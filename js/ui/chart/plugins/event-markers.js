/**
 * event-markers.js — Shape markers for TCI events on the Ce curve.
 */

import { drawOctagon, drawTriangle, drawDoubleUpArrow } from '../shapes.js';

export function createEventMarkersPlugin(s) {
  return {
    id: 'futureEventMarkers',
    afterDraw(ch) {
      if (!s.eventAnnotationsEnabled || !s.eventMarkers.length) return;
      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) return;

      // Match the foreground Ce dataset by role tag — borderColor matching
      // would falsely target a per-drug ghost whose class hue happens to
      // coincide with the previous hardcoded Ce color.
      let ceData = null;
      for (const ds of ch.data.datasets) {
        if (ds.role === 'ce') { ceData = ds.data; break; }
      }
      if (!ceData || ceData.length === 0) return;

      const ctx = ch.ctx;
      const R = s.eventMarkerSize;

      for (const m of s.eventMarkers) {
        const cx = xScl.getPixelForValue(m.time);
        if (cx < ca.left || cx > ca.right) continue;

        let lo = 0, hi = ceData.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ceData[mid].x < m.time) lo = mid + 1; else hi = mid;
        }
        const i = Math.min(lo, ceData.length - 1);
        let yVal;
        if (i === 0 || ceData[i].x === m.time) {
          yVal = ceData[i].y;
        } else {
          const a = ceData[i - 1], b = ceData[i];
          const frac = (m.time - a.x) / (b.x - a.x);
          yVal = a.y + frac * (b.y - a.y);
        }
        const py = yScl.getPixelForValue(yVal);
        if (py < ca.top || py > ca.bottom) continue;

        ctx.save();
        if (m.past) ctx.globalAlpha = 0.3;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';

        if (m.kind === 'stop') {
          drawOctagon(ctx, cx, py, R, '#dc2626');
        } else if (m.kind === 'resume') {
          drawTriangle(ctx, cx, py, R, 'right', '#22c55e');
        } else if (m.kind === 'increase') {
          drawTriangle(ctx, cx, py, R, 'up', '#22c55e');
        } else if (m.kind === 'decrease') {
          drawTriangle(ctx, cx, py, R, 'down', '#22c55e');
        } else if (m.kind === 'bolus') {
          drawDoubleUpArrow(ctx, cx, py, R, '#22c55e');
        }

        ctx.restore();
      }
    },
  };
}
