/**
 * inspect-handle.js — Draggable knob on the inspect cursor.
 *
 * Draws a circular handle at the top of the inspect-cursor vertical line
 * when inspect mode is on and a cursor is set. The handle is the only
 * region that participates in cursor-drag gestures; touches elsewhere on
 * the chart body continue to pan / pinch / tap as usual.
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
        // Cursor is outside the visible x-range — no handle to draw or hit.
        s._inspectHandleHit = null;
        return;
      }
      const cy = ca.top + 10;
      const ctx = ch.ctx;

      ctx.save();
      // Outer subtle halo — visual hint for the tap target.
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fill();
      // Inner knob.
      ctx.fillStyle = '#cbd5e1';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Left + right chevrons suggesting horizontal drag.
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy - 2.5);
      ctx.lineTo(cx - 5, cy);
      ctx.lineTo(cx - 3, cy + 2.5);
      ctx.moveTo(cx + 3, cy - 2.5);
      ctx.lineTo(cx + 5, cy);
      ctx.lineTo(cx + 3, cy + 2.5);
      ctx.stroke();
      ctx.restore();

      // Expose a 44-diameter hit region for gestures.js (iOS / Material min).
      s._inspectHandleHit = { cx, cy, r: 22 };
    },
  };
}
