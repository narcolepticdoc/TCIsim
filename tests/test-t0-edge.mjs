/**
 * test-t0-edge.js — t=0 initialization edge case tests
 * 
 * Verifies correct behavior at the boundary of the first interval:
 * - Zero state initialization
 * - Bolus at t=0 from zero state
 * - Rate change at t=0
 * - Simultaneous events at t=0
 * - Querying concentrations at and near t=0
 * - Matrix exponential with zero state vector
 */


import { createEngine } from '../js/pk/engine.js';
// The shared mini event-list is TEST SCAFFOLDING for exercising event ordering
// at t=0 against the REAL engine (registered via registerEngine) — it is not a
// reimplementation of js/sim/events under test. See the helper's header.
import { createEventList } from './helpers/mini-event-list.mjs';

// Reference patient: 35y/70kg/170cm male, no opioid
const REF = { V1:6.28, V2:25.5, V3:273, CL:1.79, Q2:1.75, Q3:1.11, ke0:0.146 };

// ============ TESTS ============
let passed=0,failed=0;
function ok(cond,msg){if(cond){passed++;console.log(`  ✓ ${msg}`)}else{failed++;console.error(`  ✗ ${msg}`)}}
function near(a,b,tol,msg){const rel=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(rel<tol,`${msg} (got ${a.toFixed(6)}, expected ${b.toFixed(6)}, ${(rel*100).toFixed(3)}%)`)}

// ===== GROUP 1: Engine Zero-State Behavior =====
console.log('\n===== 1. Engine Zero-State Initialization =====\n');

{
  const eng = createEngine(REF);
  const c = eng.getConcentrations();
  ok(c.Cp === 0 && c.Ce === 0 && c.C2 === 0 && c.C3 === 0, 
    'Fresh engine returns all-zero concentrations');
}

{
  const eng = createEngine(REF);
  eng.advance(0, 10); // dt=0, should be no-op
  const c = eng.getConcentrations();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(0, R) is a no-op — state stays zero');
}

{
  const eng = createEngine(REF);
  eng.advance(-1, 10); // negative dt, should be no-op
  const c = eng.getConcentrations();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(negative dt, R) is a no-op');
}

{
  const eng = createEngine(REF);
  eng.advance(5, 0); // zero rate, zero state — decay of nothing
  const c = eng.getConcentrations();
  ok(c.Cp === 0 && c.Ce === 0, 'advance(dt, 0) from zero state stays zero');
}

// ===== GROUP 2: Bolus from Zero State =====
console.log('\n===== 2. Bolus from Zero State =====\n');

{
  // 100mg bolus delivered over 0.05 min (3 seconds) — our standard delivery
  const eng = createEngine(REF);
  eng.advance(0.05, 100 / 0.05); // 2000 mg/min for 0.05 min = 100mg
  const c = eng.getConcentrations();
  
  ok(c.Cp > 0, `Bolus from zero: Cp is positive (${c.Cp.toFixed(3)} µg/mL)`);
  ok(c.Ce > 0, `Bolus from zero: Ce is positive (${c.Ce.toFixed(6)} µg/mL)`);
  ok(c.C2 > 0, 'Bolus from zero: C2 is positive (redistribution started)');
  ok(c.C3 > 0, 'Bolus from zero: C3 is positive (redistribution started)');
  
  // Cp should be close to dose/V1 = 100/6.28 ≈ 15.92
  // But after 3 seconds of redistribution it'll be slightly less
  near(c.Cp, 100/REF.V1, 0.02, 'Cp ≈ dose/V1 within 2% after 3s bolus delivery');
}

{
  // Verify the bolus total amount is correct
  const eng = createEngine(REF);
  eng.advance(0.05, 100 / 0.05);
  const s = eng.getState();
  const totalAmount = s[0] + s[1] + s[2]; // A1 + A2 + A3 (Ce is concentration, not amount)
  // Total should be slightly less than 100mg due to elimination during delivery
  ok(totalAmount > 99 && totalAmount < 100.01, 
    `Total amount in compartments = ${totalAmount.toFixed(4)} mg (≈100mg, minus elimination)`);
}

{
  // Two identical approaches should give identical results:
  // Approach A: bolus via high-rate infusion
  const engA = createEngine(REF);
  engA.advance(0.05, 100/0.05);
  engA.advance(4.95, 0); // total 5 min
  
  // Approach B: same but with a reset + restore
  const engB = createEngine(REF);
  engB.advance(0.05, 100/0.05);
  const snapshot = engB.getState();
  engB.reset();
  engB.setState(snapshot);
  engB.advance(4.95, 0);
  
  const cA = engA.getConcentrations();
  const cB = engB.getConcentrations();
  near(cA.Cp, cB.Cp, 1e-10, 'Snapshot save/restore preserves Cp exactly');
  near(cA.Ce, cB.Ce, 1e-10, 'Snapshot save/restore preserves Ce exactly');
}

// ===== GROUP 3: Rate Infusion from Zero State =====
console.log('\n===== 3. Rate Infusion from Zero State =====\n');

{
  const eng = createEngine(REF);
  eng.advance(1, 2.0); // 2 mg/min for 1 minute = 2mg delivered
  const c = eng.getConcentrations();
  ok(c.Cp > 0, `1 min infusion from zero: Cp > 0 (${c.Cp.toFixed(4)})`);
  ok(c.Ce > 0, `1 min infusion from zero: Ce > 0 (${c.Ce.toFixed(6)})`);
  ok(c.Ce < c.Cp, 'Ce lags Cp during initial infusion');
}

// ===== GROUP 4: Event System t=0 Scenarios =====
console.log('\n===== 4. Event System at t=0 =====\n');

{
  // Bolus at t=0
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  ok(el.length === 2, `Bolus at t=0 creates 2 events (bolus + rate restore) [got ${el.length}]`);
  ok(el.raw[0].time === 0 && el.raw[0].type === 'bolus', 'First event is bolus at t=0');
  ok(el.raw[1].time === 0.05 && el.raw[1].type === 'rate', 'Second event is rate restore at t=0.05');
  ok(el.raw[0].snapshot !== null, 'Bolus event has snapshot');
  ok(el.raw[1].snapshot !== null, 'Rate-restore event has snapshot');
}

{
  // Concentrations at t=0 with bolus at t=0
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  // At t=0 exactly — the bolus event is at t=0, its snapshot is POST-bolus (after 0.05 min delivery)
  const c0 = el.getConcentrationsAt('propofol', 0);
  ok(c0.Cp > 0, `getConcentrationsAt(0) with bolus at t=0: Cp > 0 (${c0.Cp.toFixed(3)})`);
  
  // At t=1 — should show decay from the bolus
  const c1 = el.getConcentrationsAt('propofol', 1);
  ok(c1.Cp > 0 && c1.Cp < c0.Cp, 'At t=1, Cp has decayed from post-bolus peak');
  ok(c1.Ce > 0, 'At t=1, Ce is rising toward equilibrium');
}

{
  // Concentrations at t=0 with NO events — should return zeros
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  
  const c = el.getConcentrationsAt('propofol', 0);
  ok(c.Cp === 0 && c.Ce === 0, 'getConcentrationsAt(0) with no events returns zeros');
}

{
  // Rate at t=0 followed by query at t=5
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualRate('propofol', 0, 2.0); // 2 mg/min starting at t=0
  
  // At t=0 itself — rate just programmed, no drug delivered yet
  const c0 = el.getConcentrationsAt('propofol', 0);
  ok(c0.Cp === 0, 'Rate at t=0: Cp=0 at t=0 (pump just started, no drug yet)');
  ok(c0.rate === 2.0, 'Rate at t=0: active rate is 2.0 mg/min');
  
  // At t=5 — should have 5 min of infusion
  const c5 = el.getConcentrationsAt('propofol', 5);
  ok(c5.Cp > 0, `Rate at t=0, query t=5: Cp > 0 (${c5.Cp.toFixed(4)})`);
  
  // Compare with direct engine computation
  const eng = createEngine(REF);
  eng.advance(5, 2.0);
  const cDirect = eng.getConcentrations();
  near(c5.Cp, cDirect.Cp, 1e-6, 'Event-system Cp matches direct engine Cp at t=5');
  near(c5.Ce, cDirect.Ce, 1e-6, 'Event-system Ce matches direct engine Ce at t=5');
}

{
  // Bolus at t=0 followed by rate at t=0 (simultaneous)
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  // addManualBolus already adds a rate-restore at t=0.05. Now add a real rate:
  el.addManualRate('propofol', 0.05, 5.0); // start infusion right after bolus
  
  const c10 = el.getConcentrationsAt('propofol', 10);
  ok(c10.Cp > 0, 'Bolus+Rate at t=0: concentrations exist at t=10');
  ok(c10.rate === 5.0, 'Active rate at t=10 is 5.0 mg/min');
  
  // Verify against direct engine
  const eng = createEngine(REF);
  eng.advance(0.05, 100/0.05); // bolus
  eng.advance(9.95, 5.0);       // infusion for remaining time
  near(c10.Cp, eng.getConcentrations().Cp, 0.01, 'Bolus+Rate matches direct engine at t=10');
}

// ===== GROUP 5: Matrix Exponential Edge Cases =====
console.log('\n===== 5. Matrix Exponential Edge Cases =====\n');

// The engine's matrix exponential is validated end-to-end at 0.0000% vs the
// analytical eigenvalue solution in test-vs-simtiva. Here we pin two low-level
// properties using only the engine's public getSystemMatrix + advance (the
// primitive itself is internal, so we probe it through observable behavior).
{
  // expm(A·0)·x = x — advancing a known non-zero state by dt=0 is exact identity.
  const eng = createEngine(REF);
  eng.setState(new Float64Array([10, 5, 2, 1]));
  const before = eng.getState();
  eng.advance(0, 0);
  const after = eng.getState();
  let maxDiff = 0;
  for (let i = 0; i < 4; i++) maxDiff = Math.max(maxDiff, Math.abs(after[i] - before[i]));
  ok(maxDiff === 0, `advance(0) is exact identity on state (max diff ${maxDiff})`);
}

{
  // expm(A·ε)·x ≈ x + A·x·ε for tiny ε (leading linear term). A comes from the
  // engine's own getSystemMatrix; the 4×4 mat-vec is the independent reference.
  const eng = createEngine(REF);
  const x0 = new Float64Array([10, 5, 2, 1]);
  eng.setState(x0);
  const A = eng.getSystemMatrix();
  const eps = 1e-8;
  eng.advance(eps, 0); // homogeneous (rate 0) evolution of the state
  const x1 = eng.getState();
  let maxRelDiff = 0;
  for (let i = 0; i < 4; i++) {
    let Ax = 0;
    for (let j = 0; j < 4; j++) Ax += A[i * 4 + j] * x0[j];
    const expected = x0[i] + Ax * eps;
    const diff = Math.abs(x1[i] - expected);
    const scale = Math.max(Math.abs(expected), 1e-15);
    maxRelDiff = Math.max(maxRelDiff, diff / scale);
  }
  ok(maxRelDiff < 1e-3, `engine advance(ε) ≈ x + A·x·ε for tiny ε (max rel diff ${maxRelDiff.toExponential(2)})`);
}

// ===== GROUP 6: Continuity at Bolus Delivery Boundary =====
console.log('\n===== 6. Continuity Across Bolus Delivery =====\n');

{
  // The bolus is delivered over 0.05 min. Verify that querying at t=0.05
  // (end of delivery) and t=0.06 (just after) shows smooth continuation.
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  el.addManualBolus('propofol', 0, 100);
  
  const c_at = el.getConcentrationsAt('propofol', 0.05);
  const c_after = el.getConcentrationsAt('propofol', 0.06);
  
  // Cp should be decreasing after bolus (redistribution)
  ok(c_after.Cp < c_at.Cp || Math.abs(c_after.Cp - c_at.Cp) < 0.01,
    'Cp is continuous/decreasing across bolus delivery boundary');
  ok(c_after.Ce >= c_at.Ce || Math.abs(c_after.Ce - c_at.Ce) < 0.001,
    'Ce is continuous/rising across bolus delivery boundary');
}

{
  // Verify total delivered drug is correct
  // 100mg bolus: at t=0.05 (end of delivery), sum of amounts should ≈ 100mg
  const eng = createEngine(REF);
  eng.advance(0.05, 100/0.05);
  const s = eng.getState();
  const total = s[0] + s[1] + s[2]; // A1+A2+A3 (not Ce — it's concentration)
  // Some drug eliminated during 3s delivery, so slightly < 100
  const eliminated = 100 - total;
  ok(eliminated >= 0 && eliminated < 1.0,
    `Bolus conservation: ${total.toFixed(3)} mg in compartments, ${eliminated.toFixed(4)} mg eliminated during delivery`);
}

// ===== GROUP 7: Multiple Drugs at t=0 =====
console.log('\n===== 7. Multi-Drug at t=0 =====\n');

{
  const el = createEventList();
  el.registerEngine('propofol', createEngine(REF));
  // Fentanyl with different PK params (just for isolation test)
  el.registerEngine('fentanyl', createEngine({V1:10, V2:30, V3:200, CL:1.0, Q2:1.5, Q3:0.8, ke0:0.1}));
  
  el.addManualBolus('propofol', 0, 100);
  el.addManualBolus('fentanyl', 0, 0.1); // 100 mcg = 0.1 mg
  
  const cp = el.getConcentrationsAt('propofol', 1);
  const cf = el.getConcentrationsAt('fentanyl', 1);
  
  ok(cp.Cp > 0, 'Propofol has concentrations at t=1 after t=0 bolus');
  ok(cf.Cp > 0, 'Fentanyl has concentrations at t=1 after t=0 bolus');
  
  // Verify isolation: propofol Cp should be much larger (100mg vs 0.1mg)
  ok(cp.Cp > cf.Cp * 10, 'Drug engines are isolated — propofol Cp >> fentanyl Cp');
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
