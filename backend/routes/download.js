// 下载路由
const express = require('express');
const router = express.Router();
const downloader = require('../services/downloader');
const netease = require('../services/netease');
const config = require('../config');

// 下载单曲
router.post('/downloadSong', (req, res) => {
  try {
    const { id, name, artistName, artistids, albumName, albumid, plugName, brType, downloadFormat, audioBook, gd, url_id, lyric_id, pic_id, pic, source, external, backendBase, backendProtocol } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少歌曲ID' });
    const song = {
      id: String(id),
      musicName: name || '未知歌曲',
      artistName: artistName || '未知歌手',
      albumName: albumName || '未知专辑',
      plugName: plugName || 'netease',
      brType: brType || config.defaultBrType,
      audioBook: audioBook ? 1 : 0,
      // GD 聚合下载字段：存在 url_id/source 即视为 GD 歌曲，取链走 GD types=url 换源
      gd: gd ? 1 : (url_id ? 1 : 0),
      url_id: url_id || '',
      lyric_id: lyric_id || '',
      pic_id: pic_id || pic || '',
      sourcePlatform: source || '',
      // 外部自定义后端字段（填写地址即用的可插拔后端）
      external: external ? 1 : 0,
      backendBase: backendBase || '',
      backendProtocol: backendProtocol || ''
    };
    const result = downloader.enqueueDownload(song, 'search');
    if (result.status === 'queued-dedup') {
      res.json({ code: 200, msg: '该歌曲已在下载队列中，不重复添加', data: { dedup: true } });
    } else if (result.status === 'duplicate') {
      res.json({ code: 200, msg: '歌曲已下载过，跳过', data: { duplicate: true, filePath: result.filePath } });
    } else if (result.status === 'pending') {
      res.json({ code: 200, msg: '本地已存在相同歌曲（元数据匹配），已移至待处理栏', data: { pending: true, pendingId: result.pendingId, matchedFile: result.matchedFile } });
    } else {
      res.json({ code: 200, msg: '已加入下载队列', data: { taskId: result.taskId } });
    }
  } catch (e) {
    res.json({ code: 500, msg: '下载失败: ' + e.message.slice(0, 100) });
  }
});

// 下载专辑内所有歌曲
router.post('/downloadAlbum', async (req, res) => {
  try {
    const { id, albumName, artistName, brType, downloadFormat } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少专辑ID' });
    const detail = await netease.getAlbumDetail(id);
    const songs = detail.musics.map(m => ({
      id: m.id,
      musicName: m.musicName,
      artistName: m.musicArtists,
      albumName: albumName || m.musicAlbum,
      plugName: 'netease',
      brType: brType || config.defaultBrType
    }));
    const result = downloader.enqueueBatch(songs, 'album');
    res.json({ code: 200, msg: `已加入 ${result.added} 首（跳过 ${result.dup} 首已下载，${result.pending} 首已移至待处理）`, data: result });
  } catch (e) {
    res.json({ code: 500, msg: '下载专辑失败: ' + e.message.slice(0, 100) });
  }
});

// 下载歌手全部专辑（遍历专辑 → 专辑内全部歌曲入队）
router.post('/downloadArtistAlbum', async (req, res) => {
  try {
    const { id, artistName, brType } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少歌手ID' });
    const info = await netease.getArtistInfo(id);
    const albums = info.albums || [];
    if (!albums.length) return res.json({ code: 200, msg: '该歌手暂无专辑可下载', data: { added: 0, dup: 0, albums: 0 } });
    let added = 0, dup = 0, pending = 0;
    for (const alb of albums) {
      try {
        const detail = await netease.getAlbumDetail(alb.albumId);
        const songs = (detail.musics || []).map(m => ({
          id: m.id,
          musicName: m.musicName,
          artistName: m.musicArtists || artistName || '未知歌手',
          albumName: m.musicAlbum || alb.albumName || '未知专辑',
          plugName: 'netease',
          brType: brType || config.defaultBrType
        }));
        const result = downloader.enqueueBatch(songs, 'album');
        added += result.added; dup += result.dup; pending += result.pending;
      } catch (e) {
        console.error('歌手专辑下载失败 album=' + alb.albumId + ': ' + e.message);
      }
    }
    const name = info.musicArtistsName || artistName || '该歌手';
    res.json({ code: 200, msg: `「${name}」全部专辑已加入下载队列：${added} 首（跳过 ${dup} 首已下载，${pending} 首已移至待处理）`, data: { added, dup, pending, albums: albums.length } });
  } catch (e) {
    res.json({ code: 500, msg: '下载歌手失败: ' + e.message.slice(0, 100) });
  }
});

// 文本解析下载（简化：按行搜索下载）
router.post('/downloadParserText', async (req, res) => {
  try {
    const { text, brType } = req.body || {};
    if (!text) return res.json({ code: 500, msg: '文本不能为空' });
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    let added = 0;
    for (const line of lines) {
      // 尝试 "歌名 - 歌手" 或 "歌名" 格式
      const [name, artist] = line.split('-').map(s => s.trim());
      const result = await netease.searchSong(name, 1, 1);
      if (result.records.length > 0) {
        const r = result.records[0];
        const song = {
          id: r.id,
          musicName: r.musicName,
          artistName: artist || r.musicArtists,
          albumName: r.musicAlbum,
          plugName: 'netease',
          brType: brType || config.defaultBrType
        };
        const ret = downloader.enqueueDownload(song, 'text');
        if (ret.status === 'queued') added++;
      }
    }
    res.json({ code: 200, msg: `已加入 ${added} 首`, data: { added } });
  } catch (e) {
    res.json({ code: 500, msg: '文本解析失败: ' + e.message.slice(0, 100) });
  }
});

// 歌单链接解析并下载
router.post('/downloadParserUrl', async (req, res) => {
  try {
    const { url, isAudioBook, bookName, artist, brType } = req.body || {};
    if (!url) return res.json({ code: 500, msg: '歌单链接不能为空' });
    const info = await netease.parsePlaylistUrl(url);
    const tracks = await netease.getPlaylistTracks(info.id);
    const songs = tracks.map(t => ({
      id: t.id,
      musicName: t.name,
      artistName: isAudioBook ? (artist || t.artists) : t.artists,
      albumName: isAudioBook ? (bookName || t.album) : t.album,
      plugName: 'netease',
      brType: brType || config.defaultBrType,
      audioBook: isAudioBook ? 1 : 0
    }));
    const result = downloader.enqueueBatch(songs, 'playlist');
    // 返回已识别歌曲信息（前端 V3ParserPlaylist 展示用）
    const recognized = songs.map(s => ({
      downloadMusicname: s.musicName,
      downloadArtistname: s.artistName,
      downloadAlbumname: s.albumName,
      downloadBrType: s.brType
    }));
    res.json({ code: 200, msg: `歌单「${info.name}」已加入 ${result.added} 首（跳过 ${result.dup} 首，${result.pending} 首已移至待处理）`, data: recognized });
  } catch (e) {
    res.json({ code: 500, msg: '歌单解析失败: ' + e.message.slice(0, 100) });
  }
});

// 歌单/榜单 ID 直接下载（网易云）
router.post('/downloadPlaylistById', async (req, res) => {
  try {
    const { id, brType } = req.body || {};
    if (!id) return res.json({ code: 500, msg: '缺少歌单ID' });
    const detail = await netease.getPlaylistDetail(id);
    const songs = (detail.tracks || []).map(t => ({
      id: t.id,
      musicName: t.name,
      artistName: t.artists,
      albumName: t.album,
      plugName: 'netease',
      brType: brType || config.defaultBrType
    }));
    const result = downloader.enqueueBatch(songs, 'playlist');
    res.json({ code: 200, msg: `歌单「${detail.name}」已加入 ${result.added} 首（跳过 ${result.dup} 首，${result.pending} 首已移至待处理）`, data: result });
  } catch (e) {
    res.json({ code: 500, msg: '歌单下载失败: ' + e.message.slice(0, 100) });
  }
});

module.exports = router;
