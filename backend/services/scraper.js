// 刮削（元数据补全）服务：从多平台数据源搜索补全 歌手/专辑/歌词/封面
// 数据源接入方式参考 FnMusicEnhance / musicdl / Lyrico：
//   网易云 / 酷狗 / 酷我 走本地 download-service 既有搜索适配（services/netease|kugou|kuwo）
//   GD Tidal / JOOX（Apple 系）走 GD 聚合网关 search/lyric/pic
// 刮削产出：写同名 .lrc 歌词文件 + 更新 local_track 的 artist/album 元数据
const fs = require('fs');
const path = require('path');
const db = require('./db');
const netease = require('./netease');
const kugou = require('./kugou');
const kuwo = require('./kuwo');
const gd = require('./gd');

// 数据源清单（前端刮削页数据源选择器）
const SOURCES = [
  { id: 'netease', name: '网易云音乐', caps: ['artist', 'album', 'lyric', 'pic'] },
  { id: 'kugou', name: '酷狗音乐', caps: ['artist', 'album'] },
  { id: 'kuwo', name: '酷我音乐', caps: ['artist', 'album', 'pic'] },
  { id: 'tidal', name: 'GD Tidal（Apple 系）', caps: ['artist', 'album', 'lyric', 'pic'] },
  { id: 'joox', name: 'GD JOOX', caps: ['artist', 'album', 'lyric', 'pic'] },
];

function sources() {
  return SOURCES;
}

// 清理搜索结果中的 HTML 标签（如酷狗 artist 里的 <em> 高亮）
function cleanText(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

// 统一搜索：各源 → { records: [{ id, name, artist, album, pic }] }
async function search(source, keyword, type = 'song') {
  const kw = String(keyword || '').trim();
  if (!kw) return { records: [] };

  switch (source) {
    case 'netease': {
      if (type === 'album') {
        const r = await netease.searchAlbum(kw, 10, 1);
        const records = (r.records || []).map(s => ({
          id: String(s.albumid || s.id || ''),
          name: s.musicName || '',
          artist: s.musicArtists || '',
          album: s.musicAlbum || '',
          pic: s.musicImage || ''
        }));
        return { records };
      }
      if (type === 'artist') {
        const r = await netease.searchArtist(kw, 10, 1);
        const records = (r.records || []).map(s => ({
          id: String(s.artistId || s.id || ''),
          name: s.musicName || s.name || '',
          artist: s.musicName || s.name || '',
          album: '',
          pic: s.musicImage || ''
        }));
        return { records };
      }
      const r = await netease.searchSong(kw, 10, 1);
      const records = (r.records || []).map(s => ({
        id: String(s.id || ''),
        name: s.musicName || '',
        artist: s.musicArtists || '',
        album: s.musicAlbum || '',
        pic: s.musicImage || ''
      }));
      return { records };
    }
    case 'kugou': {
      const r = await kugou.search(kw, 1, 10);
      const records = (r.records || []).map(s => ({
        id: String(s.id || s.FileHash || ''),
        name: cleanText(s.musicName),
        artist: cleanText(s.musicArtists),
        album: cleanText(s.musicAlbum),
        pic: s.musicImage || ''
      }));
      return { records };
    }
    case 'kuwo': {
      const r = await kuwo.search(kw, 0, 10);
      const records = (r.records || []).map(s => ({
        id: String(s.id || s.rid || ''),
        name: s.musicName || '',
        artist: s.musicArtists || '',
        album: s.musicAlbum || '',
        pic: s.musicImage || ''
      }));
      return { records };
    }
    case 'tidal':
    case 'joox': {
      const data = await gd.gdRequest({ types: 'search', source, name: kw, count: 20, pages: 1 });
      const arr = Array.isArray(data) ? data : [];
      // 封面直链可选：仅补首条，避免 20 条结果逐条 spawn 子进程签名（execFileSync 阻塞事件循环）导致搜索接口超时
      try {
        const first = arr[0];
        if (first && first.pic_id) {
          const u = await gd.getPic(first.pic_id);
          if (u) first.pic = u;
        }
      } catch (e) { /* 单条失败不影响整体 */ }
      const records = arr.map(s => ({
        id: String(s.id != null ? s.id : s.musicrid || ''),
        name: s.name || s.musicName || s.songName || '',
        artist: Array.isArray(s.artist) ? s.artist.map(a => (typeof a === 'string' ? a : a.name)).join('/') : (s.artist || ''),
        album: s.album || '',
        pic: s.pic || s.musicImage || ''
      }));
      return { records };
    }
    default:
      return { records: [] };
  }
}

// 歌词：netease / GD 源支持，其余源暂不支持（返回空）
async function lyric(source, id) {
  if (!id) return { lyric: '' };
  try {
    if (source === 'netease') {
      const r = await netease.getLyric(id);
      return { lyric: (r && r.lyric) || '' };
    }
    if (source === 'tidal' || source === 'joox') {
      const r = await gd.getLyric(id);
      return { lyric: (r && r.lyric) || '' };
    }
    return { lyric: '' };
  } catch (e) {
    return { lyric: '', error: (e && e.message) || String(e) };
  }
}

// 待刮削列表：local_track 中 缺歌手/缺专辑 或 缺同名 .lrc 的歌曲
function needs({ kw, limit } = {}) {
  const lim = Math.min(parseInt(limit || '500', 10) || 500, 2000);
  let rows;
  if (kw) {
    const like = '%' + String(kw).trim() + '%';
    rows = db.prepare(
      'SELECT id, file_path, title, artist, album, album_artist FROM local_track WHERE (title LIKE ? OR artist LIKE ? OR album LIKE ?) ORDER BY id DESC LIMIT ?'
    ).all(like, like, like, lim);
  } else {
    rows = db.prepare(
      'SELECT id, file_path, title, artist, album, album_artist FROM local_track ORDER BY (CASE WHEN artist IS NULL OR artist = \'\' THEN 0 WHEN album IS NULL OR album = \'\' THEN 1 ELSE 2 END), id DESC LIMIT ?'
    ).all(lim);
  }
  const list = rows.map(r => {
    const fp = r.file_path || '';
    const lrcPath = fp ? fp.replace(/\.[^.\\/]+$/, '.lrc') : '';
    const hasLrc = !!(lrcPath && fs.existsSync(lrcPath));
    return {
      id: r.id,
      filePath: fp,
      fileName: fp ? path.basename(fp) : '',
      title: r.title || '',
      artist: r.artist || '',
      album: r.album || '',
      hasLrc,
      needArtist: !(r.artist || '').trim(),
      needAlbum: !(r.album || '').trim()
    };
  });
  return { list, total: list.length };
}

// 写 .lrc（与音频文件同目录同名）
function writeLrc(filePath, text) {
  if (!filePath || !text) return { ok: false, reason: 'empty' };
  try {
    const lrcPath = filePath.replace(/\.[^.\\/]+$/, '.lrc');
    if (lrcPath === filePath) return { ok: false, reason: 'bad-path' };
    fs.mkdirSync(path.dirname(lrcPath), { recursive: true });
    fs.writeFileSync(lrcPath, text, 'utf8');
    return { ok: true, lrcPath };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// 更新 local_track 歌手/专辑元数据
function updateTrackMeta(id, { artist, album }) {
  if (!id) return { ok: false, reason: 'no-id' };
  const row = db.prepare('SELECT * FROM local_track WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: 'not-found' };
  const now = new Date().toISOString();
  const newArtist = (artist || '').trim() || row.artist;
  const newAlbum = (album || '').trim() || row.album;
  const newAlbumArtist = (artist || '').trim() || row.album_artist;
  const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  db.prepare(
    'UPDATE local_track SET artist = ?, album = ?, album_artist = ?, norm_artist = ?, norm_album = ?, updated_at = ? WHERE id = ?'
  ).run(newArtist, newAlbum, newAlbumArtist, normalize(newArtist), normalize(newAlbum), now, id);
  return { ok: true, artist: newArtist, album: newAlbum };
}

// 对一批本地曲目执行刮削补全
// items: [{ id, filePath, title, artist }]  source: 数据源 id
// 返回每项：match / artist / album / lyricSaved / lrcPath / err
async function apply(items, source, { withLyric = true } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (const item of list) {
    const kw = (item.title || '').trim() || (item.filePath ? path.basename(item.filePath).replace(/\.[^.\\/]+$/, '') : '');
    const artistHint = (item.artist || '').trim();
    const searchKw = artistHint ? `${artistHint} ${kw}`.trim() : kw;
    const entry = { id: item.id, filePath: item.filePath, title: kw, ok: false, err: '' };
    try {
      if (!searchKw) { entry.err = '缺少歌名/文件名'; results.push(entry); continue; }
      const { records } = await search(source, searchKw, 'song');
      if (!records || records.length === 0) { entry.err = '数据源无匹配结果'; results.push(entry); continue; }
      const hit = records[0];
      entry.match = hit;
      // 更新元数据
      const meta = updateTrackMeta(item.id, { artist: hit.artist, album: hit.album });
      entry.meta = meta.ok ? { artist: meta.artist, album: meta.album } : { err: meta.reason };
      entry.ok = true;
      // 歌词
      if (withLyric && item.filePath) {
        const cap = (SOURCES.find(s => s.id === source) || {}).caps || [];
        if (cap.indexOf('lyric') !== -1) {
          const { lyric: lrcText, error } = await lyric(source, hit.id);
          if (error) {
            entry.lyricErr = error;
          } else if (lrcText) {
            const w = writeLrc(item.filePath, lrcText);
            entry.lyricSaved = w.ok;
            if (w.ok) entry.lrcPath = w.lrcPath;
            else entry.lyricErr = w.reason;
          } else {
            entry.lyricEmpty = true;
          }
        } else {
          entry.lyricSkipped = true;
        }
      }
    } catch (e) {
      entry.err = (e && e.message) || String(e);
    }
    results.push(entry);
  }
  return results;
}

module.exports = { sources, search, lyric, needs, apply, writeLrc, updateTrackMeta };
