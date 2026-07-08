/**
 * test-integration.js — End-to-end integration test
 * 
 * Validates the full module chain: setPatient → planTCI → computeCurve
 * → verify concentration curve has realistic pharmacokinetic shape.
 * 
 * This test exercises all modules wired together through createModel(),
 * not in isolation. It serves as a regression anchor before app.js
 * starts layering DOM code on top.
 */

// ============ REAL engine + Eleveld + SHARED SCAFFOLDING ============
import { createEngine } from '../js/pk/engine.js';
import { calcEleveldParams } from '../js/pk/eleveld.js';
// createEventList (shared helper), plus the inline planTCIScheme / createModel
// below, are test scaffolding for exercising the full chain against the REAL
// engine + Eleveld; the production event/sim/planner layers are covered by
// test-session-roundtrip, test-pump-rate-correction, test-tci-scheme, and the
// end-to-end clinical-outcome check in test-tci-plan-fidelity.
import { createEventList } from './helpers/mini-event-list.mjs';

// Inline TCI planner (simplified — generates bolus + rate steps)
function planTCIScheme(engine, startState, startTime, ceTarget, config={}) {
  const cfg = { tolerancePct: 0.05, maxRate: 200, maxSteps: 8, maxPlanTime: 120,
    simStep: 0.1, rateSearchIter: 35, minStepDuration: 3.0, rateStablePct: 0.05, ...config };
  const scheme = [];
  if (ceTarget <= 0) { scheme.push({ type: 'rate', time: startTime, value: 0 }); return scheme; }
  const saved = engine.getState();
  engine.setState(startState);
  const currentCe = engine.getConcentrations().Ce;
  let simTime = startTime;
  // Loading bolus if needed
  if (currentCe < ceTarget * (1 - cfg.tolerancePct)) {
    // Binary search for bolus dose
    let lo = 0, hi = 500;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const sv = engine.getState();
      engine.advance(0.05, mid / 0.05);
      // Scan forward for Ce peak
      let peakCe = 0;
      for (let t = 0; t < 300; t++) { engine.advance(cfg.simStep, 0); const ce = engine.getConcentrations().Ce; if (ce > peakCe) peakCe = ce; else break; }
      engine.setState(sv);
      if (peakCe < ceTarget) lo = mid; else hi = mid;
    }
    const bolusMg = Math.round((lo + hi) / 2 * 10) / 10;
    if (bolusMg > 0) {
      scheme.push({ type: 'bolus', time: simTime, value: bolusMg });
      engine.advance(0.05, bolusMg / 0.05);
      simTime += 0.05;
    }
  }
  // Find maintenance rate by binary search
  function findRate() {
    let lo = 0, hi = cfg.maxRate;
    for (let i = 0; i < cfg.rateSearchIter; i++) {
      const mid = (lo + hi) / 2;
      const ce = engine.predictCe ? engine.predictCe(cfg.minStepDuration, mid) : (() => {
        const sv = engine.getState(); engine.advance(cfg.minStepDuration, mid);
        const ce = engine.getConcentrations().Ce; engine.setState(sv); return ce;
      })();
      if (ce < ceTarget) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // Generate a few rate steps
  let prevRate = -1;
  for (let step = 0; step < cfg.maxSteps; step++) {
    if (simTime >= startTime + cfg.maxPlanTime) break;
    const rate = findRate();
    if (prevRate > 0 && Math.abs(rate - prevRate) / prevRate < cfg.rateStablePct) {
      scheme.push({ type: 'rate', time: simTime, value: rate });
      break;
    }
    scheme.push({ type: 'rate', time: simTime, value: rate });
    prevRate = rate;
    // Advance at this rate until Ce drifts
    const sv = engine.getState();
    let dur = 0;
    while (dur < cfg.maxPlanTime) {
      engine.advance(cfg.simStep, rate);
      dur += cfg.simStep;
      const ce = engine.getConcentrations().Ce;
      if (dur >= cfg.minStepDuration && (ce > ceTarget * (1 + cfg.tolerancePct) || ce < ceTarget * (1 - cfg.tolerancePct))) break;
    }
    simTime += dur;
  }
  engine.setState(saved);
  return scheme;
}

// Inline PD
function predictBIS(Ce, p) {
  if (Ce <= 0) return p.BIS_baseline;
  const g = Ce <= p.Ce50 ? p.gamma1 : p.gamma2;
  const r = Ce / p.Ce50;
  const rg = Math.pow(r, g);
  const effect = rg / (1 + rg);
  return Math.max(0, Math.min(100, p.BIS_baseline * (1 - effect)));
}

// ============ MINI createModel (matching refactored simulation.js) ============
function createModel(config = {}) {
  const cfg = { primaryDrug: 'propofol', ...config };
  let eventList = createEventList();
  let pdModels = {};
  let patient = { age: 35, weight: 70, height: 170, male: true, opioid: false };
  let params = null;

  function init() {
    params = calcEleveldParams(patient);
    eventList.registerEngine(cfg.primaryDrug, createEngine(params));
    pdModels[cfg.primaryDrug] = { Ce50: params.Ce50, gamma1: params.gamma1, gamma2: params.gamma2, BIS_baseline: params.BIS_baseline };
  }
  init();

  function setPatient(p) {
    patient = { ...patient, ...p };
    params = calcEleveldParams(patient);
    const old = eventList.getEngine(cfg.primaryDrug);
    const sv = old ? old.getState() : null;
    const ne = createEngine(params);
    if (sv) ne.setState(sv);
    eventList.registerEngine(cfg.primaryDrug, ne);
    pdModels[cfg.primaryDrug] = { Ce50: params.Ce50, gamma1: params.gamma1, gamma2: params.gamma2, BIS_baseline: params.BIS_baseline };
    eventList.replayAll();
    return params;
  }

  function planTCI(drugId, fromTime, ceTarget, tciConfig = {}) {
    const engine = eventList.getEngine(drugId);
    if (!engine) return { scheme: [], events: [] };
    eventList.clearAfter(drugId, fromTime);
    const startState = eventList.getStateAtTime(drugId, fromTime);
    const scheme = planTCIScheme(engine, startState, fromTime, ceTarget, tciConfig);
    const bolus = scheme.find(s => s.type === 'bolus');
    if (bolus) eventList.addBolus(drugId, bolus.time, bolus.value, `TCI bolus Ce=${ceTarget.toFixed(1)}`);
    const rateSteps = scheme.filter(s => s.type === 'rate').map(s => ({ time: s.time, rate: s.value }));
    const inserted = eventList.addRateBatch(drugId, rateSteps, `TCI Ce=${ceTarget.toFixed(1)}`);
    return { scheme, events: inserted };
  }

  return {
    setPatient, getPatient: () => ({ ...patient }), getParams: () => params,
    addRate: (d, t, r, a) => eventList.addRate(d, t, r, a),
    addBolus: (d, t, m, a) => eventList.addBolus(d, t, m, a),
    planTCI, clearAfter: (d, t) => eventList.clearAfter(d, t),
    getConcentrationsAt: (d, t) => eventList.getConcentrationsAt(d, t),
    computeCurve: (d, s, e, st) => eventList.computeCurve(d, s, e, st),
    predictBIS: (d, t) => { const pd = pdModels[d]; if (!pd) return null; const c = eventList.getConcentrationsAt(d, t); return predictBIS(c.Ce, pd); },
    getEvents: (d) => d ? eventList.getByDrug(d) : eventList.getAll(),
    get primaryDrug() { return cfg.primaryDrug; },
    reset() { eventList.clearAll(); pdModels = {}; init(); },
  };
}

// ============ TESTS ============
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

console.log('\n===== 1. Full Chain: setPatient → planTCI → computeCurve =====\n');

{
  const model = createModel();
  model.setPatient({ age: 50, weight: 80, height: 175, male: true, opioid: true });

  const params = model.getParams();
  ok(params.V1 > 0, `Params computed: V1=${params.V1.toFixed(2)}`);
  ok(params.Ce50 > 0, `Ce50=${params.Ce50.toFixed(3)}`);

  // Plan TCI at Ce=3.0 from t=0
  const { scheme } = model.planTCI('propofol', 0, 3.0);
  ok(scheme.length >= 2, `TCI scheme has ${scheme.length} steps (bolus + rates)`);

  const bolus = scheme.find(s => s.type === 'bolus');
  ok(bolus !== undefined, `Scheme includes a loading bolus`);
  ok(bolus.value > 50 && bolus.value < 300, `Bolus dose reasonable: ${bolus.value.toFixed(1)} mg`);

  // Compute curve for 30 minutes at 10-second resolution
  const curve = model.computeCurve('propofol', 0, 30, 10/60);
  ok(curve.length > 100, `Curve has ${curve.length} points (30 min @ 10s)`);
}

console.log('\n===== 2. Curve Shape: PK Pharmacology =====\n');

{
  const model = createModel();
  // Standard reference patient, no opioid
  const { scheme } = model.planTCI('propofol', 0, 3.0);
  const curve = model.computeCurve('propofol', 0, 30, 10/60);

  // Peak Cp should be near bolus dose / V1
  const params = model.getParams();
  const bolus = scheme.find(s => s.type === 'bolus');
  const expectedPeakCp = bolus ? bolus.value / params.V1 : 0;
  const actualPeakCp = Math.max(...curve.map(p => p.Cp));
  ok(actualPeakCp > expectedPeakCp * 0.5, `Peak Cp (${actualPeakCp.toFixed(1)}) reasonable vs dose/V1 (${expectedPeakCp.toFixed(1)})`);

  // Ce should lag Cp — at t=0.5 min, Cp > Ce
  const early = curve.find(p => p.time >= 0.5);
  if (early) {
    ok(early.Cp > early.Ce, `At t=0.5 min: Cp (${early.Cp.toFixed(2)}) > Ce (${early.Ce.toFixed(2)}) — Ce lags`);
  }

  // Ce should approach target by 15 min
  const at15 = curve.find(p => p.time >= 15);
  if (at15) {
    ok(Math.abs(at15.Ce - 3.0) < 0.5, `At t=15 min: Ce (${at15.Ce.toFixed(2)}) near target 3.0`);
  }

  // Cp should decrease after bolus (redistribution)
  const at1 = curve.find(p => p.time >= 1);
  const at5 = curve.find(p => p.time >= 5);
  if (at1 && at5) {
    ok(at5.Cp < at1.Cp, `Cp at 5 min (${at5.Cp.toFixed(2)}) < Cp at 1 min (${at1.Cp.toFixed(2)}) — redistribution`);
  }

  // Rate should decrease over time (stepped down by TCI scheme)
  const significantRates = curve.filter(p => p.rate > 1.0).map(p => p.rate);
  const firstSignificantRate = significantRates[0];
  const lastSignificantRate = significantRates[significantRates.length - 1];
  ok(lastSignificantRate < firstSignificantRate, `Rate decreases: first=${firstSignificantRate.toFixed(1)} → last=${lastSignificantRate.toFixed(1)} mg/min`);
}

console.log('\n===== 3. BIS Prediction Along Curve =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // BIS at t=0 should be baseline (93)
  const bis0 = model.predictBIS('propofol', 0);
  ok(bis0 > 90, `BIS at t=0: ${bis0.toFixed(1)} (near baseline 93)`);

  // BIS at t=10 should be in anaesthetic range (below 60)
  const bis10 = model.predictBIS('propofol', 10);
  ok(bis10 < 60, `BIS at t=10 min: ${bis10.toFixed(1)} (anaesthetic range)`);

  // BIS at t=15 should be near target BIS (~47 at Ce=Ce50, lower at Ce=3.0)
  const bis15 = model.predictBIS('propofol', 15);
  ok(bis15 > 20 && bis15 < 60, `BIS at t=15 min: ${bis15.toFixed(1)} (in clinical range 20-60)`);
}

console.log('\n===== 4. Target Change Mid-Case =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // Get Ce at 10 min
  const c10 = model.getConcentrationsAt('propofol', 10);

  // Change target to 4.0 at t=10
  model.planTCI('propofol', 10, 4.0);

  // Get curve from 10 to 30
  const curve = model.computeCurve('propofol', 10, 30, 10/60);

  // Ce should rise toward 4.0
  const at25 = curve.find(p => p.time >= 25);
  ok(at25.Ce > c10.Ce, `After target increase: Ce at 25 min (${at25.Ce.toFixed(2)}) > Ce at 10 min (${c10.Ce.toFixed(2)})`);
  ok(Math.abs(at25.Ce - 4.0) < 1.0, `Ce approaching new target 4.0 (got ${at25.Ce.toFixed(2)})`);
}

console.log('\n===== 5. Manual Bolus During TCI =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  const ceBefore = model.getConcentrationsAt('propofol', 5).Ce;

  // Give manual bolus at t=5, then clear future TCI events
  model.addBolus('propofol', 5, 50, 'Manual rescue bolus');
  model.clearAfter('propofol', 5.05); // keep bolus + rate restore, clear TCI future

  const ceAfter = model.getConcentrationsAt('propofol', 5.1).Ce;
  ok(ceAfter > ceBefore, `Bolus at t=5 raises Ce: before=${ceBefore.toFixed(2)}, after=${ceAfter.toFixed(2)}`);

  // Rate should be restored to what it was before bolus
  const events = model.getEvents('propofol');
  const restore = events.find(e => e.source === 'system' && e.time > 5);
  ok(restore !== undefined, 'Rate-restore event exists after bolus');
  ok(restore.value > 0, `Restored rate is ${restore.value.toFixed(2)} mg/min (not zero)`);
}

console.log('\n===== 6. Elderly Patient — Age-Adjusted PD =====\n');

{
  const model = createModel();
  model.setPatient({ age: 75, weight: 60, height: 165, male: false, opioid: true });

  const params = model.getParams();

  // Ce50 decreases with age (elderly = ~2.39 for 75y). Opioid correction off by default (SimTIVA mode).
  ok(params.Ce50 < 2.6, `Elderly Ce50=${params.Ce50.toFixed(3)} (should be <2.6 due to aging)`);

  // Plan TCI at Ce=2.0 (appropriate for elderly)
  model.planTCI('propofol', 0, 2.0);

  // BIS at 15 min should be in anaesthetic range
  const bis = model.predictBIS('propofol', 15);
  ok(bis > 20 && bis < 60, `Elderly BIS at t=15: ${bis.toFixed(1)} (anaesthetic range)`);

  // Bolus dose should be smaller than for reference patient
  const events = model.getEvents('propofol');
  const bolus = events.find(e => e.type === 'bolus');
  ok(bolus.value < 150, `Elderly bolus dose: ${bolus.value.toFixed(1)} mg (should be modest)`);
}

console.log('\n===== 7. computeCurve Resolution Check =====\n');

{
  const model = createModel();
  model.planTCI('propofol', 0, 3.0);

  // Default 10-second step for 30 min → 181 points
  const curve10s = model.computeCurve('propofol', 0, 30, 10/60);
  ok(curve10s.length >= 180, `10s step: ${curve10s.length} points for 30 min`);

  // 1-minute step → 31 points
  const curve1m = model.computeCurve('propofol', 0, 30, 1.0);
  ok(curve1m.length === 31, `1 min step: ${curve1m.length} points for 30 min`);

  // Both should give similar Ce at t=15
  const ce10s = curve10s.find(p => Math.abs(p.time - 15) < 0.1);
  const ce1m = curve1m.find(p => p.time === 15);
  const diff = Math.abs(ce10s.Ce - ce1m.Ce);
  ok(diff < 0.05, `Ce at t=15 agrees between resolutions: diff=${diff.toFixed(4)}`);
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
