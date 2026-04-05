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

import { calcEleveldParams } from '../pk/eleveld.js';
import { createEngine } from '../pk/engine.js';
import { createPDModel } from '../pk/pd.js';
import { createEventList } from './events.js';
import { planTCIScheme, planTCISchemeCET, planTCISchemeCETConservative, planTCISchemeEmulation } from './tci-planner.js';
import { predictTroughTime } from '../pk/decay-predictor.js';
import { DRUG_DEFS, getPumpSettings } from '../util/constants.js';

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
  let patient = { age: 35, weight: 70, height: 170, male: true, opioid: false, ce50OpioidCorrection: false };
  let params = null;               // PK-PD params for primary drug

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
  }

  // Initialize immediately
  init();

  // ---- Patient management ----

  /**
   * Update patient demographics. Rebuilds engine with new params,
   * preserving compartment state. Replays all events.
   */
  function setPatient(newPatient) {
    patient = { ...patient, ...newPatient };
    params = calcEleveldParams(patient);

    const oldEngine = eventList.getEngine(cfg.primaryDrug);
    const savedState = oldEngine ? oldEngine.getState() : null;

    const newEngine = createEngine(params);
    if (savedState) newEngine.setState(savedState);
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
   * Reset everything — clear all events, reset engines.
   */
  function reset() {
    eventList.clearAll();
    pdModels = {};
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
    clearAfter, reset, refreshDrugConfig,

    // Queries
    getConcentrationsAt, computeCurve, predictBIS,
    getRateAtTime, getEvents, getPDModel,
    getEventList, predictTrough,

    // Multi-drug
    registerDrug,

    // Config
    get primaryDrug() { return cfg.primaryDrug; },
    get config() { return { ...cfg }; },
  };
}
