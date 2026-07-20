// Test de escenarios guardados — mejora #5, tarea 3a (guardar/cargar/borrar/deshacer).
//
// Mismo patron que test/persistencia.js: Node puro + vm.Script, sin frameworks.
// Corre con: node test/escenarios.js
//
// Que verifica (ver .superpowers/sdd/task-3a-brief.md, seccion "Verificacion obligatoria"):
//  1. Round-trip: guardar, cambiar el estado vivo, cargar -> vuelve el estado guardado.
//  2. Aislamiento: guardar dos escenarios, mutar el estado vivo, ninguno de los guardados
//     cambia. Cubre explicitamente weights y goals (el "bug mas caro" del brief).
//  3. Deshacer: cargar y deshacer -> vuelve exactamente el estado previo, incluida la
//     cartera real (hLiq/hIdx/hBtc/hTem).
//  4. Sobrescritura: guardar dos veces con el mismo nombre no duplica la entrada.
//  5. Escapado: un escenario llamado <img src=x onerror=alert(1)> se renderiza escapado.
//  6. Tolerancia: cnf_scenarios_v1 con JSON corrupto, o con un objeto en vez de array,
//     no rompe.
//  7. Sanity checks (ver seccion final): cada proteccion nueva se rompe a proposito
//     una vez para confirmar que el test la detecta, documentado en el reporte de la
//     tarea en vez de dejar el codigo roto en el repo.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX_PATH, 'utf8');

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

const scriptBlocks = [];
{
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scriptBlocks.push(m[1]);
}
const bigScript = scriptBlocks.find(s => s.includes('function computeFlow'));
if (!bigScript) {
  console.log('FAIL setup: no se encontro el bloque <script> con computeFlow en index.html');
  process.exit(1);
}
// Igual que persistencia.js: cortamos justo antes de la ultima invocacion real
// "loadPrices();" (con parentesis). Todo lo anterior -incluido bootState(), los
// listeners delegados de autosave y el wiring de escenarios (onclick + el
// renderScenarios() inicial)- se ejecuta al cargar el sandbox.
const CUT_MARKER = 'loadPrices();';
const cutIdx = bigScript.lastIndexOf(CUT_MARKER);
if (cutIdx === -1) {
  console.log('FAIL setup: no se encontro el marcador de corte "' + CUT_MARKER + '"');
  process.exit(1);
}
const logicSrc = bigScript.slice(0, cutIdx);

// ---------------------------------------------------------------------------
// Stubs de DOM y localStorage (copiados de test/persistencia.js)
// ---------------------------------------------------------------------------
function makeClassList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      const has = set.has(c);
      const want = force === undefined ? !has : !!force;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    _classes() { return Array.from(set); },
  };
}
function makeElement(id) {
  return {
    id: id,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    disabled: false,
    onclick: null,
    classList: makeClassList(),
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector() { return makeElement(id + '>nested'); },
    querySelectorAll() { return []; },
  };
}
function makeSegButtons(values, on) {
  return values.map(v => {
    const cl = makeClassList();
    if (v === on) cl.add('on');
    return { dataset: { v }, classList: cl };
  });
}

// loadSandbox: crea un sandbox nuevo, con su propio localStorage-stub (respaldado por
// `store`, poblable ANTES de llamar a esta funcion) y su propio DOM-stub. `confirmAnswer`
// controla lo que devuelve window.confirm() (usado por saveScenario/deleteScenario al
// pedir confirmacion); por defecto true, para no bloquear los tests que no la ejercitan
// a proposito.
function loadSandbox(initialStore, confirmAnswer) {
  const store = Object.assign({}, initialStore || {});
  const elCache = new Map();
  const perfilButtons = makeSegButtons(['conservador', 'moderado', 'arriesgado'], 'moderado');
  const plazoButtons = makeSegButtons(['corto', 'mediano', 'largo'], 'largo');
  const docListeners = { input: [], change: [] };
  const documentStub = {
    getElementById(id) {
      if (!elCache.has(id)) elCache.set(id, makeElement(id));
      return elCache.get(id);
    },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    querySelectorAll(sel) {
      if (sel === '#perfil button') return perfilButtons;
      if (sel === '#plazo button') return plazoButtons;
      return [];
    },
    documentElement: makeElement('documentElement'),
    addEventListener(type, fn) { if (docListeners[type]) docListeners[type].push(fn); },
  };
  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const confirmState = { answer: confirmAnswer !== undefined ? confirmAnswer : true };
  const sandbox = {
    document: documentStub,
    localStorage: localStorageStub,
    console,
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    setTimeout,
    clearTimeout,
    confirm() { return confirmState.answer; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic-escenarios' });
  return { sandbox, documentStub, ctx, store, perfilButtons, plazoButtons, docListeners, confirmState };
}

// normalize: mismo motivo que en persistencia.js — comparar via JSON evita falsos
// negativos de assert.deepStrictEqual por [[Prototype]] distinto entre realms.
function normalize(x) { return JSON.parse(JSON.stringify(x)); }

function snapA() {
  return {
    v: 1, perfil: 'arriesgado', plazo: 'corto', aporteModo: 'fijo',
    weights: { liq: 5, idx: 35, btc: 40, tem: 20 },
    inputs: {
      ingresoNum: 2345000, gAlq: 610000, gCom: 280000, gImp: 190000,
      cuotas: 75000, pctInv: 65, objYa: 1200000, objMud: 4100000,
      projYrs: 12, projP0: 300000, projGoal: 80000000, inflExp: 45,
      hLiq: 111111, hIdx: 222222, hBtc: 333333, hTem: 444444,
    },
    goals: [{ name: 'Auto', usd: 18000, years: 3 }, { name: 'Casa propia', usd: 120000, years: 10 }],
  };
}
function snapB() {
  return {
    v: 1, perfil: 'conservador', plazo: 'largo', aporteModo: 'infl',
    weights: { liq: 60, idx: 25, btc: 5, tem: 10 },
    inputs: {
      ingresoNum: 1500000, gAlq: 500000, gCom: 300000, gImp: 200000,
      cuotas: 250000, pctInv: 80, objYa: 3900000, objMud: 3500000,
      projYrs: 20, projP0: 0, projGoal: 50000000, inflExp: 20,
      hLiq: 999, hIdx: 888, hBtc: 777, hTem: 666,
    },
    goals: [{ name: 'Viaje', usd: 3500, years: 2 }],
  };
}

// ---------------------------------------------------------------------------
// 1. Round-trip: guardar, cambiar el estado vivo, cargar -> vuelve el estado guardado.
// ---------------------------------------------------------------------------
section('round-trip: guardar, cambiar el estado vivo, cargar -> vuelve el estado guardado', () => {
  const { sandbox } = loadSandbox({});
  sandbox.restore(snapA());
  sandbox.saveScenario('Escenario A');
  check(sandbox.readScenarios().length === 1, 'debe haber quedado 1 escenario guardado');

  // cambiamos el estado vivo a algo bien distinto
  sandbox.restore(snapB());
  const midway = normalize(sandbox.snapshot());
  check(midway.perfil === 'conservador', 'sanity: el estado intermedio debe haber cambiado');

  sandbox.applyScenario(0);
  const after = normalize(sandbox.snapshot());
  assert.deepStrictEqual(after, normalize(snapA()), 'applyScenario(0) debe reproducir exactamente el snapshot A guardado');
});

// ---------------------------------------------------------------------------
// 2. Aislamiento: guardar dos escenarios, mutar el estado vivo, ninguno cambia.
//    Cubre explicitamente weights y goals.
// ---------------------------------------------------------------------------
section('aislamiento: mutar el estado vivo despues de guardar no afecta los escenarios guardados (weights y goals)', () => {
  const { sandbox, ctx } = loadSandbox({});
  sandbox.restore(snapA());
  sandbox.saveScenario('A');
  sandbox.restore(snapB());
  sandbox.saveScenario('B');

  const listBefore = sandbox.readScenarios();
  check(listBefore.length === 2, 'deben quedar 2 escenarios guardados');
  const aWeightsBefore = normalize(listBefore.find(s => s.name === 'A').snap.weights);
  const bGoalsBefore = normalize(listBefore.find(s => s.name === 'B').snap.goals);

  // mutamos el estado VIVO (weights y goals) directamente, sin pasar por restore()
  const liveState = vm.runInContext('state', ctx);
  const liveGoals = vm.runInContext('goals', ctx);
  liveState.weights.liq += 12345;
  liveState.weights.idx -= 999;
  liveGoals[0].usd += 55555;
  liveGoals.push({ name: 'Meta nueva post-guardado', usd: 1, years: 1 });

  const listAfter = sandbox.readScenarios();
  const aWeightsAfter = normalize(listAfter.find(s => s.name === 'A').snap.weights);
  const bGoalsAfter = normalize(listAfter.find(s => s.name === 'B').snap.goals);
  assert.deepStrictEqual(aWeightsAfter, aWeightsBefore, 'escenario A: weights no debe cambiar al mutar el estado vivo despues de guardar');
  assert.deepStrictEqual(bGoalsAfter, bGoalsBefore, 'escenario B: goals no debe cambiar al mutar el estado vivo despues de guardar');

  // y los dos escenarios guardados no deben compartir objeto weights/goals entre si
  const aSnap = listAfter.find(s => s.name === 'A').snap, bSnap = listAfter.find(s => s.name === 'B').snap;
  check(aSnap.weights !== bSnap.weights, 'los escenarios A y B no deben compartir el mismo objeto weights');
  check(aSnap.goals !== bSnap.goals, 'los escenarios A y B no deben compartir el mismo array goals');
});

section('aislamiento: mutar un snapshot leido de readScenarios() no afecta lo guardado en localStorage', () => {
  const { sandbox } = loadSandbox({});
  sandbox.restore(snapA());
  sandbox.saveScenario('A');
  const leido = sandbox.readScenarios()[0];
  leido.snap.weights.liq = -999999;
  leido.snap.goals[0].usd = -999999;
  leido.name = 'nombre mutado a mano';

  const relectura = sandbox.readScenarios()[0];
  check(relectura.snap.weights.liq !== -999999, 'mutar el objeto devuelto por readScenarios() no debe afectar una relectura posterior');
  check(relectura.name === 'A', 'mutar el objeto devuelto por readScenarios() no debe afectar el nombre en una relectura posterior');
});

// ---------------------------------------------------------------------------
// 3. Deshacer: cargar y deshacer -> vuelve exactamente el estado previo, incluida
//    la cartera real (hLiq/hIdx/hBtc/hTem).
// ---------------------------------------------------------------------------
section('deshacer: cargar un escenario y deshacer vuelve exactamente el estado previo (incluida la cartera real)', () => {
  const { sandbox, documentStub } = loadSandbox({});
  // el escenario guardado a cargar (B) vive en el indice 0
  sandbox.restore(snapB());
  sandbox.saveScenario('el que voy a cargar');
  // el estado VIVO antes de cargar (A, con su propia cartera real hLiq/hIdx/hBtc/hTem)
  sandbox.restore(snapA());
  const before = normalize(sandbox.snapshot());
  check(documentStub.getElementById('scnUndoBox').style.display === 'none', 'sanity: el boton de deshacer debe arrancar oculto');

  sandbox.applyScenario(0);
  check(normalize(sandbox.snapshot()).perfil === 'conservador', 'sanity: applyScenario debe haber cargado el escenario B');
  check(documentStub.getElementById('scnUndoBox').style.display !== 'none', 'el boton de deshacer debe quedar visible despues de cargar un escenario');

  sandbox.undoLoad();
  const after = normalize(sandbox.snapshot());
  assert.deepStrictEqual(after, before, 'undoLoad() debe reproducir exactamente el estado previo a la carga');
  check(after.inputs.hLiq === before.inputs.hLiq && after.inputs.hIdx === before.inputs.hIdx
     && after.inputs.hBtc === before.inputs.hBtc && after.inputs.hTem === before.inputs.hTem,
     'la cartera real (hLiq/hIdx/hBtc/hTem) debe volver exactamente a como estaba antes de cargar');
  check(documentStub.getElementById('scnUndoBox').style.display === 'none', 'el boton de deshacer debe ocultarse despues de usarlo');
});

// ---------------------------------------------------------------------------
// 4. Sobrescritura: guardar dos veces con el mismo nombre no duplica la entrada.
// ---------------------------------------------------------------------------
section('sobrescritura: guardar dos veces con el mismo nombre no duplica (con confirmacion aceptada)', () => {
  const { sandbox } = loadSandbox({}, true); // confirm() -> true
  sandbox.restore(snapA());
  sandbox.saveScenario('mismo nombre');
  check(sandbox.readScenarios().length === 1, 'debe haber 1 escenario tras el primer guardado');

  sandbox.restore(snapB());
  sandbox.saveScenario('mismo nombre');
  const list = sandbox.readScenarios();
  check(list.length === 1, 'guardar dos veces con el mismo nombre no debe duplicar la entrada, hubo ' + list.length);
  check(normalize(list[0].snap).perfil === 'conservador', 'la entrada sobrescrita debe reflejar el estado del SEGUNDO guardado');
});

section('sobrescritura: si el usuario cancela la confirmacion, no se pisa la entrada existente', () => {
  const { sandbox } = loadSandbox({}, true);
  sandbox.restore(snapA());
  sandbox.saveScenario('mismo nombre');

  const { sandbox: sandbox2, confirmState } = loadSandbox({ cnf_scenarios_v1: JSON.stringify(sandbox.readScenarios()) });
  confirmState.answer = false; // el usuario cancela el "sobrescribir"
  sandbox2.restore(snapB());
  sandbox2.saveScenario('mismo nombre');
  const list = sandbox2.readScenarios();
  check(list.length === 1, 'cancelar la sobrescritura no debe duplicar ni borrar la entrada existente');
  check(normalize(list[0].snap).perfil === 'arriesgado', 'cancelar la sobrescritura debe conservar el contenido ORIGINAL (snapA)');
});

// ---------------------------------------------------------------------------
// 5. Escapado: un escenario llamado <img src=x onerror=alert(1)> se renderiza escapado.
// ---------------------------------------------------------------------------
section('escapado: un nombre de escenario con HTML/JS se renderiza escapado, no inyectado', () => {
  const { sandbox, documentStub } = loadSandbox({});
  const NOMBRE_MALICIOSO = '<img src=x onerror=alert(1)>';
  sandbox.restore(snapA());
  sandbox.saveScenario(NOMBRE_MALICIOSO);
  sandbox.renderScenarios();

  const html = documentStub.getElementById('scnList').innerHTML;
  check(!html.includes('<img src=x onerror=alert(1)>'), 'el HTML renderizado no debe contener el tag <img> sin escapar');
  check(!/<img[^>]*onerror/i.test(html), 'el HTML renderizado no debe tener un <img onerror=...> ejecutable');
  check(html.includes('&lt;img'), 'el nombre debe aparecer escapado (con &lt;img) en el HTML renderizado');
});

// ---------------------------------------------------------------------------
// 6. Tolerancia: cnf_scenarios_v1 con JSON corrupto, o con un objeto en vez de
//    array, no rompe.
// ---------------------------------------------------------------------------
section('tolerancia: cnf_scenarios_v1 con JSON corrupto no rompe y se trata como lista vacia', () => {
  let threw = false;
  let result = null;
  try { result = loadSandbox({ cnf_scenarios_v1: '{"esto no es json valido' }); } catch (e) { threw = true; }
  check(!threw, 'cargar el sandbox con cnf_scenarios_v1 corrupto no debe lanzar');
  if (result) {
    let readThrew = false;
    let list = null;
    try { list = result.sandbox.readScenarios(); } catch (e) { readThrew = true; }
    check(!readThrew, 'readScenarios() no debe lanzar con JSON corrupto');
    check(Array.isArray(list) && list.length === 0, 'readScenarios() debe devolver [] con JSON corrupto, devolvio ' + JSON.stringify(list));

    let renderThrew = false;
    try { result.sandbox.renderScenarios(); } catch (e) { renderThrew = true; }
    check(!renderThrew, 'renderScenarios() no debe lanzar con JSON corrupto en localStorage');
  }
});

section('tolerancia: cnf_scenarios_v1 con un objeto (no array) no rompe y se trata como lista vacia', () => {
  const { sandbox } = loadSandbox({ cnf_scenarios_v1: JSON.stringify({ foo: 'bar', no: 'es un array' }) });
  let threw = false;
  let list = null;
  try { list = sandbox.readScenarios(); } catch (e) { threw = true; }
  check(!threw, 'readScenarios() no debe lanzar cuando la clave guarda un objeto en vez de un array');
  check(Array.isArray(list) && list.length === 0, 'readScenarios() debe devolver [] cuando cnf_scenarios_v1 es un objeto, devolvio ' + JSON.stringify(list));

  // y guardar un escenario nuevo despues de esa basura debe dejar la lista sana
  sandbox.restore(snapA());
  sandbox.saveScenario('recuperado');
  const after = sandbox.readScenarios();
  check(Array.isArray(after) && after.length === 1 && after[0].name === 'recuperado', 'despues de la basura, guardar un escenario nuevo debe dejar una lista sana de 1 elemento');
});

section('tolerancia: sin ningun escenario guardado, renderScenarios() no rompe (estado vacio con sentido)', () => {
  const { sandbox, documentStub } = loadSandbox({});
  let threw = false;
  try { sandbox.renderScenarios(); } catch (e) { threw = true; }
  check(!threw, 'renderScenarios() no debe lanzar sin escenarios guardados');
  const html = documentStub.getElementById('scnList').innerHTML;
  check(typeof html === 'string' && html.length > 0, 'sin escenarios debe mostrar un estado vacio con contenido, no una lista en blanco');
});

// ---------------------------------------------------------------------------
// 6b. Elementos malformados DENTRO del array (a diferencia del punto 6, que cubre
//     que la CLAVE entera sea JSON corrupto o un objeto). Este es el hallazgo critico
//     de la revision: renderScenarios() hace list.map(s=>...esc(s.name)...) sin
//     guardar `s`, asi que un elemento null/vacio tira TypeError. Y como
//     renderScenarios() se llama sin try/catch en el arranque sincrono (ANTES de
//     bootState(), de render() y del wiring de autosave), ese throw corta TODA la
//     inicializacion, no solo la seccion Escenarios.
// ---------------------------------------------------------------------------
section('readScenarios(): filtra elementos malformados (null, objeto vacio, sin snap) y conserva los validos', () => {
  const { sandbox } = loadSandbox({ cnf_scenarios_v1: JSON.stringify([
    null,
    {},
    { name: 'sin snap' },
    { name: 'ok', ts: 1, snap: snapA() },
  ]) });
  const list = sandbox.readScenarios();
  check(Array.isArray(list) && list.length === 1, 'readScenarios() debe filtrar los 3 elementos malformados y conservar solo el valido, quedaron ' + list.length);
  check(list[0].name === 'ok', 'el unico elemento conservado debe ser el valido ("ok")');
});

section('arranque completo: cnf_scenarios_v1 con elementos malformados no tira abajo TODO el tablero (no solo renderScenarios())', () => {
  const casosMalos = [
    JSON.stringify([null]),
    JSON.stringify([{}]),
    JSON.stringify([{ name: 'ok', snap: snapA() }, null]),
    JSON.stringify([{ name: 'sin snap' }]),
  ];
  casosMalos.forEach(raw => {
    let threw = false;
    let result = null;
    // loadSandbox() ejecuta TODO el script de punta a punta (incluido el
    // renderScenarios() sincrono del arranque, bootState(), buildGoals/buildAlloc/
    // render() y el wiring de los listeners de autosave). Si el bug del hallazgo #1
    // sigue presente, esta linea es la que tira, no una llamada aislada a
    // renderScenarios().
    try { result = loadSandbox({ cnf_scenarios_v1: raw }); } catch (e) { threw = true; }
    check(!threw, 'el arranque completo con cnf_scenarios_v1=' + raw + ' no debe lanzar');
    if (!result) return;
    const { sandbox } = result;
    // no alcanza con "no tiro": el tablero tiene que haber quedado usable de punta a
    // punta (bootState/render/wiring corrieron), no solo el modulo de escenarios.
    check(typeof sandbox.snapshot === 'function' && typeof sandbox.restore === 'function' && typeof sandbox.scheduleSave === 'function',
      'el sandbox debe quedar completamente inicializado (snapshot/restore/scheduleSave disponibles) con cnf_scenarios_v1=' + raw);
    sandbox.restore(snapB());
    const snap = normalize(sandbox.snapshot());
    check(snap.perfil === 'conservador', 'el estado debe seguir siendo operable (restore/snapshot funcionan) despues de un arranque con escenarios malformados, caso ' + raw);
  });
});

// ---------------------------------------------------------------------------
// 6c. Bug de verificacion independiente sobre bd5eaca: el filtro de 6b solo
//     validaba "s.snap es un objeto", no que tuviera la forma que computeFlow()
//     necesita. Un escenario como {"name":"buena","ts":1,"snap":{"v":1}} pasaba
//     ese filtro viejo (snap ES un objeto) y despues metricsFor(s.snap) ->
//     computeFlow(snap) hacia `inputs.ingresoNum` con inputs undefined -> TypeError,
//     pero recien adentro del timer de scheduleCompare() (ver test/comparativa.js
//     para la reproduccion async por el camino real). Esta seccion cubre el punto
//     de saneo en la fuente: readScenarios() ahora tiene que filtrar tambien estos
//     casos, no solo null/{}/sin snap.
// ---------------------------------------------------------------------------
section('readScenarios(): filtra snaps que SON objeto pero sin la forma minima de computeFlow (sin inputs/weights, o con inputs de tipo invalido)', () => {
  const { sandbox } = loadSandbox({ cnf_scenarios_v1: JSON.stringify([
    { name: 'exacto del bug: snap={v:1}', ts: 1, snap: { v: 1 } },
    { name: 'inputs no es objeto', ts: 1, snap: { v: 1, inputs: 'no soy un objeto', weights: { liq: 25, idx: 25, btc: 25, tem: 25 } } },
    { name: 'weights ausente', ts: 1, snap: { v: 1, inputs: snapA().inputs } },
    { name: 'weights con claves incompletas', ts: 1, snap: { v: 1, inputs: snapA().inputs, weights: { liq: 5, idx: 35 } } },
    { name: 'inputs sin un campo CORE (le falta projGoal)', ts: 1, snap: { v: 1, inputs: (() => { const i = Object.assign({}, snapA().inputs); delete i.projGoal; return i; })(), weights: snapA().weights } },
    { name: 'ok', ts: 1, snap: snapA() },
  ]) });
  const list = sandbox.readScenarios();
  check(Array.isArray(list) && list.length === 1, 'readScenarios() debe filtrar los 5 snaps incompletos y conservar solo el valido, quedaron ' + list.length);
  check(list[0].name === 'ok', 'el unico elemento conservado debe ser el valido ("ok"), fue "' + (list[0] && list[0].name) + '"');
});

// Compatibilidad hacia atras: un escenario guardado por una version ANTERIOR a la mejora
// #6 no tiene aporteModo ni inputs.inflExp. Debe seguir siendo usable (los campos nuevos
// caen a su default), no descartarse — si no, el usuario perderia sus escenarios viejos.
section('compat: un escenario viejo (sin aporteModo ni inflExp) sigue siendo usable y carga con defaults', () => {
  const viejo = { v:1, perfil:'moderado', plazo:'largo',
    weights:{ liq:15, idx:55, btc:15, tem:15 },
    inputs:{ ingresoNum:1500000, gAlq:500000, gCom:300000, gImp:200000, cuotas:250000, pctInv:80,
      objYa:3900000, objMud:3500000, projYrs:20, projP0:0, projGoal:50000000,
      hLiq:0, hIdx:0, hBtc:0, hTem:0 },  // sin inflExp, sin aporteModo
    goals:[{ name:'Viaje', usd:3500, years:2 }] };
  const { sandbox } = loadSandbox({ cnf_scenarios_v1: JSON.stringify([{ name:'viejo', ts:1, snap:viejo }]) });
  const list = sandbox.readScenarios();
  check(list.length === 1 && list[0].name === 'viejo', 'el escenario viejo NO debe descartarse (quedaron ' + list.length + ')');
  sandbox.applyScenario(0);
  const s = sandbox.snapshot();
  check(s.aporteModo === 'infl', 'al cargar un escenario sin aporteModo, queda el default "infl", fue ' + s.aporteModo);
  check(s.inputs.ingresoNum === 1500000, 'los datos del escenario viejo se restauran igual');
});

section('arranque completo: cnf_scenarios_v1 con el snap EXACTO del bug reportado ({"v":1}, sin inputs/weights) no tira abajo el tablero', () => {
  const raw = JSON.stringify([{ name: 'buena', ts: 1, snap: { v: 1 } }]);
  let threw = false;
  let result = null;
  try { result = loadSandbox({ cnf_scenarios_v1: raw }); } catch (e) { threw = true; }
  check(!threw, 'el arranque completo con el snap exacto del bug reportado no debe lanzar');
  if (!result) return;
  const { sandbox } = result;
  check(sandbox.readScenarios().length === 0, 'el escenario "buena" (snap incompleto) no debe aparecer en readScenarios()');
  sandbox.restore(snapB());
  check(normalize(sandbox.snapshot()).perfil === 'conservador', 'el tablero debe seguir siendo operable despues del arranque');
});

// ---------------------------------------------------------------------------
// 6d. restore()/applyScenario() con un snap incompleto: a diferencia de
//     computeFlow(), restore() ya chequea cada campo por separado antes de usarlo
//     (if(s.weights && typeof s.weights==='object'), if(s.inputs && ...), etc.), asi
//     que un snap tipo {v:1} deberia dejarlo simplemente sin tocar esos campos, no
//     tirar. Esta seccion lo confirma explicitamente en vez de asumirlo.
// ---------------------------------------------------------------------------
section('restore(): un snap incompleto ({v:1}, sin inputs/weights/goals) no tira y deja el resto del estado intacto', () => {
  const { sandbox } = loadSandbox({});
  sandbox.restore(snapA());
  const before = normalize(sandbox.snapshot());

  let threw = false;
  try { sandbox.restore({ v: 1 }); } catch (e) { threw = true; }
  check(!threw, 'restore({v:1}) no debe lanzar');

  const after = normalize(sandbox.snapshot());
  assert.deepStrictEqual(after, before, 'restore() con un snap sin inputs/weights/goals no debe alterar el estado previo (cada campo se chequea por separado antes de aplicarse)');
});

section('applyScenario(): cargar un indice cuyo snap guardado es incompleto no tira (y, tras el fix de readScenarios(), ni siquiera queda cargable)', () => {
  const { sandbox } = loadSandbox({ cnf_scenarios_v1: JSON.stringify([{ name: 'buena', ts: 1, snap: { v: 1 } }]) });
  let threw = false;
  try { sandbox.applyScenario(0); } catch (e) { threw = true; }
  check(!threw, 'applyScenario(0) sobre un escenario con snap incompleto no debe lanzar');
  // tras el fix de readScenarios(), este escenario ni siquiera aparece en la lista
  // (indice 0 esta vacio), asi que applyScenario(0) es un no-op seguro.
  check(sandbox.readScenarios().length === 0, 'sanity: el escenario incompleto no debe estar en readScenarios() tras el fix');
});

// ---------------------------------------------------------------------------
// Extra: nombre vacio no guarda (y no explota si se intenta cargar/borrar un
// indice que no existe).
// ---------------------------------------------------------------------------
section('nombre vacio: no guarda nada', () => {
  const { sandbox } = loadSandbox({});
  sandbox.restore(snapA());
  sandbox.saveScenario('');
  sandbox.saveScenario('   ');
  check(sandbox.readScenarios().length === 0, 'un nombre vacio o solo espacios no debe crear un escenario');
});

section('borrar: pide confirmacion y, aceptada, elimina la entrada', () => {
  const { sandbox } = loadSandbox({}, true);
  sandbox.restore(snapA());
  sandbox.saveScenario('para borrar');
  check(sandbox.readScenarios().length === 1, 'sanity: debe existir el escenario a borrar');
  sandbox.deleteScenario(0);
  check(sandbox.readScenarios().length === 0, 'deleteScenario() con confirmacion aceptada debe eliminar la entrada');
});

section('borrar: si el usuario cancela la confirmacion, no borra nada', () => {
  const { sandbox, confirmState } = loadSandbox({}, true);
  sandbox.restore(snapA());
  sandbox.saveScenario('para no borrar');
  confirmState.answer = false;
  sandbox.deleteScenario(0);
  check(sandbox.readScenarios().length === 1, 'deleteScenario() con confirmacion cancelada no debe borrar nada');
});

section('indices invalidos: applyScenario/deleteScenario con indice fuera de rango no rompen', () => {
  const { sandbox } = loadSandbox({});
  let threw = false;
  try {
    sandbox.applyScenario(0);
    sandbox.applyScenario(-1);
    sandbox.deleteScenario(99);
  } catch (e) { threw = true; }
  check(!threw, 'applyScenario/deleteScenario con indices invalidos sobre una lista vacia no deben lanzar');
});

// ---------------------------------------------------------------------------
// Fin
// ---------------------------------------------------------------------------
console.log('');
console.log(checks + ' aserciones corridas.');
if (failures > 0) {
  console.log(failures + ' seccion(es) fallaron.');
  process.exit(1);
} else {
  console.log('Todo OK.');
  process.exit(0);
}
