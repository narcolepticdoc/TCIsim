/**
 * TCI Simulator — Main Application State
 */

import { EleveldModel } from './models/eleveld.js';
import { PKEngine, simulateTrace } from './pkengine.js';
import { generateTCISchedule } from './tciengine.js';

// ─── App State ────────────────────────────────────────────────────────────────

export const state = {
  patient: null,            // { age, weightKg, heightCm, sex }
  model: null,              // EleveldModel
  engine: null,             // PKEngine (tracks current state)
  
  // Case timing
  caseStarted: false,
  caseStartWallTime: null,  // Date.now() when case started
  caseStartOffsetMin: 0,    // offset for "back-dated" start
  currentTimeMin: 0,        // current case elapsed time
  
  // Events log (sorted by timeMin)
  // Each: { id, timeMin, type, label, value, source }
  //   type: 'rate' | 'bolus' | 'tci_target' | 'tci_cancel'
  //   source: 'manual' | 'tci'
  events: [],
  
  // TCI state
  tciActive: false,
  tciTarget: 0,             // mcg/ml
  tciSchedule: [],          // future rate events from TCI engine
  
  // Computed trace (10-sec resolution)
  trace: [],
  traceNeedsRebuild: true,
  
  // Timers
  _tickInterval: null,
  
  // Listeners
  _listeners: {},
};

let _nextEventId = 1;
const evId = () => String(_nextEventId++);

// ─── Patient Setup ─────────────────────────────────────────────────────────────

export function setupPatient(patient) {
  state.patient = patient;
  state.model = new EleveldModel(patient);
  state.engine = new PKEngine(state.model, patient.weightKg);
  state.events = [];
  state.tciActive = false;
  state.tciSchedule = [];
  state.caseStarted = false;
  state.currentTimeMin = 0;
  state.trace = [];
  state.traceNeedsRebuild = true;
  emit('patientChanged', patient);
  emit('stateChanged');
}

// ─── Case Control ──────────────────────────────────────────────────────────────

export function startCase(offsetMin = 0) {
  if (!state.patient) return;
  state.caseStarted = true;
  state.caseStartOffsetMin = offsetMin;
  state.caseStartWallTime = Date.now() - offsetMin * 60000;
  state.currentTimeMin = offsetMin;
  
  // Rebuild engine to current time
  rebuildEngineToTime(offsetMin);
  
  clearInterval(state._tickInterval);
  state._tickInterval = setInterval(() => {
    const elapsed = (Date.now() - state.caseStartWallTime) / 60000;
    state.currentTimeMin = elapsed;
    
    // Advance engine to current time if needed
    rebuildTrace();
    emit('tick', state.currentTimeMin);
  }, 1000);
  
  rebuildTrace();
  emit('stateChanged');
}

export function stopCase() {
  clearInterval(state._tickInterval);
  state._tickInterval = null;
  state.caseStarted = false;
  emit('stateChanged');
}

// ─── Event Management ─────────────────────────────────────────────────────────

export function addRateEvent(rateUgKgMin, timeMin = null) {
  const t = timeMin ?? state.currentTimeMin;
  
  // Cancel TCI if manual rate during active TCI
  if (state.tciActive) {
    cancelTCI(t, `Manual rate set: ${rateUgKgMin.toFixed(0)} mcg/kg/min`);
  }
  
  const ev = {
    id: evId(),
    timeMin: t,
    type: 'rate',
    label: `Rate → ${rateUgKgMin.toFixed(0)} mcg/kg/min`,
    value: rateUgKgMin,
    source: 'manual',
  };
  addEvent(ev);
  return ev;
}

export function addBolusEvent(bolusMg, timeMin = null) {
  const t = timeMin ?? state.currentTimeMin;
  
  if (state.tciActive) {
    cancelTCI(t, `Manual bolus: ${bolusMg.toFixed(1)} mg`);
  }
  
  const ev = {
    id: evId(),
    timeMin: t,
    type: 'bolus',
    label: `Bolus ${bolusMg.toFixed(1)} mg propofol`,
    value: bolusMg,
    source: 'manual',
  };
  addEvent(ev);
  return ev;
}

export function setTCITarget(ceMcgMl, timeMin = null) {
  const t = timeMin ?? state.currentTimeMin;
  
  // Remove existing TCI schedule events from this time forward
  purgeFutureTCIEvents(t);
  
  state.tciActive = true;
  state.tciTarget = ceMcgMl;
  
  // Log the target change
  const ev = {
    id: evId(),
    timeMin: t,
    type: 'tci_target',
    label: `TCI target Ce ${ceMcgMl.toFixed(1)} mcg/ml`,
    value: ceMcgMl,
    source: 'manual',
  };
  addEvent(ev);
  
  // Build TCI schedule from current engine state at time t
  scheduleTCI(t);
  return ev;
}

export function cancelTCI(timeMin = null, reason = 'TCI cancelled') {
  const t = timeMin ?? state.currentTimeMin;
  purgeFutureTCIEvents(t);
  state.tciActive = false;
  state.tciSchedule = [];
  
  const ev = {
    id: evId(),
    timeMin: t,
    type: 'tci_cancel',
    label: reason,
    value: null,
    source: 'manual',
  };
  addEvent(ev);
}

export function deleteEvent(id) {
  const idx = state.events.findIndex(e => e.id === id);
  if (idx === -1) return;
  state.events.splice(idx, 1);
  invalidateTrace();
  emit('stateChanged');
}

export function editEvent(id, updates) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  Object.assign(ev, updates);
  // Re-sort
  state.events.sort((a, b) => a.timeMin - b.timeMin);
  invalidateTrace();
  emit('stateChanged');
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function addEvent(ev) {
  state.events.push(ev);
  state.events.sort((a, b) => a.timeMin - b.timeMin);
  invalidateTrace();
  emit('stateChanged');
}

function purgeFutureTCIEvents(fromTime) {
  state.events = state.events.filter(e => !(e.source === 'tci' && e.timeMin >= fromTime));
}

function invalidateTrace() {
  state.traceNeedsRebuild = true;
}

function scheduleTCI(fromTime) {
  // Build engine state at fromTime
  const snapEngine = new PKEngine(state.model, state.patient.weightKg);
  const snapState = computeEngineStateAt(fromTime);
  snapEngine.setState(snapState);
  
  const { events: tciEvents, trace: tciTrace } = generateTCISchedule(
    snapEngine,
    state.patient.weightKg,
    state.tciTarget,
    fromTime,
    60
  );
  
  // Tag them as TCI and add to events
  tciEvents.forEach(e => {
    e.id = evId();
    e.label = `TCI rate ${e.value.toFixed(0)} mcg/kg/min`;
    e.source = 'tci';
    state.events.push(e);
  });
  state.events.sort((a, b) => a.timeMin - b.timeMin);
  state.tciSchedule = tciEvents;
  
  invalidateTrace();
  emit('stateChanged');
}

/**
 * Compute engine state by replaying all events from t=0 up to targetTime
 */
function computeEngineStateAt(targetTimeMin) {
  const eng = new PKEngine(state.model, state.patient.weightKg);
  const DT = 1/60; // 1-second steps
  const steps = Math.ceil(targetTimeMin / DT);
  
  const sorted = [...state.events]
    .filter(e => e.type === 'rate' || e.type === 'bolus')
    .sort((a, b) => a.timeMin - b.timeMin);
  
  let currentRate = 0;
  let evIdx = 0;
  
  for (let i = 0; i <= steps; i++) {
    const t = i * DT;
    while (evIdx < sorted.length && sorted[evIdx].timeMin <= t) {
      const ev = sorted[evIdx];
      if (ev.type === 'rate') currentRate = ev.value;
      else if (ev.type === 'bolus') eng.A1 += ev.value;
      evIdx++;
    }
    if (i < steps) eng.step(currentRate, 0, DT);
  }
  
  return eng.cloneState();
}

function rebuildEngineToTime(targetTimeMin) {
  if (!state.engine || !state.model) return;
  const s = computeEngineStateAt(targetTimeMin);
  state.engine.setState(s);
}

export function rebuildTrace() {
  if (!state.model || !state.patient) return;
  
  // Determine window: past from 0 to currentTime + 30min future
  const pastEnd = state.currentTimeMin;
  const futureEnd = pastEnd + 30;
  
  // Build trace from all manual + TCI rate/bolus events
  const traceEvents = state.events
    .filter(e => e.type === 'rate' || e.type === 'bolus')
    .map(e => ({
      timeMin: e.timeMin,
      type: e.type,
      value: e.value,
    }));
  
  state.trace = simulateTrace(state.model, state.patient.weightKg, traceEvents, futureEnd, 10);
  state.traceNeedsRebuild = false;
  
  // Update engine state to current time
  rebuildEngineToTime(state.currentTimeMin);
  
  emit('traceUpdated', state.trace);
}

// ─── Event emitter ─────────────────────────────────────────────────────────────

export function on(event, fn) {
  if (!state._listeners[event]) state._listeners[event] = [];
  state._listeners[event].push(fn);
}

export function off(event, fn) {
  if (!state._listeners[event]) return;
  state._listeners[event] = state._listeners[event].filter(f => f !== fn);
}

function emit(event, data) {
  (state._listeners[event] || []).forEach(fn => fn(data));
}

// ─── Utility ───────────────────────────────────────────────────────────────────

export function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  const s = Math.floor((minutes * 60) % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function getCurrentConcentrations() {
  if (!state.engine) return { Cp: 0, Ce: 0 };
  return { Cp: state.engine.getCp(), Ce: state.engine.getCe() };
}
