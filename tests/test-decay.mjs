/**
 * test-decay.js — Trough-time prediction (intermittent bolus mode).
 *
 * Imports the REAL js/pk/decay-predictor.js predictTroughTime against the
 * real engine + Eleveld params (previously inlined faithful copies that had
 * drifted from production). Assertions are behavioral: trough found, time
 * ordering under larger boluses, Ce ≈ target at the predicted time, engine
 * state preserved.
 */

import { createEngine } from '../js/pk/engine.js';
import { calcEleveldParams } from '../js/pk/eleveld.js';
import { predictTroughTime } from '../js/pk/decay-predictor.js';

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

const params = calcEleveldParams({ age:35, weight:70, height:170, male:true, opioid:false });

console.log('\n=== TEST 1: Trough Time After Bolus (No Infusion) ===');
{
  const eng=createEngine(params);
  
  // Give a 100mg bolus — Ce starts ~0, rises to ~1-2, then decays
  eng.advance(0.05, 100/0.05);
  const postBolusState=eng.getState();
  const postBolusCe=eng.getConcentrations().Ce;
  console.log(`  Immediate post-bolus Ce: ${postBolusCe.toFixed(3)} μg/mL (Ce lags behind Cp)`);

  // Let Ce equilibrate to find peak
  eng.advance(5, 0); // 5 min decay
  const peakCe=eng.getConcentrations().Ce;
  console.log(`  Ce at 5 min (near peak): ${peakCe.toFixed(3)} μg/mL`);

  // Predict when Ce decays to 0.5 μg/mL from the bolus state
  const result=predictTroughTime(eng, postBolusState, 0, 0.5, 0);
  console.log(`  Time to Ce=0.5: ${result.time!==null?result.time.toFixed(1)+' min':'never'}`);
  console.log(`  Ce at that time: ${result.ceAtTime.toFixed(3)}`);

  assert(result.time!==null,'Trough time found');
  assert(result.time>3,'Trough time is well after bolus (Ce must rise first then decay)');
  assert(Math.abs(result.ceAtTime-0.5)<0.02,'Ce at trough time ≈ 0.5');

  // Verify
  eng.setState(postBolusState);
  eng.advance(result.time, 0);
  const verifyCe=eng.getConcentrations().Ce;
  console.log(`  Verification Ce: ${verifyCe.toFixed(3)}`);
  assert(Math.abs(verifyCe-0.5)<0.02,'Verified Ce at predicted time');
}

console.log('\n=== TEST 2: Already Below Trough ===');
{
  const eng=createEngine(params);
  const state=eng.getState();
  const result=predictTroughTime(eng, state, 5.0, 1.0, 0);
  assert(result.time===5.0,'Returns current time when already below trough');
  assert(result.ceAtTime<0.01,'Ce is ~0');
}

console.log('\n=== TEST 3: Multiple Boluses — Trough Shifts ===');
{
  const eng=createEngine(params);
  
  // 50mg bolus
  eng.advance(0.05, 50/0.05);
  const state1=eng.getState();
  const r1=predictTroughTime(eng, state1, 0, 0.3, 0);
  
  // 100mg bolus
  eng.reset();
  eng.advance(0.05, 100/0.05);
  const state2=eng.getState();
  const r2=predictTroughTime(eng, state2, 0, 0.3, 0);

  console.log(`  50mg bolus → trough 0.3 at ${r1.time?.toFixed(1)} min`);
  console.log(`  100mg bolus → trough 0.3 at ${r2.time?.toFixed(1)} min`);

  assert(r1.time!==null&&r2.time!==null,'Both reach trough');
  assert(r2.time>r1.time,'Larger bolus takes longer to decay to trough');
}

console.log('\n=== TEST 4: Low Trough — Long Decay ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 100/0.05);
  const state=eng.getState();
  
  const result=predictTroughTime(eng, state, 0, 0.05, 0);
  console.log(`  Time to Ce=0.05: ${result.time!==null?result.time.toFixed(1)+' min':'never'}`);
  assert(result.time!==null,'Reaches very low trough eventually');
  assert(result.time>30,'Takes >30 min to reach 0.05 μg/mL');
}

console.log('\n=== TEST 5: High Trough — Near Peak ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 200/0.05);
  const state=eng.getState();
  
  // Find actual peak Ce by scanning
  eng.setState(state);
  let maxCe=0,maxT=0;
  for(let t=0.5;t<30;t+=0.5){eng.setState(state);eng.advance(t,0);const ce=eng.getConcentrations().Ce;if(ce>maxCe){maxCe=ce;maxT=t}}
  console.log(`  Peak Ce after 200mg: ${maxCe.toFixed(3)} at t=${maxT.toFixed(1)} min`);

  // Trough set to 90% of peak — should find it during the decay phase
  const trough=maxCe*0.9;
  const result=predictTroughTime(eng, state, 0, trough, 0);
  console.log(`  Time to Ce=${trough.toFixed(3)}: ${result.time?.toFixed(1)} min`);
  assert(result.time!==null,'Found trough near peak');
  assert(result.time>maxT,'Trough time is after peak time');
}

console.log('\n=== TEST 6: Trough With Background Infusion ===');
{
  const eng=createEngine(params);
  eng.advance(10, 2.0);
  const state=eng.getState();
  const currentCe=eng.getConcentrations().Ce;
  console.log(`  Ce after 10min at 2mg/min: ${currentCe.toFixed(3)}`);

  // Stop infusion and predict decay to 0.1
  const result=predictTroughTime(eng, state, 10, 0.1, 0);
  console.log(`  Time to Ce=0.1 (no infusion): ${result.time?.toFixed(1)} min`);
  assert(result.time!==null,'Reaches trough after stopping');
  assert(result.time>10,'Trough time is after the start time');
}

console.log('\n=== TEST 7: Engine State Preserved ===');
{
  const eng=createEngine(params);
  eng.advance(0.05, 100/0.05);
  const stateBefore=new Float64Array(eng.getState());
  
  predictTroughTime(eng, eng.getState(), 0, 0.5, 0);
  
  const stateAfter=eng.getState();
  let preserved=true;
  for(let i=0;i<4;i++){if(Math.abs(stateBefore[i]-stateAfter[i])>1e-10){preserved=false;break}}
  assert(preserved,'Engine state unchanged after prediction');
}

// ---- SUMMARY ----
console.log(`\n${'='.repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed>0?1:0);
