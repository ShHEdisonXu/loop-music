// 酷我音乐源服务：搜索 / 播放取链 / 榜单（含官网签名逆向）
const axios = require('axios');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 酷我官网固定统计 cookie 名（Secret 签名依赖它的值）
const COOKIE_NAME = 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324';

let tokenCookie = '';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': UA },
});

// 获取 Hm_Iuvt token（酷我 API 签名必需；带缓存，force 强制刷新）
async function getToken(force = false) {
  if (tokenCookie && !force) return tokenCookie;
  try {
    const res = await http.get('https://www.kuwo.cn/', {
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    });
    const sc = res.headers['set-cookie'] || [];
    for (const c of sc) {
      if (c.startsWith(COOKIE_NAME + '=')) {
        tokenCookie = c.split(';')[0].slice(COOKIE_NAME.length + 1);
        break;
      }
    }
  } catch (e) {
    // 忽略，尽量沿用已有 token
  }
  return tokenCookie;
}

// 酷我 Secret 签名算法（逆向自 www.kuwo.cn webpack 混淆）
// 权威实现核对：数字根拼接用 COOKIE_NAME 的 charCode，异或生成 hex 用 cookieValue
function genSecret(cookieValue) {
  const t = cookieValue; // 异或循环使用：cookie 值
  const e = COOKIE_NAME; // 拼接使用：cookie 名
  if (cookieValue == null || cookieValue.length <= 0) return null;
  let n = '';
  for (let i = 0; i < e.length; i++) n += e.charCodeAt(i).toString();
  const o = Math.floor(n.length / 5);
  const r = parseInt(n.charAt(o) + n.charAt(2 * o) + n.charAt(3 * o) + n.charAt(4 * o) + n.charAt(5 * o));
  const c = Math.ceil(e.length / 2);
  const l = Math.pow(2, 31) - 1;
  if (r < 2) return null;
  let d = Math.round(1e9 * Math.random()) % 1e8;
  n += d;
  while (n.length > 10) {
    n = (parseInt(n.substring(0, 10)) + parseInt(n.substring(10, n.length))).toString();
  }
  n = (r * n + c) % l;
  let f = 0;
  let h = '';
  for (let i = 0; i < t.length; i++) {
    f = parseInt(t.charCodeAt(i) ^ Math.floor((n / l) * 255));
    h += f < 16 ? '0' + f.toString(16) : f.toString(16);
    n = (r * n + c) % l;
  }
  d = d.toString(16);
  while (d.length < 8) d = '0' + d;
  return h + d;
}

// UUID v1（酷我 reqId 要求 v1 格式，版本位=1；v4 会被拒）
function uuidV1() {
  const b = crypto.randomBytes(16);
  const g1582 = 122192928000000000n; // 1970-01-01 -> 1582-10-15 的 100ns 偏移
  const now = BigInt(Date.now()) * 10000n + g1582;
  // time_low(32) + time_mid(16) + time_hi_and_version(12+4) + clock_seq(14) + node(48)
  b[0] = Number(now & 0xffn);
  b[1] = Number((now >> 8n) & 0xffn);
  b[2] = Number((now >> 16n) & 0xffn);
  b[3] = Number((now >> 24n) & 0xffn);
  b[4] = Number((now >> 32n) & 0xffn);
  b[5] = Number((now >> 40n) & 0xffn);
  b[6] = Number(((now >> 48n) >> 8n) & 0x0fn) | 0x10; // version = 1
  b[7] = Number((now >> 48n) & 0xffn);
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// 带签名的 GET（榜单类接口）
// 关键：Hm_Iuvt cookie 为一次性令牌，Secret/reqId 与其绑定；复用旧 token 会返回 code:-1 / illegal
// 因此每次调用都强制刷新 token
async function signedGet(url, params = {}) {
  const tok = await getToken(true);
  const reqId = uuidV1();
  const res = await http.get(url, {
    params: { ...params, httpsStatus: 1, reqId },
    headers: {
      Referer: 'https://www.kuwo.cn/rankList',
      Cookie: `${COOKIE_NAME}=${tok}`,
      Secret: genSecret(tok),
    },
  });
  return res.data;
}

// 解析 MINFO 得到音质列表
function parseQuality(minfo) {
  const q = (String(minfo || '').match(/<quality>([^<]+)<\/quality>/) || [])[1] || '';
  if (q.includes('flac') || q.includes('lossless')) return ['lossless', 'higher', 'exhigh', 'standard'];
  if (q.includes('320')) return ['higher', 'exhigh', 'standard'];
  if (q.includes('192')) return ['exhigh', 'standard'];
  if (q.includes('128')) return ['standard'];
  return ['standard'];
}

// 搜索歌曲（返回 sqmusic records 格式）
async function search(keyword, page = 0, size = 30) {
  const res = await http.get('https://search.kuwo.cn/r.s', {
    params: {
      client: 'kt', all: keyword, pn: page, rn: size, uid: '',
      ver: 'kwplayer_9.2.2.1', vipver: 1, show_copyright_off: 1, newver: 1,
      ft: 'music', cluster: 0, strategy: 2012, encoding: 'utf8', rformat: 'json',
      mobi: 1, issubtitle: 1,
    },
  });
  const data = res.data;
  const list = (data && data.abslist) || [];
  const records = list.map((s) => {
    const rid = String(s.MUSICRID || s.ID || '');
    return {
      id: rid,
      rid,
      musicName: s.NAME || '',
      musicArtists: s.ARTIST || '',
      musicAlbum: s.ALBUM || '',
      musicImage: s.PIC || '',
      musicDuration: parseInt(s.DURATION || 0, 10) * 1000 || 0,
      bits: parseQuality(s.MINFO),
      plugName: 'kuwo',
      source: 'kuwo',
    };
  });
  return { records, searchTotal: (data && (data.total || records.length)) || records.length };
}

// 播放/下载直链（mp3；flac 需会员，前端按需降级）
// 取链策略（pyncmd 同款思路）：
//   1) 优先老接口 convert_url（不带 br）——免费歌直接返回完整直链
//   2) 老接口拿不到（资源缺失/仅会员）再回退 convert_url3 + br（可能仅试听片段，由调用方 assertNotPreview 拦截）
async function getPlayUrl(rid, format = 'mp3', br = '') {
  if (!rid) return null;
  // 优先：老接口 convert_url，免费歌完整直链
  try {
    const r1 = await http.get('http://antiserver.kuwo.cn/anti.s', {
      params: { type: 'convert_url', format: 'mp3', rid, response: 'url' },
    });
    let u = String(r1.data || '').trim().replace(/\\\//g, '/');
    if (u && u.startsWith('http')) return u;
  } catch (e) { /* 继续回退 */ }
  // 回退：convert_url3 + br（会员路径，可能仅试听）
  const params = { type: 'convert_url3', rid, response: 'url' };
  if (br) params.br = br;
  else params.format = format;
  const res = await http.get('http://antiserver.kuwo.cn/anti.s', { params });
  let data = res.data;
  if (typeof data === 'string') data = data.replace(/\\\//g, '/');
  if (typeof data === 'string' && data.trim().startsWith('{')) {
    try {
      const j = JSON.parse(data);
      return j.url || null;
    } catch (e) { return null; }
  }
  const t = typeof data === 'string' ? data.trim() : (data && data.url) || '';
  return t || null;
}

// 榜单列表（含分类）
async function getBangMenu() {
  return signedGet('https://www.kuwo.cn/api/www/bang/bang/bangMenu');
}

// id → sourceid 映射缓存（musicList 接口仅认 sourceid 老编号，bangMenu 里 id 为新编号）
let bangIdMapCache = null;
async function getBangIdMap(force = false) {
  if (bangIdMapCache && !force) return bangIdMapCache;
  const d = await getBangMenu();
  const map = {};
  for (const grp of (d && d.data) || []) {
    for (const b of (grp.list) || []) {
      if (b && b.id != null && b.sourceid != null) map[String(b.id)] = String(b.sourceid);
    }
  }
  bangIdMapCache = map;
  return map;
}

// 榜单歌曲列表（自动把 bangMenu 的新 id 映射为 musicList 认识的 sourceid 老编号）
async function getBangList(bangId, pn = 1, rn = 20) {
  let real = String(bangId);
  const map = await getBangIdMap();
  if (map[real]) real = map[real];
  return signedGet('https://www.kuwo.cn/api/www/bang/bang/musicList', { bangId: real, pn, rn, plat: 'web_www', from: '' });
}

// ===== 酷我主页推荐（banner / 推荐歌单 / 新歌）=====

// 首页轮播 Banner：data.banner 数组，元素 {pic, url, banner_id, name}
async function getBanner() {
  return signedGet('https://www.kuwo.cn/api/www/banner/index', { plat: 'web_www' });
}

// 推荐歌单：data.list 数组，元素 {id, name, pic, playnum, total, ...}
async function getRecPlaylist(page = 1, rows = 12) {
  return signedGet('https://www.kuwo.cn/api/www/rcm/index/rec_playlist', { loginUid: 0, page, rows });
}

// 新歌速递：酷我新歌榜（id 489928 = sourceid 17），getBangList 内部自动映射
async function getNewSongs(pn = 1, rn = 20) {
  return getBangList(489928, pn, rn);
}

module.exports = { search, getPlayUrl, getBangMenu, getBangList, getBangIdMap, getBanner, getRecPlaylist, getNewSongs, getToken, genSecret };
