// Test de la tabla comparativa de escenarios — mejora #5, tarea 3b.
//
// Mismo patron que test/escenarios.js: Node puro + vm.Script, sin frameworks.
// Corre con: node test/comparativa.js
//
// Que verifica (ver .superpowers/sdd/task-3b-brief.md, "Verificacion obligatoria"):
//  1. HORIZONTE COMUN (el test central): dos escenarios con projYrs distintos, comparados
//     a un horizonte comun, se calculan AMBOS con ese horizonte y no con el propio.
//  2. Cambiar el horizonte comun recalcula todas las filas.
//  3. Memoizacion: recalcular sin cambios no vuelve a correr el Monte Carlo.
//  4. Fila "actual": refleja el estado vivo.
//  5. Columnas: exced/inv de la tabla coinciden con computeFlow(snap).
//  6. Escapado: un nombre con HTML se renderiza escapado tambien en la tabla.
//  7. Sin escenarios guardados no rompe.

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
const CUT_MARKER = 'loadPrices();';
const cutIdx = bigScript.lastIndexOf(CUT_MARKER);
if (cutIdx === -1) {
  console.log('FAIL setup: no se encontro el marcador de corte "' + CUT_MARKER + '"');
  process.exit(1);
}
const logicSrc = bigScript.slice(0, cutIdx);

// ---------------------------------------------------------------------------
// Stubs de DOM y localStorage (mismo patron que test/escenarios.js)
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
  };
}
function makeElement(id) {
  // _listeners: a diferencia del stub original (addEventListener era un no-op), acá
  // los guardamos de verdad para poder disparar el evento "input" real sobre #cmpYrs
  // (hallazgo #3: hay que probar el camino real del listener, no llamar renderCompare()
  // a mano).
  const listeners = {};
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
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn); },
    dispatch(type) { (listeners[type] || []).slice().forEach(fn => fn({ target: this })); },
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

function loadSandbox(initialStore, srcOverride) {
  const store = Object.assign({}, initialStore || {});
  const elCache = new Map();
  const perfilButtons = makeSegButtons(['conservador', 'moderado', 'arriesgado'], 'moderado');
  const plazoButtons = makeSegButtons(['corto', 'mediano', 'largo'], 'largo');
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
    addEventListener() {},
  };
  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  const sandbox = {
    document: documentStub,
    localStorage: localStorageStub,
    console,
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    setTimeout,
    clearTimeout,
    confirm() { return true; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(srcOverride || logicSrc, ctx, { filename: 'index.html#logic-comparativa' });
  return { sandbox, documentStub, ctx, store };
}

// spyMcStats: reemplaza mcStats en el sandbox por un envoltorio que registra con que
// argumentos se lo llamo. mcStats es una `function` declarada en el top level del
// script, asi que vive como propiedad del global del contexto y se puede sustituir;
// metricsFor la resuelve dinamicamente por la cadena de scopes.
function spyMcStats(sandbox) {
  const calls = [];
  const real = sandbox.mcStats;
  assert.ok(typeof real === 'function', 'mcStats debe ser accesible en el sandbox para poder espiarlo');
  sandbox.mcStats = function (a) {
    calls.push(Object.assign({}, a));
    return real(a);
  };
  return {
    calls,
    reset() { calls.length = 0; },
    yearsSeen() { return calls.map(c => c.years); },
  };
}

function setHorizon(documentStub, years) {
  documentStub.getElementById('cmpYrs').value = String(years);
}

function snapCorto() {
  return {
    v: 1, perfil: 'arriesgado', plazo: 'corto', aporteModo: 'infl',
    weights: { liq: 5, idx: 35, btc: 40, tem: 20 },
    inputs: {
      ingresoNum: 2345000, gAlq: 610000, gCom: 280000, gImp: 190000,
      cuotas: 75000, pctInv: 65, objYa: 1200000, objMud: 4100000,
      projYrs: 10, projP0: 300000, projGoal: 80000000, inflExp: 30,
      hLiq: 111111, hIdx: 222222, hBtc: 333333, hTem: 444444,
    },
    goals: [{ name: 'Auto', usd: 18000, years: 3 }],
  };
}
function snapLargo() {
  return {
    v: 1, perfil: 'conservador', plazo: 'largo', aporteModo: 'infl',
    weights: { liq: 60, idx: 25, btc: 5, tem: 10 },
    inputs: {
      ingresoNum: 1500000, gAlq: 500000, gCom: 300000, gImp: 200000,
      cuotas: 250000, pctInv: 80, objYa: 3900000, objMud: 3500000,
      projYrs: 30, projP0: 0, projGoal: 50000000, inflExp: 30,
      hLiq: 999, hIdx: 888, hBtc: 777, hTem: 666,
    },
    goals: [{ name: 'Viaje', usd: 3500, years: 2 }],
  };
}

// seedScenarios: deja dos escenarios guardados con projYrs 10 y 30 respectivamente.
function seedScenarios() {
  return {
    cnf_scenarios_v1: JSON.stringify([
      { name: 'Corto', ts: 1752800000000, snap: snapCorto() },
      { name: 'Largo', ts: 1752800000001, snap: snapLargo() },
    ]),
  };
}

// ---------------------------------------------------------------------------
// 1. HORIZONTE COMUN — el requisito central de la tarea.
// ---------------------------------------------------------------------------
section('horizonte comun: dos escenarios con projYrs 10 y 30 se calculan AMBOS al horizonte de la tabla', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  spy.reset();
  sandbox.renderCompare();

  const years = spy.yearsSeen();
  check(years.length >= 3, 'debe calcular al menos 3 filas (actual + 2 escenarios), se calcularon ' + years.length);
  years.forEach((y, i) => {
    check(y === 20, 'la fila ' + i + ' se calculo con years=' + y + ' en vez del horizonte comun 20');
  });
  // Y explicitamente: ninguna fila uso el projYrs propio de su escenario (10 ni 30).
  check(!years.includes(10), 'ninguna fila puede usar el projYrs=10 propio del escenario "Corto"');
  check(!years.includes(30), 'ninguna fila puede usar el projYrs=30 propio del escenario "Largo"');
});

section('horizonte comun: el projYrs propio de cada escenario se muestra igual como dato informativo', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  setHorizon(documentStub, 20);
  sandbox.renderCompare();
  const out = documentStub.getElementById('cmpTable').innerHTML;
  check(/su plan: 10 años/.test(out), 'la fila "Corto" debe mostrar su horizonte propio (10 años)');
  check(/su plan: 30 años/.test(out), 'la fila "Largo" debe mostrar su horizonte propio (30 años)');
});

// ---------------------------------------------------------------------------
// 2. Cambiar el horizonte comun recalcula todas las filas.
// ---------------------------------------------------------------------------
section('cambiar el horizonte comun recalcula todas las filas con el horizonte nuevo', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);

  setHorizon(documentStub, 15);
  spy.reset();
  sandbox.renderCompare();
  const first = spy.calls.length;
  check(first >= 3, 'primer render debe calcular las filas');
  check(spy.yearsSeen().every(y => y === 15), 'todas las filas al horizonte 15');

  setHorizon(documentStub, 25);
  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length >= 3, 'cambiar el horizonte debe recalcular (no servir el memo del horizonte viejo)');
  check(spy.yearsSeen().every(y => y === 25), 'todas las filas al horizonte nuevo 25');
});

// ---------------------------------------------------------------------------
// 3. Memoizacion.
// ---------------------------------------------------------------------------
section('memoizacion: re-renderizar sin cambios no vuelve a correr el Monte Carlo', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);

  spy.reset();
  sandbox.renderCompare();
  const firstPass = spy.calls.length;
  check(firstPass >= 3, 'el primer render debe calcular las filas, calculo ' + firstPass);

  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length === 0,
    're-renderizar sin cambios no debe llamar a mcStats, llamo ' + spy.calls.length + ' vez/veces');
});

section('memoizacion: cambia el estado vivo -> la fila "actual" se recalcula', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  sandbox.renderCompare();

  // Ojo: el estado nuevo tiene que ser distinto de TODO lo ya calculado. Si restauraramos
  // snapCorto() tal cual, la fila "actual" tendria la misma clave de memo que la fila del
  // escenario "Corto" y el acierto de cache seria correcto, no un bug.
  const distinto = snapCorto();
  distinto.inputs.ingresoNum += 137000;
  sandbox.restore(distinto);
  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length >= 1, 'cambiar el estado vivo debe recalcular la fila "actual"');
});

section('memoizacion: la fila "actual" reusa el calculo de un escenario identico (no lo duplica)', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  sandbox.restore(snapCorto());
  spy.reset();
  sandbox.renderCompare();
  // 3 filas (actual + Corto + Largo) pero solo 2 estados distintos: la fila "actual"
  // y el escenario "Corto" comparten snapshot, asi que comparten memo.
  check(spy.calls.length === 2,
    'con la fila actual identica a un escenario guardado deben correrse 2 Monte Carlo, no 3; corrieron ' + spy.calls.length);
});

// ---------------------------------------------------------------------------
// 3b. Hallazgo de revision (mejora-5): la clave del memo antes era el snapshot ENTERO
//     via JSON.stringify(snap), pero computeFlow() ignora hLiq/hIdx/hBtc/hTem (cartera
//     real, solo los lee renderRebalance) y goals (solo los lee computeGoals). Con la
//     clave vieja, tipear en los campos de cartera real cambiaba la clave sin que
//     computeFlow() cambiara un bit -> se disparaban 500 paths de Monte Carlo de mas y
//     los p50/p10/p90 de la fila "Actual" bailaban en pantalla sin causa visible.
// ---------------------------------------------------------------------------
section('memoizacion: cambiar SOLO cartera real (hLiq/hIdx/hBtc/hTem) NO recalcula la fila "actual"', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  sandbox.restore(snapCorto());
  sandbox.renderCompare(); // deja "actual" en el memo

  const soloHoldings = snapCorto();
  soloHoldings.inputs.hLiq += 555555;
  soloHoldings.inputs.hIdx += 555555;
  soloHoldings.inputs.hBtc += 555555;
  soloHoldings.inputs.hTem += 555555;
  sandbox.restore(soloHoldings);

  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length === 0,
    'cambiar solo hLiq/hIdx/hBtc/hTem (campos que computeFlow no lee) no debe recalcular ninguna fila, corrio ' + spy.calls.length + ' vez/veces');
});

section('memoizacion: cambiar un campo que computeFlow SI consume (ingresoNum) SI recalcula la fila "actual"', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  sandbox.restore(snapCorto());
  sandbox.renderCompare();

  const distinto = snapCorto();
  distinto.inputs.ingresoNum += 137000;
  sandbox.restore(distinto);

  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length >= 1, 'cambiar ingresoNum (que SI consume computeFlow) debe recalcular la fila "actual", corrio ' + spy.calls.length + ' vez/veces');
});

section('mutacion: con la clave vieja (JSON.stringify(snap) entero), cambiar SOLO cartera real SI recalcularia', () => {
  // Reproduce el bug: la misma logica real de index.html, pero con la linea de la clave
  // de metricsFor revertida a la version vieja (todo el snapshot, sin flowInputsKey()).
  // Si este replace no encuentra nada, el mutante no mutó nada y el test no probaría
  // nada -> se corta ahi mismo con un mensaje claro en vez de dar un falso OK.
  const viejo = logicSrc.replace(
    "const key=years+'|'+flowInputsKey(snap);",
    "const key=years+'|'+JSON.stringify(snap);"
  );
  check(viejo !== logicSrc, 'el replace debe haber encontrado la linea de la clave real (si no, el mutante no mutó nada)');

  const { sandbox, documentStub } = loadSandbox(seedScenarios(), viejo);
  const spy = spyMcStats(sandbox);
  setHorizon(documentStub, 20);
  sandbox.restore(snapCorto());
  sandbox.renderCompare();

  const soloHoldings = snapCorto();
  soloHoldings.inputs.hLiq += 555555;
  soloHoldings.inputs.hIdx += 555555;
  soloHoldings.inputs.hBtc += 555555;
  soloHoldings.inputs.hTem += 555555;
  sandbox.restore(soloHoldings);

  spy.reset();
  sandbox.renderCompare();
  check(spy.calls.length >= 1,
    'con la clave vieja (snapshot entero), cambiar solo cartera real SI recalcularia (confirma que flowInputsKey() real hace falta), corrio ' + spy.calls.length + ' vez/veces');
});

// ---------------------------------------------------------------------------
// 4 y 5. Fila "actual" y coherencia de columnas con computeFlow.
// ---------------------------------------------------------------------------
section('fila "actual": existe, esta resaltada y refleja el estado vivo', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  setHorizon(documentStub, 20);
  sandbox.restore(snapLargo());
  sandbox.renderCompare();
  const out = documentStub.getElementById('cmpTable').innerHTML;
  check(/class="now"/.test(out), 'la fila del estado vivo debe llevar la clase "now" para resaltarse');
  check(/Actual/.test(out), 'la fila del estado vivo debe llamarse "Actual"');
});

section('columnas: exced e inv de la tabla coinciden con computeFlow(snap)', () => {
  const { sandbox } = loadSandbox(seedScenarios());
  const snap = snapCorto();
  const f = sandbox.computeFlow(snap);
  const m = sandbox.metricsFor(snap, 20);
  check(m.exced === f.exced, 'exced de la tabla (' + m.exced + ') debe ser el de computeFlow (' + f.exced + ')');
  check(m.inv === f.inv, 'inv de la tabla (' + m.inv + ') debe ser el de computeFlow (' + f.inv + ')');
  check(m.ownYears === f.years, 'ownYears debe ser el projYrs propio del escenario');
});

section('columnas: p10 <= p50 <= p90 y prob entre 0 y 100', () => {
  const { sandbox } = loadSandbox(seedScenarios());
  const m = sandbox.metricsFor(snapLargo(), 20);
  check(typeof m.p50 === 'number' && isFinite(m.p50), 'p50 debe ser un numero finito (el ultimo punto de la serie)');
  check(m.p10 <= m.p50 && m.p50 <= m.p90, 'debe cumplirse p10 <= p50 <= p90, fue ' + [m.p10, m.p50, m.p90].join(' / '));
  check(m.prob >= 0 && m.prob <= 100, 'prob debe estar entre 0 y 100, fue ' + m.prob);
});

// ---------------------------------------------------------------------------
// 5b. Defensa en profundidad de computeFlow() en si misma (independiente del
//     filtro de readScenarios()): llamadas DIRECTAS con un snap incompleto, sin
//     pasar por readScenarios(). Si el dia de mañana algun otro consumidor le pasa
//     un snap crudo a computeFlow()/metricsFor() sin sanear antes, esto confirma
//     que el throw original (`inputs.ingresoNum` con inputs undefined) ya no puede
//     pasar aunque el saneo en la fuente no haya corrido.
// ---------------------------------------------------------------------------
section('computeFlow(): un snap sin inputs/weights no tira (defensa en profundidad, sin pasar por readScenarios())', () => {
  const { sandbox } = loadSandbox();
  [{ v: 1 }, {}, { v: 1, inputs: 'no soy un objeto' }, { v: 1, weights: null }].forEach(snap => {
    let threw = false;
    let f = null;
    try { f = sandbox.computeFlow(snap); } catch (e) { threw = true; }
    check(!threw, 'computeFlow(' + JSON.stringify(snap) + ') no debe lanzar');
    check(f && typeof f === 'object', 'computeFlow(' + JSON.stringify(snap) + ') debe devolver un objeto de todas formas');
  });
});

section('metricsFor(): un snap sin inputs/weights no tira al llamarlo directo (sin pasar por readScenarios())', () => {
  const { sandbox } = loadSandbox();
  let threw = false;
  let m = null;
  try { m = sandbox.metricsFor({ v: 1 }, 20); } catch (e) { threw = true; }
  check(!threw, 'metricsFor({v:1}, 20) no debe lanzar aunque el snap no tenga inputs/weights');
  check(m && typeof m === 'object', 'metricsFor({v:1}, 20) debe devolver un objeto de metricas de todas formas');
});

section('renderCompare(): tercera red -- si metricsFor() fallara por cualquier motivo no previsto, esa fila sola se salta sin tirar abajo toda la tabla', () => {
  const { sandbox, documentStub } = loadSandbox(seedScenarios());
  setHorizon(documentStub, 20);
  // metricsFor es una `function` de top-level, igual que mcStats (ver spyMcStats
  // arriba): vive como propiedad del global del contexto, asi que reemplazarla ahi
  // hace que renderCompare() -que la resuelve por la cadena de scopes en cada
  // llamada- use la version reemplazada.
  const real = sandbox.metricsFor;
  sandbox.metricsFor = function (snap, years) {
    if (snap && snap.__forceFail) throw new Error('fallo forzado para el test');
    return real(snap, years);
  };
  const list = sandbox.readScenarios();
  list[0].snap.__forceFail = true; // "Corto" falla a proposito; "Largo" queda intacto
  sandbox.writeScenarios(list);

  let threw = false;
  try { sandbox.renderCompare(); } catch (e) { threw = true; }
  check(!threw, 'renderCompare() no debe lanzar aunque metricsFor() falle para una fila puntual');

  const out = documentStub.getElementById('cmpTable').innerHTML;
  check(/class="now"/.test(out), 'la fila "Actual" debe seguir apareciendo pese al fallo de otra fila');
  check(/no se pudo calcular/.test(out), 'la fila que fallo debe mostrar un aviso en vez de romper toda la tabla');
  check(/Largo/.test(out), 'la fila "Largo" (que no fallo) debe seguir calculandose normalmente pese al fallo de su vecina');
});

// ---------------------------------------------------------------------------
// 6. Escapado en la tabla.
// ---------------------------------------------------------------------------
section('escapado: un nombre con HTML se renderiza escapado tambien en la tabla', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const store = {
    cnf_scenarios_v1: JSON.stringify([{ name: evil, ts: 1752800000000, snap: snapCorto() }]),
  };
  const { sandbox, documentStub } = loadSandbox(store);
  setHorizon(documentStub, 20);
  sandbox.renderCompare();
  const out = documentStub.getElementById('cmpTable').innerHTML;
  check(!out.includes('<img src=x'), 'el nombre no puede inyectarse crudo en la tabla');
  check(out.includes('&lt;img'), 'el nombre debe aparecer escapado (&lt;img...)');
});

// ---------------------------------------------------------------------------
// 7. Tolerancia.
// ---------------------------------------------------------------------------
section('sin escenarios guardados: la tabla muestra solo la fila "actual" y no rompe', () => {
  const { sandbox, documentStub } = loadSandbox({});
  setHorizon(documentStub, 20);
  sandbox.renderCompare();
  const out = documentStub.getElementById('cmpTable').innerHTML;
  check(/class="now"/.test(out), 'debe seguir estando la fila "actual"');
  check(out.length > 0, 'la tabla no puede quedar vacia');
});

section('tolerancia: cnf_scenarios_v1 corrupto no rompe la tabla', () => {
  ['{no json', JSON.stringify({ noEsUnArray: true }), 'null'].forEach(raw => {
    const { sandbox, documentStub } = loadSandbox({ cnf_scenarios_v1: raw });
    setHorizon(documentStub, 20);
    sandbox.renderCompare();
    check(documentStub.getElementById('cmpTable').innerHTML.length > 0,
      'con cnf_scenarios_v1=' + raw.slice(0, 20) + ' la tabla debe renderizar igual');
  });
});

section('horizonte por defecto: sin valor en #cmpYrs cae en 20, nunca en 0 ni NaN', () => {
  const { sandbox } = loadSandbox(seedScenarios());
  const y = sandbox.cmpYears();
  check(y === 20, 'el horizonte por defecto debe ser 20, fue ' + y);
  check(Number.isFinite(y) && y >= 1, 'el horizonte nunca puede ser NaN ni menor a 1');
});

// ---------------------------------------------------------------------------
// 8. Horizonte por defecto: tiene que tomar el projYrs YA RESTAURADO desde
//    cnf_state_v1, no el default estatico "20" del HTML (hallazgo #2 de la revision).
//    El sync de #cmpYrs con #projYrs tiene que correr DESPUES de bootState().
// ---------------------------------------------------------------------------
section('horizonte por defecto: con un cnf_state_v1 guardado, arranca en el projYrs restaurado (no en el default estatico)', () => {
  const savedState = snapCorto();
  savedState.inputs = Object.assign({}, savedState.inputs, { projYrs: 12 });
  const { sandbox } = loadSandbox({ cnf_state_v1: JSON.stringify(savedState) });
  const y = sandbox.cmpYears();
  check(y === 12, 'cmpYears() debe arrancar en el projYrs restaurado por bootState() (12), no en el default estatico del HTML (20), fue ' + y);
});

// ---------------------------------------------------------------------------
// 9. Camino real del listener de #cmpYrs (hallazgo #3): arrastrar el slider dispara
//    muchos eventos "input" nativos. Ninguno de ellos puede correr mcStats (500 paths
//    por fila) sincronicamente -eso es lo que hacia el codigo viejo con
//    addEventListener('input',renderCompare) directo-, tiene que quedar debounceado
//    via scheduleCompare(). La etiqueta #cmpYrsVal si se actualiza al toque, sin
//    esperar el debounce (feedback visual del slider). Los tests de arriba nunca
//    disparan el addEventListener real -por eso este bug no se detecto antes-, asi
//    que esta seccion usa dispatch('input') sobre el elemento real, no una llamada
//    directa a renderCompare().
// ---------------------------------------------------------------------------
function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function listenerAsyncChecks() {
  try {
    const { sandbox, documentStub } = loadSandbox(seedScenarios());
    const spy = spyMcStats(sandbox);
    const c = documentStub.getElementById('cmpYrs');
    const lab = documentStub.getElementById('cmpYrsVal');

    // mcStats es global y lo comparten dos debounces independientes: el de esta tabla
    // (scheduleCompare, 150ms) y el del panel de metas/rebalanceo (scheduleMC, 110ms,
    // disparado por el render() inicial del arranque). Dejamos asentar ese primero,
    // igual que hace test/persistencia.js con drawMC, para no confundirlo con el que
    // estamos midiendo.
    await wait(150);
    spy.reset();

    c.value = '25';
    spy.reset();
    c.dispatch('input'); // el listener real registrado con addEventListener durante la carga
    check(spy.calls.length === 0, 'el evento "input" real sobre #cmpYrs no debe correr mcStats sincronicamente (debe quedar debounceado)');
    check(lab.textContent === '25 años', 'la etiqueta #cmpYrsVal debe reflejar el horizonte nuevo de inmediato aunque el calculo pesado este debounceado, fue "' + lab.textContent + '"');

    await wait(200); // > los 150ms de debounce de scheduleCompare()
    check(spy.calls.length >= 3, 'tras el debounce, el evento "input" real debe terminar corriendo mcStats (via scheduleCompare -> renderCompare), corrio ' + spy.calls.length + ' vez/veces');
    check(spy.yearsSeen().every(y => y === 25), 'el calculo debounceado debe usar el horizonte nuevo (25), no uno viejo');
    console.log('OK   listener real de #cmpYrs: debounce via scheduleCompare() + etiqueta inmediata');
  } catch (e) {
    failures++;
    console.log('FAIL listener real de #cmpYrs: debounce via scheduleCompare() + etiqueta inmediata');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}

// ---------------------------------------------------------------------------
// 10. Defensa en profundidad (bug de verificacion independiente sobre bd5eaca): el
//     saneo de bd5eaca solo validaba que s.snap FUERA un objeto, no que tuviera la
//     forma que computeFlow() necesita. Un escenario como
//     {"name":"buena","ts":1,"snap":{"v":1}} pasaba ese filtro (snap es un objeto)
//     y despues metricsFor(s.snap) -> computeFlow(snap) hacia `inputs.ingresoNum`
//     con inputs undefined -> TypeError.
//
//     Critico: ese throw pasa DENTRO del setTimeout de scheduleCompare(), no en una
//     llamada directa a renderCompare() -por eso estos checks disparan el camino
//     real (scheduleCompare()/render(), nunca renderCompare() a mano) y esperan el
//     debounce con wait(), igual que la seccion 9 de arriba. Si solo llamaramos
//     renderCompare() sincronicamente, el try/catch del harness (section/try-catch
//     de arriba) taparia el throw y no reproduciriamos las condiciones reales: en
//     produccion ese throw ocurre suelto en el event loop, sin ningun try/catch
//     alrededor, y ahi es donde de verdad mata el tablero en silencio.
// ---------------------------------------------------------------------------
async function malformedSnapAsyncChecks() {
  try {
    const store = {
      cnf_scenarios_v1: JSON.stringify([
        null,
        {},
        { name: 'sin snap' },
        // el caso exacto reportado: snap es un objeto (pasa el filtro viejo de
        // bd5eaca) pero no tiene inputs ni weights.
        { name: 'buena', ts: 1, snap: { v: 1 } },
        // inputs presente pero del tipo equivocado (no objeto).
        { name: 'inputs no objeto', ts: 1, snap: { v: 1, inputs: 'no soy un objeto', weights: { liq: 25, idx: 25, btc: 25, tem: 25 } } },
        // weights ausente directamente.
        { name: 'sin weights', ts: 1, snap: { v: 1, inputs: snapCorto().inputs } },
        // un escenario sano de verdad, para confirmar que sigue funcionando
        // apesar de sus vecinos rotos en el mismo array.
        { name: 'ok', ts: 1, snap: snapCorto() },
      ]),
    };
    const { sandbox, documentStub } = loadSandbox(store);
    setHorizon(documentStub, 20);

    let caught = null;
    const onUncaught = (err) => { caught = err; };
    process.on('uncaughtException', onUncaught);

    // camino real: scheduleCompare() arma el setTimeout de 150ms, exactamente lo
    // que dispara render()/renderScenarios() en la app de verdad. No llamamos
    // renderCompare() directo.
    sandbox.scheduleCompare();
    await wait(250); // > 150ms del debounce

    process.removeListener('uncaughtException', onUncaught);

    check(caught === null,
      'un escenario con snap incompleto (sin inputs/weights, o con inputs de tipo invalido) no debe tirar una excepcion no capturada dentro del timer de scheduleCompare(); tiro: ' + (caught && caught.stack));

    const out = documentStub.getElementById('cmpTable').innerHTML;
    check(/class="now"/.test(out), 'pese a los escenarios malformados, la tabla debe seguir mostrando la fila "Actual"');
    check(out.includes('ok'), 'el unico escenario sano ("ok") debe seguir apareciendo en la tabla pese a sus vecinos rotos');
    console.log('OK   defensa en profundidad: snaps incompletos no rompen el timer real de scheduleCompare()');
  } catch (e) {
    failures++;
    console.log('FAIL defensa en profundidad: snaps incompletos no rompen el timer real de scheduleCompare()');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}

// ---------------------------------------------------------------------------
listenerAsyncChecks().then(malformedSnapAsyncChecks).then(() => {
  console.log('');
  console.log(checks + ' aserciones corridas.');
  if (failures) {
    console.log(failures + ' seccion(es) fallaron.');
    process.exit(1);
  }
  console.log('Todo OK.');
  process.exit(0);
});
