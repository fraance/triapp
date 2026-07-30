/**
 * Generates the PWA / home-screen icons.
 *
 * Hand-rolled PNG writer so the build needs no image dependency.
 * Design: indigo tile with three white bars — swim, bike, run.
 *
 * Run with: npm run icons
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const BG = [79, 70, 229]; // indigo-600, matches the app's headings
const FG = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Builds an RGB PNG from a pixel-picking function. */
function png(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Three stacked bars of different lengths, centred.
 * Coordinates are fractions of the icon size so every resolution matches.
 */
function draw(size) {
  const bars = [
    { y: 0.32, w: 0.52 }, // swim
    { y: 0.47, w: 0.4 }, // bike
    { y: 0.62, w: 0.28 }, // run
  ];
  const h = 0.075 * size;
  const r = h / 2;
  const left = 0.24 * size;

  return (x, y) => {
    for (const bar of bars) {
      const top = bar.y * size;
      const right = left + bar.w * size;
      if (y < top || y > top + h) continue;

      // rounded ends
      const cy = top + r;
      if (x >= left + r && x <= right - r) return FG;
      const cx = x < left + r ? left + r : right - r;
      if (x >= left && x <= right) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return FG;
      }
    }
    return BG;
  };
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(join(OUT_DIR, name), png(size, draw(size)));
  console.log(`  wrote public/${name} (${size}x${size})`);
}
