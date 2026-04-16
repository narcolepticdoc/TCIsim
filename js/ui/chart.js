/**
 * chart.js — Reusable TCI Chart Component
 * 
 * Wraps a Chart.js instance to display pharmacokinetic curves
 * (Cp, Ce), a time cursor, optional effect-site overlay bands
 * (BIS nomogram), and a target line.
 * 
 * The chart is size-agnostic — it fills its parent container.
 * Multiple instances can coexist for different drugs or layouts.
 * 
 * Dependencies (loaded via CDN in index.html):
 *   - Chart.js v4
 *   - chartjs-plugin-annotation
 *   - chartjs-plugin-zoom + hammer.js
 */

import { COLORS } from '../util/constants.js';
import { fromCanonical, getDefaultUnit, getPrefKey, formatValue, getAllowedUnits } from '../util/units.js';

// Chart.js is loaded globally via CDN
const Chart = window.Chart;

if (!Chart) {
  console.warn('[TCI Sim] Chart.js not loaded — chart features disabled');
}

// ---- Shape helpers for futureEventMarkers plugin ----

function drawOctagon(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + k * Math.PI / 4;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

function drawTriangle(ctx, cx, cy, r, dir, fill) {
  // Equilateral triangle centred on (cx, cy), pointing in `dir` ('up'|'down'|'right')
  const h = r * 1.1;
  ctx.beginPath();
  if (dir === 'up') {
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx - h, cy + h * 0.7);
    ctx.lineTo(cx + h, cy + h * 0.7);
  } else if (dir === 'down') {
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx - h, cy - h * 0.7);
    ctx.lineTo(cx + h, cy - h * 0.7);
  } else { // 'right'
    ctx.moveTo(cx + h, cy);
    ctx.lineTo(cx - h * 0.7, cy - h);
    ctx.lineTo(cx - h * 0.7, cy + h);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

function drawDoubleUpArrow(ctx, cx, cy, r, fill) {
  // Two stacked up-chevrons — reads as "push up"
  const w = r * 1.1;
  const h = r * 0.75;
  const gap = r * 0.25;
  ctx.fillStyle = fill;

  // Lower chevron (arrowhead): points at cy + h/2, base at cy + h*1.5
  ctx.beginPath();
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx - w, cy + gap + h);
  ctx.lineTo(cx + w, cy + gap + h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Upper chevron: points at cy - h, base at cy
  ctx.beginPath();
  ctx.moveTo(cx, cy - gap - h);
  ctx.lineTo(cx - w, cy - gap);
  ctx.lineTo(cx + w, cy - gap);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/**
 * Create a TCI chart instance.
 *
 * @param {HTMLCanvasElement} canvas - The canvas element to render into
 * @param {Object} [config] - Configuration options
 * @param {string} [config.drugId] - Drug identifier (for labelling)
 * @param {boolean} [config.showCp] - Show Cp curve (default true)
 * @param {boolean} [config.showCe] - Show Ce curve (default true)
 * @param {boolean} [config.showRate] - Show rate step plot (default false)
 * @returns {Object} Chart controller
 */
export function createChart(canvas, config = {}) {
  if (!Chart) {
    console.error('[TCI Sim] Cannot create chart — Chart.js not loaded');
    return null;
  }
  const cfg = {
    drugId: 'propofol',
    showCp: true,
    showCe: true,
    showRate: false,
    ...config,
  };

  let cursorTime = 0;
  let targetCe = null;
  let thresholdCe = null;   // intermittent redose threshold line (same scale as targetCe)
  let effectBands = [];     // [{ ceMin, ceMax, color, label }]
  let plateauRegion = null; // { startMin, endMin, ceMin, ceMax } — chart units
  let steadyStateCe = null; // horizontal line at analytical Ce_ss — chart units
  let exitCe = null;        // horizontal line at exit/emergence Ce threshold
  let viewMin = 0;
  let viewMax = 30;         // default 30-minute view
  let autoScroll = true;
  let _currentDrugId = cfg.drugId || 'propofol';
  let _yScale = 1;          // scale factor applied to curve data (1 for mcg/mL, 1000 for ng/mL)
  let _overlayAlpha = 'ff';  // hex alpha for threshold/target lines
  let _nomogramOpacity = 1.0; // multiplier for BIS band alpha
  let eventMarkers = [];      // [{ time, kind }] — future TCI events for overlay
  let eventAnnotationsEnabled = false;
  let eventMarkerSize = 7;    // px radius / half-size for marker shapes
  let inspectTime = null;     // time (minutes) where user tapped to inspect, or null
  let inspectEnabled = false; // gate: ⓘ button controls whether taps set inspectTime

  // Shared helper: binary-search + linear interpolation for a sorted {x, y} array
  function interpolateAtTime(data, time) {
    if (!data || data.length === 0) return null;
    let lo = 0, hi = data.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid].x < time) lo = mid + 1; else hi = mid;
    }
    const i = Math.min(lo, data.length - 1);
    if (i === 0 || data[i].x === time) return data[i].y;
    const a = data[i - 1], b = data[i];
    const frac = (time - a.x) / (b.x - a.x);
    return a.y + frac * (b.y - a.y);
  }

  // Build datasets
  const datasets = [];

  if (cfg.showCp) {
    datasets.push({
      label: 'Cp (μg/mL)',
      data: [],
      borderColor: COLORS.cp,
      backgroundColor: COLORS.cp + '18',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.1,
      fill: false,
      order: 2,
    });
  }

  if (cfg.showCe) {
    datasets.push({
      label: 'Ce (μg/mL)',
      data: [],
      borderColor: COLORS.ce,
      backgroundColor: COLORS.ce + '18',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.1,
      fill: false,
      order: 1,
    });
  }

  if (cfg.showRate) {
    datasets.push({
      label: 'Rate (mg/min)',
      data: [],
      borderColor: COLORS.rate,
      backgroundColor: COLORS.rate + '30',
      borderWidth: 1,
      pointRadius: 0,
      stepped: 'before',
      fill: true,
      yAxisID: 'yRate',
      order: 3,
    });
  }

  // Build annotation config
  function buildAnnotations() {
    const annotations = {};

    // Cursor line
    annotations.cursor = {
      type: 'line',
      xMin: cursorTime,
      xMax: cursorTime,
      borderColor: '#ffffff',
      borderWidth: 1.5,
      borderDash: [4, 3],
    };

    // Inspect line (amber solid — user tap point)
    if (inspectTime !== null) {
      annotations.inspect = {
        type: 'line',
        xMin: inspectTime,
        xMax: inspectTime,
        borderColor: '#f59e0b',
        borderWidth: 1.5,
        borderDash: [],
      };
    }

    // Target line
    if (targetCe !== null && targetCe > 0) {
      annotations.target = {
        type: 'line',
        yMin: targetCe,
        yMax: targetCe,
        borderColor: COLORS.target + _overlayAlpha,
        borderWidth: 1.5,
        borderDash: [6, 3],
      };
    }

    // Intermittent redose threshold line
    if (thresholdCe !== null && thresholdCe > 0) {
      annotations.threshold = {
        type: 'line',
        yMin: thresholdCe,
        yMax: thresholdCe,
        borderColor: '#f59e0b' + _overlayAlpha,
        borderWidth: 1.5,
        borderDash: [4, 3],
      };
    }

    // Analytical steady-state line (manual-mode constant infusion)
    if (steadyStateCe !== null && steadyStateCe > 0) {
      annotations.ssLine = {
        type: 'line',
        yMin: steadyStateCe,
        yMax: steadyStateCe,
        borderColor: '#22c55e' + _overlayAlpha,
        borderWidth: 1.5,
        borderDash: [8, 4],
      };
    }

    // Exit Ce threshold line
    if (exitCe !== null && exitCe > 0) {
      annotations.exitCe = {
        type: 'line',
        yMin: exitCe,
        yMax: exitCe,
        borderColor: '#ef4444' + _overlayAlpha,
        borderWidth: 1.5,
        borderDash: [5, 4],
      };
    }

    // Effect overlay bands — scale base alpha by nomogram opacity
    effectBands.forEach((band, i) => {
      const baseAlpha = parseInt(band.color.slice(7, 9) || '30', 16);
      const scaledAlpha = Math.round(baseAlpha * _nomogramOpacity).toString(16).padStart(2, '0');
      const labelAlpha = Math.round(0x88 * _nomogramOpacity).toString(16).padStart(2, '0');
      annotations[`band_${i}`] = {
        type: 'box',
        yMin: band.ceMin,
        yMax: band.ceMax,
        backgroundColor: band.color.slice(0, 7) + scaledAlpha,
        borderWidth: 0,
        label: band.label ? {
          display: true,
          content: band.label,
          position: { x: 'end', y: 'center' },
          xAdjust: -36,
          color: '#ffffff' + labelAlpha,
          font: { size: 9 },
        } : undefined,
      };
    });

    // Plateau region bounding box (manual-mode plateau highlight)
    if (plateauRegion) {
      const fillA = Math.round(0x1f * (parseInt(_overlayAlpha, 16) / 255)).toString(16).padStart(2, '0');
      annotations.plateau = {
        type: 'box',
        xScaleID: 'x',
        yScaleID: 'y',
        xMin: plateauRegion.startMin,
        xMax: plateauRegion.endMin ?? viewMax,
        yMin: plateauRegion.ceMin,
        yMax: plateauRegion.ceMax,
        backgroundColor: '#f59e0b' + fillA,
        borderColor: '#f59e0b' + _overlayAlpha,
        borderWidth: 2,
        drawTime: 'afterDatasetsDraw',
      };
    }

    return annotations;
  }

  // Store rate values alongside curve for tooltip lookup.
  // BIS is computed on the fly from the hovered Ce dataset item,
  // so no parallel bisValues cache is needed.
  let rateValues = [];      // parallel array: rateValues[i] = rate (mg/min) at curveData[i].time
  let patientWeightKg = null;
  let pdModel = null; // set via setPDModel()

  // Create chart instance
  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: {
        padding: { right: 5 },
      },
      onClick(event, elements, ch) {
        if (!inspectEnabled) return;
        const xScale = ch.scales.x;
        if (!xScale) return;
        const ca = ch.chartArea;
        if (!ca) return;
        const px = event.x;
        if (px < ca.left || px > ca.right) return;
        const t = xScale.getValueForPixel(px);
        if (t < 0) return;
        setInspectTime(t);
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (min)', color: '#9ca3af', font: { size: 10 } },
          min: viewMin,
          max: viewMax,
          ticks: {
            color: '#6b7280',
            font: { size: 9 },
            maxTicksLimit: 12,
          },
          grid: { color: '#1e293b' },
        },
        y: {
          type: 'linear',
          title: { display: true, text: 'μg/mL', color: '#9ca3af', font: { size: 10 } },
          min: 0,
          suggestedMax: 8,
          ticks: {
            color: '#6b7280',
            font: { size: 9 },
          },
          grid: { color: '#1e293b' },
        },
        ...(cfg.showRate ? {
          yRate: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'mg/min', color: COLORS.rate, font: { size: 10 } },
            min: 0,
            grid: { display: false },
            ticks: { color: COLORS.rate, font: { size: 9 } },
          },
        } : {}),
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 12, padding: 8 },
        },
        tooltip: {
          enabled: false,
          backgroundColor: '#1e293bee',
          titleFont: { size: 11 },
          bodyFont: { size: 10 },
          callbacks: {
            title(items) {
              if (items.length > 0) return `t = ${items[0].parsed.x.toFixed(1)} min`;
              return '';
            },
            afterBody(items) {
              if (!items.length) return '';
              const idx = items[0].dataIndex;
              const lines = [];
              // Rate line — use the drug's preferred unit for correct precision
              if (rateValues.length > idx) {
                const rateMgMin = rateValues[idx];
                try {
                  const prefKey = getPrefKey(_currentDrugId, 'rate');
                  let displayUnit = getDefaultUnit(_currentDrugId, 'rate');
                  if (prefKey) {
                    try {
                      const saved = localStorage.getItem(prefKey);
                      const allowed = getAllowedUnits(_currentDrugId, 'rate');
                      if (saved && allowed.includes(saved)) displayUnit = saved;
                    } catch (e) {}
                  }
                  const ctx = { weightKg: patientWeightKg || undefined };
                  const displayVal = fromCanonical(rateMgMin, displayUnit, _currentDrugId, 'rate', ctx);
                  lines.push(`Rate: ${formatValue(displayVal, displayUnit)} ${displayUnit}`);
                } catch (e) {
                  lines.push(`Rate: ${rateMgMin.toFixed(2)} mg/min`);
                }
              }
              // eBIS line — computed on the fly from the hovered Ce dataset
              // item so it works even if setCurveData ran before setPDModel.
              // Label matches the drug card readout ("eBIS").
              if (pdModel) {
                const ceItem = items.find(it => {
                  const lbl = it.dataset && it.dataset.label;
                  return typeof lbl === 'string' && lbl.startsWith('Ce');
                });
                if (ceItem) {
                  try {
                    const ce  = ceItem.parsed.y / (_yScale || 1);
                    const bis = pdModel.predict(ce);
                    if (Number.isFinite(bis)) lines.push(`eBIS: ${bis.toFixed(0)}`);
                  } catch (e) {}
                }
              }
              return lines;
            },
          },
        },
        annotation: {
          annotations: buildAnnotations(),
        },
        zoom: {
          limits: {
            x: { min: 0 },
          },
          pan: {
            enabled: true,
            mode: 'x',
            onPanStart() {
              autoScroll = false;
            },
            onPanComplete({ chart: c }) {
              autoScroll = false;
              viewMin = c.scales.x.min;
              viewMax = c.scales.x.max;
            },
          },
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: true },
            mode: 'x',
            onZoomStart() {
              // Disable auto-scroll immediately so setCursorTime doesn't
              // call zoomScale with stale viewMin/viewMax mid-gesture
              autoScroll = false;
            },
            onZoomComplete({ chart: c }) {
              autoScroll = false;
              // Track the plugin's resulting range
              viewMin = c.scales.x.min;
              viewMax = c.scales.x.max;
            },
          },
        },
      },
    },
    plugins: [
      {
        // Draw coloured pill labels straddling the right edge of the chart area.
        id: 'targetCeLabel',
        afterDraw(ch) {
          const yScl = ch.scales.y;
          const ca = ch.chartArea;
          if (!yScl || !ca) return;

          function drawPillLabel(ctx, value, text, bgColor) {
            const y = yScl.getPixelForValue(value);
            if (y < ca.top || y > ca.bottom) return;
            ctx.save();
            ctx.font = 'bold 10px sans-serif';
            const tw = ctx.measureText(text).width;
            const padH = 5, padV = 3;
            const pillW = tw + padH * 2;
            const pillH = 10 + padV * 2;
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
          if (targetCe !== null && targetCe > 0)
            drawPillLabel(ctx, targetCe, targetCe.toFixed(1), COLORS.target);
          if (thresholdCe !== null && thresholdCe > 0)
            drawPillLabel(ctx, thresholdCe, thresholdCe.toFixed(1), '#f59e0b');
          if (steadyStateCe !== null && steadyStateCe > 0)
            drawPillLabel(ctx, steadyStateCe, steadyStateCe.toFixed(2), 'rgba(34, 197, 94, 0.9)');
          if (exitCe !== null && exitCe > 0)
            drawPillLabel(ctx, exitCe, exitCe.toFixed(1), '#ef4444');
        },
      },
      {
        // Draw dots on Ce/Cp lines at the cursor time
        id: 'cursorDots',
        afterDraw(ch) {
          if (cursorTime <= 0) return;
          const xScl = ch.scales.x;
          const yScl = ch.scales.y;
          const ca = ch.chartArea;
          if (!xScl || !yScl || !ca) return;
          const cx = xScl.getPixelForValue(cursorTime);
          if (cx < ca.left || cx > ca.right) return;
          const ctx = ch.ctx;

          for (const ds of ch.data.datasets) {
            if (!ds.data || ds.data.length === 0) return;
            const color = ds.borderColor;
            // Only draw for Ce/Cp datasets (skip rate) — Cp color may have alpha suffix
            if (!color.startsWith(COLORS.ce) && !color.startsWith(COLORS.cp)) continue;
            // Binary search for the cursor time in sorted x data
            const data = ds.data;
            let lo = 0, hi = data.length - 1;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (data[mid].x < cursorTime) lo = mid + 1; else hi = mid;
            }
            // Interpolate between adjacent points
            const i = Math.min(lo, data.length - 1);
            let yVal;
            if (i === 0 || data[i].x === cursorTime) {
              yVal = data[i].y;
            } else {
              const a = data[i - 1], b = data[i];
              const frac = (cursorTime - a.x) / (b.x - a.x);
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
      },
      {
        // Draw amber dots on Ce/Cp curves at the inspect time
        id: 'inspectDots',
        afterDraw(ch) {
          if (inspectTime === null) return;
          const xScl = ch.scales.x;
          const yScl = ch.scales.y;
          const ca = ch.chartArea;
          if (!xScl || !yScl || !ca) return;
          const icx = xScl.getPixelForValue(inspectTime);
          if (icx < ca.left || icx > ca.right) return;
          const ctx = ch.ctx;

          for (const ds of ch.data.datasets) {
            if (!ds.data || ds.data.length === 0) continue;
            const color = ds.borderColor;
            if (!color.startsWith(COLORS.ce) && !color.startsWith(COLORS.cp)) continue;
            const yVal = interpolateAtTime(ds.data, inspectTime);
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
      },
      {
        // Fixed readout panel drawn on canvas at top-right of chart area
        id: 'readoutPanel',
        afterDraw(ch) {
          if (inspectTime === null || !inspectEnabled) return;
          const ca = ch.chartArea;
          if (!ca) return;
          const ctx = ch.ctx;

          // Interpolate Ce and Cp at inspectTime
          let ceVal = null, cpVal = null;
          for (const ds of ch.data.datasets) {
            if (!ds.data || ds.data.length === 0) continue;
            const color = ds.borderColor;
            if (color.startsWith(COLORS.ce)) ceVal = interpolateAtTime(ds.data, inspectTime);
            else if (color.startsWith(COLORS.cp)) cpVal = interpolateAtTime(ds.data, inspectTime);
          }

          // Compute eBIS from Ce (unscale to canonical mcg/mL)
          let bisStr = '';
          if (pdModel && ceVal !== null) {
            try {
              const ce = ceVal / (_yScale || 1);
              const bis = pdModel.predict(ce);
              if (Number.isFinite(bis)) bisStr = 'eBIS ' + bis.toFixed(0);
            } catch (e) {}
          }

          // Build display lines
          const line1 = 't = ' + inspectTime.toFixed(1) + ' min';
          const parts2 = [];
          if (ceVal !== null) parts2.push('Ce ' + ceVal.toFixed(2));
          if (cpVal !== null) parts2.push('Cp ' + cpVal.toFixed(2));
          if (bisStr) parts2.push(bisStr);
          const line2 = parts2.join('  ');

          // Measure and draw panel
          ctx.save();
          ctx.font = '11px monospace';
          const w1 = ctx.measureText(line1).width;
          const w2 = ctx.measureText(line2).width;
          const panelW = Math.max(w1, w2) + 16;
          const panelH = 34;
          const px = ca.right - panelW - 4;
          // Buttons sit at top:8 and are 38px tall. Anchor readout below them
          // (with 6px gap), but never above chartArea.top.
          const py = Math.max(ca.top + 4, 52);

          ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
          ctx.beginPath();
          ctx.roundRect(px, py, panelW, panelH, 5);
          ctx.fill();

          ctx.fillStyle = '#f59e0b';
          ctx.textBaseline = 'top';
          ctx.fillText(line1, px + 8, py + 4);
          ctx.fillStyle = '#e2e8f0';
          ctx.fillText(line2, px + 8, py + 18);
          ctx.restore();
        },
      },
      {
        // Draw shape markers at future TCI event times, interpolated onto the Ce curve
        id: 'futureEventMarkers',
        afterDraw(ch) {
          if (!eventAnnotationsEnabled || !eventMarkers.length) return;
          const xScl = ch.scales.x;
          const yScl = ch.scales.y;
          const ca = ch.chartArea;
          if (!xScl || !yScl || !ca) return;

          // Locate Ce dataset (markers ride on Ce)
          let ceData = null;
          for (const ds of ch.data.datasets) {
            if (ds.borderColor && ds.borderColor.startsWith(COLORS.ce)) {
              ceData = ds.data; break;
            }
          }
          if (!ceData || ceData.length === 0) return;

          const ctx = ch.ctx;
          const R = eventMarkerSize;  // shape radius / half-size (configurable)

          for (const m of eventMarkers) {
            const cx = xScl.getPixelForValue(m.time);
            if (cx < ca.left || cx > ca.right) continue;

            // Binary search for Ce at this event's time
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
      },
    ],
  });

  // ---- Public API ----

  let yMaxManual = null; // null = auto-scale, number = user-set

  /**
   * Update curve data from model.computeCurve() output.
   * @param {Array} curveData - [{ time, Cp, Ce, rate }, ...]
   */
  function setCurveData(curveData) {
    let dsIdx = 0;

    if (cfg.showCp) {
      datasets[dsIdx].data = curveData.map(p => ({ x: p.time, y: p.Cp }));
      dsIdx++;
    }

    if (cfg.showCe) {
      datasets[dsIdx].data = curveData.map(p => ({ x: p.time, y: p.Ce }));
      dsIdx++;
    }

    if (cfg.showRate) {
      datasets[dsIdx].data = curveData.map(p => ({ x: p.time, y: p.rate }));
      dsIdx++;
    }

    // Store rate values for tooltip
    rateValues = curveData.map(p => p.rate);

    // Auto-scale Y axis (unless user has manually set it)
    if (yMaxManual === null && curveData.length > 0) {
      const maxCp = Math.max(...curveData.map(p => p.Cp));
      const maxCe = Math.max(...curveData.map(p => p.Ce));
      const maxConc = Math.max(maxCp, maxCe, targetCe || 0);
      chart.options.scales.y.max = Math.ceil(maxConc * 1.3);
    }

    // Sync scale options to current view state (prevents snap-back after zoom)
    chart.options.scales.x.min = viewMin;
    chart.options.scales.x.max = viewMax;

    // Show the canvas, hide placeholder
    canvas.style.display = 'block';
    const placeholder = document.getElementById('chart-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    chart.update('none');
  }

  /**
   * Move the time cursor.
   * @param {number} t - time in minutes
   */
  function setCursorTime(t) {
    cursorTime = t;
    chart.options.plugins.annotation.annotations = buildAnnotations();

    // Auto-scroll if cursor approaches right edge
    if (autoScroll && t > viewMax * 0.85) {
      const range = viewMax - viewMin;
      viewMin = Math.max(0, t - range * 0.3);
      viewMax = viewMin + range;
      try {
        chart.zoomScale('x', { min: viewMin, max: viewMax }, 'none');
      } catch (e) {
        // Fallback for older plugin versions
        chart.options.scales.x.min = viewMin;
        chart.options.scales.x.max = viewMax;
      }
    }

    chart.update('none');
  }

  /**
   * Set the effect overlay bands (BIS nomogram).
   * @param {Array} bands - [{ ceMin, ceMax, color, label }]
   */
  function setEffectOverlay(bands) {
    effectBands = bands;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the intermittent redose threshold line.
   * @param {number|null} ce - threshold in chart units, or null to hide
   */
  function setThresholdLine(ce) {
    thresholdCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the plateau region bounding box (manual-mode highlight).
   * @param {Object|null} region - { startMin, endMin, ceMin, ceMax } in chart units, or null
   */
  function setPlateauRegion(region) {
    plateauRegion = region;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the steady-state horizontal line (manual-mode).
   * @param {number|null} ce - steady-state Ce in chart units, or null to hide
   */
  function setSteadyStateLine(ce) {
    steadyStateCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the horizontal target line.
   * @param {number|null} ce - target Ce, or null to hide
   */
  function setTargetLine(ce) {
    targetCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the horizontal exit Ce line.
   * @param {number|null} ce - exit Ce threshold, or 0/null to hide
   */
  function setExitLine(ce) {
    exitCe = (ce && ce > 0) ? ce : null;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /**
   * Set the visible time range.
   * @param {number} tMin
   * @param {number} tMax
   */
  function setViewRange(tMin, tMax) {
    viewMin = tMin;
    viewMax = tMax;
    autoScroll = false;
    try {
      chart.zoomScale('x', { min: viewMin, max: viewMax }, 'none');
    } catch (e) {
      chart.options.scales.x.min = viewMin;
      chart.options.scales.x.max = viewMax;
    }
    chart.update('none');
  }

  /**
   * Full reset: default zoom, recenter on current time, auto-scale Y.
   */
  function resetView() {
    autoScroll = true;
    yMaxManual = null;
    try { localStorage.removeItem('chart-ymax-' + _currentDrugId); } catch (e) {}
    viewMin = 0;
    viewMax = 30;
    chart.options.scales.y.min = 0;
    delete chart.options.scales.y.max;
    try { chart.resetZoom('none'); } catch (e) {}
    try {
      chart.zoomScale('x', { min: 0, max: 30 }, 'none');
    } catch (e) {
      chart.options.scales.x.min = 0;
      chart.options.scales.x.max = 30;
    }
    chart.update('none');
  }

  function setInspectTime(t) {
    inspectTime = t;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  function clearInspect() {
    if (inspectTime === null) return;
    inspectTime = null;
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  function toggleInspect() {
    inspectEnabled = !inspectEnabled;
    if (!inspectEnabled) clearInspect();
    return inspectEnabled;
  }

  /**
   * Set the PD model for BIS computation in tooltips.
   * @param {Object|null} pd - PD model with .predict(ce) method
   */
  function setPDModel(pd) {
    pdModel = pd || null;
  }

  /**
   * Set patient weight for rate unit conversion in tooltip (mg/min → mcg/kg/min).
   * @param {number|null} kg
   */
  function setPatientWeight(kg) {
    patientWeightKg = kg;
  }

  /**
   * Switch the chart to display a different drug.
   * Saves the current drug's y-axis max, then restores (or auto-scales) the new drug's.
   *
   * @param {string} drugId - New drug identifier
   * @param {string} yLabel - Y-axis label (e.g. 'μg/mL' or 'ng/mL')
   * @param {number} suggestedMax - Default y-max if no saved value exists
   * @param {number} [yScale=1] - Scale factor applied to incoming curve Ce/Cp data
   */
  function switchDrug(drugId, yLabel, suggestedMax, yScale) {
    // Save current drug's y-max before switching
    if (_currentDrugId && yMaxManual !== null) {
      try { localStorage.setItem('chart-ymax-' + _currentDrugId, String(yMaxManual)); } catch (e) {}
    }

    _currentDrugId = drugId;
    _yScale = yScale || 1;
    thresholdCe = null;  // clear stale threshold from previous drug
    inspectTime = null;  // clear stale inspect from previous drug

    // Update y-axis label
    chart.options.scales.y.title.text = yLabel || 'μg/mL';

    // Restore saved y-max for new drug, or use auto-scale with suggestedMax
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem('chart-ymax-' + drugId)); } catch (e) {}
    if (isFinite(saved) && saved > 0) {
      yMaxManual = saved;
      chart.options.scales.y.max = yMaxManual;
      delete chart.options.scales.y.suggestedMax;
    } else {
      yMaxManual = null;
      delete chart.options.scales.y.max;
      chart.options.scales.y.suggestedMax = suggestedMax || 10;
    }
    chart.update('none');
  }

  /**
   * Destroy the chart instance.
   */
  function destroy() {
    canvas.removeEventListener('touchstart', handleYTouchStart);
    canvas.removeEventListener('touchmove', handleYTouchMove);
    canvas.removeEventListener('touchend', handleYTouchEnd);
    chart.destroy();
  }

  // ---- Y-axis finger drag handler ----
  // Drag down on the Y-axis area (left ~50px) to increase max Y,
  // drag up to decrease max Y.

  let yDragActive = false;
  let yDragStartY = 0;
  let yDragStartMax = 0;

  function handleYTouchStart(e) {
    if (e.touches.length !== 1) return;
    const chartArea = chart.chartArea;
    if (!chartArea) return;

    const rect = canvas.getBoundingClientRect();
    const touchX = e.touches[0].clientX - rect.left;

    // Only activate on the Y-axis area (left edge of chart)
    if (touchX > chartArea.left + 20) return;

    yDragActive = true;
    yDragStartY = e.touches[0].clientY;
    yDragStartMax = chart.options.scales.y.max || chart.options.scales.y.suggestedMax || 10;
    e.preventDefault();
  }

  function handleYTouchMove(e) {
    if (!yDragActive || e.touches.length !== 1) return;
    e.preventDefault();

    const deltaY = e.touches[0].clientY - yDragStartY; // positive = dragged down
    const chartArea = chart.chartArea;
    const chartHeight = chartArea ? (chartArea.bottom - chartArea.top) : 200;

    // Map pixel drag to Y-axis scale: dragging full chart height doubles/halves the range
    const ratio = deltaY / chartHeight;
    const newMax = Math.max(1, yDragStartMax * (1 + ratio * 2));

    yMaxManual = newMax;
    chart.options.scales.y.max = newMax;
    try { localStorage.setItem('chart-ymax-' + _currentDrugId, String(newMax)); } catch (e) {}
    chart.update('none');
  }

  function handleYTouchEnd(e) {
    yDragActive = false;
  }

  canvas.addEventListener('touchstart', handleYTouchStart, { passive: false });
  canvas.addEventListener('touchmove', handleYTouchMove, { passive: false });
  canvas.addEventListener('touchend', handleYTouchEnd);

  // ---- Double-tap: recenter on current time + re-enable auto-scroll ----
  // Does NOT reset zoom level — just re-centers the view.
  let lastTap = 0;
  let wasMultiTouch = false;

  // Track pinch/multi-touch so the two touchend events that follow a pinch
  // release don't get mistaken for a double-tap.
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) wasMultiTouch = true;
  }, { passive: true });

  function recenter() {
    inspectTime = null;
    autoScroll = true;
    const range = viewMax - viewMin; // keep current zoom level
    viewMin = Math.max(0, cursorTime - range * 0.3);
    viewMax = viewMin + range;
    try {
      chart.zoomScale('x', { min: viewMin, max: viewMax }, 'none');
    } catch (e) {
      chart.options.scales.x.min = viewMin;
      chart.options.scales.x.max = viewMax;
    }
    chart.update('none');
  }

  canvas.addEventListener('dblclick', () => {
    recenter();
  });
  canvas.addEventListener('touchend', (e) => {
    if (yDragActive) return; // don't trigger on Y-axis drag end
    // Skip if other fingers are still on screen (mid-pinch)
    if (e.touches.length > 0) return;
    // Skip if this touchend is the tail of a pinch gesture
    if (wasMultiTouch) {
      wasMultiTouch = false;
      return; // don't update lastTap — keep it at the last genuine single tap
    }
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      recenter();
    }
    lastTap = now;
  });

  /** Set Cp line opacity (0.1–1.0). Applies to border and fill colors. */
  function setCpOpacity(opacity) {
    if (!cfg.showCp) return;
    const ds = datasets[0]; // Cp is always first when showCp is true
    const a = Math.round(Math.max(0.1, Math.min(1.0, opacity)) * 255).toString(16).padStart(2, '0');
    ds.borderColor = COLORS.cp + a;
    ds.backgroundColor = COLORS.cp + Math.round(opacity * 0x18).toString(16).padStart(2, '0');
    chart.update('none');
  }

  /** Set BIS nomogram band opacity (0.1–1.0). Rebuilds annotations with scaled alpha. */
  function setNomogramOpacity(opacity) {
    _nomogramOpacity = Math.max(0.1, Math.min(1.0, opacity));
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /** Set threshold/target/SS/exit line opacity (0.1–1.0). Rebuilds annotations with scaled alpha. */
  function setOverlayOpacity(opacity) {
    _overlayAlpha = Math.round(Math.max(0.1, Math.min(1.0, opacity)) * 255).toString(16).padStart(2, '0');
    chart.options.plugins.annotation.annotations = buildAnnotations();
    chart.update('none');
  }

  /** Replace the set of future-event markers. `markers` = [{ time, kind }]. */
  function setEventAnnotations(markers) {
    eventMarkers = Array.isArray(markers) ? markers : [];
    chart.update('none');
  }

  /** Toggle the futureEventMarkers overlay. Returns the new enabled state. */
  function toggleEventAnnotations() {
    eventAnnotationsEnabled = !eventAnnotationsEnabled;
    chart.update('none');
    return eventAnnotationsEnabled;
  }

  /** Set the event-marker shape radius in px (clamped to 4–16). */
  function setEventMarkerSize(px) {
    eventMarkerSize = Math.max(4, Math.min(16, Math.round(px)));
    chart.update('none');
  }

  return {
    setCurveData,
    setCursorTime,
    setEffectOverlay,
    setTargetLine,
    setThresholdLine,
    setPlateauRegion,
    setSteadyStateLine,
    setExitLine,
    setViewRange,
    resetView,
    recenter,
    setInspectTime,
    clearInspect,
    toggleInspect,
    setPDModel,
    setPatientWeight,
    switchDrug,
    setCpOpacity,
    setNomogramOpacity,
    setOverlayOpacity,
    setEventAnnotations,
    toggleEventAnnotations,
    setEventMarkerSize,
    destroy,
    get inspectEnabled() { return inspectEnabled; },
    get eventAnnotationsEnabled() { return eventAnnotationsEnabled; },
    get chart() { return chart; },
  };
}
