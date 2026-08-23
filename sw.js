// SEYMUR13 PRO — minimal service worker (PWA tələbi üçün)
// Bu sadəcə app-i "install olunabilən" edir; canlı data hər zaman şəbəkədən (API) gəlir.
const CACHE_NAME = 'seymur13-shell-v1';
const SHELL_FILES = ['./index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Şəbəkə əvvəlcə (canlı qiymət/siqnal data-sı köhnəlməməlidir); yalnız şəbəkə yoxdursa cache-dən qayıt.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
