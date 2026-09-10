// 音频指纹智能去重服务（Chromaprint fpcalc）
// - 后台扫描：逐首调用 fpcalc -raw 生成指纹存入 audio_fp（可暂停/停止/轮询进度）
// - 比对引擎：duration 秒级分桶 + int 倒排投票，共享指纹比例超阈值判为同曲重复
//   实测基准：同源 flac→mp3 转码 ≈93%，异源同曲压制 ≈79%，Remaster 重混 ≈25%，异曲 ≈0%
//   默认阈值 0.5：可捕获同曲不同编码/不同压制，排除 Remaster/异曲
const { spawn } = require('child_process');
const db = require('./db');
const localLibrary = require('./localLibrary');

const CONCURRENCY = 3;          // fpcalc 并发数（避免打满容器 CPU）
const DEFAULT_MIN_RATIO = 0.5;  // 共享指纹/较短方指纹 比例阈值
const DUR_BUCKET_S = 1;         // duration 秒级分桶
const INT_MAX_OCCUR = 500;      // 单 int 命中歌数超过此值视为异常，忽略该 int（防呆/防误报）

// ===== 扫描任务状态（进程内单例）=====
const scan = {
  running: false,
  paused: false,
  stopReq: false,
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  current: '',
  startAt: 0,
  endAt: 0
};

function getStatus() {
  const elapsed = scan.running ? Date.now() - scan.startAt : (scan.endAt - scan.startAt || 0);
  return {
    running: scan.running,
    paused: scan.paused,
    total: scan.total,
    done: scan.done,
    failed: scan.failed,
    skipped: scan.skipped,
    current: scan.current,
    percent: scan.total ? Math.round((scan.done / scan.total) * 1000) / 10 : 0,
    elapsedSec: Math.round(elapsed / 1000)
  };
}

function fpcalcRaw(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('fpcalc', ['-raw', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 180000);
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('fpcalc exit ' + code));
      const dm = out.match(/DURATION=([\d.]+)/);
      const fm = out.match(/FINGERPRINT=(.+)/s);
      if (!fm || !fm[1].trim()) return reject(new Error('no fingerprint'));
      const ints = fm[1].trim().split(',').filter(Boolean).map(Number);
      resolve({ duration: dm ? parseFloat(dm[1]) : 0, ints });
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scanPump(items) {
  let idx = 0;
  const runWorker = async () => {
    while (scan.running && !scan.stopReq) {
      while (scan.paused && scan.running && !scan.stopReq) await sleep(400);
      if (!scan.running || scan.stopReq) break;
      const it = items[idx++];
      if (!it) break;
      scan.current = it.path;
      try {
        const r = await fpcalcRaw(it.path);
        if (!r.ints || !r.ints.length) throw new Error('empty fp');
        db.prepare('INSERT INTO audio_fp (local_id, file_path, duration, fp, updated_at) VALUES (?,?,?,?,?)')
          .run(it.id, it.path, r.duration, r.ints.join(','), new Date().toISOString());
        scan.done++;
      } catch (e) {
        scan.failed++;
      }
    }
  };
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(runWorker());
  await Promise.all(workers);
}

function collectTodo(opts) {
  // 待扫 = local_track 中未入 audio_fp 的音轨（支持 dir 前缀试扫 / limit 限制）
  const dir = (opts && opts.dir) || '';
  const limit = Math.max(0, parseInt((opts && opts.limit), 10) || 0);
  let sql = `SELECT lt.id, lt.file_path AS path
             FROM local_track lt
             LEFT JOIN audio_fp af ON af.local_id = lt.id
             WHERE af.local_id IS NULL AND lt.file_path IS NOT NULL AND lt.file_path != ''`;
  const params = [];
  if (dir) { sql += ' AND lt.file_path LIKE ?'; params.push(String(dir).replace(/[%_]/g, m => '\\' + m) + '%'); }
  sql += ' ORDER BY lt.id LIMIT ?';
  params.push(limit || 200000);
  return db.prepare(sql).all(...params);
}

async function startScan(opts) {
  if (scan.running) return { code: 500, msg: '已有扫描正在进行' };
  const items = collectTodo(opts);
  if (!items.length) return { code: 200, msg: '没有需要扫描的曲目（可能已全部完成）', data: getStatus() };
  scan.running = true; scan.paused = false; scan.stopReq = false;
  scan.total = items.length; scan.done = 0; scan.failed = 0; scan.skipped = 0;
  scan.current = ''; scan.startAt = Date.now(); scan.endAt = 0;
  // 不 await：后台执行，接口立即返回
  scanPump(items)
    .catch(e => console.error('[fp] scan error: ' + e.message))
    .finally(() => { scan.running = false; scan.endAt = Date.now(); scan.current = ''; });
  return { code: 200, msg: `开始音频指纹扫描，共 ${items.length} 首（可轮询进度或暂停）`, data: getStatus() };
}

function stopScan() {
  if (!scan.running) return { code: 200, msg: '当前没有进行中的扫描', data: getStatus() };
  scan.stopReq = true;
  return { code: 200, msg: '已请求停止，正在收尾…', data: getStatus() };
}

function setPaused(paused) {
  if (!scan.running) return { code: 500, msg: '当前没有进行中的扫描' };
  scan.paused = !!paused;
  scan.stopReq = false;
  return { code: 200, msg: paused ? '已暂停' : '已继续', data: getStatus() };
}

function clearAll() {
  db.exec('DELETE FROM audio_fp');
  scan.stopReq = true; // 若在扫也停掉
  return { code: 200, msg: '已清空全部音频指纹，下次扫描将重新生成' };
}

// ===== 指纹统计 =====
function stats() {
  const c = db.prepare('SELECT COUNT(*) AS n FROM audio_fp').get();
  return { fingerprintCount: c.n };
}

// ===== 比对引擎 =====
function unionFind(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = x => (p[x] === x ? x : (p[x] = find(p[x])));
  const uni = (a, b) => { p[find(a)] = find(b); };
  return { find, uni };
}

function match(minRatio) {
  const ratio = (typeof minRatio === 'number' && minRatio > 0 && minRatio <= 1) ? minRatio : DEFAULT_MIN_RATIO;
  const rows = db.prepare(`
    SELECT af.local_id AS localId, af.duration AS duration, af.fp AS fp, lt.file_path AS path,
           lt.title, lt.artist, lt.album, lt.format, lt.bit_rate, lt.sample_rate, lt.duration AS trackDuration
    FROM audio_fp af JOIN local_track lt ON lt.id = af.local_id
    WHERE af.fp IS NOT NULL AND af.fp != ''
  `).all();

  // 预解析：每首 unique int 集合 + 原始长度
  const songs = [];
  for (const r of rows) {
    const ints = [];
    const seen = new Set();
    const parts = String(r.fp).split(',');
    for (let i = 0; i < parts.length; i++) {
      const v = Number(parts[i]);
      if (!seen.has(v)) { seen.add(v); ints.push(v); }
    }
    if (ints.length < 30) continue; // 过短指纹无意义
    songs.push({ localId: r.localId, duration: r.duration || r.trackDuration || 0, uniq: ints, uniqLen: ints.length });
  }
  if (songs.length < 2) return { code: 200, data: { total: 0, scanned: songs.length, groups: [] } };

  // duration 秒级分桶
  const buckets = new Map();
  for (let i = 0; i < songs.length; i++) {
    const b = Math.max(0, Math.floor(songs[i].duration));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(i);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);

  const uf = unionFind(songs.length);
  const vote = new Map();
  const edgeRatio = [];

  const touchVote = (x, y) => {
    const key = x < y ? x * 10000000 + y : y * 10000000 + x;
    vote.set(key, (vote.get(key) || 0) + 1);
  };

  for (let bi = 0; bi < keys.length; bi++) {
    const b = keys[bi];
    const cand = (buckets.get(b) || []).concat(buckets.get(b + 1) || []);
    const baseSet = new Set(buckets.get(b) || []);
    if (cand.length < 2) continue;
    // 候选内 int 倒排：int -> songIdx 列表（仅记录出现歌数）
    const inv = new Map();
    for (const idx of cand) {
      const u = songs[idx].uniq;
      for (let k = 0; k < u.length; k++) {
        const v = u[k];
        const arr = inv.get(v);
        if (!arr) inv.set(v, [idx]);
        else if (arr[arr.length - 1] !== idx) arr.push(idx); // 每首唯一，无需查重再判
      }
    }
    vote.clear();
    // 只处理「首个元素来自当前桶」的对，保证 pair 只统计一次
    for (const [v, arr] of inv) {
      if (arr.length < 2 || arr.length > INT_MAX_OCCUR) continue;
      for (let i = 0; i < arr.length; i++) {
        if (!baseSet.has(arr[i])) continue; // 仅以本桶元素为第一端
        for (let j = i + 1; j < arr.length; j++) touchVote(arr[i], arr[j]);
      }
    }
    for (const [key, cnt] of vote) {
      const x = Math.floor(key / 10000000), y = key % 10000000;
      const minLen = Math.min(songs[x].uniqLen, songs[y].uniqLen);
      if (cnt >= minLen * ratio) edgeRatio.push([x, y, cnt / minLen]);
    }
  }

  for (const [x, y] of edgeRatio) uf.uni(x, y);

  // 聚组
  const groupsMap = new Map();
  for (let i = 0; i < songs.length; i++) {
    const root = uf.find(i);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(i);
  }
  const groups = [];
  for (const members of groupsMap.values()) {
    if (members.length < 2) continue;
    // 拉取完整 rowToTrack 并组装
    const ids = members.map(m => songs[m].localId);
    const ph = ids.map(() => '?').join(',');
    const trackRows = db.prepare(`SELECT * FROM local_track WHERE id IN (${ph})`).all(...ids);
    const byId = new Map(trackRows.map(r => [r.id, r]));
    const tracks = members
      .map(m => byId.get(songs[m].localId))
      .filter(Boolean)
      .map(r => localLibrary.rowToTrack(r))
      .sort((a, b) => qualityScore(b) - qualityScore(a));
    if (tracks.length < 2) continue;
    groups.push({ id: 'fpg' + groups.length, count: tracks.length, tracks });
  }
  groups.sort((a, b) => b.count - a.count);
  return { code: 200, data: { total: groups.length, scanned: songs.length, ratio, groups } };
}

// 音质评分（仅用于组内排序标注「推荐保留」）
function qualityScore(t) {
  const fmt = (t.format || '').toLowerCase();
  const rankMap = { flac: 100, ape: 98, wav: 96, wv: 94, aiff: 92, tak: 90, m4a: 72, aac: 72, ogg: 62, opus: 58, mp3: 52 };
  let rank = rankMap[fmt] || 40;
  const br = Number(t.bitRate) || 0;
  if (fmt === 'mp3') rank += Math.min(br, 320) / 320 * 6;      // mp3 320k 略高于低码率
  else if (br) rank += Math.min(br, 2000) / 2000 * 4;
  if ((t.sampleRate || 0) >= 44100) rank += 0.5;
  return rank;
}

module.exports = { getStatus, startScan, stopScan, setPaused, clearAll, stats, match };
