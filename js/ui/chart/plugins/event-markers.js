/**
 * event-markers.js — Shape markers for TCI events on the Ce curve.
 */

import { drawOctagon, drawTriangle, drawDoubleUpArrow } from '../shapes.js';

export function createEventMarkersPlugin(s) {
  return {
    id: 'futureEventMarkers',
    afterDraw(ch) {
      // Planning mode draws the PROPOSED plan's steps instead of the committed
      // ones, and does so regardless of the ⚑ toggle: the whole point of
      // previewing a TCI target is seeing the scheme it would produce, which
      // exists nowhere else on screen. Committed markers stay behind the
      // toggle as before.
      const planning = s.planPreviewActive && s.planEventMarkers && s.planEventMarkers.length > 0;
      const markers = planning
        ? s.planEventMarkers
        : (s.eventAnnotationsEnabled ? s.eventMarkers : null);
      if (!markers || !markers.length) return;

      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) return;

      // Match the curve the markers belong to by role tag — borderColor
      // matching would falsely target a per-drug ghost whose class hue happens
      // to coincide with the previous hardcoded Ce color.
      const wantRole = planning ? 'plan-preview-ce' : 'ce';
      let ceData = null;
      for (const ds of ch.data.datasets) {
        if (ds.role === wantRole) { ceData = ds.data; break; }
      }
      if (!ceData || ceData.length === 0) return;

      const ctx = ch.ctx;
      const R = s.eventMarkerSize;

      for (const m of markers) {
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
