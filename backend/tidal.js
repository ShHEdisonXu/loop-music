// Tidal 音乐源服务：搜索（元数据）/ 播放取链
// 凭证：Tidal 公开 Web Player client_credentials（匿名应用凭证，非账号）
//   token 端点无需 scope 即可取到 client_credentials token（已在纯净网络实测通过）
// 边界：匿名态下 playbackinfopostpaywall 拉流被付费墙 405 拦截，拿不到音频流；
//   因此本源作为「元数据/搜索补充源」，播放由下游聚合链在其他源兜底。
const axios = require('axios');

const CLIENT_ID = 'zU4XHVVkc2tDPo4t';
const CLIENT_SECRET = 'VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4=';
const COUNTRY = 'US';

let _token = '';
let _tokenExp = 0;

const http = axios.create({ timeout: 15000 });

// 获取 client_credentials token（带缓存，提前 60s 过期）
async function getToken(force = false) {
  const now = Date.now();
  if (!force && _token && _tokenExp > now + 60000) return _token;
  const res = await http.post(
    'https://auth.tidal.com/v1/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const d = res.data || {};
  if (!d.access_token) throw new Error('Tidal token 获取失败: ' + JSON.stringify(d).slice(0, 120));
  _token = d.access_token;
  _tokenExp = now + (parseInt(d.expires_in, 10) || 3600) * 1000;
  return _token;
}

// 专辑封面图（resources.tidal.com 路径由 '-' 转 '/'）
function coverUrl(cover) {
  if (!cover) return '';
  return `https://resources.tidal.com/images/${String(cover).replace(/-/g, '/')}/750x750.jpg`;
}

// 搜索歌曲（返回 sqmusic records 格式）
async function search(keyword, page = 0, size = 30) {
  const token = await getToken();
  const res = await http.get('https://api.tidal.com/v1/search/tracks', {
    params: { query: keyword, countryCode: COUNTRY, limit: size, offset: page * size },
    headers: { Authorization: 'Bearer ' + token },
  });
  const items = (((res.data || {}).items) || []);
  const records = items.map((s) => ({
    id: String(s.id || ''),
    musicName: s.title || '',
    musicArtists: ((s.artists || []).map((a) => a.name)).join('/'),
    musicAlbum: ((s.album || {}).title) || '',
    musicImage: coverUrl(s.album && s.album.cover),
    musicDuration: (parseInt(s.duration || 0, 10) || 0) * 1000,
    bits: ['lossless', 'higher', 'standard'],
    plugName: 'tidal',
    source: 'tidal',
  }));
  return { records, searchTotal: (res.data && res.data.totalNumberOfResults) || records.length };
}

// 播放/下载直链：匿名态无付费墙穿透能力，始终返回 null（由聚合链兜底到其他源）
async function getPlayUrl(id, format = 'mp3', br = '') {
  return null;
}

module.exports = { search, getPlayUrl, getToken };
