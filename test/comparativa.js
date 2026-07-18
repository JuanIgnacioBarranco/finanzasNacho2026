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

function loadSandbox(initialStore) {
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
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic-comparativa' });
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
    v: 1, perfil: 'arriesgado', plazo: 'corto',
    weights: { liq: 5, idx: 35, btc: 40, tem: 20 },
    inputs: {
      ingresoNum: 2345000, gAlq: 610000, gCom: 280000, gImp: 190000,
      cuotas: 75000, pctInv: 65, objYa: 1200000, objMud: 4100000,
      projYrs: 10, projP0: 300000, projGoal: 80000000,
      hLiq: 111111, hIdx: 222222, hBtc: 333333, hTem: 444444,
    },
    goals: [{ name: 'Auto', usd: 18000, years: 3 }],
  };
}
function snapLargo() {
  return {
    v: 1, perfil: 'conservador', plazo: 'largo',
    weights: { liq: 60, idx: 25, btc: 5, tem: 10 },
    inputs: {
      ingresoNum: 1500000, gAlq: 500000, gCom: 300000, gImp: 200000,
      cuotas: 250000, pctInv: 80, objYa: 3900000, objMud: 3500000,
      projYrs: 30, projP0: 0, projGoal: 50000000,
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
console.log('');
console.log(checks + ' aserciones corridas.');
if (failures) {
  console.log(failures + ' seccion(es) fallaron.');
  process.exit(1);
}
console.log('Todo OK.');
