/**
 * test-fentanyl-pk.js — Fentanyl PK Parameter Tests
 *
 * Validates Shafer 1990 fentanyl PK parameter calculator with
 * Shibutani 2004 pharmacokinetic mass correction for patients with
 * TBW ≥ 85 kg AND BMI > 30 (Shibutani 2004 obese-group entry criteria).
 * Inline implementation mirrors js/pk/fentanyl.js.
 */


import { pkMass, calcFentanylParams } from '../js/pk/fentanyl.js';

// Reference population values (Shafer 1990) used as independent expected
// values in the assertions below — NOT a second implementation.
const REF_WEIGHT = 70;
const REF_V1  =   7.35;
const REF_V2  =  33.94;
const REF_V3  = 275.62;
const REF_CL  =  36.47 / 60;
const REF_Q2  = 207.71 / 60;
const REF_Q3  =  99.22 / 60;
const KE0     = 0.1195;


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

// ── Shibutani 2004 PK mass — activation criteria ─────────────────

test('pkMass: both criteria met (TBW 90 kg, BMI 33) → PK mass formula applies', () => {
  // BMI 33, TBW 90 kg: obese group entry criteria met
  const m = pkMass(90, 33);
  // Formula: 52 / (1 + (196.4×exp(-0.025×90) − 53.66) / 100)
  assert(m < 90, `Expected PK mass < TBW, got ${m}`);
  assertApprox(m, 77.57, 0.1, 'pkMass(90, BMI=33)');
});

test('pkMass: TBW criterion not met (84 kg, BMI 31) → TBW returned unchanged', () => {
  // TBW = 84 < 85: criterion not met even though BMI > 30
  assertApprox(pkMass(84, 31), 84, 1e-9, 'pkMass(84, BMI=31)');
});

test('pkMass: BMI criterion not met (85 kg, BMI 29) → TBW returned unchanged', () => {
  // BMI = 29 ≤ 30: criterion not met even though TBW ≥ 85
  assertApprox(pkMass(85, 29), 85, 1e-9, 'pkMass(85, BMI=29)');
});

test('pkMass: tall lean patient (82 kg, BMI 24) → TBW returned unchanged', () => {
  // 82 kg / (1.85 m)² ≈ 24: tall lean patient, no obesity correction
  const bmi = 82 / (1.85 * 1.85);
  assertApprox(pkMass(82, bmi), 82, 1e-9, 'pkMass(82, lean)');
});

test('pkMass: 100 kg, BMI 33 → ~83.3 kg (Shibutani 2004 Table reference)', () => {
  assertApprox(pkMass(100, 33), 83.3, 0.1, 'pkMass(100, BMI=33)');
});

test('pkMass: 140 kg, BMI 33 → ~99.5 kg (Shibutani 2004 Table reference)', () => {
  assertApprox(pkMass(140, 33), 99.5, 0.1, 'pkMass(140, BMI=33)');
});

test('pkMass: monotonically increasing with TBW above 90 kg (obese group)', () => {
  const bmi = 35; // clearly obese
  let prev = pkMass(90, bmi);
  for (const w of [100, 120, 140, 160, 200]) {
    const m = pkMass(w, bmi);
    assert(m > prev, `pkMass not increasing at ${w} kg: ${m} ≤ ${prev}`);
    prev = m;
  }
});

test('pkMass: always less than TBW when both criteria met', () => {
  const bmi = 35;
  for (const w of [85, 100, 120, 140, 200]) {
    assert(pkMass(w, bmi) < w, `pkMass(${w}) = ${pkMass(w, bmi)} is not < TBW`);
  }
});

// ── Reference values at 70 kg, 175 cm (BMI ≈ 22.9, s=1) ─────────

test('V1 at 70 kg = 7.35 L', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).V1, 7.35, 1e-9, 'V1');
});

test('V2 at 70 kg = 33.94 L', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).V2, 33.94, 1e-9, 'V2');
});

test('V3 at 70 kg = 275.62 L', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).V3, 275.62, 1e-9, 'V3');
});

test('CL at 70 kg = 36.47/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).CL, 36.47 / 60, 1e-9, 'CL');
});

test('Q2 at 70 kg = 207.71/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).Q2, 207.71 / 60, 1e-9, 'Q2');
});

test('Q3 at 70 kg = 99.22/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70, height: 175 }).Q3, 99.22 / 60, 1e-9, 'Q3');
});

test('ke0 = 0.1195 min⁻¹ (weight-independent)', () => {
  for (const [w, h] of [[35, 175], [70, 175], [140, 175]]) {
    assertApprox(calcFentanylParams({ weight: w, height: h }).ke0, 0.1195, 1e-9, `ke0 at ${w} kg`);
  }
});

// ── Weight scaling (non-obese — no PK mass correction) ───────────

test('Volumes scale linearly for non-obese patients', () => {
  const p35 = calcFentanylParams({ weight: 35, height: 175 });
  const p70 = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p35.V1 * 2, p70.V1, 1e-9, 'V1 35→70');
  assertApprox(p35.V2 * 2, p70.V2, 1e-9, 'V2 35→70');
  assertApprox(p35.V3 * 2, p70.V3, 1e-9, 'V3 35→70');
});

test('Clearances scale linearly for non-obese patients', () => {
  const p35 = calcFentanylParams({ weight: 35, height: 175 });
  const p70 = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p35.CL * 2, p70.CL, 1e-9, 'CL 35→70');
  assertApprox(p35.Q2 * 2, p70.Q2, 1e-9, 'Q2 35→70');
  assertApprox(p35.Q3 * 2, p70.Q3, 1e-9, 'Q3 35→70');
});

test('PK mass correction attenuates V1 growth in obese patients', () => {
  // 100 kg, 170 cm → BMI ≈ 34.6 (obese, criteria met)
  // Linear scaling: V1 = 7.35 × (100/70) = 10.5 L
  // With PK mass: V1 = 7.35 × (83.3/70) ≈ 8.74 L
  const p100obese  = calcFentanylParams({ weight: 100, height: 170 });
  const p100Linear = REF_V1 * (100 / REF_WEIGHT);
  assert(p100obese.V1 < p100Linear - 0.5,
    `Expected V1 attenuation at 100 kg obese: ${p100obese.V1.toFixed(3)} vs linear ${p100Linear.toFixed(3)}`);
});

test('Tall lean patient at 90 kg uses linear scaling (no PK mass correction)', () => {
  // 90 kg, 190 cm → BMI ≈ 24.9 (lean, criteria not met)
  const pLean   = calcFentanylParams({ weight: 90, height: 190 });
  const pLinear = REF_V1 * (90 / REF_WEIGHT);
  assertApprox(pLean.V1, pLinear, 1e-9, 'V1 90 kg lean');
});

// ── Micro-rate constant derivation ──────────────────────────────

test('k10 = CL / V1', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p.k10, p.CL / p.V1, 1e-12, 'k10');
});

test('k12 = Q2 / V1', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p.k12, p.Q2 / p.V1, 1e-12, 'k12');
});

test('k21 = Q2 / V2', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p.k21, p.Q2 / p.V2, 1e-12, 'k21');
});

test('k13 = Q3 / V1', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p.k13, p.Q3 / p.V1, 1e-12, 'k13');
});

test('k31 = Q3 / V3', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p.k31, p.Q3 / p.V3, 1e-12, 'k31');
});

test('Micro-constants weight-independent for non-obese patients (s cancels)', () => {
  const p35 = calcFentanylParams({ weight: 35, height: 175 });
  const p70 = calcFentanylParams({ weight: 70, height: 175 });
  assertApprox(p35.k10, p70.k10, 1e-12, 'k10');
  assertApprox(p35.k12, p70.k12, 1e-12, 'k12');
  assertApprox(p35.k21, p70.k21, 1e-12, 'k21');
  assertApprox(p35.k13, p70.k13, 1e-12, 'k13');
  assertApprox(p35.k31, p70.k31, 1e-12, 'k31');
});

// ── Engine compatibility ──────────────────────────────────────────

test('Q3 >= 0.05 L/min at all clinical weights', () => {
  for (const [w, h] of [[30,175],[40,175],[50,175],[60,175],[70,175],[80,175],[100,170],[120,170],[150,170]]) {
    const p = calcFentanylParams({ weight: w, height: h });
    assert(p.Q3 >= 0.05, `Q3 < 0.05 at ${w} kg: ${p.Q3}`);
  }
});

test('All parameters are positive finite numbers', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  for (const [k, v] of Object.entries(p)) {
    assert(isFinite(v) && v > 0, `${k} = ${v} is not a positive finite number`);
  }
});

// ── Plausible concentration range after 100 mcg bolus ───────────

test('Peak Cp after 100 mcg fentanyl bolus is plausible (1–50 ng/mL at 70 kg)', () => {
  const p = calcFentanylParams({ weight: 70, height: 175 });
  const peakNgMl = (0.1 / p.V1) * 1000;  // 0.1 mg / V1 L → mcg/mL → ng/mL
  assert(peakNgMl > 1,  `Peak Cp too low: ${peakNgMl.toFixed(2)} ng/mL`);
  assert(peakNgMl < 50, `Peak Cp unrealistically high: ${peakNgMl.toFixed(2)} ng/mL`);
});

// ─────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
