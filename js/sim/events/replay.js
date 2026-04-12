/**
 * events/replay.js — Per-drug engine replay.
 *
 * Replaying a drug steps its engine through all that drug's events
 * and stores a snapshot (Float64Array state) on each event. Snapshots
 * are a performance optimization that lets point queries restore from
 * a nearby event rather than replaying from t=0.
 *
 * Also provides helpers for looking up the active infusion rate at a
 * given event index or time.
 */

export function createReplay(state, { getBolusDelivery, advanceBolus }) {
  /**
   * Get the active infusion rate for a drug at a given event index.
   * Walks backward through that drug's events.
   */
  function getActiveRateForDrug(drugId, beforeGlobalIdx) {
    for (let i = beforeGlobalIdx; i >= 0; i--) {
      if (state.events[i].drug !== drugId) continue;
      if (state.events[i].type === 'rate') return state.events[i].value;
      if (state.events[i].type === 'pause') return 0;
    }
    return 0;
  }

  /**
   * Get the active infusion rate for a drug at a given time.
   */
  function getRateAtTime(drugId, time) {
    let rate = 0;
    for (const evt of state.events) {
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
    const engine = state.engines[drugId];
    if (!engine) return;

    engine.reset();
    let currentTime = 0;
    let currentRate = 0;

    for (const evt of state.events) {
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
    for (const drugId of Object.keys(state.engines)) {
      replayDrug(drugId);
    }
  }

  /**
   * Replay a drug from a specific event forward (partial replay).
   * Restores the snapshot from the previous event of the same drug
   * and replays forward.
   */
  function replayDrugFrom(drugId, fromEventId) {
    const engine = state.engines[drugId];
    if (!engine) return;

    const allDrugEvts = [];
    let fromDrugIdx = -1;
    for (let i = 0; i < state.events.length; i++) {
      if (state.events[i].drug !== drugId) continue;
      if (state.events[i].id === fromEventId) fromDrugIdx = allDrugEvts.length;
      allDrugEvts.push({ globalIdx: i, evt: state.events[i] });
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

  return { getActiveRateForDrug, getRateAtTime, replayDrug, replayAll, replayDrugFrom };
}
