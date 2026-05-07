/**
 * color.js — Small color helpers for drug-keyed UI surfaces.
 *
 * lighten()    — raise the luminance of a hex color (and slightly drop
 *                saturation) for ghost/secondary trace styling.
 * hexToRgba()  — produce an `rgba(r,g,b,a)` string from a #rrggbb hex.
 */

/** Parse a `#rrggbb` (or `#rgb`) hex into [r, g, b] in 0–255. */
function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) + (g < b ? 6 : 0);
    else if (max === g) h = ((b - r) / d) + 2;
    else h = ((r - g) / d) + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3) * 255, hue2rgb(h) * 255, hue2rgb(h - 1 / 3) * 255];
}

/**
 * Return a lighter, slightly-desaturated version of `hex`.
 * `amount` is the absolute increase added to L (and 0.5×amount subtracted
 * from S), both clamped to [0, 1]. 0.25 is a good starting point for ghost
 * trace tinting against the saturated foreground color.
 */
export function lighten(hex, amount = 0.25) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const L = Math.max(0, Math.min(1, l + amount));
  const S = Math.max(0, Math.min(1, s - amount * 0.5));
  const [r2, g2, b2] = hslToRgb(h, S, L);
  return rgbToHex(r2, g2, b2);
}

/**
 * Convert `#rrggbb` to `rgba(r,g,b,a)` with the given alpha (0–1).
 */
export function hexToRgba(hex, alpha = 1) {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Convert an alpha (0–1) into a 2-char hex byte for `#rrggbb` + `aa` style
 * Chart.js fills.
 */
export function alphaToHex(alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return Math.round(a * 255).toString(16).padStart(2, '0');
}
