// 下载核心：落盘 + 元数据 + 去重 + 并发控制
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const config = require('../config');
const db = require('./db');
const netease = require('./netease');
const localLibrary = require('./localLibrary');
const traffic = require('./traffic');
const matcher = require('./matcher');

// 并发队列
let activeCount = 0;
const queue = [];

// 清理文件名中的非法字符
function sanitize(name) {
  return String(name || '未知')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从 URL / 文件名推断音频扩展名（酷我/QQ 返回链接多不带扩展名）
function inferExt(str, fallback = 'mp3') {
  const m = String(str || '').match(/\.(flac|mp3|m4a|ape|wav)(\?|$)/i);
  return m ? m[1].toLowerCase() : fallback;
}

// 计算目标路径：/vol4/1000/Music/歌手/专辑/歌名 - 歌手.格式
function buildTargetPath(song, ext) {
  const artist = sanitize(song.artistName || '未知歌手');
  const album = sanitize(song.albumName || '未知专辑');
  const title = sanitize(song.musicName || '未知歌曲');
  const fileName = `${title} - ${artist}.${ext || config.downloadFormat}`;
  const dir = path.join(config.musicRoot, artist, album);
  return { dir, filePath: path.join(dir, fileName), fileName };
}

// 检查是否已下载（去重）
function isDownloaded(songId, brType) {
  const row = db.prepare('SELECT * FROM downloaded WHERE song_id = ? AND br_type = ?').get(songId, brType);
  if (row) return row.file_path;
  return null;
}

// 检查是否已存在非终态/失败任务（waiting/loading/supplement/error）
// 用于歌单监控批量入队去重：避免定时扫描对同一首歌反复创建下载任务（任务数翻倍缺陷）
function hasExistingTask(songId) {
  const row = db.prepare(
    "SELECT id FROM download_task WHERE song_id = ? AND download_status IN ('waiting','loading','supplement','error') LIMIT 1"
  ).get(songId);
  return !!row;
}

// 创建任务
function createTask(song, source = 'search') {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const isGd = song.gd ? 1 : 0;
  const info = db.prepare(`
    INSERT INTO download_task (song_id, music_name, artist_name, album_name, plug_name, br_type, audio_book, download_status, download_time, download_update_time, source, gd, url_id, lyric_id, pic_id, source_platform, external, backend_base, backend_protocol)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    song.id, song.musicName, song.artistName, song.albumName,
    song.plugName || 'netease', song.brType || config.defaultBrType,
    song.audioBook ? 1 : 0, now, now, source,
    isGd, song.url_id || '', song.lyric_id || '', song.pic_id || '', song.sourcePlatform || song.source_platform || '',
    song.external ? 1 : 0, song.backendBase || '', song.backendProtocol || ''
  );
  return info.lastInsertRowid;
}

// 更新任务状态
function updateTask(id, status, msg = '', filePath = null) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    UPDATE download_task SET download_status = ?, download_msg = ?, download_update_time = ?, file_path = COALESCE(?, file_path) WHERE id = ?
  `).run(status, msg, now, filePath, id);
}

// 下载文件（流式，带断流保护）
async function downloadFile(url, destPath) {
  const resp = await axios.get(url, { responseType: 'stream', timeout: 90000, maxRedirects: 5 });
  const total = parseInt(resp.headers['content-length'] || '0', 10);
  const writer = fs.createWriteStream(destPath);
  return new Promise((resolve, reject) => {
    let written = 0;
    resp.data.on('data', (c) => { written += c.length; traffic.recordDownload(c.length); });
    resp.data.pipe(writer);
    writer.on('finish', () => {
      // 断流保护：声明了 Content-Length 但未写满，判定下载不完整
      if (total > 0 && written < total * 0.98) {
        reject(new Error(`下载不完整（${written}/${total} 字节）`));
      } else {
        resolve();
      }
    });
    writer.on('error', reject);
    resp.data.on('error', reject);
  });
}

// 探测音频时长（秒），失败返回 null
async function probeDuration(filePath) {
  try {
    const r = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    const d = parseFloat((r.stdout || '').trim());
    return isFinite(d) ? d : null;
  } catch (e) { return null; }
}

// 试听/截断检测：网易云未登录 VIP/付费歌返回 30 秒试听、酷我/QQ 返回 10~30 秒试听，
// 统一以 <45 秒拦截（正常完整歌曲极少短于此），防止坏文件污染曲库。
// 若出现误杀极短合法音轨，可在此下调阈值。
async function assertNotPreview(tmpAudio) {
  const dur = await probeDuration(tmpAudio);
  if (dur !== null && dur < 45) {
    const e = new Error(`仅获取到约${Math.round(dur)}秒试听片段（该曲目可能为付费/版权受限，请切换音源或使用聚合源）`);
    e.preview = true;
    throw e;
  }
}

// ===== 灰色/VIP 歌曲多音源兜底解锁（借鉴 Kumone 多音源思路）=====
// 网易云取链失败（无版权/VIP）时，按「歌名+歌手」到 Kuwo / GD-joox 等音源搜索取链兜底，
// 让灰色/VIP 歌曲也能完整下载。成功仅替换直链，落盘目录结构与元数据逻辑保持原样。

// 从搜索结果里挑与目标 歌名+歌手+专辑 三要素一致的记录。
// 无一致版本返回 null（严禁退回首条，杜绝自动换源/兜底命中翻唱、翻版、Live/伴奏等错误版本）
// 下载换源链路统一严格模式：专辑也必须一致，不回退到"仅歌名+歌手"
function pickBestMatch(records, task) {
  if (!Array.isArray(records) || !records.length) return null;
  return matcher.findMatch(
    { name: task.music_name, artist: task.artist_name, album: task.album_name },
    records,
    { strict: true }
  );
}

// 匹配度评分（与 pickBestMatch 一致，用于候选排序）
function matchScore(task, musicName, musicArtists) {
  const title = String(task.music_name || '').trim().toLowerCase();
  const artist = String(task.artist_name || '').trim().toLowerCase();
  const n = String(musicName || '').trim().toLowerCase();
  const a = String(musicArtists || '').trim().toLowerCase();
  let s = 0;
  if (title && n === title) s += 3;
  else if (title && n.includes(title)) s += 1;
  if (artist && a === artist) s += 2;
  else if (artist && a.includes(artist)) s += 1;
  return s;
}

// 依次尝试 Kuwo → Kugou → GD-joox 兜底，返回候选列表（每源多个候选，按匹配度降序）。
// 下载阶段会逐个校验完整时长（>45s），试听则换下一个候选，直至拿到完整音频。
// exclude 传入已失败的音源集合（试听重下场景），避免重复尝试同一音源。
async function resolveFallbackSource(task, exclude = []) {
  const keyword = [task.music_name, task.artist_name].filter(Boolean).join(' ').trim() || task.music_name;
  if (!keyword) return [];
  // 三要素匹配目标：仅采用 歌名+歌手+专辑 均一致的候选，拒绝翻唱/翻版/伴奏等
  const want = { name: task.music_name, artist: task.artist_name, album: task.album_name };
  const brMap = { lossless: '320kmp3', higher: '320kmp3', exhigh: '320kmp3', standard: '128kmp3' };
  const hits = [];

  // Kuwo：搜索取候选（匹配度降序前 5 个 rid），逐个取直链，收集全部非空 url
  if (!exclude.includes('kuwo')) {
    try {
      const kuwo = require('./kuwo');
      const r = await kuwo.search(keyword, 0, 20);
      const recs = (r.records || [])
        .filter((x) => matcher.trackMatch(want, x))
        .map((x) => ({ ...x, _s: matchScore(task, x.musicName, x.musicArtists) }))
        .sort((a, b) => b._s - a._s)
        .slice(0, 5);
      for (const hit of recs) {
        const br = brMap[task.br_type] || '320kmp3';
        const fmt = ['lossless', 'higher', 'exhigh'].includes(task.br_type) ? 'flac' : 'mp3';
        let u = await kuwo.getPlayUrl(hit.rid, fmt, br);
        if (!u) u = await kuwo.getPlayUrl(hit.rid, 'mp3', '128kmp3');
        if (u) hits.push({ url: u, source: 'kuwo', name: hit.musicName, artist: hit.musicArtists });
      }
    } catch (e) { console.warn(`[fallback] kuwo音源兜底失败: ${e.message}`); }
  }

  // Kugou：搜索取候选，逐级用 SQ/HQ/标准 hash 取链（getPlayUrlByHash 已做 >45s 校验）
  if (!exclude.includes('kugou')) {
    try {
      const kugou = require('./kugou');
      const r = await kugou.search(keyword, 1, 20);
      const recs = (r.records || [])
        .filter((x) => matcher.trackMatch(want, x))
        .map((x) => ({ ...x, _s: matchScore(task, x.musicName, x.musicArtists) }))
        .sort((a, b) => b._s - a._s)
        .slice(0, 3);
      for (const hit of recs) {
        const hashChain = [hit.SQFileHash, hit.HQFileHash, hit.FileHash].filter(Boolean);
        for (const hash of hashChain) {
          const g = await kugou.getPlayUrlByHash(hash, hit.AlbumID, { minDuration: 45 });
          if (g && g.url) { hits.push({ url: g.url, source: 'kugou', name: hit.musicName, artist: hit.musicArtists, ext: g.ext }); break; }
        }
      }
    } catch (e) { console.warn(`[fallback] kugou音源兜底失败: ${e.message}`); }
  }

  // GD-joox（腾讯海外 JOOX）：GD 聚合搜索取候选，逐个用平台内 url_id 取直链
  // （覆盖网易云/酷我等版权死角，128k m4a 完整直链，带时效 vkey）
  if (!exclude.includes('joox')) {
    try {
      const gd = require('./gd');
      const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: keyword, pagesize: '10' });
      const recs = (Array.isArray(sd) ? sd : (sd && sd.records) || [])
        .map((x) => ({
          ...x,
          musicName: x.name || x.musicName || '',
          musicArtists: Array.isArray(x.artist) ? x.artist.join('/') : (x.artist || x.musicArtists || ''),
          musicAlbum: x.album || x.albumName || x.musicAlbum || ''
        }))
        .filter((x) => matcher.trackMatch(want, x))
        .map((x) => ({ ...x, _s: matchScore(task, x.musicName, x.musicArtists) }))
        .sort((a, b) => b._s - a._s)
        .slice(0, 3);
      for (const hit of recs) {
        const uid = hit.url_id || hit.id;
        if (!uid) continue;
        const g = await gd.getSongUrl(uid, 'joox', task.br_type);
        if (g && g.url) hits.push({ url: g.url, source: 'joox', name: hit.name || hit.musicName, artist: Array.isArray(hit.artist) ? hit.artist.join('/') : (hit.artist || '') });
      }
    } catch (e) { console.warn(`[fallback] joox音源兜底失败: ${e.message}`); }
  }

  return hits;
}

// 用 ffmpeg 写元数据 + 封面（非 FLAC 源自动转码为 FLAC）
async function writeMetadata(inputPath, outputPath, meta, coverPath) {
  // 探测输入音频编码
  let codec = 'flac';
  try {
    const probe = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath]);
    codec = (probe.stdout || '').trim();
  } catch (e) { /* 探测失败默认按 flac 处理 */ }

  const args = ['-y', '-i', inputPath];
  if (coverPath && fs.existsSync(coverPath)) {
    args.push('-i', coverPath);
  }
  if (codec === 'flac') {
    args.push('-c', 'copy');
  } else {
    args.push('-c:a', 'flac');
  }
  args.push(
    '-metadata', `title=${meta.title}`,
    '-metadata', `artist=${meta.artist}`,
    '-metadata', `album=${meta.album}`,
    '-metadata', `album_artist=${meta.albumArtist}`,
    '-metadata', `date=${meta.date || ''}`,
    '-metadata', `lyrics=${meta.lyrics || ''}`
  );
  if (coverPath && fs.existsSync(coverPath)) {
    args.push('-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  }
  args.push('-f', 'flac');
  args.push(outputPath);
  await execFileAsync('ffmpeg', args, { timeout: 180000 });
}

// 执行单个下载任务
async function doDownload(taskId) {
  const task = db.prepare('SELECT * FROM download_task WHERE id = ?').get(taskId);
  if (!task) return;

  updateTask(taskId, 'loading', '获取下载链接中');
  const isGd = !!task.gd;
  const plug = (task.plug_name || 'netease').toLowerCase();
  // 统一输出格式：与现有曲库一致（全部转 flac，目录结构同 sqmusic）
  const fileExt = config.downloadFormat || 'flac';
  let tmpAudio = null;
  let fallbackQueue = [];   // 多音源兜底候选队列（取链失败时预拉，下载阶段逐个校验）
  let pendingBackup = null;      // P1-3 pending 强制重下旧文件备份（函数级，供 catch 回滚）
  let pendingRollbackTo = null;  // P1-3 备份对应的原目标路径
  try {
    // 获取直链（按音源分支：GD 聚合换源 / 酷我 / QQ / 网易云 + 降级链）
    let urlInfo = null;
    if (isGd) {
      const gd = require('./gd');
      const brChain = [task.br_type, 'exhigh', 'standard'];
      for (const br of brChain) {
        const u = await gd.getSongUrl(task.url_id || task.song_id, task.source_platform, br);
        if (u && u.url) { urlInfo = u; break; }
      }
      if (!urlInfo) {
        await failTask(taskId, task, '无法获取下载链接（GD 源暂无可播音源）');
        return;
      }
    } else if (plug === 'kuwo') {
      const kuwo = require('./kuwo');
      // 酷我完整版直链必须带 br（128kmp3/192kmp3/320kmp3）；不带 br 只返回 11 秒试听
      const brMap = { lossless: '320kmp3', higher: '320kmp3', exhigh: '320kmp3', standard: '128kmp3' };
      const br = brMap[task.br_type] || '320kmp3';
      const fmt = ['lossless', 'higher', 'exhigh'].includes(task.br_type) ? 'flac' : 'mp3';
      let u = await kuwo.getPlayUrl(task.song_id, fmt, br);
      if (!u && br !== '128kmp3') {
        u = await kuwo.getPlayUrl(task.song_id, 'mp3', '128kmp3');
      }
      if (u) urlInfo = { url: u };
      if (!urlInfo) {
        await failTask(taskId, task, '酷我取链失败（可能为付费歌曲）');
        return;
      }
    } else if (task.external) {
      // 外部自定义后端：按配置的协议+地址走 external 适配器取链
      const external = require('./external');
      const brChain = [task.br_type, 'higher', 'standard'].filter(Boolean);
      for (const br of brChain) {
        const u = await external.externalGetUrl({
          protocol: task.backend_protocol || 'sqmusic',
          base: task.backend_base || '',
          source: task.source_platform || 'netease',
          id: task.song_id,
          br,
        });
        if (u && u.url) { urlInfo = u; break; }
      }
      if (!urlInfo) {
        await failTask(taskId, task, '404 未找到（外部后端取链失败，可能需登录或为付费歌）');
        return;
      }
    } else {
      // 网易云：先取原音源直链（brType → exhigh 降级）；仍失败则多音源兜底解锁灰色/VIP 歌
      urlInfo = await netease.getSongUrl(task.song_id, task.br_type);
      if (!urlInfo || !urlInfo.url) {
        const fallback = await netease.getSongUrl(task.song_id, 'exhigh');
        if (fallback && fallback.url) {
          urlInfo = fallback;
        } else {
          // 多音源兜底：网易云无版权/VIP 取不到链时，按歌名+歌手换 Kuwo/Kugou/joox 取链（候选列表）
          const alts = await resolveFallbackSource(task);
          if (alts && alts.length && alts[0] && alts[0].url) {
            fallbackQueue.push(...alts.slice(1));
            urlInfo = { url: alts[0].url, source: alts[0].source };
            updateTask(taskId, 'loading', `网易云无版权，已切换${alts[0].source}音源兜底`);
          } else {
            await failTask(taskId, task, '404 未找到（可能需要VIP或源已下架）');
            return;
          }
        }
      }
    }

    // 补全歌曲信息（GD 歌曲直接用任务携带字段，不查网易云详情避免 id 错乱）
    let song = {
      id: task.song_id,
      musicName: task.music_name,
      artistName: task.artist_name,
      albumName: task.album_name,
      brType: task.br_type,
      date: ''
    };
    if (!isGd && plug === 'netease') {
      try {
        const detail = await netease.getSongDetail(task.song_id);
        if (detail) {
          song.musicName = detail.name;
          song.artistName = detail.artists;
          song.albumName = detail.album;
          song.date = detail.date || '';
        }
        // song/detail 常缺 publishTime，发行年改从专辑详情补
        if (!song.date && detail && detail.albumId) {
          const ad = await netease.getAlbumDetail(detail.albumId).catch(() => null);
          if (ad && ad.albumTime) song.date = ad.albumTime;
        }
      } catch (e) { /* 忽略详情获取失败 */ }
    } else {
      // GD 源：仅当 source 为 netease 时尝试用网易云详情补齐专辑/发行年（id 同源才一致，失败不影响下载）
      if (task.source_platform === 'netease' && task.song_id) {
        try {
          const detail = await netease.getSongDetail(task.song_id);
          if (detail) {
            if (!song.albumName) song.albumName = detail.album;
            song.date = detail.date || '';
            if (!song.date && detail.albumId) {
              const ad = await netease.getAlbumDetail(detail.albumId).catch(() => null);
              if (ad && ad.albumTime) song.date = ad.albumTime;
            }
          }
        } catch (e) { /* 忽略 */ }
      }
    }

    // 目标路径（歌手/专辑/歌名 - 歌手.格式，与 sqmusic 目录结构一致）
    const { dir, filePath, fileName } = buildTargetPath(song, fileExt);
    fs.mkdirSync(dir, { recursive: true });

    // P1-3 修复：待处理栏"仍要下载"(source=pending) 语义为强制重新下载——
    // 旧文件先暂存为 .pendingbak，下载成功后删除、失败则回滚恢复，避免重下失败丢歌。
    // 普通路径（文件已存在）仍走"跳过下载"，但补回填待处理 remote_size。
    // 二次去重：文件已存在则直接标记成功（pending 强制重下除外）
    if (fs.existsSync(filePath)) {
      if (task.source === 'pending') {
        try {
          fs.renameSync(filePath, filePath + '.pendingbak');
          pendingBackup = filePath + '.pendingbak';
          pendingRollbackTo = filePath;
        } catch (e) {}
        try {
          const lrc = filePath.replace(/\.(flac|mp3|m4a|aac|ogg|wav|ape|wma|opus)$/i, '.lrc');
          if (fs.existsSync(lrc)) fs.renameSync(lrc, lrc + '.pendingbak');
        } catch (e) {}
      } else {
        db.prepare('INSERT OR IGNORE INTO downloaded (song_id, br_type, file_path, music_name, artist_name, album_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(task.song_id, task.br_type, filePath, song.musicName, song.artistName, song.albumName, new Date().toISOString());
        localLibrary.recordDownloaded(song, filePath);
        let esize = 0;
        try { esize = fs.statSync(filePath).size || 0; } catch (e) {}
        db.prepare('UPDATE download_task SET file_size = ? WHERE id = ?').run(esize, taskId);
        // P1-3 修复：文件已存在跳过时也回填待处理项 remote_size（下载侧一致口径）
        try { localLibrary.recordPendingRemoteSize(task.song_id, esize); } catch (e) {}
        updateTask(taskId, 'success', '文件已存在，跳过下载', filePath);
        return;
      }
    }

    updateTask(taskId, 'loading', '下载音频中');
    tmpAudio = path.join(dir, `.${fileName}.tmp`);
    // 候选队列：当前 urlInfo（网易云原链/降级链/首个兜底候选）优先，其后为多音源兜底候选。
    // 试听/截断检测：网易云灰色/VIP 歌常返回 30 秒试听直链、酷我付费歌常返回 11 秒试听，
    // 逐个候选下载并校验完整时长（>45s），试听则换下一个候选，直到拿到完整音频。
    const triedSources = new Set(urlInfo && urlInfo.source ? [urlInfo.source] : []);
    let dlQueue = [{ url: urlInfo.url, source: urlInfo.source || 'netease' }];
    if (fallbackQueue.length) dlQueue.push(...fallbackQueue);
    let done = false;
    let lastErr = null;
    while (dlQueue.length) {
      const cand = dlQueue.shift();
      if (!cand || !cand.url) continue;
      updateTask(taskId, 'loading',
        cand.source && cand.source !== 'netease'
          ? `当前音源仅试听，已切换${cand.source}音源兜底`
          : '下载音频中');
      try {
        try { fs.unlinkSync(tmpAudio); } catch (_) {}
        await downloadFile(cand.url, tmpAudio);
        await assertNotPreview(tmpAudio);
        done = true;
        urlInfo = cand;
        break;
      } catch (e) {
        lastErr = e;
        const canRetry = e.preview && !isGd && !task.external &&
          (plug === 'netease' || plug === 'kuwo' || plug === 'kugou');
        if (!canRetry) break;
        console.warn('[fallback] 检测到试听片段，尝试下一个候选音源:', e.message);
        if (cand.source) triedSources.add(cand.source);
        // 队列耗尽时补充一轮兜底候选（新音源），避免试听重下死循环
        if (!dlQueue.length) {
          const extra = await resolveFallbackSource(task, Array.from(triedSources));
          const fresh = (extra || []).filter((f) => f && f.url && !triedSources.has(f.source));
          if (fresh.length) {
            fresh.forEach((f) => triedSources.add(f.source));
            dlQueue.push(...fresh);
          }
        }
      }
    }
    if (!done) throw lastErr || new Error('下载失败');

    // 下载封面（GD 走 types=pic；网易云走详情接口）
    let coverPath = null;
    try {
      let coverUrl = '';
      if (task.external) {
        const ext = await require('./external').externalGetPic({
          protocol: task.backend_protocol || 'sqmusic',
          base: task.backend_base || '',
          source: task.source_platform || 'netease',
          id: task.song_id,
        });
        coverUrl = (ext && ext.url) || task.pic_id || '';
      } else if (isGd) {
        coverUrl = await require('./gd').getPic(task.pic_id);
      } else if (plug === 'netease') {
        const detail = await netease.getSongDetail(task.song_id);
        if (detail && detail.image) coverUrl = detail.image;
      } else {
        // 酷我/QQ：任务携带的封面 URL（前端搜索时已有）
        coverUrl = task.pic_id || '';
      }
      if (coverUrl) {
        const coverExt = coverUrl.includes('.png') ? 'png' : 'jpg';
        coverPath = path.join(dir, `cover.${coverExt}`);
        await downloadFile(coverUrl, coverPath);
      }
    } catch (e) { /* 封面失败不阻塞 */ }

    // 下载歌词（GD 走 types=lyric）
    let lyricText = '';
    try {
      let lyric;
      if (task.external) {
        lyric = await require('./external').externalGetLyric({
          protocol: task.backend_protocol || 'sqmusic',
          base: task.backend_base || '',
          source: task.source_platform || 'netease',
          id: task.song_id,
        });
      } else if (isGd) {
        lyric = await require('./gd').getLyric(task.lyric_id);
      } else if (plug === 'netease') {
        lyric = await netease.getLyric(task.song_id);
      } else {
        lyric = null; // 酷我/QQ 歌词接口待补充
      }
      lyricText = (lyric && lyric.lyric) || '';
      if (lyricText) {
        const lrcPath = path.join(dir, `${fileName.replace(/\.(flac|mp3)$/i, '')}.lrc`);
        fs.writeFileSync(lrcPath, lyricText, 'utf8');
      }
    } catch (e) { /* 歌词失败不阻塞 */ }

    // 写元数据
    updateTask(taskId, 'loading', '写入元数据中');
    const tmpFinal = path.join(dir, `.${fileName}.meta.tmp`);
    await writeMetadata(tmpAudio, tmpFinal, {
      title: song.musicName,
      artist: song.artistName,
      album: song.albumName,
      albumArtist: song.artistName,
      date: song.date || '',
      lyrics: lyricText
    }, coverPath);

    // 移动到最终位置
    fs.renameSync(tmpFinal, filePath);
    try { fs.unlinkSync(tmpAudio); } catch (e) {}
    // P1-3：pending 强制重下成功后删除旧文件备份
    if (pendingBackup) { try { fs.unlinkSync(pendingBackup); } catch (e) {} }

    // 回填文件大小（任务列表/查重页展示）与待处理项远程侧实际大小
    let fsize = 0;
    try { fsize = fs.statSync(filePath).size || 0; } catch (e) {}
    db.prepare('UPDATE download_task SET file_size = ? WHERE id = ?').run(fsize, taskId);
    try { localLibrary.recordPendingRemoteSize(task.song_id, fsize); } catch (e) {}

    // 记录去重
    db.prepare('INSERT OR IGNORE INTO downloaded (song_id, br_type, file_path, music_name, artist_name, album_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.song_id, task.br_type, filePath, song.musicName, song.artistName, song.albumName, new Date().toISOString());
    localLibrary.recordDownloaded(song, filePath);

    updateTask(taskId, 'success', '下载完成', filePath);
  } catch (e) {
    console.error(`任务 ${taskId} 下载失败:`, e.message);
    // 清理下载过程中产生的临时文件（含试听/不完整文件），防止坏文件残留
    try {
      if (tmpAudio && fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio);
    } catch (_) {}
    // P1-3：pending 强制重下失败时回滚恢复旧文件
    if (pendingBackup && fs.existsSync(pendingBackup) && pendingRollbackTo && !fs.existsSync(pendingRollbackTo)) {
      try { fs.renameSync(pendingBackup, pendingRollbackTo); } catch (_) {}
    }
    await failTask(taskId, task, `下载失败: ${e.message.slice(0, 120)}`);
  }
}

// 队列调度
function pump() {
  while (activeCount < config.maxConcurrent && queue.length > 0) {
    const taskId = queue.shift();
    activeCount++;
    doDownload(taskId).finally(() => {
      activeCount--;
      pump();
    });
  }
}

// 复用原任务记录重新入队（不新建任务；已在队列则跳过，避免重复）
function reQueueTask(taskId, msg = '重新下载') {
  updateTask(taskId, 'waiting', msg);
  if (!queue.includes(taskId)) {
    queue.push(taskId);
    pump();
  }
}

// 服务启动恢复：把数据库中 waiting/loading 的未完成任务重新拉回内存队列继续消费。
// 解决"服务重启后任务永久卡在等待中"的问题（内存队列清空，waiting 记录无人消费）。
// 同时做重复任务合并：同一 song_id 存在多条未完成任务（历史重试/换源留下的 orphan）时，
// 仅保留最新一条入队下载，其余转为 error 并注明被接管，不静默删除、用户可见可清理。
function resumePendingTasks() {
  const rows = db.prepare("SELECT id, song_id FROM download_task WHERE download_status IN ('waiting','loading') ORDER BY id ASC").all();
  if (!rows.length) return 0;
  const latestId = new Map(); // song_id -> 最新任务 id
  for (const r of rows) latestId.set(r.song_id, r.id);
  let restored = 0;
  let folded = 0;
  for (const r of rows) {
    const latest = latestId.get(r.song_id);
    if (r.id !== latest) {
      // 历史重复/孤儿任务：折叠为 error（不删除），由最新任务接管下载
      db.prepare("UPDATE download_task SET download_status = 'error', download_msg = ?, download_update_time = ? WHERE id = ?")
        .run('检测到重复未完成任务（由任务 #' + latest + ' 接管），已折叠', new Date().toISOString().replace('T', ' ').slice(0, 19), r.id);
      folded++;
      continue;
    }
    // 唯一任务：loading → waiting 并重新入队消费
    updateTask(r.id, 'waiting', '服务重启，恢复下载');
    if (!queue.includes(r.id)) queue.push(r.id);
    restored++;
  }
  console.log(`[resume] 服务重启恢复 ${restored} 个未完成任务, 折叠重复 ${folded} 个`);
  pump();
  return restored;
}

// 自动切 GD-joox 兜底：任务最终失败时，自动按「歌名+歌手」走 GD 聚合搜索 joox 平台匹配，
// 将任务标记为 GD 任务（gd=1, source_platform=joox, url_id=平台id）重新入队，走 isGd 分支取海外直链重下，
// 覆盖网易云无版权/付费死角。仅对普通搜索源生效（GD 聚合源 / external 外部源 / pending 强制重下语义不干预）
// 已处于 joox 源则跳过，避免死循环
async function autoSwitchToJoox(taskId, task) {
  try {
    const plug = String(task.plug_name || 'netease').toLowerCase();
    if (plug === 'joox' || (task.gd && task.source_platform === 'joox') || task.external || task.source === 'pending') return false;
    const keyword = [task.music_name, task.artist_name].filter(Boolean).join(' ').trim();
    if (!keyword) return false;
    const gd = require('./gd');
    const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: keyword, pagesize: '10' });
    const recs = (Array.isArray(sd) ? sd : (sd && sd.records) || []).map((x) => ({
      ...x,
      musicName: x.name || x.musicName || '',
      musicArtists: Array.isArray(x.artist) ? x.artist.join('/') : (x.artist || x.musicArtists || ''),
      musicAlbum: x.album || x.albumName || x.musicAlbum || ''
    }));
    const rec = pickBestMatch(recs, task);
    if (!rec) {
      console.log(`[auto-joox] 任务 ${taskId}「${task.music_name}」未找到三要素一致（歌名/歌手/专辑）的 JOOX 版本，放弃自动切源`);
      return false;
    }
    const uid = rec && (rec.url_id || rec.id);
    if (!uid) return false;
    db.prepare("UPDATE download_task SET gd = 1, plug_name = 'joox', source_platform = 'joox', url_id = ?, song_id = ?, pic_id = COALESCE(?, pic_id) WHERE id = ?")
      .run(String(uid), String(uid), rec.pic_id || rec.pic || '', taskId);
    reQueueTask(taskId, '自动切换joox音源重下');
    console.log(`[auto-joox] 任务 ${taskId}「${task.music_name}」已自动切换 GD-joox 音源重下 (url_id=${uid})`);
    return true;
  } catch (e) {
    console.warn(`[auto-joox] 任务 ${taskId} 自动换源失败: ${e.message}`);
    return false;
  }
}

// 统一的失败出口：优先尝试自动切 GD-joox 换源，换源成功则不再标 error；否则按原消息标失败
async function failTask(taskId, task, msg) {
  try {
    const ok = await autoSwitchToJoox(taskId, task);
    if (ok) return;
  } catch (_) {}
  updateTask(taskId, 'error', msg);
}

// 入队下载（去重：song_id 已成功 → 已存在未完成任务 → 本地元数据识别 → 路径二次）
function enqueueDownload(song, source = 'search') {
  const br = song.brType || config.defaultBrType;
  // ① song_id + 音质 精确去重（已成功下载）
  const existing = isDownloaded(song.id, br);
  if (existing) {
    return { status: 'duplicate', filePath: existing };
  }
  // ② 同曲目已有未完成任务（waiting/loading/supplement/error）→ 不再重复创建。
  // 修复：重试/换源后卡 waiting 的历史场景，搜索页重复点击同一首会产生第二条记录。
  if (hasExistingTask(song.id)) {
    return { status: 'queued-dedup' };
  }
  // ③ 本地元数据识别（严格：歌名+歌手+专辑）
  const matched = localLibrary.matchByMetadata(song);
  if (matched) {
    const pendingId = localLibrary.addPending(song, br, matched.file_path, source);
    return { status: 'pending', pendingId, matchedFile: matched.file_path };
  }
  // ④ 正常入队
  const taskId = createTask(song, source);
  queue.push(taskId);
  pump();
  return { status: 'queued', taskId };
}

// 强制入队（跳过所有去重，用于待处理栏"仍要下载"）
function forceEnqueue(song, source = 'pending') {
  const taskId = createTask(song, source);
  queue.push(taskId);
  pump();
  return { status: 'queued', taskId };
}

// 批量入队（歌单/监控）
// 去重顺序：① 已成功下载（downloaded 表）→ 跳过；② 已存在非终态/失败任务（waiting/loading/supplement/error）→ 跳过，不再重复创建；
//           ③ 本地元数据匹配 → 进待处理；④ 其余 → 新建任务。error 任务保留在列表可手动重试，定时扫描不再无脑重建。
function enqueueBatch(songs, source = 'playlist') {
  let added = 0;
  let dup = 0;
  let pending = 0;
  for (const s of songs) {
    const br = s.brType || config.defaultBrType;
    const existing = isDownloaded(s.id, br);
    if (existing) { dup++; continue; }
    if (hasExistingTask(s.id)) { dup++; continue; }
    const matched = localLibrary.matchByMetadata(s);
    if (matched) {
      localLibrary.addPending(s, br, matched.file_path, source);
      pending++;
      continue;
    }
    const taskId = createTask(s, source);
    queue.push(taskId);
    added++;
  }
  pump();
  return { added, dup, pending };
}

// 换源重试辅助：清除旧错误/失败状态与残留进度标记，供 /switchSource 路由调用
function resetRetry(id) {
  db.prepare("UPDATE download_task SET download_status = 'waiting', download_msg = '', download_update_time = ? WHERE id = ?")
    .run(new Date().toISOString().replace('T', ' ').slice(0, 19), id);
}

function clearProgress(id) {
  db.prepare('UPDATE download_task SET file_path = NULL WHERE id = ?').run(id);
}

// 下载失败原始信息 → 中文友好提示（task/list 等展示用；已是中文则原样返回）
function msgToCn(msg) {
  if (!msg) return '';
  const s = String(msg);
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  const rules = [
    [/^Request failed with status code 401/i, '未授权（登录状态失效，请重新登录）'],
    [/^Request failed with status code 403/i, '上游拒绝访问（期限/版权受限）'],
    [/^Request failed with status code (\d{3})/, m => `上游返回 HTTP ${m[1]} 错误`],
    [/request aborted/i, '请求被中断'],
    [/connect ECONNREFUSED/i, '连接被拒绝（服务不可达）'],
    [/ETIMEDOUT|timeout/i, '请求超时'],
    [/ENOTFOUND|getaddrinfo/i, '域名解析失败'],
    [/ECONNRESET|socket hang up/i, '连接被重置'],
    [/EACCES|EPERM/i, '权限不足，无法写入文件'],
    [/ENOSPC/i, '磁盘空间不足'],
    [/EEXIST/i, '文件已存在'],
    [/preview/i, '仅试听片段（可能为付费/版权受限）']
  ];
  for (const [re, rep] of rules) {
    if (re.test(s)) return typeof rep === 'function' ? rep(re.exec(s) || []) : rep;
  }
  return s;
}

module.exports = {
  enqueueDownload,
  enqueueBatch,
  forceEnqueue,
  isDownloaded,
  resetRetry,
  clearProgress,
  msgToCn,
  createTask,
  updateTask,
  reQueueTask,
  resumePendingTasks,
  buildTargetPath
};
