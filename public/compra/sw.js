// Keeps the purchase capture page loadable when the wifi drops. Network first, so a
// new deploy is picked up the moment there is a connection; the cached copy is
// only the fallback. API calls are never cached.
const CACHE = 'compra-shell-v1';
const SHELL = ['/compra/', '/compra/app.js', '/compra/style.css', '/compra/normalize.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/compra/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('/compra/')))
  );
});
