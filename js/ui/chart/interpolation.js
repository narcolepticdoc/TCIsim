/**
 * interpolation.js — Binary-search helpers for sorted {x, y} arrays.
 *
 * Pure functions — no state dependencies.
 */

export function interpolateAtTime(data, time) {
  if (!data || data.length === 0) return null;
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].x < time) lo = mid + 1; else hi = mid;
  }
  const i = Math.min(lo, data.length - 1);
  if (i === 0 || data[i].x === time) return data[i].y;
  const a = data[i - 1], b = data[i];
  const frac = (time - a.x) / (b.x - a.x);
  return a.y + frac * (b.y - a.y);
}

export function nearestIndexAtTime(data, time) {
  if (!data || data.length === 0) return -1;
  let lo = 0, hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].x < time) lo = mid + 1; else hi = mid;
  }
  const i = Math.min(lo, data.length - 1);
  return (i > 0 && data[i].x > time) ? i - 1 : i;
}
