/**
 * events/query.js — Concentration queries.
 *
 * Point-in-time reads and regular-interval curve sampling, using event
 * snapshots to avoid replaying from t=0 on every query. Also provides
 * helpers for reading the engine state at a specific event or time —
 * used as the starting point for TCI planning.
 */

import { bolusDeliveryMinutes, pushDeliveryMinutes } from '../../util/constants.js';

/**
 * Walk a drug's events and sum the total mg delivered up to `now`.
 * Rate segments are integrated (rate × duration). Bolus events add
 * their full value if fully delivered by `now`, or a time-proportional
 * fraction if delivery is still in progress. Background rate is
 * suppressed while a bolus is delivering (mirrors replay semantics).
 *
 * Pure function — takes a pre-filtered events array for the drug.
 * The drug-scoped breakdown is the single source of truth for the
 * history panel "Total delivered" row and the reconciliation modal.
 *
 * @param {Array} events - events already filtered to a single drug, sorted by time
 * @param {string} drugId
 * @param {number} now - minutes since case start
 * @returns {{ bolusMg: number, rateMg: number, totalMg: number }}
 */
export function getCumulativeDose(events, drugId, now) {
  if (!events || !events.length || !(now > 0)) {
    return { bolusMg: 0, rateMg: 0, totalMg: 0 };
  }

  let bolusMg = 0;
  let rateMg = 0;
  let currentTime = 0;
  let currentRate = 0;

  for (const evt of events) {
    if (evt.time > now) break;
    if (evt.time > currentTime) {
      rateMg += (evt.time - currentTime) * currentRate;
      currentTime = evt.time;
    }
    if (evt.type === 'bolus') {
      const duration = evt.deliveryMode === 'push'
        ? pushDeliveryMinutes(evt.value, drugId)
        : bolusDeliveryMinutes(evt.value, drugId);
      const endTime = evt.time + duration;
      if (endTime <= now) {
        bolusMg += evt.value;
        currentTime = endTime;
      } else {
        const frac = (now - evt.time) / duration;
        bolusMg += evt.value * Math.max(0, Math.min(1, frac));
        currentTime = now;
        break;
      }
    } else if (evt.type === 'rate') {
      currentRate = evt.value;
    } else if (evt.type === 'pause') {
      currentRate = 0;
    }
  }
  if (currentTime < now) {
    rateMg += (now - currentTime) * currentRate;
  }
  return { bolusMg, rateMg, totalMg: bolusMg + rateMg };
}

export function createQuery(
  state,
  { getBolusDelivery, advanceBolus },
  { replayDrug, getActiveRateForDrug },
) {
  /**
   * Get concentrations for a drug at a given time.
   * Finds the nearest prior event's snapshot and advances from there.
   * During bolus delivery, computes partial delivery correctly.
   */
  function getConcentrationsAt(drugId, time) {
    const engine = state.engines[drugId];
    if (!engine) return { Cp: 0, Ce: 0, C2: 0, C3: 0, rate: 0, time };

    // Find the last event for this drug at or before the requested time
    let lastEvt = null;
    let lastGlobalIdx = -1;
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i].drug === drugId && state.events[i].time <= time) {
        lastEvt = state.events[i];
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
          if (state.events[i].drug === drugId) {
            prevEvt = state.events[i];
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
            const e = state.events[i];
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
    const engine = state.engines[drugId];
    if (!engine) return [];

    const drugEvents = state.events.filter(e => e.drug === drugId);
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
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i].drug === drugId && state.events[i].snapshot) {
        let time = state.events[i].time;
        // Snapshot is taken after bolus delivery — adjust time
        if (state.events[i].type === 'bolus') {
          time += getBolusDelivery(state.events[i]).duration;
        }
        return { state: state.events[i].snapshot, time };
      }
    }
    const engine = state.engines[drugId];
    return { state: engine ? engine.getState() : new Float64Array(4), time: 0 };
  }

  /**
   * Get the engine state at a specific time for a drug.
   * Useful for TCI planning from an arbitrary point.
   */
  function getStateAtTime(drugId, time) {
    getConcentrationsAt(drugId, time); // side effect: sets engine state
    const engine = state.engines[drugId];
    return engine ? engine.getState() : new Float64Array(4);
  }

  return { getConcentrationsAt, computeCurve, getStateAtLastEvent, getStateAtTime };
}
