/**
 * session.js — Case lifecycle: save, restore, new case.
 *
 * Extracted from app.js. Manages serializing/deserializing the
 * full application state to localStorage via the persist module.
 */

import { setPumpSettings, getPumpSettings, isPumpEnabled, DRUG_IDS, DRUG_DEFS } from '../util/constants.js';
import { fromCanonical, getDefaultUnit, formatValue, getPrefKey, getSetupDefaultUnit } from '../util/units.js';
import * as persist from '../ui/persist.js';
import { rehydrateEvents } from '../sim/preview.js';

const $ = id => document.getElementById(id);

/**
 * Create session controller.
 *
 * @param {{
 *   getModel: Function,
 *   getConfirmedPatient: Function,
 *   setConfirmedPatient: Function,
 *   getSelectedDrug: Function,
 *   getAnnotations: Function,
 *   setAnnotations: Function,
 *   getChart: Function,
 *   destroyChart: Function,
 *   timer: object,
 *   mode: object,
 *   settings: object,
 *   controls: object,
 *   setup: object,
 *   initSimScreen: Function,
 *   showScreen: Function,
 *   addAnnotation: Function,
 *   refreshChart: Function,
 * }} deps
 */
export function createSession({
  getModel, getConfirmedPatient, setConfirmedPatient,
  getSelectedDrug, getAnnotations, setAnnotations,
  getChart, destroyChart,
  timer, mode, settings, controls, setup,
  initSimScreen, showScreen, addAnnotation, refreshChart,
}) {

  function save() {
    const model = getModel();
    const confirmedPatient = getConfirmedPatient();
    if (!model || !confirmedPatient) return;

    // Collect events for all drugs (strip snapshot — Float64Array won't serialize)
    const eventsByDrug = {};
    for (const drugId of DRUG_IDS) {
      eventsByDrug[drugId] = model.getEvents(drugId).map(evt => ({
        drug: evt.drug,
        time: evt.time,
        type: evt.type,
        value: evt.value,
        source: evt.source,
        deliveryMode: evt.deliveryMode,
        annotation: evt.annotation,
      }));
    }

    // Collect mode state for all drugs
    const modes = {};
    const ceTargets = {};
    const intermittentThresholds = {};
    const exitCeTargets = {};
    const pumpEnabled = {};
    const pumpConcentrations = {};
    for (const drugId of DRUG_IDS) {
      modes[drugId] = mode.get(drugId);
      ceTargets[drugId] = mode.getCeTarget(drugId);
      intermittentThresholds[drugId] = mode.getIntermittentThreshold(drugId);
      exitCeTargets[drugId] = mode.getExitCe(drugId);
      pumpEnabled[drugId] = isPumpEnabled(drugId);
      pumpConcentrations[drugId] = getPumpSettings(drugId).concentration;
    }

    persist.saveCase({
      patient: confirmedPatient,
      events: eventsByDrug,
      // Global pump bolus rate the events were planned/anchored under. On
      // restore, if the live global rate differs (a mid-case correction made
      // after this save), bolus deliveries are re-anchored to the new rate.
      bolusRateMlH: getPumpSettings('propofol').bolusRateMlH,
      // Per-drug pump concentration the case was planned under. Restored in
      // preference to the live global setting so an old case replays with its
      // original delivery volumes even if the global concentration changed
      // (and so a nonstandard concentration like 8.33 survives restore).
      pumpConcentrations,
      wallClockStart: timer.getWallClock() ? new Date(timer.getWallClock().getTime() - timer.getElapsedMs()).toISOString() : null,
      modes,
      ceTargets,
      intermittentThresholds,
      exitCeTargets,
      pumpEnabled,
      reconciliationWindows: model.getAllReconciliationWindows ? model.getAllReconciliationWindows() : {},
      reconciliationGhosts: model.getAllReconciliationGhosts ? model.getAllReconciliationGhosts() : {},
      annotations: getAnnotations(),
      primaryDrug: getSelectedDrug(),
    });
  }

  function restore() {
    const saved = persist.loadCase();
    if (!saved || !saved.patient) return;
    const model = getModel();

    try {
      // Apply saved pump settings before resetting model. Max Pump Rate is a
      // shared global (one physical pump) read from `tci-pump-max-rate`, with a
      // legacy fallback to the old per-propofol `tci-pump-rate` key. Each drug
      // has its own concentration.
      try {
        const savedRate = localStorage.getItem('tci-pump-max-rate')
                       ?? localStorage.getItem('tci-pump-rate');
        const bolusRateMlH = parseFloat(savedRate) || 750;
        // Prefer the concentration stored in the case snapshot (the value the
        // case was actually planned under); fall back to the live global for
        // old saves that predate `pumpConcentrations`.
        const caseConc = saved.pumpConcentrations || {};
        for (const drugId of DRUG_IDS) {
          // propofol's concentration key predates the per-drug suffix scheme.
          const concKey = drugId === 'propofol'
            ? 'tci-pump-concentration'
            : `tci-pump-concentration-${drugId}`;
          const storedConc = parseFloat(localStorage.getItem(concKey));
          setPumpSettings(drugId, {
            concentration: caseConc[drugId]
              ?? (storedConc > 0 ? storedConc : DRUG_DEFS[drugId].concentration),
            bolusRateMlH,
            // setPumpSettings ignores pumpEnabled for pump-mandatory drugs.
            pumpEnabled: localStorage.getItem(`tci-pump-enabled-${drugId}`) === 'true',
          });
        }
      } catch (e) {
        console.warn('[TCI Sim] Pump-settings restore failed, using defaults:', e);
      }

      // Restore pump-enabled state from saved case (takes precedence over localStorage
      // since it reflects the actual case configuration)
      if (saved.pumpEnabled) {
        for (const [drugId, enabled] of Object.entries(saved.pumpEnabled)) {
          setPumpSettings(drugId, { pumpEnabled: enabled });
        }
      }

      // Reset model and set patient
      model.reset();
      model.setPatient(saved.patient);
      setConfirmedPatient(saved.patient);

      // Replay saved events. Shared with the planning-mode preview clone
      // (js/sim/preview.js) so the two rebuild paths cannot drift — it skips
      // system rate-restores, which addBolus regenerates.
      if (saved.events) rehydrateEvents(model, saved.events);

      // Whole-timeline re-anchor: the rebuild above delivered every bolus at
      // the current global pump rate. If this case was saved under a different
      // rate (a correction happened after the save), move each bolus's
      // following step from the saved-rate bolus-end to the current one so the
      // restored plan is internally consistent. Bolus dose (mg) is unchanged.
      const savedRate = saved.bolusRateMlH;
      const curRate = getPumpSettings('propofol').bolusRateMlH;
      if (savedRate > 0 && curRate > 0 && Math.abs(savedRate - curRate) > 1e-9) {
        for (const drugId of DRUG_IDS) {
          model.reanchorBolusDeliveries(drugId, savedRate, curRate);
        }
      }

      // Initialize sim screen
      initSimScreen(saved.patient);
      showScreen('sim-screen');

      // Restore wall clock / timer
      if (saved.wallClockStart) {
        const startDate = new Date(saved.wallClockStart);
        timer.setWallClockStart(startDate);
      }

      // Restore modes (migrate old 'intermittent' → 'none'; threshold is restored below)
      if (saved.modes) {
        for (const [drugId, m] of Object.entries(saved.modes)) {
          mode.set(drugId, m === 'intermittent' ? 'none' : m);
        }
      }
      if (saved.ceTargets) {
        for (const [drugId, ce] of Object.entries(saved.ceTargets)) {
          if (ce > 0) mode.setCeTarget(drugId, ce);
        }
      }
      if (saved.intermittentThresholds) {
        for (const [drugId, thr] of Object.entries(saved.intermittentThresholds)) {
          if (thr > 0) mode.setIntermittentThreshold(drugId, thr);
        }
      }
      // Refresh UI after thresholds are restored so combined states display correctly
      mode.refreshUI(getSelectedDrug());
      if (saved.reconciliationWindows && model.setReconciliationWindow) {
        for (const [drugId, w] of Object.entries(saved.reconciliationWindows)) {
          if (w && typeof w.insertMin === 'number' && typeof w.endMin === 'number') {
            model.setReconciliationWindow(drugId, w.insertMin, w.endMin);
          }
        }
      }
      if (saved.reconciliationGhosts && model.setReconciliationGhost) {
        for (const [drugId, g] of Object.entries(saved.reconciliationGhosts)) {
          if (g && Array.isArray(g.points) && g.points.length > 0) {
            model.setReconciliationGhost(drugId, { capturedAt: g.capturedAt, points: g.points });
          }
        }
      }
      if (saved.exitCeTargets) {
        for (const [drugId, ce] of Object.entries(saved.exitCeTargets)) {
          if (ce > 0) {
            // Rebuild short numeric label from canonical value (e.g. "1.5", "0.2")
            const unit = getDefaultUnit(drugId, 'ceTarget') || 'mcg/mL';
            const displayVal = fromCanonical(ce, unit, drugId, 'ceTarget', {});
            // Strip trailing zeros: 1.50 → 1.5, 0.20 → 0.2
            const label = parseFloat(formatValue(displayVal, unit)).toString();
            mode.setExitCe(drugId, ce, label);
          }
        }
      }

      // Restore annotations — the unified history renderer (via refreshChart
      // below) paints them interleaved with pump events. No manual DOM build.
      if (saved.annotations) {
        setAnnotations(saved.annotations);
      }

      // Start the case (timer). Suppress the "Case Started" annotation —
      // the original is already in the restored annotations, and we add
      // "Case Restored" below.
      controls.ensureStarted({ restored: true });

      // Refresh chart
      refreshChart();

      // Re-select the drug card that was active at save time. Clicking the
      // card reuses the full selection chain in app.js (keypad, editor,
      // history, chart axis switch) instead of duplicating it here.
      if (saved.primaryDrug && DRUG_IDS.includes(saved.primaryDrug)) {
        $('drug-' + saved.primaryDrug)?.click();
      }

      addAnnotation('Case Restored');
    } catch (err) {
      console.error('[TCI Sim] Restore failed:', err);
      addAnnotation('\u26a0 Restore failed: ' + err.message);
    }
  }

  function newCase() {
    const model = getModel();
    // Reset model
    if (model) model.reset();

    // Reseed each drug/task's working display-unit preference from the
    // persistent setup default, so a mid-case unit swap in the previous case
    // does not leak into this fresh case. Mid-case swaps still stick and
    // survive save/restore (restore() deliberately leaves working keys alone).
    for (const drugId of DRUG_IDS) {
      for (const task of ['bolus', 'rate']) {
        const workKey = getPrefKey(drugId, task);
        if (!workKey) continue;
        try { localStorage.setItem(workKey, getSetupDefaultUnit(drugId, task)); } catch (e) {}
      }
    }

    setConfirmedPatient(null);
    setAnnotations([]);
    settings.reset();

    // Destroy chart
    destroyChart();

    // Reset UI modules
    controls.reset();
    mode.reset();
    setup.reset();
    showScreen('setup-screen');
  }

  return { save, restore, newCase };
}
