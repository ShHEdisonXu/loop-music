// 供下载前"元数据识别"去重（严格匹配：歌名 + 歌手 + 专辑）
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const config = require('../config');
const db = require('./db');

const AUDIO_EXTS = ['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.wav', '.ape', '.wma', '.opus'];

// 大小写兼容取内嵌标签字段
// VORBIS 注释（FLAC/OGG）键名保留文件内原始大小写：部分文件用大写 TITLE/ARTIST/ALBUM，部分用小写。
// ID3（MP3）与 iTunes（M4A）键名也可能不同，按常见键名依次尝试，首个非空命中即返回。
function pickTag(tags, ...names) {
  if (!tags) return undefined;
  for (const n of names) {
    const v = tags[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// 年份：date/year 等字段，截取 4 位数字年份；无则原样返回清洗值
function extractYear(tags) {
  const d = cleanTag(pickTag(tags, 'year', 'YEAR', 'Year', 'date', 'DATE', 'Date', 'originaldate', 'ORIGINALDATE', 'TYER'));
  if (!d) return '';
  const m = d.match(/(19|20)\d{2}/);
  return m ? m[0] : d;
}
// 音轨/总轨数：取原值，兼容 "01" / "5/12" / "01/12"
function extractTrack(tags) {
  return cleanTag(pickTag(tags, 'track', 'TRACK', 'Track', 'tracknumber', 'TRACKNUMBER', 'TRK', 'TRCK', 'TIT1'));
}
// 碟号/总碟数：如 "1" / "1/2"
function extractDisc(tags) {
  return cleanTag(pickTag(tags, 'disc', 'DISCNUMBER', 'Disc', 'DiscNumber', 'TPOS'));
}

// 扫描进度状态（全局，供 /status 轮询 & 前端进度条展示）
const scanState = {
  running: false,
  scanMode: 'full', // full | incremental
  phase: 'idle', // walk | probing | done | stopped | idle
  total: 0,
  scanned: 0,
  inserted: 0,
  added: 0,
  removed: 0,
  updated: 0,
  percent: 0,
  currentFile: '',
  startedAt: null,
  finishedAt: null
};
// 扫描中断标志：/scan/stop 置位，rebuild 工作线程检测后安全退出
let scanStopRequested = false;

function getScanState() { return Object.assign({}, scanState); }
function stopScan() { scanStopRequested = true; return { ok: true }; }

// 规范化指纹：小写、全角转半角、去标点、去空白
function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000]/g, ' ')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[\[\]()【】{}"“”‘’'`~!@#$%^&*_+\-=|;:,.<>/?·、，。；：！？…—《》〈〉]/g, '')
    .replace(/\s+/g, '');
}

function fingerprint(title, artist, album) {
  return [normalize(title), normalize(artist), normalize(album)].join('|');
}

// 用 ffprobe 读取单个音频的内嵌标签
// 清洗内嵌标签：纯空白或 "null"/"undefined" 等占位字符串视为无此字段
function cleanTag(v) {
  if (v == null) return '';
  const str = String(v).trim();
  if (!str) return '';
  if (/^(null|undefined|nan|none|n\/a|\?|-)$/i.test(str)) return '';
  return str;
}

async function probeFile(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', filePath],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    const f = info.format || {};
    const tags = f.tags || {};
    const stream = Array.isArray(info.streams) ? info.streams.find(s => s && (s.codec_type === 'audio' || !s.codec_type)) : null;
    const duration = parseFloat(f.duration || 0) || 0;
    let fileSize = 0;
    try { fileSize = fs.statSync(filePath).size || 0; } catch (e) { /* 忽略 */ }
    const title = cleanTag(pickTag(tags, 'title', 'TITLE', 'Title', 'tiTLE', 'TIT2'));
    const artist = cleanTag(pickTag(tags, 'artist', 'ARTIST', 'Artist', 'TPE1')) ||
                   cleanTag(pickTag(tags, 'album_artist', 'ALBUM_ARTIST', 'Album Artist', 'TPE2'));
    const albumArtist = cleanTag(pickTag(tags, 'album_artist', 'ALBUM_ARTIST', 'Album Artist', 'TPE2'));
    const album = cleanTag(pickTag(tags, 'album', 'ALBUM', 'Album', 'TALB'));
    // 技术参数（-show_streams → sample_rate / channels / bits_per_sample；format → bit_rate / format_name）
    const bitRate = parseInt(f.bit_rate, 10) || 0;
    const sampleRate = parseInt(stream && stream.sample_rate, 10) || 0;
    const channels = parseInt(stream && stream.channels, 10) || 0;
    const bitsPerSample = parseInt(stream && stream.bits_per_sample, 10) || 0;
    const format = cleanTag((f.format_name || '').split(',')[0]);
    return {
      title,
      artist,
      album,
      albumArtist,
      year: extractYear(tags),
      track: extractTrack(tags),
      disc: extractDisc(tags),
      genre: cleanTag(pickTag(tags, 'genre', 'GENRE', 'Genre', 'TCON')),
      language: cleanTag(pickTag(tags, 'language', 'LANGUAGE', 'Language', 'TLAN')),
      composer: cleanTag(pickTag(tags, 'composer', 'COMPOSER', 'Composer', 'TCOM')),
      lyricist: cleanTag(pickTag(tags, 'lyricist', 'LYRICIST', 'Lyricist', 'writer', 'WRITER', 'TEXT', 'TEXT2')),
      comment: cleanTag(pickTag(tags, 'comment', 'COMMENT', 'Comment', 'description', 'DESCRIPTION', 'COMM')),
      bpm: cleanTag(pickTag(tags, 'bpm', 'BPM', 'Bpm', 'BPM1', 'TBPM')),
      duration,
      fileSize,
      bitRate,
      sampleRate,
      channels,
      bitsPerSample,
      format
    };
  } catch (e) {
    return null;
  }
}

// 递归收集音乐目录下所有音频文件
function walk(root) {
  const files = [];
  (function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        rec(p);
      } else if (AUDIO_EXTS.includes(path.extname(ent.name).toLowerCase())) {
        files.push(p);
      }
    }
  })(root);
  return files;
}

// 通用写入/更新本地曲库一行完整标签（全量重建 / 增量扫描 / 下载成功 三方共用）
// INSERT ... ON CONFLICT(file_path) DO UPDATE 幂等，不重复建行；字段拒绝写 null（用空串兜底）
function upsertTrack(fp, meta, now) {
  const m = meta || {};
  db.prepare(`
    INSERT INTO local_track (file_path, title, artist, album, album_artist, year, track, disc, genre, language,
      composer, lyricist, comment, bpm, duration, file_size, bit_rate, sample_rate, channels, bits_per_sample, format,
      cover_url, norm_title, norm_artist, norm_album, fingerprint, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      title = excluded.title, artist = excluded.artist, album = excluded.album,
      album_artist = excluded.album_artist, year = excluded.year, track = excluded.track,
      disc = excluded.disc, genre = excluded.genre, language = excluded.language,
      composer = excluded.composer, lyricist = excluded.lyricist, comment = excluded.comment,
      bpm = excluded.bpm, duration = excluded.duration, file_size = excluded.file_size,
      bit_rate = excluded.bit_rate, sample_rate = excluded.sample_rate, channels = excluded.channels,
      bits_per_sample = excluded.bits_per_sample, format = excluded.format,
      cover_url = excluded.cover_url,
      norm_title = excluded.norm_title, norm_artist = excluded.norm_artist,
      norm_album = excluded.norm_album, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at
  `).run(
    fp,
    m.title || '', m.artist || '', m.album || '', m.albumArtist || '',
    m.year || '', m.track || '', m.disc || '', m.genre || '', m.language || '',
    m.composer || '', m.lyricist || '', m.comment || '', m.bpm || '',
    m.duration || 0, m.fileSize || 0,
    m.bitRate || 0, m.sampleRate || 0, m.channels || 0, m.bitsPerSample || 0, m.format || '',
    m.coverUrl || '',
    normalize(m.title || ''), normalize(m.artist || ''), normalize(m.album || ''),
    fingerprint(m.title || '', m.artist || '', m.album || ''), now
  );
}

// 全量扫描重建本地曲库索引
// 单实例锁：一次只允许一个重建在跑（并发触发会导致两个扫描同时写表 → UNIQUE 冲突）
let rebuildRunning = false;
async function rebuildLibrary(progressCb) {
  if (rebuildRunning) {
    return { total: 0, inserted: 0, skipped: true };
  }
  rebuildRunning = true;
  scanStopRequested = false;
  Object.assign(scanState, {
    running: true, scanMode: 'full', phase: 'walk', total: 0, scanned: 0, inserted: 0,
    added: 0, removed: 0, updated: 0, percent: 0, currentFile: '',
    startedAt: new Date().toISOString(), finishedAt: null
  });
  try {
      const files = walk(config.musicRoot);
      scanState.total = files.length;
      db.exec('DELETE FROM local_track');
      let inserted = 0;
      const now = new Date().toISOString();
      // 并发探测：ffprobe 为独立子进程，串行 await 是性能瓶颈。
      // 改为固定并发（默认 8，config.scanConcurrency 可调），任务由共享计数器分发；
      // better-sqlite3 插入仍同步在主线程，一次很短，单进程内安全。
      const CONCURRENCY = Math.max(1, parseInt(config.scanConcurrency, 10) || 8);
      let nextIdx = 0;
      let done = 0;
      const insertTrack = (fp, meta) => {
        if (scanStopRequested) { done++; return; } // 已请求停止：不再入库，等待安全退出
        if (meta && (meta.title || meta.artist)) {
          upsertTrack(fp, meta, now);
          inserted++;
        }
        done++;
        scanState.scanned = done;
        scanState.inserted = inserted;
        scanState.percent = files.length ? Math.round(done / files.length * 100) : 0;
        if (progressCb && done % 200 === 0) progressCb(done, files.length);
      };
      const worker = async () => {
        while (true) {
          if (scanStopRequested) return;
          const i = nextIdx++;
          if (i >= files.length) return;
          const fp = files[i];
          scanState.currentFile = fp;
          const meta = await probeFile(fp);
          insertTrack(fp, meta);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
      if (scanStopRequested) {
        scanState.phase = 'stopped';
        if (progressCb) progressCb(scanState.scanned, files.length);
        return { total: files.length, inserted, stopped: true };
      }
      scanState.phase = 'done';
      if (progressCb) progressCb(files.length, files.length);
      return { total: files.length, inserted };
  } finally {
    rebuildRunning = false;
    scanState.phase = (scanState.phase === 'done' || scanState.phase === 'stopped') ? scanState.phase : 'idle';
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  }
}

// 增量扫描：对比“磁盘文件 ↔ 本地索引”，只识别三类变化
//   - 新增：磁盘有、索引无             → ffprobe 读标签入库
//   - 已删除：索引有、磁盘无           → 从索引移除
//   - 已变更：路径相同但文件大小不同   → 重新 ffprobe 刷新
// 未变化的文件完全不触碰，速度远快于全量重建
let incrementalRunning = false;
async function incrementalScan(progressCb) {
  if (rebuildRunning || incrementalRunning) {
    return { total: 0, added: 0, removed: 0, updated: 0, skipped: true };
  }
  incrementalRunning = true;
  scanStopRequested = false;
  Object.assign(scanState, {
    running: true, scanMode: 'incremental', phase: 'walk', total: 0, scanned: 0, inserted: 0,
    added: 0, removed: 0, updated: 0, percent: 0, currentFile: '',
    startedAt: new Date().toISOString(), finishedAt: null
  });
  try {
    const files = walk(config.musicRoot);
    const diskSet = new Set(files);
    const indexRows = db.prepare('SELECT file_path, file_size FROM local_track').all();
    const indexMap = new Map();
    for (const r of indexRows) indexMap.set(r.file_path, r);

    // ① 归类变化：新增 / 已变更（大小不同）
    const toProbe = [];
    for (const fp of files) {
      let sz = 0;
      try { sz = fs.statSync(fp).size || 0; } catch (_) { /* 文件被读走时按 0 处理 */ }
      const row = indexMap.get(fp);
      if (!row) toProbe.push({ fp, kind: 'added' });
      else if ((row.file_size || 0) !== sz) toProbe.push({ fp, kind: 'changed' });
    }
    // ② 已删除：索引中存在、磁盘已不存在
    const removed = [];
    for (const fp of indexMap.keys()) {
      if (!diskSet.has(fp)) removed.push(fp);
    }

    // 先执行删除（不占探测额）
    const delStmt = db.prepare('DELETE FROM local_track WHERE file_path = ?');
    for (const fp of removed) delStmt.run(fp);
    scanState.removed = removed.length;

    // ③ 并发探测并写入新增/变更
    scanState.phase = 'probing';
    scanState.total = toProbe.length;
    let added = 0;
    let updated = 0;
    let scanned = 0;
    const now = new Date().toISOString();
    const CONCURRENCY = Math.max(1, parseInt(config.scanConcurrency, 10) || 8);
    let nextIdx = 0;
    const worker = async () => {
      while (true) {
        if (scanStopRequested) return;
        const i = nextIdx++;
        if (i >= toProbe.length) return;
        const { fp, kind } = toProbe[i];
        scanState.currentFile = fp;
        const meta = await probeFile(fp);
        if (!scanStopRequested && meta && (meta.title || meta.artist)) {
          upsertTrack(fp, meta, now);
          if (kind === 'added') added++;
          else updated++;
        }
        scanned++;
        if (scanState.phase === 'probing') {
          scanState.scanned = scanned;
          scanState.added = added;
          scanState.updated = updated;
          scanState.percent = toProbe.length ? Math.round(scanned / toProbe.length * 100) : 100;
        }
        if (progressCb && scanned % 50 === 0) progressCb(scanned, toProbe.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toProbe.length || 1) }, () => worker()));

    scanState.added = added;
    scanState.updated = updated;
    scanState.scanned = scanned;
    if (scanStopRequested) {
      scanState.phase = 'stopped';
      if (progressCb) progressCb(scanned, toProbe.length);
      return { total: files.length, added, removed: removed.length, updated, stopped: true };
    }
    scanState.phase = 'done';
    scanState.percent = 100;
    if (progressCb) progressCb(scanned, toProbe.length);
    return { total: files.length, added, removed: removed.length, updated };
  } finally {
    incrementalRunning = false;
    scanState.phase = (scanState.phase === 'done' || scanState.phase === 'stopped') ? scanState.phase : 'idle';
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  }
}

// 索引统计
function stats() {
  const row = db.prepare('SELECT COUNT(*) AS cnt, MAX(updated_at) AS last FROM local_track').get();
  return { count: row ? row.cnt : 0, lastScan: row ? row.last : null };
}

// 本地曲库歌曲列表（全标签字段），支持按 歌名/歌手/专辑/作曲/作词 模糊过滤
function listLocalTracks(kw = '') {
  let sql = 'SELECT * FROM local_track';
  const params = [];
  if (kw) {
    sql += ' WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? OR composer LIKE ? OR lyricist LIKE ?';
    const like = '%' + kw + '%';
    params.push(like, like, like, like, like);
  }
  sql += ' ORDER BY file_size DESC, id DESC LIMIT 2000';
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToTrack);
}

// local_track 行 → 前端歌曲对象（全标签字段）
function rowToTrack(r) {
  const fp = r.file_path || '';
  const ext = fp ? (fp.split('.').pop() || '').toLowerCase() : '';
  return {
    id: r.id,
    filePath: fp,
    musicName: r.title || '未知歌曲',
    artistName: r.artist || '',
    albumName: r.album || '',
    albumArtist: r.album_artist || '',
    year: r.year || '',
    track: r.track || '',
    disc: r.disc || '',
    genre: r.genre || '',
    language: r.language || '',
    composer: r.composer || '',
    lyricist: r.lyricist || '',
    comment: r.comment || '',
    bpm: r.bpm || '',
    format: ext || (r.format || ''),
    container: r.format || '',
    duration: r.duration || 0,
    fileSize: r.file_size || 0,
    bitRate: r.bit_rate || 0,
    sampleRate: r.sample_rate || 0,
    channels: r.channels || 0,
    bitsPerSample: r.bits_per_sample || 0,
    cover: r.cover_url || '',
    updatedAt: r.updated_at || ''
  };
}

// 元数据总表（"元数据匹配修改"页）：分页 + 多条件筛选
// kw=歌名/歌手/专辑/作曲/作词 模糊（OR），其余字段精确包含（AND）；支持年份区间与数值范围、排序
function metaList(options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(options.pageSize, 10) || 50));
  const conds = [];
  const params = [];
  if (options.kw) {
    const like = '%' + options.kw + '%';
    conds.push('(title LIKE ? OR artist LIKE ? OR album LIKE ? OR composer LIKE ? OR lyricist LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const singleLike = (col, val) => {
    if (val) { conds.push(`${col} LIKE ?`); params.push('%' + val + '%'); }
  };
  singleLike('artist', options.artist);
  singleLike('album', options.album);
  singleLike('album_artist', options.albumArtist);
  singleLike('genre', options.genre);
  singleLike('language', options.language);
  singleLike('composer', options.composer);
  singleLike('lyricist', options.lyricist);
  // year 支持：单年 / 年份区间（如 1990-2010）/ 任意包含
  if (options.year) {
    const y = String(options.year).trim();
    const range = y.match(/^(\d{4})\s*[-~]\s*(\d{4})$/);
    if (range) {
      const [a, b] = range.slice(1).map(Number);
      conds.push('(CAST(COALESCE(year,\'0\') AS INTEGER) BETWEEN ? AND ?)');
      params.push(Math.min(a, b), Math.max(a, b));
    } else if (/^\d{4}$/.test(y)) {
      conds.push('(CAST(COALESCE(year,\'0\') AS INTEGER) = ?)');
      params.push(Number(y));
    } else {
      conds.push('(year LIKE ?)');
      params.push('%' + y + '%');
    }
  }
  // 格式按文件扩展名 / format 列匹配（表 format 列可能为空，改走 file_path）
  if (options.format) {
    const f = '%' + String(options.format).toLowerCase() + '%';
    conds.push(`( lower(file_path) LIKE ? OR lower(format) LIKE ? )`);
    params.push(f, f);
  }
  // 数值范围：时长（秒）/ 大小（字节）/ 码率（kbps）
  const numCmp = (col, val, op) => {
    const n = parseFloat(val);
    if (!Number.isNaN(n)) { conds.push(`(${col} >= 0 AND ${col} ${op} ?)`); params.push(n); }
  };
  if (options.minDur !== undefined) numCmp('duration', options.minDur, '>=');
  if (options.maxDur !== undefined) numCmp('duration', options.maxDur, '<=');
  if (options.minSize !== undefined) numCmp('file_size', options.minSize, '>=');
  if (options.maxSize !== undefined) numCmp('file_size', options.maxSize, '<=');
  if (options.minBitrate !== undefined) numCmp('bit_rate', options.minBitrate, '>=');
  if (options.maxBitrate !== undefined) numCmp('bit_rate', options.maxBitrate, '<=');
  const where = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
  // 排序：白名单映射，year 用整数比较；默认按 专辑-音轨
  const SORT_MAP = {
    title: 'norm_title', artist: 'norm_artist', album: 'norm_album', albumArtist: 'COALESCE(album_artist,\'\')',
    year: 'CAST(COALESCE(year,\'0\') AS INTEGER)', genre: 'COALESCE(genre,\'\')', language: 'COALESCE(language,\'\')',
    composer: 'COALESCE(composer,\'\')', lyricist: 'COALESCE(lyricist,\'\')', duration: 'duration',
    fileSize: 'file_size', bitRate: 'bit_rate', sampleRate: 'sample_rate', format: 'lower(file_path)',
  };
  let orderBy = 'album COLLATE NOCASE, track, id';
  if (options.sort && SORT_MAP[options.sort]) {
    const dir = String(options.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderBy = `${SORT_MAP[options.sort]} ${dir}, id`;
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM local_track ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM local_track ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, list: rows.map(rowToTrack) };
}

// 筛选项候选取值：各字段常见取值（供前端下拉建议），均取曲库实际存在的值
function metaFacets() {
  const colPick = (col, guest) => db.prepare(
    `SELECT ${col} AS v, COUNT(*) AS c FROM local_track WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col} ORDER BY c DESC, ${col} LIMIT 50`
  ).all().map(r => guest ? String(r.v) : r.v);
  // 格式走文件扩展名聚合（SQLite 无 reverse()，改用 JS 提取）
  let formats = [];
  try {
    const frows = db.prepare(`SELECT lower(file_path) AS p FROM local_track WHERE file_path LIKE '%.%'`).all();
    const cnt = {};
    for (const r of frows) {
      const m = /\.([a-z0-9]{1,8})$/i.exec(r.p);
      if (m) cnt[m[1]] = (cnt[m[1]] || 0) + 1;
    }
    formats = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([v]) => v);
  } catch (e) { formats = []; }
  let years = [];
  try {
    years = db.prepare(
      `SELECT CAST(COALESCE(year,'0') AS INTEGER) AS v, COUNT(*) AS c FROM local_track GROUP BY v ORDER BY c DESC, v LIMIT 60`
    ).all().map(r => String(r.v)).filter(v => v !== '0');
  } catch (e) { years = []; }
  return {
    artists: colPick('artist'), albums: colPick('album'), genres: colPick('genre'),
    languages: colPick('language'), composers: colPick('composer'), lyricists: colPick('lyricist'),
    formats, years,
  };
}

// 更新单条本地音频的元数据（仅更新曲库索引，用于"匹配修改"修正错标/补全）
// 校验值域：仅允许文本标签列；技术参数列（时长/大小/码率/采样率等）不在此页编辑
function metaUpdate(id, fields = {}) {
  const row = db.prepare('SELECT * FROM local_track WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, msg: '歌曲不存在' };
  const allowed = ['title', 'artist', 'album', 'album_artist', 'year', 'track', 'disc', 'genre',
    'language', 'composer', 'lyricist', 'comment', 'bpm', 'cover'];
  const sets = [];
  const params = [];
  const next = {};
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    const v = (fields[k] == null ? '' : String(fields[k]).trim());
    // cover（前端草稿字段）映射到曲库列 cover_url（在线匹配注入的封面地址可持久化）
    const col = k === 'cover' ? 'cover_url' : k;
    sets.push(`${col} = ?`);
    params.push(v);
    next[k] = v;
  }
  if (!sets.length) return { ok: false, msg: '没有可更新的字段' };
  const now = new Date().toISOString();
  const title = next.title !== undefined ? next.title : (row.title || '');
  const artist = next.artist !== undefined ? next.artist : (row.artist || '');
  const album = next.album !== undefined ? next.album : (row.album || '');
  sets.push('norm_title = ?'); params.push(normalize(title));
  sets.push('norm_artist = ?'); params.push(normalize(artist));
  sets.push('norm_album = ?'); params.push(normalize(album));
  sets.push('fingerprint = ?'); params.push(fingerprint(title, artist, album));
  sets.push('updated_at = ?'); params.push(now);
  params.push(Number(id));
  db.prepare(`UPDATE local_track SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  // 一行写完后再读取，避免 rowToTrack 用到旧值
  const fresh = db.prepare('SELECT * FROM local_track WHERE id = ?').get(Number(id));
  return { ok: true, track: rowToTrack(fresh) };
}

// 元数据识别：严格匹配（歌名 + 歌手 + 专辑）
// 若本地或待下载的专辑名缺失，退化为 歌名 + 歌手 匹配，避免漏判
function matchByMetadata(song) {
  const title = song.musicName || '';
  const artist = song.artistName || '';
  const album = song.albumName || '';
  const nTitle = normalize(title);
  const nArtist = normalize(artist);
  const nAlbum = normalize(album);
  if (!nTitle || !nArtist) return null;

  if (nAlbum) {
    // 严格：三字段全等
    const strict = db.prepare('SELECT * FROM local_track WHERE fingerprint = ? LIMIT 1').get(fingerprint(title, artist, album));
    if (strict) return strict;
    // 严格模式下专辑不同不判重（允许同名不同专辑重复收集）
    return null;
  }
  // 待下载缺专辑名 → 退化 歌名+歌手
  const relaxed = db.prepare('SELECT * FROM local_track WHERE norm_title = ? AND norm_artist = ? LIMIT 1').get(nTitle, nArtist);
  return relaxed || null;
}

// 下载成功后增量写入本地曲库（P1-2 修复：duration 用 ffprobe 真实时长，不再硬编码 0）
function recordDownloaded(song, filePath) {
  const title = song.musicName || '';
  const artist = song.artistName || '';
  const album = song.albumName || '';
  if (!title && !artist) return;
  // 同步探测真实时长（秒），失败兜底 0 不阻塞入库
  let duration = 0;
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 8000, maxBuffer: 1024 * 1024 }
    );
    duration = parseFloat(String(out).trim());
    if (!isFinite(duration) || duration < 0) duration = 0;
  } catch (e) { /* 探测失败不阻塞 */ }
  // 同步读取实际文件大小（展示用）
  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size || 0; } catch (e) { /* 忽略 */ }
  const ext = (String(filePath).split('.').pop() || '').toLowerCase();
  upsertTrack(filePath, {
    title, artist, album,
    albumArtist: artist,
    duration,
    fileSize,
    format: ext
  }, new Date().toISOString());
}

// 同步读取本地音频文件的实际大小 / 码率 / 格式（用于待处理对比展示）
function probeLocalFileStat(filePath) {
  let size = 0, bitRate = 0, format = '';
  try { size = fs.statSync(filePath).size || 0; } catch (e) {}
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-print_format', 'json', filePath],
      { timeout: 8000, maxBuffer: 1024 * 1024 }
    );
    const info = JSON.parse(out.toString());
    const f = info.format || {};
    bitRate = parseInt(f.bit_rate || 0, 10) || 0;
    format = (f.format_name || '').split(',')[0] || '';
  } catch (e) { /* 忽略，用扩展名兜底 */ }
  if (!format) format = path.extname(filePath || '').replace('.', '').toLowerCase();
  return { size, bitRate, format };
}

// 加入待处理重复项（记录本地文件与待下载文件双方对比信息）
function addPending(song, brType, matchedFilePath, source = 'search') {
  const now = new Date().toISOString();
  const title = song.musicName || '';
  const artist = song.artistName || '';
  // 本地侧：文件名 / 大小 / 码率 / 格式
  const local = probeLocalFileStat(matchedFilePath);
  // 待下载侧：预期文件名 / 码率档位 / 格式
  const remoteFormat = config.downloadFormat || 'flac';
  const remoteFileName = `${title} - ${artist}.${remoteFormat}`;
  const remoteBits = Array.isArray(song.bits) && song.bits.length ? JSON.stringify(song.bits) : '';
  const info = db.prepare(`
    INSERT INTO pending_dup (song_id, music_name, artist_name, album_name, br_type,
      remote_file_name, remote_bits, remote_format, source,
      matched_file_path, local_file_name, local_size, local_bit_rate, local_format,
      status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    song.id, title, artist, song.albumName || '', brType,
    remoteFileName, remoteBits, remoteFormat, source,
    matchedFilePath, path.basename(matchedFilePath || ''), local.size, local.bitRate, local.format,
    now
  );
  return info.lastInsertRowid;
}

// 待处理列表
function listPending() {
  const rows = db.prepare("SELECT * FROM pending_dup WHERE status = 'pending' ORDER BY id DESC").all();
  // 需求2：补本地侧专辑名（按已匹配的本地文件路径反查曲库索引，供"上下对比"展示完整 歌名/歌手/专辑/格式/大小）
  const locByPath = new Map();
  const lrows = db.prepare('SELECT file_path, title, artist, album FROM local_track').all();
  for (const l of lrows) locByPath.set(l.file_path, l);
  for (const r of rows) {
    try { r.remote_bits = r.remote_bits ? JSON.parse(r.remote_bits) : []; } catch (e) { r.remote_bits = []; }
    const loc = locByPath.get(r.matched_file_path);
    if (loc) {
      r.local_album = loc.album || '';
      if (!r.local_size && loc.file_size) r.local_size = loc.file_size;
    } else {
      r.local_album = '';
    }
    const a = analyzePending(r);
    r.local_score = a.localScore;
    r.remote_score = a.remoteScore;
    r.recommend = a.recommend;
    r.recommend_reason = a.reason;
  }
  return rows;
}

// ===== 查重质量分析（文件大小优先，其次参考 格式/码率，用于"保留哪一份"推荐） =====
// 格式分：flac/wav 无损 > m4a/ape > mp3
function formatScore(fmt) {
  const f = String(fmt || '').toLowerCase();
  const map = { flac: 100, wav: 95, ape: 90, alac: 90, aiff: 88, m4a: 72, aac: 68, ogg: 60, opus: 66, mp3: 62 };
  return map[f] ?? 50;
}
// 实测码率分（kbps）
function bitRateScore(bps) {
  const k = Number(bps || 0) / 1000;
  if (!k || k <= 0) return 0;
  if (k >= 3000) return 100;
  if (k >= 1400) return 92;
  if (k >= 900) return 82;
  if (k >= 700) return 72;
  if (k >= 500) return 64;
  if (k >= 320) return 58;
  if (k >= 192) return 50;
  if (k >= 128) return 42;
  return 34;
}
// 待下载音质档位分（无实测码率时按 brType 估算）
function brTypeScore(br) {
  const map = { hires: 100, lossless: 90, exhigh: 74, higher: 62, high: 62, standard: 42 };
  return map[br] ?? 50;
}
// 文件大小分（MB，0-100）
function sizeScore(bytes) {
  const mb = Number(bytes || 0) / 1024 / 1024;
  if (mb >= 60) return 100;
  if (mb >= 30) return 90;
  if (mb >= 15) return 80;
  if (mb >= 8) return 70;
  if (mb >= 5) return 60;
  if (mb >= 1) return 40;
  if (mb > 0) return 20;
  return 0;
}
// 综合质量分（0-100）：有实测大小时大小为主权重（60%），其次 格式25%+码率15%；
// 无实测大小（如付费/无版权项）时退化为 格式55%+码率45%，避免大小缺失干扰决策
function qualityScore({ format, bitRate, brType, size }) {
  const fmt = formatScore(format || (brType ? (['lossless', 'hires'].includes(brType) ? 'flac' : 'mp3') : ''));
  const br = bitRate && bitRate > 0 ? bitRateScore(bitRate) : (brType ? brTypeScore(brType) : 0);
  const sz = sizeScore(size);
  if (sz > 0) return Math.round(sz * 0.6 + fmt * 0.25 + br * 0.15);
  return Math.round(fmt * 0.55 + br * 0.45);
}
// 字节 → MB 文案
function fmtMb(bytes) {
  const mb = Number(bytes || 0) / 1024 / 1024;
  if (!mb || mb <= 0) return '';
  return mb.toFixed(1) + 'MB';
}
// 对待处理项做本地 vs 待下载对比，给出"保留哪一份"推荐
// 规则：文件大小优先（大者胜）；仅当大小缺失或完全相同时，才回退参考综合质量（格式+码率）
function analyzePending(row) {
  const remoteBr = row.br_type || config.defaultBrType;
  const remoteFmt = row.remote_format || config.downloadFormat || 'flac';
  const localQ = { format: row.local_format, bitRate: row.local_bit_rate, size: row.local_size };
  const remoteQ = {
    format: remoteFmt,
    bitRate: 0,
    brType: remoteBr,
    size: row.remote_size && row.remote_size > 0 ? row.remote_size : 0
  };
  const localScore = qualityScore(localQ);
  const remoteScore = qualityScore(remoteQ);

  const szLocal = Number(row.local_size || 0);
  const szRemote = Number(row.remote_size || 0);

  let recommend = 'keep_local';
  let reason = '音质接近，建议保留本地';

  // 1) 文件大小优先：双方都有实测大小且不同 → 大者胜
  if (szLocal > 0 && szRemote > 0 && szLocal !== szRemote) {
    if (szRemote > szLocal) {
      recommend = 'download';
      reason = '待下载文件更大（' + fmtMb(szRemote) + ' > ' + fmtMb(szLocal) + '），优先保留大文件，建议重新下载';
    } else {
      recommend = 'keep_local';
      reason = '本地文件更大（' + fmtMb(szLocal) + ' > ' + fmtMb(szRemote) + '），优先保留大文件，建议保留本地';
    }
    return { localScore, remoteScore, recommend, reason };
  }

  // 2) 大小缺失或相同 → 综合质量（格式+码率）
  const diff = remoteScore - localScore;
  if (diff >= 6) { recommend = 'download'; reason = '待下载综合质量更高，建议重新下载'; }
  else if (diff <= -6) { recommend = 'keep_local'; reason = '本地综合质量更高，建议保留本地'; }
  return { localScore, remoteScore, recommend, reason };
}

// 下载成功后回填待处理项远程侧实际大小（供查重页展示真实大小对比）
// 不限定 status：download/keep_remote 后行已离开 pending 列表，但需保证后续重新识别时仍能展示真实大小
function recordPendingRemoteSize(songId, size) {
  db.prepare("UPDATE pending_dup SET remote_size = ? WHERE song_id = ?").run(Number(size) || 0, songId);
}

// 删除本地音频文件（查重"保留待下载"时移除本地低质量副本）
// 安全校验：仅允许删除 musicRoot 目录下的音频文件，防止越权删除
function removeLocalFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, msg: '无效文件路径' };
  const root = path.resolve(config.musicRoot || '');
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, msg: '文件不在本地音乐目录内，拒绝删除' };
  }
  const ext = path.extname(target).toLowerCase();
  if (!AUDIO_EXTS.includes(ext)) {
    return { ok: false, msg: '非音频文件，拒绝删除' };
  }
  try {
    if (!fs.existsSync(target)) return { ok: true, deleted: false, msg: '本地文件已不存在，无需删除' };
    fs.unlinkSync(target);
    // 同步清理本地曲库索引
    db.prepare('DELETE FROM local_track WHERE file_path = ?').run(target);
    return { ok: true, deleted: true, msg: '已删除本地文件: ' + path.basename(target) };
  } catch (e) {
    return { ok: false, msg: '删除失败: ' + e.message };
  }
}

// 处理待处理项：skip=确认已有跳过 / download=强制下载 / remove=直接移除
// keep_local=保留本地（取消待下载任务） / keep_remote=保留待下载（删除本地文件，由路由强制下载）
function resolvePending(id, action) {
  const row = db.prepare('SELECT * FROM pending_dup WHERE id = ?').get(id);
  if (!row) return { ok: false, msg: '待处理项不存在' };
  const now = new Date().toISOString();
  if (action === 'skip' || action === 'keep_local') {
    // 确认本地已有 → 写入 downloaded 表，之后不再提示
    db.prepare('INSERT OR IGNORE INTO downloaded (song_id, br_type, file_path, music_name, artist_name, album_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.song_id, row.br_type, row.matched_file_path, row.music_name, row.artist_name, row.album_name, now);
    if (action === 'keep_local') {
      // 保留本地：取消该歌曲的待下载/下载中/错误任务，避免重复下载
      db.prepare("DELETE FROM download_task WHERE song_id = ? AND download_status IN ('waiting','loading','supplement','error')")
        .run(row.song_id);
    }
    db.prepare("UPDATE pending_dup SET status = 'skipped', resolved_at = ? WHERE id = ?").run(now, id);
    return { ok: true, action: action === 'keep_local' ? 'keep_local' : 'skipped' };
  }
  if (action === 'remove') {
    db.prepare("UPDATE pending_dup SET status = 'removed', resolved_at = ? WHERE id = ?").run(now, id);
    return { ok: true, action: 'removed' };
  }
  if (action === 'download') {
    db.prepare("UPDATE pending_dup SET status = 'download', resolved_at = ? WHERE id = ?").run(now, id);
    return { ok: true, action: 'download' };
  }
  return { ok: false, msg: '未知操作: ' + action };
}

// ===== 内嵌封面提取（元数据页缩略图 / 编辑卡片左上角大图共用） =====
// 用 ffmpeg 从音频文件取 attached picture，缩放到最宽 480px，输出 JPEG buffer。
// 内存 LRU 缓存（无封面也短暂缓存避免反复起 ffmpeg）+ 并发去重（同一 id 同时触发只提取一次）。
const coverCache = new Map();   // id -> { buf: {buffer,type}|null, at: timestamp }
const coverPending = new Map(); // id -> Promise（提取中）
const COVER_CACHE_MAX = 500;

function extractCoverOnce (fp) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', fp,
      '-an', '-sn', '-dn',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', "scale='min(480,iw)':-2",
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '4',
      'pipe:1'
    ];
    execFile('ffmpeg', args, { timeout: 12000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err || !stdout || !stdout.length) return resolve(null);
      resolve({ buffer: stdout, type: 'image/jpeg' });
    });
  });
}

// 缓存写入（统一 FIFO 淘汰）
function coverCacheSet (key, val) {
  coverCache.set(key, { buf: val, at: Date.now() });
  while (coverCache.size > COVER_CACHE_MAX) {
    const first = coverCache.keys().next().value;
    coverCache.delete(first);
  }
}

// 对外：按曲库记录 id 提取内嵌封面（带缓存），无封面 / 文件缺失 / 失败返回 null
function extractCoverById (id) {
  let row = null;
  try { row = db.prepare('SELECT id, file_path FROM local_track WHERE id = ?').get(Number(id)); } catch (e) { row = null; }
  if (!row || !row.file_path) return Promise.resolve(null);
  const ck = Number(id);
  const hit = coverCache.get(ck);
  if (hit) {
    // 命中缓存：12h 内有效（约 5 分钟增量扫描周期，足够多次翻页复用）
    if (Date.now() - hit.at < 12 * 3600 * 1000) {
      return Promise.resolve(hit.buf ? { buffer: hit.buf.buffer, type: hit.buf.type } : null);
    }
    coverCache.delete(ck);
  }
  if (coverPending.has(ck)) return coverPending.get(ck);
  const p = extractCoverOnce(row.file_path).then((out) => {
    coverPending.delete(ck);
    coverCacheSet(ck, out);
    return out ? { buffer: out.buffer, type: out.type } : null;
  }).catch(() => {
    coverPending.delete(ck);
    coverCacheSet(ck, null);
    return null;
  });
  coverPending.set(ck, p);
  return p;
}

// 批量本地是否存在匹配（今日推荐/搜索/歌单/专辑本地标注用）：
// 与入参逐条对齐，未命中返回 null；命中返回 { exists,filePath,fileSize,format,... }
function matchLocalExists(tracks = []) {
  const rows = db.prepare('SELECT * FROM local_track').all();
  const strict = new Map();
  const relaxed = new Map();
  for (const r of rows) {
    const k1 = fingerprint(r.title || '', r.artist || '', r.album || '');
    if (!strict.has(k1)) strict.set(k1, r);
    const k2 = (r.norm_title || normalize(r.title || '')) + '\u0001' + normalize(r.artist || '');
    if (!relaxed.has(k2)) relaxed.set(k2, r);
  }
  return (tracks || []).map((t) => {
    const title = t && (t.title || t.musicName);
    const artist = t && (t.artist || t.musicArtists || t.artistName);
    const album = t && (t.album || t.musicAlbum || t.albumName);
    let hit = null;
    if (title && artist && album) hit = strict.get(fingerprint(title, artist, album)) || null;
    if (!hit && title && artist) hit = relaxed.get(normalize(title) + '\u0001' + normalize(artist)) || null;
    if (!hit) return null;
    const fp = hit.file_path || '';
    return {
      exists: true,
      filePath: fp,
      fileSize: hit.file_size || 0,
      format: (fp.split('.').pop() || '').toLowerCase(),
      musicName: hit.title || '',
      artistName: hit.artist || '',
      albumName: hit.album || ''
    };
  });
}

module.exports = {
  normalize,
  fingerprint,
  matchLocalExists,
  probeFile,
  rebuildLibrary,
  incrementalScan,
  metaList,
  metaFacets,
  metaUpdate,
  extractCoverById,
  rowToTrack,
  getScanState,
  stopScan,
  stats,
  listLocalTracks,
  matchByMetadata,
  recordDownloaded,
  addPending,
  listPending,
  resolvePending,
  removeLocalFile,
  analyzePending,
  recordPendingRemoteSize
};
