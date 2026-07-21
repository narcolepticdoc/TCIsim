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
 */

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
      const traj = ch.data.datasets.find(ds => ds.role === 'emergence-traj');
      if (!traj || !traj.data || traj.data.length < 2) return;

      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) return;

      const cs = getComputedStyle(document.documentElement);
      const amber = (cs.getPropertyValue('--amber').trim() || '#f59e0b');
      const red   = (cs.getPropertyValue('--red').trim()   || '#ef4444');

      const ctx = ch.ctx;
      const draw = (thr, color) => {
        if (thr === null || !(thr > 0)) return;
        const x = downwardCrossingX(traj.data, thr);
        if (x === null) return;
        const px = xScl.getPixelForValue(x);
        const py = yScl.getPixelForValue(thr);
        if (px < ca.left || px > ca.right || py < ca.top || py > ca.bottom) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      };

      draw(s.thresholdCe, amber);
      draw(s.exitCe, red);
    },
  };
}
