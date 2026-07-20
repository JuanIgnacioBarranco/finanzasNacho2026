// Service worker del tablero — mejora #5, tarea 4 (PWA offline).
// Ver .superpowers/sdd/task-4-brief.md para la decisión de producto (network-first,
// sin aviso de "hay version nueva").
//
// OJO rutas: el sitio se sirve desde un SUBDIRECTORIO de GitHub Pages
// (https://juanignaciobarranco.github.io/finanzasNacho2026/), nunca desde la raíz del
// dominio. Todo acá abajo es relativo a la ubicación de este archivo.

// Nombre de cache VERSIONADO: subí el numero cuando cambien los estaticos precacheados
// para que `activate` tire la version vieja y no quede basura pisando el deploy nuevo.
const CACHE_NAME = 'cnf-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// APIs de precios: el SW NUNCA las cachea. Ya tienen su propia cache en localStorage
// (cnf_prices, ver loadPrices() en index.html); si el SW tambien guardara sus
// respuestas, quedarian dos capas de "ultimo precio conocido" pisandose entre si y
// confundiendo cual es el dato vivo.
const NO_CACHE_HOSTS = ['data912.com', 'dolarapi.com', 'api.coingecko.com'];

function esHostSinCache(hostname) {
  return NO_CACHE_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

self.addEventListener('install', (event) => {
  self.skipWaiting(); // la version nueva no espera a que se cierren las pestañas viejas
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()) // toma control de las pestañas abiertas sin recargar
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (esHostSinCache(url.hostname)) return; // se deja pasar tal cual a la red, sin tocar el cache

  const esNavegacion = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (esNavegacion) {
    // network-first REAL: `{cache:'reload'}` obliga a ir al servidor salteando el cache
    // HTTP del navegador. Sin esto, GitHub Pages sirve el HTML con `Cache-Control:
    // max-age=600`, asi que `fetch(req)` a secas devolvia el index.html cacheado hasta
    // 10 min — o sea, un deploy nuevo NO se veia al recargar (era "cache-first por 10
    // minutos" disfrazado de network-first). Si no hay señal, el .catch cae al cache.
    event.respondWith(
      fetch(req, { cache: 'reload' })
        .then((res) => {
          // Solo cacheamos respuestas ok: fetch() resuelve normalmente (no rechaza) con
          // 404/500, y GitHub Pages tira 404 transitorios durante sus propios deploys. Sin
          // este chequeo, un 404 de HTML quedaria como fallback offline y la app offline
          // mostraria la pagina de error de GitHub en vez del tablero.
          if (res.ok) {
            const copia = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
          }
          return res;
        })
        .catch(() => caches.match(req).then((res) => res || caches.match('./index.html')))
    );
    return;
  }

  const esPropio = url.origin === self.location.origin;
  const esGoogleFonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (esPropio || esGoogleFonts) {
    // cache-first: iconos, manifest y las fuentes no cambian seguido.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        // Mismo chequeo que en la rama network-first de arriba: en cache-first un 404
        // cacheado queda PARA SIEMPRE (esta rama nunca revalida), asi que un 404
        // transitorio de GitHub Pages pisaria el icono/manifest/fuente real sin que
        // nada lo vuelva a corregir salvo bumpear CACHE_NAME.
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        }
        return res;
      }))
    );
  }
  // cualquier otro pedido (no propio, no fuentes, no APIs de precios) pasa de largo.
});
