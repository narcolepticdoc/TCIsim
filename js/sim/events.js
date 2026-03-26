/**
 * events.js — Multi-Drug Event List
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
 *   'push'           — rapid IV push, delivered over ~10 seconds.
 * 
 * Each event stores a snapshot of its drug's engine state, computed
 * during replay. Snapshots are a performance optimization — they
 * allow point queries to restore from a nearby snapshot instead of
 * replaying from t=0.
 */

let _nextId = 1;
function genId() { return 'evt_' + String(_nextId++).padStart(5, '0'); }

const PUSH_DURATION = 10 / 60; // 10 seconds in minutes

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
    snapshot: opts.snapshot || null,    // Float64Array engine state after this event
  };
}

/**
 * Create a multi-drug EventList manager.
 */
export function createEventList() {
  let events = [];
  const engines = {};      // { drugId: engineInstance }
  const drugConfigs = {};  // { drugId: { concentration, bolusRateMlH } }

  // ---- Engine registry ----

  function registerEngine(drugId, engine) {
    engines[drugId] = engine;
  }

  /**
   * Register drug configuration for bolus delivery.
   * @param {string} drugId
   * @param {Object} config - { concentration: mg/mL, bolusRateMlH: mL/h }
   */
  function registerDrugConfig(drugId, config) {
    drugConfigs[drugId] = config;
  }

  function getEngine(drugId) {
    return engines[drugId] || null;
  }

  function getDrugIds() {
    return Object.keys(engines);
  }

  // ---- Bolus delivery computation ----

  /**
   * Compute bolus delivery duration and infusion rate for a bolus event.
   * @param {Object} evt - bolus event
   * @returns {{ duration: number, rate: number }} duration in minutes, rate in mg/min
   */
  function getBolusDelivery(evt) {
    if (evt.deliveryMode === 'push') {
      return { duration: PUSH_DURATION, rate: evt.value / PUSH_DURATION };
    }
    const cfg = drugConfigs[evt.drug];
    if (!cfg || !cfg.bolusRateMlH || !cfg.concentration) {
      // Fallback: 10-second delivery if no config
      return { duration: PUSH_DURATION, rate: evt.value / PUSH_DURATION };
    }
    const volumeMl = evt.value / cfg.concentration;
    const durationMin = volumeMl / cfg.bolusRateMlH * 60;
    const duration = Math.max(0.05, durationMin); // minimum 3 seconds
    return { duration, rate: evt.value / duration };
  }

  /**
   * Advance the engine through a bolus event.
   * @param {Object} engine
   * @param {Object} evt - bolus event
   * @returns {number} delivery duration in minutes
   */
  function advanceBolus(engine, evt) {
    const { duration, rate } = getBolusDelivery(evt);
    engine.advance(duration, rate);
    return duration;
  }

  // ---- Core list operations ----

  /**
   * Insert an event in time-sorted order.
   * Events at the same time are ordered by insertion (stable).
   */
  function insert(event) {
    let idx = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].time <= event.time) { idx = i + 1; break; }
      if (i === 0) idx = 0;
    }
    events.splice(idx, 0, event);
    return event;
  }

  /**
   * Remove an event by ID.
   */
  function remove(id) {
    const idx = events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    return events.splice(idx, 1)[0];
  }

  /**
   * Get an event by ID.
   */
  function getById(id) {
    return events.find(e => e.id === id) || null;
  }

  /**
   * Get all events (unified, time-sorted).
   */
  function getAll() {
    return [...events];
  }

  /**
   * Get events for a specific drug.
   */
  function getByDrug(drugId) {
    return events.filter(e => e.drug === drugId);
  }

  /**
   * Remove all events for a drug after a given time.
   * Events at exactly `afterTime` are kept.
   * Replays the drug after removal.
   * 
   * @param {string} drugId
   * @param {number} afterTime - cutoff time (events with time > afterTime are removed)
   * @returns {number} count of removed events
   */
  function clearAfter(drugId, afterTime) {
    const before = events.length;
    events = events.filter(e => !(e.drug === drugId && e.time > afterTime));
    const removed = before - events.length;
    if (removed > 0) replayDrug(drugId);
    return removed;
  }

  /**
   * Remove all events for a drug at and after a given time.
   * Used for "delete this event and everything after it."
   * 
   * @param {string} drugId
   * @param {number} fromTime - cutoff time (events with time >= fromTime are removed)
   * @returns {number} count of removed events
   */
  function clearFrom(drugId, fromTime) {
    const before = events.length;
    events = events.filter(e => !(e.drug === drugId && e.time >= fromTime));
    const removed = before - events.length;
    if (removed > 0) replayDrug(drugId);
    return removed;
  }

  /**
   * Clear everything.
   */
  function clearAll() {
    events = [];
    _nextId = 1;
    for (const id of Object.keys(engines)) {
      engines[id].reset();
    }
  }

  // ---- Per-drug replay ----

  /**
   * Get the active infusion rate for a drug at a given event index.
   * Walks backward through that drug's events.
   */
  function getActiveRateForDrug(drugId, beforeIdx) {
    for (let i = beforeIdx; i >= 0; i--) {
      if (events[i].drug !== drugId) continue;
      if (events[i].type === 'rate') return events[i].value;
      if (events[i].type === 'pause') return 0;
    }
    return 0;
  }

  /**
   * Get the active infusion rate for a drug at a given time.
   */
  function getRateAtTime(drugId, time) {
    let rate = 0;
    for (const evt of events) {
      if (evt.drug !== drugId) continue;
      if (evt.time > time) break;
      if (evt.type === 'rate') rate = evt.value;
      else if (evt.type === 'pause') rate = 0;
    }
    return rate;
  }

  /**
   * Replay a single drug's engine from t=0 through all its events.
   * Updates snapshots on all events for that drug.
   */
  function replayDrug(drugId) {
    const engine = engines[drugId];
    if (!engine) return;

    engine.reset();
    let currentTime = 0;
    let currentRate = 0;

    for (const evt of events) {
      if (evt.drug !== drugId) continue;

      const dt = evt.time - currentTime;
      if (dt > 0) engine.advance(dt, currentRate);
      currentTime = evt.time;

      if (evt.type === 'bolus') {
        currentTime += advanceBolus(engine, evt);
      } else if (evt.type === 'rate') {
        currentRate = evt.value;
      } else if (evt.type === 'pause') {
        currentRate = 0;
      }

      evt.snapshot = engine.getState();
    }
  }

  /**
   * Replay all drugs from t=0.
   */
  function replayAll() {
    for (const drugId of Object.keys(engines)) {
      replayDrug(drugId);
    }
  }

  /**
   * Replay a drug from a specific event forward (partial replay).
   * Restores the snapshot from the previous event of the same drug
   * and replays forward.
   */
  function replayDrugFrom(drugId, fromEventId) {
    const engine = engines[drugId];
    if (!engine) return;

    const allDrugEvts = [];
    let fromDrugIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].drug !== drugId) continue;
      if (events[i].id === fromEventId) fromDrugIdx = allDrugEvts.length;
      allDrugEvts.push({ globalIdx: i, evt: events[i] });
    }

    if (fromDrugIdx === -1) { replayDrug(drugId); return; }

    let currentTime, currentRate;
    if (fromDrugIdx === 0) {
      engine.reset();
      currentTime = 0;
      currentRate = 0;
    } else {
      const prevEntry = allDrugEvts[fromDrugIdx - 1];
      if (!prevEntry.evt.snapshot) { replayDrug(drugId); return; }
      engine.setState(prevEntry.evt.snapshot);
      currentTime = prevEntry.evt.time;
      if (prevEntry.evt.type === 'bolus') {
        currentTime += getBolusDelivery(prevEntry.evt).duration;
      }
      currentRate = getActiveRateForDrug(drugId, prevEntry.globalIdx);
    }

    for (let i = fromDrugIdx; i < allDrugEvts.length; i++) {
      const evt = allDrugEvts[i].evt;
      const dt = evt.time - currentTime;
      if (dt > 0) engine.advance(dt, currentRate);
      currentTime = evt.time;

      if (evt.type === 'bolus') {
        currentTime += advanceBolus(engine, evt);
      } else if (evt.type === 'rate') {
        currentRate = evt.value;
      } else if (evt.type === 'pause') {
        currentRate = 0;
      }

      evt.snapshot = engine.getState();
    }
  }

  // ---- Query concentrations ----

  /**
   * Get concentrations for a drug at a given time.
   * Finds the nearest prior event's snapshot and advances from there.
   */
  function getConcentrationsAt(drugId, time) {
    const engine = engines[drugId];
    if (!engine) return { Cp: 0, Ce: 0, C2: 0, C3: 0, rate: 0, time };

    // Find the last event for this drug at or before the requested time
    let lastEvt = null;
    let lastGlobalIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].drug === drugId && events[i].time <= time) {
        lastEvt = events[i];
        lastGlobalIdx = i;
        break;
      }
    }

    if (!lastEvt) {
      // No events yet — engine at zero state
      engine.reset();
      if (time > 0) engine.advance(time, 0);
      return { ...engine.getConcentrations(), rate: 0, time };
    }

    // Ensure snapshot exists
    if (!lastEvt.snapshot) replayDrug(drugId);

    // Restore to snapshot
    engine.setState(lastEvt.snapshot);
    let currentTime = lastEvt.time;
    if (lastEvt.type === 'bolus') {
      currentTime += getBolusDelivery(lastEvt).duration;
    }

    const currentRate = getActiveRateForDrug(drugId, lastGlobalIdx);
    const dt = time - currentTime;
    if (dt > 0) engine.advance(dt, currentRate);

    const conc = engine.getConcentrations();
    return { ...conc, rate: currentRate, time };
  }

  /**
   * Compute a concentration curve for a drug.
   * Replays from t=0 and samples at regular intervals.
   * Much more efficient than calling getConcentrationsAt() in a loop.
   */
  function computeCurve(drugId, startTime, endTime, step = 10 / 60) {
    const engine = engines[drugId];
    if (!engine) return [];

    const drugEvents = events.filter(e => e.drug === drugId);
    const curve = [];

    engine.reset();
    let currentTime = 0;
    let currentRate = 0;
    let evtPtr = 0;

    // Process events up to startTime
    while (evtPtr < drugEvents.length && drugEvents[evtPtr].time <= startTime) {
      const evt = drugEvents[evtPtr];
      const dt = evt.time - currentTime;
      if (dt > 0) engine.advance(dt, currentRate);
      currentTime = evt.time;
      if (evt.type === 'bolus') { currentTime += advanceBolus(engine, evt); }
      else if (evt.type === 'rate') currentRate = evt.value;
      else if (evt.type === 'pause') currentRate = 0;
      evtPtr++;
    }

    // Advance to startTime
    if (startTime > currentTime) {
      engine.advance(startTime - currentTime, currentRate);
      currentTime = startTime;
    }

    // Sample forward
    let sampleTime = startTime;
    while (sampleTime <= endTime) {
      // Process events up to sample time
      while (evtPtr < drugEvents.length && drugEvents[evtPtr].time <= sampleTime) {
        const evt = drugEvents[evtPtr];
        const dt = evt.time - currentTime;
        if (dt > 0) engine.advance(dt, currentRate);
        currentTime = evt.time;
        if (evt.type === 'bolus') { currentTime += advanceBolus(engine, evt); }
        else if (evt.type === 'rate') currentRate = evt.value;
        else if (evt.type === 'pause') currentRate = 0;
        evtPtr++;
      }

      const dt = sampleTime - currentTime;
      if (dt > 0) { engine.advance(dt, currentRate); currentTime = sampleTime; }

      const conc = engine.getConcentrations();
      curve.push({ time: sampleTime, Cp: conc.Cp, Ce: conc.Ce, C2: conc.C2, C3: conc.C3, rate: currentRate });
      sampleTime += step;
    }

    return curve;
  }

  /**
   * Get the engine state at the last event for a drug.
   * Useful as starting point for TCI planning.
   */
  function getStateAtLastEvent(drugId) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].drug === drugId && events[i].snapshot) {
        return { state: events[i].snapshot, time: events[i].time };
      }
    }
    const engine = engines[drugId];
    return { state: engine ? engine.getState() : new Float64Array(4), time: 0 };
  }

  /**
   * Get the engine state at a specific time for a drug.
   * Useful for TCI planning from an arbitrary point.
   */
  function getStateAtTime(drugId, time) {
    getConcentrationsAt(drugId, time); // side effect: sets engine state
    const engine = engines[drugId];
    return engine ? engine.getState() : new Float64Array(4);
  }

  // ---- High-level drug-scoped operations ----

  /**
   * Add a rate change event.
   * 
   * @param {string} drugId
   * @param {number} time
   * @param {number} mgPerMin
   * @param {string} [annotation]
   * @returns {Object} the created event
   */
  function addRate(drugId, time, mgPerMin, annotation) {
    const evt = createEvent(drugId, time, 'rate', mgPerMin, {
      source: 'manual',
      annotation: annotation || `Rate ${mgPerMin.toFixed(1)} mg/min`,
    });
    insert(evt);
    replayDrugFrom(drugId, evt.id);
    return evt;
  }

  /**
   * Add a bolus event.
   * Inserts a rate-restore event after the bolus delivery duration
   * to preserve the prior infusion rate.
   * 
   * @param {string} drugId
   * @param {number} time
   * @param {number} mg
   * @param {string} [annotation]
   * @param {Object} [opts] - { deliveryMode: 'pump'|'push' }
   * @returns {Object} the bolus event
   */
  function addBolus(drugId, time, mg, annotation, opts = {}) {
    const priorRate = getRateAtTime(drugId, time);

    const bolusEvt = createEvent(drugId, time, 'bolus', mg, {
      source: opts.source || 'manual',
      deliveryMode: opts.deliveryMode || 'pump',
      annotation: annotation || `Bolus ${mg.toFixed(1)} mg`,
    });
    insert(bolusEvt);

    const { duration } = getBolusDelivery(bolusEvt);
    const rateEvt = createEvent(drugId, time + duration, 'rate', priorRate, {
      source: 'system',
      annotation: 'Rate restored after bolus',
    });
    insert(rateEvt);

    replayDrugFrom(drugId, bolusEvt.id);
    return bolusEvt;
  }

  /**
   * Add a pause event.
   */
  function addPause(drugId, time, annotation) {
    const evt = createEvent(drugId, time, 'pause', 0, {
      source: 'manual',
      annotation: annotation || 'Pump paused',
    });
    insert(evt);
    replayDrugFrom(drugId, evt.id);
    return evt;
  }

  /**
   * Add a batch of rate events (used by TCI planner).
   * Does NOT clear anything — the caller is responsible for
   * calling clearAfter() first if needed.
   * 
   * @param {string} drugId
   * @param {Array} steps - [{time, rate}, ...]
   * @param {string} [annotation]
   * @returns {Array} created events
   */
  function addRateBatch(drugId, steps, annotation) {
    const created = [];
    for (const step of steps) {
      const evt = createEvent(drugId, step.time, 'rate', step.rate, {
        source: 'tci',
        annotation: annotation || 'TCI step',
      });
      insert(evt);
      created.push(evt);
    }
    if (created.length > 0) {
      replayDrugFrom(drugId, created[0].id);
    }
    return created;
  }

  /**
   * Edit an existing event's value or time.
   * Does NOT clear future events — the caller decides whether to
   * clear after the edit based on the rules (e.g., clearAfter for
   * edits in the past).
   */
  function editEvent(id, changes) {
    const evt = getById(id);
    if (!evt) return null;

    const drugId = evt.drug;
    const timeChanged = changes.time != null && changes.time !== evt.time;

    if (changes.value != null) evt.value = changes.value;
    if (changes.type != null) evt.type = changes.type;
    if (changes.annotation != null) evt.annotation = changes.annotation;

    if (timeChanged) {
      evt.time = changes.time;
      const idx = events.indexOf(evt);
      if (idx !== -1) events.splice(idx, 1);
      insert(evt);
    }

    replayDrug(drugId);
    return evt;
  }

  /**
   * Delete a single event.
   * Does NOT clear future events — the caller decides.
   */
  function deleteEvent(id) {
    const evt = getById(id);
    if (!evt) return null;

    const drugId = evt.drug;
    const idx = events.indexOf(evt);
    if (idx !== -1) events.splice(idx, 1);

    replayDrug(drugId);
    return evt;
  }

  /**
   * Delete a single event and all events for that drug after it.
   */
  function deleteEventAndAfter(id) {
    const evt = getById(id);
    if (!evt) return null;

    const drugId = evt.drug;
    const cutoffTime = evt.time;
    events = events.filter(e => !(e.drug === drugId && e.time >= cutoffTime));
    replayDrug(drugId);
    return evt;
  }

  return {
    // Engine registry
    registerEngine,
    registerDrugConfig,
    getEngine,
    getDrugIds,
    getBolusDelivery,

    // Core operations
    insert,
    remove,
    getById,
    getAll,
    getByDrug,
    clearAfter,
    clearFrom,
    clearAll,

    // Replay
    replayDrug,
    replayAll,
    replayDrugFrom,

    // Queries
    getConcentrationsAt,
    computeCurve,
    getRateAtTime,
    getActiveRateForDrug,
    getStateAtLastEvent,
    getStateAtTime,

    // High-level actions
    addRate,
    addBolus,
    addPause,
    addRateBatch,
    editEvent,
    deleteEvent,
    deleteEventAndAfter,

    // Debug
    get length() { return events.length; },
    get raw() { return events; },
  };
}

export { createEvent };
