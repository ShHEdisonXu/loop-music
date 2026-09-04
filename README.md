---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0db9335e44ec2ddef396a5334940da03_63001625a82711f19281525400dcc5b3
    ReservedCode1: cl+vXxdwatMENEN00yDmfByWTyFib5fMruQwl59iTZ3eqzH/uBaEF/LCjxlIcpsz7pb2KZBhQezvVC3wJTL+2dSUpkh7TdrFiw5xyvHXQ8gfhH8laqktGyQmVLnAH6Ql6fibr662aIHw896weHrsXvtK3633qjV6cF6ZiLU3j5Hw5F8IiQmRJDUCUFk=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0db9335e44ec2ddef396a5334940da03_63001625a82711f19281525400dcc5b3
    ReservedCode2: cl+vXxdwatMENEN00yDmfByWTyFib5fMruQwl59iTZ3eqzH/uBaEF/LCjxlIcpsz7pb2KZBhQezvVC3wJTL+2dSUpkh7TdrFiw5xyvHXQ8gfhH8laqktGyQmVLnAH6Ql6fibr662aIHw896weHrsXvtK3633qjV6cF6ZiLU3j5Hw5F8IiQmRJDUCUFk=
---

# Loop 音乐下载工具（四合一单镜像）

前端（Vue/Vite 静态页）+ 自研 download-service 后端 + 双网易云 ncm-api 网关（热备 failover）
整合进**一个容器**（supervisord 管理 nginx / backend / 双 ncm-api 四进程）。

> 镜像通过 GitHub Actions 自动构建并发布至 **GHCR**，任何人可直接 compose 拉取使用。

## 一键部署

```yaml
services:
  loop-app:
    image: ghcr.io/shhedisonxu/loop-music
    container_name: loop-app
    restart: unless-stopped
    ports:
      - "23238:80"
      - "23237:3001"
      - "23236:23236"
      - "23240:23240"
    environment:
      - NCM_API_BASE=http://127.0.0.1:23236,http://127.0.0.1:23240
      - MUSIC_ROOT=/Music
    volumes:
      - ./Music:/Music
      - ./loop-data:/app/data
```

```bash
mkdir -p ./Music ./loop-data
docker compose up -d
```

浏览器打开 `http://<主机IP>:23238`。后端鉴权口令默认 `loop123`，
部署后请在页面「设置」中**立即修改**；网易云 Cookie 放入 `./loop-data/ncm_cookie.txt`。

## 端口

| 端口 | 用途 |
|------|------|
| 23238 | 网页入口（nginx :80） |
| 23237 | 后端 API（:3001） |
| 23236 / 23240 | ncm-api 网关双实例 |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `NCM_API_BASE` | `http://127.0.0.1:23236,http://127.0.0.1:23240` | ncm-api 网关地址（逗号分隔多网关热备） |
| `MUSIC_ROOT` | `/Music` | 音乐库根目录（容器内） |

## 音源

- 网易云（双网关热备 /cloudsearch）
- GD 音乐台聚合源（joox 子源）

## 本地构建/开发

```bash
docker build -t loop-app:dev .
docker compose up -d
```

依赖在构建时由 `package-lock.json` 经 `npm ci` 安装，无需提交 node_modules。
基础镜像依赖 `moefurina/ncm-api:latest`（第三方开源网易云 API 网关）与 `node:24-slim`。

## License

[MIT](LICENSE)
*（内容由AI生成，仅供参考）*
