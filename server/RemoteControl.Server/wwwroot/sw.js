/* 轻量 PWA Service Worker：缓存静态资源以支持添加到主屏幕 */
const CACHE = 'rc-static-v11';
const ASSETS = ['./', './index.html', './css/style.css?v=20260909g', './js/ws.js?v=20260909g', './js/ui.js?v=20260909g', './js/main.js?v=20260909g', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      // 新版本接管后强制重载已打开页面，立即生效，避免停留在旧缓存页面
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((wins) => Promise.all(wins.map((w) => w.navigate(w.url).catch(() => {}))))
  );
});

// 页面导航：网络优先，失败回退缓存 —— 保证 index.html 更新即时生效，不被旧缓存拖住
// 静态资源：缓存优先；WebSocket 与其他请求直接走网络（不缓存）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname === '/ws') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
