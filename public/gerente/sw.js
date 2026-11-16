// Keeps the Gerente screen loadable when the wifi drops. Network first, so a
// new deploy is picked up the moment there is a connection; the cached copy is
// only the fallback. API calls are never cached.
const CACHE = 'gerente-shell-v6';
const SHELL = ['/gerente/', '/gerente/app.js', '/gerente/style.css', '/gerente/jsQR.js', '/qr-enhance.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !(url.pathname.startsWith('/gerente/') || url.pathname === '/qr-enhance.js')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('/gerente/')))
  );
});
