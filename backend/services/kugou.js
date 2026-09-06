// 酷狗音乐源服务：搜索 / 播放取链（灰色/VIP 歌曲多音源兜底之一）
// 借鉴 Kumone 多音源思路：酷狗网页接口无需登录，多数 VIP/无版权歌可返回完整音频（m4a 标准音质），
// 作为网易云取链失败后的兜底音源。取链依赖 dfid（从酷狗主页 set-cookie 获取，带缓存）与 mid（随机）。
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' },
});

// 酷狗移动端接口：网页版 wwwapi 已加风控（err_code=30020），改走移动端 playInfo（无需登录，返回完整直链）
const mhttp = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    Referer: 'https://m.kugou.com/',
  },
});

// 通用重试包装：酷狗接口偶发限流/超时时自动重试（最多 2 次，间隔 600ms）
async function retry(fn, retries = 2, delay = 600) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((s) => setTimeout(s, delay));
    }
  }
  throw lastErr;
}

// ===== dfid：取链接口必需（从酷狗主页 set-cookie 解析，缓存 30 分钟）=====
let _dfid = '';
let _dfidTs = 0;

async function getDfid() {
  const now = Date.now();
  if (_dfid && now - _dfidTs < 30 * 60 * 1000) return _dfid;
  try {
    const res = await http.get('https://www.kugou.com/', { maxRedirects: 5 });
    const cookies = (res.headers['set-cookie'] || []).join(';');
    const m = cookies.match(/dfid=([^;]+)/i) || cookies.match(/DFID=([^;]+)/i);
    if (m && m[1]) {
      _dfid = m[1];
      _dfidTs = now;
      return _dfid;
    }
  } catch (e) { /* 拿不到用随机兜底 */ }
  // 随机 20 位十六进制 dfid（格式与酷狗一致，接口接受）
  _dfid = Array.from({ length: 20 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  _dfidTs = now;
  return _dfid;
}

// 随机 16 位数字 mid（酷狗客户端标识）
function genMid() {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('');
}

// 清洗歌曲名/歌手名：去掉搜索接口返回的 <em> 高亮标签、HTML 实体与不可见控制字符，
// 并统一 trim 收尾（修复酷狗歌名/歌手名前后乱码、格式字符残留）
function cleanName(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/<[^>]*>/g, '')            // 去 <em>/<i> 等 HTML 标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')  // 去控制字符
    .replace(/\u200b|\u200e|\u200f|\ufeff/g, '')                     // 去零宽/不可见字符
    .replace(/\s+/g, ' ')
    .trim();
}

// 酷狗封面拼装：搜索接口不直接给标准封面 URL，但每条 raw item 自带 Image 占位 URL
// （{size} 可变尺寸，无 AlbumID 的翻唱/Live/伴奏也会返回 singerimg 头图），替换 {size}→300 即得；
// 个别条目 Image 为空时，再退化用 AlbumID 拼 imge.kugou.com 图床（已验证可访问）。
function kugouCover(s) {
  const img = (s && (s.Image || s.AlbumImage)) || '';
  if (img) return String(img).replace('{size}', '300').replace('http://', 'https://');
  const albumId = (s && (s.AlbumID || s.album_id)) || '';
  return albumId ? 'https://imge.kugou.com/stdmusic/300/' + albumId + '.jpg' : '';
}

// 搜索歌曲（返回 sqmusic records 格式，附带酷狗取链所需 FileHash / AlbumID / Duration）
async function search(keyword, page = 1, size = 20) {
  const res = await retry(() => http.get('https://songsearch.kugou.com/song_search_v2', {
    params: {
      keyword, page, pagesize: size, userid: -1, clientver: 2000,
      platform: 'WebFilter', tag: 'em', filter: 2, iscorrection: 1, privilege_filter: 0,
    },
  }));
  const lists = (((res.data && res.data.data) || {}).lists) || [];
  const records = lists.map((s) => ({
    id: s.FileHash || s.hash || '',
    FileHash: s.FileHash || s.hash || '',
    HQFileHash: s.HQFileHash || '',
    SQFileHash: s.SQFileHash || '',
    AlbumID: s.AlbumID || s.album_id || '',
    musicName: cleanName(s.SongName || s.songname || ''),
    musicArtists: cleanName((s.SingerName || s.singer_name || '').replace(/,/g, '/')),
    musicAlbum: cleanName(s.AlbumName || s.album_name || ''),
    // 封面：Image 占位 URL（含无 AlbumID 特殊版本）→ 退化 AlbumID 拼图床
    musicImage: kugouCover(s),
    musicDuration: (parseInt(s.Duration || '0', 10) || 0) * 1000,
    bits: ['standard'],
    plugName: 'kugou',
    source: 'kugou',
  }));
  return { records, searchTotal: (((res.data && res.data.data) || {}).total) || records.length };
}

// 取直链：hash 换取完整播放地址（移动端 playInfo 接口，无需登录）。
// data.timeLength 为时长（秒）；data.status===1 表示有可播放地址。
// 传入 minDuration 时，若时长不足（视为试听）则返回 null，供兜底链路跳过该音源。
async function getPlayUrlByHash(hash, albumId, opts = {}) {
  if (!hash) return null;
  const minDuration = opts.minDuration || 0;
  try {
    const res = await retry(() => mhttp.get('https://m.kugou.com/app/i/getSongInfo.php', {
      params: { cmd: 'playInfo', hash },
    }));
    const d = res.data || {};
    if (d.status !== 1) return null;
    const duration = parseInt(d.timeLength || '0', 10) || 0;
    if (minDuration > 0 && duration < minDuration) return null;
    const url = d.url || '';
    if (!url) return null;
    return { url, duration, hash, br: d.bitRate || 0, ext: inferUrlExt(url) };
  } catch (e) {
    return null;
  }
}

// 试听/受限检测用：直接按 hash 取链并校验完整时长（>45s 才算可用），供兜底链路快速判断
async function getSongUrlByHash(hash, albumId) {
  const hit = await getPlayUrlByHash(hash, albumId, { minDuration: 45 });
  return hit && hit.url ? hit : null;
}

function inferUrlExt(url) {
  const m = String(url || '').match(/\.(flac|mp3|m4a|ape|wav)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'm4a';
}

module.exports = { search, getPlayUrlByHash, getSongUrlByHash, getDfid, genMid };
