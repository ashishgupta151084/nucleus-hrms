// Nucleus HRMS service worker.
// Always loads the latest deployed app from the network; the cache is used only
// when the phone is offline. Old caches from earlier versions are deleted and
// open tabs are refreshed once, so staff never get stuck on an old version.
const CACHE = 'nucleus-hrms-runtime';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    const tabs = await self.clients.matchAll({ type: 'window' });
    tabs.forEach((t) => t.navigate(t.url));
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Firebase / Google traffic

  event.respondWith((async () => {
    try {
      // Pages are always fetched fresh; hashed JS/CSS files can use the normal browser cache.
      const res = await fetch(req, req.mode === 'navigate' ? { cache: 'no-store' } : undefined);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('/')) || (await caches.match('/index.html'));
      throw e;
    }
  })());
});
