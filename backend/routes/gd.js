// GD 音乐台代理路由（前端 gd 源经此代理，避免浏览器 JSONP 直连 GD 不稳定）
// 后端 gd.js 使用官网混淆 crc32 真实签名直连 GD，签名有效性已实测验证（playlist/search 均 200）
const express = require('express');
const gd = require('../services/gd');
const router = express.Router();

// 通用代理：透传 GD 协议参数（types/source/id/name/count/pages/br 等），s 由后端 gd.js 重新计算
// 附加能力：types=search 且 fill_pic=1 时，对结果批量补全封面 URL（pic_id -> pic 直链，限并发避免触发上游限流）
const PIC_CONCURRENCY = 4;
async function fillSearchPics(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  const queue = list.slice();
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const item = queue[i];
      if (!item || !item.pic_id) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const url = await gd.getPic(item.pic_id);
          if (url) { item.pic = url; break; }
        } catch (e) { /* 单条失败不影响整体 */ }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PIC_CONCURRENCY, queue.length) }, worker));
}

router.get('/', async (req, res) => {
  try {
    const params = Object.assign({}, req.query);
    if (!params.types) {
      return res.json({ code: 400, msg: 'missing types' });
    }
    const data = await gd.gdRequest(params);
    // types=search 返回数组；fill_pic=1 时批量补封面直链
    if (params.types === 'search' && String(params.fill_pic) === '1' && Array.isArray(data)) {
      await fillSearchPics(data);
    }
    res.json(data);
  } catch (e) {
    res.json({ code: 500, msg: 'GD代理请求失败: ' + (e && e.message ? e.message : e) });
  }
});

module.exports = router;
