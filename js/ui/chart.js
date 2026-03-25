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
  let effectBands = [];   // [{ ceMin, ceMax, color, label }]
  let viewMin = 0;
  let viewMax = 30;       // default 30-minute view
  let autoScroll = true;
  let tooltipEnabled = true;

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
        label: {
          display: true,
          content: `Ce target ${targetCe.toFixed(1)}`,
          position: 'start',
          backgroundColor: COLORS.target + 'cc',
          color: '#000',
          font: { size: 10 },
          padding: 2,
        },
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

  // Store BIS values alongside curve for tooltip lookup
  let bisValues = []; // parallel array to curve data: bisValues[i] = BIS at curveData[i].time
  let pdModel = null; // set via setPDModel()

  // Create chart instance
  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
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
              // Add BIS to tooltip
              if (items.length > 0 && bisValues.length > 0) {
                const idx = items[0].dataIndex;
                if (idx < bisValues.length && bisValues[idx] !== null) {
                  return `BIS: ${bisValues[idx].toFixed(0)}`;
                }
              }
              return '';
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
            onPanComplete() {
              autoScroll = false;
            },
          },
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: true },
            mode: 'x',
            onZoomComplete() {
              autoScroll = false;
            },
          },
        },
      },
    },
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

    // Compute BIS for each point (for tooltip)
    if (pdModel) {
      bisValues = curveData.map(p => {
        try { return pdModel.predict(p.Ce); } catch (e) { return null; }
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
      chart.options.scales.x.min = viewMin;
      chart.options.scales.x.max = viewMax;
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
    chart.options.scales.x.min = viewMin;
    chart.options.scales.x.max = viewMax;
    autoScroll = false;
    chart.update('none');
  }

  /**
   * Full reset: default zoom, recenter on current time, auto-scale Y.
   */
  function resetView() {
    autoScroll = true;
    yMaxManual = null;
    viewMin = 0;
    viewMax = 30;
    chart.options.scales.x.min = viewMin;
    chart.options.scales.x.max = viewMax;
    chart.options.scales.y.min = 0;
    delete chart.options.scales.y.max;
    try { chart.resetZoom(); } catch (e) {}
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

  function recenter() {
    autoScroll = true;
    const range = viewMax - viewMin; // keep current zoom level
    viewMin = Math.max(0, cursorTime - range * 0.3);
    viewMax = viewMin + range;
    chart.options.scales.x.min = viewMin;
    chart.options.scales.x.max = viewMax;
    chart.update('none');
  }

  canvas.addEventListener('dblclick', () => {
    recenter();
  });
  canvas.addEventListener('touchend', (e) => {
    if (yDragActive) return; // don't trigger on Y-axis drag end
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      recenter();
    }
    lastTap = now;
  });

  return {
    setCurveData,
    setCursorTime,
    setEffectOverlay,
    setTargetLine,
    setViewRange,
    resetView,
    recenter,
    toggleTooltip,
    setPDModel,
    destroy,
    get tooltipEnabled() { return tooltipEnabled; },
    get chart() { return chart; },
  };
}
