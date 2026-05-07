/**
 * chart-bridge.js — Chart updates, effect overlay, and per-frame callbacks.
 *
 * Extracted from app.js. Owns the refreshChart cycle, BIS overlay
 * computation, per-drug chart configuration, and the rAF-driven
 * onFrame callback that updates the chart cursor, history dimming,
 * steady-state line, and plateau region.
 */

import { ceForBIS } from '../pk/pd.js';
import { DRUG_IDS } from '../util/constants.js';

const $ = id => document.getElementById(id);

/**
 * Classify TCI events into chart-marker kinds by walking the full event
 * list forward while tracking the running rate. Skips system-generated events
 * (e.g. rate-restore after a bolus). Tags each marker as past or future so
 * the chart can render past events dimmed.
 *
 * Classification compares each rate event against the last *non-zero* rate,
 * not the instantaneous running rate. This way a rate event that follows a
 * pause is labelled by its direction relative to the pre-pause level
 * (decrease/increase) rather than always being called "resume". A true
 * "resume" marker is only used when the new rate matches the prior rate
 * (or when no prior rate has ever been set).
 */
function classifyFutureEvents(events, now) {
  let currentRate = 0;
  let lastNonZeroRate = 0;
  const out = [];
  for (const e of events) {
    if (e.source === 'system') continue;
    const past = e.time <= now;
    if (e.type === 'pause' || (e.type === 'rate' && e.value === 0)) {
      out.push({ time: e.time, kind: 'stop', past });
      currentRate = 0;
    } else if (e.type === 'rate' && e.value > 0) {
      const ref = lastNonZeroRate;
      let kind = null;
      if (ref === 0)                  kind = 'resume';   // first rate ever set
      else if (e.value > ref)         kind = 'increase';
      else if (e.value < ref)         kind = 'decrease';
      else if (currentRate === 0)     kind = 'resume';   // equal to prior, after a pause
      // else: equal to prior with no pause → no-op, skip
      if (kind) out.push({ time: e.time, kind, past });
      currentRate = e.value;
      lastNonZeroRate = e.value;
    } else if (e.type === 'bolus') {
      out.push({ time: e.time, kind: 'bolus', past });
    }
  }
  return out;
}

// ---- Per-Drug Chart Configuration ----
// yScale: multiply canonical mcg/mL curve values before passing to chart
// yLabel: y-axis title
// yDefault: suggestedMax when no saved value exists
const CHART_DRUG_CONFIG = {
  propofol:     { yScale: 1,    yLabel: '\u03bcg/mL', yDefault: 10 },
  remifentanil: { yScale: 1,    yLabel: '\u03bcg/mL', yDefault: 10 },
  fentanyl:     { yScale: 1000, yLabel: 'ng/mL',  yDefault: 10 },
  ketamine:     { yScale: 1000, yLabel: 'ng/mL',  yDefault: 10000 },
};

/**
 * Create chart bridge controller.
 *
 * @param {{
 *   getChart: Function,
 *   getModel: Function,
 *   timer: object,
 *   getSelectedDrug: Function,
 *   mode: object,
 *   drugPanel: object,
 *   history: object,
 *   settings: object,
 *   save: Function,
 * }} deps
 */
export function createChartBridge({
  getChart, getModel, timer, getSelectedDrug,
  mode, drugPanel, history, settings, save,
}) {
  // Throttle state — replaces properties previously glued onto the chart object
  let lastCursorUpdate = 0;
  let lastHistoryDimUpdate = 0;
  let lastSsCe = null;
  let lastPlateauRegion = null;
  let lastEventMarkersKey = '';

  // Opacity / marker-size / font-scale setters are idempotent inside the chart
  // (early-return when the value matches) so we can call them every frame without
  // a bridge-level cache. Crucially, this makes chart recreation (new case) self-
  // heal: the fresh chart's state defaults differ from the user's settings, so the
  // first frame's push takes effect.

  const TEXT_SCALE = { normal: 1.0, large: 1.15, xl: 1.30, xxl: 1.45 };

  function getConfig(drugId) {
    return CHART_DRUG_CONFIG[drugId] || { yScale: 1, yLabel: '\u03bcg/mL', yDefault: 10 };
  }

  /**
   * Compute BIS overlay bands from the PD model.
   * Bands are drawn at Ce levels corresponding to BIS thresholds.
   */
  function computeEffectOverlay() {
    const chart = getChart();
    const model = getModel();
    const selectedDrug = getSelectedDrug();
    if (!chart || !model) return;
    const pd = model.getPDModel(selectedDrug);
    if (!pd) { chart.setEffectOverlay([]); return; }

    const params = pd.params;
    // ceForBIS(N) returns the Ce concentration at which BIS = N.
    // More drug -> lower BIS -> higher Ce, so: ce90 < ce80 < ce60 < ce40 < ce20 numerically.
    const ce90 = ceForBIS(90, params);  // Light Sedation upper boundary
    const ce80 = ceForBIS(80, params);  // Light Sedation / Deep Sedation boundary
    const ce60 = ceForBIS(60, params);  // Deep Sedation / GA boundary
    const ce40 = ceForBIS(40, params);  // GA / Deep Anesthesia boundary
    const ce20 = ceForBIS(20, params);  // Deep Anesthesia lower boundary

    // Theme-aware fill alpha: 19% for dark, ~33% for light. The 19% bands
    // tuned for a near-black backdrop are essentially invisible on white.
    const a = (getComputedStyle(document.documentElement)
                .getPropertyValue('--bis-band-alpha').trim() || '30');

    chart.setEffectOverlay([
      { ceMin: ce90, ceMax: ce80, color: '#ef4444' + a, label: 'Light Sedation' },  // Red    BIS 80-90
      { ceMin: ce80, ceMax: ce60, color: '#f97316' + a, label: 'Deep Sedation' },   // Orange BIS 60-80
      { ceMin: ce60, ceMax: ce40, color: '#eab308' + a, label: 'GA' },              // Yellow BIS 40-60
      { ceMin: ce40, ceMax: ce20, color: '#22c55e' + a, label: 'Deep Anesthesia' }, // Green  BIS 20-40
    ]);
  }

  /**
   * Recompute the curve and refresh the chart.
   * Called after every model mutation.
   */
  function refresh() {
    const chart = getChart();
    const model = getModel();
    const selectedDrug = getSelectedDrug();
    if (!chart || !model) return;
    const t = timer.getElapsedMinutes();

    // Compute end time: furthest event + 360 min forward buffer, minimum 360 min.
    // Matches the slope-based steady-state predictor's 6 h search horizon so the
    // chart can display the full predicted plateau region when users pan out.
    const events = model.getEvents(selectedDrug);
    const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
    const endTime = Math.max(360, t + 360, lastEventTime + 360);

    const rawCurve = model.computeCurve(selectedDrug, 0, endTime, 10 / 60);
    const { yScale } = getConfig(selectedDrug);
    const chartCurve = yScale === 1 ? rawCurve : rawCurve.map(pt => ({
      ...pt, Ce: pt.Ce * yScale, Cp: pt.Cp * yScale,
    }));
    // Keep the chart's PD model in sync with the currently selected drug
    // so the eBIS tooltip line reflects the right drug (null clears it
    // for fentanyl/ketamine which have no PD model).
    chart.setPDModel(model.getPDModel(selectedDrug));
    chart.clearInspect();
    chart.setCurveData(chartCurve);
    drugPanel.setCurveData(rawCurve);  // drug-panel uses canonical mcg/mL for threshold comparisons
    computeEffectOverlay();  // clears BIS bands for drugs without a PD model

    // Per-drug ghost Ce traces — peripheral awareness of every other
    // drug currently on the case. Only computed for drugs that have
    // events (avoids drawing flat-zero baselines on session start).
    // Each ghost runs against its own hidden Y-axis so the line height
    // matches the user's calibration for that drug.
    if (chart.setGhostTraces) {
      const tracesByDrug = {};
      for (const drugId of DRUG_IDS) {
        if (drugId === selectedDrug) continue;
        const drugEvents = model.getEvents(drugId);
        if (!drugEvents || drugEvents.length === 0) continue;
        const drugCurve = model.computeCurve(drugId, 0, endTime, 10 / 60);
        const ys = getConfig(drugId).yScale;
        tracesByDrug[drugId] = ys === 1
          ? drugCurve.map(p => ({ time: p.time, Ce: p.Ce }))
          : drugCurve.map(p => ({ time: p.time, Ce: p.Ce * ys }));

        // Match the ghost's Y-axis max to that drug's foreground
        // calibration: prefer a saved per-drug zoom, fall back to the
        // chart-config default. Idempotent inside the chart.
        let ghostMax = NaN;
        try { ghostMax = parseFloat(localStorage.getItem('chart-ymax-' + drugId)); } catch (e) {}
        if (!Number.isFinite(ghostMax) || ghostMax <= 0) ghostMax = getConfig(drugId).yDefault;
        if (chart.setGhostAxisMax) chart.setGhostAxisMax(drugId, ghostMax);
      }
      chart.setGhostTraces(tracesByDrug);
    }

    // Show chart controls
    const cc = $('chart-controls');
    if (cc) cc.style.display = 'flex';

    // Update target line (scale Ce target to match chart units)
    const m = mode.get(selectedDrug);
    const ce = mode.getCeTarget(selectedDrug);
    chart.setTargetLine(m === 'tci' && ce > 0 ? ce * yScale : null);

    // Intermittent threshold line (amber dashed, shown whenever threshold is set)
    const threshold = mode.getIntermittentThreshold(selectedDrug);
    chart.setThresholdLine(threshold > 0 ? threshold * yScale : null);

    // Exit Ce line (red dashed, mode-independent)
    const exitCeVal = mode.getExitCe(selectedDrug);
    chart.setExitLine(exitCeVal > 0 ? exitCeVal * yScale : null);

    // Update history panel
    history.render(selectedDrug);

    // Auto-save state
    save();
  }

  /**
   * Per-frame callback for drugPanel's rAF loop.
   * Updates chart cursor, history dimming, steady-state line,
   * plateau region, and settings warnings.
   */
  function onFrame(t) {
    const chart = getChart();
    const model = getModel();
    const selectedDrug = getSelectedDrug();

    // Update chart cursor — throttled to every 500ms
    if (chart && t > 0) {
      const now = Date.now();
      if (!lastCursorUpdate || now - lastCursorUpdate > 500) {
        lastCursorUpdate = now;
        chart.setCursorTime(t);
      }
    }
    // Update history past/future dimming — throttled to every 2s
    {
      const now = Date.now();
      if (!lastHistoryDimUpdate || now - lastHistoryDimUpdate > 2000) {
        lastHistoryDimUpdate = now;
        history.updateDimming();
      }
    }
    // Chart annotations — updated per-frame so they reflect the
    // freshly-computed approach data (which runs in the rAF loop BEFORE
    // this callback). Putting it in refreshChart would race: refreshChart
    // reads the data before updateApproachLine has computed it.
    if (chart) {
      const m = mode.get(selectedDrug);
      const { yScale: ys } = getConfig(selectedDrug);

      // Steady-state horizontal line (manual mode only)
      const ssCe = drugPanel.getSteadyStateCe(selectedDrug);
      if (ssCe && m === 'manual') {
        const scaled = ssCe * ys;
        if (lastSsCe !== scaled) {
          lastSsCe = scaled;
          chart.setSteadyStateLine(scaled);
        }
      } else if (lastSsCe) {
        lastSsCe = null;
        chart.setSteadyStateLine(null);
      }

      // Plateau region bounding box (manual mode only)
      const plat = drugPanel.getPlateauRegion(selectedDrug);
      if (plat && m === 'manual') {
        // Compute chart end time for permanent plateaus (endMin === null)
        const events = model ? model.getEvents(selectedDrug) : [];
        const lastEvt = events.length > 0 ? events[events.length - 1].time : 0;
        const chartEnd = Math.max(360, t + 360, lastEvt + 360);
        const region = {
          startMin: plat.startMin,
          endMin:   plat.endMin ?? chartEnd,
          ceMin:    plat.ceMin * ys,
          ceMax:    plat.ceMax * ys,
        };
        // Only update chart when region actually changed
        const prev = lastPlateauRegion;
        if (!prev || prev.startMin !== region.startMin || prev.endMin !== region.endMin ||
            Math.abs(prev.ceMin - region.ceMin) > 1e-9 || Math.abs(prev.ceMax - region.ceMax) > 1e-9) {
          lastPlateauRegion = region;
          chart.setPlateauRegion(region);
        }
      } else if (lastPlateauRegion) {
        lastPlateauRegion = null;
        chart.setPlateauRegion(null);
      }

      // Reconciliation region — amber band spanning [insertMin, endMin] on
      // the time axis, marking an interval whose Cp/Ce values should not be
      // trusted while the model rebalances from a retrospective correction.
      // Reads from simulation state directly; setter is idempotent so we
      // call unconditionally every frame (self-healing on chart recreation).
      if (model && chart.setReconciliationRegion) {
        const rw = model.getActiveReconciliationWindow(selectedDrug, t);
        if (rw) {
          chart.setReconciliationRegion({ xMin: rw.insertMin, xMax: rw.endMin });
        } else {
          chart.setReconciliationRegion(null);
        }
      }

      // Ghost Ce curve — purple dashed snapshot of what the simulation Ce
      // looked like immediately BEFORE the most recent reconciliation
      // correction was applied. Only show for the currently selected drug;
      // drug switches naturally clear it because the other drug's ghost
      // never gets pushed. Y-scaled to match the live Ce dataset.
      if (model && chart.setGhostCurve) {
        const ghost = model.getActiveReconciliationGhost(selectedDrug, t);
        const { yScale: ys } = getConfig(selectedDrug);
        if (ghost && ghost.points && ghost.points.length > 0) {
          const scaled = ys === 1
            ? ghost.points
            : ghost.points.map(p => ({ time: p.time, Ce: p.Ce * ys }));
          chart.setGhostCurve(scaled);
        } else {
          chart.setGhostCurve(null);
        }
      }

      // Future-event markers — only when the overlay is enabled.
      // Gated to TCI mode (manual mode rarely has pre-scheduled future events).
      if (chart.eventAnnotationsEnabled) {
        if (m === 'tci' && model) {
          const evts = model.getEvents(selectedDrug) || [];
          const markers = classifyFutureEvents(evts, t);
          const key = markers.map(x => `${x.time}:${x.kind}:${x.past ? 1 : 0}`).join('|');
          if (key !== lastEventMarkersKey) {
            lastEventMarkersKey = key;
            chart.setEventAnnotations(markers);
          }
        } else if (lastEventMarkersKey) {
          lastEventMarkersKey = '';
          chart.setEventAnnotations([]);
        }
      } else if (lastEventMarkersKey) {
        lastEventMarkersKey = '';
        chart.setEventAnnotations([]);
      }
    }
    // Appearance settings — setters are idempotent; safe to call every frame.
    if (chart) {
      const s = settings.getSettings();
      chart.setCpOpacity(s.cpOpacity ?? 1.0);
      chart.setNomogramOpacity(s.nomogramOpacity ?? 1.0);
      chart.setOverlayOpacity(s.overlayOpacity ?? 1.0);
      chart.setEventMarkerSize(s.eventMarkerSize ?? 7);
      // Ce drift band: visible only when the Appearance toggle is on AND
      // the active drug has a TCI target set. Null hides it.
      if (typeof chart.setCeToleranceBand === 'function') {
        chart.setCeToleranceBand(s.showCeBand ? (s.ceTolerance ?? 0.015) : null);
      }
      if (typeof chart.setFontScale === 'function') {
        chart.setFontScale(TEXT_SCALE[s.textSize] ?? 1.0);
      }
      // Foreground Ce trace color follows the active drug. Idempotent;
      // re-applies after chart recreation (new case) on the first frame.
      if (typeof chart.setDrugColor === 'function') {
        chart.setDrugColor(selectedDrug);
      }
      // Ghost trace appearance + on/off. setGhostEnabled is idempotent
      // and also re-evaluates per-dataset visibility relative to the
      // selected drug, so drug switches naturally hide/unhide ghosts.
      if (typeof chart.setGhostOpacity === 'function') {
        chart.setGhostOpacity(s.ghostOpacity ?? 0.5);
      }
      if (typeof chart.setGhostEnabled === 'function') {
        chart.setGhostEnabled(!!s.ghostTracesEnabled);
      }
    }
    // Check for upcoming events requiring advance warning
    if (t > 0) settings.check(t);
  }

  // The settings UI dispatches `tci:theme-change` after swapping
  // `<html data-theme>`. Push the new CSS variable values into the chart
  // (idempotent inside the chart itself), then recompute the BIS overlay
  // so the band fills pick up the per-theme `--bis-band-alpha`.
  document.addEventListener('tci:theme-change', () => {
    const chart = getChart && getChart();
    if (chart && typeof chart.applyTheme === 'function') chart.applyTheme();
    computeEffectOverlay();
  });

  return { getConfig, computeEffectOverlay, refresh, onFrame };
}
