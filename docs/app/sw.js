/* App de choferes: guarda la app para que abra sin señal. Primero intenta la red (para tener
   siempre la última versión) y, si no hay, usa la copia guardada. Los datos (Firebase) no pasan por acá. */
const CACHE = 'choferes-lt-1.8.1';
const BASICO = ['./', './index.html', './app.js', './optimo.js', './app.css', './manifest.webmanifest', './icono-192.png',
  '../lt-firebase.js', '../firebase-config.js', '../vendor/leaflet/leaflet.js', '../vendor/leaflet/leaflet.css'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICO)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
