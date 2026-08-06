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
export function classifyFutureEvents(events, now) {
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
  let lastGhostCrossUpdate = 0;
  let lastSsCe = null;
  let lastPlateauRegion = null;
  let lastEventMarkersKey = '';
  // Last non-'rt' time-axis mode, tracked every frame in onFrame. The history
  // RT toggle restores this so turning real-time off never destroys the chart's
  // min-vs-h:min tick choice.
  let lastNonRtMode = 'min';

  // Threshold values being previewed in planning mode, or null. The decay
  // trajectory below normally reads committed `mode` state — which is 0 while
  // a threshold is being set for the FIRST time, so no trajectory was drawn
  // and the crossover dots had nothing to sit on. Editing an existing
  // threshold happened to work because the old value was still non-zero.
  let planThresholds = null;

  /**
   * Preview thresholds for the decay trajectory.
   * @param {{exitCe?: number, thresholdCe?: number}|null} o - canonical mcg/mL
   */
  function setPlanThresholds(o) {
    planThresholds = o || null;
  }

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
   * Per-drug decay projections for the background drugs, feeding the ghosted
   * crossover dots. Mirrors the foreground trajectory logic in onFrame, but
   * for every non-selected drug.
   *
   * Only runs while ghost traces are on — with the toggle off (the default)
   * the whole feature costs nothing, which matters because each drug here is
   * a full decay simulation. The trajectory is sampled at a coarse 1-minute
   * step: it is never drawn, only interpolated for a crossing, so the default
   * 0.25 min sampling would be four times the engine work and array size for
   * no visible gain.
   */
  function updateGhostCrossings(t) {
    const chart = getChart();
    const model = getModel();
    if (!chart || !model || !chart.setGhostCrossings) return;
    if (!chart.ghostTracesEnabled) { chart.setGhostCrossings({}); return; }

    const selectedDrug = getSelectedDrug();
    const byDrug = {};
    for (const drugId of DRUG_IDS) {
      if (drugId === selectedDrug) continue;
      const drugEvents = model.getEvents(drugId);
      if (!drugEvents || drugEvents.length === 0) continue;

      // A decay projection is only a real forecast when nothing more is going
      // in. While an infusion runs — or more dosing is queued — it is a "what
      // if", and its crossing would sit far from this drug's own ghost trace
      // with no line to sit on: unlike the foreground, a background drug draws
      // no "Ce (if stopped)" trajectory to anchor the dot. Skipping here also
      // means the (expensive) decay simulation below is never run for a
      // running drug, which is the common case.
      if (model.getRateAtTime(drugId, t) > 0) continue;
      if (drugEvents.some(e => e.time > t &&
          (e.type === 'bolus' || (e.type === 'rate' && e.value > 0)))) continue;

      const exitCe = mode.getExitCe(drugId);
      const redoseCe = mode.getIntermittentThreshold(drugId);
      const targets = [exitCe, redoseCe].filter(v => v > 0);
      if (!targets.length || !(t > 0)) continue;
      const target = Math.min(...targets);
      const conc = model.getConcentrationsAt(drugId, t);
      if (!conc || !(conc.Ce > target)) continue;

      const traj = model.computeDecayTrajectory(drugId, t, target, { step: 1 });
      if (!traj || traj.length < 2) continue;

      // Scale onto this drug's own ghost axis — never the foreground's.
      const ys = getConfig(drugId).yScale;
      byDrug[drugId] = {
        traj: ys === 1 ? traj : traj.map(p => ({ time: p.time, Ce: p.Ce * ys })),
        exitCe: exitCe > 0 ? exitCe * ys : 0,
        thresholdCe: redoseCe > 0 ? redoseCe * ys : 0,
      };
    }
    chart.setGhostCrossings(byDrug);
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
    // Inspect cursor persists across refreshes (drug switches, dosing, edits);
    // its renderers recompute from s.inspectTime against the new curve.
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

    // Ghosted crossover dots for the background drugs. Also refreshed on the
    // onFrame throttle, but recomputed here too so a dosing edit moves them
    // immediately rather than up to 2 s later.
    updateGhostCrossings(t);

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

    // Control-bar state that depends on the event list — currently the Redose
    // button's dose and visibility. Every path that adds, edits, deletes,
    // reconciles or restores a bolus ends here, so one call covers them all;
    // refreshUI is cheap and idempotent (it already runs on every drug-card
    // click). Doing this per-frame in onFrame would re-scan the event list
    // ~60x/s for a value that only changes on mutation.
    mode.refreshUI(selectedDrug);

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
    // Slow lane — history past/future dimming and the background-drug
    // crossover dots, both throttled to every 2s.
    {
      const now = Date.now();
      if (!lastHistoryDimUpdate || now - lastHistoryDimUpdate > 2000) {
        lastHistoryDimUpdate = now;
        history.updateDimming();
      }
      // Background-drug crossover dots — one full decay simulation per
      // background drug, so throttled to the same 2 s cadence rather than
      // riding the 500 ms tick. The dots mark a projection minutes out; 2 s
      // of granularity is imperceptible.
      if (!lastGhostCrossUpdate || now - lastGhostCrossUpdate > 2000) {
        lastGhostCrossUpdate = now;
        updateGhostCrossings(t);
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

      // Decay projection — red dashed "Ce if stopped now" trend line. Projected
      // toward the LOWEST set threshold (redose or emergence) so it descends far
      // enough to cross both threshold lines; the crossover-dots plugin reads
      // this dataset to place its orange (redose) and red (emergence) dots.
      // Shown whenever a threshold is set AND current Ce is above it — regardless
      // of pump state, since the predictor already advances at rate 0. This keeps
      // the line visible while the pump is paused (e.g. after lowering the target),
      // which is exactly the decay it projects. Scaled to match the live Ce dataset.
      if (model && chart.setEmergenceTrajectory) {
        const exitCe   = planThresholds && planThresholds.exitCe != null
          ? planThresholds.exitCe : mode.getExitCe(selectedDrug);
        const redoseCe = planThresholds && planThresholds.thresholdCe != null
          ? planThresholds.thresholdCe : mode.getIntermittentThreshold(selectedDrug);
        const conc = model.getConcentrationsAt(selectedDrug, t);
        const targets = [exitCe, redoseCe].filter(v => v > 0);
        const target = targets.length ? Math.min(...targets) : 0;
        const showTrajectory = target > 0 && t > 0 && conc.Ce > target;
        if (showTrajectory) {
          const traj = model.computeDecayTrajectory(selectedDrug, t, target);
          const scaled = (traj && ys !== 1)
            ? traj.map(p => ({ time: p.time, Ce: p.Ce * ys }))
            : traj;
          chart.setEmergenceTrajectory(scaled && scaled.length ? scaled : null);
        } else {
          chart.setEmergenceTrajectory(null);
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
      if (chart.setCrossoverLabels) chart.setCrossoverLabels(!!s.crossoverTimeLabels);
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
      // X-axis time scale: min | h:min | real time. Feed the wall-clock
      // anchor (epoch ms for sim t=0) so 'rt' can render clock labels;
      // null falls back to h:min. Idempotent — early-returns when unchanged.
      if (typeof chart.setTimeAxisMode === 'function') {
        const wc = timer.getWallClockStart();
        chart.setTimeAxisMode(s.timeAxisMode ?? 'min', wc ? wc.getTime() : null);
      }
      // Reflect the current mode onto the on-chart time-axis button so its
      // label stays correct no matter which surface (this button or the
      // Settings segmented control) last changed the setting. Idempotent.
      const mode = s.timeAxisMode ?? 'min';
      const taBtn = $('btn-chart-timeaxis');
      if (taBtn) {
        const label = { min: 'min', hmin: 'h:m', rt: 'rt' }[mode] || 'min';
        if (taBtn.textContent !== label) taBtn.textContent = label;
        taBtn.classList.toggle('active', mode !== 'min');
      }
      // Sync the history log to the same real-time dimension as the chart axis:
      // clock time when the mode is 'rt', elapsed h:mm:ss otherwise. Remember the
      // last non-'rt' mode so the history RT toggle can restore the chart's tick
      // style (min vs h:min) when it turns real-time off. All idempotent.
      if (mode !== 'rt') lastNonRtMode = mode;
      history.setTimeFormat(mode === 'rt' ? 'rt' : 'et');
      const htBtn = $('btn-history-time');
      if (htBtn) {
        const etEl = htBtn.querySelector('.t-et');
        const rtEl = htBtn.querySelector('.t-rt');
        if (etEl) etEl.classList.toggle('active', mode !== 'rt');
        if (rtEl) rtEl.classList.toggle('active', mode === 'rt');
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

  function getLastNonRtMode() { return lastNonRtMode; }

  return { getConfig, computeEffectOverlay, refresh, onFrame, getLastNonRtMode, setPlanThresholds };
}
