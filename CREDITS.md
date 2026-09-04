# 致谢声明（Credits）

## GD 音乐台（GD Music）

本项目作为自建音乐下载工具，其音源能力之一来自 GD 音乐台开放的音乐聚合 API，特此致以诚挚感谢。

- **服务方**：GD 音乐台（GD Music）
- **API 入口**：`https://music.gdstudio.org/api.php`
- **官方频道**：<https://t.me/gdstudio_music>

本项目的后端通过 `backend/services/gd.js`、`backend/services/gd_sign.js` 等模块调用 GD 音乐台开放的搜索、播放地址、歌词等接口，并对部分曲目提供 joox 子源取链能力；前端聚合换源播放亦依赖该 API 提供跨平台取链。GD 音乐台接口为本项目提供了重要、稳定且免费的音源支持。

**再次感谢 GD 音乐台的开发与维护者为音乐工具生态所做的贡献。**
