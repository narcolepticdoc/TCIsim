/**
 * chart/index.js — TCI Chart Component orchestrator.
 *
 * Creates and manages a Chart.js instance for pharmacokinetic curves.
 * Sub-modules handle plugins, annotations, gestures, and state.
 */

import { COLORS, DRUG_DEFS, DRUG_IDS } from '../../util/constants.js';
import { fromCanonical, getDefaultUnit, getPrefKey, formatValue, getAllowedUnits } from '../../util/units.js';
import { alphaToHex } from '../../util/color.js';

import { createState } from './state.js';
import { buildAnnotations } from './annotations.js';
import { attachGestures } from './gestures.js';
import { createTargetLabelPlugin } from './plugins/target-label.js';
import { createCursorDotsPlugin } from './plugins/cursor-dots.js';
import { createInspectDotsPlugin } from './plugins/inspect-dots.js';
import { createCrossoverDotsPlugin } from './plugins/crossover-dots.js';
import { createInspectHandlePlugin } from './plugins/inspect-handle.js';
import { createPlanHandlePlugin } from './plugins/plan-handle.js';
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

// Format an x-axis tick (sim minutes) per the selected time-axis mode.
// Dedicated to the x-axis — the y-axes keep using the generic fmtTick.
// Mirrors the elapsed/real-time formatting in history.js fmtTime.
function fmtXTick(v, mode, wallClockStartMs) {
  if (!Number.isFinite(v)) return '';
  if (mode === 'rt' && wallClockStartMs != null) {
    const d = new Date(wallClockStartMs + v * 60000);
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  if (mode === 'hmin' || (mode === 'rt' && wallClockStartMs == null)) {
    const totalMin = Math.round(v);
    const sign = totalMin < 0 ? '-' : '';
    const a = Math.abs(totalMin);
    return sign + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }
  return fmtTick(v);
}

function xAxisTitle(mode) {
  if (mode === 'hmin') return 'Time (h:min)';
  if (mode === 'rt') return 'Clock time';
  return 'Time (min)';
}

/**
 * Read theme-derived chart colors from the document's CSS custom properties.
 * Chart.js doesn't observe CSS variables, so we sample them here at chart
 * construction and again whenever the user switches themes.
 */
export function readThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    axisTitle: v('--chart-axis-title', '#9ca3af'),
    tick:      v('--chart-tick',       '#6b7280'),
    grid:      v('--chart-grid',       '#1e293b'),
    legend:    v('--chart-legend',     '#9ca3af'),
    tooltipBg: v('--chart-tooltip-bg', '#1e293bee'),
    labelFg:   v('--chart-label-fg',   '#ffffff'),
  };
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

  // Sampled once here for chart construction; kept up-to-date by applyTheme().
  const theme = readThemeVars();

  // Resolve the foreground drug color from DRUG_DEFS — single source of
  // truth shared with drug-card highlights and analysis buttons. The Ce
  // trace adopts this color; setDrugColor() re-tints on drug switch.
  const initialDrugColor = (DRUG_DEFS[cfg.drugId] && DRUG_DEFS[cfg.drugId].color) || COLORS.ce;
  s.drugColor = initialDrugColor;

  // Build datasets
  const datasets = [];

  let cpDsIdx = -1;
  let ceDsIdx = -1;

  if (cfg.showCp) {
    cpDsIdx = datasets.length;
    datasets.push({
      label: 'Cp (μg/mL)',
      role: 'cp',
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
    ceDsIdx = datasets.length;
    datasets.push({
      label: 'Ce (μg/mL)',
      role: 'ce',
      data: [],
      borderColor: initialDrugColor,
      backgroundColor: initialDrugColor + '18',
      borderWidth: 3,
      pointRadius: 0,
      tension: 0.1,
      fill: false,
      order: 1,
    });
  }

  if (cfg.showRate) {
    datasets.push({
      label: 'Rate (mg/min)',
      role: 'rate',
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

  // Ghost Ce dataset — purple dashed line showing the pre-correction Ce
  // up to the moment of reconciliation. Empty by default; the bridge
  // pushes data only while a reconciliation window is active for the
  // currently-selected drug. Hidden via legend toggle isn't desired —
  // we control visibility by clearing/setting `data`.
  const ghostDsIdx = datasets.length;
  datasets.push({
    label: 'Ce (pre-reconcile)',
    role: 'ghost-reconcile',
    data: [],
    borderColor: COLORS.ghost,
    backgroundColor: COLORS.ghost + '00',
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    tension: 0.1,
    fill: false,
    spanGaps: false,
    order: 0, // draw on top of the live Ce so the comparison is legible
  });

  // Emergence trajectory dataset — red dashed projection of how Ce would
  // decay if the running infusion were stopped right now, descending until
  // it meets the horizontal emergence threshold line. Appearance is synced
  // to that threshold annotation (same red, same dash, same overlay alpha).
  // Empty by default; the bridge pushes data only while an emergence
  // threshold is set AND an infusion is running for the selected drug.
  const emergenceTrajDsIdx = datasets.length;
  datasets.push({
    label: 'Ce (if stopped)',
    role: 'emergence-traj',
    data: [],
    borderColor: COLORS.cp + s.overlayAlpha,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    tension: 0.1,
    fill: false,
    spanGaps: false,
    order: 0,
  });

  // Plan-preview datasets — the proposed dose's Ce/Cp, drawn while planning
  // mode is open and the user is typing/dragging a dose that hasn't been
  // committed. Same colours as the live traces (this IS the same drug), but
  // drawn on top while the committed traces dim back, so the eye reads the
  // proposal as the foreground and the current plan as the reference.
  const planCeDsIdx = datasets.length;
  datasets.push({
    label: 'Ce (proposed)',
    role: 'plan-preview-ce',
    data: [],
    borderColor: initialDrugColor,
    backgroundColor: 'transparent',
    borderWidth: 3,
    pointRadius: 0,
    tension: 0.1,
    fill: false,
    spanGaps: false,
    order: -1, // above every committed trace
  });

  const planCpDsIdx = datasets.length;
  datasets.push({
    label: 'Cp (proposed)',
    role: 'plan-preview-cp',
    data: [],
    borderColor: COLORS.cp,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.1,
    fill: false,
    spanGaps: false,
    order: -1,
  });

  // Per-drug ghost Ce datasets — peripheral-awareness traces for every
  // non-selected drug that has events. Each runs against its own hidden
  // Y-axis (yGhost_<drugId>) so the line height matches the user's
  // calibration for that drug, while X stays shared with the foreground.
  // Color = full saturation DRUG_DEFS color; secondary feel comes from
  // dash [2,4] + thin stroke + user-tunable alpha. Hidden by default;
  // toggled on via the chart's `∿` button.
  const ghostTraceDsIdx = {};
  const initialGhostAlphaHex = alphaToHex(s.ghostOpacity);
  for (const drugId of DRUG_IDS) {
    const def = DRUG_DEFS[drugId];
    if (!def) continue;
    ghostTraceDsIdx[drugId] = datasets.length;
    datasets.push({
      label: 'Ce ghost (' + drugId + ')',
      role: 'ghost-drug',
      drugId,
      data: [],
      borderColor: def.color + initialGhostAlphaHex,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [2, 4],
      pointRadius: 0,
      tension: 0.1,
      fill: false,
      hidden: true,
      yAxisID: 'yGhost_' + drugId,
      order: 4,
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
      // Suppress Chart.js's built-in hover/active-element points. Datasets set
      // pointRadius: 0 for the resting state, but the default pointHoverRadius (4)
      // still drew hollow rings on every curve at the hovered/clicked x-index
      // (interaction mode 'index'). The tooltip is disabled and onClick reads
      // event.x, so nothing depends on hover activation — kill the rings here.
      elements: { point: { hoverRadius: 0 } },
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
          title: { display: true, text: xAxisTitle(s.timeAxisMode), color: theme.axisTitle, font: { size: 10 } },
          min: s.viewMin,
          max: s.viewMax,
          ticks: {
            color: theme.tick,
            font: { size: 9 },
            maxTicksLimit: 12,
            callback: (v) => fmtXTick(v, s.timeAxisMode, s.wallClockStartMs),
          },
          grid: { color: theme.grid },
        },
        y: {
          type: 'linear',
          title: { display: true, text: 'μg/mL', color: theme.axisTitle, font: { size: 10 } },
          min: 0,
          suggestedMax: 8,
          ticks: {
            color: theme.tick,
            font: { size: 9 },
            callback: fmtTick,
          },
          grid: { color: theme.grid },
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
        // Per-drug hidden ghost Y-axes. `display: false` keeps Chart.js
        // positioning the line correctly while drawing nothing on either
        // side of the chart. The bridge sets `max` per drug via
        // setGhostAxisMax() so each ghost's height matches that drug's
        // foreground calibration.
        ...Object.fromEntries(DRUG_IDS.map(drugId => ['yGhost_' + drugId, {
          type: 'linear',
          display: false,
          min: 0,
          max: 10,
        }])),
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: theme.legend, font: { size: 10 }, boxWidth: 12, padding: 8,
            // Hide ghost datasets from the legend — both the
            // pre-reconcile purple dashed line and the per-drug ghost
            // traces are self-explanatory next to the live Ce. A
            // persistent legend entry would just add clutter. Same for the
            // plan-preview traces — they only exist inside planning mode,
            // which titles itself, and an always-present "(proposed)" entry
            // would be a permanent lie on the main screen.
            filter: (item) => !/(pre-reconcile|ghost|proposed)/i.test(item.text || ''),
          },
        },
        tooltip: {
          enabled: false,
          backgroundColor: theme.tooltipBg,
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
                const ceItem = items.find(it => it.dataset && it.dataset.role === 'ce');
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
      createCrossoverDotsPlugin(s),
      createInspectHandlePlugin(s),
      createPlanHandlePlugin(s),
      createReadoutPanelPlugin(s),
      createEventMarkersPlugin(s),
    ],
  });

  // ---- Public API ----

  /**
   * Y-axis maximum for the current data, when the user hasn't pinned one.
   *
   * Floored at the drug's default axis max so selecting a drug that has no
   * events yet cannot collapse the axis to zero and blank the chart — which
   * it used to, whenever no target line was set to prop the maximum up.
   *
   * The plan-preview curve counts toward the maximum as well: a proposed dose
   * that overshoots the committed one must stay on screen, or the drag handle
   * would be somewhere above the plot area with no way to grab it.
   */
  function autoYMax() {
    let peak = s.targetCe || 0;
    for (const idx of [cpDsIdx, ceDsIdx, planCeDsIdx, planCpDsIdx]) {
      if (idx < 0) continue;
      for (const point of datasets[idx].data) if (point.y > peak) peak = point.y;
    }
    return Math.max(Math.ceil(peak * 1.3), s.yDefaultMax || 10);
  }

  /**
   * Re-apply the auto Y max unless the user has pinned one by dragging the
   * axis — or is mid-drag on the plan handle, where rescaling would move the
   * curve out from under their finger on every frame. gestures.js re-applies
   * it on release.
   */
  function applyAutoYMax() {
    if (s.yMaxManual !== null || s._planDragging) return;
    chart.options.scales.y.max = autoYMax();
  }

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

    // Ghost Ce dataset is managed independently via setGhostCurve.
    // Re-applying live data here (e.g. on every refresh) must not
    // touch the ghost slot, which is what the index above guarantees.

    if (curveData.length > 0) applyAutoYMax();

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

  /**
   * Select the x-axis time-scale display: 'min' | 'hmin' | 'rt'.
   * wallClockStartMs anchors 'rt' (epoch ms for sim t=0). Idempotent — the
   * bridge pushes this every frame, so unchanged values early-return.
   */
  function setTimeAxisMode(mode, wallClockStartMs = null) {
    const m = (mode === 'hmin' || mode === 'rt') ? mode : 'min';
    if (m === s.timeAxisMode && wallClockStartMs === s.wallClockStartMs) return;
    s.timeAxisMode = m;
    s.wallClockStartMs = wallClockStartMs;
    const xScale = chart.options.scales.x;
    if (xScale) {
      xScale.title.text = xAxisTitle(m);
      xScale.ticks.callback = (v) => fmtXTick(v, s.timeAxisMode, s.wallClockStartMs);
    }
    chart.update('none');
  }

  function setPlateauRegion(region) {
    s.plateauRegion = region;
    chart.options.plugins.annotation.annotations = buildAnnotations(s);
    chart.update('none');
  }

  /**
   * Update the pre-correction Ce ghost-curve dataset.
   * Pass `points: [{ time, Ce }, ...]` (already y-scaled to the chart's
   * units), or null to clear. Idempotent — bridge calls every frame
   * (CLAUDE.md invariant). Comparison is by signature so we don't
   * rebuild the dataset every tick.
   */
  function setGhostCurve(points) {
    const sig = points && points.length > 0
      ? `${points.length}|${points[0].time}|${points[points.length - 1].time}|${points[points.length - 1].Ce.toFixed(4)}`
      : '';
    if (sig === s.ghostCurveSig) return;
    s.ghostCurveSig = sig;
    const ds = datasets[ghostDsIdx];
    ds.data = (points && points.length > 0)
      ? points.map(p => ({ x: p.time, y: p.Ce }))
      : [];
    chart.update('none');
  }

  /**
   * Update the emergence trajectory line (red dashed Ce projection assuming
   * the infusion stops now). Pass null/empty to clear. Signature-cache
   * guarded — the bridge calls this every frame. Re-tints borderColor from
   * the live `--red` CSS variable + current overlay alpha each call so it
   * stays in lockstep with the horizontal emergence threshold annotation
   * (theme switches + overlay-opacity changes).
   */
  function setEmergenceTrajectory(points) {
    const sig = points && points.length > 0
      ? `${points.length}|${points[0].time}|${points[points.length - 1].time}|${points[points.length - 1].Ce.toFixed(4)}|${s.overlayAlpha}`
      : '';
    if (sig === s.emergenceTrajSig) return;
    s.emergenceTrajSig = sig;
    const ds = datasets[emergenceTrajDsIdx];
    const red = (getComputedStyle(document.documentElement)
      .getPropertyValue('--red').trim() || COLORS.cp);
    ds.borderColor = red + s.overlayAlpha;
    ds.data = (points && points.length > 0)
      ? points.map(p => ({ x: p.time, y: p.Ce }))
      : [];
    chart.update('none');
  }

  // ---- Planning mode ----

  /**
   * How far the committed Ce/Cp traces fade back while a proposed dose is
   * on the chart. Low enough that the proposal clearly leads, high enough
   * that the comparison — the whole point of showing both — still reads.
   */
  const PLAN_DIM = 0.28;

  /** Fill alpha as a fraction of line alpha (the historical `18` hex byte). */
  const FILL_RATIO = 0x18 / 0xff;

  /**
   * Repaint the committed Ce/Cp traces from their three inputs: the drug
   * colour, the user's Cp-opacity setting, and whether a plan preview is up.
   *
   * Everything that touches those colours routes through here rather than
   * writing borderColor itself. Two reasons: setCpOpacity and setDrugColor
   * both early-return on an unchanged value (the bridge calls them every
   * frame), so a dim applied outside this function would be sticky in one
   * direction and unrecoverable in the other; and the bridge pushes
   * setCpOpacity ~60×/s, which would otherwise erase the dim immediately.
   */
  function _applyCommittedColors() {
    const k = s.planPreviewActive ? PLAN_DIM : 1;
    if (cfg.showCp && cpDsIdx >= 0) {
      const a = s.cpOpacity * k;
      datasets[cpDsIdx].borderColor = COLORS.cp + alphaToHex(a);
      datasets[cpDsIdx].backgroundColor = COLORS.cp + alphaToHex(a * FILL_RATIO);
    }
    if (cfg.showCe && ceDsIdx >= 0 && s.drugColor) {
      datasets[ceDsIdx].borderColor = s.drugColor + alphaToHex(k);
      datasets[ceDsIdx].backgroundColor = s.drugColor + alphaToHex(k * FILL_RATIO);
    }
  }

  /**
   * Push the proposed-dose curve. `points` are `[{time, Cp, Ce}]` already
   * y-scaled by the bridge; null/empty clears the preview and un-dims the
   * committed traces.
   *
   * Signature-guarded like every other per-frame setter (CLAUDE.md
   * invariant), but the active flag is compared too so entering and leaving
   * planning mode always repaints even when the points happen to match.
   */
  function setPlanPreview(points) {
    const has = !!(points && points.length > 0);
    const sig = has
      ? `${points.length}|${points[0].time}|${points[points.length - 1].time}|${points[points.length - 1].Ce.toFixed(4)}`
      : '';
    if (sig === s.planPreviewSig && has === s.planPreviewActive) return;
    s.planPreviewSig = sig;
    s.planPreviewActive = has;

    datasets[planCeDsIdx].data = has ? points.map(p => ({ x: p.time, y: p.Ce })) : [];
    datasets[planCpDsIdx].data = has && cfg.showCp
      ? points.map(p => ({ x: p.time, y: p.Cp }))
      : [];
    if (has && s.drugColor) datasets[planCeDsIdx].borderColor = s.drugColor;

    _applyCommittedColors();
    // A proposal that overshoots the committed curve has to stay on screen —
    // its drag handle is the control surface.
    applyAutoYMax();
    chart.update('none');
  }

  /**
   * Position the vertical drag handle, or clear it with null.
   * `spec` is `{ time, ce }` in chart units — the point the user grabs to
   * retitrate the dose.
   */
  function setPlanHandle(spec) {
    const next = (spec && Number.isFinite(spec.time) && Number.isFinite(spec.ce))
      ? { time: spec.time, ce: spec.ce }
      : null;
    const cur = s.planHandle;
    if (!next && !cur) return;
    if (next && cur && next.time === cur.time && next.ce === cur.ce) return;
    s.planHandle = next;
    chart.update('none');
  }

  /**
   * Register the callback the vertical handle drag reports to.
   * Receives the dragged Ce in CHART units; planning.js converts back.
   */
  function setPlanDragHandler(fn) {
    s._onPlanDrag = typeof fn === 'function' ? fn : null;
  }

  /**
   * Re-tint the foreground Ce trace to match the active drug's color.
   * Idempotent — bridge calls every frame (CLAUDE.md self-heal invariant).
   */
  function setDrugColor(drugId) {
    if (ceDsIdx < 0) return;
    const def = DRUG_DEFS[drugId];
    if (!def || !def.color) return;
    if (s.drugColor === def.color) return;
    s.drugColor = def.color;
    datasets[planCeDsIdx].borderColor = def.color;
    _applyCommittedColors();
    chart.update('none');
  }

  /**
   * Update per-drug ghost Ce traces.
   * `tracesByDrug` is `{ [drugId]: [{ time, Ce }, ...] | null }` — pass
   * null for a drug to clear that ghost (e.g. when its event list is
   * empty). Per-drug signature cache short-circuits unchanged drugs.
   */
  function setGhostTraces(tracesByDrug) {
    let dirty = false;
    for (const drugId of DRUG_IDS) {
      const dsIdx = ghostTraceDsIdx[drugId];
      if (dsIdx == null) continue;
      const ds = datasets[dsIdx];
      const points = tracesByDrug ? tracesByDrug[drugId] : null;
      const sig = points && points.length > 0
        ? `${drugId}|${points.length}|${points[0].time}|${points[points.length - 1].time}|${points[points.length - 1].Ce.toFixed(4)}`
        : `${drugId}|`;
      if (s.ghostTracesSigs[drugId] === sig) continue;
      s.ghostTracesSigs[drugId] = sig;
      ds.data = (points && points.length > 0)
        ? points.map(p => ({ x: p.time, y: p.Ce }))
        : [];
      dirty = true;
    }
    if (dirty) chart.update('none');
  }

  /**
   * Per-drug decay projections for background drugs. The crossover-dots plugin
   * reads these to place dimmed threshold-crossing dots on each drug's own
   * hidden ghost axis. No dataset is involved — the dots are canvas-drawn, so
   * nothing needs hiding from the legend.
   *
   * `byDrug` maps drugId to { traj: [{time, Ce}], exitCe, thresholdCe }, all
   * already scaled to that drug's ghost axis by the bridge. Idempotent per
   * drug (CLAUDE.md self-heal invariant) — the bridge calls this repeatedly.
   */
  function setGhostCrossings(byDrug) {
    let dirty = false;
    const seen = {};
    for (const drugId of DRUG_IDS) {
      const entry = byDrug ? byDrug[drugId] : null;
      const pts = entry && entry.traj;
      const sig = pts && pts.length > 1
        ? `${drugId}|${pts.length}|${pts[0].time}|${pts[pts.length - 1].time}|${entry.exitCe}|${entry.thresholdCe}`
        : `${drugId}|`;
      if (s.ghostCrossingsSigs[drugId] !== sig) {
        s.ghostCrossingsSigs[drugId] = sig;
        dirty = true;
      }
      if (pts && pts.length > 1) {
        seen[drugId] = {
          traj: pts.map(p => ({ x: p.time, y: p.Ce })),
          exitCe: entry.exitCe,
          thresholdCe: entry.thresholdCe,
        };
      }
    }
    if (!dirty) return;
    s.ghostCrossings = seen;
    chart.update('none');
  }

  /**
   * Set the Y-axis max for a drug's ghost trace. Bridge calls this once
   * per drug in refresh() so each ghost line height matches that drug's
   * own foreground Y calibration. Idempotent.
   */
  function setGhostAxisMax(drugId, max) {
    if (!Number.isFinite(max) || max <= 0) return;
    const ax = chart.options.scales['yGhost_' + drugId];
    if (!ax) return;
    if (ax.max === max) return;
    ax.max = max;
    chart.update('none');
  }

  /** Re-apply drug color × ghost opacity to all per-drug ghost datasets. */
  function _applyGhostColors() {
    const aHex = alphaToHex(s.ghostOpacity);
    for (const drugId of DRUG_IDS) {
      const dsIdx = ghostTraceDsIdx[drugId];
      if (dsIdx == null) continue;
      const def = DRUG_DEFS[drugId];
      if (!def) continue;
      datasets[dsIdx].borderColor = def.color + aHex;
    }
  }

  function setGhostOpacity(opacity) {
    const clamped = Math.max(0.1, Math.min(1.0, opacity));
    if (s.ghostOpacity === clamped) return;
    s.ghostOpacity = clamped;
    _applyGhostColors();
    chart.update('none');
  }

  /** Show/hide all per-drug ghost datasets, except the active drug's own ghost. */
  function _refreshGhostVisibility() {
    let changed = false;
    for (const drugId of DRUG_IDS) {
      const dsIdx = ghostTraceDsIdx[drugId];
      if (dsIdx == null) continue;
      const ds = datasets[dsIdx];
      const shouldHide = !s.ghostEnabled || drugId === s.currentDrugId;
      if (ds.hidden !== shouldHide) {
        ds.hidden = shouldHide;
        changed = true;
      }
    }
    return changed;
  }

  function setGhostEnabled(enabled) {
    const want = !!enabled;
    if (s.ghostEnabled === want) {
      // Even if the flag hasn't changed, re-evaluate per-dataset visibility
      // — switchDrug can leave a stale `hidden: true` on the now-non-active
      // drug's ghost. Idempotent inside _refreshGhostVisibility().
      if (_refreshGhostVisibility()) chart.update('none');
      return;
    }
    s.ghostEnabled = want;
    _refreshGhostVisibility();
    chart.update('none');
  }

  function toggleGhostTraces() {
    s.ghostEnabled = !s.ghostEnabled;
    _refreshGhostVisibility();
    chart.update('none');
    return s.ghostEnabled;
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
    // Inspect cursor is deliberately preserved across drug switches — it stays
    // at its current time position while setCurveData swaps in the new drug's
    // data. Only toggling inspect off (or New Case) clears it.

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
    // Remembered as the floor for setCurveData's autoscale — see there.
    s.yDefaultMax = suggestedMax || 10;

    // Re-tint the foreground Ce trace to the new drug's color and
    // re-evaluate ghost visibility so the new drug's own ghost is hidden
    // (its data is now drawn as the foreground) while the others reappear.
    setDrugColor(drugId);
    _refreshGhostVisibility();

    chart.update('none');
  }

  // Attach gestures (Y-axis drag, double-tap recenter)
  const detachGestures = attachGestures(canvas, chart, s, recenter, setInspectTime);

  // Releasing the plan handle un-freezes the autoscale (see applyAutoYMax)
  // and settles the axis around whatever dose the user landed on.
  s._onPlanDragEnd = () => { applyAutoYMax(); chart.update('none'); };

  function destroy() {
    detachGestures();
    chart.destroy();
  }

  function setCpOpacity(opacity) {
    if (!cfg.showCp) return;
    const clamped = Math.max(0.1, Math.min(1.0, opacity));
    if (s.cpOpacity === clamped) return;
    s.cpOpacity = clamped;
    _applyCommittedColors();
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

  /**
   * Re-read theme CSS variables and push the new colors into the chart.
   * Called by chart-bridge in response to the `tci:theme-change` event;
   * also safe to call any time after a CSS variable change.
   */
  function applyTheme() {
    const t = readThemeVars();
    const opts = chart.options;
    opts.scales.x.title.color = t.axisTitle;
    opts.scales.x.ticks.color = t.tick;
    opts.scales.x.grid.color  = t.grid;
    opts.scales.y.title.color = t.axisTitle;
    opts.scales.y.ticks.color = t.tick;
    opts.scales.y.grid.color  = t.grid;
    opts.plugins.legend.labels.color = t.legend;
    opts.plugins.tooltip.backgroundColor = t.tooltipBg;
    // Annotations sample CSS variables themselves on rebuild — see annotations.js.
    opts.plugins.annotation.annotations = buildAnnotations(s);
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
    setTimeAxisMode,
    setPlateauRegion,
    setReconciliationRegion,
    setGhostCurve,
    setEmergenceTrajectory,
    setPlanPreview,
    setPlanHandle,
    setPlanDragHandler,
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
    setDrugColor,
    setGhostTraces,
    setGhostCrossings,
    setGhostAxisMax,
    setGhostOpacity,
    setGhostEnabled,
    toggleGhostTraces,
    applyTheme,
    destroy,
    get inspectEnabled() { return s.inspectEnabled; },
    get inspectTime() { return s.inspectTime; },
    get eventAnnotationsEnabled() { return s.eventAnnotationsEnabled; },
    get ghostTracesEnabled() { return s.ghostEnabled; },
    get chart() { return chart; },
  };
}
