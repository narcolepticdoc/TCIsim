/**
 * events/index.js — Multi-drug event list orchestrator.
 *
 * The event list is an ordered sequence of pump commands. Each event
 * represents a physical action: a rate change, a bolus delivery, or
 * a pump pause. Events are tagged by drug and sorted by time.
 *
 * There is no concept of "planned" vs "executed" — all events in the
 * list are treated equally by the PK engine. Whether an event is "in
 * the past" relative to the user's current view is determined by the
 * UI layer comparing event.time to the display cursor position.
 *
 * Event types:
 *   'rate'  — infusion rate change (value in mg/min)
 *   'bolus' — bolus delivery (value in mg, delivered over a computed
 *             duration at the pump's bolus rate or as a rapid push)
 *   'pause' — pump stopped (equivalent to rate = 0)
 *
 * Bolus delivery modes:
 *   'pump' (default) — delivered at the drug's configured pump bolus
 *                       rate (e.g. 750 mL/h). Duration depends on dose.
 *   'push'           — rapid IV push at 3600 mL/h (1 mL/s), min 1 second.
 *
 * Each event stores a snapshot of its drug's engine state, computed
 * during replay. Snapshots are a performance optimization — they
 * allow point queries to restore from a nearby snapshot instead of
 * replaying from t=0.
 *
 * Implementation is split across sub-modules under js/sim/events/:
 *   delivery.js   — bolus delivery math
 *   replay.js     — per-drug engine replay
 *   list-ops.js   — CRUD + clear operations
 *   query.js      — concentration queries and state reads
 *   actions.js    — findActiveBolus + high-level add/edit/delete
 *
 * This file wires them together with a shared `state` container and
 * returns the public facade expected by simulation.js and the tests.
 */

import { createDelivery } from './delivery.js';
import { createReplay } from './replay.js';
import { createListOps } from './list-ops.js';
import { createQuery } from './query.js';
import { createActions } from './actions.js';

/**
 * Create a multi-drug EventList manager.
 */
export function createEventList() {
  // Shared mutable state. Each sub-module receives a reference to this
  // object and reads/writes its fields through the reference, so a
  // reassignment like `state.events = state.events.filter(...)` in
  // list-ops is visible to every other sub-module on the next read.
  const state = {
    events: [],
    nextId: 1,     // instance-scoped so clearAll() only resets this instance
    engines: {},   // { drugId: engineInstance }
    drugConfigs: {}, // { drugId: { concentration, bolusRateMlH } }
  };

  function genId() { return 'evt_' + String(state.nextId++).padStart(5, '0'); }

  /**
   * Create an event object.
   */
  function createEvent(drug, time, type, value, opts = {}) {
    return {
      id: genId(),
      drug,                              // 'propofol' | 'fentanyl' | ...
      time,                              // elapsed minutes
      type,                              // 'rate' | 'bolus' | 'pause'
      value,                             // mg/min for rate, mg for bolus, 0 for pause
      source: opts.source || 'manual',   // 'tci' | 'manual' | 'system'
      deliveryMode: opts.deliveryMode || 'pump', // 'pump' | 'push' (bolus only)
      annotation: opts.annotation || '', // human-readable context
      snapshot: opts.snapshot || null,   // Float64Array engine state after this event
    };
  }

  // ---- Engine registry (trivial — kept here rather than in a sub-module) ----

  function registerEngine(drugId, engine) {
    state.engines[drugId] = engine;
  }

  /**
   * Register drug configuration for bolus delivery.
   * @param {string} drugId
   * @param {Object} config - { concentration: mg/mL, bolusRateMlH: mL/h }
   */
  function registerDrugConfig(drugId, config) {
    state.drugConfigs[drugId] = config;
  }

  function getEngine(drugId) {
    return state.engines[drugId] || null;
  }

  function getDrugIds() {
    return Object.keys(state.engines);
  }

  // ---- Build sub-modules in dependency order ----

  const delivery = createDelivery(state);
  const replay = createReplay(state, delivery);
  const listOps = createListOps(state, { replayDrug: replay.replayDrug });
  const query = createQuery(state, delivery, replay);
  const actions = createActions(state, {
    createEvent,
    getBolusDelivery: delivery.getBolusDelivery,
    getRateAtTime: replay.getRateAtTime,
    insert: listOps.insert,
    replayDrug: replay.replayDrug,
    replayDrugFrom: replay.replayDrugFrom,
  });

  // ---- Facade (shape must match the pre-split API exactly) ----

  return {
    // Engine registry
    registerEngine,
    registerDrugConfig,
    getEngine,
    getDrugIds,
    getBolusDelivery: delivery.getBolusDelivery,

    // Core operations
    insert: listOps.insert,
    remove: listOps.remove,
    getById: listOps.getById,
    getAll: listOps.getAll,
    getByDrug: listOps.getByDrug,
    clearAfter: listOps.clearAfter,
    clearFrom: listOps.clearFrom,
    clearAll: listOps.clearAll,

    // Replay
    replayDrug: replay.replayDrug,
    replayAll: replay.replayAll,
    replayDrugFrom: replay.replayDrugFrom,

    // Queries
    getConcentrationsAt: query.getConcentrationsAt,
    computeCurve: query.computeCurve,
    getRateAtTime: replay.getRateAtTime,
    getActiveRateForDrug: replay.getActiveRateForDrug,
    getStateAtLastEvent: query.getStateAtLastEvent,
    getStateAtTime: query.getStateAtTime,

    // High-level actions
    addRate: actions.addRate,
    addBolus: actions.addBolus,
    addPause: actions.addPause,
    addRateBatch: actions.addRateBatch,
    editEvent: actions.editEvent,
    deleteEvent: actions.deleteEvent,
    deleteEventAndAfter: actions.deleteEventAndAfter,
    reanchorBolusDeliveries: actions.reanchorBolusDeliveries,

    // Debug
    get length() { return state.events.length; },
    get raw() { return state.events; },
  };
}
