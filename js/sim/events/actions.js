/**
 * events/actions.js — High-level drug-scoped event actions.
 *
 * findActiveBolus, addRate, addBolus, addPause, addRateBatch,
 * editEvent, deleteEvent, deleteEventAndAfter.
 *
 * These are the operations that UI and TCI-planner code should prefer —
 * they handle the 'system' rate-restore events and per-drug replays
 * correctly.
 *
 * Invariants (see CLAUDE.md):
 *   - findActiveBolus uses strict less-than boundaries.
 *     Boundary-collision bugs (rate change at the exact end of a bolus)
 *     require the explicit scans in addRate / addPause — do not rely
 *     on findActiveBolus alone.
 *   - System rate-restore events must stay visible in the UI.
 *     addBolus creates them with source: 'system' + the exact annotation
 *     'Rate restored after bolus' that the history view keys off of.
 */

export function createActions(
  state,
  {
    createEvent,
    getBolusDelivery,
    getRateAtTime,
    insert,
    replayDrug,
    replayDrugFrom,
  },
) {
  /**
   * Find the active bolus event for a drug at a given time, if any.
   * Returns { bolusEvt, bolusIdx, bolusEnd, restoreIdx } or null.
   */
  function findActiveBolus(drugId, time) {
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.drug !== drugId || e.type !== 'bolus') continue;
      if (e.time > time) continue;
      const delivery = getBolusDelivery(e);
      const bolusEnd = e.time + delivery.duration;
      if (time < bolusEnd) {
        // Find the matching rate-restore event
        let restoreIdx = -1;
        for (let j = i + 1; j < state.events.length; j++) {
          const r = state.events[j];
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
   * @param {Object} [opts]
   * @returns {Object} the created event
   */
  function addRate(drugId, time, mgPerMin, annotation, opts = {}) {
    const active = findActiveBolus(drugId, time);
    let eventTime = time;
    if (active) {
      eventTime = active.bolusEnd;
      // Remove the rate-restore — our new rate replaces it
      if (active.restoreIdx >= 0) state.events.splice(active.restoreIdx, 1);
    }

    // Also remove any system rate-restore at the exact event time
    // (handles the case where the new rate lands exactly at bolus end)
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.drug === drugId && e.type === 'rate' && e.source === 'system' &&
          Math.abs(e.time - eventTime) < 0.001) {
        state.events.splice(i, 1);
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
        state.events.splice(active.restoreIdx, 1);
      }

      // Find the correct rate to restore: the last non-system rate/pause
      // event at or before the new end time (ignoring the bolus itself
      // and any system rate-restore events).
      let restoreRate = 0;
      for (const e of state.events) {
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
      const hasManualAtEnd = state.events.some(e =>
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
      if (active.restoreIdx >= 0) state.events.splice(active.restoreIdx, 1);
    }

    // Also remove any system rate-restore at the exact event time
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i];
      if (e.drug === drugId && e.type === 'rate' && e.source === 'system' &&
          Math.abs(e.time - eventTime) < 0.001) {
        state.events.splice(i, 1);
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
    const evt = state.events.find(e => e.id === id);
    if (!evt) return null;

    const drugId = evt.drug;
    const timeChanged = changes.time != null && changes.time !== evt.time;
    const wasBolus = evt.type === 'bolus';

    // Capture old bolus end BEFORE applying any changes
    let oldBolusEnd = null;
    if (wasBolus) {
      const { duration: oldDuration } = getBolusDelivery(evt);
      oldBolusEnd = evt.time + oldDuration;
    }

    if (changes.value != null) evt.value = changes.value;
    if (changes.type != null) evt.type = changes.type;
    if (changes.annotation != null) evt.annotation = changes.annotation;
    if (changes.source != null) evt.source = changes.source;
    if (changes.deliveryMode != null) evt.deliveryMode = changes.deliveryMode;

    if (timeChanged) {
      evt.time = changes.time;
      const idx = state.events.indexOf(evt);
      if (idx !== -1) state.events.splice(idx, 1);
      insert(evt);
    }

    // If this was (and remains) a bolus, sync the associated rate-restore event
    if (wasBolus && evt.type === 'bolus') {
      const newBolusEnd = evt.time + getBolusDelivery(evt).duration;
      if (Math.abs(newBolusEnd - oldBolusEnd) > 1e-9) {
        const restoreEvt = state.events.find(e =>
          e.drug === drugId &&
          e.type === 'rate' &&
          e.source === 'system' &&
          e.annotation === 'Rate restored after bolus' &&
          Math.abs(e.time - oldBolusEnd) < 0.001
        );
        if (restoreEvt) {
          const ri = state.events.indexOf(restoreEvt);
          if (ri !== -1) state.events.splice(ri, 1);
          restoreEvt.time = newBolusEnd;
          insert(restoreEvt);
        }
      }
    }

    replayDrug(drugId);
    return evt;
  }

  /**
   * Delete a single event.
   * Does NOT clear future events — the caller decides.
   */
  function deleteEvent(id) {
    const evt = state.events.find(e => e.id === id);
    if (!evt) return null;

    const drugId = evt.drug;
    const idx = state.events.indexOf(evt);
    if (idx !== -1) state.events.splice(idx, 1);

    replayDrug(drugId);
    return evt;
  }

  /**
   * Delete a single event and all events for that drug after it.
   */
  function deleteEventAndAfter(id) {
    const evt = state.events.find(e => e.id === id);
    if (!evt) return null;

    const drugId = evt.drug;
    const cutoffTime = evt.time;
    state.events = state.events.filter(e => !(e.drug === drugId && e.time >= cutoffTime));
    replayDrug(drugId);
    return evt;
  }

  return {
    findActiveBolus,
    addRate,
    addBolus,
    addPause,
    addRateBatch,
    editEvent,
    deleteEvent,
    deleteEventAndAfter,
  };
}
