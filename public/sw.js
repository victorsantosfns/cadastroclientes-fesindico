// Service worker simples — cache do "app shell" (a página, os ícones) pra
// abrir rápido/funcionar mesmo com wifi instável no estande. NÃO cacheia
// respostas de API (/api/...) — CNPJ e envio de cadastro sempre precisam
// ser em tempo real, nunca servidos do cache.
// 23/09/2026: bump pra v2 — força o SW a reinstalar e descartar o cache
// antigo em quem já tinha o app aberto antes das 3 perguntas novas do
// cadastro (evento é 24/09, sem essa troca a 1ª abertura pós-deploy
// mostraria a versão desatualizada até a 2ª abertura).
const CACHE = 'fesindico-v2';
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
