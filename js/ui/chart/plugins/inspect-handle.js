/**
 * inspect-handle.js — Draggable handle on the inspect cursor.
 *
 * Draws a horizontal pill with left/right chevrons at the bottom of the
 * inspect-cursor line when inspect mode is on and a cursor is set. The
 * handle is the only region that captures gesture events for cursor-drag;
 * touches elsewhere on the chart body continue to pan / pinch / tap as usual.
 *
 * Exposes the current hit-region on `s._inspectHandleHit` so `gestures.js`
 * can hit-test without recomputing pixel positions. Recomputed on every
 * afterDraw so zooming, panning, or window resize keeps it accurate.
 */

export function createInspectHandlePlugin(s) {
  return {
    id: 'inspectHandle',
    afterDraw(ch) {
      if (!s.inspectEnabled || s.inspectTime === null) {
        s._inspectHandleHit = null;
        return;
      }
      const xScl = ch.scales.x;
      const ca = ch.chartArea;
      if (!xScl || !ca) { s._inspectHandleHit = null; return; }
      const cx = xScl.getPixelForValue(s.inspectTime);
      if (cx < ca.left || cx > ca.right) {
        s._inspectHandleHit = null;
        return;
      }
      // Center the handle just above the bottom of the chart plot area so it
      // sits below the curves but above the x-axis labels.
      const cy = ca.bottom - 14;
      const ctx = ch.ctx;

      // Pill geometry
      const w = 34, h = 16, r = 8;
      const x0 = cx - w / 2;
      const y0 = cy - h / 2;

      ctx.save();
      // Subtle outer halo (hint for the touch target)
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x0 - 4, y0 - 4, w + 8, h + 8, r + 4);
      } else {
        ctx.rect(x0 - 4, y0 - 4, w + 8, h + 8);
      }
      ctx.fill();
      // Pill body
      ctx.fillStyle = '#cbd5e1';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x0, y0, w, h, r);
      } else {
        ctx.rect(x0, y0, w, h);
      }
      ctx.fill();
      ctx.stroke();
      // Left + right chevrons pointing outward, suggesting drag direction.
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // left '<'
      ctx.beginPath();
      ctx.moveTo(cx - 6,  cy - 3);
      ctx.lineTo(cx - 10, cy);
      ctx.lineTo(cx - 6,  cy + 3);
      ctx.stroke();
      // right '>'
      ctx.beginPath();
      ctx.moveTo(cx + 6,  cy - 3);
      ctx.lineTo(cx + 10, cy);
      ctx.lineTo(cx + 6,  cy + 3);
      ctx.stroke();
      ctx.restore();

      // Hit region — a 48×32 rectangle around the pill, generous for touch.
      s._inspectHandleHit = {
        cx, cy,
        left: cx - 24, right: cx + 24,
        top: cy - 16,  bottom: cy + 16,
      };
    },
  };
}
