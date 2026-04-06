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
 *   'push'           — rapid IV push at 3600 mL/h (1 mL/s), min 1 second.
 * 
 * Each event stores a snapshot of its drug's engine state, computed
 * during replay. Snapshots are a performance optimization — they
 * allow point queries to restore from a nearby snapshot instead of
 * replaying from t=0.
 */

// PUSH_RATE_MLH: rapid IV push delivery rate (1 mL/s = 3600 mL/h).
// Push duration is volume-derived with a 1-second minimum.
// Pump boluses use the drug's configured bolusRateMlH (typically 750 mL/h)
// with a 3-second minimum — a different, slower rate by design.
const PUSH_RATE_MLH = 3600;

/**
 * Create an event object.
 * Defined inside createEventList() — uses closure-scoped genId().
 */

/**
 * Create a multi-drug EventList manager.
 */
export function createEventList() {
  let events = [];
  let _nextId = 1; // instance-scoped so clearAll() only resets this instance
  function genId() { return 'evt_' + String(_nextId++).padStart(5, '0'); }

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
    const cfg = drugConfigs[evt.drug];
    const concentration = cfg?.concentration || 10;
    const volumeMl = evt.value / concentration;
    if (evt.deliveryMode === 'push') {
      // Rapid IV push: volume-derived at 3600 mL/h (1 mL/s), minimum 1 second
      const duration = Math.max(1 / 60, volumeMl / PUSH_RATE_MLH * 60);
      return { duration, rate: evt.value / duration };
    }
    if (!cfg || !cfg.bolusRateMlH) {
      // Fallback: pump rate unknown, use push rate
      const duration = Math.max(1 / 60, volumeMl / PUSH_RATE_MLH * 60);
      return { duration, rate: evt.value / duration };
    }
    // Pump bolus: volume / pump bolus rate, minimum 3 seconds
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
  function getActiveRateForDrug(drugId, beforeGlobalIdx) {
    for (let i = beforeGlobalIdx; i >= 0; i--) {
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
   * During bolus delivery, computes partial delivery correctly.
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

    if (lastEvt.type === 'bolus') {
      // The snapshot is the state AFTER full bolus delivery.
      // If the query time is during delivery, we need to replay from
      // the previous event's snapshot instead.
      const delivery = getBolusDelivery(lastEvt);
      const bolusEndTime = lastEvt.time + delivery.duration;

      if (time < bolusEndTime) {
        // Query is during bolus delivery — find the event BEFORE this bolus
        // and replay forward including partial bolus
        let prevEvt = null;
        let prevGlobalIdx = -1;
        for (let i = lastGlobalIdx - 1; i >= 0; i--) {
          if (events[i].drug === drugId) {
            prevEvt = events[i];
            prevGlobalIdx = i;
            break;
          }
        }

        if (prevEvt && prevEvt.snapshot) {
          engine.setState(prevEvt.snapshot);
          let t = prevEvt.time;
          if (prevEvt.type === 'bolus') {
            t += getBolusDelivery(prevEvt).duration;
          }
          const preBolusRate = getActiveRateForDrug(drugId, prevGlobalIdx);
          // Advance to bolus start
          const dt1 = lastEvt.time - t;
          if (dt1 > 0) engine.advance(dt1, preBolusRate);
          // Partial bolus delivery
          const partialDuration = time - lastEvt.time;
          if (partialDuration > 0) engine.advance(partialDuration, delivery.rate);
          return { ...engine.getConcentrations(), rate: delivery.rate, time };
        } else {
          // No prior snapshot — replay from scratch
          engine.reset();
          let t = 0;
          let rate = 0;
          for (let i = 0; i <= lastGlobalIdx; i++) {
            const e = events[i];
            if (e.drug !== drugId) continue;
            const dt = e.time - t;
            if (dt > 0) engine.advance(dt, rate);
            t = e.time;
            if (e === lastEvt) {
              // Partial bolus
              const partialDuration = time - e.time;
              if (partialDuration > 0) engine.advance(partialDuration, delivery.rate);
              return { ...engine.getConcentrations(), rate: delivery.rate, time };
            }
            if (e.type === 'bolus') { t += advanceBolus(engine, e); }
            else if (e.type === 'rate') rate = e.value;
            else if (e.type === 'pause') rate = 0;
          }
        }
      }

      // Query is after bolus delivery — use snapshot normally
      engine.setState(lastEvt.snapshot);
      const currentRate = getActiveRateForDrug(drugId, lastGlobalIdx);
      const dt = time - bolusEndTime;
      if (dt > 0) engine.advance(dt, currentRate);
      return { ...engine.getConcentrations(), rate: currentRate, time };
    }

    // Non-bolus event — straightforward snapshot restore
    engine.setState(lastEvt.snapshot);
    const currentRate = getActiveRateForDrug(drugId, lastGlobalIdx);
    const dt = time - lastEvt.time;
    if (dt > 0) engine.advance(dt, currentRate);
    return { ...engine.getConcentrations(), rate: currentRate, time };
  }

  /**
   * Compute a concentration curve for a drug.
   * Replays from t=0 and samples at regular intervals.
   * Boluses are delivered incrementally at sample resolution so
   * the curve shows the concentration profile during delivery.
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

    // Track active bolus delivery
    let bolusEnd = -1;    // time when current bolus delivery finishes
    let bolusRate = 0;    // mg/min during bolus delivery
    let preBolusRate = 0; // rate to restore after bolus

    /**
     * Get the effective rate at the current moment.
     * During bolus delivery, the pump is running at bolusRate.
     */
    function effectiveRate() {
      return (currentTime < bolusEnd) ? bolusRate : currentRate;
    }

    /**
     * Process a single event at currentTime.
     */
    function processEvent(evt) {
      if (evt.type === 'bolus') {
        const delivery = getBolusDelivery(evt);
        preBolusRate = currentRate;
        bolusRate = delivery.rate;
        bolusEnd = evt.time + delivery.duration;
        // Don't advance engine here — the sample loop will step through it
      } else if (evt.type === 'rate') {
        currentRate = evt.value;
        // If this is a rate-restore after bolus, clear bolus state
        if (currentTime >= bolusEnd) {
          bolusEnd = -1;
          bolusRate = 0;
        }
      } else if (evt.type === 'pause') {
        currentRate = 0;
      }
    }

    // Process events up to startTime (advance engine through them)
    while (evtPtr < drugEvents.length && drugEvents[evtPtr].time <= startTime) {
      const evt = drugEvents[evtPtr];
      const targetTime = evt.time;

      // Advance to event time
      while (currentTime < targetTime) {
        const stepTo = Math.min(targetTime, currentTime + step);
        const dt = stepTo - currentTime;
        if (dt > 0) engine.advance(dt, effectiveRate());
        currentTime = stepTo;
      }

      processEvent(evt);
      evtPtr++;
    }

    // Advance to startTime
    while (currentTime < startTime) {
      const stepTo = Math.min(startTime, currentTime + step);
      const dt = stepTo - currentTime;
      if (dt > 0) engine.advance(dt, effectiveRate());
      currentTime = stepTo;
    }

    // Sample forward
    let sampleTime = startTime;
    while (sampleTime <= endTime) {
      // Process events up to sample time
      while (evtPtr < drugEvents.length && drugEvents[evtPtr].time <= sampleTime) {
        const evt = drugEvents[evtPtr];

        // Advance to event time first
        const dt = evt.time - currentTime;
        if (dt > 0) engine.advance(dt, effectiveRate());
        currentTime = evt.time;

        processEvent(evt);
        evtPtr++;
      }

      // Advance to sample time
      const dt = sampleTime - currentTime;
      if (dt > 0) { engine.advance(dt, effectiveRate()); currentTime = sampleTime; }

      const conc = engine.getConcentrations();
      curve.push({
        time: sampleTime,
        Cp: conc.Cp,
        Ce: conc.Ce,
        C2: conc.C2,
        C3: conc.C3,
        rate: effectiveRate(),
      });
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
        let time = events[i].time;
        // Snapshot is taken after bolus delivery — adjust time
        if (events[i].type === 'bolus') {
          time += getBolusDelivery(events[i]).duration;
        }
        return { state: events[i].snapshot, time };
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
   * Find the active bolus event for a drug at a given time, if any.
   * Returns { bolusEvt, bolusEnd, restoreIdx } or null.
   */
  function findActiveBolus(drugId, time) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.drug !== drugId || e.type !== 'bolus') continue;
      if (e.time > time) continue;
      const delivery = getBolusDelivery(e);
      const bolusEnd = e.time + delivery.duration;
      if (time < bolusEnd) {
        // Find the matching rate-restore event
        let restoreIdx = -1;
        for (let j = i + 1; j < events.length; j++) {
          const r = events[j];
          if (r.drug === drugId && r.type === 'rate' &&
              r.source === 'system' && r.annotation === 'Rate restored after bolus' &&
              Math.abs(r.time - bolusEnd) < 0.001) {
            restoreIdx = j;
            break;
          }
        }
        return { bolusEvt: e, bolusIdx: i, bolusEnd, restoreIdx };
      }
      break;
    }
    return null;
  }

  /**
   * Add a rate change event.
   * If the time falls during an active bolus delivery, the event
   * is deferred to the bolus end time — the bolus completes first,
   * then the new rate takes effect.
   * 
   * @param {string} drugId
   * @param {number} time
   * @param {number} mgPerMin
   * @param {string} [annotation]
   * @returns {Object} the created event
   */
  function addRate(drugId, time, mgPerMin, annotation, opts = {}) {
    const active = findActiveBolus(drugId, time);
    let eventTime = time;
    if (active) {
      eventTime = active.bolusEnd;
      // Remove the rate-restore — our new rate replaces it
      if (active.restoreIdx >= 0) events.splice(active.restoreIdx, 1);
    }

    // Also remove any system rate-restore at the exact event time
    // (handles the case where the new rate lands exactly at bolus end)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.drug === drugId && e.type === 'rate' && e.source === 'system' &&
          Math.abs(e.time - eventTime) < 0.001) {
        events.splice(i, 1);
        break;
      }
    }

    const evt = createEvent(drugId, eventTime, 'rate', mgPerMin, {
      source: opts.source || 'manual',
      annotation: annotation || `Rate ${mgPerMin.toFixed(1)} mg/min`,
    });
    insert(evt);
    replayDrugFrom(drugId, active ? active.bolusEvt.id : evt.id);
    return evt;
  }

  /**
   * Add a bolus event.
   * If the time falls during an active bolus delivery, the new dose
   * is added to the existing bolus (merged). The delivery duration
   * is recalculated for the combined dose and the rate-restore event
   * is moved to the new end time. The curve updates as if the
   * original bolus was always the combined dose.
   * 
   * Otherwise, inserts a new bolus with a rate-restore event after
   * the delivery duration.
   * 
   * @param {string} drugId
   * @param {number} time
   * @param {number} mg
   * @param {string} [annotation]
   * @param {Object} [opts] - { deliveryMode: 'pump'|'push', source: string }
   * @returns {Object} the bolus event (original if merged, new if not)
   */
  function addBolus(drugId, time, mg, annotation, opts = {}) {
    const active = findActiveBolus(drugId, time);

    if (active) {
      // Merge into existing bolus
      const existing = active.bolusEvt;
      existing.value += mg;
      existing.annotation = `Bolus ${existing.value.toFixed(1)} mg`;

      // Recalculate delivery duration for the combined dose
      const { duration: newDuration } = getBolusDelivery(existing);
      const newEnd = existing.time + newDuration;

      // Remove old rate-restore if present
      if (active.restoreIdx >= 0) {
        events.splice(active.restoreIdx, 1);
      }

      // Find the correct rate to restore: the last non-system rate/pause
      // event at or before the new end time (ignoring the bolus itself
      // and any system rate-restore events).
      let restoreRate = 0;
      for (const e of events) {
        if (e.drug !== drugId) continue;
        if (e.time > newEnd) break;
        if (e.source === 'system') continue;  // skip rate-restores
        if (e.type === 'bolus') continue;
        if (e.type === 'rate') restoreRate = e.value;
        else if (e.type === 'pause') restoreRate = 0;
      }

      // Check if there's already a manual event exactly at newEnd
      // (e.g. a deferred rate that landed right at the new end).
      // If so, no rate-restore needed — the manual event takes over.
      const hasManualAtEnd = events.some(e =>
        e.drug === drugId && e.source !== 'system' &&
        (e.type === 'rate' || e.type === 'pause') &&
        Math.abs(e.time - newEnd) < 0.001
      );

      if (!hasManualAtEnd) {
        const rateEvt = createEvent(drugId, newEnd, 'rate', restoreRate, {
          source: 'system',
          annotation: 'Rate restored after bolus',
        });
        insert(rateEvt);
      }

      replayDrugFrom(drugId, existing.id);
      return existing;
    }

    // No active bolus — create a new one
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
   * If the time falls during an active bolus delivery, the pause
   * is deferred to the bolus end time — the bolus completes first.
   */
  function addPause(drugId, time, annotation) {
    const active = findActiveBolus(drugId, time);
    let eventTime = time;
    if (active) {
      eventTime = active.bolusEnd;
      // Remove the rate-restore — pause replaces it
      if (active.restoreIdx >= 0) events.splice(active.restoreIdx, 1);
    }

    // Also remove any system rate-restore at the exact event time
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.drug === drugId && e.type === 'rate' && e.source === 'system' &&
          Math.abs(e.time - eventTime) < 0.001) {
        events.splice(i, 1);
        break;
      }
    }

    const evt = createEvent(drugId, eventTime, 'pause', 0, {
      source: 'manual',
      annotation: annotation || 'Pump paused',
    });
    insert(evt);
    replayDrugFrom(drugId, active ? active.bolusEvt.id : evt.id);
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
    if (changes.source != null) evt.source = changes.source;
    if (changes.deliveryMode != null) evt.deliveryMode = changes.deliveryMode;

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
