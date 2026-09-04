// 配置/登录路由
const express = require('express');
const router = express.Router();
const fs = require('fs');
const config = require('../config');
const settings = require('../services/settings');
const localLibrary = require('../services/localLibrary');
const traffic = require('../services/traffic');

// 简单 token 管理（内存）
const tokens = new Set();

// 默认配置列表（与 sqmusic 前端兼容）
const defaultConfigs = [
  { configKey: 'system.download.file.audio.format', configValue: config.downloadFormat, configName: '下载格式', configType: 'select', configOption: 'flac,mp3' },
  { configKey: 'system.show.play.url', configValue: 'false', configName: '显示播放按钮', configType: 'switch' },
  { configKey: 'system.download.path', configValue: config.musicRoot, configName: '下载目录', configType: 'text' },
  { configKey: 'system.download.brType', configValue: config.defaultBrType, configName: '默认音质', configType: 'select', configOption: 'standard,higher,exhigh,lossless,hires' },
  { configKey: 'system.download.maxConcurrent', configValue: String(config.maxConcurrent), configName: '并发下载数', configType: 'number' },
  { configKey: 'system.auth.token', configValue: config.authToken, configName: '访问口令', configType: 'text' }
];

// 登录：口令校验（password 与正式口令 config.authToken 一致，默认 loop123）
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === config.authToken) {
    const token = 'token_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    tokens.add(token);
    res.json({ code: 200, data: { tokenValue: token, loginDevice: 'web' }, msg: '登录成功' });
  } else {
    res.json({ code: 500, msg: '用户名或密码错误' });
  }
});

// 登出
router.post('/logout', (req, res) => {
  res.json({ code: 200, msg: '退出成功' });
});

// 检查登录
router.post('/isLogin', (req, res) => {
  res.json({ code: 200, msg: '已登录' });
});

// 获取全部设置
router.get('/getConfigList', (req, res) => {
  res.json({ code: 200, data: defaultConfigs, msg: 'success' });
});

// 修改设置
router.post('/updateConfig', (req, res) => {
  const { configKey, configValue } = req.body || {};
  const item = defaultConfigs.find(c => c.configKey === configKey);
  if (!item) return res.json({ code: 500, msg: '配置项不存在' });

  // 下载目录：持久化到 settings.json（musicRoot）并重建索引
  if (configKey === 'system.download.path') {
    const dir = String(configValue || '').trim();
    if (!dir || !dir.startsWith('/')) return res.json({ code: 500, msg: '路径必须是绝对路径，例如 /vol4/1000/Music' });
    if (!config.isAllowedRoot(dir)) return res.json({ code: 500, msg: '路径必须在挂载范围内（' + config.allowedRoots.join('、') + '）的子目录中' });
    let st;
    try { st = fs.statSync(dir); } catch (e) { return res.json({ code: 500, msg: '目录不存在：' + dir + '，请先在 NAS 上创建该目录' }); }
    if (!st.isDirectory()) return res.json({ code: 500, msg: '路径不是文件夹：' + dir });
    settings.set('musicRoot', dir);
    item.configValue = dir;
    res.json({ code: 200, msg: '已更新下载目录并开始重建索引', data: { musicRoot: dir } });
    localLibrary.rebuildLibrary()
      .then(r => console.log('[本地曲库] 重建完成: root=' + dir + ' total=' + r.total + ' inserted=' + r.inserted))
      .catch(e => console.error('[本地曲库] 重建失败: ' + e.message));
    return;
  }

  // 访问口令：持久化到 settings.json（authToken），改后立即生效，需用新口令重新登录
  if (configKey === 'system.auth.token') {
    const v = String(configValue || '').trim();
    if (v.length < 4) return res.json({ code: 500, msg: '口令至少 4 位' });
    settings.set('authToken', v);
    item.configValue = v;
    res.json({ code: 200, msg: '访问口令已更新，请用新口令重新登录' });
    return;
  }

  item.configValue = configValue;
  if (configKey === 'system.download.file.audio.format') config.downloadFormat = configValue;
  if (configKey === 'system.download.brType') config.defaultBrType = configValue;
  if (configKey === 'system.download.maxConcurrent') config.maxConcurrent = parseInt(configValue) || 3;
  res.json({ code: 200, msg: '修改成功' });
});

// 获取插件类型
router.get('/getOption', (req, res) => {
  res.json({ code: 200, data: [{ plugName: 'netease', plugNameCn: '网易云', plugType: 'music' }], msg: 'success' });
});

// 版本号
router.get('/version', (req, res) => {
  res.json({ code: 200, data: 'v1.0.0', msg: 'success' });
});

// 网速：返回进程内实时流量统计（EWMA 平滑后字节/秒 + 单位化字符串）
router.get('/getCurrentNetwork', (req, res) => {
  res.json({ code: 200, data: traffic.getSnapshot(), msg: 'success' });
});

module.exports = router;
