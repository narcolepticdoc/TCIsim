#!/usr/bin/env node
/**
 * gen-icons.js — Procedural placeholder icon generator for TCI Sim.
 *
 * Renders a 512×512 master (dark app-themed square, propofol-yellow Ce
 * curve over a dashed blue target line) with pure pixel math, encodes PNG
 * via zlib, then box-downsamples to 192 and 180 (apple-touch-icon).
 * No dependencies.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;

// Theme (manifest background_color + drug/class colors from constants.js)
const BG_TOP = [10, 15, 26];      // #0a0f1a
const BG_BOT = [6, 10, 18];       // #060a12
const CURVE = [250, 204, 21];     // #facc15 propofol yellow
const TARGET = [59, 130, 246];    // #3b82f6 fentanyl blue
const EDGE = [30, 41, 59];        // subtle border

// RGBA framebuffer
const px = new Float64Array(S * S * 4);
function blend(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const na = Math.min(1, a);
  px[i] = px[i] * (1 - na) + rgb[0] * na;
  px[i + 1] = px[i + 1] * (1 - na) + rgb[1] * na;
  px[i + 2] = px[i + 2] * (1 - na) + rgb[2] * na;
  px[i + 3] = Math.min(255, px[i + 3] + na * 255);
}

// 1. Background: vertical gradient, full bleed (iOS masks its own corners)
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const rgb = BG_TOP.map((c, k) => c + (BG_BOT[k] - c) * t);
  for (let x = 0; x < S; x++) blend(x, y, rgb, 1);
}
// subtle inner border
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.min(x, y, S - 1 - x, S - 1 - y);
    if (d < 6) blend(x, y, EDGE, 0.5 * (1 - d / 6));
  }
}

// 2. Ce curve: bateman-style rise/decay, normalized to canvas
const k1 = 9, k2 = 1.15; // fast rise, slow decay
const bateman = (t) => Math.exp(-k2 * t) - Math.exp(-k1 * t);
let peakV = 0, samples = [];
for (let i = 0; i <= 2000; i++) {
  const v = bateman(i / 2000);
  if (v > peakV) peakV = v;
}
const X0 = S * 0.13, X1 = S * 0.90;      // horizontal span
const YBASE = S * 0.80, YPEAK = S * 0.24; // vertical span
const curveXY = (t) => [X0 + (X1 - X0) * t, YBASE - (YBASE - YPEAK) * (bateman(t) / peakV)];

// 3. Dashed target line at 72% of peak height (drawn first, behind curve)
const yTarget = YBASE - (YBASE - YPEAK) * 0.72;
const DASH = S * 0.055, GAP = S * 0.035, TLW = S * 0.016;
for (let x = Math.round(X0 * 0.8); x <= Math.round(X1 * 1.04); x++) {
  const phase = (x - X0 * 0.8) % (DASH + GAP);
  if (phase > DASH) continue;
  for (let dy = -Math.ceil(TLW); dy <= Math.ceil(TLW); dy++) {
    const a = Math.max(0, 1 - Math.abs(dy) / TLW);
    blend(x, Math.round(yTarget) + dy, TARGET, a * 0.85);
  }
}

// 4. Stroke the curve: stamp anti-aliased discs along dense samples
const R = S * 0.030;
for (let i = 0; i <= 4000; i++) {
  const [cx, cy] = curveXY(i / 4000);
  const x0 = Math.floor(cx - R - 1), x1 = Math.ceil(cx + R + 1);
  const y0 = Math.floor(cy - R - 1), y1 = Math.ceil(cy + R + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < R + 1) blend(x, y, CURVE, Math.min(1, R + 0.5 - d));
    }
  }
}

// 5. Peak dot (slightly larger, with dark ring for separation)
{
  let tPeak = 0, best = 0;
  for (let i = 0; i <= 2000; i++) {
    const v = bateman(i / 2000);
    if (v > best) { best = v; tPeak = i / 2000; }
  }
  const [cx, cy] = curveXY(tPeak);
  const RD = S * 0.052, RING = S * 0.068;
  for (let y = Math.floor(cy - RING - 1); y <= Math.ceil(cy + RING + 1); y++) {
    for (let x = Math.floor(cx - RING - 1); x <= Math.ceil(cx + RING + 1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < RING + 1) blend(x, y, BG_TOP, Math.min(1, RING + 0.5 - d));
    }
  }
  for (let y = Math.floor(cy - RD - 1); y <= Math.ceil(cy + RD + 1); y++) {
    for (let x = Math.floor(cx - RD - 1); x <= Math.ceil(cx + RD + 1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < RD + 1) blend(x, y, CURVE, Math.min(1, RD + 0.5 - d));
    }
  }
}

// ---- PNG encoding ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) {
      raw[y * (size * 4 + 1) + 1 + x] = Math.round(rgba[y * size * 4 + x]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Box-filter downsample (S is not an integer multiple of 192/180 — use area averaging)
function resample(src, srcSize, dstSize) {
  const dst = new Float64Array(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = x * ratio, x1 = (x + 1) * ratio;
      const y0 = y * ratio, y1 = (y + 1) * ratio;
      const acc = [0, 0, 0, 0];
      let w = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const fx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const fy = Math.min(sy + 1, y1) - Math.max(sy, y0);
          const f = fx * fy;
          for (let k = 0; k < 4; k++) acc[k] += src[(sy * srcSize + sx) * 4 + k] * f;
          w += f;
        }
      }
      for (let k = 0; k < 4; k++) dst[(y * dstSize + x) * 4 + k] = acc[k] / w;
    }
  }
  return dst;
}

const outDir = process.argv[2] || '.';
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'icons/icon-512.png'), encodePNG(px, S));
fs.writeFileSync(path.join(outDir, 'icons/icon-192.png'), encodePNG(resample(px, S, 192), 192));
fs.writeFileSync(path.join(outDir, 'icons/apple-touch-icon.png'), encodePNG(resample(px, S, 180), 180));
console.log('icons written to', path.join(outDir, 'icons'));
