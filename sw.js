// Hors ligne : sert les fichiers depuis le cache, et les met à jour en arrière-plan.
const CACHE = 'biblio-v4';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'sync.js', 'firebase-config.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Fichiers de l'appli + bibliothèque Firebase (pour démarrer hors ligne)
  if (u.origin !== location.origin && !u.href.startsWith('https://www.gstatic.com/firebasejs/')) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
