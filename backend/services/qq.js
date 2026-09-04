// QQ 音乐源服务：搜索 / 播放取链 / 榜单
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
});

// 通用重试包装：外部 QQ 接口偶发限流/超时时自动重试（最多 2 次，间隔 600ms）
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

// 生成 QQ 播放 guid（17 位数字，QQ 取链接口要求）
function genGuid() {
  return String(Math.floor(1e16 + Math.random() * 9e16));
}

// 音质 br 标识映射（download 音质 → QQ filename 前缀）
const BR_MAP = {
  lossless: 'F000', higher: 'M800', exhigh: 'M800', standard: 'M500', m4a: 'M4A',
};
const BR_ORDER = ['lossless', 'higher', 'standard', 'm4a'];

// 搜索歌曲（返回 sqmusic records 格式）
async function search(keyword, page = 1, size = 20) {
  const res = await retry(() => http.get('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
    params: {
      format: 'json', p: page, n: size, w: keyword, cr: 1, aggr: 1, lossless: 1,
      t: 0, platform: 'yqq.json', needNewCode: 0,
    },
  }));
  const list = (((res.data && res.data.data) || {}).song || {}).list || [];
  const records = list.map((s) => {
    const bits = [];
    if (s.sizeflac) bits.push('lossless');
    if (s.size320) bits.push('higher');
    if (s.size128) bits.push('standard');
    if (bits.length === 0) bits.push('standard');
    return {
      id: String(s.songid || ''),
      songmid: s.songmid || '',
      musicName: s.songname || '',
      musicArtists: (s.singer || []).map((a) => a.name).join('/'),
      musicAlbum: s.albumname || '',
      musicImage: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
      musicDuration: (s.interval || 0) * 1000,
      bits,
      plugName: 'qq',
      source: 'qq',
    };
  });
  const totalnum = ((((res.data && res.data.data) || {}).song || {}).totalnum) || records.length;
  return { records, searchTotal: totalnum };
}

// 播放/下载直链（musicu.fcg CgiGetVkey，GET + data 参数，无需登录 cookie）
// 未登录态：免费歌曲可拿 C400(m4a/128k) 直链；付费/无版权歌曲仅试听或为空
// brType: lossless/higher/standard/m4a，取不到自动降级
async function getPlayUrl(songmid, brType = 'standard') {
  if (!songmid) return { url: null, msg: '缺少 songmid' };
  const guid = genGuid();
  const order = brType ? [brType].concat(BR_ORDER.filter((b) => b !== brType)) : BR_ORDER;
  for (const br of order) {
    const prefix = BR_MAP[br] || 'M500';
    const ext = br === 'lossless' ? 'flac' : br === 'm4a' ? 'm4a' : 'mp3';
    try {
      const body = {
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: { guid, songmid: [songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20', needNewCode: 1 },
        },
      };
      const res = await retry(() => http.get('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        params: { format: 'json', data: JSON.stringify(body) },
      }));
      const r0 = (res.data && res.data.req_0) || {};
      const d = r0.data || {};
      const mi = (d.midurlinfo || [])[0] || {};
      const purl = mi.purl || '';
      if (purl) {
        const sip = (d.sip || [])[0] || '';
        return { url: sip + purl, purl, sip, filename: mi.filename || `${prefix}${songmid}.${ext}`, br };
      }
    } catch (e) {
      // 继续尝试下一音质
    }
  }
  return { url: null, purl: '', msg: '该歌曲为付费/无版权或仅试听，未登录无法获取完整下载链接' };
}

// 榜单列表
async function getToplist() {
  let last;
  for (let i = 0; i <= 2; i++) {
    const res = await retry(() => http.get('https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg', {
      params: { format: 'json' },
    }));
    last = res.data;
    const tl = last && last.data && last.data.data && last.data.data.topList;
    if (Array.isArray(tl) && tl.length) return last;
    await new Promise((s) => setTimeout(s, 700));
  }
  return last;
}

// 榜单详情（歌曲列表）QQ 返回体：{ code:0, ..., songlist:[...] }，songlist 在顶层
async function getToplistDetail(topid) {
  let last;
  for (let i = 0; i <= 2; i++) {
    const res = await retry(() => http.get('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg', {
      params: { topid, page: 'detail', type: 'top', tpl: 3, format: 'json' },
    }));
    last = res.data;
    const sl = last && last.songlist;
    if (Array.isArray(sl) && sl.length) return last;
    await new Promise((s) => setTimeout(s, 700));
  }
  return last;
}

// ===== QQ 主页推荐（banner / 推荐歌单 / 新歌）=====

// 首页轮播 Banner：data.slider 数组，元素 {id, picUrl, linkUrl}（无 title）
async function getBanner() {
  return retry(() => http.get('https://c.y.qq.com/musichall/fcgi-bin/fcg_yqqhomepagerecommend.fcg', {
    params: {
      format: 'json', inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
      platform: 'yqq.json', needNewCode: 0, uin: '', g_tk: 5381,
    },
  })).then((r) => r.data);
}

// 推荐歌单：data.list 数组，元素 {dissid, dissname, imgurl, listennum, creator:{name}}
async function getRecPlaylist(sin = 0, ein = 19) {
  return retry(() => http.get('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
    params: {
      format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0,
      platform: 'yqq.json', needNewCode: 0, categoryId: 10000000, sortId: 5, sin, ein,
    },
  })).then((r) => r.data);
}

// 新歌速递：QQ 官方"新歌榜"（topid=26），返回 {code:0, songlist:[...]}，songlist[].data 含歌曲信息
async function getNewSongs() {
  return getToplistDetail(26);
}

module.exports = { search, getPlayUrl, getToplist, getToplistDetail, getBanner, getRecPlaylist, getNewSongs, genGuid };
