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

      /** Draw one dot where `traj` crosses `thr`, on the given y scale. */
      const draw = (traj, yScl, thr, fill, ring, alpha) => {
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
        ctx.restore();
      };

      // Foreground drug — solid dots on the main y scale.
      const traj = ch.data.datasets.find(ds => ds.role === 'emergence-traj');
      if (traj && traj.data && traj.data.length >= 2) {
        draw(traj.data, ch.scales.y, s.thresholdCe, amber, '#ffffff', 1);
        draw(traj.data, ch.scales.y, s.exitCe, red, '#ffffff', 1);
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
        draw(g.traj, gScl, g.thresholdCe, amber, ring, s.ghostOpacity);
        draw(g.traj, gScl, g.exitCe, red, ring, s.ghostOpacity);
      }
    },
  };
}
