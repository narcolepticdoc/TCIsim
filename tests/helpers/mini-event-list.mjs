/**
 * tests/helpers/mini-event-list.mjs — shared TEST SCAFFOLDING.
 *
 * A minimal, stateless event list that mirrors the shape of the refactored
 * js/sim/events (insert/replay/query/CRUD) but is deliberately a standalone
 * copy: it lets the engine-mechanics tests exercise the REAL matrix engine
 * (registered via registerEngine) around a controlled event timeline without
 * pulling in the production simulation facade.
 *
 * This is NOT the production event list — that layer is covered end-to-end by
 * test-session-roundtrip.mjs and test-pump-rate-correction.js against the real
 * createModel(). This helper exists only so test-model / test-integration /
 * test-t0-edge don't each carry their own byte-drifted copy of the same
 * scaffolding (they used to; the triplication is what this file removes).
 *
 * Events carry NO `status` field — the refactored production events dropped it,
 * and test-model asserts its absence. Method aliases addManualRate/addManualBolus
 * mirror addRate/addBolus for the t=0 edge tests.
 *
 * Each test file runs in its own Node process (see run-tests.js), so the
 * module-level id counter is per-file and never leaks across suites.
 */

let _nid = 1;
function genId() { return 'evt_' + String(_nid++).padStart(5, '0'); }

export function createEvt(drug, time, type, value, opts = {}) {
  return { id: genId(), drug, time, type, value, source: opts.source || 'manual', annotation: opts.annotation || '', snapshot: null };
}

export function createEventList() {
  let events = []; const engines = {};
  function registerEngine(d, e) { engines[d] = e; }
  function getEngine(d) { return engines[d] || null; }
  function getDrugIds() { return Object.keys(engines); }
  function insert(e) { let idx = events.length; for (let i = events.length - 1; i >= 0; i--) { if (events[i].time <= e.time) { idx = i + 1; break; } if (i === 0) idx = 0; } events.splice(idx, 0, e); return e; }
  function remove(id) { const i = events.findIndex(e => e.id === id); if (i === -1) return null; return events.splice(i, 1)[0]; }
  function getById(id) { return events.find(e => e.id === id) || null; }
  function getAll() { return [...events]; }
  function getByDrug(d) { return events.filter(e => e.drug === d); }

  function clearAfter(d, afterTime) {
    const before = events.length;
    events = events.filter(e => !(e.drug === d && e.time > afterTime));
    const removed = before - events.length;
    if (removed > 0) replayDrug(d);
    return removed;
  }
  function clearFrom(d, fromTime) {
    const before = events.length;
    events = events.filter(e => !(e.drug === d && e.time >= fromTime));
    const removed = before - events.length;
    if (removed > 0) replayDrug(d);
    return removed;
  }
  function clearAll() { events = []; _nid = 1; for (const d of Object.keys(engines)) engines[d].reset(); }

  function getActiveRateForDrug(d, beforeIdx) { for (let i = beforeIdx; i >= 0; i--) { if (events[i].drug !== d) continue; if (events[i].type === 'rate') return events[i].value; if (events[i].type === 'pause') return 0; } return 0; }
  function getRateAtTime(d, time) { let r = 0; for (const e of events) { if (e.drug !== d) continue; if (e.time > time) break; if (e.type === 'rate') r = e.value; else if (e.type === 'pause') r = 0; } return r; }

  function replayDrug(d) { const eng = engines[d]; if (!eng) return; eng.reset(); let ct = 0, cr = 0; for (const evt of events) { if (evt.drug !== d) continue; const dt = evt.time - ct; if (dt > 0) eng.advance(dt, cr); ct = evt.time; if (evt.type === 'bolus') { eng.advance(0.05, evt.value / 0.05); ct += 0.05; } else if (evt.type === 'rate') cr = evt.value; else if (evt.type === 'pause') cr = 0; evt.snapshot = eng.getState(); } }
  function replayAll() { for (const d of Object.keys(engines)) replayDrug(d); }
  function replayDrugFrom(d, fromId) { replayDrug(d); } // simplified for tests

  function getConcentrationsAt(d, time) { const eng = engines[d]; if (!eng) return { Cp: 0, Ce: 0, C2: 0, C3: 0, rate: 0, time }; let le = null, li = -1; for (let i = events.length - 1; i >= 0; i--) { if (events[i].drug === d && events[i].time <= time) { le = events[i]; li = i; break; } } if (!le) { eng.reset(); if (time > 0) eng.advance(time, 0); return { ...eng.getConcentrations(), rate: 0, time }; } if (!le.snapshot) replayDrug(d); eng.setState(le.snapshot); let ct = le.time; if (le.type === 'bolus') ct += 0.05; const cr = getActiveRateForDrug(d, li); const dt = time - ct; if (dt > 0) eng.advance(dt, cr); return { ...eng.getConcentrations(), rate: cr, time }; }

  function computeCurve(d, startTime, endTime, step = 10 / 60) { const eng = engines[d]; if (!eng) return []; const devts = events.filter(e => e.drug === d); const curve = []; eng.reset(); let ct = 0, cr = 0, ep = 0; while (ep < devts.length && devts[ep].time <= startTime) { const e = devts[ep]; const dt = e.time - ct; if (dt > 0) eng.advance(dt, cr); ct = e.time; if (e.type === 'bolus') { eng.advance(0.05, e.value / 0.05); ct += 0.05; } else if (e.type === 'rate') cr = e.value; else if (e.type === 'pause') cr = 0; ep++; } if (startTime > ct) { eng.advance(startTime - ct, cr); ct = startTime; } let st = startTime; while (st <= endTime) { while (ep < devts.length && devts[ep].time <= st) { const e = devts[ep]; const dt = e.time - ct; if (dt > 0) eng.advance(dt, cr); ct = e.time; if (e.type === 'bolus') { eng.advance(0.05, e.value / 0.05); ct += 0.05; } else if (e.type === 'rate') cr = e.value; else if (e.type === 'pause') cr = 0; ep++; } const dt = st - ct; if (dt > 0) { eng.advance(dt, cr); ct = st; } const c = eng.getConcentrations(); curve.push({ time: st, Cp: c.Cp, Ce: c.Ce, C2: c.C2, C3: c.C3, rate: cr }); st += step; } return curve; }

  function getStateAtTime(d, time) { getConcentrationsAt(d, time); return engines[d] ? engines[d].getState() : new Float64Array(4); }
  function getStateAtLastEvent(d) { for (let i = events.length - 1; i >= 0; i--) { if (events[i].drug === d && events[i].snapshot) return { state: events[i].snapshot, time: events[i].time }; } return { state: engines[d] ? engines[d].getState() : new Float64Array(4), time: 0 }; }

  function addRate(d, time, rate, ann) { const e = createEvt(d, time, 'rate', rate, { annotation: ann || '' }); insert(e); replayDrugFrom(d, e.id); return e; }
  function addBolus(d, time, mg, ann) { const pr = getRateAtTime(d, time); const be = createEvt(d, time, 'bolus', mg, { annotation: ann || '' }); insert(be); const re = createEvt(d, time + 0.05, 'rate', pr, { source: 'system', annotation: 'Rate restored' }); insert(re); replayDrugFrom(d, be.id); return be; }
  function addPause(d, time, ann) { const e = createEvt(d, time, 'pause', 0, { annotation: ann || '' }); insert(e); replayDrugFrom(d, e.id); return e; }
  function addRateBatch(d, steps, ann) { const created = []; for (const s of steps) { const e = createEvt(d, s.time, 'rate', s.rate, { source: 'tci', annotation: ann || '' }); insert(e); created.push(e); } if (created.length > 0) replayDrugFrom(d, created[0].id); return created; }

  function editEvent(id, changes) { const evt = getById(id); if (!evt) return null; const d = evt.drug; if (changes.value != null) evt.value = changes.value; if (changes.time != null) { evt.time = changes.time; const idx = events.indexOf(evt); if (idx !== -1) events.splice(idx, 1); insert(evt); } replayDrug(d); return evt; }
  function deleteEvent(id) { const evt = getById(id); if (!evt) return null; const d = evt.drug; const idx = events.indexOf(evt); if (idx !== -1) events.splice(idx, 1); replayDrug(d); return evt; }
  function deleteEventAndAfter(id) { const evt = getById(id); if (!evt) return null; const d = evt.drug; const t = evt.time; events = events.filter(e => !(e.drug === d && e.time >= t)); replayDrug(d); return evt; }

  return {
    registerEngine, getEngine, getDrugIds, insert, remove, getById, getAll, getByDrug,
    clearAfter, clearFrom, clearAll, replayDrug, replayAll, replayDrugFrom,
    getConcentrationsAt, computeCurve, getRateAtTime, getActiveRateForDrug,
    getStateAtLastEvent, getStateAtTime,
    addRate, addBolus, addPause, addRateBatch,
    // t=0 edge tests use the "Manual" naming for the same operations.
    addManualRate: addRate, addManualBolus: addBolus,
    editEvent, deleteEvent, deleteEventAndAfter,
    get length() { return events.length; }, get raw() { return events; },
  };
}
