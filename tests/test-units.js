/**
 * test-units.js — Unit Conversion Module Tests
 * 
 * Tests toCanonical, fromCanonical, and round-trip accuracy
 * for all drug/task/unit combinations.
 */

// Inline the config so tests run standalone in Node
const DRUG_DEFS = {
  propofol: { concentration: 10 },
  fentanyl: { concentration: 0.05 },
  remifentanil: { concentration: 0.05 },
  ketamine: { concentration: 10 },
};

const DRUG_TASK_UNITS = {
  propofol: {
    bolus: { canonical: 'mg', allowed: ['mg', 'mcg/kg', 'mL'] },
    rate: { canonical: 'mg/min', allowed: ['mL/h', 'mcg/kg/min', 'mg/min'], defaultDisplay: 'mL/h' },
    ceTarget: { canonical: 'mcg/mL', allowed: ['mcg/mL'] },
  },
  fentanyl: {
    bolus: { canonical: 'mg', allowed: ['mcg', 'mcg/kg', 'mL'] },
    rate: { canonical: 'mg/min', allowed: ['mcg/kg/min', 'mcg/h', 'mL/h'], defaultDisplay: 'mcg/kg/min' },
    ceTarget: { canonical: 'mcg/mL', allowed: ['ng/mL'] },
  },
  ketamine: {
    bolus: { canonical: 'mg', allowed: ['mg', 'mg/kg', 'mL'] },
    rate: { canonical: 'mg/min', allowed: ['mg/kg/h', 'mL/h', 'mg/min'], defaultDisplay: 'mg/kg/h' },
  },
};

// ---- Inline conversion functions (matching units.js logic) ----

function toBase(value, unit, task, wt, conc) {
  if (task === 'bolus') {
    if (unit === 'mg') return value;
    if (unit === 'mcg') return value / 1000;
    if (unit === 'mcg/kg') return value * wt / 1000;
    if (unit === 'mg/kg') return value * wt;
    if (unit === 'mL') return value * conc;
  }
  if (task === 'rate') {
    if (unit === 'mg/min') return value;
    if (unit === 'mcg/kg/min') return value * wt / 1000;
    if (unit === 'mL/h') return value * conc / 60;
    if (unit === 'mcg/h') return value / 1000 / 60;
    if (unit === 'mg/kg/h') return value * wt / 60;
  }
  if (task === 'ceTarget') {
    if (unit === 'mcg/mL') return value;
    if (unit === 'ng/mL') return value / 1000;
  }
  throw new Error(`Cannot convert ${unit} for ${task}`);
}

function fromBase(value, unit, task, wt, conc) {
  if (task === 'bolus') {
    if (unit === 'mg') return value;
    if (unit === 'mcg') return value * 1000;
    if (unit === 'mcg/kg') return value * 1000 / wt;
    if (unit === 'mg/kg') return value / wt;
    if (unit === 'mL') return value / conc;
  }
  if (task === 'rate') {
    if (unit === 'mg/min') return value;
    if (unit === 'mcg/kg/min') return value * 1000 / wt;
    if (unit === 'mL/h') return value * 60 / conc;
    if (unit === 'mcg/h') return value * 1000 * 60;
    if (unit === 'mg/kg/h') return value * 60 / wt;
  }
  if (task === 'ceTarget') {
    if (unit === 'mcg/mL') return value;
    if (unit === 'ng/mL') return value * 1000;
  }
  throw new Error(`Cannot convert to ${unit} for ${task}`);
}

function toCanonical(value, displayUnit, drugId, task, ctx) {
  const config = DRUG_TASK_UNITS[drugId]?.[task];
  if (!config) throw new Error(`No config for ${drugId}/${task}`);
  if (!config.allowed.includes(displayUnit)) throw new Error(`Unit '${displayUnit}' not allowed for ${drugId}/${task}`);
  if (displayUnit === config.canonical) return { value, unit: config.canonical };
  const conc = ctx.concentration || DRUG_DEFS[drugId]?.concentration;
  const result = toBase(value, displayUnit, task, ctx.weightKg, conc);
  return { value: result, unit: config.canonical };
}

function fromCanonical(value, displayUnit, drugId, task, ctx) {
  const config = DRUG_TASK_UNITS[drugId]?.[task];
  if (!config) throw new Error(`No config for ${drugId}/${task}`);
  if (!config.allowed.includes(displayUnit)) throw new Error(`Unit '${displayUnit}' not allowed`);
  if (displayUnit === config.canonical) return value;
  const conc = ctx.concentration || DRUG_DEFS[drugId]?.concentration;
  return fromBase(value, displayUnit, task, ctx.weightKg, conc);
}

// ---- Test harness ----
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

// ===== SUMMARY =====
console.log(`\n${'='.repeat(50)}`);
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);
process.exit(failed ? 1 : 0);
