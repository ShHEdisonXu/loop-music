// 下载服务全局配置
const path = require('path');
const settings = require('./services/settings');

module.exports = {
  // 服务监听端口
  port: process.env.PORT || 3001,

  // api-enhanced 网易云后端地址
  ncmApiBase: process.env.NCM_API_BASE || 'http://127.0.0.1:3000',

  // 音乐下载根目录（与 sqmusic 一致：/vol4/1000/Music/歌手/专辑/）
  // 支持运行时在「设置」页修改：settings.json 中 musicRoot 优先，其次环境变量，最后默认值
  get musicRoot() {
    return settings.get('musicRoot') || process.env.MUSIC_ROOT || '/Music';
  },

  // 允许的音乐根候选区：容器将宿主 /vol4/1000 挂载为 /vol4/1000，
  // musicRoot 必须指向该范围下的任意子目录（多用户可各自建目录切换）
  allowedRoots: ['/Music'],

  // 校验路径是否在挂载范围内（绝对路径，且位于 allowedRoots 下）
  isAllowedRoot(p) {
    return this.allowedRoots.some(r => p === r || p.startsWith(r + '/'));
  },

  // 下载格式：flac / mp3
  downloadFormat: process.env.DOWNLOAD_FORMAT || 'flac',

  // 默认音质等级（api-enhanced 支持：standard/higher/exhigh/lossless/hires）
  defaultBrType: process.env.DEFAULT_BR_TYPE || 'lossless',

  // 数据库文件
  dbFile: path.join(__dirname, 'data', 'download.db'),

  // 登录账号（兼容旧版；实际鉴权走 authToken 口令）
  username: process.env.USERNAME || 'admin',
  password: process.env.PASSWORD || 'admin123',

  // 服务访问口令（正式口令）：持久化于 settings.json（system.auth.token），
  // 所有 /api/* 请求须携带 X-Auth-Token 与此值一致；可在「设置」页修改，即时生效
  get authToken() {
    return settings.get('authToken') || 'loop123';
  },

  // 监控扫描间隔（毫秒）
  monitorInterval: process.env.MONITOR_INTERVAL || 5 * 60 * 1000,

  // 并发下载数
  maxConcurrent: 3
};
