// Service Worker — Mi Coach
// Estrategia: network-first para los archivos de la app, cache-first para assets fijos.
const CACHE = 'mi-coach-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/dexie@4.0.8/dist/dexie.min.js'
];

// Instalación: precachea el shell para que la app funcione offline
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Activación: borra los caches de versiones anteriores
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch:
//  - Archivos de la app (HTML/CSS/JS/JSON) -> network-first: siempre intenta traer
//    lo último; si no hay conexión, usa la última copia guardada.
//  - Resto (íconos, librería Dexie) -> cache-first: casi nunca cambian.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const esArchivoApp =
    url.origin === self.location.origin &&
    /\.(html|css|js|json)$|\/$/.test(url.pathname);

  if (esArchivoApp) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() =>
          caches.match(e.request).then((cached) => cached || caches.match('./index.html'))
        )
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        });
      })
    );
  }
});

// Soporte futuro para Web Push (fase 2)
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Mi Coach', body: 'Tenés algo pendiente' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png'
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow('./'));
});
