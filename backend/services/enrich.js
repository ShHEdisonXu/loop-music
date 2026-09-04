// services/enrich.js —— 本地曲库「标签完善助手」后端
// 职责：
//  1. listCandidates  纯本地 SQL 筛出「缺指定标签字段」的候选行（不联网）
//  2. suggestOne      对单条曲目联网生成标签建议（网易云为主 + MusicBrainz 补 genre/language）
//  3. batchPreview    受限并发地对一小批曲目生成建议
// 原则：只产出「建议」，绝不自动写库；最终写回由前端逐条调用既有 metaUpdate 完成。
const db = require('./db');
const netease = require('./netease');

// ===== 归一化（与 localLibrary 指纹口径一致，用于精确匹配）=====
function normalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\u3000]/g, ' ')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[\[\]()【】{}"“”‘’'`~!@#$%^&*_+\-=|;:,.<>/?·、，。；：！？…—《》〈〉]/g, '')
    .replace(/\s+/g, '');
}

// 剥离常见副标题（Live/伴奏/混音/重制/Remix/OST 等）后再匹配，提高标题命中率
function titleBase(t) {
  if (!t) return '';
  return normalize(String(t))
    .replace(/(\(|（).+?(\)|）)/g, '')
    .replace(/[♫♪]|[A-Za-z]+mix|\b(live|remix|pt\.?\d+|feat\.?|official|demo|acoustic|cover|instrumental|ost|radio edit|single version?)\b/gi, '')
    .replace(/\s+/g, '');
}

// ===== 网易云建议 =====
// 返回 { ok, songId, albumId, fields }；无匹配返回 { ok:false }
async function ncmSuggest(title, artist, albumHint) {
  const base = titleBase(title);
  if (!base) return { ok: false };
  const kw = artist ? base : base; // 先用标题搜，K 歌太泛时结合歌手二次匹配
  let resp;
  try {
    resp = await netease.searchSong(kw, 20, 1);
  } catch (e) {
    console.warn('[enrich] ncm search 失败: ' + e.message);
    return { ok: false };
  }
  const records = (resp && resp.records) || [];
  const wantTitle = normalize(title || '');
  const wantArtist = normalize(artist || '');
  // 打分：标题完全一致 > 副标剥离一致；歌手一致加分
  const scored = records
    .map(r => {
      const rT = normalize(r.musicName || '');
      const rA = normalize(r.musicArtists || '');
      let score = 0;
      if (rT === wantTitle) score += 10;
      else if (rT && wantTitle && rT === wantArtist) score += 0; // 防错位
      else if (titleBase(rT) && titleBase(rT) === titleBase(title) && rT !== wantTitle) score += 6;
      if (wantArtist) {
        if (rA === wantArtist) score += 4;
        else if (rA && rA.includes(wantArtist)) score += 3;
      } else {
        score += 2; // 无歌手信息时降低门槛但不算高置信
      }
      return { r, score };
    })
    .filter(x => x.score >= 6)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { ok: false };

  const r = best.r;
  const fields = [];
  // 标题 / 歌手仅在确有差异时给出（防误盖）
  if (wantTitle && normalize(r.musicName) !== wantTitle) {
    fields.push({ name: 'title', value: r.musicName, source: 'netease', conf: best.score >= 14 ? 'high' : 'medium' });
  }
  if (wantArtist && normalize(r.musicArtists) !== wantArtist) {
    fields.push({ name: 'artist', value: r.musicArtists, source: 'netease', conf: 'medium' });
  }
  if (r.musicAlbum) fields.push({ name: 'album', value: r.musicAlbum, source: 'netease', conf: best.score >= 14 ? 'high' : 'medium' });

  // 专辑详情：专辑艺人 / 年份 / 音轨号
  if (r.albumid) {
    try {
      const ad = await netease.getAlbumDetail(r.albumid);
      if (ad) {
        if (ad.albumSinger) fields.push({ name: 'albumArtist', value: ad.albumSinger, source: 'netease', conf: 'medium' });
        if (ad.albumTime && /^\d{4}$/.test(ad.albumTime)) fields.push({ name: 'year', value: ad.albumTime, source: 'netease', conf: 'high' });
        const cur = (ad.musics || []).find(m => normalize(m.musicName) === normalize(r.musicName))
          || (ad.musics || []).find(m => String(m.id) === String(r.id));
        if (cur && cur.trackNo) fields.push({ name: 'track', value: String(cur.trackNo), source: 'netease', conf: 'high' });
        // 专辑艺人兜底：若 albumArtist 命中时把年份提及
        if (!ad.albumSinger && r.musicAlbum) {
          // 无专辑艺人时不额外生成
        }
      }
    } catch (e) {
      console.warn('[enrich] ncm album detail 失败: ' + e.message);
    }
  }
  return { ok: true, songId: r.id, albumId: r.albumid || '', fields };
}

// ===== MusicBrainz 建议（补 genre / language，网易云无这两项）=====
// MB 语言码 -> 中文展示
const MB_LANG = {
  zho: '中文', cmn: '中文', wuu: '中文', yue: '粤语',
  eng: '英语', jpn: '日语', kor: '韩语', fre: '法语', fra: '法语',
  rus: '俄语', spa: '西班牙语', ita: '意大利语', deu: '德语', ger: '德语',
  por: '葡萄牙语', pol: '波兰语', tur: '土耳其语', tha: '泰语', vie: '越南语',
  hin: '印地语', ara: '阿拉伯语', ind: '印尼语'
};

// 仅过滤明显噪音 tag（MB 社区标注偶尔混入 CD 音轨号 / 文件描述等），正经曲风词正常保留
const GENRE_STOP = new Set([
  'full', 'cd', 'track', 'tracks', 'bonus', 'original', 'album', 'single',
  'compilation', 'live', 'remix', 'demo', 'acoustic', 'love songs', 'content', 'vocal'
]);

async function mbSuggest(title, artist) {
  const base = titleBase(title);
  if (!base) return { ok: false };
  let q = `recording:"${String(title).replace(/"/g, '')}"`;
  if (artist) q += ` AND artist:"${String(artist).replace(/"/g, '')}"`;
  const url = 'https://musicbrainz.org/ws/2/recording?query=' +
    encodeURIComponent(q) + '&fmt=json&limit=5';
  let data;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'LoopTagEnrich/1.0 ( local music library tag assistant )',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return { ok: false };
    data = await res.json();
  } catch (e) {
    console.warn('[enrich] musicbrainz 请求失败: ' + e.message);
    return { ok: false };
  }
  const fields = [];
  const recs = (data.recordings || []).filter(r => {
    const t = normalize(r.title || '');
    return t && (t === normalize(title) || titleBase(t) === titleBase(title));
  });
  if (!recs.length) return { ok: false };
  const first = recs[0];
  // 语言：取第一个带语言码的 release
  const langs = new Set();
  let genreTags = [];
  for (const r of recs) {
    for (const rel of (r.releases || [])) {
      if (rel.language) langs.add(rel.language);
    }
    for (const t of (r.tags || [])) {
      genreTags.push(t.name);
    }
  }
  // 只取社区标注次数较高的 tag 去重前 5，过滤噪音词
  const tagCount = {};
  for (const g of genreTags) { tagCount[g] = (tagCount[g] || 0) + 1; }
  const topGenres = Object.entries(tagCount)
    .filter(([g]) => !GENRE_STOP.has(String(g).toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);
  if (topGenres.length) {
    fields.push({ name: 'genre', value: topGenres.join(' / '), source: 'musicbrainz', conf: 'medium' });
  }
  const langArr = [...langs].map(l => MB_LANG[l] || l.toUpperCase());
  if (langArr.length) {
    fields.push({ name: 'language', value: langArr[0], source: 'musicbrainz', conf: 'medium' });
  }
  if (!fields.length) return { ok: false };
  return { ok: true, mbId: first.id, fields };
}

// ===== 在线匹配（元数据匹配修改页 · 对比卡片）=====
// 按用户勾选的「匹配范围组合」逐组联网搜索候选，输出带封面/专辑详情的列表；
// MusicBrainz（genre/language）与组合无关，只补一次挂到结果。
const MATCH_COMBOS = ['title', 'title_artist', 'title_artist_album'];
const matchLabel = (c) =>
  c === 'title_artist_album' ? '歌名 + 歌手 + 专辑' :
  c === 'title_artist' ? '歌名 + 歌手' : '仅歌名';

// 候选评分排序（与 ncmSuggest 同口径）：标题全等 > 副标剥一致；歌手一致加分
function scoreRecords(records, title, artist) {
  const wantTitle = normalize(title || '');
  const wantArtist = normalize(artist || '');
  return records
    .map(r => {
      const rT = normalize(r.musicName || '');
      const rA = normalize(r.musicArtists || '');
      let score = 0;
      if (rT && wantTitle && rT === wantTitle) score += 10;
      else if (titleBase(rT) && titleBase(rT) === titleBase(title) && rT !== wantTitle) score += 6;
      if (wantArtist) {
        if (rA === wantArtist) score += 4;
        else if (rA && rA.includes(wantArtist)) score += 3;
      } else {
        score += 2;
      }
      return { r, score };
    })
    .filter(x => x.score >= 6)
    .sort((a, b) => b.score - a.score)
    .map(x => x.r);
}

// row: rowToTrack 输出；combos: 匹配范围组合子集
async function matchByCombos(row, combos = ['title_artist']) {
  const title = (row && (row.musicName || row.title)) || '';
  const artist = (row && (row.artistName || row.artist)) || '';
  const album = (row && (row.albumName || row.album)) || '';
  const want = combos.filter(c => MATCH_COMBOS.includes(c));
  const kwOf = (c) => {
    if (c === 'title_artist_album') return album ? `${title} ${artist} ${album}` : `${title} ${artist}`;
    if (c === 'title_artist') return artist ? `${title} ${artist}` : title;
    return title;
  };

  const groups = [];
  for (const c of want) {
    let records = [];
    try {
      const resp = await netease.searchSong(kwOf(c).trim() || title, 20, 1);
      records = (resp && resp.records) || [];
    } catch (e) {
      console.warn('[enrich] match 搜索失败(' + c + '): ' + e.message);
      records = [];
    }
    const top = scoreRecords(records, title, artist).slice(0, 6);
    const items = await Promise.all(top.map(async (s) => {
      const it = {
        musicName: s.musicName || '',
        artistName: s.musicArtists || '',
        albumName: s.musicAlbum || '',
        cover: s.musicImage || '',
        albumArtist: '',
        year: '',
        track: ''
      };
      if (s.albumid) {
        try {
          const ad = await netease.getAlbumDetail(s.albumid);
          if (ad) {
            it.albumArtist = ad.albumSinger || '';
            if (ad.albumTime && /^\d{4}$/.test(ad.albumTime)) it.year = ad.albumTime;
            const cur = (ad.musics || []).find(m => String(m.id) === String(s.id));
            if (cur && cur.trackNo) it.track = String(cur.trackNo);
          }
        } catch (e) { /* 专辑详情失败不阻塞候选 */ }
      }
      return it;
    }));
    if (items.length) {
      groups.push({ key: c, label: matchLabel(c), keyword: kwOf(c).trim(), candidates: items });
    }
  }

  // MusicBrainz 补 genre/language（一次）
  let mbFields = [];
  try {
    const mb = await mbSuggest(title, artist);
    if (mb && mb.ok) mbFields = mb.fields;
  } catch (e) { /* MB 失败不阻塞 */ }
  const mbExtra = {};
  for (const f of mbFields) { if (f && f.name) mbExtra[f.name] = f.value || ''; }

  return { combos: groups, mb: mbExtra };
}

// ===== 单条合成建议 =====
// row 为 rowToTrack 输出（含 musicName/artistName/albumName/year/...）
async function suggestOne(row) {
  const out = { id: row.id, musicName: row.musicName, artistName: row.artistName, fields: [] };
  const [ncm, mb] = await Promise.all([
    ncmSuggest(row.musicName, row.artistName, row.albumName),
    mbSuggest(row.musicName, row.artistName)
  ]);
  if (ncm && ncm.ok) {
    out.ncmSongId = ncm.songId;
    out.ncmAlbumId = ncm.albumId;
    out.fields = out.fields.concat(ncm.fields);
  }
  if (mb && mb.ok) {
    out.mbId = mb.mbId;
    out.fields = out.fields.concat(mb.fields);
  }
  // 同字段去重：网易云优先（来源顺序）
  const seen = {};
  out.fields = out.fields.filter(f => {
    const k = f.name;
    if (k in seen) return false;
    seen[k] = true;
    return true;
  });
  return out;
}

// 受限并发批量建议（并发 3，避免触发网易云风控）
async function batchPreview(tracks, concurrency = 3) {
  const results = new Array(tracks.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= tracks.length) return;
      try {
        results[i] = await suggestOne(tracks[i]);
      } catch (e) {
        results[i] = { id: tracks[i].id, musicName: tracks[i].musicName, fields: [], error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker));
  return results;
}

// ===== 候选清单（纯本地 SQL，不联网）=====
// missing: 逗号分隔的字段名列表；命中「任意一个所填字段为空」的行
function listCandidates(options = {}) {
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(5, parseInt(options.pageSize, 10) || 50));
  const missCols = (options.missing || '')
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(s => ['title', 'artist', 'album', 'album_artist', 'year', 'track', 'disc',
      'genre', 'language', 'composer', 'lyricist', 'comment', 'bpm'].includes(s));
  const conds = [];
  const params = [];
  if (missCols.length) {
    const emptyOr = missCols.map(() => '?').join(' OR ');
    // 用 (col IS NULL OR col='') 判定空
    const parts = missCols.map(c => `(COALESCE(${c},'')='')`);
    conds.push('(' + parts.join(' OR ') + ')');
  }
  const like = (col, val) => {
    if (val) { conds.push(`${col} LIKE ?`); params.push('%' + val + '%'); }
  };
  like('artist', options.artist);
  like('album', options.album);
  if (options.kw) {
    const kw = '%' + options.kw + '%';
    conds.push('(title LIKE ? OR artist LIKE ? OR album LIKE ?)');
    params.push(kw, kw, kw);
  }
  const where = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM local_track ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM local_track ${where} ORDER BY id LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  const list = rows.map(r => ({
    id: r.id,
    musicName: r.title || '未知歌曲',
    artistName: r.artist || '',
    albumName: r.album || '',
    albumArtist: r.album_artist || '',
    year: r.year || '',
    track: r.track || '',
    disc: r.disc || '',
    genre: r.genre || '',
    language: r.language || '',
    composer: r.composer || '',
    lyricist: r.lyricist || '',
    comment: r.comment || '',
    bpm: r.bpm || ''
  }));
  return { total, page, pageSize, list };
}

module.exports = {
  normalize,
  suggestOne,
  batchPreview,
  listCandidates,
  ncmSuggest,
  mbSuggest,
  matchByCombos
};
