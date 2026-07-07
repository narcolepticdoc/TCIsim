/**
 * test-unit-safety.js — Unit consistency validation
 *
 * The engine operates entirely in MINUTES:
 *   - CL, Q2, Q3 in L/min
 *   - ke0 in min⁻¹
 *   - dt passed to advance() in minutes
 *   - R (infusion rate) in mg/min
 *
 * SimTIVA uses per-second internally (divides k-values by 60). If someone
 * accidentally passes per-second values to our engine, concentrations decay
 * 60x too fast. This suite:
 *   1. Demonstrates what wrong units look like (so you recognize it)
 *   2. Tests the REAL parameter validator (js/pk/engine.js validateParams)
 *   3. Verifies advance() dt is minutes (seconds-vs-minutes confusion)
 *
 * Imports the REAL engine + validator — the wrong-unit demonstrations pass
 * skipValidation:true so the (intentionally invalid) params don't spam the
 * validator's console warnings; the validator itself is tested directly.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const u = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;

// Reference patient: 35y/70kg/170cm male
const CORRECT = { V1:6.28, V2:25.5, V3:273, CL:1.79, Q2:1.75, Q3:1.11, ke0:0.146 };

// Same patient but with per-SECOND clearances (the SimTIVA mistake)
const PER_SECOND = {
  V1: 6.28, V2: 25.5, V3: 273,
  CL: 1.79/60, Q2: 1.75/60, Q3: 1.11/60, ke0: 0.146/60,
};

let passed=0, failed=0;
function ok(cond,msg){if(cond){passed++;console.log(`  ✓ ${msg}`)}else{failed++;console.error(`  ✗ ${msg}`)}}
function near(a,b,tol,msg){const r=Math.abs(b)>1e-9?Math.abs(a-b)/Math.abs(b):Math.abs(a-b);ok(r<tol,`${msg} (${a.toFixed(4)} vs ${b.toFixed(4)}, ${(r*100).toFixed(1)}%)`)}

(async () => {
  const { createEngine, validateParams } = await import(u('js/pk/engine.js'));
  // Deliberately-invalid params must skip the built-in validator's warnings.
  const badEngine = (p) => createEngine(p, { skipValidation: true });

  // ===== GROUP 1: What wrong units look like =====
  console.log('\n===== 1. Demonstrating Wrong-Unit Failure Mode =====\n');
  {
    const eng = createEngine(CORRECT);
    eng.advance(0.05, 100/0.05);
    eng.advance(4.95, 0);
    const correct = eng.getConcentrations();

    const eng2 = badEngine(PER_SECOND);
    eng2.advance(0.05, 100/0.05);
    eng2.advance(4.95, 0);
    const wrong = eng2.getConcentrations();

    console.log(`  Correct Cp at 5 min: ${correct.Cp.toFixed(4)} µg/mL`);
    console.log(`  Wrong   Cp at 5 min: ${wrong.Cp.toFixed(4)} µg/mL`);
    ok(wrong.Cp > correct.Cp * 5,
      'Per-second params produce grossly wrong Cp (redistribution 60x too slow)');
    ok(Math.abs(wrong.Ce / correct.Ce - 1) > 0.5,
      'Per-second params produce grossly wrong Ce (ke0 60x too slow)');
  }

  {
    // Inverse mistake: per-minute k-values into a per-second system → 60x too large.
    const TOO_FAST = {
      V1: 6.28, V2: 25.5, V3: 273,
      CL: 1.79*60, Q2: 1.75*60, Q3: 1.11*60, ke0: 0.146*60,
    };
    const eng = badEngine(TOO_FAST);
    eng.advance(0.05, 100/0.05);
    eng.advance(4.95, 0);
    const wrong = eng.getConcentrations();

    const eng2 = createEngine(CORRECT);
    eng2.advance(0.05, 100/0.05);
    eng2.advance(4.95, 0);
    const correct = eng2.getConcentrations();

    console.log(`\n  Correct Cp at 5 min:   ${correct.Cp.toFixed(4)} µg/mL`);
    console.log(`  60x-fast Cp at 5 min:  ${wrong.Cp.toFixed(4)} µg/mL`);
    ok(wrong.Cp < correct.Cp * 0.1,
      '60x-too-fast params: drug eliminated almost completely by 5 min');
  }

  // ===== GROUP 2: The REAL parameter validator catches mistakes =====
  console.log('\n===== 2. Parameter Validator (real engine.js validateParams) =====\n');
  {
    const r = validateParams(CORRECT);
    ok(r.valid, 'Correct per-minute params pass validation');
    ok(r.warnings.length === 0, `No warnings (got ${r.warnings.length})`);
  }
  {
    const r = validateParams(PER_SECOND);
    ok(!r.valid, 'Per-second params fail validation');
    ok(r.warnings.length >= 3, `Multiple warnings raised (got ${r.warnings.length})`);
    ok(r.warnings.some(w => w.includes('CL=')), 'CL warning specifically mentions the value');
  }
  {
    const r = validateParams({ V1: 6.28, V2: 25.5, V3: 273, CL: 1.79, Q2: 1.75 });
    ok(!r.valid, 'Missing Q3 and ke0 fails validation');
  }
  {
    const r = validateParams({ ...CORRECT, CL: -1.79 });
    ok(!r.valid, 'Negative CL fails validation');
  }
  {
    const r = validateParams({ ...CORRECT, ke0: NaN });
    ok(!r.valid, 'NaN ke0 fails validation');
  }
  {
    // Neonate-like low CL (0.15 L/min) is above the 0.1 threshold → still valid.
    const neonateish = { ...CORRECT, CL: 0.15, V1: 1.5, V2: 3.0, V3: 20, Q2: 0.3, Q3: 0.15, ke0: 0.146 };
    const r = validateParams(neonateish);
    ok(r.valid, 'Neonate-like low CL (0.15 L/min) still passes validation');
  }

  // ===== GROUP 3: dt unit confusion (seconds vs minutes) =====
  console.log('\n===== 3. Time Step Unit Confusion =====\n');
  {
    const eng1 = createEngine(CORRECT);
    eng1.advance(5, 2.0); // 5 minutes, 2 mg/min = correct
    const correct = eng1.getConcentrations();

    const eng2 = createEngine(CORRECT);
    eng2.advance(300, 2.0); // 300 minutes = WRONG (they meant 300 seconds)
    const wrong = eng2.getConcentrations();

    console.log(`  5 min infusion:   Cp = ${correct.Cp.toFixed(4)} µg/mL`);
    console.log(`  300 min infusion: Cp = ${wrong.Cp.toFixed(4)} µg/mL`);
    ok(wrong.Cp > correct.Cp * 1.3,
      'Passing seconds as dt produces clearly different (higher) Cp');
  }
  {
    const tenSecInMin = 10 / 60;
    const eng = createEngine(CORRECT);
    eng.advance(tenSecInMin, 2.0);
    const c = eng.getConcentrations();
    ok(c.Cp > 0 && c.Cp < 0.1,
      `10-second advance (${tenSecInMin.toFixed(4)} min): Cp=${c.Cp.toFixed(6)} (small, as expected)`);
  }

  // ===== GROUP 4: engine from CL/Q matches engine from k-derived params =====
  console.log('\n===== 4. CL/Q vs k-value Equivalence =====\n');
  {
    const p = CORRECT;
    const k10 = p.CL / p.V1, k12 = p.Q2 / p.V1, k21 = p.Q2 / p.V2, k13 = p.Q3 / p.V1, k31 = p.Q3 / p.V3;
    const reconstructed = {
      V1: p.V1, V2: p.V2, V3: p.V3,
      CL: k10 * p.V1, Q2: k12 * p.V1, Q3: k13 * p.V1, ke0: p.ke0,
    };
    near(k21, reconstructed.Q2 / p.V2, 1e-10, 'k21 = Q2/V2 round-trips exactly');
    near(k31, reconstructed.Q3 / p.V3, 1e-10, 'k31 = Q3/V3 round-trips exactly');

    const eng1 = createEngine(p);
    eng1.advance(0.05, 100/0.05); eng1.advance(9.95, 2.0);
    const c1 = eng1.getConcentrations();

    const eng2 = createEngine(reconstructed);
    eng2.advance(0.05, 100/0.05); eng2.advance(9.95, 2.0);
    const c2 = eng2.getConcentrations();

    near(c1.Cp, c2.Cp, 1e-12, 'CL/Q params and k-derived params give identical Cp');
    near(c1.Ce, c2.Ce, 1e-12, 'CL/Q params and k-derived params give identical Ce');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
