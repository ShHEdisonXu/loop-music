// 歌单监控路由 + 定时扫描
const express = require('express');
const router = express.Router();
const db = require('../services/db');
const netease = require('../services/netease');
const downloader = require('../services/downloader');
const config = require('../config');

// 监听列表
router.get('/list', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, plug_name as plugName, type, enabled, target_id as targetId,
             target_name as targetName, target_url as targetUrl, target_count as targetCount,
             target_desc as targetDesc, target_cover as targetCover, last_scan as lastScan
      FROM monitor ORDER BY id DESC
    `).all();
    res.json({ code: 200, data: rows, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '查询失败' });
  }
});

// 新增监听
router.post('/add', (req, res) => {
  try {
    const { plugName, type, enabled, targetId, targetName, targetUrl, targetCount, targetDesc, targetCover } = req.body || {};
    if (!targetId || !targetUrl) return res.json({ code: 500, msg: '缺少歌单信息' });
    // 去重：同一歌单不重复添加
    const exist = db.prepare('SELECT * FROM monitor WHERE target_id = ?').get(targetId);
    if (exist) return res.json({ code: 500, msg: '该歌单已在监控中' });
    db.prepare(`
      INSERT INTO monitor (plug_name, type, enabled, target_id, target_name, target_url, target_count, target_desc, target_cover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(plugName || 'netease', type || 'playlist', enabled || '1', targetId, targetName || '', targetUrl, targetCount || 0, targetDesc || '', targetCover || '');
    res.json({ code: 200, msg: '添加成功' });
  } catch (e) {
    res.json({ code: 500, msg: '添加失败: ' + e.message.slice(0, 100) });
  }
});

// 删除监听
router.post('/delete', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少监听ID' });
    db.prepare('DELETE FROM monitor WHERE id = ?').run(id);
    res.json({ code: 200, msg: '删除成功' });
  } catch (e) {
    res.json({ code: 500, msg: '删除失败' });
  }
});

// 扫描单个监控歌单（P2-5：失败自动重试 1 次 + 告警日志）
async function scanMonitor(item) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tracks = await netease.getPlaylistTracks(item.target_id);
      const songs = tracks.map(t => ({
        id: t.id,
        musicName: t.name,
        artistName: t.artists,
        albumName: t.album,
        plugName: 'netease',
        brType: config.defaultBrType
      }));
      const result = downloader.enqueueBatch(songs, 'monitor');
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare('UPDATE monitor SET last_scan = ?, target_count = ? WHERE id = ?').run(now, tracks.length, item.id);
      console.log(`[监控] ${item.target_name}: 新增 ${result.added} 首，跳过 ${result.dup} 首`);
      return;
    } catch (e) {
      if (attempt === 1) {
        console.warn(`[监控] ${item.target_name} 扫描失败(第${attempt}次)，1s 后重试: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.error(`[监控] ${item.target_name} 扫描失败(第${attempt}次，已重试仍失败): ${e.message}`);
      }
    }
  }
}

// 全量扫描
async function scanAll() {
  const items = db.prepare("SELECT * FROM monitor WHERE enabled = '1'").all();
  for (const item of items) {
    await scanMonitor(item);
  }
}

// 启动定时扫描
function startMonitor() {
  console.log(`[监控] 定时扫描已启动，间隔 ${config.monitorInterval / 1000}s`);
  setInterval(scanAll, config.monitorInterval);
  // 启动后立即扫描一次
  setTimeout(scanAll, 5000);
}

module.exports = { router, startMonitor };
