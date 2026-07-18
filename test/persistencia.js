// Test de persistencia total del estado — mejora #5, tarea 2.
//
// Mismo patron que test/equivalencia.js: Node puro + vm.Script, sin frameworks.
// Corre con: node test/persistencia.js
//
// Que verifica (ver .superpowers/sdd/task-2-brief.md, seccion "Verificacion obligatoria"):
//  1. Round-trip: restore(snapshot()) deja el estado identico, sobre un estado no trivial.
//  2. Independencia de referencias: mutar el snapshot guardado no debe alterar el estado
//     vivo ni al reves (antes Y despues de restore(), que es el riesgo nuevo de esta tarea).
//  3. Tolerancia a basura: restore() con null/{}/{v:99}/tipos raros/goals no-array/inputs
//     no numericos no revienta y deja el tablero usable; idem con localStorage corrupto.
//  4. Migracion: sin cnf_state_v1 y con cnf_holdings, los 4 inputs de cartera migran.
//  5. Precedencia: con ambas claves, gana cnf_state_v1 (incluso sobre los 4 de cartera).
//  6. #lockPass nunca se persiste (ni la clave ni el valor entran al JSON guardado).
//
// Nota sobre el corte del script: a diferencia de equivalencia.js (que corta ANTES del
// bloque de wiring final para no necesitar un stub de DOM completo), esta suite SI
// necesita que corra el wiring de arranque (bootState() se dispara solo al cargar el
// script, leyendo el localStorage-stub ya poblado ANTES de crear el sandbox). Por eso
// se corta un poco mas tarde, justo antes de la unica linea "loadPrices();" del final
// (la que hace fetch de verdad) — pxBtn.onclick=loadPrices sigue siendo una asignacion,
// no una llamada, asi que no dispara red.

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
// Cortamos justo antes de la ultima invocacion real "loadPrices();" (con parentesis;
// no confundir con la asignacion "onclick=loadPrices;", que no tiene parentesis y no
// matchea este marcador). Todo lo anterior -incluida la siembra de holdings, bootState()
// y los addEventListener delegados de autosave- se ejecuta al cargar el sandbox.
const CUT_MARKER = 'loadPrices();';
const cutIdx = bigScript.lastIndexOf(CUT_MARKER);
if (cutIdx === -1) {
  console.log('FAIL setup: no se encontro el marcador de corte "' + CUT_MARKER + '"');
  process.exit(1);
}
const logicSrc = bigScript.slice(0, cutIdx);

// ---------------------------------------------------------------------------
// Stubs de DOM y localStorage
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
// `store`, un objeto plano que el test puede poblar ANTES de llamar a esta funcion para
// simular localStorage previo) y su propio DOM-stub. bootState() se dispara solo al
// cargar logicSrc (es la ultima linea real antes del corte), asi que `store` debe estar
// listo antes de invocar loadSandbox().
function loadSandbox(initialStore) {
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
  const sandbox = {
    document: documentStub,
    localStorage: localStorageStub,
    console,
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic-persistencia' });
  return { sandbox, documentStub, ctx, store, perfilButtons, plazoButtons, docListeners };
}

// normalize: los snapshots "fuente" que este archivo escribe como literales viven en
// el realm de ESTE proceso Node, pero snapshot()/restore() corren dentro de un
// vm.createContext (otro realm) — sus objetos anidados (weights/inputs/goals) quedan
// con un [[Prototype]] distinto aunque los datos sean identicos, y assert.deepStrictEqual
// los rechaza por eso solo (mismo caso que documenta test/equivalencia.js para goals).
// Comparar vía JSON evita ese falso negativo sin perder rigor sobre los datos.
function normalize(x) { return JSON.parse(JSON.stringify(x)); }

// Snapshot "no trivial" reusado en varias secciones: perfil/plazo distintos del
// default, pesos desparejos, metas editadas, y los 15 inputs con valores propios.
function nonTrivialSnapshot() {
  return {
    v: 1,
    perfil: 'arriesgado',
    plazo: 'corto',
    weights: { liq: 5, idx: 35, btc: 40, tem: 20 },
    inputs: {
      ingresoNum: 2345000, gAlq: 610000, gCom: 280000, gImp: 190000,
      cuotas: 75000, pctInv: 65,
      objYa: 1200000, objMud: 4100000,
      projYrs: 12, projP0: 300000, projGoal: 80000000,
      hLiq: 111111, hIdx: 222222, hBtc: 333333, hTem: 444444,
    },
    goals: [
      { name: 'Auto', usd: 18000, years: 3 },
      { name: 'Casa propia', usd: 120000, years: 10 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Round-trip: restore(snapshot()) deja el estado identico
// ---------------------------------------------------------------------------
section('round-trip: restore(snapshot()) reproduce un estado no trivial', () => {
  const { sandbox } = loadSandbox({});
  const src = nonTrivialSnapshot();

  sandbox.restore(src);
  const snap1 = sandbox.snapshot();
  assert.strictEqual(snap1.perfil, 'arriesgado');
  assert.strictEqual(snap1.plazo, 'corto');
  assert.deepStrictEqual(normalize(snap1.weights), src.weights);
  assert.deepStrictEqual(normalize(snap1.inputs), src.inputs);
  assert.deepStrictEqual(normalize(snap1.goals), src.goals);

  // Alejamos el estado del snapshot original para probar que restore() de verdad
  // vuelve a aplicarlo (no que snap1 ya coincidia por casualidad con los defaults).
  sandbox.restore({
    v: 1, perfil: 'conservador', plazo: 'largo',
    weights: { liq: 90, idx: 5, btc: 3, tem: 2 },
    inputs: { ingresoNum: 1, gAlq: 1, gCom: 1, gImp: 1, cuotas: 1, pctInv: 1, objYa: 1, objMud: 1, projYrs: 1, projP0: 1, projGoal: 1, hLiq: 1, hIdx: 1, hBtc: 1, hTem: 1 },
    goals: [{ name: 'Otra', usd: 1, years: 1 }],
  });
  const midway = sandbox.snapshot();
  check(midway.perfil === 'conservador', 'sanity: el estado intermedio debe haber cambiado');

  // round-trip real: restore(snapshot()) sobre el snapshot original debe reproducirlo.
  sandbox.restore(src);
  const snap2 = sandbox.snapshot();
  assert.deepStrictEqual(snap2, snap1);

  // Y snapshot() otra vez sobre el estado ya restaurado (restore(snapshot())) debe
  // seguir siendo un fixpoint.
  const snap3 = sandbox.snapshot();
  sandbox.restore(snap3);
  const snap4 = sandbox.snapshot();
  assert.deepStrictEqual(snap4, snap3);
});

// ---------------------------------------------------------------------------
// 2. Independencia de referencias (antes Y despues de restore)
// ---------------------------------------------------------------------------
section('independencia de referencias: snapshot() no alias-ea el estado vivo', () => {
  const { sandbox, ctx } = loadSandbox({});
  const snap = sandbox.snapshot();
  const liveState = vm.runInContext('state', ctx);
  const liveGoals = vm.runInContext('goals', ctx);

  check(snap.weights !== liveState.weights, 'snap.weights no debe ser el mismo objeto que state.weights');
  const origLiq = liveState.weights.liq;
  snap.weights.liq = origLiq + 777;
  check(liveState.weights.liq === origLiq, 'mutar snap.weights no debe afectar state.weights');
  snap.weights.liq = origLiq;

  check(snap.goals[0] !== liveGoals[0], 'snap.goals[0] no debe ser el mismo objeto que goals[0]');
  const origUsd = liveGoals[0].usd;
  snap.goals[0].usd = origUsd + 999;
  check(liveGoals[0].usd === origUsd, 'mutar snap.goals[0] no debe afectar goals[0] vivo');
});

section('independencia de referencias: restore(s) copia s.weights/s.goals, no los referencia', () => {
  // Este es el riesgo NUEVO de la tarea 2 (vs. el de readDOM en tarea 1): si restore()
  // hiciera `state.weights = s.weights` en vez de copiar, dos escenarios "guardados"
  // que compartan el mismo objeto de origen (p.ej. releidos del mismo JSON.parse, o el
  // propio objeto que el llamador guarda en un array de escenarios en tarea 3)
  // terminarian pisandose entre si con solo tocar el tablero.
  const { sandbox, ctx } = loadSandbox({});
  const src = nonTrivialSnapshot();
  const srcWeightsRef = src.weights, srcGoal0Ref = src.goals[0];

  sandbox.restore(src);
  const liveState = vm.runInContext('state', ctx);
  const liveGoals = vm.runInContext('goals', ctx);

  check(liveState.weights !== srcWeightsRef, 'state.weights no debe ser el mismo objeto que el s.weights pasado a restore()');
  check(liveGoals[0] !== srcGoal0Ref, 'goals[0] no debe ser el mismo objeto que s.goals[0] pasado a restore()');

  // mutar el snapshot ORIGINAL despues de restaurarlo no debe alterar el estado vivo
  srcWeightsRef.liq += 500;
  srcGoal0Ref.usd += 500;
  check(liveState.weights.liq !== srcWeightsRef.liq, 'mutar s.weights despues de restore() no debe afectar state.weights (aliasing)');
  check(liveGoals[0].usd !== srcGoal0Ref.usd, 'mutar s.goals[0] despues de restore() no debe afectar goals[0] (aliasing)');

  // y al reves: mutar el estado vivo no debe alterar el snapshot que quedo guardado
  // en manos del llamador (mismo objeto `src` de arriba)
  const beforeSrcLiq = srcWeightsRef.liq;
  liveState.weights.liq += 321;
  check(srcWeightsRef.liq === beforeSrcLiq, 'mutar state.weights despues de restore() no debe afectar el s.weights original');
});

// ---------------------------------------------------------------------------
// 3. Tolerancia a basura
// ---------------------------------------------------------------------------
section('tolerancia: restore() con datos basura no revienta y deja el tablero usable', () => {
  const { sandbox, ctx } = loadSandbox({});
  const garbageInputs = [
    null, undefined, {}, { v: 99 }, 'not json{', 42, [], { v: 1, goals: 'not-array' },
    { v: 1, inputs: { ingresoNum: 'abc', gAlq: NaN, gCom: undefined, gImp: {} } },
    { v: 1, perfil: 'bitcoinmaximalista', plazo: 123, weights: null },
    { v: 1, weights: { liq: 'x', idx: null, btc: undefined, tem: [] } },
    { v: 1, goals: [null, 42, 'x', { years: 'no-numero' }, { name: 5, usd: 'no', years: null }] },
  ];
  garbageInputs.forEach((g, i) => {
    let threw = false;
    try { sandbox.restore(g); } catch (e) { threw = true; }
    check(!threw, 'restore() no debe lanzar con entrada basura #' + i + ': ' + JSON.stringify(g));
  });

  // el tablero sigue "usable": state tiene perfil/plazo/weights validos y render() no explota.
  const liveState = vm.runInContext('state', ctx);
  check(typeof liveState.perfil === 'string' && liveState.perfil.length > 0, 'state.perfil debe seguir siendo un string valido tras la basura');
  check(typeof liveState.plazo === 'string' && liveState.plazo.length > 0, 'state.plazo debe seguir siendo un string valido tras la basura');
  ['liq', 'idx', 'btc', 'tem'].forEach(k => {
    check(typeof liveState.weights[k] === 'number' && Number.isFinite(liveState.weights[k]), 'state.weights.' + k + ' debe seguir siendo numerico tras la basura');
  });
  const liveGoals = vm.runInContext('goals', ctx);
  check(Array.isArray(liveGoals), 'goals debe seguir siendo un array tras la basura');

  let renderThrew = false;
  try { sandbox.render(); } catch (e) { renderThrew = true; }
  check(!renderThrew, 'render() no debe lanzar despues de una racha de restore() con basura');
});

section('tolerancia: {v:1} parcial (sin weights/inputs/goals) conserva el resto del estado actual', () => {
  const { sandbox, ctx } = loadSandbox({});
  sandbox.restore({ v: 1, perfil: 'arriesgado', plazo: 'corto', weights: { liq: 1, idx: 2, btc: 3, tem: 4 }, inputs: { ingresoNum: 999 }, goals: [{ name: 'X', usd: 1, years: 1 }] });
  const before = vm.runInContext('state', ctx);
  check(before.perfil === 'arriesgado', 'sanity pre-condicion');

  sandbox.restore({ v: 1 }); // snapshot valido pero sin ningun campo de datos
  const after = vm.runInContext('state', ctx);
  check(after.perfil === 'arriesgado', 'perfil no debe resetearse cuando el snapshot no trae perfil');
  check(after.plazo === 'corto', 'plazo no debe resetearse cuando el snapshot no trae plazo');
  check(after.weights.liq === 1 && after.weights.idx === 2, 'weights no debe resetearse cuando el snapshot no trae weights');
  const goalsAfter = vm.runInContext('goals', ctx);
  check(goalsAfter.length === 1 && goalsAfter[0].name === 'X', 'goals no debe resetearse cuando el snapshot no trae goals');
});

section('tolerancia: localStorage con JSON corrupto en cnf_state_v1 no rompe el arranque', () => {
  let threw = false;
  let sandboxResult = null;
  try {
    sandboxResult = loadSandbox({ cnf_state_v1: '{"v":1, esto no es json valido' });
  } catch (e) { threw = true; }
  check(!threw, 'cargar el sandbox con cnf_state_v1 corrupto no debe lanzar (bootState debe tragarselo)');
  if (sandboxResult) {
    const liveState = vm.runInContext('state', sandboxResult.ctx);
    check(typeof liveState.perfil === 'string', 'con localStorage corrupto el arranque debe caer al default (perfil moderado)');
    check(liveState.perfil === 'moderado', 'perfil default esperado moderado con cnf_state_v1 corrupto, fue ' + liveState.perfil);
  }
});

// ---------------------------------------------------------------------------
// 4. Migracion: sin cnf_state_v1, cnf_holdings siembra los 4 inputs de cartera
// ---------------------------------------------------------------------------
section('migracion: sin cnf_state_v1 y con cnf_holdings, los 4 inputs de cartera migran', () => {
  const holdings = { liq: 111, idx: 222, btc: 333, tem: 444 };
  const { documentStub } = loadSandbox({ cnf_holdings: JSON.stringify(holdings) });
  check(+documentStub.getElementById('hLiq').value === 111, 'hLiq debe migrar desde cnf_holdings, fue ' + documentStub.getElementById('hLiq').value);
  check(+documentStub.getElementById('hIdx').value === 222, 'hIdx debe migrar desde cnf_holdings');
  check(+documentStub.getElementById('hBtc').value === 333, 'hBtc debe migrar desde cnf_holdings');
  check(+documentStub.getElementById('hTem').value === 444, 'hTem debe migrar desde cnf_holdings');
});

// ---------------------------------------------------------------------------
// 5. Precedencia: con ambas claves presentes, gana cnf_state_v1
// ---------------------------------------------------------------------------
section('precedencia: con cnf_state_v1 y cnf_holdings presentes, gana cnf_state_v1', () => {
  const holdingsViejo = { liq: 1, idx: 2, btc: 3, tem: 4 };
  const src = nonTrivialSnapshot(); // hLiq:111111, hIdx:222222, hBtc:333333, hTem:444444
  const { documentStub, ctx } = loadSandbox({
    cnf_holdings: JSON.stringify(holdingsViejo),
    cnf_state_v1: JSON.stringify(src),
  });
  check(+documentStub.getElementById('hLiq').value === 111111, 'hLiq debe venir de cnf_state_v1, no de cnf_holdings, fue ' + documentStub.getElementById('hLiq').value);
  check(+documentStub.getElementById('hIdx').value === 222222, 'hIdx debe venir de cnf_state_v1');
  check(+documentStub.getElementById('hBtc').value === 333333, 'hBtc debe venir de cnf_state_v1');
  check(+documentStub.getElementById('hTem').value === 444444, 'hTem debe venir de cnf_state_v1');
  const liveState = vm.runInContext('state', ctx);
  check(liveState.perfil === 'arriesgado', 'el resto del estado (perfil) tambien debe venir de cnf_state_v1');
  check(liveState.plazo === 'corto', 'el resto del estado (plazo) tambien debe venir de cnf_state_v1');
});

// ---------------------------------------------------------------------------
// 6. #lockPass nunca se persiste
// ---------------------------------------------------------------------------
section('#lockPass nunca entra al snapshot ni al JSON guardado en localStorage', () => {
  const { sandbox, documentStub, store } = loadSandbox({});
  const SECRET = 'clave-super-secreta-123';
  documentStub.getElementById('lockPass').value = SECRET;

  const snap = sandbox.snapshot();
  const asJson = JSON.stringify(snap);
  check(!asJson.includes('lockPass'), 'el snapshot no debe mencionar la clave "lockPass"');
  check(!asJson.includes(SECRET), 'el snapshot no debe contener el valor de #lockPass');
  check(!Object.keys(snap.inputs).includes('lockPass'), 'snap.inputs no debe tener la clave lockPass');
  check(!Object.keys(snap).includes('lockPass'), 'snap no debe tener una clave lockPass de nivel superior');
});

// ---------------------------------------------------------------------------
// 6b. Lo mismo pero de punta a punta: scheduleSave() real (con su debounce de 250ms)
//     tampoco debe dejar "lockPass" en lo que efectivamente queda escrito en
//     localStorage. Es async porque hay que esperar el debounce real.
// ---------------------------------------------------------------------------
function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function asyncChecks() {
  try {
    const { sandbox, documentStub, store } = loadSandbox({});
    const SECRET = 'clave-super-secreta-456';
    documentStub.getElementById('lockPass').value = SECRET;
    documentStub.getElementById('ingresoNum').value = '1234567';
    sandbox.scheduleSave();
    check(store.cnf_state_v1 === undefined, 'scheduleSave() no debe escribir sincronicamente (debe respetar el debounce de 250ms)');
    await wait(320);
    const raw = store.cnf_state_v1;
    check(typeof raw === 'string' && raw.length > 0, 'scheduleSave() debe haber escrito cnf_state_v1 en localStorage tras el debounce');
    check(raw.indexOf('lockPass') === -1, 'el cnf_state_v1 escrito de verdad en localStorage no debe contener "lockPass"');
    check(raw.indexOf(SECRET) === -1, 'el cnf_state_v1 escrito de verdad en localStorage no debe contener el valor de #lockPass');
    console.log('OK   scheduleSave() real: debounce 250ms + #lockPass ausente del JSON efectivamente guardado');
  } catch (e) {
    failures++;
    console.log('FAIL scheduleSave() real: debounce + exclusion de #lockPass');
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e));
  }
}

// ---------------------------------------------------------------------------
// Fin
// ---------------------------------------------------------------------------
asyncChecks().then(() => {
  console.log('');
  console.log(checks + ' aserciones corridas.');
  if (failures > 0) {
    console.log(failures + ' seccion(es) fallaron.');
    process.exit(1);
  } else {
    console.log('Todo OK.');
    process.exit(0);
  }
});
