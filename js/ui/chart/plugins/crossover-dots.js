/**
 * crossover-dots.js — Highlight where the emergence trajectory (the projected
 * "Ce if the infusion stopped now" decay curve) crosses a horizontal threshold.
 *
 * Orange dot: crossing of the redose threshold line (s.thresholdCe).
 * Red dot:    crossing of the emergence / exit threshold line (s.exitCe).
 *
 * Both thresholds are stored on the shared state in the same chart y-units as
 * the trajectory dataset, so no conversion is needed. Colors are read from CSS
 * variables so they stay theme-aware and match the lines they sit on.
 *
 * Background drugs get the same two dots, drawn as ghosts: dimmed to
 * s.ghostOpacity, and ringed in the drug's own color instead of white. A
 * background drug draws no threshold line, so that ring is the only cue for
 * which drug the dot belongs to. Their projections arrive per-drug in
 * s.ghostCrossings and sit on that drug's hidden yGhost_<drugId> axis — never
 * the foreground y scale, whose calibration is unrelated.
 */

import { DRUG_DEFS } from '../../../util/constants.js';
import { fmtTimeLabel } from '../time-format.js';

/**
 * Find the x-value where a sorted {x, y} point array first crosses `thr` going
 * downward (from above to at/below). Returns null when there is no such crossing.
 */
function downwardCrossingX(data, thr) {
  for (let i = 1; i < data.length; i++) {
    const a = data[i - 1];
    const b = data[i];
    if (a.y > thr && b.y <= thr) {
      if (b.y === a.y) return b.x; // flat segment on the threshold
      const frac = (a.y - thr) / (a.y - b.y);
      return a.x + frac * (b.x - a.x);
    }
  }
  return null;
}

export function createCrossoverDotsPlugin(s) {
  return {
    id: 'crossoverDots',
    afterDraw(ch) {
      const xScl = ch.scales.x;
      const ca = ch.chartArea;
      if (!xScl || !ca) return;

      const cs = getComputedStyle(document.documentElement);
      const amber = (cs.getPropertyValue('--amber').trim() || '#f59e0b');
      const red   = (cs.getPropertyValue('--red').trim()   || '#ef4444');

      const ctx = ch.ctx;

      const labelFg = (cs.getPropertyValue('--chart-label-fg').trim() || '#ffffff');
      const labelBg = (cs.getPropertyValue('--bg-deep').trim() || '#0b1120');
      const fontPx = Math.round(10 * (s.fontScale || 1));

      /**
       * Draw one dot where `traj` crosses `thr`, on the given y scale.
       *
       * `label` adds the crossing TIME beside the dot, in whatever units the
       * x-axis is currently showing — a dot on its own says "it gets there",
       * the label says when, which is the number a clinician actually wants.
       */
      const draw = (traj, yScl, thr, fill, ring, alpha, label) => {
        if (!yScl || thr === null || !(thr > 0)) return;
        const x = downwardCrossingX(traj, thr);
        if (x === null) return;
        const px = xScl.getPixelForValue(x);
        const py = yScl.getPixelForValue(thr);
        if (px < ca.left || px > ca.right || py < ca.top || py > ca.bottom) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = ring;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (label && s.crossoverLabels) {
          const text = fmtTimeLabel(x, s.timeAxisMode, s.wallClockStartMs);
          if (text) {
            ctx.font = `600 ${fontPx}px ui-monospace, monospace`;
            ctx.textBaseline = 'middle';
            const w = ctx.measureText(text).width;
            // Flip to the left of the dot when the label would overflow the
            // plot — crossings often sit near the right edge.
            const right = px + 8 + w + 6 <= ca.right;
            const bx = right ? px + 8 : px - 8 - w - 6;
            const by = py - fontPx / 2 - 3;
            ctx.globalAlpha = alpha * 0.85;
            ctx.fillStyle = labelBg;
            if (typeof ctx.roundRect === 'function') {
              ctx.beginPath();
              ctx.roundRect(bx, by, w + 6, fontPx + 6, 3);
              ctx.fill();
            } else {
              ctx.fillRect(bx, by, w + 6, fontPx + 6);
            }
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = fill;
            ctx.lineWidth = 1;
            if (typeof ctx.roundRect === 'function') ctx.stroke();
            ctx.fillStyle = labelFg;
            ctx.textAlign = 'left';
            ctx.fillText(text, bx + 3, by + (fontPx + 6) / 2);
          }
        }
        ctx.restore();
      };

      // Foreground drug — solid dots on the main y scale.
      const traj = ch.data.datasets.find(ds => ds.role === 'emergence-traj');
      if (traj && traj.data && traj.data.length >= 2) {
        draw(traj.data, ch.scales.y, s.thresholdCe, amber, '#ffffff', 1, true);
        draw(traj.data, ch.scales.y, s.exitCe, red, '#ffffff', 1, true);
      }

      // Proposed dose (planning mode) — the same two crossings read off the
      // curve being dragged, so the effect of a dose on time-to-redose and
      // time-to-emergence is visible while choosing it. Drawn only while a
      // preview is up; the dataset is empty otherwise.
      const plan = ch.data.datasets.find(ds => ds.role === 'plan-preview-ce');
      if (s.planPreviewActive && plan && plan.data && plan.data.length >= 2) {
        draw(plan.data, ch.scales.y, s.thresholdCe, amber, '#ffffff', 1, true);
        draw(plan.data, ch.scales.y, s.exitCe, red, '#ffffff', 1, true);
      }

      // Background drugs — ghosted dots, gated on the same toggle that reveals
      // the background Ce traces they belong to.
      if (!s.ghostEnabled) return;
      const ghosts = s.ghostCrossings;
      if (!ghosts) return;
      for (const drugId of Object.keys(ghosts)) {
        if (drugId === s.currentDrugId) continue;
        const g = ghosts[drugId];
        if (!g || !g.traj || g.traj.length < 2) continue;
        const gScl = ch.scales['yGhost_' + drugId];
        const ring = (DRUG_DEFS[drugId] && DRUG_DEFS[drugId].color) || '#ffffff';
        // No time labels on background drugs — three or four of them would
        // crowd the plot, and the foreground is where the decision is made.
        draw(g.traj, gScl, g.thresholdCe, amber, ring, s.ghostOpacity, false);
        draw(g.traj, gScl, g.exitCe, red, ring, s.ghostOpacity, false);
      }
    },
  };
}
