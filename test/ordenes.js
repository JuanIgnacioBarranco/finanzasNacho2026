// Test de la seleccion de precio de los CEDEARs para las ordenes del mes.
//
// Bug reproducido con datos reales (2026-07): la API data912 devuelve para cada CEDEAR
// un campo `c` (ultimo precio OPERADO) que vale 0 cuando el papel no opero ese dia
// —tipico de tickers de bajo volumen como CIBR/URA, o de cualquier papel fuera del
// horario de mercado, fines de semana y feriados—, aunque tenga precio en el libro
// (px_bid / px_ask). renderOrders usaba `c` a secas, asi que esos tickers caian en
// "precio no disponible" y quedaban sin orden pese a ser perfectamente comprables.
//
// cedPrice(x) centraliza la eleccion: usa el ultimo operado si existe y, si no, cae al
// ask (lo que pagas al comprar) y despues al bid. Corre con: node test/ordenes.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let failures = 0, checks = 0;
function section(name, fn){ try { fn(); console.log('OK   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0,4).join('\n     ') : e)); } }
function check(c, m){ checks++; assert.ok(c, m); }

const scriptBlocks = [];
{ const re = /<script>([\s\S]*?)<\/script>/g; let m; while ((m = re.exec(html))) scriptBlocks.push(m[1]); }
const bigScript = scriptBlocks.find(s => s.includes('function renderOrders'));
if (!bigScript) { console.log('FAIL setup: no encontre el bloque <script> con renderOrders'); process.exit(1); }
const logicSrc = bigScript.slice(0, bigScript.lastIndexOf('loadPrices();'));

function makeEl(id){ return { id, value:'', textContent:'', innerHTML:'', style:{}, dataset:{}, classList:{add(){},remove(){},contains:()=>false,toggle(){}}, addEventListener(){}, removeEventListener(){}, appendChild(){}, querySelector(){return makeEl('n');}, querySelectorAll(){return [];} }; }
function loadSandbox(){
  const cache = new Map();
  const sandbox = {
    document:{ getElementById:id=>{ if(!cache.has(id)) cache.set(id, makeEl(id)); return cache.get(id); }, createElement:makeEl, querySelectorAll:()=>[], documentElement:makeEl('d'), addEventListener(){} },
    localStorage:{ getItem:()=>null, setItem(){}, removeItem(){} },
    console, getComputedStyle:()=>({getPropertyValue:()=>'#000'}), setTimeout, clearTimeout, confirm:()=>true,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(logicSrc, ctx, { filename: 'index.html#logic-ordenes' });
  return sandbox;
}

const sb = loadSandbox();

section('cedPrice existe y es una funcion', () => {
  check(typeof sb.cedPrice === 'function', 'cedPrice debe existir en el scope del script');
});

section('usa el ultimo operado (c) cuando esta disponible', () => {
  check(sb.cedPrice({ c:19550, px_bid:19530, px_ask:19560 }) === 19550, 'con c>0 debe usar c');
});

section('BUG: c=0 con libro -> cae al ask (lo que pagas al comprar), no a 0', () => {
  check(sb.cedPrice({ c:0, px_bid:14550, px_ask:14610 }) === 14610, 'con c=0 y ask>0 debe usar el ask');
});

section('c=0 y ask=0 -> cae al bid', () => {
  check(sb.cedPrice({ c:0, px_bid:12140, px_ask:0 }) === 12140, 'con c=0 y ask=0 debe usar el bid');
});

section('sin ningun precio -> 0 (recien ahi es "no disponible")', () => {
  check(sb.cedPrice({ c:0, px_bid:0, px_ask:0 }) === 0, 'sin precios debe devolver 0');
  check(sb.cedPrice(undefined) === 0, 'un ticker ausente debe devolver 0, no romper');
  check(sb.cedPrice(null) === 0, 'null debe devolver 0');
});

section('ignora valores negativos o basura como si no existieran', () => {
  check(sb.cedPrice({ c:-5, px_bid:100, px_ask:110 }) === 110, 'un c negativo no es un precio valido -> ask');
  check(sb.cedPrice({ c:0, px_ask:'x', px_bid:100 }) === 100, 'un ask no-numerico se ignora -> bid');
});

console.log('');
console.log(checks + ' aserciones corridas.');
if (failures) { console.log(failures + ' seccion(es) fallaron.'); process.exit(1); }
console.log('Todo OK.');
