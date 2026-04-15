// MyEsther Service Worker (Caching Engine)
const CACHE_NAME = 'myesther-smart-cache-v24';

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/js/urya_brain.js'
  // WebSockets (wss://) are not cached, only static PWA core files
];

self.addEventListener('install', (event) => {
  console.log('[PWA] Service Worker Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[PWA] Pre-caching static assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[PWA] Service Worker Activated');
  // Cleanup old caches
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[PWA] Deleting old cache', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Cache-First strategy for static assets
self.addEventListener('fetch', (event) => {
  // Ignore API or socket requests
  if (event.request.url.includes('/socket.io/')) return;
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Optionnel : Mettre en cache dynamique ici si nécessaire
        return networkResponse;
      }).catch(() => {
        // L'utilisateur est complétement déconnecté et demande quelque chose non-caché
        // (ex: une image googleusercontent) -> La PWA survivra via les assets vitaux
      });
    })
  );
});
