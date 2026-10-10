// Generates icons/icon{16,32,48,128}.png: a white bookmark ribbon on a rounded
// indigo square. No dependencies; the PNG is encoded by hand with node's zlib.
//   node scripts/make-icons.mjs

import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const BG = [79, 70, 229];
const FG = [255, 255, 255];
const SS = 4; // supersampling per axis

// Coordinates are 0..1 across the icon.
function inBackground(x, y) {
  const r = 0.2;
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
}

function inRibbon(x, y) {
  if (x < 0.3 || x > 0.7 || y < 0.2 || y > 0.8) return false;
  const notchTop = 0.62 + (0.18 * Math.abs(x - 0.5)) / 0.2;
  return y <= notchTop;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inRibbon(x, y)) fg++;
          else if (inBackground(x, y)) bg++;
        }
      }
      const covered = bg + fg;
      const o = row + 1 + px * 4;
      for (let c = 0; c < 3; c++) {
        raw[o + c] = covered ? Math.round((BG[c] * bg + FG[c] * fg) / covered) : 0;
      }
      raw[o + 3] = Math.round((255 * covered) / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size));
  console.log(`icons/icon${size}.png`);
}
