// api-enhanced 网易云后端客户端（接口与原版 NeteaseCloudMusicApi 兼容）
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ===== 登录态持久化（cookie 落盘，重启自动恢复）=====
// data 目录已挂载到 NAS 持久卷（/vol4/1000/download-service/data），重启容器不丢失
const COOKIE_FILE = path.join(__dirname, '..', 'data', 'ncm_cookie.txt');

let ncmCookie = '';

function loadNcmCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const c = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      if (c) ncmCookie = c;
    }
  } catch (e) {
    console.error('加载登录态失败:', e.message);
  }
}

function saveNcmCookie(cookie) {
  if (!cookie) return;
  ncmCookie = cookie;
  try {
    fs.writeFileSync(COOKIE_FILE, cookie, 'utf8');
  } catch (e) {
    console.error('保存登录态失败:', e.message);
  }
}

function clearNcmCookie() {
  ncmCookie = '';
  try {
    if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  } catch (e) {
    console.error('清除登录态失败:', e.message);
  }
}

// 启动时恢复登录态
loadNcmCookie();

// ===== 网易云多网关客户端（抗上游 502 风控）=====
// 借鉴多网关 failover / header 轮换设计思路（自研实现，不引用任何外部源码）：
// - NCM_API_BASE 支持逗号分隔多网关；网络错误 / 5xx / 429 时自动切换下一网关重试
// - 随机 User-Agent 轮换 + 固定音乐站 Referer，降低风控特征
// - 所有请求统一自动携带实时毫秒时间戳（调用点显式传 timestamp 时以显式为准）
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];

function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 构建单网关 axios 实例：注入登录态 cookie、随机 UA/Referer，并挂 301 登录态自动刷新拦截器
function makeNcmClient(baseURL) {
  const c = axios.create({ baseURL, timeout: 30000 });
  c.interceptors.request.use((cfg) => {
    cfg.headers = cfg.headers || {};
    if (ncmCookie) cfg.headers['Cookie'] = ncmCookie;
    cfg.headers['User-Agent'] = randomUA();
    if (!cfg.headers['Referer']) cfg.headers['Referer'] = 'https://music.163.com/';
    return cfg;
  });
  c.interceptors.response.use(handleNcmSuccess, handleNcmError);
  return c;
}

// ===== Cookie 自动刷新（登录态失效自动续期）=====
// 检测到接口返回"需要登录"（code 301/401 或 HTTP 401/403）时，调用 ncm-api /login/refresh
// 自动刷新 cookie 并重新落盘，避免过期后需手动重新扫码。刷新失败不抛错、不阻塞下载，
// 直接回退返回原响应（调用方按原有逻辑降级/兜底）。
let refreshing = null;            // 正在进行的刷新 Promise（防并发，多请求只刷一次）
let refreshFailLogged = false;    // 刷新失败日志去重

// 调用 /login/refresh 刷新并重新落盘（裸 axios 直连，不经 client 拦截器避免自触发）
async function refreshNcmCookie() {
  try {
    const resp = await axios.get(config.ncmApiBases[0] + '/login/refresh', {
      params: { timestamp: Date.now() },
      timeout: 30000,
      headers: Object.assign(
        ncmCookie ? { Cookie: ncmCookie } : {},
        { 'User-Agent': randomUA(), Referer: 'https://music.163.com/' }
      )
    });
    const code = resp.data && resp.data.code;
    const cookie = (resp.data && resp.data.cookie) || '';
    if (cookie) {
      saveNcmCookie(cookie);
      console.log('[netease] 登录态已自动刷新并重新落盘');
      refreshFailLogged = false;
      return { ok: true, code, cookie };
    }
    console.warn(`[netease] 登录刷新未返回新 cookie（code=${code}），可能需重新扫码`);
    return { ok: false, code, cookie: '' };
  } catch (e) {
    if (!refreshFailLogged) {
      console.warn('[netease] 登录刷新失败（不阻塞下载，回退原流程）: ' + e.message);
      refreshFailLogged = true;
    }
    return { ok: false, error: e.message };
  }
}

// 需要登录判定：ncm-api 业务码 301/401，或 HTTP 401/403
function needLogin(code, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  return code === 301 || code === 401;
}

// 上游网关业务失败码：HTTP 200 但 ncm-api 透传上游 502/503/504 时视为网关不可用，触发 failover
const UPSTREAM_BAD_CODES = [502, 503, 504];

// 构造带可重试标记的错误（供 failover 层识别"网关不可用"而非"请求本身错误"）
function makeRetryableErr(msg, extra = {}) {
  const e = new Error(msg);
  e.__ncmRetryable = true;
  return Object.assign(e, extra);
}

// 响应成功拦截器：登录态失效时自动刷新一次并重放原请求（带新 cookie）
async function handleNcmSuccess(resp) {
  const cfg = resp.config || {};
  const code = resp.data && resp.data.code;
  if (needLogin(code, resp.status) && !cfg._ncmRefreshed) {
    cfg._ncmRefreshed = true;
    if (!refreshing) {
      refreshing = refreshNcmCookie().finally(() => { refreshing = null; });
    }
    await refreshing;
    // 重放原请求（手动注入刷新后的新 cookie；裸 axios 重放避免递归触发拦截器；
    // 刷新失败则重放仍 301，因 _ncmRefreshed 已置位不再递归，直接返回该响应走原逻辑）
    cfg.headers = cfg.headers || {};
    cfg.headers['Cookie'] = ncmCookie;
    return axios.request(cfg);
  }
  // 业务层失败检测：HTTP 200 但 body 透传上游 5xx 业务码（网易云封禁/上游不可用），
  // 抛可重试错误让 failover 层切到下一网关
  if (code && UPSTREAM_BAD_CODES.indexOf(code) !== -1) {
    throw makeRetryableErr(
      `上游返回业务码 ${code} (${resp.config && resp.config.baseURL || ''})`,
      { response: { status: 200, data: resp.data } }
    );
  }
  return resp;
}

// 响应错误拦截器：HTTP 401/403 时同样刷新登录态并重放一次
async function handleNcmError(err) {
  const cfg = err.config || {};
  const status = err.response && err.response.status;
  if ((status === 401 || status === 403) && !cfg._ncmRefreshed) {
    cfg._ncmRefreshed = true;
    if (!refreshing) {
      refreshing = refreshNcmCookie().finally(() => { refreshing = null; });
    }
    await refreshing;
    cfg.headers = cfg.headers || {};
    cfg.headers['Cookie'] = ncmCookie;
    return axios.request(cfg);
  }
  throw err;
}

// 统一请求入口：多网关 failover + 网关内退避重试 + 自动实时时间戳
// 失败分级：
//   - 业务 4xx（非 429）/ 4xx HTTP（非 429）→ 请求本身问题，直接抛，不重试不切网关
//   - 网络错误 / 5xx / 429 / 上游业务码 502,503,504 → 网关不可用
//     同一网关先退避重试（最多 retriesPerGateway 次），仍失败再切下一网关
async function requestWithFailover(method, url, cfg = {}) {
  const params = Object.assign({}, cfg.params || {});
  if (!('timestamp' in params)) params.timestamp = Date.now();
  const baseCfg = Object.assign({}, cfg, { method, url, params });
  const bases = config.ncmApiBases;
  const retriesPerGateway = 2;                 // 每网关最多尝试次数
  const backoffMs = [300, 800];                // 网关内退避（两次重试）
  const switchDelay = [150, 300];              // 跨网关切换等待（指数+抖动）
  let lastErr = null;
  for (let i = 0; i < bases.length; i++) {
    const instance = makeNcmClient(bases[i]);
    for (let attempt = 0; attempt < retriesPerGateway; attempt++) {
      try {
        return await instance.request(baseCfg);
      } catch (e) {
        lastErr = e;
        const status = e.response && e.response.status;
        // 请求本身错误（业务 4xx 或 HTTP 4xx 且非 429）不重试、不切网关
        if (status && status >= 400 && status < 500 && status !== 429) throw e;
        const isLastAttempt = attempt === retriesPerGateway - 1;
        const isLastGateway = i === bases.length - 1;
        if (isLastAttempt && isLastGateway) {
          // 所有网关都试尽，抛最后一次错误
          break;
        }
        const where = isLastAttempt ? `切换备用网关 ${bases[Math.min(i + 1, bases.length - 1)]}` : `网关内重试 (第${attempt + 2}次)`;
        console.warn(`[netease] ${bases[i]} ${method.toUpperCase()} ${url} 失败(${e.message})，${where}`);
        // 跨网关切换用更长退避；网关内重试用短退避
        const delay = isLastAttempt ? switchDelay[i % switchDelay.length] : backoffMs[attempt];
        await sleep(delay + Math.floor(Math.random() * 100));
      }
    }
  }
  throw lastErr;
}

// ===== 全局请求节流（需求15：防止高频请求触发上游风控）=====
// 令牌桶：每秒最多 NCM_MAX_RPS 个请求（默认 10），突发时排队等待补桶。
// 覆盖所有经 netease client 发出的上游请求，从源头抑制请求速率。
const NCM_MAX_RPS = parseInt(process.env.NCM_MAX_RPS || '10', 10) || 10;
const TOKEN_WINDOW_MS = 1000;
let ncmTokens = NCM_MAX_RPS;
let ncmWindowStart = Date.now();

async function acquireNcmToken() {
  for (;;) {
    const now = Date.now();
    if (now - ncmWindowStart >= TOKEN_WINDOW_MS) {
      ncmTokens = NCM_MAX_RPS;
      ncmWindowStart = now;
    }
    if (ncmTokens > 0) {
      ncmTokens--;
      return;
    }
    await sleep(50); // 50ms 轮询补桶，避免忙等
  }
}

async function throttledRequest(method, url, cfg) {
  await acquireNcmToken();
  return requestWithFailover(method, url, cfg);
}

// 对外暴露的 client：保持既有调用点不变（client.get(url, cfg) / client.post(url, cfg)）
const client = {
  get(url, cfg) { return throttledRequest('get', url, cfg); },
  post(url, cfg) { return throttledRequest('post', url, cfg); }
};

// 网易云封面 picUrl 返回 http 协议，在 https 页面会被 mixed content 拦截 / 图床防盗链，
// 统一替换为 https（https://p*.music.126.net 已验证可访问）
function neteaseHttps(url) {
  return url ? String(url).replace(/^http:\/\//, 'https://') : '';
}

// 搜索歌曲
// 返回前端期望的 records 格式
async function searchSong(keyword, pageSize = 20, pageIndex = 1) {
  const offset = (pageIndex - 1) * pageSize;
  const resp = await client.get('/cloudsearch', {
    params: { keywords: keyword, limit: pageSize, offset, type: 1 }
  });
  const result = resp.data.result || {};
  const songs = result.songs || [];
  const records = songs.map(s => ({
    id: String(s.id),
    musicName: s.name,
    musicArtists: (s.ar || []).map(a => a.name).join('/'),
    artistsIds: (s.ar || []).map(a => String(a.id)).join(','),
    musicImage: neteaseHttps(s.al && s.al.picUrl),
    musicAlbum: (s.al && s.al.name) || '',
    // 单曲卡片点击“专辑”标签、下载单曲时依赖专辑ID
    albumid: (s.al && String(s.al.id)) || '',
    musicDuration: s.dt || 0,
    bits: ['lossless', 'exhigh', 'standard'],
    plugName: 'netease'
  }));
  return {
    records,
    searchTotal: result.songCount || records.length
  };
}

// 搜索专辑（/cloudsearch type=10）
// 返回前端 V3Search 专辑卡片期望的 records 格式
async function searchAlbum(keyword, pageSize = 20, pageIndex = 1) {
  const offset = (pageIndex - 1) * pageSize;
  const resp = await client.get('/cloudsearch', {
    params: { keywords: keyword, limit: pageSize, offset, type: 10 }
  });
  const result = resp.data.result || {};
  const albums = result.albums || [];
  const records = albums.map(a => {
    const artist = (a.artist && a.artist.name) ? a.artist : ((a.artists && a.artists[0]) || {});
    return {
      id: String(a.id),
      albumid: String(a.id),
      musicAlbum: a.name || '',
      musicImage: a.picUrl || '',
      musicArtists: artist.name || '',
      artistsIds: artist.id ? String(artist.id) : '',
      musicDuration: 0,
      bits: ['lossless', 'exhigh', 'standard'],
      plugName: 'netease'
    };
  });
  return {
    records,
    searchTotal: result.albumCount || records.length
  };
}

// 搜索歌手（/cloudsearch type=100）
// 返回前端 V3Search 歌手卡片期望的 records 格式
async function searchArtist(keyword, pageSize = 20, pageIndex = 1) {
  const offset = (pageIndex - 1) * pageSize;
  const resp = await client.get('/cloudsearch', {
    params: { keywords: keyword, limit: pageSize, offset, type: 100 }
  });
  const result = resp.data.result || {};
  const artists = result.artists || [];
  const records = artists.map(a => ({
    id: String(a.id),
    musicArtists: a.name || '',
    musicImage: a.picUrl || '',
    // 歌手卡片“专辑数”展示位：使用歌手专辑数量
    musicAlbum: a.albumSize || 0,
    plugName: 'netease'
  }));
  return {
    records,
    searchTotal: result.artistCount || records.length
  };
}

// 搜索歌单（/cloudsearch type=1000）
// 返回前端歌单卡片期望的 records 格式
async function searchPlaylist(keyword, pageSize = 20, pageIndex = 1) {
  const offset = (pageIndex - 1) * pageSize;
  const resp = await client.get('/cloudsearch', {
    params: { keywords: keyword, limit: pageSize, offset, type: 1000 }
  });
  const result = resp.data.result || {};
  const playlists = result.playlists || [];
  const records = playlists.map(p => ({
    id: String(p.id),
    name: p.name || '',
    cover: (p.coverImgUrl) || (p.creator && p.creator.avatarUrl) || '',
    creator: (p.creator && p.creator.nickname) || '',
    trackCount: p.trackCount || 0,
    playCount: p.playCount || 0,
    plugName: 'netease'
  }));
  return {
    records,
    searchTotal: result.playlistCount || records.length
  };
}

// 搜索播客（DJ电台/节目 /cloudsearch type=1009）
// 返回前端播客卡片期望的 records 格式
async function searchDj(keyword, pageSize = 20, pageIndex = 1) {
  const offset = (pageIndex - 1) * pageSize;
  const resp = await client.get('/cloudsearch', {
    params: { keywords: keyword, limit: pageSize, offset, type: 1009 }
  });
  const result = resp.data.result || {};
  const djs = result.djRadios || [];
  const records = djs.map(d => ({
    id: String(d.id),
    name: d.name || '',
    cover: d.picUrl || '',
    // 播客主理人 / 简介 / 节目数 供卡片展示
    creator: (d.dj && d.dj.nickname) || '',
    desc: d.desc || '',
    programCount: d.programCount || 0,
    playCount: d.playCount || 0,
    type: 'dj',
    plugName: 'netease'
  }));
  return {
    records,
    searchTotal: result.djRadiosCount || records.length
  };
}

// 推荐播客（/personalized/djprogram 或 /dj/recommend）
// 返回播客电台列表（归一化与 searchDj 一致）
async function getDjRecommend(limit = 12) {
  try {
    const resp = await client.get('/personalized/djprogram', {
      params: { limit: Math.min(parseInt(limit) || 12, 50), timestamp: Date.now() }
    });
    const result = resp.data.result || [];
    return result.map(d => ({
      id: String(d.program && d.program.radio ? d.program.radio.id : (d.id || '')),
      name: (d.program && d.program.name) || d.name || '',
      cover: (d.program && d.program.coverUrl) || d.picUrl || d.coverUrl || '',
      creator: (d.program && d.program.dj && d.program.dj.nickname) || '',
      desc: (d.program && d.program.desc) || '',
      programCount: (d.program && d.program.radio && d.program.radio.programCount) || 0,
      playCount: d.playCount || 0,
      type: 'dj',
      plugName: 'netease'
    }));
  } catch (e) {
    // 推荐接口偶发失败时退化为空，不阻塞主页
    return [];
  }
}

// 获取播客电台详情（含节目列表 /dj/program）
async function getDjDetail(id, pageSize = 20, pageIndex = 1) {
  const resp = await client.get('/dj/program', {
    params: { rid: id, limit: Math.min(parseInt(pageSize) || 20, 50), offset: (pageIndex - 1) * pageSize }
  });
  const program = resp.data.program || {};
  const programs = resp.data.programs || [];
  return {
    id: String(id),
    name: program.name || '',
    cover: program.picUrl || '',
    desc: program.desc || '',
    dj: (program.dj && program.dj.nickname) || '',
    programs: programs.map(p => ({
      id: String(p.id),
      musicName: p.name || '',
      musicArtists: (p.dj && p.dj.nickname) || '',
      musicImage: p.coverUrl || p.picUrl || '',
      musicAlbum: p.radio ? (p.radio.name || '') : '',
      musicDuration: p.duration || p.mainSong ? (p.mainSong.dt || 0) : 0,
      // 播客节目内嵌 mainSong，可直接用其歌曲ID播放/下载
      mainSongId: (p.mainSong && String(p.mainSong.id)) || '',
      plugName: 'netease'
    }))
  };
}

// 搜索提示
async function searchTips(keyword) {
  const resp = await client.get('/search/suggest', {
    params: { keywords: keyword, type: 1 }
  });
  const result = resp.data.result || {};
  const songs = result.songs || [];
  return songs.map(s => s.name).slice(0, 10);
}

// 获取下载直链
// brType: standard/higher/exhigh/lossless/hires
async function getSongUrl(id, brType = 'lossless') {
  const resp = await client.get('/song/url/v1', {
    params: { id, level: brType }
  });
  const data = resp.data.data || [];
  if (data.length === 0) return null;
  const item = data[0];
  if (!item.url) return null;
  return {
    url: item.url,
    br: item.br || 0,
    size: item.size || 0,
    type: item.type || ''
  };
}

// 获取歌词
async function getLyric(id) {
  const resp = await client.get('/lyric', { params: { id } });
  const lrc = resp.data.lrc || {};
  return { lyric: lrc.lyric || '' };
}

// 获取歌曲详情（用于下载时补全信息）
async function getSongDetail(id) {
  const resp = await client.get('/song/detail', { params: { ids: id } });
  const songs = resp.data.songs || [];
  if (songs.length === 0) return null;
  const s = songs[0];
  return {
    id: String(s.id),
    name: s.name,
    artists: (s.ar || []).map(a => a.name).join('/'),
    artistIds: (s.ar || []).map(a => String(a.id)).join(','),
    album: (s.al && s.al.name) || '',
    albumId: (s.al && String(s.al.id)) || '',
    image: neteaseHttps(s.al && s.al.picUrl),
    duration: s.dt || 0,
    date: (s.al && s.al.publishTime) ? String(new Date(s.al.publishTime).getFullYear()) : ''
  };
}

// 获取专辑详情
async function getAlbumDetail(id) {
  const resp = await client.get('/album', { params: { id } });
  const album = resp.data.album || {};
  const songs = resp.data.songs || [];
  return {
    // 字段对齐前端 AlbumInfo.vue：albumImg/albumName/albumSinger/albumTime/albumDescribe
    albumImg: neteaseHttps(album.picUrl),
    albumName: album.name || '',
    albumSinger: (album.artist && album.artist.name) || '',
    albumSongCount: album.size || songs.length,
    albumTime: album.publishTime ? String(new Date(album.publishTime).getFullYear()) : '',
    albumDescribe: album.description || '',
    musics: songs.map(s => ({
      id: String(s.id),
      musicName: s.name,
      musicArtists: (s.ar || []).map(a => a.name).join('/'),
      artistsIds: (s.ar || []).map(a => String(a.id)).join(','),
      musicImage: (s.al && s.al.picUrl) || '',
      musicAlbum: (s.al && s.al.name) || '',
      musicDuration: s.dt || 0,
      trackNo: (s.no != null ? s.no : 0), // 音轨号（用于本地标签补全）
      bits: ['lossless', 'exhigh', 'standard'],
      plugName: 'netease'
    }))
  };
}

// 获取歌手信息及专辑列表（字段对齐前端 ArtistInfo.vue）
async function getArtistInfo(id) {
  const detailResp = await client.get('/artist/detail', { params: { id } });
  const albumResp = await client.get('/artist/album', { params: { id, limit: 100, offset: 0 } });
  // 需求5：歌手简介（/artist/desc 返回含换行的 briefDesc；失败不阻塞主流程）
  let briefDesc = '';
  try {
    const descResp = await client.get('/artist/desc', { params: { id } });
    briefDesc = (descResp.data.data && descResp.data.data.briefDesc) || '';
  } catch (e) {
    briefDesc = '';
  }
  const data = detailResp.data.data || {};
  const artist = data.artist || {};
  const albums = albumResp.data.hotAlbums || albumResp.data.albums || [];
  return {
    musicArtistsName: artist.name || '',
    musicArtistsPhoto: artist.picUrl || '',
    musicArtistsAlias: (artist.alias || []).join('/'),
    musicArtistsDesc: briefDesc || artist.briefDesc || '',
    albums: albums.map(a => ({
      albumId: String(a.id),
      albumName: a.name || '',
      albumImg: a.picUrl || a.blurPicUrl || '',
      albumTime: a.publishTime ? String(new Date(a.publishTime).getFullYear()) + ' 年' : ''
    }))
  };
}

// 按首字母获取歌手列表（网易云 /artist/list，initial=a~z）
// area 参考网易云地区分类：-1 全部 / 7 华语 / 96 欧美 / 8 日本 / 16 韩国 / 0 其他
// 支持逗号分隔多地区合并（如 '8,16' 表示日韩合并）
// type 参考网易云歌手分类：-1 全部 / 1 男歌手 / 2 女歌手 / 3 乐队组合
async function getArtistList(initial, pageSize = 30, pageIndex = 1, area = -1, type = -1) {
  const offset = (pageIndex - 1) * pageSize;
  const params = { type: -1, area: -1, limit: pageSize, offset };
  const typeNum = parseInt(type);
  if (!isNaN(typeNum) && typeNum >= 1 && typeNum <= 3) params.type = typeNum;
  if (initial && initial !== '#' && initial.toLowerCase() !== 'all') params.initial = initial.toLowerCase();

  // 多地区合并：拆开分别请求后拼接（去重）
  const areaList = String(area).split(',').map(s => s.trim()).filter(Boolean);
  const useArea = areaList.length === 1 ? parseInt(areaList[0]) : null;
  // 单地区或「全部(-1)」：area=-1 表示全部地区（含热门），直接单请求
  if (useArea !== null && !isNaN(useArea) && useArea >= -1) {
    params.area = useArea;
    const resp = await client.get('/artist/list', { params });
    const artists = resp.data.artists || [];
    return {
      records: artists.map(a => ({
        id: String(a.id),
        musicArtists: a.name || '',
        musicArtistsAlias: (a.alias || []).join('/'),
        musicImage: a.picUrl || a.img1v1Url || '',
        musicAlbum: a.albumSize || 0,
        musicSize: a.musicSize || 0,
        plugName: 'netease'
      })),
      more: resp.data.more !== false
    };
  }

  // 多地区合并请求（如日韩 = 日本8 + 韩国16）
  const merged = [];
  let more = false;
  for (const a of areaList) {
    const areaNum = parseInt(a);
    if (isNaN(areaNum) || areaNum < 0) continue;
    const p = { ...params, area: areaNum };
    const resp = await client.get('/artist/list', { params: p });
    const artists = resp.data.artists || [];
    artists.forEach(ar => {
      if (!merged.find(m => String(m.id) === String(ar.id))) {
        merged.push(ar);
      }
    });
    if (resp.data.more !== false) more = true;
  }
  return {
    records: merged.map(a => ({
      id: String(a.id),
      musicArtists: a.name || '',
      musicArtistsAlias: (a.alias || []).join('/'),
      musicImage: a.picUrl || a.img1v1Url || '',
      musicAlbum: a.albumSize || 0,
      musicSize: a.musicSize || 0,
      plugName: 'netease'
    })),
    more
  };
}

// 获取网易云榜单列表（/toplist）
async function getToplist() {
  const resp = await client.get('/toplist');
  const list = resp.data.list || [];
  return list.map(t => ({
    id: String(t.id),
    name: t.name || '',
    cover: t.coverImgUrl || '',
    playCount: t.playCount || 0,
    updateFrequency: t.updateFrequency || '',
    trackCount: t.trackCount || 0,
    description: t.description || ''
  }));
}

// 获取热门歌单（/top/playlist，网易云 cat 分类）
async function getTopPlaylist(cat = '全部', limit = 12) {
  const resp = await client.get('/top/playlist', {
    params: { cat, order: 'hot', limit: Math.min(parseInt(limit) || 12, 50), offset: 0 }
  });
  const playlists = resp.data.playlists || [];
  return playlists.map(p => ({
    id: String(p.id),
    name: p.name || '',
    cover: p.coverImgUrl || '',
    trackCount: p.trackCount || 0,
    playCount: p.playCount || 0,
    description: p.description || '',
    creator: (p.creator && p.creator.nickname) || ''
  }));
}

// 按 id 获取歌单/榜单详情（信息 + 歌曲列表）
async function getPlaylistDetail(id) {
  // ncm-api 上游对网易云实时接口偶发 502/超时，做最多 3 次退避重试，屏蔽瞬时抖动
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 400 * attempt)); // 0.4s / 0.8s
    }
    try {
      const infoResp = await client.get('/playlist/detail', { params: { id } });
      const playlist = infoResp.data.playlist || {};
      const tracks = await getPlaylistTracks(id);
      return {
        id: String(playlist.id || id),
        name: playlist.name || '',
        cover: playlist.coverImgUrl || '',
        trackCount: playlist.trackCount || tracks.length,
        playCount: playlist.playCount || 0,
        description: playlist.description || '',
        updateFrequency: playlist.updateFrequency || '',
        tracks
      };
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const transient = status >= 500 || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ERR_BAD_RESPONSE';
      if (!transient || attempt === 2) break;
      console.warn('[netease] getPlaylistDetail 第' + (attempt + 1) + '次失败(' + e.message + ')，重试');
    }
  }
  throw lastErr;
}

// 解析歌单 URL，返回歌单信息
async function parsePlaylistUrl(url) {
  // 支持格式：
  // https://music.163.com/#/playlist?id=xxx
  // https://y.music.163.com/m/playlist?id=xxx
  // https://music.163.com/playlist/xxx
  let id = null;
  const m1 = url.match(/[?&]id=(\d+)/);
  const m2 = url.match(/playlist\/(\d+)/);
  if (m1) id = m1[1];
  else if (m2) id = m2[1];
  if (!id) throw new Error('无法识别的歌单链接');

  const resp = await client.get('/playlist/detail', { params: { id } });
  const playlist = resp.data.playlist;
  if (!playlist) throw new Error('歌单不存在或需要登录');

  return {
    plugName: 'netease',
    type: 'playlist',
    id: String(playlist.id),
    name: playlist.name,
    url,
    count: playlist.trackCount || 0,
    desc: playlist.description || '',
    cover: playlist.coverImgUrl || ''
  };
}

// 获取歌单全部歌曲
async function getPlaylistTracks(id) {
  // ncm-api 上游对 /playlist/track/all 带登录态的请求有频率限制，短时高频会触发约 8s 的 502 窗口。
  // 因此做最多 4 次、1s/3s/7s 递增退避重试，跨过限流窗口后再取，恢复后返回完整歌曲列表。
  let lastErr = null;
  const backoff = [1000, 3000, 7000];
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, backoff[attempt - 1]));
    }
    try {
      const resp = await client.get('/playlist/track/all', {
        params: { id, limit: 1000 }
      });
      const songs = resp.data.songs || [];
      if (songs.length === 0) {
        // 歌单可能确实为空，不重试
        return [];
      }
      return songs.map(s => ({
    id: String(s.id),
    name: s.name,
    artists: (s.ar || []).map(a => a.name).join('/'),
    artistIds: (s.ar || []).map(a => String(a.id)).join(','),
    album: (s.al && s.al.name) || '',
    albumId: (s.al && String(s.al.id)) || '',
    image: (s.al && s.al.picUrl) || '',
    duration: s.dt || 0
  }));
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const transient = status >= 500 || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ERR_BAD_RESPONSE';
      if (!transient || attempt === 2) break;
      console.warn('[netease] getPlaylistTracks 第' + (attempt + 1) + '次失败(' + e.message + ')，重试');
    }
  }
  throw lastErr;
}

// ===== 网易云主页模块 =====

// 轮播 Banner（/banner）
async function getBanner() {
  const resp = await client.get('/banner', { params: { type: 2, timestamp: Date.now() } });
  const banners = resp.data.banners || [];
  return banners.map(b => ({
    id: b.bannerId || b.targetId || '',
    title: b.typeTitle || '',
    imageUrl: b.imageUrl || b.pic || '',
    url: b.url || '',
    songId: (b.targetType === 1 && b.targetId) ? String(b.targetId) : ''
  }));
}

// 新歌速递（/top/song type=0 全部）
async function getNewSongs(limit = 20) {
  const resp = await client.get('/top/song', {
    params: { type: 0, limit: Math.min(parseInt(limit) || 20, 50), timestamp: Date.now() }
  });
  const songs = resp.data.data || [];
  return songs.map(s => ({
    id: String(s.id),
    musicName: s.name,
    musicArtists: (s.artists || s.ar || []).map(a => a.name).join('/'),
    artistsIds: (s.artists || s.ar || []).map(a => String(a.id)).join(','),
    musicImage: ((s.album || s.al) && (s.album.picUrl || s.al.picUrl)) || '',
    musicAlbum: ((s.album || s.al) && (s.album.name || s.al.name)) || '',
    albumid: ((s.album || s.al) && String((s.album.id || s.al.id) || '')) || '',
    musicDuration: s.duration || s.dt || 0,
    bits: ['lossless', 'exhigh', 'standard'],
    plugName: 'netease'
  }));
}

// 新碟上架（/top/album）
async function getNewAlbums(limit = 10) {
  const resp = await client.get('/top/album', {
    params: { limit: Math.min(parseInt(limit) || 10, 50), timestamp: Date.now() }
  });
  const albums = (resp.data.weekData && resp.data.weekData.length)
    ? resp.data.weekData
    : (resp.data.data || []);
  return albums.map(a => {
    const artist = (a.artist && a.artist.name)
      ? a.artist
      : ((a.artists && a.artists[0]) || {});
    return {
      id: String(a.id),
      albumid: String(a.id),
      musicAlbum: a.name || '',
      musicImage: a.picUrl || a.blurPicUrl || '',
      musicArtists: artist.name || '',
      artistsIds: artist.id ? String(artist.id) : '',
      musicDuration: 0,
      bits: ['lossless', 'exhigh', 'standard'],
      plugName: 'netease'
    };
  });
}

// 个性化推荐歌单（/personalized）
async function getRecommendPlaylist(limit = 12) {
  const resp = await client.get('/personalized', {
    params: { limit: Math.min(parseInt(limit) || 12, 50), timestamp: Date.now() }
  });
  const result = resp.data.result || [];
  return result.map(p => ({
    id: String(p.id),
    name: p.name || '',
    cover: p.picUrl || '',
    trackCount: p.trackCount || 0,
    playCount: p.playCount || 0,
    copywriter: p.copywriter || '',
    description: p.copywriter || ''
  }));
}

// ===== 网易云账号登录（二维码）=====

// 获取二维码 key
async function createQrKey() {
  const resp = await client.get('/login/qr/key', { params: { timestamp: Date.now() } });
  return { key: (resp.data.data && resp.data.data.unikey) || '' };
}

// 生成二维码（含 qrimg 图片）
async function createQrCode(key) {
  const resp = await client.get('/login/qr/create', {
    params: { key, qrimg: true, timestamp: Date.now() }
  });
  return {
    qrurl: (resp.data.data && resp.data.data.qrurl) || '',
    qrimg: (resp.data.data && resp.data.data.qrimg) || ''
  };
}

// 用待落盘 cookie 直连 ncm-api /login/status，校验是否为真实登录态（非匿名/降级）
// 网易云对数据中心 IP 有风控，扫码 803 返回的 cookie 可能是匿名会话（anonimousUser=true、profile=null），
// 若直接落盘会导致 loginStatus 恒为 loggedIn:false、扫码"成功"却登不上。故落盘前先验证。
async function verifyQrCookieValid(cookie) {
  try {
    const resp = await axios.get(config.ncmApiBases[0] + '/login/status', {
      params: { timestamp: Date.now() },
      timeout: 15000,
      headers: Object.assign(
        cookie ? { Cookie: cookie } : {},
        { 'User-Agent': randomUA(), Referer: 'https://music.163.com/' }
      )
    });
    const data = (resp.data && resp.data.data) || {};
    const account = data.account || {};
    const profile = data.profile || {};
    // ncm-api /login/status 的 account 返回 id 而非 userId，两者都兼容
    const uid = account.userId || account.id;
    const loggedIn = !!(uid && !account.anonimousUser && profile.userId);
    return { valid: loggedIn, error: '' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// 轮询扫码状态
// code: 800 二维码过期 / 801 等待扫码 / 802 已扫码待确认 / 803 授权登录成功
async function checkQrStatus(key) {
  const resp = await client.get('/login/qr/check', {
    params: { key, timestamp: Date.now() }
  });
  const code = resp.data.code;
  const cookie = resp.data.cookie || '';
  // 登录成功（803）时：先校验 cookie 是否为真实登录态，有效才持久化（重启自动恢复）
  if (code === 803 && cookie) {
    const v = await verifyQrCookieValid(cookie);
    if (v.valid) {
      saveNcmCookie(cookie);
      return { code, message: resp.data.message || '', cookie, valid: true };
    }
    // cookie 无效（匿名/风控降级）：不落盘，返回 800 让前端提示重新扫码
    console.warn('[netease] 803 返回 cookie 校验未通过(可能匿名/风控)，不落盘: ' + (v.error || 'anonimousUser'));
    return { code: 800, message: '扫码已确认但登录态未生效，请刷新二维码重试', cookie: '', valid: false };
  }
  return {
    code,
    message: resp.data.message || '',
    cookie
  };
}

// 当前登录状态（含用户信息，ncm-api 对网易云实时接口偶发 502/超时，做 3 次退避重试）
async function getLoginStatus() {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 400 * attempt)); // 0.4s / 0.8s
    }
    try {
      const resp = await client.get('/login/status', { params: { timestamp: Date.now() } });
      const data = resp.data.data || {};
      const profile = data.profile || {};
      const loggedIn = !!(data.account && profile.userId);
      return {
        loggedIn,
        userId: loggedIn ? String(profile.userId) : '',
        nickname: profile.nickname || '',
        avatarUrl: profile.avatarUrl || '',
        signature: profile.signature || ''
      };
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const transient = status >= 500 || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ERR_BAD_RESPONSE';
      if (!transient || attempt === 2) break;
      console.warn('[netease] loginStatus 第' + (attempt + 1) + '次失败(' + e.message + ')，重试');
    }
  }
  throw lastErr;
}

// 用户歌单（/user/playlist，需已登录）
async function getUserPlaylist(uid, limit = 50) {
  // ncm-api 上游对网易云实时接口偶发 502/超时，这里做最多 3 次、退避重试，屏蔽瞬时抖动
  const maxLimit = Math.min(parseInt(limit) || 50, 100);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 400 * attempt)); // 0.4s / 0.8s
    }
    try {
      const resp = await client.get('/user/playlist', {
        params: { uid, limit: maxLimit, timestamp: Date.now() }
      });
      const playlists = resp.data.playlist || [];
      return playlists.map(p => ({
        id: String(p.id),
        name: p.name || '',
        cover: p.coverImgUrl || '',
        trackCount: p.trackCount || 0,
        playCount: p.playCount || 0,
        description: p.description || '',
        creator: (p.creator && p.creator.nickname) || '',
        subscribed: !!p.subscribed, // true=收藏的歌单，false=自己创建
        createTime: p.createTime || 0
      }));
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const transient = status >= 500 || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ERR_BAD_RESPONSE';
      if (!transient || attempt === 2) break;
      console.warn('[netease] getUserPlaylist 第' + (attempt + 1) + '次失败(' + e.message + ')，重试');
    }
  }
  throw lastErr;
}

// 退出登录
async function neteaseLogout() {
  const resp = await client.get('/logout', { params: { timestamp: Date.now() } });
  // 退出后清除本地持久化登录态
  clearNcmCookie();
  return { code: resp.data.code, message: resp.data.message || '' };
}

// 每日推荐歌曲（/recommend/songs，需登录，按用户喜好推荐 30 首）
// 网易云每日首次调用可能返回 code 201（需先在网易云 App 打开一次每日推荐初始化）
async function getDailyRecommendSongs(limit = 30) {
  const resp = await client.get('/recommend/songs', { params: { timestamp: Date.now() } });
  if (resp.data && (resp.data.code === 201 || resp.data.code === 2000)) {
    const err = new Error(resp.data.message || '每日推荐未初始化');
    err.unready = true;
    throw err;
  }
  const daily = (resp.data && resp.data.data && resp.data.data.dailySongs) || [];
  return daily.slice(0, Math.min(parseInt(limit) || 30, 50)).map(s => ({
    id: String(s.id),
    musicName: s.name,
    musicArtists: (s.ar || []).map(a => a.name).join('/'),
    artistsIds: (s.ar || []).map(a => String(a.id)).join(','),
    musicImage: (s.al && s.al.picUrl) || '',
    musicAlbum: (s.al && s.al.name) || '',
    albumid: (s.al && String(s.al.id)) || '',
    musicDuration: s.dt || 0,
    bits: ['lossless', 'exhigh', 'standard'],
    plugName: 'netease'
  }));
}

module.exports = {
  searchSong,
  searchAlbum,
  searchArtist,
  searchPlaylist,
  searchDj,
  getDjRecommend,
  getDjDetail,
  searchTips,
  getSongUrl,
  getLyric,
  getSongDetail,
  getAlbumDetail,
  getArtistInfo,
  getArtistList,
  parsePlaylistUrl,
  getPlaylistTracks,
  getToplist,
  getTopPlaylist,
  getPlaylistDetail,
  getBanner,
  getNewSongs,
  getNewAlbums,
  getRecommendPlaylist,
  getDailyRecommendSongs,
  createQrKey,
  createQrCode,
  checkQrStatus,
  getLoginStatus,
  getUserPlaylist,
  neteaseLogout,
  refreshNcmCookie,
  verifyQrCookieValid,
  saveNcmCookie
};
