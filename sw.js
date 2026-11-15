const CACHE = 'tradelens-v4';
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

// Presentación uniforme: título = evento (el nombre de la app ya lo muestra el sistema), cuerpo limpio y sin emojis sueltos.
const EMO = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const KINDS = {
  test:  { title: 'Conexión verificada',          body: 'Tus avisos están activos en este dispositivo.' },
  wd:    { title: 'Retiro disponible',            body: 'Ya puedes solicitar tu retiro.' },
  dd:    { title: 'Límite de drawdown superado',  body: 'La caída de hoy superó tu límite diario.' },
  coach: { title: 'Subiste de nivel',             body: 'Tu Risk Scaling avanzó al siguiente nivel.' }
};
// Ordena el texto que llega del servidor: mayúscula inicial, espacios limpios y punto final.
function tlTidy(t) {
  t = String(t || '').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  if (!t) return '';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(t) ? t : t + '.';
}
function tlKind(d, text) {
  const key = ((d.tag || '') + ' ' + (d.kind || '')).toLowerCase();
  if (/test|prueba/.test(key)) return 'test';
  if (/\bdd\b|drawdown/.test(key)) return 'dd';
  if (/\bwd\b|wd-|withdraw|retiro/.test(key)) return 'wd';
  if (/coach|level|nivel|risk/.test(key)) return 'coach';
  const t = text.toLowerCase();
  if (/prueba/.test(t)) return 'test';
  if (/drawdown/.test(t)) return 'dd';
  if (/retiro|objetivo/.test(t)) return 'wd';
  if (/coach|nivel|risk scaling/.test(t)) return 'coach';
  return '';
}
function tlPolish(d) {
  let title = String(d.title || '').replace(EMO, '').replace(/^\s*TradeLens\s*[—–·:-]*\s*/i, '').trim();
  let body = String(d.body || '').replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200D]+/u, '').replace(/\s{2,}/g, ' ').trim();
  const kind = tlKind(d, title + ' ' + body), k = KINDS[kind];
  if (k) {
    const generic = !body || /prueba|funciona/i.test(body);
    title = k.title;
    body = (k.title === KINDS.test.title || generic) ? k.body : tlTidy(body);   // con datos reales del servidor se conservan
  } else body = tlTidy(body);
  return { title: title || 'TradeLens', body, kind };
}

// ── PUSH: el servidor envía el aviso y el sistema operativo despierta este service worker (app cerrada) ──
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const p = tlPolish(d);
  const opts = {
    body: p.body,
    tag: d.tag || 'tradelens',
    renotify: true,
    lang: 'es',
    icon: p.kind ? './icon-' + p.kind + '.png' : './icon-192.png',   // imagen grande a la derecha: un icono propio por tipo de aviso
    badge: './badge-96.png',         // logo monocromo junto al nombre de la app (solo usa el canal alfa)
    vibrate: [90, 50, 90],
    timestamp: Date.now(),
    data: { url: d.url || './index.html' }
  };
  // En iPhone cada push DEBE mostrar una notificación; por eso siempre se muestra.
  e.waitUntil(self.registration.showNotification(p.title, opts));
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

// ── Renovación automática de la suscripción push (sin abrir la web ni iniciar sesión) ──
const TL_DB = 'tl-push', TL_ST = 'kv';
const tlDb = () => new Promise((ok, no) => { const r = indexedDB.open(TL_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(TL_ST); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const tlGet = k => tlDb().then(db => new Promise(ok => { const q = db.transaction(TL_ST).objectStore(TL_ST).get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); })).catch(() => null);
const tlSet = (k, v) => tlDb().then(db => new Promise(ok => { const tx = db.transaction(TL_ST, 'readwrite'); tx.objectStore(TL_ST).put(v, k); tx.oncomplete = () => ok(true); tx.onerror = () => ok(false); })).catch(() => false);
const b64ToU8 = b => { const raw = atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
async function tlResubscribe(oldEp) {
  try {
    const cfg = await tlGet('cfg'); if (!cfg || !cfg.publicKey || !cfg.server) return;
    const sub = (await self.registration.pushManager.getSubscription()) || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.publicKey) });
    const r = await fetch(cfg.server + '/push/resubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint: oldEp || cfg.endpoint || '', deviceId: cfg.deviceId || '', subscription: sub.toJSON() }) });
    if (r.ok) await tlSet('cfg', Object.assign({}, cfg, { endpoint: sub.endpoint }));
  } catch (_) {}
}
self.addEventListener('pushsubscriptionchange', e => e.waitUntil(tlResubscribe(e.oldSubscription && e.oldSubscription.endpoint)));
self.addEventListener('message', e => {
  const m = e.data || {};
  if (m.type === 'tl-push-cfg') e.waitUntil(tlSet('cfg', { server: m.server, publicKey: m.publicKey, deviceId: m.deviceId, endpoint: m.endpoint }));
  else if (m.type === 'tl-push-clear') e.waitUntil(tlSet('cfg', null));
});
