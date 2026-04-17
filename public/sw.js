const CACHE='nucleus-hrms-v1';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  if(e.request.url.includes('firestore')||e.request.url.includes('firebase'))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));
});
