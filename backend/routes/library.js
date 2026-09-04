const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../services/db');
const settings = require('../services/settings');
const localLibrary = require('../services/localLibrary');
const downloader = require('../services/downloader');
const enrich = require('../services/enrich');
const netease = require('../services/netease');
const kuwo = require('../services/kuwo');
const qq = require('../services/qq');
const kugou = require('../services/kugou');

// 本地曲库配置：读取（音乐文件夹 + 索引状态 + 挂载范围）
router.get('/config', (req, res) => {
  const st = localLibrary.stats();
  res.json({
    code: 200,
    data: {
      musicRoot: settings.get('musicRoot') || config.musicRoot,
      allowedRoots: config.allowedRoots,
      library: st
    }
  });
});

// 本地曲库配置：更新音乐文件夹，并后台重建索引
router.post('/config', (req, res) => {
  const { musicRoot } = req.body || {};
  if (!musicRoot || typeof musicRoot !== 'string' || !musicRoot.trim()) {
    return res.json({ code: 500, msg: '请填写本地音乐文件夹路径' });
  }
  const dir = musicRoot.trim();
  // 非法路径拦截：绝对路径 + 挂载范围内 + 已存在目录
  if (!dir.startsWith('/')) {
    return res.json({ code: 500, msg: '路径必须是绝对路径，例如 /vol4/1000/Music' });
  }
  if (!config.isAllowedRoot(dir)) {
    return res.json({ code: 500, msg: '路径必须在挂载范围内（' + config.allowedRoots.join('、') + '）的子目录中，请选择其下的文件夹' });
  }
  let st;
  try { st = fs.statSync(dir); } catch (e) {
    return res.json({ code: 500, msg: '目录不存在：' + dir + '，请先在 NAS 上创建该目录' });
  }
  if (!st.isDirectory()) {
    return res.json({ code: 500, msg: '路径不是文件夹：' + dir });
  }
  settings.set('musicRoot', dir);
  res.json({ code: 200, msg: '已保存本地音乐文件夹，开始重建本地曲库索引', data: { musicRoot: dir } });
  localLibrary.rebuildLibrary()
    .then(r => console.log('[本地曲库] 重建完成: root=' + dir + ' total=' + r.total + ' inserted=' + r.inserted))
    .catch(e => console.error('[本地曲库] 重建失败: ' + e.message));
});

// 待处理列表（元数据识别命中、等待用户决定）
router.get('/pendingList', (req, res) => {
  res.json({ code: 200, data: { list: localLibrary.listPending() } });
});

// 处理待处理项：skip=确认已有跳过 / download=强制下载 / remove=移除
// keep_local=保留本地（取消待下载任务） / keep_remote=保留待下载（删除本地文件并强制下载）
router.post('/pendingResolve', (req, res) => {
  const { id, action } = req.body || {};
  if (!id || !action) return res.json({ code: 500, msg: '缺少参数' });
  const row = db.prepare('SELECT * FROM pending_dup WHERE id = ?').get(id);
  if (!row) return res.json({ code: 500, msg: '待处理项不存在' });

  const buildSong = () => ({
    id: row.song_id,
    musicName: row.music_name,
    artistName: row.artist_name,
    albumName: row.album_name,
    plugName: 'netease',
    brType: row.br_type || config.defaultBrType
  });

  if (action === 'download') {
    const result = downloader.forceEnqueue(buildSong(), 'pending');
    localLibrary.resolvePending(id, 'download');
    res.json({ code: 200, msg: '已强制加入下载队列', data: { taskId: result.taskId } });
    return;
  }

  if (action === 'keep_remote') {
    // 保留待下载：先删除本地低质量副本，再强制入队下载
    const del = localLibrary.removeLocalFile(row.matched_file_path);
    const result = downloader.forceEnqueue(buildSong(), 'pending');
    localLibrary.resolvePending(id, 'download');
    res.json({
      code: 200,
      msg: '已保留待下载并加入下载队列' + (del.msg ? '；' + del.msg : ''),
      data: { taskId: result.taskId, deleted: del.deleted || false, delMsg: del.msg || '' }
    });
    return;
  }

  if (action === 'keep_local') {
    const result = localLibrary.resolvePending(id, 'keep_local');
    if (!result.ok) return res.json({ code: 500, msg: result.msg });
    res.json({ code: 200, msg: '已保留本地，取消待下载任务', data: { action: 'keep_local' } });
    return;
  }

  const result = localLibrary.resolvePending(id, action);
  if (!result.ok) return res.json({ code: 500, msg: result.msg });
  const msgs = { skipped: '已确认本地已有，后续不再提示', removed: '已从待处理移除' };
  res.json({ code: 200, msg: msgs[result.action] || '已处理', data: { action: result.action } });
});

// 本地曲库：已下载歌曲列表（下载成功任务 = 本地文件库，合并 local_track 时长）
// 支持 ?kw= 按 歌名/歌手/专辑 模糊过滤
router.get('/downloaded', (req, res) => {
  try {
    const kw = (req.query && req.query.kw) ? String(req.query.kw).trim() : '';
    let where = "dt.download_status IN ('success','supplement_success')";
    let params = [];
    if (kw) {
      where += " AND (dt.music_name LIKE ? OR dt.artist_name LIKE ? OR dt.album_name LIKE ?)";
      const like = '%' + kw + '%';
      params.push(like, like, like);
    }
    const rows = db.prepare(`
      SELECT dt.id, dt.song_id, dt.music_name, dt.artist_name, dt.album_name,
             dt.plug_name, dt.br_type, dt.file_path, dt.file_size, dt.download_time,
             lt.duration, lt.year, lt.track, lt.genre, lt.language
      FROM download_task dt
      LEFT JOIN local_track lt ON lt.file_path = dt.file_path
      WHERE ${where}
      ORDER BY dt.id DESC
      LIMIT 2000
    `).all(...params);
    const list = rows.map(r => {
      const ext = r.file_path ? (r.file_path.split('.').pop() || '').toLowerCase() : '';
      return {
        id: r.id,
        songId: r.song_id || '',
        musicName: r.music_name || '未知歌曲',
        artistName: r.artist_name || '',
        albumName: r.album_name || '',
        plugName: r.plug_name || 'netease',
        brType: r.br_type || '',
        filePath: r.file_path || '',
        fileSize: r.file_size || 0,
        downloadTime: r.download_time || '',
        format: ext,
        duration: r.duration || 0,
        year: r.year || '',
        track: r.track || '',
        genre: r.genre || '',
        language: r.language || ''
      };
    });
    res.json({ code: 200, data: { list, total: list.length } });
  } catch (e) {
    res.json({ code: 500, msg: '查询已下载歌曲失败: ' + e.message.slice(0, 120) });
  }
});

// 本地曲库：删除已下载歌曲（删除本地文件 + 清理下载记录/索引）
router.post('/downloadedDel', (req, res) => {
  try {
    const { id, songId } = req.body || {};
    if (!id && !songId) return res.json({ code: 500, msg: '缺少任务ID或歌曲ID' });
    const row = id ? db.prepare('SELECT * FROM download_task WHERE id = ?').get(id) : null;
    // P2-4：download_task 无对应记录时，按 song_id 清理 downloaded 孤悬记录（仅清记录不删文件）
    if (!row) {
      const sid = songId || id;
      const orphan = sid ? db.prepare('SELECT COUNT(*) AS c FROM downloaded WHERE song_id = ?').get(sid) : null;
      if (!orphan || orphan.c === 0) return res.json({ code: 500, msg: '下载任务不存在' });
      db.prepare('DELETE FROM downloaded WHERE song_id = ?').run(sid);
      return res.json({ code: 200, msg: '已删除孤悬下载记录', data: { deleted: true, orphan: true } });
    }

    let delMsg = '';
    if (row.file_path) {
      const del = localLibrary.removeLocalFile(row.file_path);
      if (!del.ok && del.msg && del.msg !== '非音频文件，拒绝删除') {
        return res.json({ code: 500, msg: del.msg });
      }
      delMsg = del.msg || '';
    }
    // 清理下载记录与已下载登记
    db.prepare('DELETE FROM download_task WHERE id = ?').run(id);
    if (row.song_id) {
      db.prepare('DELETE FROM downloaded WHERE song_id = ?').run(row.song_id);
    }
    res.json({ code: 200, msg: '已删除歌曲' + (delMsg ? '；' + delMsg : ''), data: { deleted: true } });
  } catch (e) {
    res.json({ code: 500, msg: '删除失败: ' + e.message.slice(0, 120) });
  }
});

// 本地曲库索引状态
router.get('/status', (req, res) => {
  const st = localLibrary.stats();
  const pending = db.prepare("SELECT COUNT(*) AS cnt FROM pending_dup WHERE status = 'pending'").get();
  res.json({ code: 200, data: { library: st, pendingCount: pending ? pending.cnt : 0, rebuild: localLibrary.getScanState() } });
});

// 本地曲库：扫描进度状态（供前端轮询进度条）
router.get('/scan/status', (req, res) => {
  res.json({ code: 200, data: { rebuild: localLibrary.getScanState() } });
});

// 本地曲库：请求停止扫描（置中断标志，rebuild 工作线程检测后安全退出）
router.post('/scan/stop', (req, res) => {
  localLibrary.stopScan();
  res.json({ code: 200, msg: '已请求停止扫描', data: { ok: true } });
});

// 本地曲库：歌曲列表（全标签字段，来自 local_track 扫描索引）
// 支持 ?kw= 按 歌名/歌手/专辑 模糊过滤
router.get('/local', (req, res) => {
  try {
    const kw = (req.query && req.query.kw) ? String(req.query.kw).trim() : '';
    const list = localLibrary.listLocalTracks(kw);
    res.json({ code: 200, data: { list, total: list.length } });
  } catch (e) {
    res.json({ code: 500, msg: '查询本地曲库失败: ' + e.message.slice(0, 120) });
  }
});

// 批量本地是否存在匹配（按 歌名/歌手/专辑，归一化指纹）：与入参逐条对齐，未命中返回 null
router.post('/local/matchExists', (req, res) => {
  try {
    const tracks = (req.body && Array.isArray(req.body.tracks)) ? req.body.tracks : [];
    const list = localLibrary.matchLocalExists(tracks);
    res.json({ code: 200, data: { list }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '本地匹配失败: ' + String((e && e.message) || e).slice(0, 120) });
  }
});

// 本地音频流（<audio> 直接播放）：支持 ?id=本地曲目ID 或 ?path=绝对路径，路径须在挂载范围内
router.get('/audio', (req, res) => {
  try {
    let filePath = '';
    const qid = parseInt((req.query && req.query.id) || '', 10);
    const qpath = (req.query && req.query.path) ? String(req.query.path) : '';
    if (qid && isFinite(qid)) {
      const row = db.prepare('SELECT file_path FROM local_track WHERE id = ?').get(qid);
      filePath = (row && row.file_path) ? String(row.file_path) : '';
    } else if (qpath) {
      filePath = qpath;
    }
    if (!filePath) return res.status(404).json({ code: 404, msg: '未找到歌曲文件' });
    if (!path.isAbsolute(filePath)) filePath = path.resolve(config.musicRoot || '/Music', filePath);
    // 宿主绝对路径（/vol4/.../Music/...）→ 容器挂载路径（/Music/...）归一化
    if (filePath.startsWith('/vol4/')) {
      const mi = filePath.indexOf('/Music');
      if (mi >= 0) filePath = filePath.slice(mi);
    }
    if (!config.isAllowedRoot(filePath)) {
      return res.status(403).json({ code: 403, msg: '路径不在允许范围内' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ code: 404, msg: '文件不存在' });
    res.sendFile(filePath, { headers: { 'Cache-Control': 'no-cache' } });
  } catch (e) {
    res.status(500).json({ code: 500, msg: '读取音频失败: ' + String((e && e.message) || e).slice(0, 120) });
  }
});

// 本地曲库：删除歌曲（删除本地文件 + 清理扫描索引/下载记录）
router.post('/localDel', (req, res) => {
  try {
    const { id, filePath } = req.body || {};
    if (!id && !filePath) return res.json({ code: 500, msg: '缺少任务ID或文件路径' });
    let delMsg = '';
    let deleted = false;
    if (filePath) {
      const del = localLibrary.removeLocalFile(filePath);
      if (!del.ok) return res.json({ code: 500, msg: del.msg });
      deleted = del.deleted || false;
      delMsg = del.msg || '';
    }
    // 清理扫描索引
    if (id) db.prepare('DELETE FROM local_track WHERE id = ?').run(id);
    else if (filePath) db.prepare('DELETE FROM local_track WHERE file_path = ?').run(filePath);
    // 顺带清理对应的下载任务与已下载登记
    if (filePath) {
      db.prepare('DELETE FROM download_task WHERE file_path = ?').run(filePath);
      db.prepare('DELETE FROM downloaded WHERE file_path = ?').run(filePath);
    }
    res.json({ code: 200, msg: '已删除歌曲' + (delMsg ? '；' + delMsg : ''), data: { deleted: true } });
  } catch (e) {
    res.json({ code: 500, msg: '删除失败: ' + e.message.slice(0, 120) });
  }
});

// 重建本地曲库索引（后台异步执行）
router.post('/rebuild', (req, res) => {
  res.json({ code: 200, msg: '已开始重建本地曲库索引', data: { started: true } });
  localLibrary.rebuildLibrary()
    .then(r => console.log('[本地曲库] 重建完成: total=' + r.total + ' inserted=' + r.inserted))
    .catch(e => console.error('[本地曲库] 重建失败: ' + e.message));
});

// 增量扫描本地曲库（后台异步执行）：仅识别 新增 / 已删除 / 已变更，不重新全量读取
router.post('/scan/incremental', (req, res) => {
  res.json({ code: 200, msg: '已开始增量扫描本地曲库', data: { started: true } });
  localLibrary.incrementalScan()
    .then(r => console.log('[本地曲库] 增量完成: total=' + r.total + ' added=' + r.added + ' removed=' + r.removed + ' updated=' + r.updated))
    .catch(e => console.error('[本地曲库] 增量失败: ' + e.message));
});

// 元数据总表（"元数据匹配修改"页）：分页 + 多条件筛选
// 查询参数：kw / artist / album / albumArtist / genre / language / year(区间) / format / composer / lyricist
//          / minDur / maxDur / minSize / maxSize / minBitrate / maxBitrate / sort / dir / page / pageSize
router.get('/meta', (req, res) => {
  try {
    const q = req.query || {};
    const num = (v) => (v === undefined || v === null || v === '' ? undefined : parseFloat(v));
    const data = localLibrary.metaList({
      kw: String(q.kw || '').trim(),
      artist: String(q.artist || '').trim(),
      album: String(q.album || '').trim(),
      albumArtist: String(q.albumArtist || '').trim(),
      genre: String(q.genre || '').trim(),
      language: String(q.language || '').trim(),
      year: String(q.year || '').trim(),
      format: String(q.format || '').trim(),
      composer: String(q.composer || '').trim(),
      lyricist: String(q.lyricist || '').trim(),
      minDur: num(q.minDur), maxDur: num(q.maxDur),
      minSize: num(q.minSize), maxSize: num(q.maxSize),
      minBitrate: num(q.minBitrate), maxBitrate: num(q.maxBitrate),
      sort: String(q.sort || '').trim(),
      dir: String(q.dir || '').trim(),
      page: parseInt(q.page, 10) || 1,
      pageSize: parseInt(q.pageSize, 10) || 50
    });
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, msg: '查询元数据失败: ' + e.message.slice(0, 120) });
  }
});

// 筛选项候选取值：返回曲库中实际存在的歌手/专辑/风格/语言/格式/年份建议
router.get('/meta/facets', (req, res) => {
  try {
    res.json({ code: 200, data: localLibrary.metaFacets() });
  } catch (e) {
    res.json({ code: 500, msg: '获取筛选项失败: ' + e.message.slice(0, 120) });
  }
});

// 元数据匹配修改：更新单条索引的可编辑标签字段（title/artist/album/... 受限白名单）
router.post('/meta/update', (req, res) => {
  try {
    const { id, fields } = req.body || {};
    if (!id || typeof fields !== 'object') return res.json({ code: 500, msg: '缺少歌曲ID或修改字段' });
    const r = localLibrary.metaUpdate(id, fields || {});
    if (!r.ok) return res.json({ code: 500, msg: r.msg || '更新失败' });
    res.json({ code: 200, msg: '已更新元数据', data: { track: r.track } });
  } catch (e) {
    res.json({ code: 500, msg: '更新元数据失败: ' + e.message.slice(0, 120) });
  }
});
// ===== 在线元数据匹配（多线路：netease 主源 + kuwo/qq/kugou/itunes/deezer 补足 + MusicBrainz 风格/语言）=====
const MCOMBO_LABEL = { title: '仅歌名', title_artist: '歌名＋歌手', title_artist_album: '歌名＋歌手＋专辑' };
// Deezer 流派 id → 名称（未命中映射时回退显示「流派#id」）
const DEEZER_GENRE = { 0: '摇滚', 20: '另类', 85: '另类摇滚', 106: '嘻哈', 113: '舞曲', 116: '节奏布鲁斯', 129: '爵士', 132: '流行', 152: '电子', 153: '浩室', 165: '说唱', 174: '摇滚', 333: '金属', 464: '民谣', 473: '民谣', 541: '古典', 576: '配乐', 578: '原声', 849: '福音', 1523: '独立' };
function mnorm (s) { return String(s || '').replace(/[\s·・.．,，、/()（）]/g, '').toLowerCase(); }

router.post('/meta/match', async (req, res) => {
  try {
    const { id, combos, song } = req.body || {};
    // 兼容两种调用方字段：MetaTable 传 song.name，播放器刮削传 song.title
    const title = (song && (song.name || song.title)) || '';
    const artist = (song && (song.artist || song.artistName)) || '';
    const album = (song && (song.album || song.albumName)) || '';
    if (!id || !title) return res.json({ code: 500, msg: '缺少歌曲信息' });

    // 多线路聚合搜索：按 歌名|歌手 去重，netease 主源在前，其余源补足候选
    async function collectSources (kw) {
      const out = [];
      const seen = new Set();
      const pushRow = (r, src) => {
        const key = mnorm(r.musicName) + '|' + mnorm(r.musicArtists || r.musicArtist || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        r._src = src;
        out.push(r);
      };
      const srcs = [
        { name: 'netease', fn: () => netease.searchSong(kw, 20, 1).then(x => x.records || []) },
        { name: 'kuwo', fn: () => kuwo.search(kw, 0, 15).then(x => x.records || []) },
        { name: 'qq', fn: () => qq.search(kw, 1, 15).then(x => x.records || []) },
        { name: 'kugou', fn: () => kugou.search(kw, 1, 15).then(x => x.records || []) },
        // 需求5：扩源 —— iTunes 官方曲库（时长/年份/流派/音轨号/发行国家俱齐）
        { name: 'itunes', fn: async () => {
          const u = 'https://itunes.apple.com/search?media=music&entity=song&limit=25&term=' + encodeURIComponent(kw);
          const r = await fetch(u);
          const j = await r.json();
          return (j.results || []).map(it => ({
            musicName: it.trackName || '',
            musicArtist: it.artistName || '',
            musicAlbum: it.collectionName || '',
            albumArtist: it.collectionArtistName || '',
            albumid: it.collectionId != null ? String(it.collectionId) : '',
            pic: (it.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
            duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
            year: it.releaseDate ? String(it.releaseDate).slice(0, 4) : '',
            track: it.trackNumber != null ? String(it.trackNumber) : '',
            genre: it.primaryGenreName || '',
            country: it.country || ''
          }));
        } },
        // 需求5：扩源 —— Deezer（作曲/作词等深字段需二次拉取）
        { name: 'deezer', fn: async () => {
          const u = 'https://api.deezer.com/search?limit=25&q=' + encodeURIComponent(kw);
          const r = await fetch(u);
          const j = await r.json();
          return ((j && j.data) || []).map(dt => ({
            musicName: dt.title || '',
            musicArtist: (dt.artist && dt.artist.name) || '',
            musicAlbum: (dt.album && dt.album.title) || '',
            albumid: dt.album && dt.album.id != null ? String(dt.album.id) : '',
            pic: (dt.album && (dt.album.cover_xl || dt.album.cover_big)) || '',
            duration: dt.duration || 0,
            _deezerTrackId: dt.id
          }));
        } }
      ];
      for (const s of srcs) {
        try {
          const rows = await s.fn();
          const rowsArr = rows.slice();
          // 标题完全一致者优先
          rowsArr.sort((a, b) => {
            const aHit = mnorm(a.musicName || '') === mnorm(title) ? 0 : 1;
            const bHit = mnorm(b.musicName || '') === mnorm(title) ? 0 : 1;
            return aHit - bHit;
          });
          for (const r of rowsArr.slice(0, 8)) pushRow(r, s.name);
        } catch (e) {
          console.warn('[meta/match] ' + s.name + ' 搜索失败: ' + e.message);
        }
        if (out.length >= 14) break;
      }
      return out;
    }

    async function toCand (r) {
      const c = {
        cover: r.musicImage || r.musicPic || r.pic || '',
        musicName: r.musicName || '',
        artistName: r.musicArtists || r.musicArtist || '',
        albumName: r.musicAlbum || '',
        albumArtist: r.albumArtist || r.albumSinger || '',
        year: (r.year != null && r.year !== '' ? String(r.year) : ''),
        track: (r.track != null && r.track !== '' ? String(r.track) : ''),
        duration: r.duration || 0,
        genre: r.genre || '',
        language: r.language || '',
        composer: r.composer || '',
        lyricist: r.lyricist || '',
        upc: r.upc || '',
        src: r._src || r.plugName || ''
      };
      // deezer 深字段：并行补 作曲/作词(contributors) + 专辑详情(年份/流派/音轨号/UPC)
      if (r._src === 'deezer' && r._deezerTrackId) {
        try {
          const [td, ad] = await Promise.all([
            fetch('https://api.deezer.com/track/' + r._deezerTrackId).then(x => x.json()).catch(() => null),
            r.albumid ? fetch('https://api.deezer.com/album/' + r.albumid).then(x => x.json()).catch(() => null) : Promise.resolve(null)
          ]);
          if (td && td.contributors) {
            const co = td.contributors.composer, ly = td.contributors.lyricist;
            if (co && !c.composer) c.composer = String(co.name || co);
            if (ly && !c.lyricist) c.lyricist = String(ly.name || ly);
          }
          if (ad) {
            if (!c.year && ad.release_date) c.year = String(ad.release_date).slice(0, 4);
            if (!c.genre && ad.genre_id != null) c.genre = DEEZER_GENRE[ad.genre_id] || ('流派#' + ad.genre_id);
            if (!c.track && ad.tracks && ad.tracks.data && ad.tracks.data.length) {
              const cur = ad.tracks.data.find(t => String(t.id) === String(r._deezerTrackId));
              if (cur && cur.track_position) c.track = String(cur.track_position);
            }
            if (ad.upc && !c.upc) c.upc = String(ad.upc);
          }
        } catch (e2) { /* deezer 补充失败忽略 */ }
      }
      // netease 主源补充专辑详情：专辑艺人 / 年份 / 音轨号（优先只补缺失字段）
      if (r._src === 'netease' && r.albumid && (!c.year || !c.track || !c.albumArtist)) {
        try {
          const ad = await netease.getAlbumDetail(r.albumid);
          if (ad) {
            if (!c.albumArtist && ad.albumSinger) c.albumArtist = ad.albumSinger;
            if (!c.year && ad.albumTime && /^\d{4}$/.test(ad.albumTime)) c.year = ad.albumTime;
            if (!c.track) {
              const cur = (ad.musics || []).find(m => mnorm(m.musicName) === mnorm(r.musicName))
                || (ad.musics || []).find(m => String(m.id) === String(r.id));
              if (cur && cur.trackNo) c.track = String(cur.trackNo);
            }
          }
        } catch (e2) { /* 详情补充失败忽略 */ }
      }
      return c;
    }

    const out = [];
    for (const k of (combos || [])) {
      let kw = title;
      if (k === 'title_artist' && artist) kw = title + ' ' + artist;
      else if (k === 'title_artist_album') kw = [title, artist, album].filter(Boolean).join(' ');
      const rows = await collectSources(kw);
      const cands = [];
      for (const r of rows.slice(0, 12)) cands.push(await toCand(r));
      out.push({ key: k, label: MCOMBO_LABEL[k] || k, keyword: kw, candidates: cands });
    }

    // MusicBrainz 补充：风格 / 语言
    let mb = {};
    try {
      const m = await enrich.mbSuggest(title, artist);
      if (m && m.ok && Array.isArray(m.fields)) {
        for (const f of m.fields) {
          if (f.name === 'genre' && f.value) mb.genre = f.value;
          else if (f.name === 'language' && f.value) mb.language = f.value;
        }
      }
    } catch (e3) { /* 忽略 */ }

    res.json({ code: 200, data: { combos: out, mb } });
  } catch (e) {
    res.json({ code: 500, msg: '在线匹配失败: ' + e.message.slice(0, 150) });
  }
});


// ===== 内嵌封面缩略图（元数据页 & 编辑卡片共用）=====
// 按 id 从音频文件提取 attached picture（ffmpeg），返回 JPEG；无封面返回 404。
// 注：<img> 无法携带 X-Auth-Token header，鉴权由 server.js 中间件放行 query token。
router.get('/meta/cover', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!id || !isFinite(id)) return res.status(400).json({ code: 400, msg: '缺少歌曲ID' });
  try {
    const out = await localLibrary.extractCoverById(id);
    if (!out) return res.status(404).json({ code: 404, msg: '该文件无内嵌封面' });
    // 元数据修改后封面需即时生效：禁止强缓存（no-cache = 每次回源校验，重新提取内嵌封面）
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Type', out.type);
    return res.send(out.buffer);
  } catch (e) {
    return res.status(500).json({ code: 500, msg: '封面提取失败: ' + String(e.message || e).slice(0, 120) });
  }
});

// ===== 标签完善助手（只出建议不写库；写回走 /meta/update）=====

// 候选清单：按「缺失字段」本地筛出待补全/待核对的曲目（不联网）
router.get('/tag/candidates', (req, res) => {
  try {
    const q = req.query || {};
    const data = enrich.listCandidates({
      missing: String(q.missing || '').trim(),
      artist: String(q.artist || '').trim(),
      album: String(q.album || '').trim(),
      kw: String(q.kw || '').trim(),
      page: parseInt(q.page, 10) || 1,
      pageSize: parseInt(q.pageSize, 10) || 50
    });
    res.json({ code: 200, data });
  } catch (e) {
    res.json({ code: 500, msg: '获取候选清单失败: ' + e.message.slice(0, 120) });
  }
});

// 批量建议预览：对一批曲目联网生成标签建议（网易云 + MusicBrainz）
// body: { tracks: [{id, musicName, artistName, ...}] }  单批 ≤ 20 条
router.post('/tag/preview', (req, res) => {
  const tracks = (req.body && req.body.tracks) || [];
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.json({ code: 500, msg: '缺少待预览的曲目列表' });
  }
  if (tracks.length > 20) {
    return res.json({ code: 500, msg: '单批最多 20 首，请分批预览' });
  }
  enrich.batchPreview(tracks, 3)
    .then(list => res.json({ code: 200, data: list }))
    .catch(e => res.json({ code: 500, msg: '生成建议失败: ' + e.message.slice(0, 120) }));
});

// ===== 本地是否已有（为歌单 / 专辑 / 单曲 / 搜索结果标注"本地已有"徽标）=====
// POST body: { tracks: [{ key?, id?, title, artist, album }] }（key 供前端回填定位，缺省用 id）
// 匹配优先级：歌名+歌手+专辑(指纹) → 歌名+歌手 → 仅歌名（同名取最接近/最大文件）
router.post('/meta/exists', (req, res) => {
  try {
    const tracks = (req.body && req.body.tracks) || [];
    if (!Array.isArray(tracks) || !tracks.length) return res.json({ code: 200, data: { matched: {} } });
    const all = localLibrary.listLocalTracks('');
    const byFp = new Map();      // fingerprint → track
    const byTa = new Map();      // norm(title)|norm(artist) → track
    const byTitle = new Map();   // norm(title) → [{track}]（同名多份候选）

    for (const t of all) {
      const fp = localLibrary.fingerprint(t.musicName, t.artistName, t.albumName);
      if (!byFp.has(fp)) byFp.set(fp, t);
      const taKey = localLibrary.normalize(t.musicName || '') + '|' + localLibrary.normalize(t.artistName || '');
      if (!byTa.has(taKey)) byTa.set(taKey, t);
      const tk = localLibrary.normalize(t.musicName || '');
      if (!byTitle.has(tk)) byTitle.set(tk, []);
      byTitle.get(tk).push(t);
    }

    const pack = (t) => ({
      exists: true,
      id: t.id,
      musicName: t.musicName,
      artistName: t.artistName,
      albumName: t.albumName,
      format: (t.format || '').toUpperCase(),
      fileSize: t.fileSize || 0,
      duration: t.duration || 0,
      filePath: t.filePath
    });

    const matched = {};
    for (const s of tracks) {
      const key = s.key != null ? s.key : (s.id != null ? String(s.id) : '');
      const title = (s.title || s.musicName || '').trim();
      const artist = (s.artist || s.artistName || '').trim();
      const album = (s.album || s.albumName || '').trim();
      if (!title) { matched[key] = { exists: false }; continue; }

      let hit = null;
      const fp = localLibrary.fingerprint(title, artist, album);
      if (artist && album && byFp.has(fp)) hit = byFp.get(fp);
      else if (artist && byTa.has(localLibrary.normalize(title) + '|' + localLibrary.normalize(artist))) {
        hit = byTa.get(localLibrary.normalize(title) + '|' + localLibrary.normalize(artist));
      }
      if (!hit) {
        const arr = byTitle.get(localLibrary.normalize(title));
        if (arr && arr.length) {
          const ranked = arr.slice().sort((a, b) => {
            const am = a.artistName === artist ? 0 : 1;
            const bm = b.artistName === artist ? 0 : 1;
            if (am !== bm) return am - bm;
            const af = a.format === 'flac' ? 0 : 1;
            const bf = b.format === 'flac' ? 0 : 1;
            if (af !== bf) return af - bf;
            return (b.fileSize || 0) - (a.fileSize || 0);
          });
          hit = ranked[0];
        }
      }
      matched[key] = hit ? pack(hit) : { exists: false };
    }
    res.json({ code: 200, data: { matched } });
  } catch (e) {
    res.json({ code: 500, msg: '本地存在查询失败: ' + String(e.message || e).slice(0, 120) });
  }
});

module.exports = router;

// ===== 本地曲库查重（按勾选字段组合分组，返回重复组及组内曲目）=====
// GET /api/library/meta/dups?fields=name,artist   fields 可为 name/artist/album 任意组合（至少一个）
router.get('/meta/dups', (req, res) => {
  try {
    const FIELD_MAP = { name: 'title', artist: 'artist', album: 'album' };
    const ALIAS = { title: 'name', artist: 'artist', album: 'album' };
    let cols = [];
    const raw = String((req.query && req.query.fields) || '').split(',').map(x => String(x).trim()).filter(Boolean);
    for (const f of raw) if (FIELD_MAP[f]) cols.push(FIELD_MAP[f]);
    cols = cols.filter((v, i, a) => a.indexOf(v) === i);
    if (!cols.length) return res.json({ code: 500, msg: '请至少勾选一个查重条件' });

    const groupBy = cols.map(c => "COALESCE(" + c + ",'')").join(', ');
    const selExprs = cols.map((c, i) => "COALESCE(" + c + ",'') AS c" + i).join(', ');
    const groups = db.prepare(
      "SELECT " + selExprs + ", COUNT(*) AS cnt FROM local_track GROUP BY " + groupBy +
      " HAVING COUNT(*) > 1 ORDER BY cnt DESC, c0 LIMIT 300"
    ).all();

    const result = groups.map((g, gi) => {
      const key = {};
      cols.forEach((c, i) => { key[ALIAS[c]] = g['c' + i]; });
      const where = cols.map(c => "(COALESCE(" + c + ",'') = ?)").join(' AND ');
      const vals = cols.map((c, i) => g['c' + i]);
      const items = db.prepare("SELECT * FROM local_track WHERE " + where + " ORDER BY (COALESCE(title,''))").all(...vals);
      return {
        id: 'g' + gi,
        key,
        count: Number(g.cnt),
        tracks: items.map(r => localLibrary.rowToTrack(r))
      };
    });

    return res.json({
      code: 200,
      data: { fields: cols.map(c => ALIAS[c]), total: result.length, groups: result }
    });
  } catch (e) {
    return res.json({ code: 500, msg: '查重失败: ' + e.message.slice(0, 120) });
  }
});
