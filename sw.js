// Service worker del tablero — mejora #5, tarea 4 (PWA offline).
// Ver .superpowers/sdd/task-4-brief.md para la decisión de producto (network-first,
// sin aviso de "hay version nueva").
//
// OJO rutas: el sitio se sirve desde un SUBDIRECTORIO de GitHub Pages
// (https://juanignaciobarranco.github.io/finanzasNacho2026/), nunca desde la raíz del
// dominio. Todo acá abajo es relativo a la ubicación de este archivo.

// Nombre de cache VERSIONADO: subí el numero cuando cambien los estaticos precacheados
// para que `activate` tire la version vieja y no quede basura pisando el deploy nuevo.
const CACHE_NAME = 'cnf-v1';

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
    // network-first: si hay señal, la version nueva se ve enseguida; si no, cae al cache.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
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
        const copia = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        return res;
      }))
    );
  }
  // cualquier otro pedido (no propio, no fuentes, no APIs de precios) pasa de largo.
});
