import { deflateSync } from 'node:zlib';
import { nativeImage, type NativeImage } from 'electron';

/**
 * Small status dots for menu bar items (Services, Object Storage): soft,
 * anti-aliased circles in macOS's system colours instead of emoji. Drawn in
 * memory as PNGs (no image library), cached per colour.
 */
export type DotColor = 'green' | 'yellow' | 'red' | 'gray' | 'blue';

const COLORS: Record<DotColor, [number, number, number]> = {
  green: [52, 199, 89],
  yellow: [255, 204, 0],
  red: [255, 59, 48],
  gray: [142, 142, 147],
  blue: [10, 132, 255],
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA PNG of `size` px; `pixel(x, y)` in 0..1 returns [r, g, b, a]. 4×4 supersampling. */
function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const [r, g, b, a] = pixel((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          acc[0] += r * a;
          acc[1] += g * a;
          acc[2] += b * a;
          acc[3] += a;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = acc[3] ? acc[0] / acc[3] : 0;
      raw[o + 1] = acc[3] ? acc[1] / acc[3] : 0;
      raw[o + 2] = acc[3] ? acc[2] / acc[3] : 0;
      raw[o + 3] = Math.round((acc[3] / (S * S)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = new Map<string, NativeImage>();

/**
 * A 16 pt dot (drawn at 2×): filled circle with a faint outer glow and a
 * highlight, like macOS's traffic lights. `hollow` draws a ring (not running).
 */
export function dot(color: DotColor, hollow = false): NativeImage {
  const key = `${color}:${hollow}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [r, g, b] = COLORS[color];
  const size = 32;
  const buf = png(size, (x, y) => {
    const d = Math.hypot(x - 0.5, y - 0.5);
    if (hollow) {
      // Ring, 1.5 px at 2×.
      const inner = 0.19;
      const outer = 0.26;
      return d >= inner && d <= outer ? [r, g, b, 0.9] : [0, 0, 0, 0];
    }
    if (d <= 0.26) {
      // Highlight toward the top-left.
      const hl = Math.max(0, 1 - Math.hypot(x - 0.4, y - 0.38) / 0.3) * 0.35;
      return [Math.min(255, r + (255 - r) * hl), Math.min(255, g + (255 - g) * hl), Math.min(255, b + (255 - b) * hl), 1];
    }
    if (d <= 0.4) return [r, g, b, 0.22 * (1 - (d - 0.26) / 0.14)]; // soft glow
    return [0, 0, 0, 0];
  });
  const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
  cache.set(key, img);
  return img;
}
