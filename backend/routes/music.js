// 音乐路由：搜索/播放/歌词（转发 api-enhanced）
const express = require('express');
const axios = require('axios');
const router = express.Router();
const netease = require('../services/netease');
const scraper = require('../services/scraper');
const matcher = require('../services/matcher');

// 搜索歌曲
router.get('/searchSong', async (req, res) => {
  try {
    const { keyword, pageSize = 20, pageIndex = 1 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await netease.searchSong(keyword, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('searchSong 失败:', e.message);
    res.json({ code: 500, msg: '搜索失败: ' + e.message.slice(0, 100) });
  }
});

// 搜索提示
router.get('/searchTips', async (req, res) => {
  try {
    const { keyword } = req.query;
    const data = await netease.searchTips(keyword || '');
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 200, data: [], msg: 'success' });
  }
});

// 获取播放/下载直链（含音质降级回退：高音质取不到时依次降级，直到 standard）
router.post('/getDownloadUrl', async (req, res) => {
  try {
    const { id, brType } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少歌曲ID' });
    // 降级链：hires > lossless > exhigh > higher > standard
    const brChain = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
    let startIdx = brChain.indexOf(String(brType || '').toLowerCase());
    if (startIdx === -1) startIdx = 1; // 未指定或非法音质时从 lossless 开始
    let urlInfo = null;
    for (let i = startIdx; i < brChain.length; i++) {
      urlInfo = await netease.getSongUrl(id, brChain[i]);
      if (urlInfo && urlInfo.url) break;
    }
    if (!urlInfo || !urlInfo.url) return res.json({ code: 500, msg: '无法获取播放链接' });
    res.json({ code: 200, data: { url: urlInfo.url, br: urlInfo.br, size: urlInfo.size }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '获取链接失败: ' + e.message.slice(0, 100) });
  }
});

// 获取歌词
router.post('/getLyric', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少歌曲ID' });
    const data = await netease.getLyric(id);
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 200, data: { lyric: '' }, msg: 'success' });
  }
});

// 歌手信息（含专辑列表）
router.get('/artistAlbumById', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json({ code: 500, msg: '缺少歌手ID' });
    const data = await netease.getArtistInfo(id);
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('artistAlbumById 失败:', e.message);
    res.json({ code: 500, msg: '获取歌手信息失败: ' + e.message.slice(0, 100) });
  }
});

// 专辑信息
router.get('/albumInfoById', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json({ code: 500, msg: '缺少专辑ID' });
    const resp = await netease.getAlbumDetail(id);
    res.json({ code: 200, data: resp, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '获取专辑失败: ' + e.message.slice(0, 100) });
  }
});

// 搜索专辑
router.get('/searchAlbum', async (req, res) => {
  try {
    const { keyword, pageSize = 20, pageIndex = 1 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await netease.searchAlbum(keyword, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('searchAlbum 失败:', e.message);
    res.json({ code: 500, msg: '搜索专辑失败: ' + e.message.slice(0, 100) });
  }
});

// 搜索歌手
router.get('/searchArtist', async (req, res) => {
  try {
    const { keyword, pageSize = 20, pageIndex = 1 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await netease.searchArtist(keyword, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('searchArtist 失败:', e.message);
    res.json({ code: 500, msg: '搜索歌手失败: ' + e.message.slice(0, 100) });
  }
});

// 搜索歌单
router.get('/searchPlaylist', async (req, res) => {
  try {
    const { keyword, pageSize = 20, pageIndex = 1 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await netease.searchPlaylist(keyword, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('searchPlaylist 失败:', e.message);
    res.json({ code: 500, msg: '搜索歌单失败: ' + e.message.slice(0, 100) });
  }
});

// 搜索播客（DJ电台/节目）
router.get('/searchDj', async (req, res) => {
  try {
    const { keyword, pageSize = 20, pageIndex = 1 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await netease.searchDj(keyword, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('searchDj 失败:', e.message);
    res.json({ code: 500, msg: '搜索播客失败: ' + e.message.slice(0, 100) });
  }
});

// 推荐播客
router.get('/djRecommend', async (req, res) => {
  try {
    const { limit = 12 } = req.query;
    const data = await netease.getDjRecommend(parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('djRecommend 失败:', e.message);
    res.json({ code: 500, msg: '获取推荐播客失败: ' + e.message.slice(0, 100) });
  }
});

// 播客电台详情（含节目列表）
router.get('/djDetail', async (req, res) => {
  try {
    const { id, pageSize = 20, pageIndex = 1 } = req.query;
    if (!id) return res.json({ code: 500, msg: '缺少播客ID' });
    const data = await netease.getDjDetail(id, parseInt(pageSize), parseInt(pageIndex));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('djDetail 失败:', e.message);
    res.json({ code: 500, msg: '获取播客详情失败: ' + e.message.slice(0, 100) });
  }
});

// 按首字母获取歌手列表（A-Z，网易云数据）
// area：-1 全部 / 7 华语 / 96 欧美 / 8 日本 / 16 韩国 / 0 其他，支持逗号分隔合并（如 8,16=日韩）
router.get('/artistList', async (req, res) => {
  try {
    const { initial = '', pageSize = 30, pageIndex = 1, area = -1, type = -1 } = req.query;
    const data = await netease.getArtistList(initial, parseInt(pageSize), parseInt(pageIndex), area, parseInt(type));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('artistList 失败:', e.message);
    res.json({ code: 500, msg: '获取歌手列表失败: ' + e.message.slice(0, 100) });
  }
});

// 网易云榜单列表
router.get('/toplist', async (req, res) => {
  try {
    const data = await netease.getToplist();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('toplist 失败:', e.message);
    res.json({ code: 500, msg: '获取榜单失败: ' + e.message.slice(0, 100) });
  }
});

// 热门歌单（网易云 /top/playlist）
router.get('/topPlaylist', async (req, res) => {
  try {
    const { cat = '全部', limit = 12 } = req.query;
    const data = await netease.getTopPlaylist(cat, parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('topPlaylist 失败:', e.message);
    res.json({ code: 500, msg: '获取热门歌单失败: ' + e.message.slice(0, 100) });
  }
});

// 歌单/榜单详情（信息 + 歌曲列表）
router.get('/playlistDetail', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json({ code: 500, msg: '缺少歌单ID' });
    const data = await netease.getPlaylistDetail(id);
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('playlistDetail 失败:', e.message);
    res.json({ code: 500, msg: '获取歌单详情失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 网易云主页模块 =====

// 轮播 Banner
router.get('/banner', async (req, res) => {
  try {
    const data = await netease.getBanner();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('banner 失败:', e.message);
    res.json({ code: 500, msg: '获取Banner失败: ' + e.message.slice(0, 100) });
  }
});

// 新歌速递
router.get('/newSongs', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const data = await netease.getNewSongs(parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('newSongs 失败:', e.message);
    res.json({ code: 500, msg: '获取新歌失败: ' + e.message.slice(0, 100) });
  }
});

// 新碟上架
router.get('/newAlbums', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const data = await netease.getNewAlbums(parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('newAlbums 失败:', e.message);
    res.json({ code: 500, msg: '获取新碟失败: ' + e.message.slice(0, 100) });
  }
});

// 个性化推荐歌单
router.get('/recommendPlaylist', async (req, res) => {
  try {
    const { limit = 12 } = req.query;
    const data = await netease.getRecommendPlaylist(parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('recommendPlaylist 失败:', e.message);
    res.json({ code: 500, msg: '获取推荐歌单失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 网易云账号登录（二维码）=====

// 获取二维码 key
router.get('/qrKey', async (req, res) => {
  try {
    const data = await netease.createQrKey();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('qrKey 失败:', e.message);
    res.json({ code: 500, msg: '获取二维码key失败: ' + e.message.slice(0, 100) });
  }
});

// 生成二维码（含图片）
router.get('/qrCreate', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.json({ code: 500, msg: '缺少key' });
    const data = await netease.createQrCode(key);
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('qrCreate 失败:', e.message);
    res.json({ code: 500, msg: '生成二维码失败: ' + e.message.slice(0, 100) });
  }
});

// 轮询扫码状态
router.get('/qrStatus', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.json({ code: 500, msg: '缺少key' });
    const data = await netease.checkQrStatus(key);
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('qrStatus 失败:', e.message);
    res.json({ code: 500, msg: '查询扫码状态失败: ' + e.message.slice(0, 100) });
  }
});

// 当前登录状态（用户信息）
router.get('/loginStatus', async (req, res) => {
  try {
    const data = await netease.getLoginStatus();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('loginStatus 失败:', e.message);
    res.json({ code: 200, data: { loggedIn: false }, msg: 'success' });
  }
});

// 用户歌单
router.get('/userPlaylist', async (req, res) => {
  try {
    const { uid, limit = 50 } = req.query;
    if (!uid) return res.json({ code: 500, msg: '缺少uid' });
    const data = await netease.getUserPlaylist(uid, parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('userPlaylist 失败:', e.message);
    res.json({ code: 500, msg: '获取用户歌单失败: ' + e.message.slice(0, 100) });
  }
});

// 网易云退出登录
router.post('/neteaseLogout', async (req, res) => {
  try {
    const data = await netease.neteaseLogout();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('neteaseLogout 失败:', e.message);
    res.json({ code: 500, msg: '退出失败: ' + e.message.slice(0, 100) });
  }
});

// ===================== 酷我音源 =====================
const kuwo = require('../services/kuwo');

// 酷我搜索
router.get('/kuwo/search', async (req, res) => {
  try {
    const { keyword, page = 0, size = 30 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await kuwo.search(keyword, parseInt(page), parseInt(size));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('kuwo search 失败:', e.message);
    res.json({ code: 500, msg: '酷我搜索失败: ' + e.message.slice(0, 100) });
  }
});

// 酷我取链（播放/下载）
router.get('/kuwo/url', async (req, res) => {
  try {
    const { rid, format = 'mp3', br = '' } = req.query;
    if (!rid) return res.json({ code: 500, msg: '缺少rid' });
    const url = await kuwo.getPlayUrl(rid, format, br);
    if (!url) return res.json({ code: 500, msg: '酷我取链失败（可能为付费歌曲）' });
    res.json({ code: 200, data: { url }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷我取链失败: ' + e.message.slice(0, 100) });
  }
});

// 酷我榜单分类
router.get('/kuwo/bangmenu', async (req, res) => {
  try {
    const data = await kuwo.getBangMenu();
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷我榜单获取失败: ' + e.message.slice(0, 100) });
  }
});

// 酷我榜单歌曲
router.get('/kuwo/banglist', async (req, res) => {
  try {
    const { bangId, pn = 1, rn = 20 } = req.query;
    if (!bangId) return res.json({ code: 500, msg: '缺少bangId' });
    const data = await kuwo.getBangList(bangId, parseInt(pn), parseInt(rn));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷我榜单获取失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 酷狗（Kugou）音源：灰色/VIP 歌曲播放兜底（无需登录，常可取完整版） =====
const kugou = require('../services/kugou');

// 酷狗搜索
router.get('/kugou/search', async (req, res) => {
  try {
    const { keyword, page = 1, size = 20 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await kugou.search(keyword, parseInt(page), parseInt(size));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷狗搜索失败: ' + e.message.slice(0, 100) });
  }
});

// 酷狗取链（播放/下载）：按 FileHash + AlbumID 取完整播放直链，返回 url/duration 供前端试听识别
router.get('/kugou/url', async (req, res) => {
  try {
    const { hash, albumId, minDuration } = req.query;
    if (!hash) return res.json({ code: 500, msg: '缺少hash' });
    const opts = {};
    const md = parseInt(minDuration, 10);
    if (md > 0) opts.minDuration = md;
    const r = await kugou.getPlayUrlByHash(hash, albumId || '', opts);
    if (!r || !r.url) return res.json({ code: 500, msg: '酷狗取链失败（可能无完整版本）' });
    res.json({ code: 200, data: { url: r.url, duration: r.duration || 0, br: r.br || '', ext: r.ext || '' }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷狗取链失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 酷我 / QQ 主页推荐（banner / 推荐歌单 / 新歌），返回统一归一化格式 =====

// ---- 酷我 ----
// 酷我官网已下线匿名 banner / 推荐歌单 API（404），主页模块由榜单聚合承担；此处返回空以隐藏模块
router.get('/kuwo/banner', async (req, res) => {
  res.json({ code: 200, data: [], msg: 'success' });
});

router.get('/kuwo/recplaylist', async (req, res) => {
  res.json({ code: 200, data: [], msg: 'success' });
});

router.get('/kuwo/newsongs', async (req, res) => {
  try {
    const rn = parseInt(req.query.limit || 20);
    // 酷我新歌榜老编号=17（musicList 接口仅认老编号，bangMenu 的 sourceid 即老编号）
    const d = await kuwo.getBangList(17, 1, rn);
    const arr = (d && d.data && d.data.musicList) || [];
    const list = arr.map((t) => ({
      id: String(t.musicrid != null ? t.musicrid : t.rid != null ? t.rid : ''),
      rid: t.musicrid != null ? t.musicrid : t.rid,
      musicName: t.name || t.songName || '',
      musicArtists: (typeof t.artist === 'string') ? t.artist : (t.artist || '未知歌手'),
      musicAlbum: t.album || '',
      musicImage: t.albumpic || t.pic || '',
      musicDuration: t.duration || 0,
      plugName: 'kuwo'
    }));
    res.json({ code: 200, data: list, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '酷我新歌失败: ' + e.message.slice(0, 100) });
  }
});

// ===== GD 音乐台聚合换源播放取链（服务端免签名直连官方开放 API，source 依次尝试由前端驱动）=====
// 透传 GD types=url（聚合换源，返回完整直链）；可选 name 参数用 GD search 校验歌曲真实时长，
// duration < 45s 视为试听片段（与 downloader.assertNotPreview 同口径），由前端自动切下一 source。
router.get('/gdplay', async (req, res) => {
  try {
    const { id, source = 'netease', brType = 'lossless', name = '' } = req.query;
    if (!id) return res.json({ code: 500, msg: '缺少歌曲ID' });
    const gd = require('../services/gd');
    const src = gd.normalizeSource(source); // 非法 source 回退官方稳定首源 netease
    const info = await gd.getSongUrl(String(id), src, brType);
    if (!info || !info.url) return res.json({ code: 500, msg: 'GD聚合取链失败' });
    // 可选：GD search 校验该歌在 GD 侧的完整时长（用于试听判断，避免前端下载探测）
    let duration = 0;
    if (name) {
      try {
        const arr = await gd.gdRequest({ types: 'search', source: src, name, count: 10, pages: 1 });
        const list = Array.isArray(arr) ? arr : [];
        // 官方 search 返回 id 即 track_id（url_id 已废弃），按 id 精确匹配
        const hit = list.find((i) => i && String(i.id != null ? i.id : '') === String(id)) || list[0];
        if (hit && hit.extra_data) duration = hit.extra_data.duration || 0;
      } catch (e) { /* 时长校验失败不阻塞取链，由前端探测兜底 */ }
    }
    res.json({
      code: 200,
      data: { url: info.url, br: info.br, size: info.size, duration, source: src, preview: duration > 0 && duration < 45 },
      msg: 'success'
    });
  } catch (e) {
    res.json({ code: 500, msg: 'GD聚合取链失败: ' + (e && e.message ? e.message : e) });
  }
});

// ===== 网易云主页聚合：banner + 推荐歌单 + 新歌速递 + 热门歌单 =====
router.get('/homepage', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 30);
    // ncm 源偶发限流，带一次重试
    const tryGet = async (fn, fallback) => {
      for (let i = 0; i < 2; i++) {
        try { const r = await fn(); if (Array.isArray(r) && r.length) return r; } catch (e) {}
      }
      return fallback;
    };
    const [banner, recommend, newSongs, topPlaylists] = await Promise.all([
      tryGet(() => netease.getBanner(), []),
      tryGet(() => netease.getRecommendPlaylist(limit), []),
      tryGet(() => netease.getNewSongs(limit), []),
      tryGet(() => netease.getTopPlaylist('全部', 8), [])
    ]);
    res.json({ code: 200, data: { banner, recommend, newSongs: newSongs.slice(0, limit), topPlaylists }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '获取主页失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 每日推荐歌曲（需登录，按用户喜好推荐 30 首）=====
router.get('/dailyRecommend', async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const data = await netease.getDailyRecommendSongs(parseInt(limit));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    if (e.unready) {
      res.json({ code: 201, data: [], msg: '每日推荐未初始化，请先在网易云 App 打开一次「每日推荐」' });
      return;
    }
    console.error('dailyRecommend 失败:', e.message);
    res.json({ code: 500, data: [], msg: '获取每日推荐失败: ' + e.message.slice(0, 100) });
  }
});

// ===== 播放聚合取链：完整版优先（全界面统一）=====
// 策略：按候选顺序取链，每个候选做"试听识别"——优先用取链响应自带的权威时长（秒），
// 否则用 HEAD 探测直链 Content-Length 粗判（试听片段体积远小于完整曲目）。
// 命中第一个完整版立即返回；全部候选仅试听时兜底返回最强试听并标记 preview:true（前端打"试听"标）。
// 各候选源顺位：指定 source → 网易云 id 兜底 → 跨源搜索(kuwo → kugou → netease)。酷狗 playInfo 自带
// 权威时长且对版权歌命中率高，放跨源第 2 位；尾部用 length<45s 的探测无法覆盖的源做最后兜底。
const FRAGMENT_BYTES = 2.5 * 1024 * 1024; // 试听片段体积护栏：30s*128kbps≈480KB，完整曲目极少小于 2.5MB

// HEAD 探测音频直链的 Content-Length（跟随重定向；失败回退 Range GET；仍失败返回 0）
// 返回值约定：>0 有效体积；0 无法探测（未知）；-1 死链（HTTP 状态 >=400，如 403/404）
async function probeUrlSize(url) {
  if (!url) return 0;
  try {
    const head = await axios.head(url, { timeout: 8000, maxRedirects: 4, validateStatus: () => true });
    if (head.status >= 400) return -1;
    const cl = parseInt(head.headers['content-length'] || '0', 10);
    if (cl > 0) return cl;
  } catch (e) { /* fallthrough */ }
  try {
    const get = await axios.get(url, {
      timeout: 8000, maxRedirects: 4, validateStatus: () => true,
      responseType: 'stream', headers: { Range: 'bytes=0-1023' },
    });
    if (get.status >= 400) return -1;
    const cr = String(get.headers['content-range'] || '/0').split('/')[1] || '0';
    const cl = parseInt(get.headers['content-length'] || cr, 10) || 0;
    if (get.data && typeof get.data.destroy === 'function') get.data.destroy();
    return cl;
  } catch (e) { return 0; }
}

// 是否试听/片段：候选带权威时长→短于 45s 或短于目标曲目 60%；无时长→按探测体积过小判片段
function isFragment(url, size, durationSec, refSec) {
  if (durationSec) {
    const minFull = refSec > 0 ? Math.min(45, refSec * 0.6) : 45;
    return durationSec < minFull;
  }
  return size > 0 && size < FRAGMENT_BYTES;
}

router.post('/play', async (req, res) => {
  try {
    const { source, id, rid, songmid, hash, albumId, name, artist, album, brType, duration, force, probe } = req.body || {};
    const forceMode = force === true || force === 'true' || force === 1;
    const probeMode = probe === true || probe === 'true' || probe === 1;
    const kw = [name, artist && artist !== '未知' ? artist : ''].filter(Boolean).join(' ').trim();
    // 三要素匹配目标（跨源/探测搜索时用于筛选一致版本，杜绝翻唱/翻版）
    const want = { name: name || '', artist: artist && artist !== '未知' ? artist : '', album: album || '' };
    const refSec = (parseInt(duration, 10) || 0) / 1000;
    const brChain = ['hires', 'lossless', 'exhigh', 'higher', 'standard'];
    const br = String(brType || '').toLowerCase();

    // 单源探测（probe=true / force=true 共用）：返回 { source, ok, preview }
    // ok=true 表示该源可取链；preview=true 表示仅能拿到试听片段/不完整（<45s 或体积过小）
    // 修复：缺对应源 ID 时按 歌名+歌手 跨源搜索取首条再探测，避免网易云来源歌曲跨源探测误报"无音源"
    const probeSource = async (src) => {
      const params = { id, rid, songmid, hash, albumId };
      try {
        if (src === 'netease') {
          let nid = params.id;
          if (!nid && kw.length >= 2) {
            const rs = await netease.searchSong(kw, 10, 1);
            const hit = matcher.findMatch(want, rs && rs.records) || null;
            nid = hit && hit.id;
          }
          if (nid) {
            let startIdx = brChain.indexOf(br);
            if (startIdx === -1) startIdx = 1;
            for (let i = startIdx; i < brChain.length; i++) {
              const u = await netease.getSongUrl(nid, brChain[i]);
              if (u && u.url) {
                const size = u.size || await probeUrlSize(u.url);
                if (size < 0) return { source: 'netease', ok: false, preview: false }; // 死链：403/404 视为无音源
                return { source: 'netease', ok: true, preview: size > 0 && size < FRAGMENT_BYTES };
              }
            }
          }
          return { source: 'netease', ok: false, preview: false };
        }
        if (src === 'kuwo') {
          let r = params.rid;
          if (!r && kw.length >= 2) {
            const rs = await kuwo.search(kw, 0, 10);
            const hit = matcher.findMatch(want, rs && rs.records) || null;
            r = hit && (hit.rid || hit.id);
          }
          if (r) {
            const u = await kuwo.getPlayUrl(r, 'mp3', '');
            if (!u) return { source: 'kuwo', ok: false, preview: false };
            const size = await probeUrlSize(u);
            if (size < 0) return { source: 'kuwo', ok: false, preview: false };
            return { source: 'kuwo', ok: true, preview: size > 0 && size < FRAGMENT_BYTES };
          }
          return { source: 'kuwo', ok: false, preview: false };
        }
        if (src === 'kugou') {
          let h = params.hash;
          let aId = params.albumId;
          if (!h && kw.length >= 2) {
            const rs = await kugou.search(kw, 1, 10);
            const r0 = matcher.findMatch(want, rs && rs.records) || null;
            h = r0 && (r0.FileHash || r0.id || r0.hash);
            aId = r0 && (r0.AlbumID || r0.albumId || '');
          }
          if (h) {
            // 不传 minDuration 以便探测到「仅试听」场景；用酷狗 playInfo 权威时长判 preview
            const g = await kugou.getPlayUrlByHash(h, aId || '');
            if (!g || !g.url) return { source: 'kugou', ok: false, preview: false };
            const dur = g.duration || 0;
            return { source: 'kugou', ok: true, preview: dur > 0 && dur < 45 };
          }
          return { source: 'kugou', ok: false, preview: false };
        }
        if (src === 'joox') {
          // GD-joox：平台内 url_id 取直链探测；缺 id 时按 歌名+歌手 GD 搜索三要素匹配后取直链
          const gd = require('../services/gd');
          let uid = params.id || params.songmid;
          if (!uid && kw.length >= 2) {
            const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: kw, pagesize: '10' });
            const recs = Array.isArray(sd) ? sd : (sd && sd.records) || [];
            const hit = matcher.findMatch(want, recs) || null;
            uid = hit && (hit.url_id || hit.id);
          }
          if (uid) {
            const g = await gd.getSongUrl(String(uid), 'joox', br);
            if (g && g.url) {
              const size = g.size || await probeUrlSize(g.url);
              if (size < 0) return { source: 'joox', ok: false, preview: false };
              return { source: 'joox', ok: true, preview: size > 0 && size < FRAGMENT_BYTES };
            }
          }
          return { source: 'joox', ok: false, preview: false };
        }
        return { source: src || '', ok: false, preview: false };
      } catch (e) {
        return { source: src || '', ok: false, preview: false };
      }
    };

    // probe=true：仅探测指定源可用性，不返回播放 url
    if (probeMode) {
      const r = await probeSource(source);
      res.json({ code: 200, data: r, msg: 'success' });
      return;
    }

    const neteaseUrl = async (songId) => {
      let startIdx = brChain.indexOf(br);
      if (startIdx === -1) startIdx = 1;
      for (let i = startIdx; i < brChain.length; i++) {
        const u = await netease.getSongUrl(songId, brChain[i]);
        if (u && u.url) return { url: u.url, br: brChain[i], size: u.size || await probeUrlSize(u.url), source: 'netease' };
      }
      return null;
    };

    // force=true：只尝试指定源，不做跨源兜底。命中即返回——即便仅试听片段也照播（标记 preview:true），
    // 满足"切换源就要换这个源播放，无论试听"。
    // 缺该源平台 ID 时，按 歌名+歌手+专辑 三要素搜索匹配后再取链（杜绝选中翻唱/翻版版本）。
    if (forceMode) {
      try {
        let urlRes = null;
        if (source === 'netease') {
          let nid = id;
          if (!nid && kw.length >= 2) {
            const rs = await netease.searchSong(kw, 10, 1);
            const hit = matcher.findMatch(want, rs && rs.records) || null;
            nid = hit && hit.id;
          }
          if (nid) urlRes = await neteaseUrl(nid);
        } else if (source === 'kuwo') {
          let r = rid;
          if (!r && kw.length >= 2) {
            const rs = await kuwo.search(kw, 0, 10);
            const hit = matcher.findMatch(want, rs && rs.records) || null;
            r = hit && (hit.rid || hit.id);
          }
          if (r) {
            const u = await kuwo.getPlayUrl(r, 'mp3', '');
            urlRes = u ? { url: u, source: 'kuwo', size: await probeUrlSize(u) } : null;
          }
        } else if (source === 'qq') {
          let sm = songmid;
          if (!sm && kw.length >= 2) {
            const rs = await qq.search(kw, 20, 1);
            const hit = matcher.findMatch(want, rs && rs.records) || null;
            sm = hit && hit.songmid;
          }
          if (sm) {
            const u = await qq.getPlayUrl(sm, br || 'standard');
            urlRes = u && u.url ? { url: u.url, source: 'qq', br: u.br || '', size: await probeUrlSize(u.url) } : null;
          }
        } else if (source === 'kugou') {
          let h = hash;
          let aId = albumId || '';
          if (!h && kw.length >= 2) {
            const rs = await kugou.search(kw, 1, 10);
            const r0 = matcher.findMatch(want, rs && rs.records) || null;
            h = r0 && (r0.FileHash || r0.id || r0.hash);
            aId = r0 && (r0.AlbumID || r0.albumId || '');
          }
          if (h) {
            // 不回传 minDuration：仅能取到试听也照播（由前端标记 preview）
            const g = await kugou.getPlayUrlByHash(h, aId || '', {});
            urlRes = g ? { url: g.url, source: 'kugou', durationSec: g.duration, br: g.br || '' } : null;
          }
        } else if (source === 'joox') {
          // GD-joox 聚合直链（平台内 url_id 取链）；跨平台歌曲缺 joox 平台 id 时按三要素搜索匹配
          const gd = require('../services/gd');
          let uid = id || songmid;
          if (!uid && kw.length >= 2) {
            const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: kw, pagesize: '10' });
            const recs = Array.isArray(sd) ? sd : (sd && sd.records) || [];
            const hit = matcher.findMatch(want, recs) || null;
            uid = hit && (hit.url_id || hit.id);
          }
          if (uid) {
            const g = await gd.getSongUrl(String(uid), 'joox', br);
            urlRes = g && g.url ? { url: g.url, source: 'joox', br: g.br || '', size: g.size || 0 } : null;
          }
        }
        if (urlRes && urlRes.url) {
          if ((urlRes.size || 0) < 0) {
            return res.json({ code: 500, msg: '该音源直链已失效（403/404），请切换其他音源' });
          }
          const pv = isFragment(urlRes.url, urlRes.size || 0, urlRes.durationSec || 0, refSec);
          return res.json({ code: 200, data: { url: urlRes.url, br: urlRes.br || '', source, duration: urlRes.durationSec || 0, preview: pv }, msg: 'success' });
        }
      } catch (e) {}
      return res.json({ code: 500, msg: '该音源无此歌曲（或未找到三要素一致的版本）' });
    }

    const fallbackRef = { url: null }; // 兜底：仅试听可用时的最优候选
    const bestPreview = { url: '', br: '', source: '', durationSec: 0, size: 0 };

    // 单一候选验收：完整→立即响应；试听→记录兜底并继续
    const emit = (data) => { if (data) res.json({ code: 200, data, msg: 'success' }); };
    const accept = async (cand, src) => {
      if (!cand || !cand.url) return false;
      if ((cand.size || 0) < 0) return false; // 死链（403/404）直接跳过
      const c = { url: cand.url, br: cand.br || '', source: src, durationSec: cand.durationSec || 0, size: cand.size || 0 };
      if (isFragment(c.url, c.size, c.durationSec, refSec)) {
        if (!bestPreview.url) { bestPreview.url = c.url; bestPreview.br = c.br; bestPreview.source = c.source; bestPreview.durationSec = c.durationSec; }
        return false;
      }
      emit({ url: c.url, br: c.br, source: c.source, duration: c.durationSec, preview: false });
      return true;
    };

    // 1) 指定来源优先
    try {
      if (source === 'netease' && id) { const r = await neteaseUrl(id); if (await accept(r, 'netease')) return; }
      if (source === 'kuwo' && rid) {
        const u = await kuwo.getPlayUrl(rid, 'mp3', '');
        if (await accept(u ? { url: u, source: 'kuwo', size: await probeUrlSize(u) } : null, 'kuwo')) return;
      }
      if (source === 'kugou' && hash) {
        const u = await kugou.getPlayUrlByHash(hash, albumId || '', { minDuration: 45 });
        if (await accept(u ? { url: u.url, source: 'kugou', durationSec: u.duration, br: u.br || '', size: u.size || 0 } : null, 'kugou')) return;
      }
      if (source === 'joox' && (id || songmid)) {
        const gd = require('../services/gd');
        const g = await gd.getSongUrl(String(id || songmid), 'joox', br);
        if (await accept(g ? { url: g.url, source: 'joox', br: g.br || '', size: g.size || 0 } : null, 'joox')) return;
      }
    } catch (e) {}

    // 2) 持网易云 id 时的空闲兜底
    if (id && source !== 'netease') { const r = await neteaseUrl(id); if (await accept(r, 'netease')) return; }

    // 3) 按 歌名+歌手+专辑 三要素跨源搜索兜底（kuwo → kugou → netease → GD-joox）
    // 每源先做三要素一致性筛选，无一致版本直接跳过该源，杜绝跨源兜底命中翻唱/翻版。
    if (kw.length >= 2) {
      const fallbacks = [
        { src: 'kuwo', fn: async () => { const rs = await kuwo.search(kw, 0, 10); const hit = matcher.findMatch(want, rs && rs.records) || null; const rr = hit && (hit.rid || hit.id); if (!rr) return null; const u = await kuwo.getPlayUrl(rr, 'mp3', ''); return u ? { url: u, source: 'kuwo', size: await probeUrlSize(u) } : null; } },
        { src: 'kugou', fn: async () => { const rs = await kugou.search(kw, 1, 10); const r0 = matcher.findMatch(want, rs && rs.records) || null; const hh = r0 && (r0.FileHash || r0.id || r0.hash); if (!hh) return null; const g = await kugou.getPlayUrlByHash(hh, (r0 && (r0.AlbumID || r0.albumId)) || '', { minDuration: 45 }); return g ? { url: g.url, source: 'kugou', durationSec: g.duration, br: g.br || 0 } : null; } },
        { src: 'netease', fn: async () => { const rs = await netease.searchSong(kw, 10, 1); const r0 = matcher.findMatch(want, rs && rs.records) || null; if (!r0 || !r0.id) return null; return neteaseUrl(r0.id); } },
        { src: 'joox', fn: async () => { const gd = require('../services/gd'); const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: kw, pagesize: '10' }); const recs = Array.isArray(sd) ? sd : (sd && sd.records) || []; const hit = matcher.findMatch(want, recs) || null; const uu = hit && (hit.url_id || hit.id); if (!uu) return null; const gg = await gd.getSongUrl(String(uu), 'joox', br); return gg && gg.url ? { url: gg.url, source: 'joox', br: gg.br || '', size: gg.size || 0 } : null; } },
      ];
      for (const f of fallbacks) {
        try { const r = await f.fn(); if (await accept(r, r.source || f.src)) return; } catch (e) {}
      }
    }

    // 4) 全部候选仅试听 → 兜底播放最强试听并明确标记 preview:true
    if (bestPreview.url) {
      emit({ url: bestPreview.url, br: bestPreview.br, source: bestPreview.source, duration: bestPreview.durationSec, preview: true });
      return;
    }
    res.json({ code: 500, msg: '所有音源均无法获取完整播放链接' });
  } catch (e) {
    res.json({ code: 500, msg: '获取播放链接失败: ' + (e && e.message ? e.message : e).slice(0, 100) });
  }
});

// ===================== GD JOOX 音源（搜索） =====================
// 取链走 /play 聚合链（joox 分支已接入）；此段提供 GD JOOX 搜索供前端源列表切换
router.get('/joox/search', async (req, res) => {
  try {
    const { keyword, page = 0, size = 30 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await scraper.search('joox', keyword, 'song');
    res.json({ code: 200, data: data || { records: [] }, msg: 'success' });
  } catch (e) {
    console.error('joox search 失败:', e.message);
    res.json({ code: 500, msg: 'JOOX搜索失败: ' + (e && e.message ? e.message : e).slice(0, 200) });
  }
});

// ===================== Tidal 音源（元数据搜索补充） =====================
// 匿名 client_credentials 凭证可用；拉流被付费墙 405 拦截 → getPlayUrl 恒 null，
// 播放走 /play 聚合链在其他源兜底。此段仅提供 Tidal 高品质元数据搜索结果。
const tidal = require('../services/tidal');

// Tidal 搜索
router.get('/tidal/search', async (req, res) => {
  try {
    const { keyword, page = 0, size = 30 } = req.query;
    if (!keyword) return res.json({ code: 500, msg: '关键词不能为空' });
    const data = await tidal.search(keyword, parseInt(page), parseInt(size));
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    console.error('tidal search 失败:', e.message);
    res.json({ code: 500, msg: 'Tidal搜索失败: ' + e.message.slice(0, 200) });
  }
});

module.exports = router;
