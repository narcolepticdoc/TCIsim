/**
 * time-format.js — Chart axis/label time formatting.
 *
 * Extracted from chart/index.js so plugins can format times the same way the
 * x-axis does without importing index.js, which imports them (circular).
 */

/**
 * Format an axis tick value. Chart.js's auto-computed min/max can produce
 * floating-point noise like 30.00000000000002; snap to 3 decimals and drop
 * the decimal entirely on integers so ticks read cleanly.
 */
export function fmtTick(v) {
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? r.toString() : r.toFixed(1);
}

/**
 * Format an x-axis value (sim minutes) per the selected time-axis mode.
 * Mirrors the elapsed/real-time formatting in history.js fmtTime.
 */
export function fmtXTick(v, mode, wallClockStartMs) {
  if (!Number.isFinite(v)) return '';
  if (mode === 'rt' && wallClockStartMs != null) {
    const d = new Date(wallClockStartMs + v * 60000);
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  if (mode === 'hmin' || (mode === 'rt' && wallClockStartMs == null)) {
    const totalMin = Math.round(v);
    const sign = totalMin < 0 ? '-' : '';
    const a = Math.abs(totalMin);
    return sign + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }
  return fmtTick(v);
}

export function xAxisTitle(mode) {
  if (mode === 'hmin') return 'Time (h:min)';
  if (mode === 'rt') return 'Clock time';
  return 'Time (min)';
}

/**
 * Label a point in time for an in-plot annotation, in the axis's own units.
 *
 * In `min` mode a bare number would be ambiguous next to a concentration, so
 * it carries its unit; `h:mm` and clock time are self-evident and don't.
 */
export function fmtTimeLabel(v, mode, wallClockStartMs) {
  const text = fmtXTick(v, mode, wallClockStartMs);
  if (!text) return '';
  return (mode === 'hmin' || mode === 'rt') ? text : `${text} min`;
}
