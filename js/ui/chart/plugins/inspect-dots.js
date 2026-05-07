/**
 * inspect-dots.js — Draw amber dots on Ce/Cp curves at the inspect time.
 */

import { interpolateAtTime } from '../interpolation.js';

export function createInspectDotsPlugin(s) {
  return {
    id: 'inspectDots',
    afterDraw(ch) {
      if (s.inspectTime === null) return;
      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) return;
      const icx = xScl.getPixelForValue(s.inspectTime);
      if (icx < ca.left || icx > ca.right) return;
      const ctx = ch.ctx;

      for (const ds of ch.data.datasets) {
        if (!ds.data || ds.data.length === 0) continue;
        // Only draw dots on the foreground Ce/Cp curves; skip ghosts.
        if (ds.role !== 'ce' && ds.role !== 'cp') continue;
        const yVal = interpolateAtTime(ds.data, s.inspectTime);
        if (yVal === null) continue;
        const py = yScl.getPixelForValue(yVal);
        if (py < ca.top || py > ca.bottom) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(icx, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    },
  };
}
