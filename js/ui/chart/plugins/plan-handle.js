/**
 * plan-handle.js — Draggable handle on the proposed-dose curve.
 *
 * The vertical twin of inspect-handle.js: where that one slides along X to
 * move the inspect cursor in time, this one slides along Y to retitrate the
 * dose. The user grabs the point where the proposal peaks (or, for a rate,
 * where it has settled) and pulls the curve to the concentration they want;
 * planning.js back-solves the dose that lands there.
 *
 * Drawn only while planning mode has published `s.planHandle` — a
 * `{ time, ce }` pair in chart units. Publishes its hit region on
 * `s._planHandleHit` for gestures.js, recomputed every afterDraw so pan,
 * zoom and resize keep it accurate.
 */

export function createPlanHandlePlugin(s) {
  return {
    id: 'planHandle',
    afterDraw(ch) {
      const h = s.planHandle;
      if (!h) { s._planHandleHit = null; return; }

      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) { s._planHandleHit = null; return; }

      const cx = xScl.getPixelForValue(h.time);
      const cy = yScl.getPixelForValue(h.ce);
      // Off-screen in either axis — no handle, and nothing to hit-test.
      if (cx < ca.left || cx > ca.right || cy < ca.top || cy > ca.bottom) {
        s._planHandleHit = null;
        return;
      }

      const ctx = ch.ctx;
      const color = s.drugColor || '#cbd5e1';

      // Pill is taller than wide — the shape itself says "drag me vertically".
      const w = 18, hh = 34, r = 9;
      const x0 = cx - w / 2;
      const y0 = cy - hh / 2;

      ctx.save();

      // Guide line back to the y-axis, so the value being dragged is
      // readable against the scale rather than floating in the plot.
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ca.left, cy);
      ctx.lineTo(cx - w / 2 - 3, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Touch-target halo
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x0 - 4, y0 - 4, w + 8, hh + 8, r + 4);
      } else {
        ctx.rect(x0 - 4, y0 - 4, w + 8, hh + 8);
      }
      ctx.fill();

      // Pill body, tinted to the drug so it reads as part of its curve
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x0, y0, w, hh, r);
      } else {
        ctx.rect(x0, y0, w, hh);
      }
      ctx.fill();
      ctx.stroke();

      // Up / down chevrons
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - 3.5, cy - 6);
      ctx.lineTo(cx,       cy - 10);
      ctx.lineTo(cx + 3.5, cy - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 3.5, cy + 6);
      ctx.lineTo(cx,       cy + 10);
      ctx.lineTo(cx + 3.5, cy + 6);
      ctx.stroke();

      ctx.restore();

      // Hit region — 44×56, generous for touch as with the inspect handle.
      s._planHandleHit = {
        cx, cy,
        left: cx - 22, right: cx + 22,
        top: cy - 28,  bottom: cy + 28,
      };
    },
  };
}
