// 外部后端代理路由：前端"自定义后端"搜索/取链/歌词/封面统一走本服务代理
const express = require('express');
const external = require('../services/external');
const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const { protocol, base, source, keyword } = req.query;
    if (!base) return res.json({ code: 500, msg: '缺少后端地址 base' });
    if (!keyword) return res.json({ code: 500, msg: '缺少搜索关键词 keyword' });
    const r = await external.externalSearch({
      protocol, base, source,
      keyword, page: req.query.page, size: req.query.size,
    });
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '外部后端搜索失败: ' + (e.message || '').slice(0, 120) });
  }
});

router.get('/url', async (req, res) => {
  try {
    const { protocol, base, source, id, br } = req.query;
    if (!base || !id) return res.json({ code: 500, msg: '缺少后端地址或歌曲 id' });
    const r = await external.externalGetUrl({ protocol, base, source, id, br });
    if (!r.url) return res.json({ code: 500, msg: '该歌曲无可播链接（可能需登录或为付费歌）' });
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '外部后端取链失败: ' + (e.message || '').slice(0, 120) });
  }
});

router.get('/lyric', async (req, res) => {
  try {
    const { protocol, base, source, id } = req.query;
    if (!base || !id) return res.json({ code: 500, msg: '缺少后端地址或歌曲 id' });
    const r = await external.externalGetLyric({ protocol, base, source, id });
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '外部后端歌词失败: ' + (e.message || '').slice(0, 120) });
  }
});

router.get('/pic', async (req, res) => {
  try {
    const { protocol, base, source, id } = req.query;
    if (!base || !id) return res.json({ code: 500, msg: '缺少后端地址或歌曲 id' });
    const r = await external.externalGetPic({ protocol, base, source, id });
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '外部后端封面失败: ' + (e.message || '').slice(0, 120) });
  }
});

// 测试外部后端连通性：发一次最小搜索请求，能收到协议可解析的响应即视为可用
router.get('/test', async (req, res) => {
  try {
    const { protocol, base, source } = req.query;
    if (!base) return res.json({ code: 500, msg: '缺少后端地址 base' });
    const r = await external.externalSearch({
      protocol, base, source: source || 'netease',
      keyword: 'test', page: 1, size: 1,
    });
    const ok = !!r && Array.isArray(r.records);
    res.json({
      code: ok ? 200 : 500,
      data: ok ? { message: '连接成功，后端响应正常（共 ' + (r.searchTotal || 0) + ' 条结果）' } : null,
      msg: ok ? 'success' : '后端已连接但返回结构无法解析',
    });
  } catch (e) {
    res.json({ code: 500, msg: '外部后端连接失败: ' + (e.message || '').slice(0, 160) });
  }
});

module.exports = router;
