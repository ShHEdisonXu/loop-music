// 进程内流量统计：下载/上传字节计数 + EWMA 速率平滑
// recordDownload / recordUpload 由下载（及未来上传）路径调用；
// getSnapshot 供 /api/config/getCurrentNetwork 返回实时网速。

// 累计字节（进程生命周期内，仅统计，不落盘）
let downloadBytes = 0;
let uploadBytes = 0;

// EWMA 平滑后的速率（字节/秒）
let downloadSpeed = 0;
let uploadSpeed = 0;

// 上一个采样点的累计字节（用于每秒增量）
let lastDownload = 0;
let lastUpload = 0;

// EWMA 平滑系数：越大越灵敏，越小越平滑
const ALPHA = 0.3;

// 每秒采样一次：用「本次累计 - 上次累计」得到该秒瞬时字节数，再并入 EWMA
setInterval(() => {
  const nowDownload = downloadBytes;
  const nowUpload = uploadBytes;
  const dlDelta = nowDownload - lastDownload;
  const upDelta = nowUpload - lastUpload;
  lastDownload = nowDownload;
  lastUpload = nowUpload;
  // 每 tick 都做 EWMA 平滑：无新流量时按系数指数衰减向 0 收敛，形成真实波动
  downloadSpeed = ALPHA * dlDelta + (1 - ALPHA) * downloadSpeed;
  uploadSpeed = ALPHA * upDelta + (1 - ALPHA) * uploadSpeed;
}, 1000);

// 记录一次下载流量（字节）
function recordDownload(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  downloadBytes += bytes;
}

// 记录一次上传流量（字节）
function recordUpload(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  uploadBytes += bytes;
}

// 速率格式化：B/s / KB/s / MB/s
function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps < 1024) return bps.toFixed(1) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
}

// 实时快照：保留 downloadSpeed/uploadSpeed 原始语义（字节/秒），
// 新增 *Formatted 单位化字符串，供前端直接展示
function getSnapshot() {
  const snapshot = {
    downloadSpeed,
    uploadSpeed
  };
  snapshot.downloadSpeedFormatted = formatSpeed(snapshot.downloadSpeed);
  snapshot.uploadSpeedFormatted = formatSpeed(snapshot.uploadSpeed);
  return snapshot;
}

module.exports = { recordDownload, recordUpload, getSnapshot };
