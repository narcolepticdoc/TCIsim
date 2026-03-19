/**
 * TCI Chart — Canvas-based Cp/Ce concentration graph
 * Shows past (solid) and future (dashed) trace segments
 * Moving time cursor
 */

export class TCIChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trace = [];
    this.currentTimeMin = 0;
    this.windowMin = 60;      // Total window in minutes
    this.padding = { top: 20, right: 20, bottom: 40, left: 58 };
    
    // Colors (CSS var fallbacks)
    this.colors = {
      bg: '#0a0d12',
      grid: 'rgba(255,255,255,0.07)',
      gridLabel: 'rgba(255,255,255,0.35)',
      cp: '#4ac9ff',
      ce: '#f59e0b',
      cpFuture: 'rgba(74,201,255,0.35)',
      ceFuture: 'rgba(245,158,11,0.35)',
      cursor: 'rgba(255,255,255,0.6)',
      cursorLine: 'rgba(255,255,255,0.15)',
      axis: 'rgba(255,255,255,0.15)',
    };
    
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas.parentElement);
    this._resize();
  }

  _resize() {
    const parent = this.canvas.parentElement;
    this.canvas.width = parent.clientWidth;
    this.canvas.height = parent.clientHeight;
    this.render();
  }

  setTrace(trace) {
    this.trace = trace;
  }

  setCurrentTime(minutes) {
    this.currentTimeMin = minutes;
  }

  _plotArea() {
    const { top, right, bottom, left } = this.padding;
    return {
      x: left,
      y: top,
      w: this.canvas.width - left - right,
      h: this.canvas.height - top - bottom,
    };
  }

  _timeToX(t, area, viewStart, viewEnd) {
    return area.x + ((t - viewStart) / (viewEnd - viewStart)) * area.w;
  }

  _concToY(c, area, maxConc) {
    return area.y + area.h - (c / maxConc) * area.h;
  }

  render() {
    const ctx = this.ctx;
    const { width: W, height: H } = this.canvas;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, W, H);

    const area = this._plotArea();
    const t = this.currentTimeMin;
    
    // View window: show past 15min + future 30min, centered on cursor if possible
    const pastShow = 15;
    const futureShow = 30;
    let viewStart = Math.max(0, t - pastShow);
    let viewEnd = viewStart + this.windowMin;

    // Max concentration for Y axis
    const visibleTrace = this.trace.filter(p => p.timeMin >= viewStart && p.timeMin <= viewEnd);
    const maxConc = Math.max(
      6,
      ...visibleTrace.map(p => Math.max(p.Cp || 0, p.Ce || 0))
    ) * 1.15;

    // Grid
    this._drawGrid(ctx, area, viewStart, viewEnd, maxConc);

    // Trace lines
    if (this.trace.length > 1) {
      this._drawTrace(ctx, area, viewStart, viewEnd, maxConc);
    }

    // Cursor
    this._drawCursor(ctx, area, viewStart, viewEnd, t, maxConc);

    // Legend
    this._drawLegend(ctx);
  }

  _drawGrid(ctx, area, viewStart, viewEnd, maxConc) {
    ctx.save();
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.gridLabel;
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;

    // Y gridlines: concentration
    const yTicks = this._niceTicks(0, maxConc, 6);
    yTicks.forEach(v => {
      const y = this._concToY(v, area, maxConc);
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(1), area.x - 6, y + 4);
    });

    // X gridlines: time
    ctx.textAlign = 'center';
    const xTicks = this._niceTicks(viewStart, viewEnd, 8);
    xTicks.forEach(v => {
      const x = this._timeToX(v, area, viewStart, viewEnd);
      if (x < area.x || x > area.x + area.w) return;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
      ctx.fillText(this._fmtTick(v), x, area.y + area.h + 14);
    });

    // Axes
    ctx.strokeStyle = this.colors.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, area.y);
    ctx.lineTo(area.x, area.y + area.h);
    ctx.lineTo(area.x + area.w, area.y + area.h);
    ctx.stroke();

    // Y axis label
    ctx.save();
    ctx.translate(12, area.y + area.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.colors.gridLabel;
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText('mcg/ml', 0, 0);
    ctx.restore();

    ctx.restore();
  }

  _drawTrace(ctx, area, viewStart, viewEnd, maxConc) {
    const t = this.currentTimeMin;
    const past = this.trace.filter(p => p.timeMin <= t + 1/12); // +5s buffer
    const future = this.trace.filter(p => p.timeMin >= t - 1/12);

    const drawLine = (points, color, dashed = false, key = 'Cp') => {
      if (points.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.5 : 2;
      ctx.lineJoin = 'round';
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      let started = false;
      points.forEach(p => {
        const x = this._timeToX(p.timeMin, area, viewStart, viewEnd);
        const y = this._concToY(p[key] ?? 0, area, maxConc);
        if (x < area.x - 2 || x > area.x + area.w + 2) return;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    };

    drawLine(past, this.colors.cp, false, 'Cp');
    drawLine(past, this.colors.ce, false, 'Ce');
    drawLine(future, this.colors.cpFuture, true, 'Cp');
    drawLine(future, this.colors.ceFuture, true, 'Ce');
  }

  _drawCursor(ctx, area, viewStart, viewEnd, t, maxConc) {
    const x = this._timeToX(t, area, viewStart, viewEnd);
    if (x < area.x || x > area.x + area.w) return;

    // Vertical cursor line
    ctx.save();
    ctx.strokeStyle = this.colors.cursorLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.stroke();
    ctx.restore();

    // Find current Cp/Ce
    const nearest = this._nearestPoint(t);
    if (!nearest) return;

    // Cp dot
    const yCp = this._concToY(nearest.Cp, area, maxConc);
    const yCe = this._concToY(nearest.Ce, area, maxConc);

    ctx.save();
    // Cp dot
    ctx.fillStyle = this.colors.cp;
    ctx.beginPath();
    ctx.arc(x, yCp, 5, 0, Math.PI * 2);
    ctx.fill();

    // Ce dot
    ctx.fillStyle = this.colors.ce;
    ctx.beginPath();
    ctx.arc(x, yCe, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawLegend(ctx) {
    const items = [
      { label: 'Cp', color: this.colors.cp },
      { label: 'Ce', color: this.colors.ce },
    ];
    const x0 = this.padding.left + 10;
    const y0 = this.padding.top + 10;
    ctx.save();
    ctx.font = '11px "IBM Plex Mono", monospace';
    items.forEach((item, i) => {
      const x = x0 + i * 60;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x + 18, y0);
      ctx.stroke();
      ctx.fillStyle = item.color;
      ctx.fillText(item.label, x + 22, y0 + 4);
    });
    ctx.restore();
  }

  _nearestPoint(t) {
    if (!this.trace.length) return null;
    return this.trace.reduce((best, p) =>
      Math.abs(p.timeMin - t) < Math.abs(best.timeMin - t) ? p : best
    );
  }

  _niceTicks(min, max, count) {
    const range = max - min;
    const rough = range / count;
    const exp = Math.floor(Math.log10(rough));
    const step = Math.ceil(rough / Math.pow(10, exp)) * Math.pow(10, exp);
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.01; v += step) {
      if (v >= min - step * 0.01) ticks.push(Math.round(v * 1000) / 1000);
    }
    return ticks;
  }

  _fmtTick(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
    return `${m}m`;
  }
}
