/**
 * readout-panel.js — Fixed canvas-drawn readout at top-right of chart area.
 *
 * Shows time, Ce, Cp, eBIS, and pump rate at the inspect point.
 */

import { interpolateAtTime, nearestIndexAtTime } from '../interpolation.js';
import { formatRateForDisplay } from '../rate-format.js';

export function createReadoutPanelPlugin(s) {
  return {
    id: 'readoutPanel',
    afterDraw(ch) {
      if (s.inspectTime === null || !s.inspectEnabled) return;
      const ca = ch.chartArea;
      if (!ca) return;
      const ctx = ch.ctx;

      // Match by role tag so ghosts don't get picked up as the
      // foreground Ce/Cp readouts.
      let ceVal = null, cpVal = null, refData = null;
      for (const ds of ch.data.datasets) {
        if (!ds.data || ds.data.length === 0) continue;
        if (ds.role === 'ce') {
          ceVal = interpolateAtTime(ds.data, s.inspectTime);
          refData = ds.data;
        } else if (ds.role === 'cp') {
          cpVal = interpolateAtTime(ds.data, s.inspectTime);
          if (!refData) refData = ds.data;
        }
      }

      let rateStr = '';
      if (refData && s.rateValues.length > 0) {
        const idx = nearestIndexAtTime(refData, s.inspectTime);
        if (idx >= 0 && idx < s.rateValues.length) {
          rateStr = 'Rate ' + formatRateForDisplay(s, s.rateValues[idx]);
        }
      }

      let bisStr = '';
      if (s.pdModel && ceVal !== null) {
        try {
          const ce = ceVal / (s.yScale || 1);
          const bis = s.pdModel.predict(ce);
          if (Number.isFinite(bis)) bisStr = 'eBIS ' + bis.toFixed(0);
        } catch (e) { /* ignore */ }
      }

      const line1 = 't = ' + s.inspectTime.toFixed(1) + ' min';
      const parts2 = [];
      if (ceVal !== null) parts2.push('Ce ' + ceVal.toFixed(2));
      if (cpVal !== null) parts2.push('Cp ' + cpVal.toFixed(2));
      if (bisStr) parts2.push(bisStr);
      const line2 = parts2.join('  ');
      const line3 = rateStr;

      const k = s.fontScale || 1;
      const fontPx = Math.round(11 * k);
      const lineH = Math.round(14 * k);

      ctx.save();
      ctx.font = `${fontPx}px monospace`;
      const w1 = ctx.measureText(line1).width;
      const w2 = ctx.measureText(line2).width;
      const w3 = line3 ? ctx.measureText(line3).width : 0;
      const panelW = Math.max(w1, w2, w3) + 16;
      const lineCount = line3 ? 3 : 2;
      const panelH = 6 + lineCount * lineH + 2;
      const px = ca.right - panelW - 4;
      // Floor clears the chart-controls strip (top:32, height:38, +clearance).
      const py = Math.max(ca.top + 4, 80);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.beginPath();
      ctx.roundRect(px, py, panelW, panelH, 5);
      ctx.fill();

      ctx.fillStyle = '#f59e0b';
      ctx.textBaseline = 'top';
      ctx.fillText(line1, px + 8, py + 4);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(line2, px + 8, py + 4 + lineH);
      if (line3) ctx.fillText(line3, px + 8, py + 4 + lineH * 2);
      ctx.restore();
    },
  };
}
