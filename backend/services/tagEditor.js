// tagEditor：本地音频内嵌标签读写模块（与 enrich.js 读取方式一致，基于 python3 + mutagen）
//  - readTag(id)       读取单曲内嵌标签
//  - writeTag(id, fields, cover)  写回源文件（写前 SHA1 备份到 musicRoot/.meta/tag_backup），并同步 local_track 索引
//  - backupInfo(id)    查询该曲备份情况（供回滚提示）
// 备份目录使用 config.musicRoot（容器内挂载点 /Music → 宿主 /vol4/1000/Music），确保不写入容器 rw 层
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const config = require('../config');
const db = require('./db');
const localLibrary = require('./localLibrary');

const BAK_ROOT = () => path.join(config.musicRoot, '.meta', 'tag_backup');

// ---------- 基础 ----------
function trackRow(id) {
  try {
    return db.prepare('SELECT * FROM local_track WHERE id = ?').get(id) || null;
  } catch (e) {
    return null;
  }
}

function safeId(id) {
  const n = String(id == null ? '' : id).trim();
  if (!/^\d+$/.test(n)) throw new Error('非法的歌曲ID: ' + n);
  return parseInt(n, 10);
}

// ---------- 备份 ----------
function backupFile(filePath, id) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const dir = BAK_ROOT();
  fs.mkdirSync(dir, { recursive: true });
  const sha = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
  const base = path.basename(filePath);
  const dest = path.join(dir, `${id}_${sha}_${base}`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(filePath, dest);
  }
  return dest;
}

// ---------- Python 读写 ----------
const PY_READ = `
import sys, json
from mutagen.flac import FLAC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4
from mutagen.id3 import TXXX
p = sys.argv[1]
out = {}
try:
    low = p.lower()
    t = None
    if low.endswith('.flac'):
        t = FLAC(p)
        for k in ('title','artist','album','albumartist','date','tracknumber','discnumber','genre','language','composer','lyricist','description','bpm'):
            if t.get(k):
                v = t[k][0] if isinstance(t[k], list) and t[k] else t[k]
                out[k] = str(v)
    elif low.endswith(('.m4a','.mp4','.m4b')):
        t = MP4(p)
        m = {'\\xa9nam':'title','\\xa9ART':'artist','aART':'albumartist','\\xa9alb':'album','\\xa9day':'date','\\xa9gen':'genre','\\xa9wrt':'composer','\\xa9cmt':'comment'}
        for k, n in m.items():
            if t.get(k) and t[k][0]:
                out[n] = str(t[k][0])
        if t.tags and 'trkn' in t.tags and t.tags['trkn'][0]:
            out['tracknumber'] = t.tags['trkn'][0][0]
        if t.tags and 'disk' in t.tags and t.tags['disk'][0]:
            out['discnumber'] = t.tags['disk'][0][0]
        for suffix in ('Language',):
            tag = '----:com.apple.iTunes:' + suffix
            if t.get(tag) and t[tag][0]:
                out['language'] = str(t[tag][0])
    else:
        t = MP3(p)
        fmap = {'TIT2':'title','TPE1':'artist','TALB':'album','TPE2':'albumartist','TDRC':'date','TCON':'genre','TCOM':'composer','TEXT':'lyricist','TBPM':'bpm'}
        for k, n in fmap.items():
            if t.tags and k in t.tags and t.tags[k].text:
                out[n] = str(t.tags[k].text[0])
        if t.tags and 'TRCK' in t.tags:
            out['tracknumber'] = str(t.tags['TRCK'].text[0])
        if t.tags and 'TPOS' in t.tags:
            out['discnumber'] = str(t.tags['TPOS'].text[0])
        if t.tags:
            for k in t.tags.keys():
                if k.startswith('COMM'):
                    out['comment'] = str(t.tags[k].text[0]) if t.tags[k].text else ''
                    break
            for k in t.tags.keys():
                if k.startswith('TXXX'):
                    dd = t.tags[k]
                    dsc = (dd.desc or '').lower() if hasattr(dd, 'desc') else ''
                    if dsc == 'language':
                        out['language'] = str(dd.text[0]) if dd.text else ''
                        break
    print(json.dumps(out, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({'__err__': str(e)[:300]}, ensure_ascii=False))
`;

const PY_WRITE = `
import sys, json
p = sys.argv[1]
data = json.loads(sys.argv[2])
fields = data.get('fields') or {}
cover = data.get('cover')
low = p.lower()
errs = {}
def s(v):
    if v is None: return None
    v = str(v).strip()
    return v if v and v.lower() not in ('null','undefined','nan','none') else None
try:
    if low.endswith('.flac'):
        from mutagen.flac import FLAC, Picture
        t = FLAC(p)
        fl = {'title':'title','artist':'artist','album':'album','album_artist':'albumartist','year':'date','track':'tracknumber','disc':'discnumber','genre':'genre','language':'language','composer':'composer','lyricist':'lyricist','comment':'description','bpm':'bpm'}
        for fk, mk in fl.items():
            v = s(fields.get(fk))
            if fk == 'year' and v:
                v = v[:4] if v.isdigit() else v
            if v is not None:
                try: t[mk] = [v]
                except Exception as e: errs[fk]=str(e)
        for k in ('lyrics','lyrics_en','lyrics_zh'):
            if not fields.get(k): continue
            v = s(fields.get(k))
            if v is not None:
                try: t[k] = v
                except Exception as e: errs[k]=str(e)
        if cover:
            pic = Picture()
            with open(cover,'rb') as f: pic.data = f.read()
            ext = (cover.split('.')[-1] or 'png').lower()
            pic.mime = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp'}.get(ext,'image/jpeg')
            pic.type = 3
            t.add_picture(pic)
        t.save()
    elif low.endswith(('.m4a','.mp4','.m4b')):
        from mutagen.mp4 import MP4, MP4Cover
        t = MP4(p)
        m = {'title':'\\xa9nam','artist':'\\xa9ART','album_artist':'aART','album':'\\xa9alb','year':'\\xa9day','genre':'\\xa9gen','composer':'\\xa9wrt','comment':'\\xa9cmt'}
        for fk, mk in m.items():
            v = s(fields.get(fk))
            if v:
                try: t[mk] = [v]
                except Exception as e: errs[fk]=str(e)
        v = s(fields.get('track'))
        if v:
            try:
                cur = list(t.get('trkn', [(0,0)])[0]); cur[0] = int(v); t['trkn'] = [tuple(cur)]
            except Exception as e: errs['track']=str(e)
        v = s(fields.get('disc'))
        if v:
            try:
                cur = list(t.get('disk', [(0,0)])[0]); cur[0] = int(v); t['disk'] = [tuple(cur)]
            except Exception as e: errs['disc']=str(e)
        v = s(fields.get('language'))
        if v:
            try: t['----:com.apple.iTunes:Language'] = [v.encode('utf-8')]
            except Exception as e: errs['language']=str(e)
        v = s(fields.get('lyricist'))
        if v:
            try: t['----:com.apple.iTunes:LYRICIST'] = [v.encode('utf-8')]
            except Exception as e: errs['lyricist']=str(e)
        if cover:
            try:
                with open(cover,'rb') as f: data_ = f.read()
                t['covr'] = [MP4Cover(data_, imageformat=MP4Cover.FORMAT_JPEG if (cover.lower().split('.')[-1] in ('jpg','jpeg')) else MP4Cover.FORMAT_PNG)]
            except Exception as e: errs['cover']=str(e)
        t.save()
    else:
        from mutagen.mp3 import MP3
        from mutagen.id3 import TIT2, TPE1, TALB, TPE2, TDRC, TRCK, TPOS, TCON, TCOM, TEXT, COMM, TBPM, TXXX, APIC, USLT
        t = MP3(p)
        fmap = {'title':TIT2,'artist':TPE1,'album':TALB,'album_artist':TPE2,'genre':TCON,'composer':TCOM,'lyricist':TEXT}
        for fk, cls in fmap.items():
            v = s(fields.get(fk))
            if v:
                try: t.tags.add(cls(encoding=3, text=v))
                except Exception as e: errs[fk]=str(e)
        v = s(fields.get('year'))
        if v:
            try: t.tags.add(TDRC(encoding=3, text=v))
            except Exception as e: errs['year']=str(e)
        v = s(fields.get('track'))
        if v:
            try: t.tags.add(TRCK(encoding=3, text=v))
            except Exception as e: errs['track']=str(e)
        v = s(fields.get('disc'))
        if v:
            try: t.tags.add(TPOS(encoding=3, text=v))
            except Exception as e: errs['disc']=str(e)
        v = s(fields.get('bpm'))
        if v:
            try: t.tags.add(TBPM(encoding=3, text=v))
            except Exception as e: errs['bpm']=str(e)
        v = s(fields.get('comment'))
        if v:
            try: t.tags.add(COMM(encoding=3, lang='XXX', desc='', text=v))
            except Exception as e: errs['comment']=str(e)
        v = s(fields.get('language'))
        if v:
            try: t.tags.add(TXXX(encoding=3, desc='Language', text=v))
            except Exception as e: errs['language']=str(e)
        lv = fields.get('lyrics')
        if lv and str(lv).strip():
            try: t.tags.add(USLT(encoding=3, lang='XXX', desc='', text=str(lv)))
            except Exception as e: errs['lyrics']=str(e)
        if cover:
            try:
                with open(cover,'rb') as f: c_ = f.read()
                ext = (cover.split('.')[-1] or 'jpg').lower()
                mt = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp'}.get(ext,'image/jpeg')
                t.tags.add(APIC(encoding=3, mime=mt, type=3, desc='Cover', data=c_))
            except Exception as e: errs['cover']=str(e)
        t.save()
    print(json.dumps({'ok': True, 'errs': errs}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'errs': errs, 'msg': str(e)[:300]}, ensure_ascii=False))
`;

function runPy(script, args) {
  try {
    const res = execFileSync('python3', ['-c', script].concat(args), { timeout: 60000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    const txt = String(res || '').trim();
    return txt ? JSON.parse(txt) : {};
  } catch (e) {
    return { __err__: String(e.message || e).slice(0, 300) };
  }
}

// ---------- 公开接口 ----------
async function readTag(id) {
  id = safeId(id);
  const row = trackRow(id);
  if (!row || !row.file_path) throw new Error('本地曲库中未找到歌曲 ID=' + id);
  if (!fs.existsSync(row.file_path)) throw new Error('音频文件不存在: ' + row.file_path);
  const r = runPy(PY_READ, [row.file_path]);
  if (r.__err__ && !Object.keys(r).some(k => k !== '__err__')) throw new Error('读取内嵌标签失败: ' + r.__err__);
  return { id, filePath: row.file_path, tags: r };
}

async function writeTag(id, fields, cover) {
  id = safeId(id);
  const row = trackRow(id);
  if (!row || !row.file_path) throw new Error('本地曲库中未找到歌曲 ID=' + id);
  const filePath = row.file_path;
  if (!fs.existsSync(filePath)) throw new Error('音频文件不存在: ' + filePath);

  // 写前 SHA1 备份
  const bak = backupFile(filePath, id);

  // cover 解析：本地路径或 http(s) URL（URL 需下载到临时文件）
  let coverPath = null;
  if (cover && typeof cover === 'string' && cover.trim()) {
    coverPath = cover.trim();
    if (/^https?:\/\//i.test(coverPath)) {
      const buf = await (await require('node-fetch')(coverPath)).buffer().catch(() => null);
      if (!buf) throw new Error('封面下载失败: ' + coverPath.slice(0, 120));
      coverPath = path.join(require('os').tmpdir(), 'cover_' + crypto.randomBytes(6).toString('hex') + '.jpg');
      fs.writeFileSync(coverPath, buf);
    } else if (!fs.existsSync(coverPath)) {
      coverPath = null;
    }
  }

  // 写标签
  const payload = { fields: fields || {}, cover: coverPath || null };
  const r = runPy(PY_WRITE, [filePath, JSON.stringify(payload)]);
  try { if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch (e) {}
  if (!r.ok) throw new Error('写回内嵌标签失败: ' + (r.msg || r.__err__ || JSON.stringify(r.errs)));

  // 同步本地索引（仅克隆允许的字段；title/artist/album 变更时重算 norm 与 fingerprint）
  const f = fields || {};
  const upd = {};
  const cols = ['title','artist','album','album_artist','year','track','disc','genre','language','composer','lyricist','comment','bpm'];
  for (const c of cols) {
    if (f[c] !== undefined && f[c] !== null) upd[c] = String(f[c]).trim();
  }
  upd.updated_at = new Date().toISOString();
  if ('title' in upd || 'artist' in upd || 'album' in upd) {
    const t = upd.title !== undefined ? upd.title : (row.title || '');
    const a = upd.artist !== undefined ? upd.artist : (row.artist || '');
    const al = upd.album !== undefined ? upd.album : (row.album || '');
    const nt = localLibrary.normalize(t || '');
    const na = localLibrary.normalize(a || '');
    const nl = localLibrary.normalize(al || '');
    upd.norm_title = nt;
    upd.norm_artist = na;
    upd.norm_album = nl;
    upd.fingerprint = [nt, na, nl].join('|');
  }
  if (upd.year !== undefined && upd.year !== '') {
    const n = parseInt(upd.year, 10);
    upd.year = isNaN(n) ? null : n;
  }
  const setSql = Object.keys(upd).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE local_track SET ${setSql} WHERE id = ?`).run(...Object.values(upd), id);

  return { id, filePath, backup: bak || null, written: Object.keys(upd) };
}

async function backupInfo(id) {
  id = safeId(id);
  const row = trackRow(id);
  const dir = BAK_ROOT();
  const files = [];
  if (row && row.file_path) {
    const base = path.basename(row.file_path);
    const prefix = `${id}_`;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix) && f.endsWith(base)) {
          const p = path.join(dir, f);
          files.push({ file: f, size: fs.statSync(p).size, mtime: fs.statSync(p).mtime.toISOString() });
        }
      }
    } catch (e) {}
  }
  files.sort((a, b) => (a.mtime > b.mtime ? -1 : 1));
  return { id, backupDir: dir, count: files.length, files: files.slice(0, 10) };
}

module.exports = { readTag, writeTag, backupInfo };
