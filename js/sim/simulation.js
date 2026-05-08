/**
 * simulation.js — Stateless Pharmacokinetic Model
 * 
 * A pure command/query interface over the event list and PK engines.
 * There is no concept of "now," no clock, no ticks, no state machine.
 * The model is deterministic: given a set of events and patient
 * parameters, concentrations at any time are a pure function.
 * 
 * The UI layer (app.js) owns:
 *   - The display timer and cursor position
 *   - Whether "playback" is running or paused
 *   - Mode tracking (TCI vs manual vs intermittent bolus)
 *   - Annotations and mode-change logging
 * 
 * Commands (mutate the event list):
 *   setPatient, addRate, addBolus, addPause,
 *   planTCI, editEvent, deleteEvent, deleteEventAndAfter
 * 
 * Queries (read-only):
 *   getConcentrationsAt, computeCurve, predictBIS,
 *   getEvents, getParams, getRateAtTime
 */

import { calcEleveldParams, MODEL_NAME as ELEVELD_MODEL_NAME } from '../pk/eleveld.js';
import { calcFentanylParams, MODEL_NAME as FENTANYL_MODEL_NAME } from '../pk/fentanyl.js';
import { calcKetamineParams, MODEL_NAME as KETAMINE_MODEL_NAME } from '../pk/ketamine.js';
import { createEngine } from '../pk/engine.js';
import { createPDModel } from '../pk/pd.js';
import { createEventList } from './events.js';
import { planTCIScheme, planTCISchemeCET, planTCISchemeCETConservative, planTCISchemeEmulation } from './tci-planner.js';
import { predictTroughTime } from '../pk/decay-predictor.js';
import { predictTimeToSteadyState as _predictTimeToSS, predictPlateau as _predictPlateau } from '../pk/steady-state-predictor.js';
import { DRUG_DEFS, getPumpSettings } from '../util/constants.js';

/**
 * Drugs that do not support TCI (Ce targeting).
 * These use manual rate + intermittent bolus mode only.
 */
export const NO_TCI_DRUGS = new Set(['fentanyl', 'ketamine']);

/**
 * @typedef {Object} ModelConfig
 * @property {string} primaryDrug   - Drug used for patient-derived params, default 'propofol'
 * @property {number} concentration - Drug concentration (mg/mL), default 10
 */
const DEFAULT_CONFIG = {
  primaryDrug: 'propofol',
  concentration: 10,         // mg/mL (1% propofol)
};

/**
 * Create a simulation model.
 * 
 * @param {ModelConfig} [config]
 * @returns {Object} Model interface
 */
export function createModel(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  let eventList = createEventList();
  let pdModels = {};               // { drugId: pdModel | null }
  let patient = { age: 35, weight: 70, height: 170, male: true, opioid: false };
  let params = null;               // PK-PD params for primary drug
  // Active dose-reconciliation windows keyed by drugId. Each entry:
  //   { insertMin, endMin } — the interval on the chart that should be
  //   marked as untrustworthy while the model reconverges after a
  //   retrospective correction bolus. See js/ui/reconcile-modal.js.
  const reconciliationWindows = {};
  // Pre-correction Ce snapshots, drawn on the chart as a ghost curve so
  // the user can compare the corrected curve against the original.
  // Keyed by drugId. Each entry: { capturedAt, points: [{time, Ce}, ...] }.
  // Cleared together with the matching reconciliationWindow.
  const reconciliationGhosts = {};

  // Registry of the PK model currently active for each drug.
  // When model-choice is added later, swap the entries here (and the
  // matching `calcFn` in init/setPatient) — the UI reads names only
  // through getModelName(drugId), so no UI changes are needed.
  const modelNames = {
    [cfg.primaryDrug]: ELEVELD_MODEL_NAME,
    fentanyl:          FENTANYL_MODEL_NAME,
    ketamine:          KETAMINE_MODEL_NAME,
  };

  // ---- Initialization ----

  function init() {
    params = calcEleveldParams(patient);

    const engine = createEngine(params);
    eventList.registerEngine(cfg.primaryDrug, engine);

    // Register drug config for bolus delivery computation
    const ps = getPumpSettings(cfg.primaryDrug);
    eventList.registerDrugConfig(cfg.primaryDrug, {
      concentration: ps.concentration,
      bolusRateMlH: ps.bolusRateMlH,
    });

    pdModels[cfg.primaryDrug] = createPDModel({
      Ce50: params.Ce50,
      gamma1: params.gamma1,
      gamma2: params.gamma2,
      BIS_baseline: params.BIS_baseline,
    });

    // Register secondary drugs (fentanyl, ketamine) — no PD model
    for (const [drugId, calcFn] of [
      ['fentanyl', calcFentanylParams],
      ['ketamine', calcKetamineParams],
    ]) {
      const pk = calcFn({ weight: patient.weight, height: patient.height });
      const eng = createEngine(pk);
      eventList.registerEngine(drugId, eng);
      const ps = getPumpSettings(drugId);
      eventList.registerDrugConfig(drugId, {
        concentration: ps.concentration,
        bolusRateMlH: ps.bolusRateMlH,
      });
      pdModels[drugId] = null;
    }
  }

  // Initialize immediately
  init();

  // ---- Patient management ----

  /**
   * Update patient demographics. Rebuilds engine with new params
   * and replays all events from scratch.
   */
  function setPatient(newPatient) {
    patient = { ...patient, ...newPatient };
    params = calcEleveldParams(patient);

    const newEngine = createEngine(params);
    eventList.registerEngine(cfg.primaryDrug, newEngine);

    // Re-register drug config
    const ps = getPumpSettings(cfg.primaryDrug);
    eventList.registerDrugConfig(cfg.primaryDrug, {
      concentration: ps.concentration,
      bolusRateMlH: ps.bolusRateMlH,
    });

    pdModels[cfg.primaryDrug] = createPDModel({
      Ce50: params.Ce50,
      gamma1: params.gamma1,
      gamma2: params.gamma2,
      BIS_baseline: params.BIS_baseline,
    });

    // Rebuild secondary drug engines with new patient weight
    for (const [drugId, calcFn] of [
      ['fentanyl', calcFentanylParams],
      ['ketamine', calcKetamineParams],
    ]) {
      const pk = calcFn({ weight: patient.weight, height: patient.height });
      const newEng = createEngine(pk);
      eventList.registerEngine(drugId, newEng);
      const ps = getPumpSettings(drugId);
      eventList.registerDrugConfig(drugId, {
        concentration: ps.concentration,
        bolusRateMlH: ps.bolusRateMlH,
      });
    }

    eventList.replayAll();
    return params;
  }

  function getPatient() {
    return { ...patient };
  }

  function getParams() {
    return params;
  }

  /**
   * Re-register drug config from current pump settings.
   * Call after user changes pump settings.
   */
  function refreshDrugConfig(drugId) {
    const id = drugId || cfg.primaryDrug;
    const ps = getPumpSettings(id);
    eventList.registerDrugConfig(id, {
      concentration: ps.concentration,
      bolusRateMlH: ps.bolusRateMlH,
    });
  }

  // ---- Commands: event mutations ----

  /**
   * Add a rate change event.
   */
  function addRate(drugId, time, mgPerMin, annotation, opts) {
    return eventList.addRate(drugId, time, mgPerMin, annotation, opts);
  }

  /**
   * Add a bolus event. Preserves prior rate after bolus.
   * @param {string} drugId
   * @param {number} time
   * @param {number} mg
   * @param {string} [annotation]
   * @param {Object} [opts] - { deliveryMode: 'pump'|'push' }
   */
  function addBolus(drugId, time, mg, annotation, opts) {
    return eventList.addBolus(drugId, time, mg, annotation, opts);
  }

  /**
   * Add a pause event.
   */
  function addPause(drugId, time, annotation) {
    return eventList.addPause(drugId, time, annotation);
  }

  /**
   * Generate a TCI scheme and insert events.
   * Clears all events after `fromTime` for the drug first.
   * 
   * @param {string} drugId
   * @param {number} fromTime - time at which to set the target
   * @param {number} ceTarget - desired Ce (µg/mL)
   * @param {Object} [tciConfig] - overrides for planTCIScheme
   * @returns {Object} { scheme, events } - the generated scheme and inserted events
   */
  function planTCI(drugId, fromTime, ceTarget, tciConfig = {}) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return { scheme: [], events: [] };

    // Clear future events for this drug
    eventList.clearAfter(drugId, fromTime);

    // Get state at fromTime
    const startState = eventList.getStateAtTime(drugId, fromTime);

    // Pass drug config to planner for realistic bolus delivery
    const ps = getPumpSettings(drugId);
    const planConfig = {
      ...tciConfig,
      bolusConcentration: ps.concentration,
      bolusRateMlH: ps.bolusRateMlH,
      maxRate: ps.maxRate,
      // Quantize-in-display-units mode — planner snaps every bolus/rate to
      // the clinician's chosen display-unit step before advancing the engine.
      drugId,
      weightKg: patient.weight,
      quantizeInDisplay: !!tciConfig.quantizeInDisplay,
      bolusDisplayUnit: tciConfig.bolusDisplayUnit || null,
      rateDisplayUnit: tciConfig.rateDisplayUnit || null,
    };

    // Generate scheme — select planner based on tciMode
    let planFn;
    switch (planConfig.tciMode) {
      case 'cet': planFn = planTCISchemeCET; break;
      case 'cet-conservative': planFn = planTCISchemeCETConservative; break;
      case 'cet-emulation': planFn = planTCISchemeEmulation; break;
      default: planFn = planTCIScheme; break;
    }
    const scheme = planFn(engine, startState, fromTime, ceTarget, planConfig);

    // Insert bolus if present (TCI boluses always use pump delivery)
    const bolusStep = scheme.find(s => s.type === 'bolus');
    if (bolusStep) {
      eventList.addBolus(drugId, bolusStep.time, bolusStep.value,
        `TCI bolus for Ce=${ceTarget.toFixed(1)}`,
        { source: 'tci', deliveryMode: 'pump' });
    }

    // Insert rate steps
    const rateSteps = scheme
      .filter(s => s.type === 'rate')
      .map(s => ({ time: s.time, rate: s.value }));

    const inserted = eventList.addRateBatch(drugId, rateSteps,
      `TCI Ce=${ceTarget.toFixed(1)}`);

    return { scheme, events: inserted };
  }

  /**
   * Edit an event's value or time.
   */
  function editEvent(id, changes) {
    return eventList.editEvent(id, changes);
  }

  /**
   * Add a constant rate offset of `deltaPerMin` mg/min across `[t0, t1]`
   * for the drug. Used by the reconcile modal's "spread across case" mode
   * to reconstruct a sustained rate-logging error exactly — a sustained
   * deficit is exactly cancelled by a sustained correction.
   *
   * How it works:
   *   1. Capture the active rate at t0 and t1 BEFORE any mutation.
   *   2. Bump every rate event strictly inside (t0, t1) by `deltaPerMin`.
   *   3. If a rate event already exists at exactly t0, bump it. Otherwise
   *      insert a new rate event at t0 = (originalRateAtT0 + deltaPerMin).
   *   4. If no event exists at t1, insert a restore event setting rate back
   *      to the un-augmented value. If an event already exists at t1, trust
   *      it (user's forward plan takes precedence).
   *
   * Pause events are not modified — augmenting during an explicit pump
   * pause would deliver drug while the pump was off. Minor inaccuracy in
   * cases with pauses is accepted in v1.
   *
   * @param {string} drugId
   * @param {number} t0
   * @param {number} t1
   * @param {number} deltaPerMin - rate offset to apply (can be negative)
   * @returns {Object[]} the inserted endpoint events ({start?, restore?})
   */
  function applyRateAugmentation(drugId, t0, t1, deltaPerMin) {
    if (!(t1 > t0) || !Number.isFinite(deltaPerMin) || deltaPerMin === 0) {
      return { start: null, restore: null };
    }

    // Capture baselines BEFORE any mutation
    const originalRateAtT0 = eventList.getRateAtTime(drugId, t0);
    const originalRateAtT1 = eventList.getRateAtTime(drugId, t1);

    // Bump rate events strictly inside the interval. Skip pauses.
    const all = eventList.getByDrug(drugId);
    const toBump = all.filter(e =>
      e.type === 'rate' && e.time > t0 + 1e-9 && e.time < t1 - 1e-9,
    );
    for (const evt of toBump) {
      eventList.editEvent(evt.id, { value: evt.value + deltaPerMin });
    }

    // Start event at t0
    let startEvt = null;
    const existingAtT0 = all.filter(e =>
      e.type === 'rate' && Math.abs(e.time - t0) < 0.001,
    );
    if (existingAtT0.length > 0) {
      for (const evt of existingAtT0) {
        eventList.editEvent(evt.id, { value: evt.value + deltaPerMin });
      }
    } else {
      startEvt = eventList.addRate(
        drugId, t0, originalRateAtT0 + deltaPerMin,
        `Reconcile: +${deltaPerMin.toFixed(3)} mg/min across case`,
        { source: 'reconcile' },
      );
    }

    // Restore event at t1 (only if nothing is already scheduled there)
    let restoreEvt = null;
    const existingAtT1 = eventList.getByDrug(drugId).filter(e =>
      e.type === 'rate' && Math.abs(e.time - t1) < 0.001,
    );
    if (existingAtT1.length === 0) {
      restoreEvt = eventList.addRate(
        drugId, t1, originalRateAtT1,
        'Reconcile: restore baseline',
        { source: 'reconcile' },
      );
    }

    return { start: startEvt, restore: restoreEvt };
  }

  /**
   * Delete a single event.
   */
  function deleteEvent(id) {
    return eventList.deleteEvent(id);
  }

  /**
   * Delete an event and all subsequent events for that drug.
   */
  function deleteEventAndAfter(id) {
    return eventList.deleteEventAndAfter(id);
  }

  /**
   * Clear all events for a drug after a given time.
   */
  function clearAfter(drugId, time) {
    return eventList.clearAfter(drugId, time);
  }

  /**
   * Clear all events for a drug at and after a given time.
   * `clearFrom(drugId, 0)` wipes the entire plan for the drug
   * (all event times are >= 0).
   */
  function clearFrom(drugId, time) {
    return eventList.clearFrom(drugId, time);
  }

  /**
   * Reset everything — clear all events, reset engines.
   */
  function reset() {
    eventList.clearAll();
    pdModels = {};
    clearReconciliationWindows();
    init();
  }

  // ---- Queries ----

  /**
   * Get concentrations for a drug at a specific time.
   */
  function getConcentrationsAt(drugId, time) {
    return eventList.getConcentrationsAt(drugId, time);
  }

  /**
   * Compute a concentration curve for charting.
   */
  function computeCurve(drugId, startTime, endTime, step) {
    return eventList.computeCurve(drugId, startTime, endTime, step);
  }

  /**
   * Predict BIS at a given time for a drug (if PD model available).
   * Returns null if no PD model is registered for the drug.
   */
  function predictBIS(drugId, time) {
    const pd = pdModels[drugId];
    if (!pd) return null;
    const conc = eventList.getConcentrationsAt(drugId, time);
    return pd.predict(conc.Ce);
  }

  /**
   * Get the infusion rate active for a drug at a given time.
   */
  function getRateAtTime(drugId, time) {
    return eventList.getRateAtTime(drugId, time);
  }

  /**
   * Get all events, optionally filtered by drug.
   */
  function getEvents(drugId) {
    return drugId ? eventList.getByDrug(drugId) : eventList.getAll();
  }

  /**
   * Get the PD model for a drug (or null if none).
   */
  function getPDModel(drugId) {
    const id = drugId || cfg.primaryDrug;
    return pdModels[id] || null;
  }

  /**
   * Get the display name of the PK model currently active for a drug
   * (e.g. "Eleveld 2018"). Returns '' for unknown drugs. UI code should
   * read model names through this instead of hard-coding literals, so
   * that swapping models later is a one-place change.
   */
  function getModelName(drugId) {
    const id = drugId || cfg.primaryDrug;
    return modelNames[id] || '';
  }

  /**
   * Get the event list (for direct access if needed).
   */
  function getEventList() {
    return eventList;
  }

  /**
   * Predict when Ce will decay to a threshold.
   * Used for intermittent bolus mode countdown.
   */
  function predictTrough(drugId, time, troughCe) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return null;

    const state = eventList.getStateAtTime(drugId, time);
    const currentRate = eventList.getRateAtTime(drugId, time);

    const result = predictTroughTime(engine, state, time, troughCe, currentRate);

    // Restore engine state (predictTroughTime modifies it)
    eventList.replayDrug(drugId);

    return result;
  }

  /**
   * Predict when Ce would decay to a threshold if the infusion were
   * stopped right now (rate forced to 0).
   * Used for the "Exit Ce" countdown on the drug card.
   */
  function predictDecayTo(drugId, time, targetCe) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return null;

    const state = eventList.getStateAtTime(drugId, time);
    const result = predictTroughTime(engine, state, time, targetCe, 0);

    eventList.replayDrug(drugId);
    return result;
  }

  /**
   * Predict analytical steady-state Ce and time to reach 95% of it
   * under a constant infusion rate.
   *
   * Returns:
   *   null                          if rate ≤ 0 or engine unavailable
   *   { ceSS, timeToSsMin, reachable }
   *     - ceSS: true analytical Ce_ss (mcg/mL)
   *     - timeToSsMin: minutes until within 5% of Ce_ss (0 if already there)
   *     - reachable: true if reached within 6h horizon
   */
  function predictSteadyState(drugId, time, rate, opts) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return null;

    const state = eventList.getStateAtTime(drugId, time);
    const result = _predictTimeToSS(engine, state, rate, opts);

    eventList.replayDrug(drugId);
    return result;
  }

  /**
   * Predict when Ce will enter a local plateau with slope reversal
   * under a constant infusion rate.
   *
   * A plateau requires slope reversal (Ce was falling → flattens → rises,
   * or vice versa). Monotonic approach to SS is NOT a plateau.
   *
   * slopeTol is a dimensionless per-minute relative slope threshold
   * (e.g. 0.0010 = 0.10 %/min).
   *
   * opts.exitBandPct controls the ±% band for exit detection
   * (e.g. 0.05 = ±5%).
   *
   * Returns:
   *   null                                    if rate ≤ 0 or bad input
   *   { plateauCe, entryMin, exitMin,
   *     bandLow, bandHigh, noPlateau: false }  on success (reversal found)
   *   { plateauCe: null, ..., noPlateau: true } if no plateau (no reversal)
   */
  function predictPlateau(drugId, time, rate, slopeTol, opts) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return null;

    const state = eventList.getStateAtTime(drugId, time);
    const result = _predictPlateau(engine, state, rate, slopeTol, opts);

    eventList.replayDrug(drugId);
    return result;
  }

  // ---- Dose reconciliation windows ----

  /**
   * Mark a per-drug reconciliation window. `insertMin` is when the
   * correction bolus was placed (may be in the past); `endMin` is the
   * time after which the chart can be trusted again. Pass null to clear.
   */
  function setReconciliationWindow(drugId, insertMin, endMin) {
    if (insertMin == null || endMin == null) {
      delete reconciliationWindows[drugId];
      delete reconciliationGhosts[drugId];
      return;
    }
    reconciliationWindows[drugId] = { insertMin, endMin };
  }

  /**
   * Return the currently-active reconciliation window for a drug, auto-
   * clearing any window whose endMin has already passed. `now` is required
   * so the simulation stays clock-free. The matching ghost curve is
   * cleared at the same time so the chart can drop the comparison line
   * once the region clears.
   */
  function getActiveReconciliationWindow(drugId, now) {
    const w = reconciliationWindows[drugId];
    if (!w) return null;
    if (now != null && now > w.endMin) {
      delete reconciliationWindows[drugId];
      delete reconciliationGhosts[drugId];
      return null;
    }
    return { ...w };
  }

  /**
   * Snapshot all active reconciliation windows — used by session save.
   */
  function getAllReconciliationWindows() {
    const out = {};
    for (const [k, v] of Object.entries(reconciliationWindows)) {
      out[k] = { ...v };
    }
    return out;
  }

  function clearReconciliationWindows() {
    for (const k of Object.keys(reconciliationWindows)) {
      delete reconciliationWindows[k];
    }
    for (const k of Object.keys(reconciliationGhosts)) {
      delete reconciliationGhosts[k];
    }
  }

  /**
   * Store a pre-correction Ce snapshot for the drug. `points` is the array
   * returned by computeCurve sampled from 0 to `capturedAt` — captured
   * BEFORE addBolus is called so it reflects the simulation state the user
   * is correcting away from. The chart shows it as a ghost curve up to
   * `capturedAt` so the corrected vs. original can be compared. Pass null
   * to clear.
   */
  function setReconciliationGhost(drugId, ghost) {
    if (!ghost) {
      delete reconciliationGhosts[drugId];
      return;
    }
    reconciliationGhosts[drugId] = {
      capturedAt: ghost.capturedAt,
      points: ghost.points,
    };
  }

  /**
   * Return the active ghost curve for a drug, or null when no
   * reconciliation window is active. Tied to the reconciliation
   * window's lifecycle — once the window auto-clears (now > endMin)
   * the ghost is dropped too.
   */
  function getActiveReconciliationGhost(drugId, now) {
    if (!getActiveReconciliationWindow(drugId, now)) return null;
    return reconciliationGhosts[drugId] || null;
  }

  function getAllReconciliationGhosts() {
    const out = {};
    for (const [k, v] of Object.entries(reconciliationGhosts)) {
      out[k] = { capturedAt: v.capturedAt, points: v.points.slice() };
    }
    return out;
  }

  // ---- Multi-drug ----

  /**
   * Register an additional drug with its own PK engine.
   * PD model is optional (null for drugs without validated PD).
   */
  function registerDrug(drugId, pkParams, pdParams) {
    const engine = createEngine(pkParams);
    eventList.registerEngine(drugId, engine);
    pdModels[drugId] = pdParams ? createPDModel(pdParams) : null;
  }

  return {
    // Patient
    setPatient, getPatient, getParams,

    // Commands
    addRate, addBolus, addPause, planTCI,
    editEvent, deleteEvent, deleteEventAndAfter,
    clearAfter, clearFrom, reset, refreshDrugConfig,
    applyRateAugmentation,

    // Queries
    getConcentrationsAt, computeCurve, predictBIS,
    getRateAtTime, getEvents, getPDModel, getModelName,
    getEventList, predictTrough, predictDecayTo, predictSteadyState, predictPlateau,

    // Dose reconciliation
    setReconciliationWindow, getActiveReconciliationWindow,
    getAllReconciliationWindows, clearReconciliationWindows,
    setReconciliationGhost, getActiveReconciliationGhost,
    getAllReconciliationGhosts,

    // Multi-drug
    registerDrug,

    // Config
    get primaryDrug() { return cfg.primaryDrug; },
    get config() { return { ...cfg }; },
  };
}
