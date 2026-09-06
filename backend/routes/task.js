// 任务管理路由
const express = require('express');
const router = express.Router();
const db = require('../services/db');
const downloader = require('../services/downloader');
const netease = require('../services/netease');
const kuwo = require('../services/kuwo');
const matcher = require('../services/matcher');

// 任务列表（分页 + 筛选）
router.post('/list', (req, res) => {
  try {
    const {
      downloadMusicname, downloadArtistname, downloadAlbumname,
      downloadPlugName, downloadStatus, downloadTimeStart, downloadTimeEnd,
      pageSize = 20, pageIndex = 1
    } = req.body || {};

    let where = [];
    let params = [];
    if (downloadMusicname) { where.push('music_name LIKE ?'); params.push(`%${downloadMusicname}%`); }
    if (downloadArtistname) { where.push('artist_name LIKE ?'); params.push(`%${downloadArtistname}%`); }
    if (downloadAlbumname) { where.push('album_name LIKE ?'); params.push(`%${downloadAlbumname}%`); }
    if (downloadPlugName) { where.push('plug_name = ?'); params.push(downloadPlugName); }
    if (downloadStatus) { where.push('download_status = ?'); params.push(downloadStatus); }
    if (downloadTimeStart) { where.push('download_time >= ?'); params.push(downloadTimeStart); }
    if (downloadTimeEnd) { where.push('download_time <= ?'); params.push(downloadTimeEnd); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) as c FROM download_task ${whereSql}`).get(...params).c;
    const offset = (parseInt(pageIndex) - 1) * parseInt(pageSize);
    const rows = db.prepare(`
      SELECT id, song_id, music_name as downloadMusicname, artist_name as downloadArtistname,
             album_name as downloadAlbumname, plug_name as downloadPlugName, br_type as downloadBrType,
             audio_book as audioBook, download_status as downloadStatus, download_msg as downloadMsg,
             download_time as downloadTime, download_update_time as downloadUpdateTime, file_path,
             file_size as downloadFileSize, source as taskSource
      FROM download_task ${whereSql}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, parseInt(pageSize), offset);

    // 下载中任务附加实时进度（received/total/speed，前端算百分比）；失败原因统一转中文
    for (const r of rows) {
      if (r.downloadMsg) r.downloadMsg = downloader.msgToCn(r.downloadMsg);
      // 需求14：监控来源标注（source='monitor' 表示由歌单监控触发的任务）
      r.isMonitor = r.taskSource === 'monitor';
      if (r.downloadStatus === 'loading') {
        let p = null;
        if (typeof downloader.getProgress === 'function') p = downloader.getProgress(r.id);
        if (p) r.progress = { received: p.received || 0, total: p.total || 0, speed: p.speed || 0 };
      }
    }

    res.json({ code: 200, data: { records: rows, total, pageSize: parseInt(pageSize), pageIndex: parseInt(pageIndex) }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '查询失败: ' + e.message.slice(0, 100) });
  }
});

// 任务统计（含实时下载速率）
router.get('/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as c FROM download_task').get().c;
    const success = db.prepare("SELECT COUNT(*) as c FROM download_task WHERE download_status IN ('success','supplement_success')").get().c;
    const waiting = db.prepare("SELECT COUNT(*) as c FROM download_task WHERE download_status IN ('waiting','loading','supplement')").get().c;
    const error = db.prepare("SELECT COUNT(*) as c FROM download_task WHERE download_status = 'error'").get().c;
    // 角标口径：等待中+下载中均计入（loading 窗口短，仅统计 loading 角标几乎不亮）
    const downloading = db.prepare("SELECT COUNT(*) as c FROM download_task WHERE download_status IN ('waiting','loading')").get().c;
    let totalSpace = 0;
    try {
      totalSpace = db.prepare("SELECT COALESCE(SUM(file_size),0) as s FROM download_task WHERE download_status IN ('success','supplement_success')").get().s || 0;
    } catch (_) {}
    res.json({ code: 200, data: {
      total, success, waiting, error, downloading,
      successRate: total ? Math.round((success / total) * 100) : 0,
      totalSpace,
      globalSpeed: downloader.getGlobalSpeed()
    }, msg: 'success' });
  } catch (e) {
    res.json({ code: 500, msg: '统计失败: ' + e.message.slice(0, 100) });
  }
});

// 删除单个任务
router.post('/del', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少任务ID' });
    db.prepare('DELETE FROM download_task WHERE id = ?').run(id);
    res.json({ code: 200, msg: '删除成功' });
  } catch (e) {
    res.json({ code: 500, msg: '删除失败' });
  }
});

// 重新下载单个任务（复用原任务记录重新入队，不新建任务，符合 sqmusic 规则）
router.post('/refreshTask', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少任务ID' });
    const task = db.prepare('SELECT * FROM download_task WHERE id = ?').get(id);
    if (!task) return res.json({ code: 500, msg: '任务不存在' });
    downloader.reQueueTask(id, '重新下载');
    res.json({ code: 200, msg: '已重新加入队列' });
  } catch (e) {
    res.json({ code: 500, msg: '操作失败' });
  }
});

// 全部错误任务重新下载（逐个复用原任务，不新建）
router.get('/againTask', (req, res) => {
  try {
    const tasks = db.prepare("SELECT * FROM download_task WHERE download_status = 'error'").all();
    for (const t of tasks) downloader.reQueueTask(t.id, '重新下载');
    res.json({ code: 200, msg: `已重新加入 ${tasks.length} 个任务` });
  } catch (e) {
    res.json({ code: 500, msg: '操作失败' });
  }
});

// 删除错误任务
router.get('/delErrorTask', (req, res) => {
  db.prepare("DELETE FROM download_task WHERE download_status = 'error'").run();
  res.json({ code: 200, msg: '已删除错误任务' });
});

// 删除成功任务
router.get('/delSuccessTask', (req, res) => {
  db.prepare("DELETE FROM download_task WHERE download_status = 'success'").run();
  res.json({ code: 200, msg: '已删除成功任务' });
});

// 删除等待任务
router.get('/delWaitingTask', (req, res) => {
  db.prepare("DELETE FROM download_task WHERE download_status IN ('waiting','loading')").run();
  res.json({ code: 200, msg: '已删除等待任务' });
});

// 错误任务重试详情（简化）
router.post('/errorTaskRetry', (req, res) => {
  res.json({ code: 200, data: [], msg: 'success' });
});

// 失败任务切换音源重新下载
// source 支持：netease / kuwo / kugou / joox（joox 为 GD 聚合的腾讯海外 JOOX，走平台内 url_id 取链）
router.post('/switchSource', async (req, res) => {
  try {
    const { id, source } = req.body || {};
    if (!id || !source) return res.json({ code: 500, msg: '缺少参数' });
    if (!['netease', 'kuwo', 'kugou', 'joox'].includes(source)) return res.json({ code: 500, msg: '不支持的音源: ' + source });
    const task = db.prepare('SELECT * FROM download_task WHERE id = ?').get(id);
    if (!task) return res.json({ code: 500, msg: '任务不存在' });

    const keyword = [task.music_name, task.artist_name].filter(Boolean).join(' ');
    if (!keyword) return res.json({ code: 500, msg: '任务缺少歌曲信息，无法换源' });

    // 换源匹配目标：严格按 歌名+歌手+专辑 三要素一致筛选，拒绝换到翻唱/翻版/伴奏等错误版本
    const song = { name: task.music_name, artist: task.artist_name, album: task.album_name };

    let matched = null;
    let newId = '';
    try {
      if (source === 'netease') {
        const r = await netease.searchSong(keyword, 10, 1);
        matched = matcher.findMatch(song, r && r.records, { strict: true }) || null;
        if (matched) newId = String(matched.id || '');
      } else if (source === 'kuwo') {
        const r = await kuwo.search(keyword, 0, 10);
        matched = matcher.findMatch(song, r && r.records, { strict: true }) || null;
        if (matched) newId = String(matched.rid || matched.id || '');
      } else if (source === 'kugou') {
        const kugou = require('../services/kugou');
        const r = await kugou.search(keyword, 1, 10);
        matched = matcher.findMatch(song, r && r.records, { strict: true }) || null;
        if (matched) newId = String(matched.FileHash || matched.hash || matched.id || '');
      } else if (source === 'joox') {
        const gd = require('../services/gd');
        const sd = await gd.gdRequest({ types: 'search', source: 'joox', name: keyword, pagesize: '10' });
        const recs = (Array.isArray(sd) ? sd : (sd && sd.records) || []);
        matched = matcher.findMatch(song, recs, { strict: true }) || null;
        if (matched) newId = String(matched.url_id || matched.id || '');
      }
    } catch (e) {
      return res.json({ code: 500, msg: '搜索「' + source + '」音源失败: ' + String(e.message || e).slice(0, 80) });
    }
    if (!matched || !newId) {
      return res.json({ code: 404, msg: '「' + source + '」音源未找到歌名、歌手、专辑完全匹配的版本（可能仅存在翻唱/翻版），已拒绝换源' });
    }

    downloader.resetRetry(id);
    downloader.clearProgress(id);
    if (source === 'joox') {
      // joox 走 GD 聚合链路：标记为 GD 任务，用平台内 url_id 取链
      db.prepare("UPDATE download_task SET gd = 1, plug_name = 'joox', source_platform = 'joox', url_id = ?, song_id = ?, pic_id = COALESCE(?, pic_id) WHERE id = ?")
        .run(newId, newId, (matched.pic_id || matched.pic || ''), id);
    } else {
      db.prepare('UPDATE download_task SET plug_name = ?, song_id = ? WHERE id = ?')
        .run(source, newId, id);
    }
    downloader.reQueueTask(id, '已切换' + source + '音源');
    res.json({ code: 200, msg: '已切换「' + source + '」音源重新下载' });
  } catch (e) {
    res.json({ code: 500, msg: '换源失败: ' + String(e.message || e).slice(0, 100) });
  }
});

module.exports = router;
