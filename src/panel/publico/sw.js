// Service worker del panel: permite instalarlo como app y abrirlo aunque la señal falle.
// Solo guarda la "cáscara" (página, estilos, íconos). Los datos (/panel/api) NUNCA se
// guardan: siempre vienen frescos del facturador. El servidor pone en VERSION una huella
// de los archivos; si cambia, el navegador baja la versión nueva y el panel lo avisa.
'use strict';
const VERSION = '__VERSION__';
const CACHE = `panel-${VERSION}`;
const CASCARA = ['/panel', '/panel/app.js', '/panel/estilo.css', '/panel/icono-192.png', '/panel/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CASCARA)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// El panel pide "actualizar" cuando la persona toca el aviso de versión nueva.
self.addEventListener('message', (e) => {
  if (e.data === 'actualizar') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/panel') || url.pathname.startsWith('/panel/api')) return;
  // Primero la red (siempre lo último); sin señal, lo guardado.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && CASCARA.includes(url.pathname)) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/panel'))),
  );
});
