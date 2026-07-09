/**
 * test-tci-scheme.js — CET (Emulation) TCI scheme planner — the production planner.
 *
 * Imports the REAL cet-emulation planner (js/sim/tci-planner.js
 * planTCISchemeEmulation — the SimTIVA deliver_cpt port, the planner used in
 * production; stepped / cet / cet-conservative were development aids). Every
 * call threads the production pump config (750 mL/h @ 10 mg/mL → maxRate
 * 125 mg/min) exactly as js/sim/simulation.js planTCI builds it, so the test
 * exercises what actually ships. Previously this file inlined a diverged
 * stepped-style planner.
 *
 * Assertions are clinical/behavioral invariants the real planner must meet
 * (loading bolus present and within mg/kg bounds, maintenance rates step down,
 * Ce reaches and holds target, step-down has no bolus, quantized scheme lands
 * on the display grid and still holds target). Bounds are baselined to
 * cet-emulation's real behavior — verified against the live app (35 y/70 kg,
 * target 3.5, rounding on): Ce hits target by ~5 min and holds it.
 */

import { createEngine } from '../js/pk/engine.js';
import { calcEleveldParams } from '../js/pk/eleveld.js';
import { planTCISchemeEmulation as _planEmulation } from '../js/sim/tci-planner.js';
import { computeSteadyStateRate } from '../js/pk/steady-state-predictor.js';

const CONC = 10; // mg/mL propofol
const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });

// Production pump config (js/sim/simulation.js planTCI): 750 mL/h @ 10 mg/mL →
// maxRate 125 mg/min. Threaded into every plan call so the test matches ship.
const PROD = { bolusConcentration: CONC, bolusRateMlH: 750, maxRate: 125, drugId: 'propofol', weightKg: 70 };

function planTCIScheme(engine, startState, startTime, ceTarget, config={}) {
  return _planEmulation(engine, startState, startTime, ceTarget, { ...PROD, ...config });
}

// Drives the planner's quantize-in-loop path: snap bolus to whole mg and rate
// to whole mL/h before each engine.advance (see js/sim/tci/shared.js).
function planTCISchemeQuantized(engine, startState, startTime, ceTarget, config={}) {
  return planTCIScheme(engine, startState, startTime, ceTarget, {
    quantizeInDisplay:true, bolusDisplayUnit:'mg', rateDisplayUnit:'mL/h', ...config });
}

let passed=0,failed=0;
function assert(c,m){if(c){passed++;console.log(`  ✓ ${m}`)}else{failed++;console.error(`  ✗ ${m}`)}}

function fmtScheme(scheme,wgt){
  for(const s of scheme){
    if(s.type==='bolus'){
      console.log(`    ${s.time.toFixed(1)} min: BOLUS ${s.value.toFixed(1)} mg (${(s.value/wgt).toFixed(2)} mg/kg)`);
    }else{
      const mlh=(s.value/CONC)*60;
      console.log(`    ${s.time.toFixed(1)} min: RATE ${mlh.toFixed(1)} mL/h (${s.value.toFixed(2)} mg/min)`);
    }
  }
}

console.log('\n=== TEST 1: Basic Scheme Generation (Ce=3.0, ±5%) ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0);
  
  console.log(`  Generated ${scheme.length} steps:`);
  fmtScheme(scheme,70);
  
  assert(scheme.length>=2,'At least bolus + 1 rate step');
  assert(scheme.length<=24,'Bounded step count (cet-emulation emits fine cpt-interval steps)');
  assert(scheme[0].type==='bolus','First step is a bolus');
  assert(scheme[0].value>50,'Bolus > 50mg for 70kg patient targeting 3.0');
  assert(scheme[0].value<300,'Bolus < 300mg (reasonable)');
  
  // CET opens with a pause (rate 0) after its peak-matched bolus; the
  // maintenance rates that follow decrease as V2/V3 fill.
  const rates=scheme.filter(s=>s.type==='rate'&&s.value>0).map(s=>s.value);
  if(rates.length>=2){
    assert(rates[0]>rates[rates.length-1],'Maintenance rates decrease over time (distribution compensation)');
  }
}

console.log('\n=== TEST 2: Verify Concentrations During Maintenance ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.05});
  
  // Find when the last rate step starts
  const lastRateEvt=scheme.filter(s=>s.type==='rate').pop();
  const checkFrom=lastRateEvt?lastRateEvt.time+5:15; // 5 min after last step settles
  
  // Replay the scheme
  eng.reset();
  let currentRate=0, simTime=0, evtIdx=0;
  let maxDeviation=0, worstTime=0;
  
  for(let t=0;t<60;t+=0.1){
    while(evtIdx<scheme.length&&scheme[evtIdx].time<=t){
      const evt=scheme[evtIdx];
      const dt=evt.time-simTime;
      if(dt>0){eng.advance(dt,currentRate);simTime=evt.time}
      if(evt.type==='bolus'){eng.advance(0.05,evt.value/0.05);simTime+=0.05}
      else{currentRate=evt.value}
      evtIdx++;
    }
    const dt=t-simTime;
    if(dt>0){eng.advance(dt,currentRate);simTime=t}
    
    const ce=eng.getConcentrations().Ce;
    if(t>checkFrom){
      const dev=Math.abs(ce-3.0)/3.0;
      if(dev>maxDeviation){maxDeviation=dev;worstTime=t}
    }
  }
  
  console.log(`  Checking from t=${checkFrom.toFixed(1)} min onward`);
  console.log(`  Max Ce deviation during maintenance: ${(maxDeviation*100).toFixed(1)}% at t=${worstTime.toFixed(1)} min`);
  assert(maxDeviation<0.15,'Ce stays within 15% during maintenance phase');
}

console.log('\n=== TEST 3: Tight Tolerance (±2%) ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.02});
  
  console.log(`  Tight scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);
  
  // Tighter tolerance should produce more steps
  const eng2=createEngine(params);
  const loosScheme=planTCIScheme(eng2, eng2.getState(), 0, 3.0, {tolerancePct:0.10});
  
  console.log(`  Loose scheme: ${loosScheme.length} steps`);
  assert(scheme.length>=loosScheme.length,'Tighter tolerance → same or more steps');
}

console.log('\n=== TEST 4: Step count is tolerance-independent (emulation cpt loop) ===');
{
  // cet-emulation's step count is set by its 2-min cpt maintenance interval,
  // not the tolerance band — so a loose tolerance produces the same bounded
  // fine step-down as a tight one (unlike the old stepped planner).
  const eng=createEngine(params);
  const loose=planTCIScheme(eng, eng.getState(), 0, 3.0, {tolerancePct:0.10});
  const eng2=createEngine(params);
  const tight=planTCIScheme(eng2, eng2.getState(), 0, 3.0, {tolerancePct:0.02});
  console.log(`  Loose: ${loose.length} steps, Tight: ${tight.length} steps`);
  fmtScheme(loose,70);
  assert(loose.length===tight.length, 'Emulation step count is independent of tolerance band');
  assert(loose.length<=24, 'Step count stays bounded');
}

console.log('\n=== TEST 5: Bolus Dose Is Reasonable ===');
{
  const eng=createEngine(params);
  const scheme=planTCIScheme(eng, eng.getState(), 0, 3.0);
  const bolus=scheme[0];
  
  const mgKg=bolus.value/70;
  console.log(`  Bolus: ${bolus.value.toFixed(1)} mg = ${mgKg.toFixed(2)} mg/kg`);
  
  // Standard propofol induction: 1.5-2.5 mg/kg
  assert(mgKg>0.5,'Bolus > 0.5 mg/kg');
  assert(mgKg<5.0,'Bolus < 5.0 mg/kg');
}

console.log('\n=== TEST 6: Scheme From Non-Zero State (Target Change) ===');
{
  const eng=createEngine(params);
  // Run at Ce≈2.0 for a while
  eng.advance(0.05, 80/0.05); // bolus 80mg
  eng.advance(20, 1.0); // 20 min at 1 mg/min
  const state=eng.getState();
  const ce=eng.getConcentrations().Ce;
  console.log(`  Starting Ce: ${ce.toFixed(3)} μg/mL`);
  
  // Now plan scheme to Ce=4.0 (step up)
  const scheme=planTCIScheme(eng, state, 20, 4.0);
  console.log(`  Step-up scheme (2→4): ${scheme.length} steps`);
  fmtScheme(scheme,70);
  
  assert(scheme.length>=2,'Has bolus + rate steps for step-up');
  // Should have a bolus since we're below target
  const hasBolus=scheme.some(s=>s.type==='bolus');
  assert(hasBolus,'Step-up includes a bolus');
}

console.log('\n=== TEST 7: Step-Down (No Bolus Needed) ===');
{
  const eng=createEngine(params);
  // Bring Ce to ~4.0
  eng.advance(0.05, 120/0.05);
  for(let i=0;i<120;i++){
    // Quick TCI-like approach
    const ce=eng.getConcentrations().Ce;
    const rate=ce<4?eng.params.CL*4:eng.params.CL*4*0.5;
    eng.advance(10/60, rate);
  }
  const state=eng.getState();
  const ce=eng.getConcentrations().Ce;
  console.log(`  Starting Ce: ${ce.toFixed(3)} (target was ~4.0)`);

  // Step down to 2.0
  const scheme=planTCIScheme(eng, state, 20, 2.0);
  console.log(`  Step-down scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);

  // Should NOT have a bolus
  const hasBolus=scheme.some(s=>s.type==='bolus');
  assert(!hasBolus,'Step-down has no bolus');
  // First rate should be low or zero (let Ce decay)
  if(scheme.length>0&&scheme[0].type==='rate'){
    assert(scheme[0].value<eng.params.CL*3,'First rate is low/zero for step-down');
  }
}

console.log('\n=== TEST 8: Engine State Preserved ===');
{
  const eng=createEngine(params);
  eng.advance(10, 2.0);
  const before=new Float64Array(eng.getState());
  planTCIScheme(eng, eng.getState(), 10, 3.0);
  const after=eng.getState();
  let ok=true;
  for(let i=0;i<4;i++){if(Math.abs(before[i]-after[i])>1e-10){ok=false;break}}
  assert(ok,'Engine state preserved after planning');
}

console.log('\n=== TEST 9: Long-Duration Drift — Ce stays within ±6% at t=300,600,900 min ===');
{
  const ceTarget = 3.0;
  const eng = createEngine(params);
  const scheme = planTCIScheme(eng, eng.getState(), 0, ceTarget);

  console.log(`  Scheme: ${scheme.length} steps`);
  fmtScheme(scheme, 70);

  // Replay scheme forward to 900 minutes
  eng.reset();
  let currentRate = 0, simTime = 0, evtIdx = 0;
  const checkTimes = [300, 600, 900];
  const results = {};

  for (let t = 0; t <= 900; t += 0.5) {
    while (evtIdx < scheme.length && scheme[evtIdx].time <= t) {
      const evt = scheme[evtIdx];
      const dt = evt.time - simTime;
      if (dt > 0) { eng.advance(dt, currentRate); simTime = evt.time; }
      if (evt.type === 'bolus') { eng.advance(0.05, evt.value / 0.05); simTime += 0.05; }
      else { currentRate = evt.value; }
      evtIdx++;
    }
    const dt = t - simTime;
    if (dt > 0) { eng.advance(dt, currentRate); simTime = t; }

    if (checkTimes.includes(t)) {
      const ce = eng.getConcentrations().Ce;
      const dev = (ce - ceTarget) / ceTarget;
      results[t] = { ce, dev };
      console.log(`  t=${t} min: Ce=${ce.toFixed(4)}, deviation=${(dev*100).toFixed(2)}%`);
    }
  }

  for (const t of checkTimes) {
    const { dev } = results[t];
    // CET's maintenance holds Ce slightly low long-term (~5.3% at 5 h); ±6%.
    assert(Math.abs(dev) < 0.06, `Ce within ±6% at t=${t} min (actual: ${(dev*100).toFixed(2)}%)`);
  }
}

console.log('\n=== TEST 10: Analytical SS Rate Matches True Steady State ===');
{
  const ceTarget = 3.5;
  const eng = createEngine(params);
  const ssRate = computeSteadyStateRate(eng, ceTarget);
  console.log(`  SS rate for Ce=${ceTarget}: ${ssRate.toFixed(4)} mg/min (${(ssRate/10*60).toFixed(1)} mL/h)`);

  // Verify: run engine at ssRate for 2000 min (>>V3 tau), check Ce ≈ ceTarget
  eng.reset();
  eng.advance(2000, ssRate);
  const ce = eng.getConcentrations().Ce;
  const dev = Math.abs(ce - ceTarget) / ceTarget;
  console.log(`  Ce at t=2000 min: ${ce.toFixed(4)} (deviation: ${(dev*100).toFixed(4)}%)`);
  assert(dev < 0.005, `SS rate converges Ce to target within 0.5% (actual: ${(dev*100).toFixed(4)}%)`);
}

console.log('\n=== TEST 11: SS Rate Event Is Emitted In Scheme ===');
{
  const ceTarget = 3.0;
  const eng = createEngine(params);
  const scheme = planTCIScheme(eng, eng.getState(), 0, ceTarget);
  const rates = scheme.filter(s => s.type === 'rate');

  // The last rate should be close to the analytical SS rate
  const ssRate = computeSteadyStateRate(eng, ceTarget);
  const lastRate = rates[rates.length - 1].value;
  const dev = Math.abs(lastRate - ssRate) / ssRate;
  console.log(`  Last emitted rate: ${lastRate.toFixed(4)} mg/min`);
  console.log(`  Analytical SS rate: ${ssRate.toFixed(4)} mg/min`);
  console.log(`  Deviation: ${(dev*100).toFixed(2)}%`);
  assert(dev < 0.02, `Last emitted rate within 2% of analytical SS rate (actual: ${(dev*100).toFixed(2)}%)`);
}

console.log('\n=== TEST 12: Quantize-In-Loop Stepped — Rates Snap To The mL/h Grid ===');
{
  const eng=createEngine(params);
  const scheme=planTCISchemeQuantized(eng, eng.getState(), 0, 3.0);

  console.log(`  Quantized scheme: ${scheme.length} steps`);
  fmtScheme(scheme,70);

  // Every rate, in mL/h, must land on the maintenance grid: integer mL/h during
  // the active phase, or the ÷10 fine tail grid (0.1 mL/h) once the correction
  // loop converges into the steady-state regime. So every rate is a multiple of
  // 0.1 mL/h (within FP tolerance).
  let allOnGrid=true;
  for (const s of scheme) {
    if (s.type === 'rate') {
      const mlh = s.value * 60 / CONC;
      const k = Math.round(mlh * 10) / 10;
      if (Math.abs(mlh - k) > 1e-9) { allOnGrid=false; break; }
    }
  }
  assert(allOnGrid, 'Every rate in scheme is a multiple of 0.1 mL/h');

  // Bolus is a whole mg
  const bolusEvt = scheme.find(s => s.type === 'bolus');
  if (bolusEvt) {
    assert(Math.abs(bolusEvt.value - Math.round(bolusEvt.value)) < 1e-9, 'Bolus is whole mg');
  }
}

console.log('\n=== TEST 13: Quantize-in-loop holds target (no stacking error) ===');
{
  // The regression this guards (CLAUDE.md): quantize INSIDE the planning loop
  // so each engine.advance sees the already-rounded rate. cet-emulation with
  // rounding on reaches target within ~5 min and HOLDS it — verified against
  // the live app (35 y/70 kg, target 3.5, rounding on). We check the whole
  // maintenance window stays tight; a post-hoc-rounding stacking bug would
  // show up as sustained drift here.
  const ceTarget=3.0;
  const scheme=planTCISchemeQuantized(createEngine(params), createEngine(params).getState(), 0, ceTarget);

  // Replay delivering the bolus over its true pump duration (750 mL/h @ 10 mg/mL).
  function ceAt(atT) {
    const e=createEngine(params); let rate=0, t=0;
    for (const s of scheme) {
      if (s.time>atT) break;
      if (s.time>t) { e.advance(s.time-t, rate); t=s.time; }
      if (s.type==='bolus') { const dur=Math.max(0.05,(s.value/CONC)/750*60); e.advance(dur, s.value/dur); t+=dur; }
      else rate=s.value;
    }
    if (atT>t) e.advance(atT-t, rate);
    return e.getConcentrations().Ce;
  }
  for (const t of [10, 30, 60, 120]) {
    const dev = Math.abs(ceAt(t) - ceTarget) / ceTarget;
    console.log(`  Quantized Ce@${t}min = ${ceAt(t).toFixed(3)} (dev ${(dev*100).toFixed(2)}%)`);
    assert(dev < 0.05, `Quantized plan holds within ±5% of target at t=${t} min (actual: ${(dev*100).toFixed(2)}%)`);
  }
}

console.log('\n=== TEST 14: Quantize-In-Loop — State Is Preserved ===');
{
  const eng=createEngine(params);
  eng.advance(10,2.0);
  const before=new Float64Array(eng.getState());
  planTCISchemeQuantized(eng, eng.getState(), 10, 3.0);
  const after=eng.getState();
  let ok=true;
  for (let i=0;i<4;i++) { if (Math.abs(before[i]-after[i])>1e-10) { ok=false; break; } }
  assert(ok,'Quantized planner preserves engine state');
}

console.log('\n=== TEST 15: Extended-case tail — no steady-state rate oscillation ===');
{
  // Regression for the quantized-actuator limit cycle: on long cases the
  // correction loop used to flip-flop between two coarse grid rates (e.g. 90↔95
  // mcg/kg/min) once V3 saturated, bouncing Ce within the CE_TOL band. The fix
  // drops to a ÷10 fine tail grid once corrections converge, so the far tail
  // settles instead of hunting. mcg/kg/min is the coarsest unit (worst case).
  const CE_TOL = 0.015;
  const toMkm = (mgMin) => mgMin * 1000 / 70;

  // Replay a scheme (bolus over its pump duration + piecewise rates) and sample
  // Ce every dt out to tEnd.
  function ceTrace(scheme, tEnd, dt=0.5) {
    const e=createEngine(params);
    const rates=scheme.filter(s=>s.type==='rate').sort((a,b)=>a.time-b.time);
    const bol=scheme.filter(s=>s.type==='bolus').map(b=>{
      const dur=Math.max(0.05,(b.value/CONC)/750*60); return {t:b.time,end:b.time+dur,rate:b.value/dur}; });
    const rateAt=(t)=>{ let base=0; for(const r of rates){ if(r.time<=t+1e-9) base=r.value; else break; }
      let extra=0; for(const b of bol) if(t>=b.t-1e-9 && t<b.end-1e-9) extra+=b.rate; return base+extra; };
    const out=[];
    for(let t=0;t<tEnd;t+=dt){ e.advance(dt, rateAt(t)); out.push({t:t+dt, ce:e.getConcentrations().Ce}); }
    return out;
  }

  for (const target of [2.0, 3.5, 5.0]) {
    const scheme=planTCISchemeQuantized(createEngine(params), createEngine(params).getState(), 0, target,
      { rateDisplayUnit:'mcg/kg/min' });
    const rates=scheme.filter(s=>s.type==='rate');
    const tEnd=Math.min(1000, rates[rates.length-1].time+30);
    // Far tail = true steady state (V3 ~saturated): amplitude must be tiny.
    const far=ceTrace(scheme, tEnd).filter(p=>p.t>=700);
    const amp=Math.max(...far.map(p=>p.ce))-Math.min(...far.map(p=>p.ce));
    console.log(`  target ${target}: far-tail Ce amplitude ${amp.toFixed(4)} µg/mL`);
    // Original coarse sawtooth was ~0.18 µg/mL at Ce 3.5; fixed is <0.03.
    assert(amp < 0.06, `Far-tail Ce amplitude < 0.06 µg/mL at Ce ${target} (actual ${amp.toFixed(4)})`);

    // Final rate's asymptotic Ce sits on target (fine grid holds within CE_TOL).
    const lastRate=rates[rates.length-1].value;
    const e2=createEngine(params); e2.advance(100000, lastRate); // → steady state
    const off=Math.abs(e2.getConcentrations().Ce-target)/target;
    assert(off<=CE_TOL, `Final rate converges Ce to within CE_TOL at Ce ${target} (actual ${(off*100).toFixed(2)}%)`);

    // The tail must actually engage the fine grid (some rate off the coarse
    // 5 mcg/kg/min grid) — proves the two-tier switch fired.
    const usedFine=rates.some(r=>{ const m=toMkm(r.value); return Math.abs(m-Math.round(m/5)*5)>1e-6; });
    assert(usedFine, `Tail engages the fine ÷10 grid at Ce ${target}`);
  }

  // Target change re-arms rounding: after settling at Ce 3.5, a new target must
  // replan with coarse (round) loading rates and settle at the new target.
  {
    const base=planTCISchemeQuantized(createEngine(params), createEngine(params).getState(), 0, 3.5,
      { rateDisplayUnit:'mcg/kg/min' });
    // Load an engine to the near-steady state at t≈720 min by replaying base.
    const e=createEngine(params);
    const rates=base.filter(s=>s.type==='rate').sort((a,b)=>a.time-b.time);
    const bol=base.filter(s=>s.type==='bolus').map(b=>{const dur=Math.max(0.05,(b.value/CONC)/750*60);return {t:b.time,end:b.time+dur,rate:b.value/dur};});
    const rateAt=(t)=>{let base2=0;for(const r of rates){if(r.time<=t+1e-9)base2=r.value;else break;}let x=0;for(const b of bol)if(t>=b.t-1e-9&&t<b.end-1e-9)x+=b.rate;return base2+x;};
    for(let t=0;t<720;t+=0.5) e.advance(0.5, rateAt(t));

    for (const newT of [2.5, 4.5]) {
      const sch=planTCISchemeQuantized(e, e.getState(), 720, newT, { rateDisplayUnit:'mcg/kg/min' });
      const r=sch.filter(s=>s.type==='rate');
      // Early post-change maintenance rate should be on the coarse grid (rounding
      // resumed because corrections are large again).
      const coarseEarly=r.some(s=>{const m=toMkm(s.value); return s.value>0 && Math.abs(m-Math.round(m/5)*5)<1e-6;});
      assert(coarseEarly, `Target change 3.5→${newT} re-arms coarse rounding`);
      // Final rate settles at the new target.
      const e3=createEngine(params); e3.advance(100000, r[r.length-1].value);
      const off=Math.abs(e3.getConcentrations().Ce-newT)/newT;
      assert(off<=CE_TOL, `Target change 3.5→${newT} settles Ce to new target (actual ${(off*100).toFixed(2)}%)`);
    }
  }
}

// ---- SUMMARY ----
console.log(`\n${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed>0?1:0);
