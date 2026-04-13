/**
 * session.js — Case lifecycle: save, restore, new case.
 *
 * Extracted from app.js. Manages serializing/deserializing the
 * full application state to localStorage via the persist module.
 */

import { setPumpSettings, DRUG_IDS } from '../util/constants.js';
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
    for (const drugId of DRUG_IDS) {
      modes[drugId] = mode.get(drugId);
      ceTargets[drugId] = mode.getCeTarget(drugId);
      intermittentThresholds[drugId] = mode.getIntermittentThreshold(drugId);
      exitCeTargets[drugId] = mode.getExitCe(drugId);
    }

    persist.saveCase({
      patient: confirmedPatient,
      events: eventsByDrug,
      wallClockStart: timer.getWallClock() ? new Date(timer.getWallClock().getTime() - timer.getElapsedMs()).toISOString() : null,
      modes,
      ceTargets,
      intermittentThresholds,
      exitCeTargets,
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
        setPumpSettings('fentanyl', {
          concentration: parseFloat(savedFentConc) || 0.05,
          bolusRateMlH,
        });
        const savedKetConc = localStorage.getItem('tci-pump-concentration-ketamine');
        setPumpSettings('ketamine', {
          concentration: parseFloat(savedKetConc) || 10,
          bolusRateMlH,
        });
      } catch (e) {}

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
              model.addRate(drugId, evt.time, evt.value, evt.annotation || '');
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

      // Restore annotations
      if (saved.annotations) {
        setAnnotations(saved.annotations);
        const list = $('history-list');
        const empty = $('history-empty');
        if (list && empty) {
          empty.style.display = 'none';
          list.innerHTML = '';
          saved.annotations.forEach((a, i) => {
            const row = document.createElement('div');
            row.className = 'history-row';
            row.innerHTML = `<span class="h-step">${i}</span>` +
              `<span class="h-desc"></span>` +
              `<span class="h-time">${a.time}</span>`;
            row.querySelector('.h-desc').textContent = a.text;
            list.appendChild(row);
          });
        }
      }

      // Start the case (timer)
      controls.ensureStarted();

      // Refresh chart
      refreshChart();

      addAnnotation('Case restored');
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
