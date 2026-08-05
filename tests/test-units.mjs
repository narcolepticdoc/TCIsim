/**
 * test-units.js — Unit Conversion Module Tests
 * 
 * Tests toCanonical, fromCanonical, and round-trip accuracy
 * for all drug/task/unit combinations.
 */

// Inline the config so tests run standalone in Node

import { toCanonical, fromCanonical, getQuantStep, quantizeInDisplay } from '../js/util/units.js';
// Real DRUG_DEFS / DRUG_TASK_UNITS come in via units.js → constants.js; the
// inline config tables and toBase/fromBase internals were removed.

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function near(a, b, tol, m) { ok(Math.abs(a - b) < tol, `${m} (${a} ≈ ${b})`); }
function throws(fn, m) { try { fn(); failed++; console.error(`  ✗ ${m} (did not throw)`); } catch(e) { passed++; console.log(`  ✓ ${m}`); } }

// ============ TESTS ============

console.log('\n===== Propofol Bolus =====\n');

{
  const ctx = { weightKg: 70 };

  // mg is canonical — passthrough
  const r1 = toCanonical(100, 'mg', 'propofol', 'bolus', ctx);
  ok(r1.value === 100 && r1.unit === 'mg', 'mg passthrough');

  // mcg/kg → mg: 1500 mcg/kg × 70 kg = 105000 mcg = 105 mg
  const r2 = toCanonical(1500, 'mcg/kg', 'propofol', 'bolus', ctx);
  near(r2.value, 105, 0.01, 'mcg/kg → mg');

  // mL → mg: 8 mL × 10 mg/mL = 80 mg
  const r3 = toCanonical(8, 'mL', 'propofol', 'bolus', ctx);
  ok(r3.value === 80, 'mL → mg');

  // Round-trip: mcg/kg
  const back = fromCanonical(105, 'mcg/kg', 'propofol', 'bolus', ctx);
  near(back, 1500, 0.01, 'mg → mcg/kg round-trip');

  // Round-trip: mL
  const back2 = fromCanonical(80, 'mL', 'propofol', 'bolus', ctx);
  ok(back2 === 8, 'mg → mL round-trip');
}

console.log('\n===== Propofol Rate =====\n');

{
  const ctx = { weightKg: 70 };

  // mL/h → mg/min: 60 mL/h × 10 mg/mL / 60 = 10 mg/min
  const r1 = toCanonical(60, 'mL/h', 'propofol', 'rate', ctx);
  ok(r1.value === 10, 'mL/h → mg/min');

  // mcg/kg/min → mg/min: 100 mcg/kg/min × 70 kg / 1000 = 7 mg/min
  const r2 = toCanonical(100, 'mcg/kg/min', 'propofol', 'rate', ctx);
  near(r2.value, 7, 0.001, 'mcg/kg/min → mg/min');

  // mg/min passthrough
  const r3 = toCanonical(5, 'mg/min', 'propofol', 'rate', ctx);
  ok(r3.value === 5 && r3.unit === 'mg/min', 'mg/min passthrough');

  // Round-trip: mL/h
  const back = fromCanonical(10, 'mL/h', 'propofol', 'rate', ctx);
  ok(back === 60, 'mg/min → mL/h round-trip');

  // Round-trip: mcg/kg/min
  const back2 = fromCanonical(7, 'mcg/kg/min', 'propofol', 'rate', ctx);
  near(back2, 100, 0.01, 'mg/min → mcg/kg/min round-trip');

  // Clinical example: propofol 6 mL/h for a 70kg patient
  const r4 = toCanonical(6, 'mL/h', 'propofol', 'rate', ctx);
  near(r4.value, 1.0, 0.001, '6 mL/h = 1.0 mg/min');
  const asUgKgMin = fromCanonical(r4.value, 'mcg/kg/min', 'propofol', 'rate', ctx);
  near(asUgKgMin, 14.29, 0.1, '1.0 mg/min = 14.3 mcg/kg/min for 70kg');
}

console.log('\n===== Propofol Ce Target =====\n');

{
  const ctx = { weightKg: 70 };
  const r1 = toCanonical(3.0, 'mcg/mL', 'propofol', 'ceTarget', ctx);
  ok(r1.value === 3.0 && r1.unit === 'mcg/mL', 'mcg/mL passthrough');
}

console.log('\n===== Fentanyl Bolus =====\n');

{
  const ctx = { weightKg: 70 };

  // mcg → mg: 100 mcg = 0.1 mg
  const r1 = toCanonical(100, 'mcg', 'fentanyl', 'bolus', ctx);
  near(r1.value, 0.1, 0.0001, 'mcg → mg');

  // mcg/kg → mg: 2 mcg/kg × 70 = 140 mcg = 0.14 mg
  const r2 = toCanonical(2, 'mcg/kg', 'fentanyl', 'bolus', ctx);
  near(r2.value, 0.14, 0.0001, 'mcg/kg → mg');

  // mL → mg: 2 mL × 0.05 mg/mL = 0.1 mg
  const r3 = toCanonical(2, 'mL', 'fentanyl', 'bolus', ctx);
  near(r3.value, 0.1, 0.0001, 'mL → mg');

  // Round-trip: mcg
  const back = fromCanonical(0.1, 'mcg', 'fentanyl', 'bolus', ctx);
  near(back, 100, 0.01, 'mg → mcg round-trip');

  // Round-trip: mL
  const back2 = fromCanonical(0.1, 'mL', 'fentanyl', 'bolus', ctx);
  near(back2, 2, 0.01, 'mg → mL round-trip');
}

console.log('\n===== Fentanyl Rate =====\n');

{
  const ctx = { weightKg: 70 };

  // mcg/kg/min → mg/min: 0.05 mcg/kg/min × 70 / 1000 = 0.0035 mg/min
  const r1 = toCanonical(0.05, 'mcg/kg/min', 'fentanyl', 'rate', ctx);
  near(r1.value, 0.0035, 0.00001, 'mcg/kg/min → mg/min');

  // mcg/h → mg/min: 100 mcg/h / 1000 / 60 = 0.001667 mg/min
  const r2 = toCanonical(100, 'mcg/h', 'fentanyl', 'rate', ctx);
  near(r2.value, 0.001667, 0.0001, 'mcg/h → mg/min');

  // mL/h → mg/min: 4 mL/h × 0.05 mg/mL / 60 = 0.003333 mg/min
  const r3 = toCanonical(4, 'mL/h', 'fentanyl', 'rate', ctx);
  near(r3.value, 0.003333, 0.0001, 'mL/h → mg/min');

  // Round-trip: mcg/kg/min
  const back = fromCanonical(0.0035, 'mcg/kg/min', 'fentanyl', 'rate', ctx);
  near(back, 0.05, 0.001, 'mg/min → mcg/kg/min round-trip');
}

console.log('\n===== Fentanyl Ce Target =====\n');

{
  const ctx = { weightKg: 70 };

  // ng/mL → mcg/mL: 3 ng/mL = 0.003 mcg/mL
  const r1 = toCanonical(3, 'ng/mL', 'fentanyl', 'ceTarget', ctx);
  near(r1.value, 0.003, 0.00001, 'ng/mL → mcg/mL');

  // Round-trip
  const back = fromCanonical(0.003, 'ng/mL', 'fentanyl', 'ceTarget', ctx);
  near(back, 3, 0.001, 'mcg/mL → ng/mL round-trip');
}

console.log('\n===== Ketamine Bolus =====\n');

{
  const ctx = { weightKg: 70 };

  // mg passthrough
  const r1 = toCanonical(100, 'mg', 'ketamine', 'bolus', ctx);
  ok(r1.value === 100, 'mg passthrough');

  // mg/kg → mg: 1.5 mg/kg × 70 = 105 mg
  const r2 = toCanonical(1.5, 'mg/kg', 'ketamine', 'bolus', ctx);
  near(r2.value, 105, 0.01, 'mg/kg → mg');

  // mL → mg: 10 mL × 10 mg/mL = 100 mg
  const r3 = toCanonical(10, 'mL', 'ketamine', 'bolus', ctx);
  ok(r3.value === 100, 'mL → mg');

  // Round-trip
  const back = fromCanonical(105, 'mg/kg', 'ketamine', 'bolus', ctx);
  near(back, 1.5, 0.001, 'mg → mg/kg round-trip');
}

console.log('\n===== Ketamine Rate =====\n');

{
  const ctx = { weightKg: 70 };

  // mg/kg/h → mg/min: 0.5 mg/kg/h × 70 / 60 = 0.5833 mg/min
  const r1 = toCanonical(0.5, 'mg/kg/h', 'ketamine', 'rate', ctx);
  near(r1.value, 0.5833, 0.01, 'mg/kg/h → mg/min');

  // Round-trip
  const back = fromCanonical(0.5833, 'mg/kg/h', 'ketamine', 'rate', ctx);
  near(back, 0.5, 0.01, 'mg/min → mg/kg/h round-trip');
}

console.log('\n===== Weight Sensitivity =====\n');

{
  // Same mcg/kg dose, different weights → different mg
  const light = { weightKg: 50 };
  const heavy = { weightKg: 100 };

  const r1 = toCanonical(2, 'mcg/kg', 'propofol', 'bolus', light);
  const r2 = toCanonical(2, 'mcg/kg', 'propofol', 'bolus', heavy);
  near(r1.value, 0.1, 0.001, '2 mcg/kg × 50 kg = 0.1 mg');
  near(r2.value, 0.2, 0.001, '2 mcg/kg × 100 kg = 0.2 mg');
  ok(r2.value === 2 * r1.value, 'Double weight = double mg');
}

console.log('\n===== Zero Handling =====\n');

{
  const ctx = { weightKg: 70 };
  const r = toCanonical(0, 'mL/h', 'propofol', 'rate', ctx);
  ok(r.value === 0, 'Zero rate converts to zero');

  const r2 = toCanonical(0, 'mcg/kg', 'propofol', 'bolus', ctx);
  ok(r2.value === 0, 'Zero bolus converts to zero');
}

console.log('\n===== Error Cases =====\n');

{
  const ctx = { weightKg: 70 };
  throws(() => toCanonical(100, 'furlongs', 'propofol', 'bolus', ctx), 'Invalid unit throws');
  throws(() => toCanonical(100, 'mg', 'plutonium', 'bolus', ctx), 'Invalid drug throws');
  throws(() => toCanonical(100, 'mg', 'propofol', 'teleport', ctx), 'Invalid task throws');
}

console.log('\n===== Round-Trip Accuracy (All Combinations) =====\n');

{
  const ctx = { weightKg: 75 };
  const cases = [
    // drug, task, displayValue, displayUnit
    ['propofol', 'rate', 6, 'mL/h'],
    ['propofol', 'rate', 100, 'mcg/kg/min'],
    ['propofol', 'rate', 2.5, 'mg/min'],
    ['propofol', 'bolus', 1500, 'mcg/kg'],
    ['propofol', 'bolus', 200, 'mg'],
    ['propofol', 'bolus', 15, 'mL'],
    ['propofol', 'ceTarget', 3.0, 'mcg/mL'],
    ['fentanyl', 'bolus', 100, 'mcg'],
    ['fentanyl', 'bolus', 2, 'mcg/kg'],
    ['fentanyl', 'bolus', 2, 'mL'],
    ['fentanyl', 'rate', 0.05, 'mcg/kg/min'],
    ['fentanyl', 'rate', 100, 'mcg/h'],
    ['fentanyl', 'rate', 4, 'mL/h'],
    ['fentanyl', 'ceTarget', 3, 'ng/mL'],
    ['ketamine', 'bolus', 100, 'mg'],
    ['ketamine', 'bolus', 1.5, 'mg/kg'],
    ['ketamine', 'bolus', 10, 'mL'],
    ['ketamine', 'rate', 0.5, 'mg/kg/h'],
    ['ketamine', 'rate', 30, 'mL/h'],
    ['ketamine', 'rate', 5, 'mg/min'],
  ];

  let allPass = true;
  for (const [drug, task, val, unit] of cases) {
    const canonical = toCanonical(val, unit, drug, task, ctx);
    const back = fromCanonical(canonical.value, unit, drug, task, ctx);
    const err = val === 0 ? 0 : Math.abs(back - val) / Math.abs(val);
    if (err > 0.0001) {
      console.error(`  ✗ Round-trip ${drug} ${task} ${val} ${unit}: got ${back}, error ${(err*100).toFixed(4)}%`);
      failed++;
      allPass = false;
    }
  }
  if (allPass) {
    passed++;
    console.log(`  ✓ All ${cases.length} round-trip conversions pass (<0.01% error)`);
  }
}

console.log('\n===== Quantization In Display Units =====\n');

{
  const ctx = { weightKg: 70 };
  const TOL = 1e-9;

  // ---- Helper: assert canonical value, when converted to display unit, is on grid ----
  function onGrid(canonical, unit, drug, task, step) {
    const disp = fromCanonical(canonical, unit, drug, task, ctx);
    const k = Math.round(disp / step);
    return Math.abs(disp - k * step) < TOL;
  }

  // --- Propofol rate: mL/h step = 1 ---
  {
    // 9.67 mg/min = 58.02 mL/h — should snap to 58 mL/h = 9.6667 mg/min
    const q = quantizeInDisplay(9.67, 'mL/h', 'propofol', 'rate', ctx);
    ok(onGrid(q, 'mL/h', 'propofol', 'rate', 1), 'propofol 9.67 mg/min → integer mL/h');
    near(fromCanonical(q, 'mL/h', 'propofol', 'rate', ctx), 58, 1e-9, '9.67 mg/min snaps to 58 mL/h');
  }

  // --- Propofol rate: mcg/kg/min step = 5 ---
  {
    // 7 mg/min = 100 mcg/kg/min for 70kg — already on grid (multiple of 5)
    const q = quantizeInDisplay(7, 'mcg/kg/min', 'propofol', 'rate', ctx);
    ok(onGrid(q, 'mcg/kg/min', 'propofol', 'rate', 5), 'propofol 100 mcg/kg/min already on grid');
    // 138.1 mcg/kg/min should snap to 140 mcg/kg/min
    const canonical138 = toCanonical(138.1, 'mcg/kg/min', 'propofol', 'rate', ctx).value;
    const q2 = quantizeInDisplay(canonical138, 'mcg/kg/min', 'propofol', 'rate', ctx);
    near(fromCanonical(q2, 'mcg/kg/min', 'propofol', 'rate', ctx), 140, 1e-9,
         '138.1 mcg/kg/min snaps to 140 mcg/kg/min');
  }

  // --- Propofol bolus: mcg/kg step = 10 ---
  {
    // 148 mg = 2114.3 mcg/kg → should snap to 2110 mcg/kg
    const q = quantizeInDisplay(148, 'mcg/kg', 'propofol', 'bolus', ctx);
    ok(onGrid(q, 'mcg/kg', 'propofol', 'bolus', 10), 'propofol 148 mg snaps to mcg/kg grid');
    near(fromCanonical(q, 'mcg/kg', 'propofol', 'bolus', ctx), 2110, 1e-9,
         '148 mg = 2114.3 mcg/kg → 2110 mcg/kg (nearest 10)');
  }

  // --- Propofol bolus: mL step = 0.1 ---
  {
    // 14.87 mg = 1.487 mL → snaps to 1.5 mL
    const q = quantizeInDisplay(14.87, 'mL', 'propofol', 'bolus', ctx);
    near(fromCanonical(q, 'mL', 'propofol', 'bolus', ctx), 1.5, 1e-9,
         '14.87 mg → 1.5 mL (nearest 0.1)');
  }

  // --- Propofol rate: mg/min step = 0.1 (canonical-unit grid) ---
  {
    const q = quantizeInDisplay(9.67, 'mg/min', 'propofol', 'rate', ctx);
    near(q, 9.7, 1e-9, '9.67 mg/min → 9.7 mg/min (nearest 0.1)');
  }

  // --- Fentanyl bolus: mcg step = 5 ---
  {
    // 0.137 mg = 137 mcg → 135 mcg (nearest 5)
    const q = quantizeInDisplay(0.137, 'mcg', 'fentanyl', 'bolus', ctx);
    near(fromCanonical(q, 'mcg', 'fentanyl', 'bolus', ctx), 135, 1e-9,
         'fentanyl 137 mcg → 135 mcg (nearest 5)');
  }

  // --- Fentanyl rate: mcg/kg/min step = 0.01 ---
  {
    // 0.003456 mg/min = 0.04937 mcg/kg/min for 70kg → 0.05 mcg/kg/min
    const q = quantizeInDisplay(0.003456, 'mcg/kg/min', 'fentanyl', 'rate', ctx);
    near(fromCanonical(q, 'mcg/kg/min', 'fentanyl', 'rate', ctx), 0.05, 1e-9,
         'fentanyl 0.04937 mcg/kg/min → 0.05 (nearest 0.01)');
  }

  // --- Ketamine bolus: mg/kg step = 0.1 ---
  {
    // 117 mg = 1.6714 mg/kg for 70kg → 1.7 mg/kg
    const q = quantizeInDisplay(117, 'mg/kg', 'ketamine', 'bolus', ctx);
    near(fromCanonical(q, 'mg/kg', 'ketamine', 'bolus', ctx), 1.7, 1e-9,
         'ketamine 117 mg → 1.7 mg/kg (nearest 0.1)');
  }

  // --- Ketamine rate: mg/kg/h step = 0.1 ---
  {
    // 0.4667 mg/min = 0.4 mg/kg/h for 70kg — already on grid
    const q = quantizeInDisplay(0.4667, 'mg/kg/h', 'ketamine', 'rate', ctx);
    near(fromCanonical(q, 'mg/kg/h', 'ketamine', 'rate', ctx), 0.4, 1e-9,
         'ketamine 0.4667 mg/min → 0.4 mg/kg/h');
  }

  // --- No quantStep (fallback) ---
  {
    // A unit with no entry in the task's quantSteps table passes through
    // untouched. (ceTarget gained steps in 0.6 for planning-mode titration,
    // so it is no longer the step-less case.)
    const q = quantizeInDisplay(3.14159, 'mL/h', 'propofol', 'ceTarget', ctx);
    near(q, 3.14159, 1e-12, 'No quantStep returns value unchanged');
  }

  // --- Zero passes through cleanly ---
  {
    const q = quantizeInDisplay(0, 'mL/h', 'propofol', 'rate', ctx);
    ok(q === 0, 'Zero quantizes to zero');
  }

  // --- Non-finite input passes through ---
  {
    const q = quantizeInDisplay(NaN, 'mL/h', 'propofol', 'rate', ctx);
    ok(Number.isNaN(q), 'NaN passes through');
  }

  // --- Idempotence: quantize(quantize(x)) === quantize(x) ---
  {
    const q1 = quantizeInDisplay(58.7 * 10 / 60, 'mL/h', 'propofol', 'rate', ctx);
    const q2 = quantizeInDisplay(q1, 'mL/h', 'propofol', 'rate', ctx);
    near(q1, q2, 1e-12, 'Quantize is idempotent');
  }

  // --- Grid snap is round-to-nearest (not floor) ---
  {
    // 0.55 mL/h should round to 1 mL/h (>=0.5), 0.45 should round to 0
    const q1canonical = toCanonical(0.55, 'mL/h', 'propofol', 'rate', ctx).value;
    const q1 = quantizeInDisplay(q1canonical, 'mL/h', 'propofol', 'rate', ctx);
    near(fromCanonical(q1, 'mL/h', 'propofol', 'rate', ctx), 1, 1e-9, '0.55 mL/h rounds up to 1');

    const q2canonical = toCanonical(0.45, 'mL/h', 'propofol', 'rate', ctx).value;
    const q2 = quantizeInDisplay(q2canonical, 'mL/h', 'propofol', 'rate', ctx);
    near(fromCanonical(q2, 'mL/h', 'propofol', 'rate', ctx), 0, 1e-9, '0.45 mL/h rounds down to 0');
  }

  // --- getQuantStep lookup ---
  {
    ok(getQuantStep('propofol', 'rate', 'mL/h') === 1, 'propofol rate mL/h step = 1');
    ok(getQuantStep('propofol', 'bolus', 'mcg/kg') === 10, 'propofol bolus mcg/kg step = 10');
    ok(getQuantStep('fentanyl', 'rate', 'mcg/kg/min') === 0.01, 'fentanyl rate mcg/kg/min step = 0.01');
    ok(getQuantStep('ketamine', 'bolus', 'mg/kg') === 0.1, 'ketamine bolus mg/kg step = 0.1');
    // Ce steps drive planning-mode titration (± buttons and drag precision).
    // They are per-drug on purpose: ng/mL spans fentanyl's sub-1 range and
    // ketamine's hundreds, so one step could not serve both.
    ok(getQuantStep('propofol', 'ceTarget', 'mcg/mL') === 0.1, 'propofol ceTarget step = 0.1 mcg/mL');
    ok(getQuantStep('fentanyl', 'ceTarget', 'ng/mL') === 0.05, 'fentanyl ceTarget step = 0.05 ng/mL');
    ok(getQuantStep('ketamine', 'ceTarget', 'ng/mL') === 10, 'ketamine ceTarget step = 10 ng/mL');
    ok(getQuantStep('propofol', 'ceTarget', 'mL/h') === null, 'a unit outside the task returns null');
  }

  // --- Weight-dependent quantization: same display-unit grid, different canonical values ---
  {
    const light = { weightKg: 50 };
    const heavy = { weightKg: 100 };
    // 10 mcg/kg step: for 50kg bolus snaps to multiples of 0.5 mg; for 100kg to multiples of 1 mg.
    const q50 = quantizeInDisplay(0.73, 'mcg/kg', 'propofol', 'bolus', light);
    const q100 = quantizeInDisplay(0.73, 'mcg/kg', 'propofol', 'bolus', heavy);
    near(fromCanonical(q50, 'mcg/kg', 'propofol', 'bolus', light), 10, 1e-9,
         '50kg: 0.73 mg = 14.6 mcg/kg → 10 mcg/kg');
    near(fromCanonical(q100, 'mcg/kg', 'propofol', 'bolus', heavy), 10, 1e-9,
         '100kg: 0.73 mg = 7.3 mcg/kg → 10 mcg/kg');
  }
}

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
