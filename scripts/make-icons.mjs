// Draw the operator package's icons: a dark rounded square with a light "a" ring-and-stem
// monogram, as PNGs of 16, 32, 48 and 128 px. Plain code, no third-party art.
// Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Coverage (0..1) of the monogram at a point in the unit square, by distance:
// a ring (the bowl of an "a") and a stem on its right.
function ink(x, y) {
  const ring = Math.abs(Math.hypot(x - 0.46, y - 0.56) - 0.2) < 0.075;
  const stem = x > 0.6 && x < 0.74 && y > 0.3 && y < 0.78;
  return ring || stem ? 1 : 0;
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 4; // 4x4 samples per pixel
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let fg = 0;
      let inside = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          const dx = Math.max(Math.abs(x - 0.5) - 0.34, 0);
          const dy = Math.max(Math.abs(y - 0.5) - 0.34, 0);
          if (Math.hypot(dx, dy) <= 0.16) {
            inside++;
            fg += ink(x, y);
          }
        }
      }
      const n = S * S;
      const alpha = inside / n;
      const light = inside ? fg / inside : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(30 + (245 - 30) * light);
      raw[o + 1] = Math.round(41 + (245 - 41) * light);
      raw[o + 2] = Math.round(59 + (245 - 59) * light);
      raw[o + 3] = Math.round(255 * alpha);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = new URL("../operator/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${size}.png`, dir), render(size));
console.log("wrote 4 icons");
