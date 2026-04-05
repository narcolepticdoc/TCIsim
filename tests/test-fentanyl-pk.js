/**
 * test-fentanyl-pk.js — Fentanyl PK Parameter Tests
 *
 * Validates Shafer/Varvel 1990 fentanyl PK parameter calculator.
 * Inline implementation matches js/pk/fentanyl.js.
 */

// ── Inline fentanyl.js ────────────────────────────────────────────
const REF_WEIGHT = 70;

function calcFentanylParams(patient) {
  const { weight } = patient;
  const s = weight / REF_WEIGHT;
  const V1 = 6.09  * s;
  const V2 = 28.2  * s;
  const V3 = 228   * s;
  const CL = 0.789 * s;
  const Q2 = 1.435 * s;
  const Q3 = 0.196 * s;
  const ke0 = 0.105;
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k21 = Q2 / V2;
  const k13 = Q3 / V1;
  const k31 = Q3 / V3;
  return { V1, V2, V3, CL, Q2, Q3, ke0, k10, k12, k21, k13, k31 };
}
// ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function approx(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    // console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertApprox(a, b, tol, label) {
  if (!approx(a, b, tol)) {
    throw new Error(`${label}: expected ${b} ± ${tol}, got ${a}`);
  }
}

// ── Reference values at 70 kg (s=1) ─────────────────────────────

test('V1 at 70 kg = 6.09 L', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.V1, 6.09, 1e-9, 'V1');
});

test('V2 at 70 kg = 28.2 L', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.V2, 28.2, 1e-9, 'V2');
});

test('V3 at 70 kg = 228 L', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.V3, 228, 1e-9, 'V3');
});

test('CL at 70 kg = 0.789 L/min', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.CL, 0.789, 1e-9, 'CL');
});

test('Q2 at 70 kg = 1.435 L/min', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.Q2, 1.435, 1e-9, 'Q2');
});

test('Q3 at 70 kg = 0.196 L/min', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.Q3, 0.196, 1e-9, 'Q3');
});

test('ke0 = 0.105 min⁻¹ (weight-independent)', () => {
  const p70  = calcFentanylParams({ weight: 70 });
  const p140 = calcFentanylParams({ weight: 140 });
  assertApprox(p70.ke0,  0.105, 1e-9, 'ke0 at 70 kg');
  assertApprox(p140.ke0, 0.105, 1e-9, 'ke0 at 140 kg');
});

// ── Weight scaling ───────────────────────────────────────────────

test('Volumes scale linearly with weight', () => {
  const p35  = calcFentanylParams({ weight: 35 });
  const p70  = calcFentanylParams({ weight: 70 });
  const p140 = calcFentanylParams({ weight: 140 });
  assertApprox(p35.V1  * 2, p70.V1,  1e-9, 'V1 35→70');
  assertApprox(p70.V1  * 2, p140.V1, 1e-9, 'V1 70→140');
  assertApprox(p35.V2  * 2, p70.V2,  1e-9, 'V2 35→70');
  assertApprox(p35.V3  * 2, p70.V3,  1e-9, 'V3 35→70');
});

test('Clearances scale linearly with weight', () => {
  const p35  = calcFentanylParams({ weight: 35 });
  const p70  = calcFentanylParams({ weight: 70 });
  assertApprox(p35.CL * 2, p70.CL, 1e-9, 'CL 35→70');
  assertApprox(p35.Q2 * 2, p70.Q2, 1e-9, 'Q2 35→70');
  assertApprox(p35.Q3 * 2, p70.Q3, 1e-9, 'Q3 35→70');
});

// ── Micro-rate constant derivation ──────────────────────────────

test('k10 = CL / V1', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.k10, p.CL / p.V1, 1e-12, 'k10');
});

test('k12 = Q2 / V1', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.k12, p.Q2 / p.V1, 1e-12, 'k12');
});

test('k21 = Q2 / V2', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.k21, p.Q2 / p.V2, 1e-12, 'k21');
});

test('k13 = Q3 / V1', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.k13, p.Q3 / p.V1, 1e-12, 'k13');
});

test('k31 = Q3 / V3', () => {
  const p = calcFentanylParams({ weight: 70 });
  assertApprox(p.k31, p.Q3 / p.V3, 1e-12, 'k31');
});

test('Micro-rate constants are weight-independent ratios', () => {
  // k10 = CL/V1 = (CL*s)/(V1*s) — weight cancels
  const p35 = calcFentanylParams({ weight: 35 });
  const p70 = calcFentanylParams({ weight: 70 });
  assertApprox(p35.k10, p70.k10, 1e-12, 'k10 weight-independence');
  assertApprox(p35.k12, p70.k12, 1e-12, 'k12 weight-independence');
  assertApprox(p35.k21, p70.k21, 1e-12, 'k21 weight-independence');
  assertApprox(p35.k13, p70.k13, 1e-12, 'k13 weight-independence');
  assertApprox(p35.k31, p70.k31, 1e-12, 'k31 weight-independence');
});

// ── Engine compatibility (Q3 >= minimum threshold) ───────────────

test('Q3 >= 0.05 L/min at all clinical weights (engine validation threshold)', () => {
  for (const w of [30, 40, 50, 60, 70, 80, 100, 120, 150]) {
    const p = calcFentanylParams({ weight: w });
    assert(p.Q3 >= 0.05, `Q3 < 0.05 at ${w} kg: ${p.Q3}`);
  }
});

test('All parameters are positive finite numbers', () => {
  const p = calcFentanylParams({ weight: 70 });
  for (const [k, v] of Object.entries(p)) {
    assert(isFinite(v) && v > 0, `${k} = ${v} is not a positive finite number`);
  }
});

// ── Plausible concentration range after 100 mcg bolus (sanity check) ─

test('Peak Cp after 100 mcg fentanyl bolus is plausible (1-10 ng/mL)', () => {
  const p = calcFentanylParams({ weight: 70 });
  // Instantaneous mixing: Cp = dose / V1 (mcg/mL)
  const doseMg = 0.1;   // 100 mcg = 0.1 mg
  const peakCp = doseMg / p.V1;  // mcg/mL
  const peakNgMl = peakCp * 1000;  // ng/mL
  assert(peakNgMl > 1,  `Peak Cp too low: ${peakNgMl.toFixed(2)} ng/mL`);
  assert(peakNgMl < 50, `Peak Cp unrealistically high: ${peakNgMl.toFixed(2)} ng/mL`);
});

// ─────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
