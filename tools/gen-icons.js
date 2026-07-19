// Generador de los íconos del manifest (PWA) — mejora #5, tarea 4.
//
// Por qué existe: el proyecto no tiene librerías de imágenes (ni las suma esta tarea),
// así que armamos los PNG a mano con el módulo `zlib` de Node (viene incluido, no hay
// que instalar nada). Un data-URI adentro del manifest hubiera evitado esto, pero tiene
// soporte irregular entre navegadores — por eso son archivos reales versionados acá.
//
// Diseño: simple a propósito. Fondo --bg (#0a0d13) del tablero + un círculo --gold
// (#f6b23a) centrado. Las variantes "any" (192/512) usan un círculo grande; la
// "maskable" (512) lo deja más chico y centrado, adentro de la "zona segura" que los
// sistemas operativos no recortan al enmascarar el ícono (radio ~40% del lado; acá
// usamos un margen extra de resguardo).
//
// Cómo correr: node tools/gen-icons.js   (regenera los 3 PNG en icons/)

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x0a, 0x0d, 0x13];   // --bg
const GOLD = [0xf6, 0xb2, 0x3a]; // --gold

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildPixels(size, radiusFactor) {
  const cx = size / 2, cy = size / 2, r = size * radiusFactor;
  const rowBytes = size * 3; // RGB, sin canal alpha
  const raw = Buffer.alloc((rowBytes + 1) * size);
  let pos = 0;
  // Tres barras ascendentes caladas en oscuro sobre el disco dorado: un circulo pelado
  // no se distingue de nada en la pantalla de inicio. Todo en proporciones de `size`
  // para que 192 y 512 salgan identicos salvo por la escala.
  const bw = size * 0.085, gap = size * 0.055;
  const base = cy + size * 0.165;                    // linea de piso de las barras
  const anchoTotal = bw * 3 + gap * 2;
  const x0 = cx - anchoTotal / 2;
  const alturas = [size * 0.135, size * 0.215, size * 0.30];
  const enBarra = (x, y) => {
    for (let i = 0; i < 3; i++) {
      const bx = x0 + i * (bw + gap);
      if (x >= bx && x < bx + bw && y <= base && y >= base - alturas[i]) return true;
    }
    return false;
  };

  for (let y = 0; y < size; y++) {
    raw[pos++] = 0; // byte de filtro por fila: 0 = None
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dx = px - cx, dy = py - cy;
      const dentro = Math.sqrt(dx * dx + dy * dy) <= r;
      const col = (dentro && !enBarra(px, py)) ? GOLD : BG;
      raw[pos++] = col[0]; raw[pos++] = col[1]; raw[pos++] = col[2];
    }
  }
  return raw;
}

function writePng(filePath, size, radiusFactor) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: truecolor RGB (sin alpha)
  ihdrData[10] = 0; // compresión
  ihdrData[11] = 0; // filtro
  ihdrData[12] = 0; // sin interlace
  const ihdr = chunk('IHDR', ihdrData);
  const raw = buildPixels(size, radiusFactor);
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));
  fs.writeFileSync(filePath, Buffer.concat([sig, ihdr, idat, iend]));
  console.log('  ' + path.relative(process.cwd(), filePath) + ` (${size}x${size})`);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

console.log('Generando íconos PWA...');
writePng(path.join(outDir, 'icon-192.png'), 192, 0.42);
writePng(path.join(outDir, 'icon-512.png'), 512, 0.42);
writePng(path.join(outDir, 'icon-maskable-512.png'), 512, 0.32); // radio menor: zona segura del recorte maskable
console.log('Listo.');
