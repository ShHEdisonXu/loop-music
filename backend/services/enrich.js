// services/enrich.js —— 本地曲库「标签完善助手」后端
// 职责：
//  1. listCandidates  纯本地 SQL 筛出「缺指定标签字段」的候选行（不联网）
//  2. suggestOne      对单条曲目联网生成标签建议（网易云为主 + MusicBrainz 补 genre/language）
//  3. batchPreview    受限并发地对一小批曲目生成建议
// 原则：只产出「建议」，绝不自动写库；最终写回由前端逐条调用既有 metaUpdate 完成。
const db = require('./db');
const netease = require('./netease');
const { execFileSync } = require('child_process');

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

// ===== 全网搜索批量自动补全（缺年份 / 缺风格 / 缺语言）=====
// 思路：按 (artist, album) 聚合缺字段曲目 → 对每个专辑用 cn.bing 抓摘要 → 识别
// 语言（字符集+关键词双保险）与风格（句级特征词）、年份（正则）→ 只出建议不写盘
// ===== 标题级风格强信号（不打搜索，直接定稿）=====
// 专辑标题：影视原声带 / OST / Score / 游戏原声带 等形态
function strongGenreFromAlbum (album) {
  const a = String(album || '')
  if (!a) return ''
  // 游戏原声优先判定（如“王者荣耀: 稷下 归虚梦演 游戏原声带”也含“原声带”）
  if (/游戏音乐|\bVGM\b|\bvideo\s?game\s?music\b|(?:游戏|手游|网游|game)\S{0,8}(?:原声带|原声|配乐|soundtrack)|(?:原声带|soundtrack)\S{0,8}(?:游戏|game)/i.test(a)) return '游戏原声'
  // 影视原声：含 OST / Soundtrack / Score，或“电影/动画/电视剧…原声/配乐”形态
  if (/影视原声|电影配乐|原声带|(?:原声带|soundtrack|ost|score)\S{0,8}(?:影视|电影|电视剧|动画|动漫)|(?:影视|电影|电视剧|动画|动漫|纪录|网剧|剧集|TV|Movie|Film|Anime|Series)\S{0,10}(?:原声|配乐|soundtrack|score|ost)|\b(?:ost|soundtrack|score)\b/i.test(a)) return '影视原声'
  return ''
}
// 曲目标题：带 OST / Soundtrack / Score / 原声 / 配乐 → 影视原声曲（无歌词，语言亦留空）
function isScoreTitle (title) {
  if (!title) return false
  return /(?:\bost\b|\bsoundtrack\b|\bscore\b|原声|配乐)/i.test(String(title))
}
// 逐曲搜索关键词：拉丁标题用英文 song 后缀（中文 bing 对英文歌名易出词典释义污染），CJK 标题沿用中文后缀
function songSearchKw (title, artist, zhSuffix) {
  const latinOnly = !/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(String(title || ''))
  return latinOnly ? `${title} ${artist} song` : `${title} ${artist} ${zhSuffix}`
}

const GENRE_LEXICON = [
  ['流行', /流行|\bpop\b/i],
  ['摇滚', /摇滚|\brock\b|\bmetal\b|\bhard\s?core/i],
  ['民谣', /民谣|\bfolk\b/i],
  ['电子', /电子|\belectronic\b|\bedm\b|\btechno\b|\btrance\b|\bhouse\b/i],
  ['嘻哈/说唱', /嘻哈|说唱|\bhip\s?-?hop\b|\brap\b/i],
  ['R&B', /\bRnB\b|\bR&B\b|\bsoul\b/i],
  ['爵士', /爵士|\bjazz\b/i],
  ['古典', /古典|\bclassical\b|\borchestral\b/i],
  ['蓝调', /蓝调|\bblues\b/i],
  ['乡村', /乡村|\bcountr(y|side)\b/i],
  ['雷鬼', /雷鬼|\breggae\b/i],
  ['朋克', /朋克|\bpunk\b/i],
  ['重金属', /重金属|\bheavy\s?metal\b/i],
  ['放克', /放克|\bfunk\b/i],
  ['中国风', /中国风|\bchinese\s?style\b/i],
  ['轻音乐', /轻音乐|\blight\s?music\b|\binstrumental\b/i],
  ['纯音乐', /纯音乐|\binstrumental\b/i],
  ['民乐', /民乐|国乐|民族乐器/i],
  ['摇滚/流行', /摇滚|流行|\brock\b|\bpop\b/i],
  ['电子舞曲', /舞曲|\bclub\b|\bdisco\b|\bdance\b/i],
  ['影视原声', /影视原声|\bOST\b|\bsoundtrack\b|\bscore\b|原声带|电影配乐/i],
  ['游戏原声', /游戏原声|\bgame\s?music\b|\bVGM\b/i],
  ['流行摇滚', /流行摇滚|\bpop\s?rock\b|\bpower\s?pop\b/i],
  ['独立', /独立|独立音乐|\bindie\b|\binde(e|ie)\b/i],
  ['另类', /另类|\balternative\b/i],
  ['新金属', /新金属|\bnu[\s-]?metal\b/i],
  ['后摇', /后摇|\bpost[\s-]?rock\b/i],
  ['氛围', /氛围音?乐|\bambient\b/i],
  ['合成器', /合成器|\bsynth(?:wave|pop|rock)?\b/i],
  ['蒸汽波', /蒸汽波|\bvaporwave\b/i],
  ['新浪潮', /新浪潮|\bnew\s?wave\b/i],
  ['迪斯科', /迪斯科|\bdisco\b/i],
  ['拉丁', /拉丁|\blatin\b/i],
  ['世界音乐', /世界音乐|\bworld\s?music\b/i],
  ['新世纪', /新世纪音乐|\bnew\s?age\b/i],
  ['city pop/城市流行', /city\s?pop|シティポップ|城市流行/i],
  ['J-POP', /\bj[\s-]?pop\b|日式流行|日系流行|日本流行|日音|杰尼斯|日本乐坛/i],
  ['演歌/歌谣曲', /演歌|歌谣曲|えんか/i],
  ['K-POP', /\bk[\s-]?pop\b|韩国流行/i],
  ['ACG/动漫', /动漫|动画|ACG|\banime\b/i],
  ['古风', /古风|\bguofeng\b/i],
  ['儿歌', /儿歌|\bkids[\s-]?song\b|\bchildren'?s\s?song\b/i],
  ['硬核', /硬核|\bhardcore\b/i]
];
// 纯音乐/器乐曲目特征标题（无歌词，语言与风格不应做歌词/搜索兜底判定，避免把器乐误判为英语等）
function isInstrumentalTitle (title) {
  if (!title) return false
  return /(序曲|前奏曲|间奏|尾奏|变奏|演奏版|纯音[乐曲]|伴奏|独奏|协奏|器乐|序章|幕间曲|谢幕曲|开场曲|\boutro\b|\bintro\b|\boverture\b|\bprelude\b|\binterlude\b|\bpostlude\b|\binstrumental\b|\breprise\b|\bsolo\b)/i.test(String(title))
}
// 风格判定的音乐语境（歌曲维度：摘要需同时出现风格词与歌曲语境词才采纳）
const MUSIC_CTX_SONG = /歌曲|单曲|音乐|歌手|演唱|献唱|唱作|歌词|专辑|发行|曲风|曲目|作品|代表作|热歌|旋律|节奏|鼓点|唱腔|乐队|乐团|live\b|cover\b|song\b|album\b|singer\b|artist\b|band\b|single\b|release\b|record\b|track\b|music\b|vocal\b|compos\w*/i
// 逐曲判定排除集合：组合模糊词条（摇滚/流行、嘻哈/说唱）+ ACG/动漫
// ACG 逐曲易被“某偶像曾为动画演唱主题曲”这类背景句污染（如 V6 整专被误标），
// 动漫歌曲改由专辑级摘要/专辑标题强信号兜底，逐曲只判具体乐风
const SKIP_PER_TRACK = new Set(['摇滚/流行', '嘻哈/说唱', 'ACG/动漫'])
// 特异性剪枝：宽泛父类风格（流行/摇滚/电子）与更具体的同族词条并存时，剔除父类，
// 避免 “city pop” 里的 pop / “pop rock” 里的 rock 让宽泛词条抢占前2位
const PRUNE_MAP = {
  '流行': ['city pop/城市流行', 'J-POP', 'K-POP', '流行摇滚', '电子舞曲', '合成器'],
  '摇滚': ['流行摇滚', '朋克', '重金属', '后摇', '新金属'],
  '电子': ['电子舞曲', '氛围', '合成器', '蒸汽波', '新浪潮']
}
// 主导性风格优先展示：命中时前移（如 city pop 专辑摘要同时提“爵士/放克”时 city pop 仍应居首）
const PREFERRED_GENRES = ['city pop/城市流行', 'J-POP', 'K-POP', '演歌/歌谣曲']
function pruneGenreHits (hits) {
  const set = new Set(hits)
  for (const [generic, specifics] of Object.entries(PRUNE_MAP)) {
    if (!set.has(generic)) continue
    if (specifics.some(s => set.has(s))) set.delete(generic)
  }
  return [...set]
}
function orderGenreHits (hits) {
  const out = []
  const rest = [...hits]
  for (const p of PREFERRED_GENRES) {
    const i = rest.indexOf(p)
    if (i >= 0) out.push(...rest.splice(i, 1))
  }
  return out.concat(rest)
}
// 逐曲风格判定：对单曲搜索摘要，按句子统计特征词，命中并含音乐语境则采纳，最多取前2个
function genreFromSnippet (snippet) {
  if (!snippet) return ''
  const sents = String(snippet).split(/[。！？!?；;\n]/)
  const hits = []
  for (const [gname, re] of GENRE_LEXICON) {
    if (SKIP_PER_TRACK.has(gname)) continue
    if (hits.includes(gname)) continue
    if (sents.some(s => re.test(s) && MUSIC_CTX_SONG.test(s))) hits.push(gname)
  }
  return orderGenreHits(pruneGenreHits(hits)).slice(0, 2).join(' / ')
}
// ===== iTunes Search API：免费无 Key，返回 primaryGenreName + releaseDate =====
async function iTuneSearch(artist, album) {
  try {
    const query = [album, artist].filter(Boolean).join(' ')
    const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&entity=album&limit=3&media=music'
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json()
    let best = null
    for (const r of (data.results || [])) {
      const n = (r.collectionCensoredName || r.collectionName || '').toLowerCase()
      const a = (r.artistName || '').toLowerCase()
      if (n === album.toLowerCase() && a === artist.toLowerCase()) { best = r; break }
    }
    best = best || data.results[0]
    if (!best) return null
    return { genre: best.primaryGenreName || '', year: best.releaseDate ? best.releaseDate.substring(0, 4) : '' }
  } catch { return null }
}

// 抓 cn.bing 搜索摘要：返回拼接后的文本（多个 <p> 摘要）
async function bingSnippet(keyword) {
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(keyword) + '&setlang=zh-CN&cc=CN'
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(12000)
  })
  if (!res.ok) return ''
  const html = await res.text()
  const cleanTxt = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-zA-Z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim()
  // 词典/翻译/汉字释义类噪音卡（如「king是什么词性」「expressions的用法」），对风格判定是纯污染
  const DICT_RE = /词典|爱词霸|翻译|音标|读音|同义词|释义|例句|中文意思|康熙|一词多义|词性|汉字|偏旁|笔顺|definition|translation/i
  const NOISE_HEAD = /^(下一步|更多|视频|图片|新闻|约\s*[\d,]+\s*个结果|[\d,]+\s*results)/i
  const parts = []
  // 1) 优先逐 b_algo 卡片提取（标题+正文），词典卡整卡跳过
  const cardRe = /<li class="b_algo"[\s\S]*?<\/li>/gi
  let cm
  while ((cm = cardRe.exec(html)) && parts.length < 6) {
    const card = cm[0]
    if (DICT_RE.test(card)) continue
    const h2 = (card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || ''
    const pp = (card.match(/<(?:p|span)[^>]*>([\s\S]*?)<\/(?:p|span)>/i) || [])[1] || ''
    const txt = cleanTxt(h2 + ' ' + pp)
    if (txt.length >= 10 && !NOISE_HEAD.test(txt)) parts.push(txt)
  }
  // 2) 卡片数不足时全局 <p>/<span> 兜底（同样逐段过滤词典/噪音）
  if (parts.length < 2) {
    const re = /<(?:p|span)[^>]*>([\s\S]*?)<\/(?:p|span)>/gi
    let m
    while ((m = re.exec(html)) && parts.length < 6) {
      if (DICT_RE.test(m[0])) continue
      const txt = cleanTxt(m[1])
      if (txt.length >= 10 && !NOISE_HEAD.test(txt)) parts.push(txt)
    }
  }
  return parts.join(' ')
}

// 容器内自建 ncm-api（网易云）取歌词：cloudsearch 拿候选 → 归一匹配歌名/歌手 → /lyric 取纯歌词
// 用于语言模式逐曲兜底（bing 摘要已退化，歌词直接判语言远比网页摘要可靠）
const NCM_BASES = ['http://127.0.0.1:23236', 'http://127.0.0.1:23240']
const sleepNcm = (ms) => new Promise(r => setTimeout(r, ms))
async function ncmLyricJson(path, params) {
  let lastErr
  // 两轮 × 双 base：网易云风控/限流常返回瞬时 405/503，短退避后重试一轮即可命中
  for (let round = 0; round < 2; round++) {
    for (const base of NCM_BASES) {
      try {
        const url = base + path + '?' + new URLSearchParams(params).toString()
        const res = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (res.ok) return await res.json()
        lastErr = new Error('ncm status ' + res.status)
      } catch (e) { lastErr = e }
    }
    if (round === 0) await sleepNcm(350)
  }
  if (lastErr) console.warn('[enrich] ncmLyricJson fail:', path, lastErr.message)
  return null
}
// 归一化：小写、去全/半角括号及波浪号、去标点空白，仅留字母数字中日韩
const normLoose = (s) => String(s || '').toLowerCase().replace(/[（(].*?[)）]/g, '').replace(/[～~〜:：・.。!！?？,，\-—_'"“”‘’\s【】\[\]]/g, '').replace(/\u3000/g, '')
// 变体标记（伴奏/纯音乐/live/翻唱 remix 等）：优先剔除，避免取到非原版歌词
const NCM_VARIANT = /伴奏|karaoke|inst(\.|rumental)?|instrumental|纯音乐|lullaby|sing-?a-?long|remix|live|演唱会|cover|翻唱|伴奏版|(acoustic|ver\.?|version|official|demo|re-?mix)/i
async function ncmSongLyric(title, artist) {
  const kw = [title, artist].filter(Boolean).join(' ')
  const j = await ncmLyricJson('/cloudsearch', { keywords: kw, limit: 8, type: 1 })
  const songs = (j && j.result && j.result.songs) || []
  if (!songs.length) return ''
  const nTitle = normLoose(title)
  const nArtist = normLoose(artist)
  // 打分：歌名归一完全相等优先；歌手名互相包含加分；变体（伴奏/live/remix）扣分
  const scored = songs.map(s => {
    const nm = normLoose(s.name)
    const ars = (s.ar || s.artists || []).map(a => normLoose(a.name))
    let score = 0
    if (nm && nTitle && nm === nTitle) score += 100
    else if (nTitle && nm && (nm.includes(nTitle) || nTitle.includes(nm))) score += 60
    if (nArtist && ars.some(a => a && (a.includes(nArtist) || nArtist.includes(a)))) score += 20
    if (nArtist && ars.some(a => a && a.includes(nArtist) && nTitle && (nm.includes(nTitle)))) score += 10
    if (NCM_VARIANT.test(s.name || '')) score -= 50
    return { id: s.id, name: s.name, score }
  // 阈值 40：仅歌手名互相包含（20 分）不足以锁定，须歌名实体匹配（60 分起步）才采信，
  // 避免同名歌手热门曲/同专辑其它曲目被错配成歌词（纯配乐无独立条目时尤其致命）
  }).filter(x => x.score >= 40).sort((a, b) => b.score - a.score)
  // 无高分候选（歌名/歌手匹配不上）直接放弃：宁缺毋滥，杜绝 songs[0] 张冠李戴
  const pick = scored[0]
  if (!pick) return ''
  const lr = await ncmLyricJson('/lyric', { id: pick.id })
  const ly = (lr && lr.lrc && lr.lrc.lyric) || ''
  // 网易云"暂无歌词"占位
  if (!ly || /暂无歌词|纯音乐，请欣赏/.test(ly)) return ''
  return ly
}

// 摘要相关性预检：摘要若完全不含 query 目标实体（歌手/专辑/歌名的关键 token），
// 视为 bing 跑偏（如搜 V6 专辑返回 UU 加速器），宁缺毋滥直接丢弃，避免词典/无关页污染判定
function snippetRelevant(snippet, names) {
  if (!snippet) return false
  const s = String(snippet)
  for (const n of names) {
    const nm = String(n || '').replace(/[（(].*?[)）]|[\s"'“”‘’·.。,-]/g, '').trim()
    if (nm && nm.length >= 2 && s.includes(nm)) return true
  }
  // 英文纯拉丁名无法逐 token 硬匹配时，允许归一化 token 任一出现在摘要
  for (const n of names) {
    const toks = String(n || '').split(/[\s'"&]+/).filter(t => t.length >= 3)
    if (toks.length && toks.some(t => s.toLowerCase().includes(t.toLowerCase()))) return true
  }
  return false
}

// 识别单个专辑字段：返回 { year, genre, language, yearConf, genreConf, langConf, snippet }
// 规则：语言以「专辑/歌手名」字符集为准（最可靠），摘要关键词仅作粤语等细化修正；
// 年份只采「发行于/发布于 XXXX(年|月)」这类明确上下文，排除版权/发布日期噪音；
// 风格要求特征词与音乐语境（歌曲/专辑/发行/歌手/演唱 等同句出现）同时命中。
const MUSIC_CTX = /专辑|歌曲|单曲|音乐|歌手|演唱|发行|发布|曲目|乐团|乐手|主打|收录|作品集|原声|配乐|单曲/i;
const MONO_MAKER = /copyright|版权所有|ICP|W3C|文档|备案|会议|新闻|NT[0-9]|测试站|个人信息保护/i;

// 读取 audio file 的内嵌歌词（FLAC lyrics / MP3 USLT / M4A ©lyr），批量读取
// 注意：路径量可能达数千，必须分批（每批 300）交给 python3，避免 argv 超长（E2BIG）导致整批失败返回空
function readEmbeddedLyrics(paths) {
  if (!paths || !paths.length) return {};
  const py = `
import sys, json
try:
    from mutagen.flac import FLAC
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4
except Exception:
    sys.exit(1)
paths = json.loads(sys.argv[1])
out = {}
for p in paths:
    try:
        t = None; lyr = None
        if p.lower().endswith('.flac'):
            t = FLAC(p)
            for k in ('lyrics','lyrics_en','lyrics_zh'):
                if t.get(k):
                    v = t[k][0] if isinstance(t[k], list) and t[k] else t[k]
                    if v: lyr = v; break
        elif p.lower().endswith(('.m4a','.mp4','.m4b')):
            t = MP4(p)
            for k in ('\\xa9lyr','soal','lyr'):
                if t.get(k) and t.get(k)[0]:
                    lyr = t[k][0]; break
        else:
            t = MP3(p)
            for k in t:
                if k.startswith('USLT'):
                    f = t[k]
                    v = f.text[0] if getattr(f, 'text', None) else (f[0] if isinstance(f, list) else str(f))
                    if v: lyr = v; break
        if lyr:
            if isinstance(lyr, bytes): lyr = lyr.decode('utf-8','ignore')
            out[p] = str(lyr)
    except Exception:
        pass
print(json.dumps(out, ensure_ascii=False))
`;
  const BATCH = 300;
  const out = {};
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const j = JSON.stringify(batch);
    try {
      const res = execFileSync('python3', ['-c', py, j], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
      const txt = String(res || '').trim();
      if (txt) Object.assign(out, JSON.parse(txt) || {});
    } catch (e) {
      // 单批失败仅跳过该批，不影响其余批次
    }
  }
  return out;
}

// 基于歌词正文判定语言：按字符集主导（假名→日语、谚文→韩语、汉字+粤语词→粤语、汉字→中文、拉丁→英语）
// 纯音乐标注 / 无有效歌词正文 → 返回空（回落字符集兜底）
function langFromLyrics(lyricText) {
  const raw = String(lyricText || '');
  // 空壳/污染歌词（QQ音乐残留元数据：nickname/qqnumber 头 + 无正文）视为无歌词
  if (/qqnumber|nickname|musicnana/i.test(raw) && !/[\u4e00-\u9fff]{4,}|[A-Za-z]{5,}\s+[A-Za-z]{2,}/.test(raw)) {
    // 若仅含标签/衬词/数字而无任何成句正文 → 判空；若确有成句歌词则继续走正文判定
    const bodyLike = raw.replace(/\[[^\]]{1,60}\]/g, '').replace(/[^\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fffA-Za-z]/g, '');
    if (!/[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]{3,}|[A-Za-z]{6,}/.test(bodyLike)) return { language: '', conf: 'low' };
  }
  const BODY = [];
  for (const ln of String(raw).split(/\r?\n/)) {
    let s = ln.replace(/\[[^\]]{1,60}\]/g, '').trim();
    if (!s) continue;
    // 跳过版权 / credit / 纯音乐标注行
    if (/^(纯音乐|纯钢琴|轻声哼唱|啊{2,}|哼唱|无歌词|纯乐曲|instrumental)/i.test(s)) continue;
    if (/^(作词|作曲|编曲|词曲|制作|混音|录音|监制|发行|出品|编曲|作曲|演唱|OP|SP|[A-Za-z\s]{0,30}(Produced|Written|Composed|Arranged|Mix(ed|ing)?|Master(ed|ing)?|Recorded|Vocals))/.test(s)) continue;
    // 网易云 lrc 头部 credit 密集段：制作/乐手/厂牌/翻译等（中文标签或中英混排），非歌词正文，须剔除避免拉丁字符污染判定
    if (/^(音乐监制|音乐出品|音乐制作|制作人|编曲人|作词人|作曲人|吉他|贝斯|鼓|鼓手|键盘|钢琴|小提琴|大提琴|弦乐|小型弦乐|管弦|铜管|木管|打击乐|管乐|萨克斯|小号|长号|录音室|混音室|录音|混音|母带|和声|和音|合唱|统筹|企划|企宣|文案|设计|封面|摄影|导演|翻译|中文翻译|歌词中文翻译|ISRC|OP|SP)\s*[:：]?/.test(s)) continue;
    if (/^[\u4e00-\u9fff]{1,20}(?:[A-Za-z]+\s*){2,}[：:]/.test(s)) continue;
    // 中文标签 + 冒号 + 英文人名/职位/厂牌（如“小型弦乐：NEM Studios Session Musicians”）同样为 credit
    if (/^[\u4e00-\u9fff]{1,14}[：:]\s*(?:[A-Za-z]+(?:[\s&/]+|$)){2,}/.test(s)) continue;
    if (/^(?:Executive|Produced|Producer|Written|Composed|Arranged|Mixed|Mixing|Master(?:ed|ing)?|Recorded|Recording|Vocals|Guitar|Bass|Drums|Keyboard|Violin|Cello|Orchestra|Strings|Engineer|Studio|Copyright|℗|©)\b/i.test(s)) continue;
    // 只保留歌词正文（含中日韩英字符）
    const pure = s.replace(/[^\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fffA-Za-z]/g, '');
    if (pure.length >= 2) {
      // 纯衬词行（lalala/dadada/nanana/yeah 等无实义重复音节）不计入正文
      if (/^(?:la|da|na|ha|ya|wo|oh|ye|yeah|ei|ai|ao|ou|ho|he|yo|hu|m+|o+|a+|i+|u+|e+)+$/i.test(pure)) continue;
      BODY.push(pure);
    }
  }
  const body = BODY.join('');
  if (!body) return { language: '', conf: 'low' };
  // 纯衬词（无实义词句，如 lalalala / dadada / nanana / yeahyeah 等重复音节）视为无歌词
  if (/^(?:la|da|na|ha|ya|wo|oh|ye|yeah|ei|ai|ao|ou|ho|he|yo|hu|m+|o+|a+|i+|u+|e+)+$/i.test(body)) {
    return { language: '', conf: 'low' };
  }
  const kana = (body.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (body.match(/[\uac00-\ud7af]/g) || []).length;
  const han = (body.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (body.match(/[A-Za-z]/g) || []).length;
  const total = Math.max(1, body.length);
  // 日文：假名占比显著（≥6% 且 ≥5 个）；假名是日文区别于中文的关键
  if (kana >= 5 && kana / total >= 0.06) return { language: '日语', conf: 'high' };
  if (hangul >= 5 && hangul / total >= 0.05) return { language: '韩语', conf: 'high' };
  // 中文：汉字占比高（多数是汉字，拉丁少）
  if (han / total >= 0.5 && han >= 6) {
    if (/[嘅|咗|唔|係|嗰|啲|佢|哋|冇|冚|喺]/.test(body)) return { language: '粤语', conf: 'high' };
    return { language: '中文', conf: 'high' };
  }
  // 拉丁：拉丁占比高（如汉字仅少量混入时）
  if (latin / total >= 0.55 && latin >= 6) return { language: '英语', conf: 'medium' };
  return { language: '', conf: 'low' };
}

async function webAlbumSuggest(artist, album, lyricTexts) {
  const kw = [album, artist, '专辑'].filter(Boolean).join(' ')
  const rawSnippet = await bingSnippet(kw)
  // bing 长尾查询常跑偏（如搜 V6 专辑返回 UU 加速器）——摘要不含专辑/歌手实体即丢弃，宁缺毋滥
  const snippet = snippetRelevant(rawSnippet, [artist, album]) ? rawSnippet : ''

  let year = '', yearConf = 'low'
  let genre = '', genreConf = 'low'
  let language = '', langConf = 'low'

  // ===== iTunes 优先：免费无 Key，精准拿风格 + 年份 =====
  const it = await iTuneSearch(artist, album)
  if (it) {
    if (it.genre) { genre = it.genre; genreConf = 'medium' }
    if (it.year) { year = it.year; yearConf = 'medium' }
  }

  // ==== 语言判定优先级：① 内嵌歌词投票（最可靠）→ ② 专辑/歌手名字符集（兜底）+摘要粤语微调 ====
  const src = (album + ' ' + artist)
  // ① 有歌词：对整张专辑采样曲目逐首判定，按语言投票取多数（跨语言合唱/多语精选集取主语言）
  const lyricList = Array.isArray(lyricTexts) ? lyricTexts : (lyricTexts ? [lyricTexts] : [])
  const validLyrics = lyricList.filter(t => t && String(t).trim())
  if (validLyrics.length) {
    const votes = {}
    for (const t of validLyrics) {
      const r = langFromLyrics(t)
      if (r && r.language) votes[r.language] = (votes[r.language] || 0) + (r.conf === 'high' ? 1 : 0.5)
    }
    // 取票数最高的语言（若最高与次高并列且同源，取高置信；空投票则回落）
    let best = '', bestV = 0
    for (const [lang, v] of Object.entries(votes)) {
      if (v > bestV) { best = lang; bestV = v }
    }
    if (best) {
      language = best
      langConf = bestV >= 2 ? 'high' : 'medium'
    }
    // 歌词判中文且摘要明确写粤语，仍可细化
    if (language === '中文' && snippet && /(专辑|歌曲|音乐)[^。；;]{0,18}(粤语|广东话|廣東話)/i.test(snippet)) {
      language = '粤语'; langConf = 'high'
    }
  }
  // ② 无歌词 / 纯音乐：字符集兜底
  if (!language) {
    if (/[\u3040-\u30ff]/.test(src)) { language = '日语'; langConf = 'medium' }
    else if (/[\uAC00-\uD7AF]/.test(src)) { language = '韩语'; langConf = 'medium' }
    else if (/[\u4e00-\u9fff]/.test(src)) {
      language = /粤|廣|港/.test(src) ? '粤语' : '中文'
      langConf = 'medium'
    } else if (/[A-Za-z]/.test(src)) { language = '英语'; langConf = 'medium' }
  }

  // 专辑标题强信号（OST / 原声带 / Score / 游戏原声带等）直接定稿：与摘要无关，必须先于摘要判定
  const albumStrong = strongGenreFromAlbum(album)
  if (albumStrong) { genre = albumStrong; genreConf = 'high' }

  if (snippet && !genre) {
    // 掐掉版权/备案等噪音片段（避免年份与风格被版权行污染）
    const clean = (snippet || '').split(/[。！？;；\n]/)
      .map(s => s.trim())
      .filter(s => s.length >= 4 && !MONO_MAKER.test(s))
      .join('。')

    // ==== 年份：只采强形式「发行于/发布于/发售于 YYYY」或「YYYY年发行/发售/上市」；强形式缺失则留空，宁缺毋滥 ====
    const ym =
      clean.match(/(?:发行于|发布于|发售于|发行时间|发行日期)\s*(?:20\d{2}|19[5-9]\d)(?:\s*年)?/)
      || clean.match(/(?:20\d{2}|19[5-9]\d)\s*年\s*(?:发行|发布|发售|上市|推出)/)
    if (ym) {
      const y = String(ym[0]).match(/(20\d{2}|19[5-9]\d)/)
      if (y) { year = y[1]; yearConf = 'high' }
    }

    // ==== 风格：特征词 + 音乐语境同片段命中才采纳 ====
    const hits = []
    const sents = (snippet || '').split(/[。！？;；\n]/)
    for (const [g, re] of GENRE_LEXICON) {
      if (hits.includes(g)) continue
      const ok = sents.some(s => re.test(s) && MUSIC_CTX.test(s))
      if (ok) hits.push(g)
    }
    if (hits.length) {
      // ACG 与流行类并存（如“日本偶像演唱动画主题曲”的专辑介绍）时优先具体乐风，去掉 ACG
      if (hits.includes('ACG/动漫') && hits.length > 1) hits.splice(hits.indexOf('ACG/动漫'), 1)
      const gh = orderGenreHits(pruneGenreHits(hits))
      genre = gh.slice(0, 2).join(' / '); genreConf = gh.length >= 2 ? 'high' : 'medium'
    }
  }
  return { year, genre, language, yearConf, genreConf, langConf, snippet: snippet.slice(0, 160) }
}

// 聚合缺字段全部曲目为 (artist,album) 组并按覆盖曲目数排序取前 limit 组
async function webAutofill({ missing, limit = 60 } = {}) {
  const col = ['year', 'genre', 'language'].includes(missing) ? missing : null
  if (!col) throw new Error('missing 必须为 year / genre / language')
  const rows = db.prepare(
    `SELECT id, title, artist, album, file_path FROM local_track WHERE COALESCE(${col},'')=''`
  ).all()
  const gmap = new Map()
  for (const r of rows) {
    const artist = String(r.artist || '').trim() || '未知歌手'
    const album = String(r.album || '').trim() || '未知专辑'
    const key = normalize(artist) + '|' + normalize(album)
    if (!gmap.has(key)) gmap.set(key, { artist, album, count: 0, ids: [], files: [], tracks: [] })
    const g = gmap.get(key)
    g.count += 1
    g.ids.push(r.id)
    if (r.file_path) g.files.push(r.file_path)
    const title = String(r.title || '').trim()
    if (title) g.tracks.push({ id: r.id, title, file: String(r.file_path || '').split('/').pop() || '', path: r.file_path || '' })
  }
  const groups = [...gmap.values()].sort((a, b) => b.count - a.count).slice(0, limit)

  const langMode = col === 'language'

  // 读取内嵌歌词：语言模式为逐曲判定，读每组全部曲目（上限 120，覆盖绝大多数专辑组）；
  // 否则采样 6 首即可
  const readPaths = langMode
    ? groups.map(g => g.files.slice(0, 120)).flat().filter(Boolean)
    : groups.map(g => g.files.slice(0, 6)).flat().filter(Boolean)
  const lyricMap = readEmbeddedLyrics(readPaths)

  // 在线歌词检索缓存（key: norm(title)|norm(artist)）与全局预算，避免对在线源过多请求
  const snippetCache = new Map()
  let searchBudget = 0
  // ncm 为容器内自建 API（无外部计费），预算放宽到 1500 以覆盖多数在线兜底；bing 已不参与语言判定
  const MAX_SEARCH = 1500

  // 受限并发识别（并发 4，避免对 bing 过快）
  const out = new Array(groups.length)
  let idx = 0
  async function worker() {
    for (;;) {
      const i = idx++
      if (i >= groups.length) return
      const g = groups[i]
      const sampleLyrics = g.files.slice(0, 6).map(f => (f && lyricMap[f]) || '')
      const r = await webAlbumSuggest(g.artist, g.album, sampleLyrics)

      // ==== 语言模式：逐曲判定（以「歌名+歌手」为维度，内嵌歌词优先，缺失时在线搜该曲歌词兜底）====
      let tracksOut = g.tracks
      if (langMode) {
        const perLang = []
        for (const t of (g.tracks || [])) {
          // 器乐/配乐/伴奏曲：即使内嵌歌词由下载源误配了原版歌词，也无唱词，语言一律留空待人工标注
          const instTitle = !!(t.title && (isInstrumentalTitle(t.title) || isScoreTitle(t.title)))
          const lyr = (t.path && lyricMap[t.path]) || ''
          let rr = (!instTitle && lyr) ? langFromLyrics(lyr) : { language: '', conf: 'low' }
          // 纯音乐/器乐/影视配乐曲目没有歌词：不做在线搜索兜底，避免器乐被误判成英语/中文
          if (!rr.language && t.title && instTitle) {
            // 留空待人工标注
          } else if (!rr.language && t.title) {
            // 标题含明确假名/谚文 → 直接按字符集定日语/韩语（日文歌名几乎必含假名，无需在线兜底）
            const kanaN = (String(t.title).match(/[\u3040-\u30ff]/g) || []).length
            const hangulN = (String(t.title).match(/[\uac00-\ud7af]/g) || []).length
            if (kanaN >= 1) { rr = { language: '日语', conf: 'medium' } }
            else if (hangulN >= 1) { rr = { language: '韩语', conf: 'medium' } }
            else {
              // 在线歌词兜底：容器内 ncm-api 取歌词正文直接判语言（bing 摘要已退化不可靠，不再用于语言判定）
              const key = normalize(t.title) + '|' + normalize(g.artist)
              let lyrTxt = snippetCache.get(key)
              if (lyrTxt === undefined && searchBudget < MAX_SEARCH) {
                lyrTxt = await ncmSongLyric(t.title, g.artist)
                snippetCache.set(key, lyrTxt || '')
                searchBudget += 1
              }
              if (lyrTxt) {
                const guess = langFromLyrics(lyrTxt)
                // 防御网易云重名错配：歌名纯拉丁却判中文（如取到中文同名歌歌词），视为不可信，留空待人工
                const titleIsCJK = /[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(String(t.title))
                if (!(guess.language === '中文' && !titleIsCJK)) rr = guess
              }
            }
          }
          perLang.push({ id: t.id, title: t.title, file: t.file, lang: rr.language, langConf: rr.conf })
        }
        // 逐曲多数票作为整组主语言（概览展示 + 前端兜底写回），混合语种专辑不再整张同一语言
        const votes = {}
        for (const p of perLang) {
          if (p.lang) votes[p.lang] = (votes[p.lang] || 0) + (p.conf === 'high' ? 1 : 0.5)
        }
        let best = '', bestV = 0
        for (const [lang, v] of Object.entries(votes)) {
          if (v > bestV) { best = lang; bestV = v }
        }
        if (best) { r.language = best; r.langConf = bestV >= 2 ? 'high' : 'medium' }
        tracksOut = perLang
      }

      // ==== 风格模式：逐曲判定（纯音乐标题直接标“纯音乐”；其余按「歌名+歌手」搜索摘要判风格，预算封顶）====
      if (col === 'genre') {
        const perGenre = []
        for (const t of (g.tracks || [])) {
          let gn = '', gConf = 'low'
          if (t.title) {
            if (isScoreTitle(t.title)) {
              gn = '影视原声'; gConf = 'high'
            } else if (isInstrumentalTitle(t.title)) {
              gn = '纯音乐'; gConf = 'high'
            } else {
              const key = normalize(t.title) + '|' + normalize(g.artist)
              let snip = snippetCache.get(key)
              if (snip === undefined && searchBudget < MAX_SEARCH) {
                snip = await bingSnippet(songSearchKw(t.title, g.artist, '歌曲'))
                snippetCache.set(key, snip)
                searchBudget += 1
              }
              if (snip && snippetRelevant(snip, [t.title, g.artist])) {
                const gs = genreFromSnippet(snip)
                if (gs) { gn = gs; gConf = 'medium' }
              }
            }
          }
          // 未能逐曲识别 → 回落整张专辑主风格，保证覆盖
          if (!gn && r.genre) { gn = r.genre; gConf = r.genreConf || 'low' }
          perGenre.push({ id: t.id, title: t.title, file: t.file, genre: gn, genreConf: gConf })
        }
        tracksOut = perGenre
      }

      out[i] = {
        artist: g.artist, album: g.album, count: g.count, ids: g.ids,
        tracks: tracksOut,
        suggest: { year: r.year, genre: r.genre, language: r.language },
        conf: { year: r.yearConf, genre: r.genreConf, language: r.langConf },
        snippet: r.snippet
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker))
  return { totalGroups: gmap.size, scannedGroups: groups.length, list: out }
}

module.exports = {
  normalize,
  suggestOne,
  batchPreview,
  listCandidates,
  ncmSuggest,
  mbSuggest,
  matchByCombos,
  bingSnippet,
  ncmSongLyric,
  langFromLyrics,
  readEmbeddedLyrics,
  webAlbumSuggest,
  webAutofill
};
