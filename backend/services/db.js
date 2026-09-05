// SQLite 存储：下载任务 + 歌单监控（使用 Node 内置 node:sqlite，无需原生编译）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// 确保 data 目录存在
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);

// 下载任务表
db.exec(`
CREATE TABLE IF NOT EXISTS download_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT,
  music_name TEXT,
  artist_name TEXT,
  album_name TEXT,
  plug_name TEXT DEFAULT 'netease',
  br_type TEXT,
  audio_book INTEGER DEFAULT 0,
  download_status TEXT DEFAULT 'waiting',
  download_msg TEXT DEFAULT '',
  download_time TEXT,
  download_update_time TEXT,
  file_path TEXT,
  source TEXT DEFAULT 'search'
);
`);

// 歌单监控表
db.exec(`
CREATE TABLE IF NOT EXISTS monitor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plug_name TEXT DEFAULT 'netease',
  type TEXT,
  enabled TEXT DEFAULT '1',
  target_id TEXT,
  target_name TEXT,
  target_url TEXT,
  target_count INTEGER DEFAULT 0,
  target_desc TEXT,
  target_cover TEXT,
  last_scan TEXT
);
`);

// download_task 补 GD 下载字段（旧库迁移：缺列则 ALTER 增加）
(function migrateTaskGd() {
  try {
    const cols = db.prepare('PRAGMA table_info(download_task)').all().map(c => c.name);
    const adds = [
      ['gd', "INTEGER DEFAULT 0"],
      ['url_id', "TEXT DEFAULT ''"],
      ['lyric_id', "TEXT DEFAULT ''"],
      ['pic_id', "TEXT DEFAULT ''"],
      ['source_platform', "TEXT DEFAULT ''"],
      ['external', "INTEGER DEFAULT 0"],
      ['backend_base', "TEXT DEFAULT ''"],
      ['backend_protocol', "TEXT DEFAULT ''"]
    ];
    for (const [name, def] of adds) {
      if (!cols.includes(name)) {
        db.exec(`ALTER TABLE download_task ADD COLUMN ${name} ${def}`);
        console.log(`[db] download_task 增加列: ${name}`);
      }
    }
  } catch (e) {
    console.warn('[db] download_task 迁移失败：' + e.message);
  }
})();

// 已下载去重表（song_id + br_type 唯一）
db.exec(`
CREATE TABLE IF NOT EXISTS downloaded (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT,
  br_type TEXT,
  file_path TEXT,
  music_name TEXT,
  artist_name TEXT,
  album_name TEXT,
  created_at TEXT,
  UNIQUE(song_id, br_type)
);
`);

// 本地曲库元数据索引表（扫描 /vol4/1000/Music 读取音频内嵌标签）
db.exec(`
CREATE TABLE IF NOT EXISTS local_track (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT UNIQUE,
  title TEXT,
  artist TEXT,
  album TEXT,
  album_artist TEXT,
  duration REAL DEFAULT 0,
  norm_title TEXT,
  norm_artist TEXT,
  norm_album TEXT,
  fingerprint TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_fp ON local_track(fingerprint);
CREATE INDEX IF NOT EXISTS idx_local_title_artist ON local_track(norm_title, norm_artist);
`);

// 待处理重复项表（元数据识别命中，等待用户决定）
// 记录「本地已有文件」与「待下载文件」双方对比信息
db.exec(`
CREATE TABLE IF NOT EXISTS pending_dup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT,
  music_name TEXT,
  artist_name TEXT,
  album_name TEXT,
  br_type TEXT,
  -- 待下载侧
  remote_file_name TEXT,
  remote_bits TEXT,
  remote_format TEXT,
  source TEXT DEFAULT 'search',
  -- 本地匹配侧
  matched_file_path TEXT,
  local_file_name TEXT,
  local_size INTEGER DEFAULT 0,
  local_bit_rate INTEGER DEFAULT 0,
  local_format TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_dup(status);
`);

// 旧版 pending_dup 缺对比字段时迁移：重建表（空表或可接受重建）
(function migratePending() {
  try {
    const cols = db.prepare('PRAGMA table_info(pending_dup)').all().map(c => c.name);
    if (!cols.includes('remote_file_name')) {
      db.exec('DROP TABLE pending_dup');
      db.exec(`
        CREATE TABLE pending_dup (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          song_id TEXT,
          music_name TEXT,
          artist_name TEXT,
          album_name TEXT,
          br_type TEXT,
          remote_file_name TEXT,
          remote_bits TEXT,
          remote_format TEXT,
          source TEXT DEFAULT 'search',
          matched_file_path TEXT,
          local_file_name TEXT,
          local_size INTEGER DEFAULT 0,
          local_bit_rate INTEGER DEFAULT 0,
          local_format TEXT,
          status TEXT DEFAULT 'pending',
          created_at TEXT,
          resolved_at TEXT
        );
      `);
      console.log('[db] pending_dup 表结构已迁移（新增本地/待下载对比字段）');
    }
  } catch (e) {
    console.warn('[db] pending_dup 迁移失败：' + e.message);
  }
})();

// 文件大小相关列迁移：download_task.file_size（任务/待下载列表显示）、pending_dup.remote_size（查重页待下载侧实际大小）
(function migrateFileSize() {
  try {
    const tcols = db.prepare('PRAGMA table_info(download_task)').all().map(c => c.name);
    if (!tcols.includes('file_size')) {
      db.exec('ALTER TABLE download_task ADD COLUMN file_size INTEGER DEFAULT 0');
      console.log('[db] download_task 增加列: file_size');
    }
    const pcols = db.prepare('PRAGMA table_info(pending_dup)').all().map(c => c.name);
    if (!pcols.includes('remote_size')) {
      db.exec('ALTER TABLE pending_dup ADD COLUMN remote_size INTEGER DEFAULT 0');
      console.log('[db] pending_dup 增加列: remote_size');
    }
  } catch (e) {
    console.warn('[db] file_size 迁移失败：' + e.message);
  }
})();

module.exports = db;
