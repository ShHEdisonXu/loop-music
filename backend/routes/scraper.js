// 刮削数据源页后端代理：多平台搜索补全 歌手/专辑/歌词/封面
const express = require('express');
const scraper = require('../services/scraper');
const router = express.Router();

// 数据源清单
router.get('/sources', (req, res) => {
  res.json({ code: 200, data: { sources: scraper.sources() }, msg: 'success' });
});

// 待刮削列表（缺歌手/缺专辑/缺歌词的本地曲目）
router.get('/needs', (req, res) => {
  try {
    const data = scraper.needs({ kw: req.query.kw, limit: req.query.limit });
    res.json({ code: 200, data, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '查询待刮削列表失败: ' + (e.message || '').slice(0, 120) });
  }
});

// 数据源搜索（预览匹配结果）
router.get('/search', async (req, res) => {
  try {
    const { source, kw, type } = req.query;
    if (!source || !kw) return res.json({ code: 500, msg: '缺少数据源 source 或关键词 kw' });
    const r = await scraper.search(source, kw, type || 'song');
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '数据源搜索失败: ' + (e.message || '').slice(0, 160) });
  }
});

// 歌词获取
router.get('/lyric', async (req, res) => {
  try {
    const { source, id } = req.query;
    if (!source || !id) return res.json({ code: 500, msg: '缺少数据源或歌曲 id' });
    const r = await scraper.lyric(source, id);
    res.json({ code: 200, data: r, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '歌词获取失败: ' + (e.message || '').slice(0, 160) });
  }
});

// 批量刮削补全
// body: { source, items: [{ id, filePath, title, artist }], withLyric }
router.post('/apply', async (req, res) => {
  try {
    const { source, items, withLyric } = req.body || {};
    if (!source) return res.json({ code: 500, msg: '缺少数据源 source' });
    if (!Array.isArray(items) || items.length === 0) return res.json({ code: 500, msg: '缺少待刮削歌曲 items' });
    if (items.length > 200) return res.json({ code: 500, msg: '单次最多刮削 200 首，请分批执行' });
    const results = await scraper.apply(items, source, { withLyric: withLyric !== false });
    const okCount = results.filter(r => r.ok).length;
    res.json({
      code: 200,
      data: { results, okCount, failCount: results.length - okCount, total: results.length },
      msg: `刮削完成：成功 ${okCount} 首，失败 ${results.length - okCount} 首`
    });
  } catch (e) {
    res.json({ code: 500, msg: '刮削执行失败: ' + (e.message || '').slice(0, 160) });
  }
});

module.exports = router;
