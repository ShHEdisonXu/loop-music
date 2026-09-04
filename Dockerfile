# loop-app: 前端 nginx + download-service 后端 + 双 ncm-api 网关 四合一镜像
# 基于 node:24-slim（Debian），apt 走 USTC 国内源
# ncm-api 自官方 moefurina/ncm-api（Alpine）整体 COPY 入 /app/ncm-api（纯 JS 依赖，无 ABI 问题）

FROM moefurina/ncm-api:latest AS ncmapi

FROM node:24-slim

RUN set -eux; \
    sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list; \
    apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg nginx supervisor curl \
    && rm -rf /var/lib/apt/lists/*

# ---- 后端（dockerfile 内由 package-lock.json 执行 npm ci 源码安装）----
WORKDIR /app
COPY backend/ /app/
RUN npm ci --no-audit --no-fund \
    && rm -rf /app/data /app/diag*.js /app/*.tgz /app/*.log /app/.health

# ---- ncm-api（官方镜像 /app 整体拷入，含 node_modules，纯 JS 无 ABI 问题）----
COPY --from=ncmapi /app /app/ncm-api

# ---- 前端 ----
RUN rm -rf /usr/share/nginx/html/*
COPY frontend/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html

# ---- nginx 配置：/api 代理到容器内 127.0.0.1:3001 ----
RUN rm -f /etc/nginx/sites-enabled/default
COPY nginx/loop.conf /etc/nginx/conf.d/loop.conf
RUN chmod 644 /etc/nginx/conf.d/loop.conf

# ---- supervisor：四进程启动 双ncm-api + 后端 + nginx ----
COPY supervisor/loop.conf /etc/supervisor/conf.d/loop.conf
RUN chmod 644 /etc/supervisor/conf.d/loop.conf

EXPOSE 80 3001 23236 23240
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1/api/health || exit 1

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
