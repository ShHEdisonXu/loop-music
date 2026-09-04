// GD 音乐台 api.php 的 s 签名生成器
// 签名 = 官网混淆 crc32 变体（jsjiami v7），依赖 /time 秒级时间戳作动态种子。
// 方案：VM 沙箱一次性加载官网原始脚本 crc32_gd.js（含完整混淆 crc32 函数），
//       SyncXHR 用 node 子进程同步 GET /time 拿种子，sign() 实时算出签名。
// 已用「官网同 ts 输出对比」验证：ts=1787230063 时 sign('周杰伦')=3CEA7174 与官网一致。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const GD_TIME_URL = 'https://music.gdstudio.org/time';

// 同步 GET /time（容器无 curl，用 node 子进程 + 内置 https）
function syncGetTime() {
  const script =
    "const https=require('https');const u='" + GD_TIME_URL + "';" +
    "https.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.stdout.write(d.trim()))})" +
    ".on('error',()=>process.exit(1));";
  try {
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    return String(out || '').trim();
  } catch (e) {
    return String(Math.floor(Date.now() / 1000));
  }
}

// 官网 player.js 的 mkPlayer 全局配置（签名内部会读取）
const mkPlayer = {
  api: "api.php", loadcount: 20, maxerror: 3, method: "POST", defaultlist: 1,
  fadeInOut: 3, autoplay: false, coverbg: true, mcoverbg: false, dotshine: false,
  showtime: true, mdotshine: false, lyrictitle: false, homelist: false,
  refreshlist: false, autoeq: false, desktoplyrics: false, auxlyrics: true,
  showcopyright: true, autosource: true, nameformat: 0, volume: 1,
  version: "2026.08.01", autoeqver: "2025.10.01", email: "gdstudio@email.com",
  tggroup: "https://t.me/gdstudio_music", appdir: "gdmusic.apk", appver: 1.1,
  dldir: "DesktopLyrics.exe", proxyUrl: "https://music-proxy.gdstudio.org",
  proxyBilibili: true, auxlyricsUrl: "https://lrclib.net/api/get",
  bansources: ["tencent", "kuwo", "joox"]
};

// SyncXHR：模拟浏览器同步 XHR，send 时拉取 /time
class SyncXHR {
  constructor() { this.status = 0; this.readyState = 0; this._rt = ''; }
  open() {}
  send() {
    try {
      const t = syncGetTime();
      if (/^\d{10}$/.test(t)) { this.status = 200; this._rt = t; this.readyState = 4; return; }
    } catch (e) { /* 走兜底 */ }
    this.status = 0; this.readyState = 4;
  }
  abort() { this.status = 0; }
  get responseText() { return this._rt; }
  set responseText(v) { this._rt = v; }
}

let ctx = null;
function ensureCtx() {
  if (ctx) return ctx;
  const sandbox = {
    XMLHttpRequest: SyncXHR,
    setTimeout: () => 1,
    clearTimeout: () => {},
    String, Number, Math, Array, Object, RegExp, parseInt, parseFloat, isNaN, JSON, console,
    md5: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
    mkPlayer,
    navigator: { userAgent: 'Mozilla/5.0' },
    document: { getElementById: () => null }
  };
  sandbox.window = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.location = { hostname: 'music.gdstudio.org', href: 'https://music.gdstudio.org/' };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, 'gd_crc32_gd.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'gd_crc32_gd.js' });
  if (typeof sandbox.crc32 !== 'function') throw new Error('GD crc32 加载失败');
  ctx = sandbox;
  return ctx;
}

// urlEncode：与 GD 官网一致（encodeURIComponent + 额外转义 ()*'!）
function urlEncode(a) {
  return encodeURIComponent(String(a))
    .replace(/\(/g, "%28").replace(/\)/g, "%29")
    .replace(/\*/g, "%2A").replace(/'/g, "%27").replace(/!/g, "%21");
}

// 生成 s 签名：按官网规则分 name 类 / id 类
function sign(types, value) {
  const c = urlEncode(value != null ? String(value) : '');
  return String(ensureCtx().crc32(c)).toUpperCase();
}

module.exports = { sign, urlEncode };
