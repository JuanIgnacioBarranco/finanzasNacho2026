// Test del modelo de inflacion — mejora #6.
//
// El aporte mensual se ingresa en pesos de hoy, pero la cartera rinde en DOLARES
// (los retornos de los buckets son en USD). El modelo proyecta en dolares:
//  - aporte inicial en USD = aporte_pesos / mep
//  - si "ajustás por inflación" (default): el aporte se mantiene en USD (decay=1)
//  - si "nominal fijo": el aporte en USD se licua a la tasa de inflacion (decay<1)
//  - el retorno de la cartera ya esta en USD
//  - las metas y el objetivo de proyeccion estan en USD
//
// mcStats/fvSeries/runGoalsMC aceptan un `decay` mensual opcional (default 1 = aporte
// constante = comportamiento previo). Corre con: node test/inflacion.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0, checks = 0;
function section(name, fn){ try { fn(); console.log('OK   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0,4).join('\n     ') : e)); } }
function check(c, m){ checks++; assert.ok(c, m); }
function near(a, b, tol, m){ checks++; assert.ok(Math.abs(a-b) <= tol, (m||'')+` (|${a}-${b}| > ${tol})`); }

const scriptBlocks = [];
{ const re = /<script>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) scriptBlocks.push(m[1]); }
const bigScript = scriptBlocks.find(s => s.includes('function mcStats'));
const logicSrc = bigScript.slice(0, bigScript.lastIndexOf('loadPrices();'));

function makeEl(id){ return { id, value:'', textContent:'', innerHTML:'', style:{}, dataset:{}, classList:{add(){},remove(){},contains:()=>false,toggle(){}}, addEventListener(){}, removeEventListener(){}, appendChild(){}, querySelector(){return makeEl('n');}, querySelectorAll(){return [];} }; }
function loadSandbox(){
  const cache = new Map();
  const sandbox = { document:{ getElementById:id=>{ if(!cache.has(id)) cache.set(id, makeEl(id)); return cache.get(id); }, createElement:makeEl, querySelectorAll:()=>[], documentElement:makeEl('d'), addEventListener(){} },
    localStorage:{ getItem:()=>null, setItem(){}, removeItem(){} }, console, getComputedStyle:()=>({getPropertyValue:()=>'#000'}), setTimeout, clearTimeout, confirm:()=>true };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic-inflacion' });
  return sandbox;
}
const sb = loadSandbox();

section('fvSeries: decay=1 (default) mantiene el comportamiento actual', () => {
  const a = sb.fvSeries(0, 100, 0.07, 120);
  const b = sb.fvSeries(0, 100, 0.07, 120, 1);
  check(a[a.length-1] === b[b.length-1], 'sin decay y con decay=1 deben coincidir');
});

section('fvSeries: decay<1 acumula MENOS que un aporte constante', () => {
  const cte = sb.fvSeries(0, 100, 0.07, 120, 1);
  const licua = sb.fvSeries(0, 100, 0.07, 120, Math.pow(1/1.30, 1/12)); // 30% anual
  check(licua[licua.length-1] < cte[cte.length-1], 'un aporte que se licua acumula menos');
  check(licua[licua.length-1] > 0, 'pero algo acumula');
});

section('aporteModel: en modo "infl" (ajustado) el aporte es constante en USD (decay=1)', () => {
  check(typeof sb.aporteModel === 'function', 'aporteModel debe existir');
  const m = sb.aporteModel({ invPesos:600000, P0pesos:0, mep:1500, inflA:0.30, modo:'infl' });
  near(m.C0usd, 400, 0.5, 'aporte inicial en USD = 600000/1500');
  check(m.decay === 1, 'modo infl -> decay 1 (constante en USD)');
});

section('aporteModel: en modo "fijo" el aporte se licua a la inflacion', () => {
  const m = sb.aporteModel({ invPesos:600000, P0pesos:0, mep:1500, inflA:0.30, modo:'fijo' });
  near(m.C0usd, 400, 0.5, 'aporte inicial igual');
  const esperado = Math.pow(1/1.30, 1/12);
  near(m.decay, esperado, 1e-9, 'modo fijo -> decay = (1+infl)^(-1/12) mensual');
});

section('aporteModel: convierte P0 de pesos a USD', () => {
  const m = sb.aporteModel({ invPesos:0, P0pesos:1500000, mep:1500, inflA:0.30, modo:'infl' });
  near(m.P0usd, 1000, 0.5, 'P0 en USD = 1.500.000 / 1500');
});

section('aporteModel: mep faltante usa un fallback razonable, no NaN', () => {
  const m = sb.aporteModel({ invPesos:600000, P0pesos:0, mep:0, inflA:0.30, modo:'infl' });
  check(isFinite(m.C0usd) && m.C0usd > 0, 'con mep=0 no debe dar NaN/Infinity');
});

section('mcStats: modo fijo da probabilidad MENOR que modo ajustado a largo plazo', () => {
  const base = { P0:0, muA:0.07, volA:0.16, years:25, goal:250000 };
  const aj  = sb.mcStats(Object.assign({}, base, { C:400, decay:1 }));
  const fij = sb.mcStats(Object.assign({}, base, { C:400, decay:Math.pow(1/1.30,1/12) }));
  check(aj.prob > fij.prob, `ajustado (${aj.prob}%) debe superar a nominal-fijo (${fij.prob}%) a 25 años`);
  check(fij.prob < 20, 'con el aporte licuandose 30%/año, la meta larga casi no se alcanza');
});

console.log('');
console.log(checks + ' aserciones corridas.');
if (failures) { console.log(failures + ' seccion(es) fallaron.'); process.exit(1); }
console.log('Todo OK.');
