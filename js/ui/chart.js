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

const DRUG_DISPLAY_NAMES = {
  propofol:     'Propofol',
  fentanyl:     'Fentanyl',
  ketamine:     'Ketamine',
  remifentanil: 'Remifentanil',
};

// Chart.js is loaded globally via CDN
const Chart = window.Chart;

if (!Chart) {
  console.warn('[TCI Sim] Chart.js not loaded — chart features disabled');
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
  let viewMin = 0;
  let viewMax = 30;         // default 30-minute view
  let autoScroll = true;
  let tooltipEnabled = true;
  let _currentDrugId = cfg.drugId || 'propofol';
  let _yScale = 1;          // scale factor applied to curve data (1 for mcg/mL, 1000 for ng/mL)
  const _legendEl = cfg.legendEl || null;

  function _drugName(id) {
    return DRUG_DISPLAY_NAMES[id] || (id.charAt(0).toUpperCase() + id.slice(1));
  }

  function _updateLegend(drugId) {
    if (!_legendEl) return;
    const name = _drugName(drugId);
    let html = `<div class="chart-legend-name">${name}</div><div class="chart-legend-items">`;
    if (cfg.showCe) html += `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${COLORS.ce}"></span>Ce</span>`;
    if (cfg.showCp) html += `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${COLORS.cp}"></span>Cp</span>`;
    html += '</div>';
    _legendEl.innerHTML = html;
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

    // Target line
    if (targetCe !== null && targetCe > 0) {
      annotations.target = {
        type: 'line',
        yMin: targetCe,
        yMax: targetCe,
        borderColor: COLORS.target,
        borderWidth: 1.5,
        borderDash: [6, 3],
        // Label is drawn in the right margin by the targetCeLabel inline plugin
      };
    }

    // Intermittent redose threshold line
    if (thresholdCe !== null && thresholdCe > 0) {
      annotations.threshold = {
        type: 'line',
        yMin: thresholdCe,
        yMax: thresholdCe,
        borderColor: '#f59e0b',   // amber — distinct from target orange
        borderWidth: 1.5,
        borderDash: [4, 3],
        // Label drawn in right margin by targetCeLabel plugin below
      };
    }

    // Effect overlay bands
    effectBands.forEach((band, i) => {
      annotations[`band_${i}`] = {
        type: 'box',
        yMin: band.ceMin,
        yMax: band.ceMax,
        backgroundColor: band.color,
        borderWidth: 0,
        label: band.label ? {
          display: true,
          content: band.label,
          position: { x: 'end', y: 'center' },
          color: '#ffffff88',
          font: { size: 9 },
        } : undefined,
      };
    });

    return annotations;
  }

  // Store BIS and rate values alongside curve for tooltip lookup
  let bisValues = [];       // parallel array: bisValues[i] = BIS at curveData[i].time
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
        padding: { right: 65 },
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
        legend: { display: false },
        tooltip: {
          enabled: tooltipEnabled,
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
              // Rate line
              if (rateValues.length > idx) {
                const rateMgMin = rateValues[idx];
                if (patientWeightKg && patientWeightKg > 0) {
                  const rateUcgKgMin = (rateMgMin * 1000) / patientWeightKg;
                  lines.push(`Rate: ${rateUcgKgMin.toFixed(1)} mcg/kg/min`);
                } else {
                  lines.push(`Rate: ${rateMgMin.toFixed(2)} mg/min`);
                }
              }
              // BIS line
              if (bisValues.length > idx && bisValues[idx] !== null) {
                lines.push(`BIS: ${bisValues[idx].toFixed(0)}`);
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
        // Draw target and threshold labels in the right-margin padding,
        // outside the chart area, so they never overlap curve data.
        id: 'targetCeLabel',
        afterDraw(ch) {
          const yScl = ch.scales.y;
          const ca = ch.chartArea;
          if (!yScl || !ca) return;

          function drawRightLabel(ctx, value, label, color, label2 = null) {
            const y = yScl.getPixelForValue(value);
            if (y < ca.top || y > ca.bottom) return;
            ctx.save();
            ctx.font = '10px sans-serif';
            const lines = label2 ? [label, label2] : [label];
            const lineH = 13, pad = 3, x = ca.right + 6;
            const tw = Math.max(...lines.map(l => ctx.measureText(l).width));
            const totalH = lines.length * lineH;
            ctx.fillStyle = color + 'dd';
            ctx.fillRect(x - pad, y - totalH / 2 - pad, tw + pad * 2, totalH + pad * 2);
            ctx.fillStyle = '#000';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            lines.forEach((line, i) => {
              ctx.fillText(line, x, y - totalH / 2 + lineH * i + lineH / 2);
            });
            ctx.restore();
          }

          const ctx = ch.ctx;
          if (targetCe !== null && targetCe > 0)
            drawRightLabel(ctx, targetCe, `Ce ${targetCe.toFixed(1)}`, COLORS.target);
          if (thresholdCe !== null && thresholdCe > 0)
            drawRightLabel(ctx, thresholdCe, 'Threshold', '#f59e0b', thresholdCe.toFixed(2));
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

    // Compute BIS for each point (for tooltip).
    // curveData Ce values may be pre-scaled (×_yScale) by app.js; unscale before
    // passing to pdModel.predict() which expects canonical mcg/mL.
    if (pdModel) {
      bisValues = curveData.map(p => {
        try { return pdModel.predict(p.Ce / _yScale); } catch (e) { return null; }
      });
    } else {
      bisValues = [];
    }

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

    // Show the canvas, hide placeholder; show HTML legend
    canvas.style.display = 'block';
    const placeholder = document.getElementById('chart-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    if (_legendEl) _legendEl.style.display = '';

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
   * Set the horizontal target line.
   * @param {number|null} ce - target Ce, or null to hide
   */
  function setTargetLine(ce) {
    targetCe = ce;
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

  /**
   * Toggle the hover tooltip on/off.
   * @returns {boolean} new state
   */
  function toggleTooltip() {
    tooltipEnabled = !tooltipEnabled;
    chart.options.plugins.tooltip.enabled = tooltipEnabled;
    chart.update('none');
    return tooltipEnabled;
  }

  /**
   * Set the PD model for BIS computation in tooltips.
   * @param {Object|null} pd - PD model with .predict(ce) method
   */
  function setPDModel(pd) {
    pdModel = pd;
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

    // Update dataset labels (used in tooltips) and HTML legend
    const unitLabel = yLabel || 'μg/mL';
    let dsIdx = 0;
    if (cfg.showCp) { datasets[dsIdx].label = `Cp (${unitLabel})`; dsIdx++; }
    if (cfg.showCe) { datasets[dsIdx].label = `Ce (${unitLabel})`; dsIdx++; }
    _updateLegend(drugId);

    // Update y-axis label
    chart.options.scales.y.title.text = unitLabel;

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
  // Drag up on the Y-axis area (left ~50px) to increase max Y,
  // drag down to decrease max Y.

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

    const deltaY = yDragStartY - e.touches[0].clientY; // positive = dragged up
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

  // Initialise HTML legend content for the starting drug (shown when first data arrives)
  _updateLegend(_currentDrugId);

  return {
    setCurveData,
    setCursorTime,
    setEffectOverlay,
    setTargetLine,
    setThresholdLine,
    setViewRange,
    resetView,
    recenter,
    toggleTooltip,
    setPDModel,
    setPatientWeight,
    switchDrug,
    destroy,
    get tooltipEnabled() { return tooltipEnabled; },
    get chart() { return chart; },
  };
}
