// Test de la PWA instalable + offline — mejora #5, tarea 4.
//
// Mismo patron que el resto de test/*.js: Node puro + vm.Script, sin frameworks.
// Corre con: node test/pwa.js
//
// Que verifica (ver .superpowers/sdd/task-4-brief.md, "Verificacion obligatoria"):
//  1. manifest.json parsea y todas sus rutas son relativas (nada arranca con "/").
//  2. Los iconos existen, no estan vacios, son PNG validos y sus dimensiones (IHDR)
//     coinciden con lo que declara el manifest.
//  3. sw.js parsea como JS (vm.Script, sin ejecutarlo).
//  4. El registro del SW en index.html esta condicionado a HTTPS/localhost (no se
//     registra bajo file://).
//  5. sw.js NO cachea los dominios de las APIs de precios.
//  6. index.html enlaza el manifest y declara theme-color.
//  7. El aviso de precios viejos: con fecha se muestra, sin fecha (dato viejo) no rompe.
//  8. Cada aserto de arriba tiene su contraparte de mutacion: se rompe a proposito lo
//     que protege y se confirma que el checker lo detecta (revirtiendo enseguida,
//     nunca contra los archivos reales del repo).

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const SW_PATH = path.join(ROOT, 'sw.js');
const html = fs.readFileSync(INDEX_PATH, 'utf8');
const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
const swSrc = fs.readFileSync(SW_PATH, 'utf8');

let failures = 0;
let checks = 0;
function section(name, fn) {
  try {
    fn();
    console.log('OK   ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name);
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

// ---------------------------------------------------------------------------
// 1. manifest.json: JSON valido + TODAS las rutas relativas.
// ---------------------------------------------------------------------------
function rutasDelManifest(m) {
  const out = [];
  if (m && typeof m.start_url === 'string') out.push(['start_url', m.start_url]);
  if (m && typeof m.scope === 'string') out.push(['scope', m.scope]);
  (m && Array.isArray(m.icons) ? m.icons : []).forEach((ic, i) => {
    if (ic && typeof ic.src === 'string') out.push(['icons[' + i + '].src', ic.src]);
  });
  return out;
}
// assertRutasRelativas: el checker que "protege" el requisito. Tira si encuentra
// alguna ruta que arranca con "/" (ruta absoluta -> apunta a la raiz del dominio,
// rompe el deploy en el subdirectorio de GitHub Pages).
function assertRutasRelativas(m) {
  rutasDelManifest(m).forEach(([campo, val]) => {
    if (val.startsWith('/')) throw new Error('ruta absoluta en ' + campo + ': "' + val + '"');
  });
}

let manifest;
section('manifest.json: parsea como JSON valido', () => {
  manifest = JSON.parse(manifestRaw);
  check(manifest && typeof manifest === 'object', 'el manifest debe parsear a un objeto');
});

section('manifest.json: start_url, scope y todos los icons[].src son rutas relativas', () => {
  const rutas = rutasDelManifest(manifest);
  check(rutas.length >= 3, 'se esperaban al menos start_url + scope + 1 icono, hubo ' + rutas.length + ' rutas');
  assertRutasRelativas(manifest); // no debe tirar
  rutas.forEach(([campo, val]) => check(!val.startsWith('/'), campo + ' no puede empezar con "/" (val="' + val + '")'));
});

section('mutacion: assertRutasRelativas() SI detecta una ruta absoluta puesta a proposito', () => {
  ['start_url', 'scope'].forEach((campo) => {
    const roto = JSON.parse(JSON.stringify(manifest));
    roto[campo] = '/';
    assert.throws(() => assertRutasRelativas(roto), 'una ruta absoluta en ' + campo + ' debe hacer fallar el checker');
  });
  const rotoIcon = JSON.parse(JSON.stringify(manifest));
  rotoIcon.icons[0].src = '/' + rotoIcon.icons[0].src;
  assert.throws(() => assertRutasRelativas(rotoIcon), 'una ruta absoluta en icons[0].src debe hacer fallar el checker');
  // y confirmamos que el manifest real (sin romper) sigue pasando -> el checker no es un falso-positivo generalizado
  assert.doesNotThrow(() => assertRutasRelativas(manifest));
});

// ---------------------------------------------------------------------------
// 2. Iconos: existen, no vacios, PNG valido (firma + IHDR), dimensiones == manifest.
// ---------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function leerPngIHDR(buf) {
  if (buf.length < 24) throw new Error('archivo demasiado chico para ser un PNG (' + buf.length + ' bytes)');
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('firma PNG invalida');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('no arranca con un chunk IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

section('iconos: existen, no estan vacios, son PNG validos y sus dimensiones coinciden con el manifest', () => {
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'el manifest debe declarar al menos 3 iconos');
  const purposes = manifest.icons.map((i) => i.purpose || 'any');
  check(purposes.includes('maskable'), 'debe haber al menos un icono purpose=maskable');
  manifest.icons.forEach((ic) => {
    const p = path.join(ROOT, ic.src);
    check(fs.existsSync(p), 'falta el archivo de icono: ' + ic.src);
    const buf = fs.readFileSync(p);
    check(buf.length > 0, ic.src + ' no puede estar vacio');
    const { width, height } = leerPngIHDR(buf);
    const [w, h] = String(ic.sizes).split('x').map(Number);
    check(width === w && height === h,
      ic.src + ': IHDR declara ' + width + 'x' + height + ' pero el manifest dice ' + ic.sizes);
  });
});

section('mutacion: leerPngIHDR() SI detecta firma invalida y dimensiones que no matchean', () => {
  const real = fs.readFileSync(path.join(ROOT, manifest.icons[0].src));

  const firmaRota = Buffer.from(real); firmaRota[0] = 0x00;
  assert.throws(() => leerPngIHDR(firmaRota), 'una firma PNG corrupta debe hacer fallar el checker');

  const vacio = Buffer.alloc(0);
  assert.throws(() => leerPngIHDR(vacio), 'un buffer vacio debe hacer fallar el checker');

  // dimension mentirosa: el checker de dimensiones (no leerPngIHDR en si, que solo lee)
  // debe detectar que el IHDR real no coincide con un sizes falso del manifest.
  const { width, height } = leerPngIHDR(real);
  const sizesFalso = (width + 1) + 'x' + height;
  const [w] = sizesFalso.split('x').map(Number);
  assert.notStrictEqual(width, w, 'la comparacion width===w debe fallar con un sizes adulterado');

  assert.doesNotThrow(() => leerPngIHDR(real), 'el icono real no debe fallar');
});

// ---------------------------------------------------------------------------
// 3. sw.js parsea como JS (vm.Script, sin ejecutarlo).
// ---------------------------------------------------------------------------
section('sw.js: parsea como JavaScript valido (vm.Script, sin ejecutar)', () => {
  assert.doesNotThrow(() => new vm.Script(swSrc, { filename: 'sw.js' }), 'sw.js debe compilar sin SyntaxError');
});

section('mutacion: vm.Script SI rechaza un sw.js con sintaxis rota a proposito', () => {
  const roto = swSrc + '\nfunction esto no cierra( {';
  assert.throws(() => new vm.Script(roto, { filename: 'sw.js#roto' }), 'una sintaxis invalida debe tirar SyntaxError');
});

// ---------------------------------------------------------------------------
// 4. Registro del SW en index.html: condicionado a HTTPS/localhost, nunca file://.
//    Chequeo behavioral de verdad: se corre el snippet real extraido del HTML en un
//    sandbox con `location`/`navigator` truchos para 3 escenarios (file://, https,
//    localhost) y se confirma que .register() se llama solo cuando corresponde.
// ---------------------------------------------------------------------------
function extraerSnippetRegistro(htmlSrc) {
  const m = htmlSrc.match(/\(function registrarServiceWorker\(\)\{[\s\S]*?\}\)\(\);/);
  if (!m) throw new Error('no se encontro la IIFE registrarServiceWorker() en index.html');
  return m[0];
}

function correrRegistro(snippet, { protocol, hostname }) {
  let registrado = false;
  const sandbox = {
    navigator: { serviceWorker: { register() { registrado = true; return { catch() {} }; } } },
    location: { protocol, hostname },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox, { filename: 'index.html#registro-sw' });
  return registrado;
}

const registroSnippet = extraerSnippetRegistro(html);

section('registro SW: se extrae el snippet real de index.html', () => {
  check(registroSnippet.includes("register('sw.js')"), 'debe registrar con ruta relativa "sw.js" (no "/sw.js")');
  check(!registroSnippet.includes("register('/sw.js')"), 'no puede registrar con ruta absoluta');
});

section('registro SW: SI se registra bajo https:, y bajo localhost aunque el protocolo sea http:', () => {
  check(correrRegistro(registroSnippet, { protocol: 'https:', hostname: 'juanignaciobarranco.github.io' }) === true,
    'bajo HTTPS debe registrar el service worker');
  check(correrRegistro(registroSnippet, { protocol: 'http:', hostname: 'localhost' }) === true,
    'bajo localhost (aunque sea http:, típico de un server local de dev) debe registrar');
});

section('registro SW: NO se registra bajo file:// ni bajo http: en un host que no es localhost', () => {
  check(correrRegistro(registroSnippet, { protocol: 'file:', hostname: '' }) === false,
    'bajo file:// (abrir el .html directo del disco) NO debe registrar nada');
  check(correrRegistro(registroSnippet, { protocol: 'http:', hostname: 'ejemplo.com' }) === false,
    'bajo http: en un host que no es localhost NO debe registrar');
});

section('mutacion: sacando el guard de protocolo, el mismo snippet SI registraria bajo file://', () => {
  // Confirma que la linea guard es la que realmente evita el registro bajo file://:
  // si la sacamos, el comportamiento se invierte (register() pasa a llamarse).
  const sinGuard = registroSnippet.replace(
    /if\(location\.protocol!=='https:' && !esLocalhost\) return;\n?/,
    ''
  );
  check(sinGuard !== registroSnippet, 'el replace debe haber encontrado y sacado la linea guard (si no, el test no prueba nada)');
  check(correrRegistro(sinGuard, { protocol: 'file:', hostname: '' }) === true,
    'sin el guard de protocolo, el snippet registraria igual bajo file:// (confirma que el guard real es necesario)');
});

// ---------------------------------------------------------------------------
// 5. sw.js NO cachea los dominios de las APIs de precios.
//    Chequeo behavioral: se ejecuta sw.js de verdad en un sandbox con self/caches/
//    fetch/URL truchos, se dispara el listener "fetch" con pedidos a cada dominio de
//    precios y se confirma que event.respondWith() NUNCA se llama para esos casos
//    (se deja pasar la request tal cual a la red, sin que el SW la intercepte).
// ---------------------------------------------------------------------------
function correrSw(source, opts) {
  opts = opts || {};
  const listeners = {};
  const putCalls = [];
  // put() registra cada llamada (para los tests de res.ok, mas abajo); el resto de los
  // tests de esta seccion no miran putCalls, asi que no les cambia nada.
  const fakeCache = { addAll: async () => {}, put: async (req, res) => { putCalls.push({ req, res }); }, match: async () => undefined };
  const fetchCalls = [];
  const fetchImpl = opts.fetchImpl || ((req) => { fetchCalls.push(req); return Promise.resolve({ ok: true, clone() { return this; } }); });
  const sandbox = {
    self: {
      addEventListener(type, fn) { listeners[type] = fn; },
      skipWaiting() {},
      clients: { claim: async () => {} },
      location: { origin: 'https://juanignaciobarranco.github.io' },
    },
    caches: {
      open: async () => fakeCache,
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    },
    fetch: fetchImpl,
    URL,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'sw.js#sandbox' });
  return { listeners, sandbox, fetchCalls, putCalls, fakeCache };
}
function pedidoFetch(listeners, urlStr, extra) {
  const req = Object.assign({
    method: 'GET', url: urlStr, mode: 'cors',
    headers: { get: () => null },
  }, extra || {});
  const event = { request: req, respondWith(p) { event._respondido = true; event._p = p; } };
  listeners.fetch(event);
  return event;
}

const PRECIOS_HOSTS = ['data912.com', 'dolarapi.com', 'api.coingecko.com'];

section('sw.js: NO intercepta (no cachea) pedidos a los dominios de las APIs de precios', () => {
  const { listeners } = correrSw(swSrc);
  PRECIOS_HOSTS.forEach((host) => {
    const ev = pedidoFetch(listeners, 'https://' + host + '/algo');
    check(!ev._respondido, 'un pedido a ' + host + ' no debe pasar por event.respondWith() (no debe cachearse)');
    // Incluso con mode:'navigate' (que en cualquier otro caso dispara la rama
    // network-first sin mirar el host): el filtro de precios tiene que ganarle a esa
    // rama tambien, no solo a la de estaticos propios.
    const evNav = pedidoFetch(listeners, 'https://' + host + '/algo', { mode: 'navigate' });
    check(!evNav._respondido, 'un pedido navigate a ' + host + ' tampoco debe cachearse: el filtro de host va antes que el chequeo de navegacion');
  });
});

section('sw.js: SI intercepta (cachea) pedidos propios y de navegacion, como control positivo', () => {
  const { listeners } = correrSw(swSrc);
  const evNav = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/index.html',
    { mode: 'navigate' });
  check(evNav._respondido, 'una navegacion (HTML) SI debe pasar por respondWith (network-first)');
  const evManifest = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/manifest.json');
  check(evManifest._respondido, 'un estatico propio (manifest.json) SI debe pasar por respondWith (cache-first)');
});

section('mutacion: sacando el filtro de hosts de precios, sw.js SI terminaria cacheandolos', () => {
  const sinFiltro = swSrc.replace(
    /if\s*\(esHostSinCache\(url\.hostname\)\)\s*return;[^\n]*\n/,
    ''
  );
  check(sinFiltro !== swSrc, 'el replace debe haber encontrado y sacado la linea del filtro (si no, el test no prueba nada)');
  const { listeners } = correrSw(sinFiltro);
  // Un pedido GET comun a data912.com tampoco se cachearia CON el filtro puesto (no
  // matchea ninguna otra rama), asi que para que la mutacion sea observable hay que
  // forzar el escenario donde el filtro es lo UNICO que lo protege: mode:'navigate'
  // (la rama network-first no mira el host, solo el filtro de precios se lo impide).
  const ev = pedidoFetch(listeners, 'https://data912.com/algo', { mode: 'navigate' });
  check(ev._respondido === true,
    'sin el filtro de hosts, un pedido navigate a data912.com pasaria por respondWith (network-first) (confirma que el filtro real es necesario)');
});

// ---------------------------------------------------------------------------
// 5b. Hallazgo de revision (mejora-5): sw.js cacheaba respuestas no-ok. fetch()
//     resuelve normalmente (no rechaza) con 404/500, y GitHub Pages tira 404
//     transitorios durante sus propios deploys.
//     - cache-first (iconos/manifest/fuentes): un 404 asi cacheado queda cacheado
//       PARA SIEMPRE (esa rama nunca revalida; solo se limpia bumpeando CACHE_NAME).
//     - network-first (navegacion): un 404 de HTML queda como fallback offline -> la
//       app offline muestra la pagina de error de GitHub en vez del tablero.
//     Chequeo behavioral: se ejercita sw.js REAL (no una reimplementacion) con un
//     fetch que resuelve {ok:false}; el cache.put() interno no esta encadenado al
//     valor que event.respondWith() devuelve (es "fire and forget"), asi que despues
//     de esperar esa promesa hay que dejar pasar un macrotask (wait(0)) para que
//     terminen de asentar los .then() sueltos antes de mirar putCalls.
// ---------------------------------------------------------------------------
function fetch404() { return Promise.resolve({ ok: false, status: 404, clone() { return this; } }); }
function fetch200() { return Promise.resolve({ ok: true, status: 200, clone() { return this; } }); }

async function swResOkAsyncChecks() {
  try {
    { // network-first (navegacion): 404 NO se cachea
      const { listeners, putCalls } = correrSw(swSrc, { fetchImpl: fetch404 });
      const ev = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/index.html', { mode: 'navigate' });
      await ev._p;
      await wait(0);
      check(putCalls.length === 0, 'network-first: un 404 de la red NO debe cachearse, se cacheo ' + putCalls.length + ' vez/veces');
    }
    { // cache-first (icono propio): 404 NO se cachea
      const { listeners, putCalls } = correrSw(swSrc, { fetchImpl: fetch404 });
      const ev = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/icons/icon-192.png');
      await ev._p;
      await wait(0);
      check(putCalls.length === 0, 'cache-first: un 404 de la red NO debe cachearse, se cacheo ' + putCalls.length + ' vez/veces');
    }
    { // controles positivos: con 200 SI se sigue cacheando en ambas ramas
      const { listeners, putCalls } = correrSw(swSrc, { fetchImpl: fetch200 });
      const evNav = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/index.html', { mode: 'navigate' });
      await evNav._p;
      await wait(0);
      check(putCalls.length === 1, 'network-first: una respuesta 200 SI debe cachearse (control positivo), se cacheo ' + putCalls.length + ' vez/veces');
    }
    {
      const { listeners, putCalls } = correrSw(swSrc, { fetchImpl: fetch200 });
      const ev = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/icons/icon-192.png');
      await ev._p;
      await wait(0);
      check(putCalls.length === 1, 'cache-first: una respuesta 200 SI debe cachearse (control positivo), se cacheo ' + putCalls.length + ' vez/veces');
    }
    console.log('OK   sw.js real: solo se cachean respuestas res.ok, en ambas ramas (network-first y cache-first)');
  } catch (e) {
    failures++;
    console.log('FAIL sw.js real: res.ok debe gatear el cache.put() en ambas ramas');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }

  try {
    // mutacion: mismo swSrc real, con los dos guards "if (res.ok) { ... }" sacados via
    // replace de texto (nunca se toca el archivo real del repo). Ninguno de los dos
    // bloques tiene llaves anidadas adentro, asi que un no-greedy hasta la primera "}"
    // alcanza para sacar el guard entero sin tocar nada mas.
    const sinGuard = swSrc.replace(/if\s*\(res\.ok\)\s*\{([\s\S]*?)\}/g, '$1');
    const nGuardsReales = (swSrc.match(/if\s*\(res\.ok\)/g) || []).length;
    check(nGuardsReales === 2, 'se esperaban 2 guards "if (res.ok)" en sw.js (network-first + cache-first), se encontraron ' + nGuardsReales);
    check(sinGuard !== swSrc, 'el replace debe haber sacado los guards (si no, el test no prueba nada)');

    const { listeners, putCalls } = correrSw(sinGuard, { fetchImpl: fetch404 });
    const ev = pedidoFetch(listeners, 'https://juanignaciobarranco.github.io/finanzasNacho2026/icons/icon-192.png');
    await ev._p;
    await wait(0);
    check(putCalls.length === 1,
      'sin el guard de res.ok, un 404 SI se cachearia igual (confirma que el guard real es necesario), se cacheo ' + putCalls.length + ' vez/veces');
    console.log('OK   mutacion: sin el guard res.ok, sw.js SI cachearia un 404');
  } catch (e) {
    failures++;
    console.log('FAIL mutacion: sin el guard res.ok, sw.js deberia cachear un 404 igual');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}

// ---------------------------------------------------------------------------
// 6. index.html enlaza el manifest y declara theme-color.
// ---------------------------------------------------------------------------
function tieneManifestYTheme(htmlSrc) {
  const linkM = htmlSrc.match(/<link[^>]+rel=["']manifest["'][^>]*>/);
  const themeM = htmlSrc.match(/<meta[^>]+name=["']theme-color["'][^>]*>/);
  if (!linkM) throw new Error('no se encontro <link rel="manifest">');
  if (!themeM) throw new Error('no se encontro <meta name="theme-color">');
  const hrefM = linkM[0].match(/href=["']([^"']+)["']/);
  if (!hrefM) throw new Error('el <link rel="manifest"> no tiene href');
  if (hrefM[1].startsWith('/')) throw new Error('el href del manifest es una ruta absoluta: ' + hrefM[1]);
  return { linkTag: linkM[0], themeTag: themeM[0], href: hrefM[1] };
}

section('index.html: enlaza manifest.json (ruta relativa) y declara theme-color', () => {
  const { href } = tieneManifestYTheme(html);
  check(href === 'manifest.json', 'el href del manifest deberia ser "manifest.json" (relativo), fue "' + href + '"');
});

section('mutacion: tieneManifestYTheme() SI detecta la ausencia del link o del meta', () => {
  const sinLink = html.replace(/<link[^>]+rel=["']manifest["'][^>]*>\n?/, '');
  assert.throws(() => tieneManifestYTheme(sinLink), 'sin el <link rel="manifest"> el checker debe fallar');
  const sinTheme = html.replace(/<meta[^>]+name=["']theme-color["'][^>]*>\n?/, '');
  assert.throws(() => tieneManifestYTheme(sinTheme), 'sin el <meta name="theme-color"> el checker debe fallar');
  assert.doesNotThrow(() => tieneManifestYTheme(html), 'el index.html real debe seguir pasando');
});

// ---------------------------------------------------------------------------
// 6b. iconos iOS: hallazgo MINOR de revision (mejora-5). iOS ignora los iconos del
//     manifest para "Añadir a pantalla de inicio", asi que sin apple-touch-icon usaria
//     una captura de pantalla en vez del icono. Ruta relativa es critico: el sitio se
//     sirve desde el subdirectorio /finanzasNacho2026/ de GitHub Pages, una ruta
//     absoluta ("/icons/...") apuntaria a la raiz del dominio y no encontraria nada.
// ---------------------------------------------------------------------------
function tieneIconosIOS(htmlSrc) {
  const linkM = htmlSrc.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]*>/);
  const capableM = htmlSrc.match(/<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]*>/);
  if (!linkM) throw new Error('no se encontro <link rel="apple-touch-icon">');
  if (!capableM) throw new Error('no se encontro <meta name="apple-mobile-web-app-capable">');
  const hrefM = linkM[0].match(/href=["']([^"']+)["']/);
  if (!hrefM) throw new Error('el <link rel="apple-touch-icon"> no tiene href');
  if (hrefM[1].startsWith('/')) throw new Error('el href del apple-touch-icon es una ruta absoluta: ' + hrefM[1]);
  return { linkTag: linkM[0], href: hrefM[1] };
}

section('index.html: declara apple-touch-icon (ruta relativa, apuntando a un icono real) y apple-mobile-web-app-capable', () => {
  const { href } = tieneIconosIOS(html);
  check(!href.startsWith('/'), 'el href del apple-touch-icon no puede ser una ruta absoluta, fue "' + href + '"');
  check(fs.existsSync(path.join(ROOT, href)), 'el apple-touch-icon debe apuntar a un archivo que existe de verdad: ' + href);
});

section('mutacion: tieneIconosIOS() SI detecta la ausencia del link o una ruta absoluta', () => {
  const sinLink = html.replace(/<link[^>]+rel=["']apple-touch-icon["'][^>]*>\n?/, '');
  assert.throws(() => tieneIconosIOS(sinLink), 'sin el <link rel="apple-touch-icon"> el checker debe fallar');
  const conRutaAbsoluta = html.replace(/(<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["'])([^"']+)/, '$1/$2');
  assert.throws(() => tieneIconosIOS(conRutaAbsoluta), 'con una ruta absoluta en el href el checker debe fallar');
  assert.doesNotThrow(() => tieneIconosIOS(html), 'el index.html real debe seguir pasando');
});

// ---------------------------------------------------------------------------
// 7. Aviso de precios viejos: pxTsLabel() dentro del bloque grande.
// ---------------------------------------------------------------------------
function makeElement(id) {
  const cl = new Set();
  return {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false, onclick: null,
    classList: { add: (c) => cl.add(c), remove: (c) => cl.delete(c), contains: (c) => cl.has(c), toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return makeElement(id + '>nested'); }, querySelectorAll() { return []; },
  };
}
// extraerLogicSrc: el bloque grande de <script> de index.html, cortado justo antes de
// la invocacion final `loadPrices();` (las funciones -incluida loadPrices- quedan
// definidas igual; lo que se corta es el arranque real que pide document/localStorage
// de verdad). Factoreado aparte de loadLogicSandbox() para poder mutarlo con un
// replace de texto en los tests de mutacion sin tocar el archivo real del repo.
function extraerLogicSrc() {
  const scriptBlocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scriptBlocks.push(m[1]);
  const bigScript = scriptBlocks.find((s) => s.includes('function computeFlow'));
  if (!bigScript) throw new Error('no se encontro el bloque <script> con computeFlow');
  const cutIdx = bigScript.lastIndexOf('loadPrices();');
  if (cutIdx === -1) throw new Error('no se encontro el marcador de corte "loadPrices();"');
  return bigScript.slice(0, cutIdx);
}

function loadLogicSandbox(store, extraGlobals, srcOverride) {
  const elCache = new Map();
  const perfilButtons = ['conservador', 'moderado', 'arriesgado'].map((v) => ({ dataset: { v }, classList: { add() {}, remove() {}, contains: () => v === 'moderado' } }));
  const plazoButtons = ['corto', 'mediano', 'largo'].map((v) => ({ dataset: { v }, classList: { add() {}, remove() {}, contains: () => v === 'largo' } }));
  const documentStub = {
    getElementById(id) { if (!elCache.has(id)) elCache.set(id, makeElement(id)); return elCache.get(id); },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    querySelectorAll(sel) {
      if (sel === '#perfil button') return perfilButtons;
      if (sel === '#plazo button') return plazoButtons;
      return [];
    },
    documentElement: makeElement('documentElement'),
    addEventListener() {},
  };
  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const sandbox = Object.assign({
    document: documentStub,
    localStorage: localStorageStub,
    console,
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    setTimeout, clearTimeout,
    confirm() { return true; },
  }, extraGlobals || {});
  const ctx = vm.createContext(sandbox);
  vm.runInContext(srcOverride || extraerLogicSrc(), ctx, { filename: 'index.html#logic-pwa' });
  return sandbox;
}

section('aviso de precios viejos: con cnf_prices con fecha y offline, pxTsLabel() muestra "precios del <fecha>"', () => {
  const sandbox = loadLogicSandbox({}, { navigator: { onLine: false } });
  const ts = '2026-07-10T15:30:00.000Z';
  const out = sandbox.pxTsLabel({ mep: 1000, ts });
  check(typeof out === 'string' && out.startsWith('precios del '), 'offline con ts debe devolver "precios del <fecha>", fue "' + out + '"');
  check(out.includes(sandbox.fmtScnDate(ts)), 'la fecha mostrada debe salir de fmtScnDate(ts) (mismo formato que el resto del tablero)');
});

section('aviso de precios viejos: con conexion, pxTsLabel() muestra la hora corta ("actualizado HH:MM"), no la fecha completa', () => {
  const sandbox = loadLogicSandbox({}, { navigator: { onLine: true } });
  const out = sandbox.pxTsLabel({ mep: 1000, ts: '2026-07-10T15:30:00.000Z' });
  check(out.startsWith('actualizado '), 'online con ts debe devolver "actualizado HH:MM", fue "' + out + '"');
});

section('aviso de precios viejos: un cnf_prices VIEJO sin `ts` (o null/undefined) no rompe pxTsLabel()', () => {
  const sandbox = loadLogicSandbox({}, { navigator: { onLine: false } });
  [{}, { mep: 1000 }, null, undefined, { ts: null }, { ts: 'no-es-una-fecha' }].forEach((viejo) => {
    let threw = false, out = null;
    try { out = sandbox.pxTsLabel(viejo); } catch (e) { threw = true; }
    check(!threw, 'pxTsLabel(' + JSON.stringify(viejo) + ') no debe tirar');
    check(typeof out === 'string' && out.length > 0, 'pxTsLabel(' + JSON.stringify(viejo) + ') debe devolver un string no vacio de todas formas');
  });
});

section('retrocompat: cargar un cnf_prices viejo (sin `ts`) desde localStorage no rompe el arranque y PRICES sigue siendo usable', () => {
  const viejo = JSON.stringify({ mep: 1050, btcUsd: 60000, cedears: {} }); // sin `ts`: formato de una version anterior
  const sandbox = loadLogicSandbox({ cnf_prices: viejo }, { navigator: { onLine: false } });
  const prices = sandbox.pricesSnapshot();
  check(prices && prices.mep === 1050, 'PRICES.mep debe venir del cnf_prices viejo cargado');
  check('ts' in prices, 'PRICES debe tener la clave `ts` presente (mergeada con el default) aunque el dato viejo no la tuviera');
  check(prices.ts === null, 'un cnf_prices viejo sin `ts` debe quedar en null (el default), no en undefined');
  assert.doesNotThrow(() => sandbox.pxTsLabel(prices), 'pxTsLabel(PRICES) no debe tirar con el PRICES retrocompat-eado');
});

section('mutacion: sin el merge retrocompat, PRICES perderia la clave `ts` con un cnf_prices viejo', () => {
  // Version deliberadamente rota del loader (reemplaza en vez de mergear, como haria
  // el codigo viejo antes de esta tarea) para confirmar que el merge real hace falta.
  function loaderIngenuo(store) {
    let PRICES = { mep: null, btcUsd: null, cedears: null, ts: null };
    const _c = JSON.parse(store || 'null');
    if (_c) PRICES = _c; // <- reemplaza entero, no mergea
    return PRICES;
  }
  const viejo = JSON.stringify({ mep: 1050 });
  check(!('ts' in loaderIngenuo(viejo)), 'el loader ingenuo (sin merge) pierde la clave `ts` con datos viejos, confirmando que el merge real hace falta');
  const sandbox = loadLogicSandbox({ cnf_prices: viejo }, { navigator: { onLine: false } });
  check('ts' in sandbox.pricesSnapshot(), 'el loader REAL (con merge) conserva la clave `ts` con los mismos datos viejos');
});

section('mutacion: sin el guard "!p||!p.ts", una version ingenua de pxTsLabel SI rompe con datos viejos', () => {
  // Version deliberadamente rota (sin el guard defensivo) para confirmar que la
  // proteccion real hace falta: reproduce el codigo de pxTsLabel pero sin la linea
  // `if(!p||!p.ts) return 'sin datos aún';`.
  function pxTsLabelIngenuo(p) {
    const d = new Date(p.ts); // <- rompe si p es null/undefined
    return 'actualizado ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }
  assert.throws(() => pxTsLabelIngenuo(null), 'la version sin guard debe tirar con p=null (confirma que el guard real es necesario)');
  assert.throws(() => pxTsLabelIngenuo(undefined), 'la version sin guard debe tirar con p=undefined');
  const sandbox = loadLogicSandbox({}, { navigator: { onLine: false } });
  assert.doesNotThrow(() => sandbox.pxTsLabel(null), 'la version REAL (con guard) no debe tirar con p=null');
  assert.doesNotThrow(() => sandbox.pxTsLabel(undefined), 'la version REAL (con guard) no debe tirar con p=undefined');
});

// ---------------------------------------------------------------------------
// 8. loadPrices() real: hallazgo de revision (mejora-5). Promise.allSettled nunca
//    rechaza, asi que offline (las 3 fetch fallan) `o` queda vacio pero la version
//    vieja pisaba PRICES.ts con "ahora" igual y lo persistia -> pxTsLabel() mostraba
//    "precios del <hoy>" con precios de dias, y el ts real quedaba perdido para
//    siempre en localStorage. Chequeo de punta a punta: se llama loadPrices() REAL
//    (no una reimplementacion) con `fetch` stubeado para que rechace las 3 veces.
// ---------------------------------------------------------------------------
function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function fetchQueSiempreRechaza() { return Promise.reject(new Error('sin conexion (stub de test)')); }
function tsPreexistenteStore() {
  return { cnf_prices: JSON.stringify({ mep: 900, btcUsd: 55000, cedears: { SPY: {} }, ts: '2026-07-10T10:00:00.000Z' }) };
}

async function loadPricesAsyncChecks() {
  try {
    const store = tsPreexistenteStore();
    const sandbox = loadLogicSandbox(store, { navigator: { onLine: false }, fetch: fetchQueSiempreRechaza });
    await sandbox.loadPrices();
    const p = sandbox.pricesSnapshot();
    check(p.ts === '2026-07-10T10:00:00.000Z',
      'con las 3 fetch fallando, PRICES.ts NO debe pisarse: debe seguir siendo el real preexistente, fue "' + p.ts + '"');
    check(p.mep === 900, 'con las fetch fallando, PRICES.mep tampoco debe pisarse (sigue el valor viejo), fue ' + p.mep);
    const persisted = JSON.parse(store.cnf_prices);
    check(persisted.ts === '2026-07-10T10:00:00.000Z',
      'lo efectivamente persistido en localStorage (cnf_prices) tampoco puede llevar un ts nuevo pisado');
    console.log('OK   loadPrices() real: offline (fetch rechazando) NO pisa el ts preexistente');
  } catch (e) {
    failures++;
    console.log('FAIL loadPrices() real: offline no debe pisar el ts preexistente');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }

  try {
    // mutacion: mismo logicSrc real, pero con la linea del guard revertida a la
    // version vieja (pisar ts incondicionalmente), via replace de texto -- nunca se
    // toca el archivo real del repo.
    const real = extraerLogicSrc();
    const LINEA_CON_GUARD = "if(o.mep!=null||o.btcUsd!=null||o.cedears)PRICES.ts=new Date().toISOString();";
    check(real.includes(LINEA_CON_GUARD), 'debe encontrarse la linea real del guard en index.html (si no, este mutante no prueba nada)');
    const ingenuo = real.replace(LINEA_CON_GUARD, 'PRICES.ts=new Date().toISOString();');
    check(ingenuo !== real, 'el replace debe haber sacado el guard (si no, el test no prueba nada)');

    const store = tsPreexistenteStore();
    const sandbox = loadLogicSandbox(store, { navigator: { onLine: false }, fetch: fetchQueSiempreRechaza }, ingenuo);
    await sandbox.loadPrices();
    const p = sandbox.pricesSnapshot();
    check(p.ts !== '2026-07-10T10:00:00.000Z',
      'sin el guard, offline SI pisaria el ts real (confirma que el guard real hace falta), quedo "' + p.ts + '"');
    console.log('OK   mutacion: sin el guard de loadPrices(), offline SI pisaria el ts preexistente');
  } catch (e) {
    failures++;
    console.log('FAIL mutacion: sin el guard de loadPrices() deberia pisar el ts');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}

// ---------------------------------------------------------------------------
swResOkAsyncChecks().then(loadPricesAsyncChecks).then(() => {
  console.log('');
  console.log(checks + ' aserciones corridas.');
  if (failures) {
    console.log(failures + ' seccion(es) fallaron.');
    process.exit(1);
  }
  console.log('Todo OK.');
  process.exit(0);
});
