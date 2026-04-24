/**
 * chart/index.js — TCI Chart Component orchestrator.
 *
 * Creates and manages a Chart.js instance for pharmacokinetic curves.
 * Sub-modules handle plugins, annotations, gestures, and state.
 */

import { COLORS } from '../../util/constants.js';
import { fromCanonical, getDefaultUnit, getPrefKey, formatValue, getAllowedUnits } from '../../util/units.js';

import { createState } from './state.js';
import { buildAnnotations } from './annotations.js';
import { attachGestures } from './gestures.js';
import { createTargetLabelPlugin } from './plugins/target-label.js';
import { createCursorDotsPlugin } from './plugins/cursor-dots.js';
import { createInspectDotsPlugin } from './plugins/inspect-dots.js';
import { createInspectHandlePlugin } from './plugins/inspect-handle.js';
import { createReadoutPanelPlugin } from './plugins/readout-panel.js';
import { createEventMarkersPlugin } from './plugins/event-markers.js';

const Chart = window.Chart;

if (!Chart) {
  console.warn('[TCI Sim] Chart.js not loaded — chart features disabled');
}

// Base font sizes for Chart.js config — multiplied by s.fontScale
// when the user picks a "Large type" setting.
const BASE_FONTS = {
  xTick: 9, xTitle: 10,
  yTick: 9, yTitle: 10,
  yRateTick: 9, yRateTitle: 10,
  legend: 10,
};

/**
 * Format an axis tick value. Chart.js's auto-computed min/max can produce
 * floating-point noise like 30.00000000000002; snap to 3 decimals and drop
 * the decimal entirely on integers so ticks read cleanly.
 */
function fmtTick(v) {
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? r.toString() : r.toFixed(1);
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

  const s = createState(cfg);

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
        if (!s.inspectEnabled) return;
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
          min: s.viewMin,
          max: s.viewMax,
          ticks: {
            color: '#6b7280',
            font: { size: 9 },
            maxTicksLimit: 12,
            callback: fmtTick,
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
            callback: fmtTick,
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
            ticks: { color: COLORS.rate, font: { size: 9 }, callback: fmtTick },
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
              if (s.rateValues.length > idx) {
                const rateMgMin = s.rateValues[idx];
                try {
                  const prefKey = getPrefKey(s.currentDrugId, 'rate');
                  let displayUnit = getDefaultUnit(s.currentDrugId, 'rate');
                  if (prefKey) {
                    try {
                      const saved = localStorage.getItem(prefKey);
                      const allowed = getAllowedUnits(s.currentDrugId, 'rate');
                      if (saved && allowed.includes(saved)) displayUnit = saved;
                    } catch (e) { /* ignore */ }
                  }
                  const ctx = { weightKg: s.patientWeightKg || undefined };
                  const displayVal = fromCanonical(rateMgMin, displayUnit, s.currentDrugId, 'rate', ctx);
                  lines.push(`Rate: ${formatValue(displayVal, displayUnit)} ${displayUnit}`);
                } catch (e) {
                  lines.push(`Rate: ${rateMgMin.toFixed(2)} mg/min`);
                }
              }
              if (s.pdModel) {
                const ceItem = items.find(it => {
                  const lbl = it.dataset && it.dataset.label;
                  return typeof lbl === 'string' && lbl.startsWith('Ce');
                });
                if (ceItem) {
                  try {
                    const ce  = ceItem.parsed.y / (s.yScale || 1);
                    const bis = s.pdModel.predict(ce);
                    if (Number.isFinite(bis)) lines.push(`eBIS: ${bis.toFixed(0)}`);
                  } catch (e) { /* ignore */ }
                }
              }
              return lines;
            },
          },
        },
        annotation: {
          annotations: buildAnnotations(s),
        },
        zoom: {
          limits: {
            x: { min: 0 },
          },
          pan: {
            enabled: true,
            mode: 'x',
            onPanStart() {
              s.autoScroll = false;
            },
            onPanComplete({ chart: c }) {
              s.autoScroll = false;
              s.viewMin = c.scales.x.min;
              s.viewMax = c.scales.x.max;
            },
          },
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: true },
            mode: 'x',
            onZoomStart() {
              s.autoScroll = false;
            },
            onZoomComplete({ chart: c }) {
              s.autoScroll = false;
              s.viewMin = c.scales.x.min;
              s.viewMax = c.scales.x.max;
            },
          },
        },
      },
    },
    plugins: [
      createTargetLabelPlugin(s),
      createCursorDotsPlugin(s),
      createInspectDotsPlugin(s),
      createInspectHandlePlugin(s),
      createReadoutPanelPlugin(s),
      createEventMarkersPlugin(s),
    ],
  });

  // ---- Public API ----

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

    s.rateValues = curveData.map(p => p.rate);

    if (s.yMaxManual === null && curveData.length > 0) {
      const maxCp = Math.max(...curveData.map(p => p.Cp));
      const maxCe = Math.max(...curveData.map(p => p.Ce));
      const maxConc = Math.max(maxCp, maxCe, s.targetCe || 0);
      chart.options.scales.y.max = Math.ceil(maxConc * 1.3);
    }

    chart.options.scales.x.min = s.viewMin;
    chart.options.scales.x.max = s.viewMax;

    canvas.style.display = 'block';
    const placeholder = document.getElementById('chart-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    chart.update('none');
  }

  function setCursorTime(t) {
    s.cursorTime = t;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);

    if (s.autoScroll && t > s.viewMax * 0.85) {
      const range = s.viewMax - s.viewMin;
      s.viewMin = Math.max(0, t - range * 0.3);
      s.viewMax = s.viewMin + range;
      try {
        chart.zoomScale('x', { min: s.viewMin, max: s.viewMax }, 'none');
      } catch (e) {
        chart.options.scales.x.min = s.viewMin;
        chart.options.scales.x.max = s.viewMax;
      }
    }

    chart.update('none');
  }

  function setEffectOverlay(bands) {
    s.effectBands = bands;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setThresholdLine(ce) {
    s.thresholdCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setPlateauRegion(region) {
    s.plateauRegion = region;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  /**
   * Show/hide the dose-reconciliation untrustworthy region.
   * Pass `{ xMin, xMax }` to show, or null to clear. Idempotent — safe to
   * call every frame from the bridge (CLAUDE.md invariant).
   */
  function setReconciliationRegion(region) {
    const cur = s.reconciliationRegion;
    if (!region) {
      if (!cur) return;
      s.reconciliationRegion = null;
    } else {
      if (cur && cur.xMin === region.xMin && cur.xMax === region.xMax) return;
      s.reconciliationRegion = { xMin: region.xMin, xMax: region.xMax };
    }
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setSteadyStateLine(ce) {
    s.steadyStateCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setTargetLine(ce) {
    s.targetCe = ce;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  /**
   * Show/hide the Ce drift tolerance band around the current target line.
   * Pass the tolerance fraction (e.g. 0.015 for ±1.5%) to show; pass null
   * or 0 to hide. Idempotent — safe to call every frame from the bridge.
   */
  function setCeToleranceBand(tolerance) {
    const next = (typeof tolerance === 'number' && tolerance > 0) ? tolerance : null;
    if (s.ceBandTolerance === next) return;
    s.ceBandTolerance = next;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setExitLine(ce) {
    s.exitCe = (ce && ce > 0) ? ce : null;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setViewRange(tMin, tMax) {
    s.viewMin = tMin;
    s.viewMax = tMax;
    s.autoScroll = false;
    try {
      chart.zoomScale('x', { min: s.viewMin, max: s.viewMax }, 'none');
    } catch (e) {
      chart.options.scales.x.min = s.viewMin;
      chart.options.scales.x.max = s.viewMax;
    }
    chart.update('none');
  }

  function resetView() {
    s.autoScroll = true;
    s.yMaxManual = null;
    try { localStorage.removeItem('chart-ymax-' + s.currentDrugId); } catch (e) { /* ignore */ }
    s.viewMin = 0;
    s.viewMax = 30;
    chart.options.scales.y.min = 0;
    delete chart.options.scales.y.max;
    try { chart.resetZoom('none'); } catch (e) { /* ignore */ }
    try {
      chart.zoomScale('x', { min: 0, max: 30 }, 'none');
    } catch (e) {
      chart.options.scales.x.min = 0;
      chart.options.scales.x.max = 30;
    }
    chart.update('none');
  }

  function recenter() {
    s.inspectTime = null;
    s.autoScroll = true;
    const range = s.viewMax - s.viewMin;
    s.viewMin = Math.max(0, s.cursorTime - range * 0.3);
    s.viewMax = s.viewMin + range;
    try {
      chart.zoomScale('x', { min: s.viewMin, max: s.viewMax }, 'none');
    } catch (e) {
      chart.options.scales.x.min = s.viewMin;
      chart.options.scales.x.max = s.viewMax;
    }
    chart.update('none');
  }

  function setInspectTime(t) {
    s.inspectTime = t;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function clearInspect() {
    if (s.inspectTime === null) return;
    s.inspectTime = null;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function toggleInspect() {
    s.inspectEnabled = !s.inspectEnabled;
    if (!s.inspectEnabled) clearInspect();
    return s.inspectEnabled;
  }

  function setPDModel(pd) {
    s.pdModel = pd || null;
  }

  function setPatientWeight(kg) {
    s.patientWeightKg = kg;
  }

  function switchDrug(drugId, yLabel, suggestedMax, yScale) {
    if (s.currentDrugId && s.yMaxManual !== null) {
      try { localStorage.setItem('chart-ymax-' + s.currentDrugId, String(s.yMaxManual)); } catch (e) { /* ignore */ }
    }

    s.currentDrugId = drugId;
    s.yScale = yScale || 1;
    s.thresholdCe = null;
    s.inspectTime = null;

    chart.options.scales.y.title.text = yLabel || 'μg/mL';

    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem('chart-ymax-' + drugId)); } catch (e) { /* ignore */ }
    if (isFinite(saved) && saved > 0) {
      s.yMaxManual = saved;
      chart.options.scales.y.max = s.yMaxManual;
      delete chart.options.scales.y.suggestedMax;
    } else {
      s.yMaxManual = null;
      delete chart.options.scales.y.max;
      chart.options.scales.y.suggestedMax = suggestedMax || 10;
    }
    chart.update('none');
  }

  // Attach gestures (Y-axis drag, double-tap recenter)
  const detachGestures = attachGestures(canvas, chart, s, recenter, setInspectTime);

  function destroy() {
    detachGestures();
    chart.destroy();
  }

  function setCpOpacity(opacity) {
    if (!cfg.showCp) return;
    const clamped = Math.max(0.1, Math.min(1.0, opacity));
    if (s.cpOpacity === clamped) return;
    s.cpOpacity = clamped;
    const ds = datasets[0];
    const a = Math.round(clamped * 255).toString(16).padStart(2, '0');
    ds.borderColor = COLORS.cp + a;
    ds.backgroundColor = COLORS.cp + Math.round(clamped * 0x18).toString(16).padStart(2, '0');
    chart.update('none');
  }

  function setNomogramOpacity(opacity) {
    const clamped = Math.max(0.1, Math.min(1.0, opacity));
    if (s.nomogramOpacity === clamped) return;
    s.nomogramOpacity = clamped;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setOverlayOpacity(opacity) {
    const hex = Math.round(Math.max(0.1, Math.min(1.0, opacity)) * 255).toString(16).padStart(2, '0');
    if (s.overlayAlpha === hex) return;
    s.overlayAlpha = hex;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  function setEventAnnotations(markers) {
    s.eventMarkers = Array.isArray(markers) ? markers : [];
    chart.update('none');
  }

  function toggleEventAnnotations() {
    s.eventAnnotationsEnabled = !s.eventAnnotationsEnabled;
    chart.update('none');
    return s.eventAnnotationsEnabled;
  }

  function setEventMarkerSize(px) {
    const clamped = Math.max(4, Math.min(16, Math.round(px)));
    if (s.eventMarkerSize === clamped) return;
    s.eventMarkerSize = clamped;
    chart.update('none');
  }

  function setFontScale(scale) {
    const k = Math.max(0.8, Math.min(2.0, Number(scale) || 1.0));
    if (s.fontScale === k) return;
    s.fontScale = k;
    const opts = chart.options;
    opts.scales.x.ticks.font.size = Math.round(BASE_FONTS.xTick * k);
    opts.scales.x.title.font.size = Math.round(BASE_FONTS.xTitle * k);
    opts.scales.y.ticks.font.size = Math.round(BASE_FONTS.yTick * k);
    opts.scales.y.title.font.size = Math.round(BASE_FONTS.yTitle * k);
    if (opts.scales.yRate) {
      opts.scales.yRate.ticks.font.size = Math.round(BASE_FONTS.yRateTick * k);
      opts.scales.yRate.title.font.size = Math.round(BASE_FONTS.yRateTitle * k);
    }
    opts.plugins.legend.labels.font.size = Math.round(BASE_FONTS.legend * k);
    // BIS band labels live inside the annotation plugin; rebuild picks up fontScale.
    opts.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  return {
    setCurveData,
    setCursorTime,
    setEffectOverlay,
    setTargetLine,
    setCeToleranceBand,
    setThresholdLine,
    setPlateauRegion,
    setReconciliationRegion,
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
    setFontScale,
    destroy,
    get inspectEnabled() { return s.inspectEnabled; },
    get eventAnnotationsEnabled() { return s.eventAnnotationsEnabled; },
    get chart() { return chart; },
  };
}
