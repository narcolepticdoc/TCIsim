/**
 * events/list-ops.js — Core list operations.
 *
 * Basic CRUD on the shared events array: insert (time-sorted),
 * remove / getById / getAll / getByDrug, plus clearAfter / clearFrom /
 * clearAll which mutate the list and trigger drug replays.
 */

export function createListOps(state, { replayDrug }) {
  /**
   * Insert an event in time-sorted order.
   * Events at the same time are ordered by insertion (stable).
   */
  function insert(event) {
    let idx = state.events.length;
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i].time <= event.time) { idx = i + 1; break; }
      if (i === 0) idx = 0;
    }
    state.events.splice(idx, 0, event);
    return event;
  }

  /**
   * Remove an event by ID.
   */
  function remove(id) {
    const idx = state.events.findIndex(e => e.id === id);
    if (idx === -1) return null;
    return state.events.splice(idx, 1)[0];
  }

  /**
   * Get an event by ID.
   */
  function getById(id) {
    return state.events.find(e => e.id === id) || null;
  }

  /**
   * Get all events (unified, time-sorted).
   */
  function getAll() {
    return [...state.events];
  }

  /**
   * Get events for a specific drug.
   */
  function getByDrug(drugId) {
    return state.events.filter(e => e.drug === drugId);
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
    const before = state.events.length;
    state.events = state.events.filter(e => !(e.drug === drugId && e.time > afterTime));
    const removed = before - state.events.length;
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
    const before = state.events.length;
    state.events = state.events.filter(e => !(e.drug === drugId && e.time >= fromTime));
    const removed = before - state.events.length;
    if (removed > 0) replayDrug(drugId);
    return removed;
  }

  /**
   * Clear everything.
   */
  function clearAll() {
    state.events = [];
    state.nextId = 1;
    for (const id of Object.keys(state.engines)) {
      state.engines[id].reset();
    }
  }

  return { insert, remove, getById, getAll, getByDrug, clearAfter, clearFrom, clearAll };
}
