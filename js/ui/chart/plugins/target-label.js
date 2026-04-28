/**
 * target-label.js — Coloured pill labels at the right edge of the chart area.
 */

import { COLORS } from '../../../util/constants.js';
import { smartDecimal } from '../../drug-panel/formatters.js';

export function createTargetLabelPlugin(s) {
  return {
    id: 'targetCeLabel',
    afterDraw(ch) {
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!yScl || !ca) return;

      const k = s.fontScale || 1;
      const fontPx = Math.round(10 * k);
      const padH = Math.round(5 * k);
      const padV = Math.round(3 * k);

      function drawPillLabel(ctx, value, text, bgColor) {
        const y = yScl.getPixelForValue(value);
        if (y < ca.top || y > ca.bottom) return;
        ctx.save();
        ctx.font = `bold ${fontPx}px sans-serif`;
        const tw = ctx.measureText(text).width;
        const pillW = tw + padH * 2;
        const pillH = fontPx + padV * 2;
        const r = pillH / 2;
        const x = ca.right - pillW - 2;
        ctx.beginPath();
        ctx.roundRect(x, y - pillH / 2, pillW, pillH, r);
        ctx.fillStyle = bgColor;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + pillW / 2, y);
        ctx.restore();
      }

      const ctx = ch.ctx;
      if (s.targetCe !== null && s.targetCe > 0)
        drawPillLabel(ctx, s.targetCe, smartDecimal(s.targetCe), COLORS.target);
      if (s.thresholdCe !== null && s.thresholdCe > 0)
        drawPillLabel(ctx, s.thresholdCe, smartDecimal(s.thresholdCe), '#f59e0b');
      if (s.steadyStateCe !== null && s.steadyStateCe > 0)
        drawPillLabel(ctx, s.steadyStateCe, s.steadyStateCe.toFixed(2), 'rgba(34, 197, 94, 0.9)');
      if (s.exitCe !== null && s.exitCe > 0)
        drawPillLabel(ctx, s.exitCe, smartDecimal(s.exitCe), '#ef4444');
    },
  };
}
