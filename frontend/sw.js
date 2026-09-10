// Loop Music Player - Service Worker
// v2：导航请求（HTML）改为 network-first，避免旧 index.html 被长期缓存导致前端修复无法下发
const CACHE_NAME = 'loop-pwa-v2';
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
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] 缓存静态资源');
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
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

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 页面文档（导航请求）：network-first —— 保证每次部署后用户打开即可拿到最新
  // 的 index.html 及其引用的新构建产物；离线时回退到缓存
  const accept = event.request.headers.get('accept') || '';
  const isNavigation = event.request.mode === 'navigate' || accept.includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request)
          .then((cached) => cached || caches.match('/?home'))
          .then((cached) => cached || new Response('', { status: 504, statusText: 'Offline' }))
      )
    );
    return;
  }

  // Static assets: cache-first（构建产物带内容 hash，URL 变化即天然失效，可安全长缓存）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/?home'));
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
