// 下载服务入口
const express = require('express');
const cors = require('cors');
const config = require('./config');
const monitor = require('./routes/monitor');
const localLibrary = require('./services/localLibrary');
const downloader = require('./services/downloader');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 口令鉴权中间件：除 /api/health 与 /api/config/login(POST) 外，所有 /api/* 须携带
// X-Auth-Token 与 config.authToken（正式口令，默认 loop123）一致，否则 401
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (req.path === '/config/login' && req.method === 'POST') return next();
  // 内嵌封面缩略图 / 本地音频流：<img>/<audio> 标签无法携带 X-Auth-Token header，允许以 ?token= 查询参数作为等效授权（仅此两路免 header）
  if (req.path === '/library/meta/cover' || req.path === '/library/audio') {
    const q = req.query && req.query.token;
    if (q && q === config.authToken) return next();
    return res.status(401).json({ code: 401, msg: '未授权：请使用正确的访问口令（X-Auth-Token）' });
  }
  const token = req.headers['x-auth-token'];
  if (token && token === config.authToken) return next();
  return res.status(401).json({ code: 401, msg: '未授权：请使用正确的访问口令（X-Auth-Token）' });
});

// 路由
app.use('/api/config', require('./routes/config'));
app.use('/api/music', require('./routes/music'));
app.use('/api/download', require('./routes/download'));
app.use('/api/task', require('./routes/task'));
app.use('/api/parser', require('./routes/parser'));
app.use('/api/monitor', monitor.router);
app.use('/api/plug', require('./routes/plug'));
app.use('/api/expand/ali', require('./routes/expand'));
app.use('/api/library', require('./routes/library'));
app.use('/api/gd', require('./routes/gd'));
app.use('/api/external', require('./routes/external'));
app.use('/api/scraper', require('./routes/scraper'));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ code: 200, msg: 'ok', data: { ncmApi: config.ncmApiBase, musicRoot: config.musicRoot } });
});

app.listen(config.port, () => {
  console.log(`[下载服务] 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[下载服务] 网易云后端: ${config.ncmApiBase}`);
  console.log(`[下载服务] 音乐目录: ${config.musicRoot}`);
  monitor.startMonitor();

  // 启动恢复：把上次会话遗留的 waiting/loading 任务重新入队消费（防"卡在等待中"），
  // 并对同曲目重复的未完成任务做折叠去重。
  downloader.resumePendingTasks();

  // 后台预热本地曲库索引（首次全量扫描，不阻塞启动）
  const st = localLibrary.stats();
  if (st.count === 0) {
    console.log('[本地曲库] 首次启动，开始后台扫描 ' + config.musicRoot + ' ...');
    localLibrary.rebuildLibrary()
      .then(r => console.log('[本地曲库] 扫描完成: total=' + r.total + ' inserted=' + r.inserted))
      .catch(e => console.error('[本地曲库] 扫描失败: ' + e.message));
  } else {
    console.log('[本地曲库] 已有索引 ' + st.count + ' 条（上次扫描 ' + st.lastScan + '）');
  }
});
