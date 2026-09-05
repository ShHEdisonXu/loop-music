// 三要素严格匹配工具：歌名 / 歌手 / 专辑 归一化后比对，全部一致才算命中。
// 用于跨源搜索、播放换源、下载自动换源（switchSource / autoSwitchToJoox / resolveFallbackSource）
// 等所有"按歌名+歌手重新搜索匹配"的环节，避免命中翻唱、翻版、Live/伴奏等错误版本。
//
// 匹配规则：
//  - 歌名：归一化后必须完全相等（忽略大小写/空白/分隔符/括号内注释，如 (Live)、(Cover)、伴奏等）
//  - 歌手：候选歌手集合（以 / 、 ，分隔）须包含目标完整歌手串；feat. 合作者不参与主歌手判定
//  - 专辑：目标带专辑信息时，候选须带专辑且归一化后相等；候选源本身不返回专辑字段（如酷我）时
//    按"歌名+歌手已一致"放行，避免误杀；目标无专辑信息时仅强校验歌名+歌手

function norm (s) {
  return String(s == null ? '' : s)
    // 去括号内注释：Live / 伴奏 / Cover / 翻唱 / feat. xxx / 消音等等
    .replace(/[（(][^）)]*[）)]/g, '')
    // 去全部空白、标点分隔（· 、 ， ， / \ _ | - ~）
    .replace(/[\s·、,/\\_|\-~]+/g, '')
    .toLowerCase()
    .trim()
}

function candName (c) { return (c && (c.musicName || c.name || c.title)) || '' }
function candArtist (c) {
  if (!c) return ''
  if (Array.isArray(c.artist)) return c.artist.join('/')
  return c.musicArtists || c.artist || c.singer || ''
}
function candAlbum (c) { return (c && (c.musicAlbum || c.album || c.albumName || c.album_name)) || '' }

// 歌名归一化后精确相等
function titleEq (want, got) {
  const w = norm(want)
  const g = norm(got)
  return !!(w && g && w === g)
}

// 歌手：目标完整歌手串须被候选主歌手集合覆盖（候选拆分后逐项精确比对，防止"合集/翻唱"混入）
function artistEq (want, got) {
  const w = norm(want)
  if (!w) return false
  const g = norm(got)
  if (!g) return false
  if (g === w) return true
  const parts = String(got).split(/[/、,，;；]/).map(norm).filter(Boolean)
  return parts.indexOf(w) !== -1
}

// 专辑：目标有专辑 → 候选须有专辑且归一化相等；候选无专辑字段 → 放行（该源不返回专辑信息）
function albumEq (want, got) {
  const w = norm(want)
  if (!w) return true
  const g = norm(got)
  if (!g) return true
  return w === g
}

// want: { name, artist, album? }；cand 为搜索源返回的单条记录（字段兼容 musicName/musicArtists/musicAlbum 与 name/artist/album）
function trackMatch (want, cand) {
  if (!want || !cand) return false
  if (!titleEq(want.name, candName(cand))) return false
  if (!artistEq(want.artist, candArtist(cand))) return false
  return albumEq(want.album, candAlbum(cand))
}

// 从候选列表取第一个三要素一致的记录；无匹配返回 null（严禁退回首条）
// opts.strict=true 时关闭宽松回退：三要素（歌名+歌手+专辑）完全一致才放行，
// 适用于"下载换源"等必须避免命中跨专辑/重制版的场景；播放等保证可听性的场景保持宽松回退。
function findMatch (want, records, opts) {
  if (!Array.isArray(records)) return null
  const strict = !!(opts && opts.strict)
  // 优先级1：三要素严格一致（含专辑精确匹配，防翻唱/翻版/伴奏误命中）
  for (const r of records) {
    if (r && trackMatch(want, r)) return r
  }
  if (strict) return null
  // 优先级2（仅非严格模式）：宽松回退——歌名+歌手一致即放行。
  // 场景：目标带专辑信息但候选歌手专辑命名差异（全曲集/单曲等）导致严格匹配失配，
  // 此时若不回退会误判"无音源"。仅当歌名与主歌手均一致才放行，杜绝命中无关歌曲。
  for (const r of records) {
    if (!r || !want) continue
    if (!titleEq((want && want.name), candName(r))) continue
    if (!artistEq((want && want.artist), candArtist(r))) continue
    return r
  }
  return null
}

module.exports = { norm, findMatch, trackMatch, candName, candArtist, candAlbum, titleEq, artistEq }
