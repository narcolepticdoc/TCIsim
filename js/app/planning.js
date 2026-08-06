/**
 * planning.js — Dose planning mode.
 *
 * A screen that puts the chart and the dose entry surface side by side and
 * redraws the projected concentration curve live as the user types, taps ±,
 * or drags a handle on the proposal itself. Confirm commits exactly as the
 * dose-entry modal would; Cancel returns to that modal with the number intact.
 *
 * Two rules shape the whole module:
 *
 *  1. Nothing here mutates the case. Every projection runs on a throwaway
 *     clone (js/sim/preview.js), so the only way a dose reaches the model is
 *     the ordinary commit path.
 *
 *  2. Commit actions are DELEGATED to the real keypad buttons rather than
 *     reimplemented. The topbar's Confirm / IV Push / Clear leave planning
 *     mode and then click their counterparts in the keypad box, so the TCI
 *     delay modal, the push-vs-pump split, the last-dose memory and the
 *     "clear this threshold" path all behave identically whether the user
 *     came through planning mode or not.
 *
 * Layout is a separate `.screen` with the `.chart-area` node teleported in,
 * mirroring the analysis screen. That keeps the live chart instance — its
 * y-calibration, inspect cursor and gesture bindings all travel with the
 * node — and avoids fighting `.sim-main`, whose display model changes three
 * times across the responsive breakpoints.
 */

import { createPreview } from '../sim/preview.js';
import { getQuantStep, getAllowedUnits, fromCanonical, toCanonical, formatValue, formatValueStep, getQuantizeConfig }
  from '../util/units.js';
import { DRUG_DEFS } from '../util/constants.js';
import { classifyFutureEvents } from './chart-bridge.js';

const $ = id => document.getElementById(id);

/**
 * Debounce before recomputing. Long enough to type a multi-digit number
 * without the chart thrashing; short enough to feel live.
 * The TCI target gets more room — its projection runs the whole
 * cet-emulation planner (~20–55 ms) rather than a single curve.
 */
const DEBOUNCE_MS = 180;
const DEBOUNCE_MS_TCI = 260;

/**
 * A drag is NOT debounced — it coalesces on the animation frame instead, so
 * the curve tracks the finger at display rate. Measured per frame: ~2.7 ms to
 * back-solve the dose (warm-seeded from the previous one, ~4 clones) plus
 * ~1.1 ms to reproject, comfortably inside a 16 ms budget. A TCI target costs
 * more because each frame replans, and simply lands at whatever rate the
 * planner allows.
 */

/** While a case runs, "now" moves; re-anchor the projection on this cadence. */
const ANCHOR_TICK_MS = 1000;

/** Tasks that move a horizontal line and never touch the curve. */
const LINE_TASKS = new Set(['intermittent', 'exitCe']);

/**
 * Create the planning-mode controller.
 *
 * @param {Object} deps
 * @param {Function} deps.getModel
 * @param {Function} deps.getChart
 * @param {Function} deps.getSelectedDrug
 * @param {Function} deps.getEntryTime      - () => elapsed minutes for a new entry
 * @param {Function} deps.isCaseStarted
 * @param {Function} deps.getTciMode
 * @param {Function} deps.getTciDelayMin    - () => the TCI first-step delay in minutes
 * @param {Function} deps.resolveBolusDeliveryMode - (drugId, requested) => 'pump'|'push'
 * @param {Object}   deps.mode
 * @param {Object}   deps.keypad
 * @param {Object}   deps.chartBridge
 * @param {Object}   deps.settings
 * @param {Function} deps.showScreen
 * @param {Function} deps.teleportChart
 * @param {Function} deps.getChartHome      - () => the chart's home parent element
 * @param {Function} deps.refreshChart
 */
export function createPlanning(deps) {
  const {
    getModel, getChart, getSelectedDrug, getEntryTime, isCaseStarted,
    getTciMode, getTciDelayMin, resolveBolusDeliveryMode,
    mode, keypad, chartBridge, settings,
    showScreen, teleportChart, getChartHome, refreshChart,
  } = deps;

  const preview = createPreview();

  let active = false;
  let entry = null;          // last keypad entry snapshot
  let projection = null;     // last { points, peak, anchor, startTime }
  let debounceTimer = null;
  let anchorTimer = null;
  // Drag state. `dragging` suppresses the keystroke debounce — otherwise every
  // setCanonical during a drag would restart the 180 ms timer and the curve
  // would not redraw until the finger stopped moving.
  let dragging = false;
  let dragRaf = null;
  let dragPendingCe = null;
  let lastSolvedDose = null;

  function isActive() { return active; }

  // ---- Entry → action -----------------------------------------------------

  /**
   * Translate the keypad's current entry into the action `preview.applyAction`
   * understands. The bolus delivery mode comes from app.js's own resolver so
   * the projection can't disagree with what Confirm will actually deliver.
   */
  function buildAction(e) {
    const drugId = e.drugId;
    const wasTci = mode.get(drugId) === 'tci';

    if (e.type === 'bolus') {
      return {
        type: 'bolus',
        value: e.canonical,
        wasTci,
        deliveryMode: resolveBolusDeliveryMode(drugId, 'pump'),
      };
    }
    if (e.type === 'rate') {
      return { type: 'rate', value: e.canonical, wasTci };
    }
    if (e.type === 'ceTarget') {
      const quantConfig = getQuantizeConfig(drugId,
        typeof e.roundOverride === 'boolean' ? e.roundOverride : undefined);
      return {
        type: 'ceTarget',
        value: e.canonical,
        caseStarted: isCaseStarted(),
        tciDelayMin: isCaseStarted() ? getTciDelayMin() : 0,
        tciConfig: {
          tciMode: getTciMode(),
          ceTolerance: settings.getSettings().ceTolerance,
          ...quantConfig,
        },
      };
    }
    return { type: e.type, value: e.canonical };
  }

  /** Chart horizon, matched to chart-bridge.refresh() so the axes agree. */
  function horizonFor(model, drugId, t) {
    const events = model.getEvents(drugId);
    const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
    return Math.max(360, t + 360, lastEventTime + 360);
  }

  // ---- Projection ---------------------------------------------------------

  function recompute() {
    if (!active || !entry) return;
    const chart = getChart();
    const model = getModel();
    if (!chart || !model) return;

    const drugId = entry.drugId;
    const { yScale } = chartBridge.getConfig(drugId);

    // Line tasks change no concentration — only where the line sits.
    if (LINE_TASKS.has(entry.type)) {
      projection = null;
      chart.setPlanPreview(null);
      if (chart.setPlanEventMarkers) chart.setPlanEventMarkers([]);
      const v = Number.isFinite(entry.canonical) ? entry.canonical : 0;
      if (entry.type === 'exitCe') chart.setExitLine(v > 0 ? v * yScale : null);
      else chart.setThresholdLine(v > 0 ? v * yScale : null);
      // The decay trajectory the crossover dots sit on is computed in
      // chart-bridge from committed `mode` state — zero while a threshold is
      // being set for the first time, which left the dots with no line. Feed
      // it the value being previewed instead.
      if (chartBridge.setPlanThresholds) {
        chartBridge.setPlanThresholds(entry.type === 'exitCe'
          ? { exitCe: v > 0 ? v : 0 }
          : { thresholdCe: v > 0 ? v : 0 });
      }
      chart.setPlanHandle(v > 0 ? { time: midViewTime(chart), ce: v * yScale } : null);
      renderReadout();
      return;
    }

    // A zero still projects — it is the baseline, and it keeps the handle on
    // screen when the user drags a dose all the way down. Only an empty or
    // negative buffer has nothing to show.
    if (!Number.isFinite(entry.canonical) || entry.canonical < 0) {
      projection = null;
      chart.setPlanPreview(null);
      chart.setPlanHandle(null);
      if (chart.setPlanEventMarkers) chart.setPlanEventMarkers([]);
      renderReadout();
      return;
    }

    // Not a line task — no threshold override in play.
    if (chartBridge.setPlanThresholds) chartBridge.setPlanThresholds(null);

    const t = getEntryTime();
    const action = buildAction(entry);
    let result = null;
    try {
      result = preview.project(model, drugId, t, action, {
        endTime: horizonFor(model, drugId, t),
      });
    } catch (err) {
      console.error('[TCI Sim] Dose projection failed:', err);
    }

    projection = result;
    if (!result || !result.points.length) {
      chart.setPlanPreview(null);
      chart.setPlanHandle(null);
      if (chart.setPlanEventMarkers) chart.setPlanEventMarkers([]);
      renderReadout();
      return;
    }

    chart.setPlanPreview(yScale === 1 ? result.points : result.points.map(p => ({
      time: p.time, Ce: p.Ce * yScale, Cp: p.Cp * yScale,
    })));

    // Step markers, for a TCI retarget ONLY. A retarget emits a whole scheme
    // whose events exist only on the preview clone, so without markers the plan
    // being chosen shows as a bare curve with no indication of when the pump
    // changes. A manual bolus or rate is the opposite case: the curve's own
    // inflection already describes it completely, and the marker glyph means
    // "a scheduled event is coming" — which a dose about to be committed by
    // hand is not. Drawing one there implies a queued event that doesn't exist.
    if (chart.setPlanEventMarkers) {
      if (entry.type !== 'ceTarget') {
        chart.setPlanEventMarkers([]);
      } else {
        // The WHOLE event list goes in, not just the future slice: rate steps
        // are classified as increase/decrease against the preceding rate, so
        // starting the walk mid-sequence would mislabel the first one. The
        // nudged `now` keeps events landing exactly at startTime reading as
        // upcoming rather than dimmed-past.
        //
        // …then keep only the ones the proposal actually contains. A marker
        // before the projection starts has no curve to sit on — the binary
        // search would clamp it to the preview's first sample and stack it
        // against the left edge at the wrong height.
        chart.setPlanEventMarkers(
          classifyFutureEvents(result.events || [], result.startTime - 1e-6)
            .filter(m => !m.past));
      }
    }

    // A TCI target's handle rides its own target line, which is the value
    // being set — there is nothing to back-solve. Everything else hangs off
    // the projection's anchor point (peak for a bolus, +30 min for a rate).
    const isTarget = entry.type === 'ceTarget';
    const anchorCe = isTarget ? entry.canonical : (result.anchor ? result.anchor.Ce : null);
    const anchorTime = isTarget ? midViewTime(chart) : (result.anchor ? result.anchor.time : null);
    chart.setPlanHandle(anchorCe != null && anchorTime != null
      ? { time: anchorTime, ce: anchorCe * yScale }
      : null);
    if (isTarget) chart.setTargetLine(entry.canonical * yScale);

    renderReadout();
  }

  function midViewTime(chart) {
    try {
      const x = chart.chart.scales.x;
      if (x && Number.isFinite(x.min) && Number.isFinite(x.max)) {
        return x.min + (x.max - x.min) * 0.55;
      }
    } catch (e) { /* fall through */ }
    return getEntryTime() + 30;
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = entry && entry.type === 'ceTarget' ? DEBOUNCE_MS_TCI : DEBOUNCE_MS;
    debounceTimer = setTimeout(() => { debounceTimer = null; recompute(); }, wait);
  }

  // ---- Readout ------------------------------------------------------------

  /** Format a canonical Ce in the drug's own display unit. */
  function ceText(drugId, canonicalCe) {
    const unit = getAllowedUnits(drugId, 'ceTarget')[0] || 'mcg/mL';
    try {
      const v = fromCanonical(canonicalCe, unit, drugId, 'ceTarget', {});
      return `${formatValue(v, unit)} ${unit}`;
    } catch (e) {
      return `${canonicalCe.toFixed(2)} mcg/mL`;
    }
  }

  function item(label, value) {
    return `<span class="pr-item"><span class="pr-label">${label}</span>` +
           `<span class="pr-value">${value}</span></span>`;
  }

  function renderReadout() {
    const el = $('planning-readout');
    if (!el) return;
    if (!entry) { el.innerHTML = ''; return; }

    if (LINE_TASKS.has(entry.type)) {
      el.innerHTML = Number.isFinite(entry.canonical) && entry.canonical > 0
        ? item(entry.type === 'exitCe' ? 'Emergence' : 'Redose', ceText(entry.drugId, entry.canonical))
        : item('', 'not set');
      return;
    }

    if (!projection || !projection.points.length) { el.innerHTML = ''; return; }

    const drugId = entry.drugId;
    const parts = [];

    if (projection.anchor) {
      const dt = projection.anchor.time - projection.startTime;
      parts.push(item(entry.type === 'rate' ? 'Ce @ +30m' : 'Peak',
        ceText(drugId, projection.anchor.Ce)));
      if (entry.type !== 'rate') parts.push(item('at', `+${dt.toFixed(1)} min`));
    } else if (projection.peak) {
      parts.push(item('Peak', ceText(drugId, projection.peak.Ce)));
    }

    // Where it lands 10 minutes out — the "and then what" the peak alone
    // doesn't answer.
    const at10 = projection.points.find(p => p.time >= projection.startTime + 10);
    if (at10) parts.push(item('+10 min', ceText(drugId, at10.Ce)));

    el.innerHTML = parts.join('');
  }

  // ---- Titration ----------------------------------------------------------

  /**
   * Step size for one ± press, in DISPLAY units.
   *
   * Dose tasks use the drug's own quantize grid, so a press lands on a number
   * the pump can actually take. Ce tasks (target / redose / emergence) have no
   * grid — their step is derived from the magnitude on screen, which keeps
   * both 3 µg/mL propofol and 800 ng/mL ketamine usable from the same buttons.
   */
  function stepFor(e) {
    const explicit = getQuantStep(e.drugId, e.task, e.unit);
    if (explicit) return explicit;
    const ref = Math.abs(e.value) > 0 ? Math.abs(e.value) : 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(ref)));
    return magnitude / 10;
  }

  function titrate(direction) {
    if (!active || !entry) return;
    const step = stepFor(entry);
    if (!(step > 0)) return;
    const current = Number.isFinite(entry.value) ? entry.value : 0;

    // Step onto the next grid multiple in the direction of travel, rather
    // than adding a step to whatever was typed. A hand-typed 47 mcg of
    // fentanyl (grid 5) goes to 50 on the first press up and 45 down.
    const k = direction > 0
      ? Math.floor(current / step + 1e-9) + 1
      : Math.ceil(current / step - 1e-9) - 1;
    const next = Math.max(0, Number((k * step).toFixed(10)));

    try {
      const weightKg = getModel()?.getPatient()?.weight || 70;
      const canonical = toCanonical(next, entry.unit, entry.drugId, entry.task, { weightKg }).value;
      if (Number.isFinite(canonical)) keypad.setCanonical(canonical, { step });
    } catch (err) { /* an unconvertible step just doesn't move */ }
  }

  function renderStepLabel() {
    const el = $('plan-step-label');
    if (!el) return;
    if (!entry) { el.textContent = ''; return; }
    const step = stepFor(entry);
    el.textContent = `± ${formatValueStep(step, entry.unit, step)} ${entry.unit}`;
  }

  // ---- Drag ---------------------------------------------------------------

  /**
   * The handle was dragged to `chartCe` (chart units). Translate back to a
   * dose. A TCI target and the two threshold lines map straight through —
   * the dragged value IS the value. A bolus or rate has to be back-solved.
   */
  function onDrag(chartCe) {
    if (!active || !entry) return;
    dragging = true;
    dragPendingCe = chartCe;
    // Coalesce: a fast drag fires many pointer events per frame, and only the
    // last position matters. One solve+reproject per frame, no throttle.
    if (dragRaf === null) dragRaf = requestAnimationFrame(runDragFrame);
  }

  function runDragFrame() {
    dragRaf = null;
    if (!active || !entry || dragPendingCe === null) return;
    const chartCe = dragPendingCe;
    dragPendingCe = null;

    const { yScale } = chartBridge.getConfig(entry.drugId);
    const canonicalCe = chartCe / (yScale || 1);
    if (!(canonicalCe > 0)) return;

    // The dragged value IS the value for a target or a threshold line.
    // Precision follows the drug's step (fentanyl 0.05 ng/mL, ketamine 10) so
    // the number tracks the finger instead of snapping through the whole
    // clinical range in a few jumps.
    if (entry.type === 'ceTarget' || LINE_TASKS.has(entry.type)) {
      keypad.setCanonical(canonicalCe, { step: stepFor(entry) });
      recompute();
      return;
    }

    const model = getModel();
    if (!model) return;
    const action = buildAction(entry);
    let dose = null;
    try {
      // Warm-seeded from the previous frame's answer: the target barely moves
      // between frames, so the bracket search starts close and converges in a
      // handful of iterations instead of growing one from scratch.
      dose = preview.solveDose(model, entry.drugId, getEntryTime(), action, canonicalCe, {
        seed: lastSolvedDose ?? entry.canonical ?? 0,
      });
    } catch (err) {
      console.error('[TCI Sim] Dose back-solve failed:', err);
    }
    if (dose == null) return;
    lastSolvedDose = dose;
    keypad.setCanonical(dose, { step: stepFor(entry) });
    // Redraw now rather than through the debounce — this IS the interaction.
    recompute();
  }

  /** Gestures reports the release; settle on a final, un-coalesced projection. */
  function onDragEnd() {
    dragging = false;
    lastSolvedDose = null;
    if (dragRaf !== null) { cancelAnimationFrame(dragRaf); dragRaf = null; }
    if (dragPendingCe !== null) { dragPendingCe = null; }
    if (active) recompute();
  }

  // ---- Enter / exit -------------------------------------------------------

  /** Mirror the keypad's own action buttons into the topbar. */
  function syncTopbarActions() {
    const confirmBtn = $('btn-planning-confirm');
    const kConfirm = $('keypad-confirm-btn');
    if (confirmBtn && kConfirm) confirmBtn.textContent = kConfirm.textContent;

    const pushBtn = $('btn-planning-push');
    const kPush = $('keypad-push-btn');
    if (pushBtn) pushBtn.style.display = (kPush && kPush.style.display !== 'none') ? '' : 'none';

    const clearBtn = $('btn-planning-clear');
    const kClear = $('keypad-clear-btn');
    if (clearBtn) clearBtn.style.display = (kClear && kClear.style.display !== 'none') ? '' : 'none';
  }

  function enter() {
    if (active) return;
    const chart = getChart();
    const host = $('planning-chart-host');
    const entryHost = $('planning-entry-host');
    if (!chart || !host || !entryHost) return;

    entry = keypad.getEntry();
    active = true;

    const def = DRUG_DEFS[entry.drugId] || {};
    const titleEl = $('planning-title');
    if (titleEl) {
      titleEl.textContent = `${def.name || entry.drugId} — ${$('keypad-title')?.textContent || 'Plan Dose'}`;
    }
    const screen = $('planning-screen');
    if (screen && def.color) screen.style.setProperty('--drug-color', def.color);

    syncTopbarActions();
    renderStepLabel();

    teleportChart(host);
    keypad.attachTo(entryHost);
    showScreen('planning-screen');

    chart.setPlanDragHandler(onDrag, onDragEnd);
    recompute();

    // "Now" advances during a running case, so the projection's anchor would
    // drift out from under the user if it were only recomputed on keystrokes.
    if (anchorTimer) clearInterval(anchorTimer);
    if (isCaseStarted()) {
      anchorTimer = setInterval(() => { if (active) recompute(); }, ANCHOR_TICK_MS);
    }

    document.addEventListener('keydown', onKeyDown, true);
  }

  /**
   * Leave planning mode.
   * @param {Object} opts
   * @param {boolean} [opts.reopenModal] - hand back to the dose-entry modal
   */
  function leave({ reopenModal = false } = {}) {
    if (!active) return;
    active = false;

    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (anchorTimer) { clearInterval(anchorTimer); anchorTimer = null; }
    document.removeEventListener('keydown', onKeyDown, true);

    dragging = false;
    lastSolvedDose = null;
    dragPendingCe = null;
    if (dragRaf !== null) { cancelAnimationFrame(dragRaf); dragRaf = null; }

    const chart = getChart();
    if (chart) {
      chart.setPlanDragHandler(null);
      chart.setPlanPreview(null);
      chart.setPlanHandle(null);
      if (chart.setPlanEventMarkers) chart.setPlanEventMarkers([]);
    }

    if (chartBridge.setPlanThresholds) chartBridge.setPlanThresholds(null);
    keypad.detach({ reopen: reopenModal });
    const home = getChartHome();
    if (home) teleportChart(home);
    showScreen('sim-screen');

    // Restores the committed target / threshold / emergence lines, which the
    // line-task preview moved, and repaints the curve at full opacity.
    refreshChart();

    projection = null;
    entry = null;
  }

  /** Cancel — back to the dose-entry modal with the typed value intact. */
  function cancel() { leave({ reopenModal: true }); }

  /**
   * Commit via one of the keypad's own buttons. Leaving first puts the box
   * back in its overlay, so the click runs exactly the path it would have
   * run had the user never opened planning mode.
   */
  function commitVia(buttonId) {
    if (!active) return;
    leave({ reopenModal: false });
    $(buttonId)?.click();
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  // ---- Wiring -------------------------------------------------------------

  /** Called by the keypad on every buffer edit. */
  function handleEntryChange(next) {
    entry = next;
    if (!active) return;
    syncTopbarActions();
    renderStepLabel();
    // A drag drives its own redraw on the animation frame. Going through the
    // debounce here would restart the timer on every frame, so the curve would
    // not move until the finger stopped.
    if (!dragging) schedule();
  }

  function initListeners() {
    $('btn-planning-cancel')?.addEventListener('click', cancel);
    $('btn-planning-confirm')?.addEventListener('click', () => commitVia('keypad-confirm-btn'));
    $('btn-planning-push')?.addEventListener('click', () => commitVia('keypad-push-btn'));
    $('btn-planning-clear')?.addEventListener('click', () => commitVia('keypad-clear-btn'));

    wireStepButton($('btn-plan-down'), -1);
    wireStepButton($('btn-plan-up'), +1);
  }

  /**
   * ± with press-and-hold repeat. Bound on pointerdown for the same reason
   * the keypad's digits are (synthesized clicks drop under fast touch).
   */
  function wireStepButton(btn, direction) {
    if (!btn) return;
    let holdTimeout = null;
    let repeatInterval = null;

    const stop = () => {
      if (holdTimeout) { clearTimeout(holdTimeout); holdTimeout = null; }
      if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
    };

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      titrate(direction);
      holdTimeout = setTimeout(() => {
        repeatInterval = setInterval(() => titrate(direction), 90);
      }, 450);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
  }

  return {
    enter,
    cancel,
    isActive,
    handleEntryChange,
    initListeners,
  };
}
