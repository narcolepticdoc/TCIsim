/**
 * cursor-dots.js — Draw dots on Ce/Cp curves at the "now" cursor time.
 */

export function createCursorDotsPlugin(s) {
  return {
    id: 'cursorDots',
    afterDraw(ch) {
      if (s.cursorTime <= 0) return;
      const xScl = ch.scales.x;
      const yScl = ch.scales.y;
      const ca = ch.chartArea;
      if (!xScl || !yScl || !ca) return;
      const cx = xScl.getPixelForValue(s.cursorTime);
      if (cx < ca.left || cx > ca.right) return;
      const ctx = ch.ctx;

      for (const ds of ch.data.datasets) {
        if (!ds.data || ds.data.length === 0) return;
        // Only draw dots on the foreground Ce/Cp curves; skip ghosts
        // and the rate dataset.
        if (ds.role !== 'ce' && ds.role !== 'cp') continue;
        const color = ds.borderColor;
        const data = ds.data;
        let lo = 0, hi = data.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (data[mid].x < s.cursorTime) lo = mid + 1; else hi = mid;
        }
        const i = Math.min(lo, data.length - 1);
        let yVal;
        if (i === 0 || data[i].x === s.cursorTime) {
          yVal = data[i].y;
        } else {
          const a = data[i - 1], b = data[i];
          const frac = (s.cursorTime - a.x) / (b.x - a.x);
          yVal = a.y + frac * (b.y - a.y);
        }
        const py = yScl.getPixelForValue(yVal);
        if (py < ca.top || py > ca.bottom) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#0a0f1a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    },
  };
}
