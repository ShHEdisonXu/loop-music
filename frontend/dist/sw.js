// Loop Music Player - Service Worker
// v5：只接管「应用外壳」（导航 HTML / 构建产物 / 图标）。
// 关键修复：/api/ 一律不进 SW —— 此前把音频流(/api/library/audio)、封面(/api/library/meta/cover)
// 与每秒轮询接口的响应全部 clone + cache.put，导致 SW 内缓冲大响应、Cache Storage 写入风暴，
// 手机上快速切换页面即卡死白屏。接口与媒体现在全部交还浏览器原生处理。
const CACHE_NAME = 'loop-pwa-v5';
const STATIC_ASSETS = [
  '/',
  '/?home',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches（含旧版写入的大量音频/封面，一并释放）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: 只缓存应用外壳，其余全部放行
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 接口请求（含音频流、封面图、轮询接口）不接管：避免 clone/cache.put 造成内存与磁盘压力
  if (url.pathname.startsWith('/api/')) return;
  // 媒体与图片、Range 请求同样交还浏览器
  if (req.headers.has('range')) return;
  if (req.destination === 'audio' || req.destination === 'video' || req.destination === 'image') return;

  const accept = req.headers.get('accept') || '';
  const isNavigation = req.mode === 'navigate' || accept.includes('text/html');

  // 页面文档（导航请求）：network-first —— 保证每次部署后用户打开即可拿到最新构建；
  // 仅在网络不可用时回退到缓存
  if (isNavigation) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() =>
        caches.match(req)
          .then((cached) => cached || caches.match('/?home'))
          .then((cached) => cached || new Response('', { status: 504, statusText: 'Offline' }))
      )
    );
    return;
  }

  // 构建产物 / 清单 / 图标：cache-first（构建产物带内容 hash，URL 变化即天然失效）
  const cacheable = url.pathname.startsWith('/assets/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.svg' ||
    /^\/icon-\d+\.png$/.test(url.pathname);
  if (!cacheable) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});

// Push notifications (if service worker supports it)
if (self.registration.pushManager) {
  self.addEventListener('push', (event) => {
    const data = event.data?.json() || { title: 'Loop', body: '新动态' };
    event.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
      })
    );
  });
}
