const CACHE = 'tradelens-v2';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Datos en vivo del servidor: nunca cachear
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// ── PUSH: el servidor envía el aviso y el sistema operativo despierta este service worker (app cerrada) ──
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'TradeLens';
  const opts = {
    body: d.body || '',
    tag: d.tag || 'tradelens',
    renotify: true,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: d.url || './index.html' }
  };
  // En iPhone cada push DEBE mostrar una notificación; por eso siempre se muestra.
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './index.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        try { await c.focus(); if ('navigate' in c) await c.navigate(target); } catch (_) {}
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
