// Draws the tray (template) and app icons as PNGs without any image library.
// Run: bun scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 4; // supersampling for anti-aliasing
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const [r, g, b, a] = pixel((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / (S * S);
      raw[o] = acc[3] ? acc[0] / acc[3] : 0;
      raw[o + 1] = acc[3] ? acc[1] / acc[3] : 0;
      raw[o + 2] = acc[3] ? acc[2] / acc[3] : 0;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inTri = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = d(px, py, ax, ay, bx, by), d2 = d(px, py, bx, by, cx, cy), d3 = d(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** Cat head silhouette in a 0..1 box: ears + face, eyes cut out. */
function cat(x, y) {
  const head = inEllipse(x, y, 0.5, 0.6, 0.42, 0.34);
  const ears = inTri(x, y, [0.1, 0.08], [0.12, 0.55], [0.45, 0.35]) || inTri(x, y, [0.9, 0.08], [0.88, 0.55], [0.55, 0.35]);
  const eyes = inEllipse(x, y, 0.34, 0.58, 0.06, 0.085) || inEllipse(x, y, 0.66, 0.58, 0.06, 0.085);
  const nose = inTri(x, y, [0.45, 0.7], [0.55, 0.7], [0.5, 0.77]);
  return (head || ears) && !eyes && !nose;
}

mkdirSync('resources', { recursive: true });
// Template images: black + alpha; macOS tints them for light/dark menu bars.
for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]) {
  writeFileSync(`resources/${name}`, png(size, (x, y) => [0, 0, 0, cat(0.05 + x * 0.9, 0.05 + y * 0.9) ? 1 : 0]));
}
// Status variant with a dot (some sites running).
for (const [name, size] of [['trayActiveTemplate.png', 18], ['trayActiveTemplate@2x.png', 36]]) {
  writeFileSync(`resources/${name}`, png(size, (x, y) => {
    const dot = inEllipse(x, y, 0.84, 0.84, 0.16, 0.16);
    const ring = inEllipse(x, y, 0.84, 0.84, 0.25, 0.25);
    const c = cat(0.02 + x * 0.9, 0.02 + y * 0.9) && !ring;
    return [0, 0, 0, c || dot ? 1 : 0];
  }));
}
// App icon: rounded square, indigo → violet gradient, white cat.
writeFileSync('resources/icon.png', png(1024, (x, y) => {
  const r = 0.2, m = 0.06;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - m - r), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - m - r), 0);
  if (Math.hypot(qx, qy) > r) return [0, 0, 0, 0];
  if (cat((x - 0.2) / 0.6, (y - 0.18) / 0.6)) return [255, 255, 255, 1];
  const t = (x + y) / 2;
  return [99 + (139 - 99) * t, 102 + (92 - 102) * t, 241 + (246 - 241) * t, 1];
}));
console.log('icons written');
