// 外部后端协议适配层：让用户"填后端地址即用"任意兼容后端
// 支持的协议：
//   sqmusic      — GD/simple-music-server 类 api.php 协议（types=search/url/lyric/pic）
//   meting       — Meting API（如 meting.qjqq.cn/?server=&type=&id=）
//   lxmusic      — lx-music-api-server（MeoProject，/api/search /api/urls /api/lyric /api/pic）
//   neteasecloud — NeteaseCloudMusicApi 实例（/search /song/url /lyric /song/detail）
// 统一对外输出 sqmusic 兼容的 records / {url} / {lyric} / {pic} 结构，供前端直接渲染与播放。
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 15000, headers: { 'User-Agent': UA } });

// 规范化 base 地址（去末尾斜杠）
function normBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}

// 拼接查询参数
function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ========== sqmusic（api.php 协议） ==========
async function sqmusicSearch(base, source, keyword, page, size) {
  const p = { types: 'search', source, name: keyword, count: size || 30, pages: (page || 1) - 1 };
  const r = await http.get(`${base}?${qs(p)}`);
  const data = r.data;
  const arr = Array.isArray(data) ? data : (data && data.data) || [];
  const records = arr.map((s, i) => {
    const id = s.id != null ? String(s.id) : String(s.rid || s.musicrid || i);
    return {
      id,
      rid: id,
      musicName: s.name || s.musicName || s.songName || '',
      musicArtists: Array.isArray(s.artist) ? s.artist.map((a) => (typeof a === 'string' ? a : a.name)).join('/') : (s.artist || s.artists || ''),
      musicAlbum: s.album || '',
      musicImage: s.pic || s.musicImage || '',
      musicDuration: s.duration || s.durationMs || 0,
      bits: ['lossless', 'higher', 'standard'],
      plugName: source,
      source,
      external: 1,
    };
  });
  return { records, searchTotal: records.length };
}

async function sqmusicGetUrl(base, source, id, br) {
  const p = { types: 'url', source, id };
  if (br) p.br = br;
  const r = await http.get(`${base}?${qs(p)}`);
  const d = r.data;
  const u = Array.isArray(d) ? (d[0] || {}) : d;
  return { url: u.url || '', br: u.br || br };
}

async function sqmusicGetLyric(base, source, id) {
  const r = await http.get(`${base}?${qs({ types: 'lyric', source, id })}`);
  const d = r.data;
  const obj = Array.isArray(d) ? (d[0] || {}) : d;
  return { lyric: obj.lyric || obj.lrc || '' };
}

async function sqmusicGetPic(base, source, id) {
  const r = await http.get(`${base}?${qs({ types: 'pic', source, id, size: 300 })}`);
  const d = r.data;
  const obj = Array.isArray(d) ? (d[0] || {}) : d;
  return { url: obj.url || obj.pic || '' };
}

// ========== meting（Meting API） ==========
// Meting 返回项的 url/pic/lrc 均自带一次性 auth 签名，必须原样复用；
// 重新构造 type=url&id= 请求会 401。故用模块级缓存保存搜索时的完整数据。
const metingCache = new Map(); // key: source:id -> { url, pic, lrc }

function metingPut(source, id, data) {
  if (!id) return;
  if (metingCache.size > 300) metingCache.clear();
  metingCache.set(`${source}:${id}`, data);
}
function metingGet(source, id) {
  return metingCache.get(`${source}:${id}`) || null;
}

async function metingSearch(base, source, keyword, page, size) {
  const r = await http.get(`${base}?${qs({ server: source, type: 'search', filter: 'name', value: keyword, page: page || 1, limit: size || 20 })}`);
  const arr = Array.isArray(r.data) ? r.data : [];
  const records = arr.map((s) => {
    // Meting 返回项无独立 id，id 嵌在 url 的 query 里（?server=&type=url&id=xxx&auth=...）
    const m = (s.url || '').match(/[?&]id=([^&]+)/);
    const id = m ? decodeURIComponent(m[1]) : String(s.id != null ? s.id : '');
    if (id) metingPut(source, id, { url: s.url || '', pic: s.pic || '', lrc: s.lrc || '' });
    return {
      id,
      rid: id,
      musicName: s.name || s.title || '',
      musicArtists: Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || s.author || ''),
      musicAlbum: s.album || '',
      musicImage: s.pic || '',
      musicDuration: (parseInt(s.duration || 0, 10) || 0) * 1000,
      bits: ['lossless', 'higher', 'standard'],
      plugName: source,
      source,
      external: 1,
    };
  });
  return { records, searchTotal: records.length };
}

async function metingGetUrl(base, source, id, br) {
  const hit = metingGet(source, id);
  if (hit && hit.url) return { url: hit.url, br };
  const p = { server: source, type: 'url', id };
  if (br) p.br = br;
  const r = await http.get(`${base}?${qs(p)}`);
  const arr = Array.isArray(r.data) ? r.data : [];
  const u = arr[0] || {};
  return { url: u.url || '', br: u.br || br };
}

async function metingGetLyric(base, source, id) {
  const hit = metingGet(source, id);
  if (hit && hit.lrc) return { lyric: hit.lrc };
  const r = await http.get(`${base}?${qs({ server: source, type: 'lyric', id })}`);
  const arr = Array.isArray(r.data) ? r.data : [];
  const u = arr[0] || {};
  return { lyric: u.lyric || '' };
}

async function metingGetPic(base, source, id) {
  const hit = metingGet(source, id);
  if (hit && hit.pic) return { url: hit.pic };
  const r = await http.get(`${base}?${qs({ server: source, type: 'pic', id })}`);
  const arr = Array.isArray(r.data) ? r.data : [];
  const u = arr[0] || {};
  return { url: u.url || '' };
}

// ========== lxmusic（lx-music-api-server） ==========
async function lxRequest(base, path, params, apikey) {
  const headers = {};
  if (apikey) headers['x-api-key'] = apikey;
  return http.get(`${base}${path}?${qs(params)}`, { headers });
}

async function lxmusicSearch(base, source, keyword, page, size, apikey) {
  const r = await lxRequest(base, '/api/search', { source, query: keyword, page: page || 1, limit: size || 20 }, apikey);
  const d = (r.data && r.data.data) || {};
  const arr = d.list || [];
  const records = arr.map((s) => {
    const id = String(s.id != null ? s.id : '');
    return {
      id,
      rid: id,
      musicName: s.name || s.title || '',
      musicArtists: Array.isArray(s.artist) ? s.artist.join('/') : (s.artist || ''),
      musicAlbum: s.album || '',
      musicImage: s.pic || s.img || '',
      musicDuration: s.duration || 0,
      bits: ['lossless', 'higher', 'standard'],
      plugName: source,
      source,
      external: 1,
    };
  });
  return { records, searchTotal: (d.total || arr.length) };
}

async function lxmusicGetUrl(base, source, id, br, apikey) {
  const r = await lxRequest(base, '/api/urls', { id, source }, apikey);
  const d = (r.data && r.data.data) || [];
  // 优先匹配请求码率，否则取第一个可用
  let hit = null;
  for (const u of d) {
    if (!hit) hit = u;
    if (u.br && br && Math.abs(u.br - parseInt(br, 10)) < 100000) { hit = u; break; }
  }
  return { url: (hit && hit.url) || '', br: hit ? String(hit.br || '') : br };
}

async function lxmusicGetLyric(base, source, id, apikey) {
  const r = await lxRequest(base, '/api/lyric', { id, source }, apikey);
  const d = (r.data && r.data.data) || {};
  return { lyric: d.lrc || d.lyric || '' };
}

async function lxmusicGetPic(base, source, id, apikey) {
  const r = await lxRequest(base, '/api/pic', { id, source }, apikey);
  const d = (r.data && r.data.data) || {};
  return { url: d.pic || '' };
}

// ========== neteasecloud（NeteaseCloudMusicApi 实例） ==========
// 注意：签名与其它适配器保持一致 (base, source, keyword, page, size)，source 仅透传不参与请求
async function ncSearch(base, source, keyword, page, size) {
  const r = await http.get(`${base}/search?${qs({ keywords: keyword, limit: size || 20, offset: ((page || 1) - 1) * (size || 20) })}`);
  const songs = (r.data && r.data.result && r.data.result.songs) || [];
  const records = songs.map((s) => {
    const id = String(s.id != null ? s.id : '');
    return {
      id,
      rid: id,
      musicName: s.name || '',
      musicArtists: Array.isArray(s.artists) ? s.artists.map((a) => a.name).join('/') : (s.artist || ''),
      musicAlbum: (s.album && s.album.name) || '',
      musicImage: (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || (s.album && s.album.artist && s.album.artist.img1v1Url) || '',
      musicDuration: s.duration || 0,
      bits: ['lossless', 'higher', 'standard'],
      plugName: 'netease',
      source: 'netease',
      external: 1,
    };
  });
  return { records, searchTotal: records.length };
}

async function ncGetUrl(base, source, id, br) {
  const brMap = { lossless: 999000, higher: 320000, exhigh: 320000, standard: 128000 };
  const r = await http.get(`${base}/song/url?${qs({ id, br: brMap[br] || 320000 })}`);
  const d = (r.data && r.data.data) || [];
  const u = d[0] || {};
  return { url: u.url || '', br };
}

async function ncGetLyric(base, source, id) {
  const r = await http.get(`${base}/lyric?${qs({ id })}`);
  const d = (r.data && r.data.lrc) || {};
  return { lyric: d.lyric || '' };
}

async function ncGetPic(base, source, id) {
  const r = await http.get(`${base}/song/detail?${qs({ ids: id })}`);
  const songs = (r.data && r.data.songs) || [];
  const s = songs[0] || {};
  return { url: (s.al && s.al.picUrl) || '' };
}

// ========== gomusic（guohuiyuan/go-music-api，多平台聚合） ==========
// REST: GET /api/v1/music/search?q=&type=song / /api/v1/music/url?id=&source= / /api/v1/music/lyric / /api/v1/music/cover
// source 平台标识：netease/qq/kugou/kuwo/migu/qianqian/bilibili/joox/jamendo
function gomusicSongToRecord(s) {
  const id = String(s.id != null ? s.id : (s.songmid || s.rid || ''));
  return {
    id,
    rid: id,
    musicName: s.name || s.title || s.songName || '',
    musicArtists: Array.isArray(s.artist) ? s.artist.map((a) => (typeof a === 'string' ? a : (a.name || a))).join('/')
      : (typeof s.artist === 'string' ? s.artist : (s.singer || s.artists || '')),
    musicAlbum: (s.album && (s.album.name || s.album)) || (typeof s.album === 'string' ? s.album : (s.albumName || '')),
    musicImage: s.pic || s.cover || s.albumPic || (s.album && s.album.pic) || s.img || '',
    musicDuration: s.duration || s.durationMs || 0,
    bits: ['lossless', 'higher', 'standard'],
    plugName: (s.source && s.source.name) || 'netease',
    source: (s.source && s.source.name) || 'netease',
    external: 1,
  };
}

async function gomusicSearch(base, source, keyword, page, size) {
  const r = await http.get(`${base}/api/v1/music/search?${qs({ q: keyword, type: 'song' })}`);
  const d = (r.data && (r.data.data || r.data)) || {};
  const arr = Array.isArray(d) ? d : (d.songs || d.list || []);
  const records = arr.map(gomusicSongToRecord);
  return { records, searchTotal: records.length };
}

async function gomusicGetUrl(base, source, id, br) {
  const p = { id, source: source || 'netease' };
  if (br) p.br = br;
  const r = await http.get(`${base}/api/v1/music/url?${qs(p)}`);
  const d = r.data || {};
  // 可能直接返回 url 字符串 / {url} / {data:{url}}
  const u = d.data && (typeof d.data === 'string' ? d.data : (d.data.url || d.data)) || d.url || '';
  return { url: typeof u === 'string' ? u : '', br };
}

async function gomusicGetLyric(base, source, id) {
  const r = await http.get(`${base}/api/v1/music/lyric?${qs({ id, source: source || 'netease' })}`);
  const d = r.data || {};
  const lyric = d.lyric || (d.data && (d.data.lyric || d.data.lrc)) || '';
  return { lyric };
}

async function gomusicGetPic(base, source, id) {
  const r = await http.get(`${base}/api/v1/music/cover?${qs({ id, source: source || 'netease' })}`);
  const d = r.data || {};
  return { url: d.url || (d.data && d.data.url) || '' };
}

// ========== mxget（winterssy/mxget 系，多平台聚合） ==========
// REST: GET /api/{platform}/search/{keyword} / /api/{platform}/song/{id} / /api/{platform}/lyric/{id}
// platform 标识：netease/qq(tencent)/migu/kugou/kuwo
function mxgetPlatform(source) {
  const map = { netease: 'netease', nc: 'netease', qq: 'qq', tencent: 'qq', migu: 'migu', mg: 'migu', kugou: 'kugou', kg: 'kugou', kuwo: 'kuwo', kw: 'kuwo' };
  return map[source] || 'netease';
}

function mxgetSongToRecord(s) {
  const id = String(s.id != null ? s.id : '');
  return {
    id,
    rid: id,
    musicName: s.name || s.title || '',
    musicArtists: s.artist || '',
    musicAlbum: s.album || '',
    musicImage: s.pic_url || s.pic || '',
    musicDuration: (parseInt(s.duration || 0, 10) || 0) * 1000,
    bits: ['lossless', 'higher', 'standard'],
    plugName: mxgetPlatform(s.platform),
    source: mxgetPlatform(s.platform),
    external: 1,
  };
}

async function mxgetSearch(base, source, keyword, page, size) {
  const plat = mxgetPlatform(source);
  const r = await http.get(`${base}/api/${plat}/search/${encodeURIComponent(keyword)}`);
  const d = (r.data && (r.data.data || r.data)) || {};
  const arr = Array.isArray(d) ? d : (d.songs || d.list || []);
  const records = arr.map(mxgetSongToRecord);
  return { records, searchTotal: records.length };
}

async function mxgetGetUrl(base, source, id, br) {
  const plat = mxgetPlatform(source);
  const r = await http.get(`${base}/api/${plat}/song/${encodeURIComponent(id)}`);
  const d = (r.data && (r.data.data || r.data)) || {};
  return { url: d.url || d.play_url || '', br };
}

async function mxgetGetLyric(base, source, id) {
  const plat = mxgetPlatform(source);
  const r = await http.get(`${base}/api/${plat}/lyric/${encodeURIComponent(id)}`);
  const d = (r.data && (r.data.data || r.data)) || {};
  return { lyric: d.lyric || d.lrc || '' };
}

async function mxgetGetPic(base, source, id) {
  const plat = mxgetPlatform(source);
  const r = await http.get(`${base}/api/${plat}/song/${encodeURIComponent(id)}`);
  const d = (r.data && (r.data.data || r.data)) || {};
  return { url: d.pic_url || d.pic || '' };
}

// ========== 统一入口 ==========
const ADAPTERS = {
  sqmusic: { search: sqmusicSearch, getUrl: sqmusicGetUrl, getLyric: sqmusicGetLyric, getPic: sqmusicGetPic },
  meting: { search: metingSearch, getUrl: metingGetUrl, getLyric: metingGetLyric, getPic: metingGetPic },
  lxmusic: { search: lxmusicSearch, getUrl: lxmusicGetUrl, getLyric: lxmusicGetLyric, getPic: lxmusicGetPic },
  neteasecloud: { search: ncSearch, getUrl: ncGetUrl, getLyric: ncGetLyric, getPic: ncGetPic },
  gomusic: { search: gomusicSearch, getUrl: gomusicGetUrl, getLyric: gomusicGetLyric, getPic: gomusicGetPic },
  mxget: { search: mxgetSearch, getUrl: mxgetGetUrl, getLyric: mxgetGetLyric, getPic: mxgetGetPic },
};

function getAdapter(protocol) {
  return ADAPTERS[protocol] || ADAPTERS.sqmusic;
}

// 统一搜索入口：返回 sqmusic 兼容 records
async function externalSearch({ protocol, base, source, keyword, page, size }) {
  const p = protocol || 'sqmusic';
  const a = getAdapter(p);
  const res = await a.search(normBase(base), source || 'netease', keyword, page || 1, size || 30, '');
  return res;
}

// 统一取链入口
async function externalGetUrl({ protocol, base, source, id, br }) {
  const p = protocol || 'sqmusic';
  const a = getAdapter(p);
  const res = await a.getUrl(normBase(base), source || 'netease', String(id), br || '');
  return res;
}

// 统一歌词入口
async function externalGetLyric({ protocol, base, source, id }) {
  const p = protocol || 'sqmusic';
  const a = getAdapter(p);
  return a.getLyric(normBase(base), source || 'netease', String(id), '');
}

// 统一封面入口
async function externalGetPic({ protocol, base, source, id }) {
  const p = protocol || 'sqmusic';
  const a = getAdapter(p);
  return a.getPic(normBase(base), source || 'netease', String(id), '');
}

module.exports = {
  ADAPTERS,
  externalSearch,
  externalGetUrl,
  externalGetLyric,
  externalGetPic,
};
