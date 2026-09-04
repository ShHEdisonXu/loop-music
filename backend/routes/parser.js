// 歌单解析路由
const express = require('express');
const router = express.Router();
const netease = require('../services/netease');

// 解析歌单 URL 信息
router.post('/parserUrlInfo', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.json({ code: 500, msg: '歌单链接不能为空' });
    const info = await netease.parsePlaylistUrl(url);
    res.json({ code: 200, data: info, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '解析失败: ' + e.message.slice(0, 100) });
  }
});

module.exports = router;
