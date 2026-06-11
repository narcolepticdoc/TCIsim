/**
 * session.js — Case lifecycle: save, restore, new case.
 *
 * Extracted from app.js. Manages serializing/deserializing the
 * full application state to localStorage via the persist module.
 */

import { setPumpSettings, isPumpEnabled, DRUG_IDS } from '../util/constants.js';
import { fromCanonical, getDefaultUnit, formatValue } from '../util/units.js';
import * as persist from '../ui/persist.js';

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
    for (const drugId of DRUG_IDS) {
      modes[drugId] = mode.get(drugId);
      ceTargets[drugId] = mode.getCeTarget(drugId);
      intermittentThresholds[drugId] = mode.getIntermittentThreshold(drugId);
      exitCeTargets[drugId] = mode.getExitCe(drugId);
      pumpEnabled[drugId] = isPumpEnabled(drugId);
    }

    persist.saveCase({
      patient: confirmedPatient,
      events: eventsByDrug,
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
        const savedConc = localStorage.getItem('tci-pump-concentration');
        const savedRate = localStorage.getItem('tci-pump-max-rate')
                       ?? localStorage.getItem('tci-pump-rate');
        const bolusRateMlH = parseFloat(savedRate) || 750;
        setPumpSettings('propofol', {
          concentration: parseFloat(savedConc) || 10,
          bolusRateMlH,
        });
        const savedFentConc = localStorage.getItem('tci-pump-concentration-fentanyl');
        const savedFentPump = localStorage.getItem('tci-pump-enabled-fentanyl');
        setPumpSettings('fentanyl', {
          concentration: parseFloat(savedFentConc) || 0.05,
          bolusRateMlH,
          pumpEnabled: savedFentPump === 'true',
        });
        const savedKetConc = localStorage.getItem('tci-pump-concentration-ketamine');
        const savedKetPump = localStorage.getItem('tci-pump-enabled-ketamine');
        setPumpSettings('ketamine', {
          concentration: parseFloat(savedKetConc) || 10,
          bolusRateMlH,
          pumpEnabled: savedKetPump === 'true',
        });
      } catch (e) {}

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

      // Replay saved events (skip system-generated rate-restore events)
      if (saved.events) {
        for (const [drugId, drugEvents] of Object.entries(saved.events)) {
          for (const evt of drugEvents) {
            // Skip system events (rate restores after bolus) — addBolus generates these
            if (evt.source === 'system') continue;
            if (evt.type === 'rate') {
              model.addRate(drugId, evt.time, evt.value, evt.annotation || '', {
                source: evt.source || 'manual', // preserve 'tci' tag so the badge survives restore
              });
            } else if (evt.type === 'bolus') {
              model.addBolus(drugId, evt.time, evt.value, evt.annotation || '', {
                deliveryMode: evt.deliveryMode || 'pump', // default for old saved cases
                source: evt.source || 'manual',
              });
            } else if (evt.type === 'pause') {
              model.addPause(drugId, evt.time, evt.annotation || '');
            }
          }
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
