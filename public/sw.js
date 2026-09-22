// Service worker simples — cache do "app shell" (a página, os ícones) pra
// abrir rápido/funcionar mesmo com wifi instável no estande. NÃO cacheia
// respostas de API (/api/...) — CNPJ e envio de cadastro sempre precisam
// ser em tempo real, nunca servidos do cache.
const CACHE = 'fesindico-v1';
const ARQUIVOS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  ev.respondWith(
    caches.match(ev.request).then((resposta) => {
      const buscarRede = fetch(ev.request)
        .then((r) => {
          if (r && r.ok) caches.open(CACHE).then((cache) => cache.put(ev.request, r.clone()));
          return r;
        })
        .catch(() => resposta);
      return resposta || buscarRede;
    })
  );
});
