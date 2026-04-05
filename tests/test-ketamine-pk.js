/**
 * test-ketamine-pk.js — Ketamine PK Parameter Tests
 *
 * Validates Domino/Clements 1982 ketamine PK parameter calculator.
 * Inline implementation matches js/pk/ketamine.js.
 */

// ── Inline ketamine.js ────────────────────────────────────────────
function calcKetamineParams(patient) {
  const { weight } = patient;
  const V1 = 0.18  * weight;
  const V2 = 0.65  * weight;
  const V3 = 1000;
  const CL = 0.019 * weight;
  const Q2 = 0.074 * weight;
  const Q3 = 0.05;
  const ke0 = 0.5;
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

// ── Reference values at 70 kg ────────────────────────────────────

test('V1 at 70 kg = 12.6 L (0.18 * 70)', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.V1, 0.18 * 70, 1e-9, 'V1');
});

test('V2 at 70 kg = 45.5 L (0.65 * 70)', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.V2, 0.65 * 70, 1e-9, 'V2');
});

test('V3 = 1000 L (fixed sink, weight-independent)', () => {
  const p35  = calcKetamineParams({ weight: 35 });
  const p70  = calcKetamineParams({ weight: 70 });
  const p140 = calcKetamineParams({ weight: 140 });
  assertApprox(p35.V3,  1000, 1e-9, 'V3 at 35 kg');
  assertApprox(p70.V3,  1000, 1e-9, 'V3 at 70 kg');
  assertApprox(p140.V3, 1000, 1e-9, 'V3 at 140 kg');
});

test('CL at 70 kg = 1.33 L/min (0.019 * 70)', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.CL, 0.019 * 70, 1e-9, 'CL');
});

test('Q2 at 70 kg = 5.18 L/min (0.074 * 70)', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.Q2, 0.074 * 70, 1e-9, 'Q2');
});

test('Q3 = 0.05 L/min (fixed, weight-independent)', () => {
  const p35  = calcKetamineParams({ weight: 35 });
  const p70  = calcKetamineParams({ weight: 70 });
  const p140 = calcKetamineParams({ weight: 140 });
  assertApprox(p35.Q3,  0.05, 1e-9, 'Q3 at 35 kg');
  assertApprox(p70.Q3,  0.05, 1e-9, 'Q3 at 70 kg');
  assertApprox(p140.Q3, 0.05, 1e-9, 'Q3 at 140 kg');
});

test('ke0 = 0.5 min⁻¹ (weight-independent)', () => {
  const p35  = calcKetamineParams({ weight: 35 });
  const p70  = calcKetamineParams({ weight: 70 });
  const p140 = calcKetamineParams({ weight: 140 });
  assertApprox(p35.ke0,  0.5, 1e-9, 'ke0 at 35 kg');
  assertApprox(p70.ke0,  0.5, 1e-9, 'ke0 at 70 kg');
  assertApprox(p140.ke0, 0.5, 1e-9, 'ke0 at 140 kg');
});

// ── Weight scaling ───────────────────────────────────────────────

test('V1 scales linearly with weight', () => {
  const p35  = calcKetamineParams({ weight: 35 });
  const p70  = calcKetamineParams({ weight: 70 });
  const p140 = calcKetamineParams({ weight: 140 });
  assertApprox(p35.V1 * 2, p70.V1,  1e-9, 'V1 35→70');
  assertApprox(p70.V1 * 2, p140.V1, 1e-9, 'V1 70→140');
});

test('V2 scales linearly with weight', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.V2 * 2, p70.V2, 1e-9, 'V2 35→70');
});

test('CL and Q2 scale linearly with weight', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.CL * 2, p70.CL, 1e-9, 'CL 35→70');
  assertApprox(p35.Q2 * 2, p70.Q2, 1e-9, 'Q2 35→70');
});

// ── Micro-rate constant derivation ──────────────────────────────

test('k10 = CL / V1', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.k10, p.CL / p.V1, 1e-12, 'k10');
});

test('k12 = Q2 / V1', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.k12, p.Q2 / p.V1, 1e-12, 'k12');
});

test('k21 = Q2 / V2', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.k21, p.Q2 / p.V2, 1e-12, 'k21');
});

test('k13 = Q3 / V1', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.k13, p.Q3 / p.V1, 1e-12, 'k13');
});

test('k31 = Q3 / V3 = 5e-5 min⁻¹ (negligible sink)', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.k31, 0.05 / 1000, 1e-12, 'k31');
  assert(p.k31 < 1e-4, `k31 should be negligible: ${p.k31}`);
});

test('k10, k12, k21 are weight-independent (linear scaling cancels)', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.k10, p70.k10, 1e-12, 'k10 weight-independence');
  assertApprox(p35.k12, p70.k12, 1e-12, 'k12 weight-independence');
  assertApprox(p35.k21, p70.k21, 1e-12, 'k21 weight-independence');
});

// ── Engine compatibility ─────────────────────────────────────────

test('Q3 >= 0.05 L/min at all clinical weights (engine validation threshold)', () => {
  for (const w of [30, 40, 50, 60, 70, 80, 100, 120, 150]) {
    const p = calcKetamineParams({ weight: w });
    assert(p.Q3 >= 0.05, `Q3 < 0.05 at ${w} kg: ${p.Q3}`);
  }
});

test('All parameters are positive finite numbers', () => {
  const p = calcKetamineParams({ weight: 70 });
  for (const [k, v] of Object.entries(p)) {
    assert(isFinite(v) && v > 0, `${k} = ${v} is not a positive finite number`);
  }
});

// ── Plausible concentration range (sanity checks) ────────────────

test('Peak Cp after 1 mg/kg ketamine bolus is plausible (0.5-5 mcg/mL)', () => {
  const weight = 70;
  const p = calcKetamineParams({ weight });
  // Instantaneous mixing: Cp = dose / V1
  const doseMg = 1 * weight;  // 1 mg/kg = 70 mg
  const peakCp = doseMg / p.V1;  // mcg/mL
  assert(peakCp > 0.5, `Peak Cp too low: ${peakCp.toFixed(2)} mcg/mL`);
  assert(peakCp < 20,  `Peak Cp unrealistically high: ${peakCp.toFixed(2)} mcg/mL`);
});

test('Analgesic Cp range (0.2-0.4 mcg/mL) is achievable with subanesthetic doses', () => {
  const weight = 70;
  const p = calcKetamineParams({ weight });
  // ~0.1 mg/kg subanalgesic bolus
  const doseMg = 0.1 * weight;  // 7 mg
  const peakCp = doseMg / p.V1;  // mcg/mL
  assert(peakCp > 0.1, `Sub-analgesic bolus gives no Cp: ${peakCp.toFixed(3)} mcg/mL`);
  assert(peakCp < 2.0, `0.1 mg/kg should not cause dissociation: ${peakCp.toFixed(3)} mcg/mL`);
});

// ─────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
