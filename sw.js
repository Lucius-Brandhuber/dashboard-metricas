/* Ergosphere — service worker.
   Um SW mal versionado serve app velho para sempre. Regras:
   - HTML/JS/CSS do app: NETWORK-FIRST (deploy novo aparece na hora; cache é só o fallback offline).
   - CDN (Chart.js, supabase-js): cache-first, são imutáveis por versão.
   - Nada de API do Supabase passa por aqui: dado nunca vem de cache. */
const VERSAO = 'ergosphere-v6';
/* os ?v= têm que bater com os do index.html, senão o fallback offline
   guarda uma URL que a página nunca pede */
const SHELL = [
  './',
  './index.html',
  './css/style.css?v=5',
  './js/app.js?v=5',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSAO);
    await c.addAll(SHELL).catch(() => {});
    await Promise.all(CDN.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;   // dado sempre da rede

  if (CDN.includes(req.url)) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }

  e.respondWith((async () => {
    try {
      const fresca = await fetch(req);
      if (fresca && fresca.status === 200 && url.origin === location.origin) {
        const c = await caches.open(VERSAO);
        c.put(req, fresca.clone());
      }
      return fresca;
    } catch (_) {
      const cacheada = await caches.match(req);
      if (cacheada) return cacheada;
      if (req.mode === 'navigate') return caches.match('./index.html');
      throw _;
    }
  })());
});
