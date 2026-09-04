// GD 音乐台聚合网关客户端（download-service 侧）
// 用于下载链路取链：GD types=url 聚合换源，免会员拿完整播放地址
const axios = require('axios');
const gdSign = require('./gd_sign');

const GD_API = 'https://music.gdstudio.org/api.php';
// 以 name 为签名的 types（与 GD 官网 ajax.js 一致），其余以 id 为签名
const NAME_TYPES = ['search', 'search_album', 'search_playlist', 'embeat_agent', 'embeat_by_track', 'autosource'];

// GD 请求（签名由官网混淆 crc32 变体实时生成，含 /time 时间戳种子）
async function gdRequest(params) {
  const qs = Object.assign({}, params);
  const val = NAME_TYPES.indexOf(qs.types) !== -1
    ? (qs.name != null ? qs.name : '')
    : (qs.id != null ? qs.id : '');
  qs.s = gdSign.sign(qs.types, val);
  const resp = await axios.get(GD_API, { params: qs, timeout: 20000 });
  return resp.data;
}

// 音质名 → GD 码率
function brToKbps(brType) {
  const b = String(brType || '').toLowerCase();
  if (b === 'lossless' || b === 'hires') return 320;
  if (b === 'exhigh' || b === 'higher') return 192;
  return 128;
}

// 获取播放/下载直链（GD 聚合换源）
async function getSongUrl(urlId, source, brType) {
  const data = await gdRequest({
    types: 'url',
    id: urlId,
    source: source || 'netease',
    br: brToKbps(brType)
  });
  if (!data || !data.url) return null;
  return { url: data.url, br: data.br || brToKbps(brType), size: data.size || 0 };
}

// 获取封面图 URL（types=pic）
async function getPic(picId) {
  if (!picId) return '';
  try {
    const data = await gdRequest({ types: 'pic', id: picId });
    return (data && (data.url || data.pic || data.img || '')) || '';
  } catch (e) {
    return '';
  }
}

// 获取歌词（types=lyric）
async function getLyric(lyricId) {
  if (!lyricId) return { lyric: '' };
  try {
    const data = await gdRequest({ types: 'lyric', id: lyricId });
    return { lyric: (data && (data.lyric || data.lrc || '')) || '' };
  } catch (e) {
    return { lyric: '' };
  }
}

module.exports = {
  getSongUrl,
  getPic,
  getLyric,
  gdRequest,
  brToKbps
};
