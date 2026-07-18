// Test de equivalencia numerica — mejora #5, tarea 1 (refactor a funciones puras).
//
// No usa ningun framework: Node puro + vm.Script, que es el patron que ya usa
// este proyecto. Corre con: node test/equivalencia.js
//
// Que verifica:
//  0. Que TODOS los bloques <script> del index.html compilan sin error de sintaxis.
//  1. Que readDOM() arma el snapshot con la forma exacta pedida en el brief.
//  2. Que computeFlow(snap) da EXACTAMENTE los mismos numeros que la matematica
//     original (recalculada a mano en este archivo, con el mismo orden de
//     operaciones que index.html) para >=5 combinaciones de inputs, incluyendo
//     los casos borde pedidos: excedente negativo, pctInv=0, todos los pesos en
//     un solo activo, y weights sumando 0.
//  3. Que mcStats(a) cumple los invariantes de una corrida Monte Carlo (no se
//     puede comparar valor a valor porque randn() usa Math.random()):
//     p10 <= p50 <= p90 en cada punto, 0 <= prob <= 100 (ver nota de escala
//     abajo), y que con volA=0 el p50 final coincide con fvSeries() dentro de
//     una tolerancia chica (ahi la corrida es determinista pese al random,
//     porque el termino de ruido queda multiplicado por sm=0).
//
// Nota de escala en el invariante de prob: el brief pide "0 <= prob <= 1", pero
// el codigo actual (sin tocar, tal cual vivia adentro de drawMC) devuelve prob
// en escala 0-100 (`prob=100*reached/N`), porque asi se usa directo en el DOM
// (`Math.round(prob)+'%'`, umbrales 66/33). Como la consigna es "el refactor no
// puede cambiar ni un peso", se preservo la escala original y el invariante de
// este test se ajusto a 0 <= prob <= 100. Ver task-1-report.md para el detalle.

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
    console.log('     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e));
  }
}
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

// ---------------------------------------------------------------------------
// 0. Chequeo de sintaxis de TODO el archivo (todos los bloques <script>)
// ---------------------------------------------------------------------------
const scriptBlocks = [];
{
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scriptBlocks.push(m[1]);
}
section('sintaxis: index.html tiene bloques <script> parseables', () => {
  check(scriptBlocks.length >= 2, 'se esperaban al menos 2 bloques <script>, hubo ' + scriptBlocks.length);
  scriptBlocks.forEach((code, i) => {
    // new vm.Script() compila sin ejecutar -> valida sintaxis pura.
    new vm.Script(code, { filename: 'index.html#script-' + (i + 1) });
  });
});

// ---------------------------------------------------------------------------
// Extraccion del bloque grande de logica (el que tiene fmt/num/css/buckets/...)
// y stub de DOM minimo para poder cargarlo con vm y llegar a las funciones puras.
// Se corta ANTES de las invocaciones finales (pxBtn.onclick=loadPrices; ... ;
// buildAlloc(); render(); loadPrices();) para no tener que simular un DOM
// completo: computeFlow/readDOM/mcStats se prueban llamandolas directo, no via
// el pipeline de pintado.
// ---------------------------------------------------------------------------
const CUT_MARKER = "document.getElementById('pxBtn').onclick=loadPrices;";
const bigScript = scriptBlocks.find(s => s.includes('function computeFlow'));
if (!bigScript) {
  console.log('FAIL setup: no se encontro el bloque <script> con computeFlow en index.html');
  process.exit(1);
}
const cutIdx = bigScript.indexOf(CUT_MARKER);
if (cutIdx === -1) {
  console.log('FAIL setup: no se encontro el marcador de corte "' + CUT_MARKER + '" — ¿se renombro esa linea?');
  process.exit(1);
}
const logicSrc = bigScript.slice(0, cutIdx);

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
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector() { return makeElement(id + '>nested'); },
    querySelectorAll() { return []; },
  };
}

function loadSandbox() {
  const elCache = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elCache.has(id)) elCache.set(id, makeElement(id));
      return elCache.get(id);
    },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    querySelectorAll() { return []; },
    documentElement: makeElement('documentElement'),
  };
  const sandbox = {
    document: documentStub,
    console,
    // css(k) hace getComputedStyle(document.documentElement).getPropertyValue(k).trim();
    // no nos importa el color real para estos tests, cualquier string sirve.
    getComputedStyle() { return { getPropertyValue() { return '#000000'; } }; },
    setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic' });
  return { sandbox, documentStub };
}

// ---------------------------------------------------------------------------
// 1. readDOM() -> forma exacta del snapshot
// ---------------------------------------------------------------------------
section('readDOM(): forma exacta del snapshot', () => {
  const { sandbox, documentStub } = loadSandbox();
  const inputVals = {
    ingresoNum: 1500000, gAlq: 500000, gCom: 300000, gImp: 200000,
    cuotas: 250000, pctInv: 80,
    objYa: 3900000, objMud: 3500000,
    projYrs: 20, projP0: 0, projGoal: 50000000,
    hLiq: 111, hIdx: 222, hBtc: 333, hTem: 444,
  };
  Object.keys(inputVals).forEach(id => { documentStub.getElementById(id).value = String(inputVals[id]); });

  const snap = sandbox.readDOM();

  check(snap.v === 1, 'v debe ser 1, fue ' + snap.v);
  check(snap.perfil === 'moderado', 'perfil default esperado moderado, fue ' + snap.perfil);
  check(snap.plazo === 'largo', 'plazo default esperado largo, fue ' + snap.plazo);
  const expectedWeights = sandbox.preset('moderado', 'largo');
  assert.deepStrictEqual(snap.weights, expectedWeights, 'weights debe ser copia de preset(moderado,largo)');

  assert.deepStrictEqual(Object.keys(snap.inputs).sort(), Object.keys(inputVals).sort(), 'las claves de inputs deben ser exactamente las pedidas');
  Object.keys(inputVals).forEach(id => {
    check(snap.inputs[id] === inputVals[id], 'inputs.' + id + ' esperado ' + inputVals[id] + ' fue ' + snap.inputs[id]);
  });

  const expectedGoals = [
    { name: 'Viaje', usd: 3500, years: 2 },
    { name: 'Entrada depto', usd: 35000, years: 6 },
    { name: 'Libertad financiera', usd: 250000, years: 25 },
  ];
  // snap.goals se crea DENTRO del contexto vm (otro realm) y expectedGoals es
  // un literal del realm de este test: deepStrictEqual compara [[Prototype]]
  // y falla por eso aunque los datos sean iguales. Comparamos vía JSON en vez
  // de por identidad de prototipo.
  check(Array.isArray(snap.goals) && snap.goals.length === expectedGoals.length, 'goals debe tener ' + expectedGoals.length + ' elementos');
  check(JSON.stringify(snap.goals) === JSON.stringify(expectedGoals), 'goals debe reflejar el array goals con {name,usd,years}: ' + JSON.stringify(snap.goals));

  check(Object.keys(snap).sort().join(',') === ['v', 'perfil', 'plazo', 'weights', 'inputs', 'goals'].sort().join(','),
    'el snapshot no debe tener claves extra ni faltantes');
});

// ---------------------------------------------------------------------------
// 2. computeFlow(snap): equivalencia numerica exacta vs. matematica original
// ---------------------------------------------------------------------------
// Constantes copiadas 1:1 de index.html (buckets/VOL) para recalcular "a mano"
// dentro del test, en el MISMO orden de iteracion (liq, idx, btc, tem) que usa
// el codigo fuente, para que las sumas de punto flotante den bit a bit iguales.
const K = ['liq', 'idx', 'btc', 'tem'];
const BUCKET_META = {
  liq: { risk: 1, grow: 1, ret: 0 },
  idx: { risk: 3, grow: 4, ret: 7 },
  btc: { risk: 5, grow: 5, ret: 12 },
  tem: { risk: 4, grow: 5, ret: 8 },
};
const VOL = { liq: 0.01, idx: 0.15, btc: 0.70, tem: 0.24 };
const RHO = 0.4;

function handComputeFlow(inputs, weights) {
  const ingreso = inputs.ingresoNum;
  const gastos = inputs.gAlq + inputs.gCom + inputs.gImp;
  const cuotas = inputs.cuotas;
  const exced = ingreso - gastos - cuotas;
  const pct = inputs.pctInv;
  const inv = Math.max(0, Math.round(exced * pct / 100));

  const sum = K.reduce((a, k) => a + weights[k], 0) || 1;
  let risk = 0, grow = 0, ret = 0;
  K.forEach(k => {
    const frac = weights[k] / sum;
    risk += frac * BUCKET_META[k].risk;
    grow += frac * BUCKET_META[k].grow;
    ret += frac * BUCKET_META[k].ret;
  });
  let volSq = 0;
  K.forEach(a => K.forEach(b => {
    volSq += (weights[a] / sum) * (weights[b] / sum) * VOL[a] * VOL[b] * (a === b ? 1 : RHO);
  }));
  const volA = Math.sqrt(Math.max(0, volSq));

  const years = Math.max(1, Math.round(inputs.projYrs));
  const goal = inputs.projGoal;
  const P0 = inputs.projP0;

  return { exced, inv, ret, sum, volA, years, goal, P0, risk, grow };
}

const scenarios = [
  {
    name: 'caso base (valores default de la UI)',
    weights: { liq: 15, idx: 55, btc: 15, tem: 15 },
    inputs: { ingresoNum: 1500000, gAlq: 500000, gCom: 300000, gImp: 200000, cuotas: 250000, pctInv: 80, objYa: 3900000, objMud: 3500000, projYrs: 20, projP0: 0, projGoal: 50000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
  {
    name: 'borde: excedente negativo',
    weights: { liq: 20, idx: 50, btc: 20, tem: 10 },
    inputs: { ingresoNum: 500000, gAlq: 400000, gCom: 300000, gImp: 200000, cuotas: 100000, pctInv: 50, objYa: 0, objMud: 0, projYrs: 10, projP0: 0, projGoal: 10000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
  {
    name: 'borde: pctInv = 0',
    weights: { liq: 30, idx: 40, btc: 20, tem: 10 },
    inputs: { ingresoNum: 2000000, gAlq: 500000, gCom: 300000, gImp: 200000, cuotas: 100000, pctInv: 0, objYa: 1000000, objMud: 500000, projYrs: 15, projP0: 200000, projGoal: 30000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
  {
    name: 'borde: todos los pesos en un solo activo (btc)',
    weights: { liq: 0, idx: 0, btc: 100, tem: 0 },
    inputs: { ingresoNum: 1000000, gAlq: 200000, gCom: 200000, gImp: 100000, cuotas: 0, pctInv: 100, objYa: 0, objMud: 0, projYrs: 5, projP0: 0, projGoal: 5000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
  {
    name: 'borde: weights sumando 0',
    weights: { liq: 0, idx: 0, btc: 0, tem: 0 },
    inputs: { ingresoNum: 1200000, gAlq: 300000, gCom: 200000, gImp: 100000, cuotas: 50000, pctInv: 60, objYa: 500000, objMud: 200000, projYrs: 8, projP0: 0, projGoal: 15000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
  {
    name: 'borde: projYrs fraccionario bajo (piso de 1 año) + P0 != 0',
    weights: { liq: 60, idx: 20, btc: 10, tem: 10 },
    inputs: { ingresoNum: 1800000, gAlq: 450000, gCom: 250000, gImp: 150000, cuotas: 80000, pctInv: 70, objYa: 100000, objMud: 500000, projYrs: 0.3, projP0: 500000, projGoal: 20000000, hLiq: 0, hIdx: 0, hBtc: 0, hTem: 0 },
  },
];

section('computeFlow(snap): equivalencia numerica exacta en ' + scenarios.length + ' escenarios', () => {
  const { sandbox } = loadSandbox();
  scenarios.forEach(sc => {
    const snap = { v: 1, perfil: 'moderado', plazo: 'largo', weights: { ...sc.weights }, inputs: { ...sc.inputs }, goals: [] };
    const got = sandbox.computeFlow(snap);
    const want = handComputeFlow(sc.inputs, sc.weights);

    ['exced', 'inv', 'ret', 'sum', 'volA', 'years', 'goal', 'P0', 'risk', 'grow'].forEach(key => {
      assert.strictEqual(got[key], want[key], '[' + sc.name + '] campo "' + key + '": esperado ' + want[key] + ', fue ' + got[key]);
    });
    assert.deepStrictEqual(got.w, sc.weights, '[' + sc.name + '] w debe reflejar los weights del snapshot');

    // cross-check independiente: volA tiene que coincidir tambien con portfolioVol(w,sum)
    // llamada directamente (la funcion pura que computeFlow debe reusar, no reimplementar).
    const volaViaPortfolioVol = sandbox.portfolioVol(sc.weights, want.sum);
    assert.strictEqual(got.volA, volaViaPortfolioVol, '[' + sc.name + '] volA debe ser exactamente portfolioVol(w,sum)');
  });
});

// ---------------------------------------------------------------------------
// 3. mcStats(a): invariantes (no determinista, usa Math.random() via randn())
// ---------------------------------------------------------------------------
section('mcStats(a): invariantes estadisticos (p10<=p50<=p90, 0<=prob<=100)', () => {
  const { sandbox } = loadSandbox();
  const mcScenarios = [
    { C: 200000, P0: 0, muA: 0.0685, volA: 0.10, years: 20, goal: 50000000 },
    { C: 0, P0: 1000000, muA: 0.05, volA: 0.30, years: 5, goal: 2000000 },
    { C: 150000, P0: 300000, muA: 0.08, volA: 0.45, years: 15, goal: 40000000 },
    { C: 500000, P0: 0, muA: 0.12, volA: 0.70, years: 1, goal: 1000000 },
  ];
  mcScenarios.forEach((a, idx) => {
    const r = sandbox.mcStats(a);
    check(Array.isArray(r.p10) && Array.isArray(r.p50) && Array.isArray(r.p90), 'mcStats debe devolver p10/p50/p90 como arrays (escenario ' + idx + ')');
    check(r.p10.length === r.p50.length && r.p50.length === r.p90.length, 'p10/p50/p90 deben tener la misma longitud (escenario ' + idx + ')');
    check(r.p10.length >= 2, 'las series deben tener al menos 2 puntos (escenario ' + idx + ')');
    for (let i = 0; i < r.p10.length; i++) {
      check(Number.isFinite(r.p10[i]) && Number.isFinite(r.p50[i]) && Number.isFinite(r.p90[i]), 'valores no finitos en indice ' + i + ' (escenario ' + idx + ')');
      check(r.p10[i] <= r.p50[i], 'p10<=p50 falla en indice ' + i + ' (escenario ' + idx + '): ' + r.p10[i] + ' > ' + r.p50[i]);
      check(r.p50[i] <= r.p90[i], 'p50<=p90 falla en indice ' + i + ' (escenario ' + idx + '): ' + r.p50[i] + ' > ' + r.p90[i]);
    }
    check(r.prob >= 0 && r.prob <= 100, 'prob fuera de [0,100] (escenario ' + idx + '): ' + r.prob);
  });
});

section('mcStats(a): con volA=0 el p50 final coincide con fvSeries (determinista)', () => {
  const { sandbox } = loadSandbox();
  const detScenarios = [
    { C: 150000, P0: 300000, muA: 0.08, years: 15, goal: 40000000 },
    { C: 0, P0: 1000000, muA: 0.05, years: 5, goal: 2000000 },
    { C: 200000, P0: 0, muA: 0.0685, years: 20, goal: 50000000 },
    { C: 0, P0: 0, muA: 0.05, years: 1, goal: 1000000 },
  ];
  detScenarios.forEach((s, idx) => {
    const a = { C: s.C, P0: s.P0, muA: s.muA, volA: 0, years: s.years, goal: s.goal };
    const r = sandbox.mcStats(a);
    const months = Math.max(1, Math.round(s.years * 12));
    const serie = sandbox.fvSeries(s.P0, s.C, s.muA, months);
    const expected = serie[months];
    const got = r.p50[r.p50.length - 1];
    const tol = Math.max(1e-6, Math.abs(expected) * 1e-6);
    check(Math.abs(got - expected) <= tol,
      '[det ' + idx + '] p50 final ' + got + ' vs fvSeries ' + expected + ' (tolerancia ' + tol + ')');
  });
});

// ---------------------------------------------------------------------------
// 4. Smoke test: render() (con el readDOM+computeFlow nuevo adentro) corre sin
//    tirar excepciones contra el stub de DOM. Los tests de arriba llaman
//    computeFlow/mcStats/readDOM directo, nunca a render() — esto cubre que el
//    "pintado" (buildAlloc/buildGoals/render) no haya quedado con una
//    referencia rota a algún campo de f.* (p.ej. un typo en el nombre).
// ---------------------------------------------------------------------------
section('render(): corre de punta a punta sin excepciones contra el stub de DOM', () => {
  const { sandbox } = loadSandbox();
  sandbox.buildAlloc();
  sandbox.buildGoals();
  sandbox.render();
  check(true, 'render() no tiro excepcion');
});

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
