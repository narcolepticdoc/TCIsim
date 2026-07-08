/**
 * test-ketamine-pk.js — Ketamine PK Parameter Tests
 *
 * Validates Domino 1982 / Navarrete 2024 ketamine PK parameter calculator.
 * V1 scales linearly with weight at 63 mL/kg.
 * All five micro-rate constants (K10–K31) are fixed population values.
 * V2, V3, CL, Q2, Q3 are derived from V1 and the fixed micro-constants.
 * Inline implementation mirrors js/pk/ketamine.js.
 */

import { calcKetamineParams } from '../js/pk/ketamine.js';

// Fixed population micro-constants (Domino/Navarrete) used as independent
// expected values in the assertions below — NOT a second implementation.
const K10 = 0.4381;
const K12 = 0.5921;
const K21 = 0.2470;
const K13 = 0.5900;
const K31 = 0.0146;
const KE0 = 0.238;
const V1_PER_KG = 0.063;

// calcKetamineParams imported from production below.
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

test('V1 at 70 kg = 4.41 L (0.063 × 70)', () => {
  assertApprox(calcKetamineParams({ weight: 70 }).V1, 4.41, 1e-9, 'V1');
});

test('V2 at 70 kg = (K12/K21) × V1 ≈ 10.57 L', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.V2, (K12 / K21) * 4.41, 1e-9, 'V2');
  assertApprox(p.V2, 10.57, 0.01, 'V2 ≈ 10.57 L');
});

test('V3 at 70 kg = (K13/K31) × V1 ≈ 178.21 L', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.V3, (K13 / K31) * 4.41, 1e-9, 'V3');
  assertApprox(p.V3, 178.21, 0.1, 'V3 ≈ 178.21 L');
});

test('CL at 70 kg = K10 × V1 ≈ 1.932 L/min', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.CL, K10 * 4.41, 1e-9, 'CL');
  assertApprox(p.CL, 115.92 / 60, 0.001, 'CL ≈ 115.92 L/h');
});

test('Q2 at 70 kg = K12 × V1 ≈ 2.611 L/min', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.Q2, K12 * 4.41, 1e-9, 'Q2');
  assertApprox(p.Q2, 156.67 / 60, 0.001, 'Q2 ≈ 156.67 L/h');
});

test('Q3 at 70 kg = K13 × V1 ≈ 2.602 L/min', () => {
  const p = calcKetamineParams({ weight: 70 });
  assertApprox(p.Q3, K13 * 4.41, 1e-9, 'Q3');
  assertApprox(p.Q3, 156.11 / 60, 0.001, 'Q3 ≈ 156.11 L/h');
});

test('ke0 = 0.238 min⁻¹ (weight-independent, Navarrete 2024)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).ke0, 0.238, 1e-9, `ke0 at ${w} kg`);
  }
});

// ── Fixed micro-constants ────────────────────────────────────────

test('k10 = K10 = 0.4381 /min (fixed)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).k10, K10, 1e-12, `k10 at ${w} kg`);
  }
});

test('k12 = K12 = 0.5921 /min (fixed)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).k12, K12, 1e-12, `k12 at ${w} kg`);
  }
});

test('k21 = K21 = 0.2470 /min (fixed)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).k21, K21, 1e-12, `k21 at ${w} kg`);
  }
});

test('k13 = K13 = 0.5900 /min (fixed)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).k13, K13, 1e-12, `k13 at ${w} kg`);
  }
});

test('k31 = K31 = 0.0146 /min (fixed)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcKetamineParams({ weight: w }).k31, K31, 1e-12, `k31 at ${w} kg`);
  }
});

// ── Weight scaling ───────────────────────────────────────────────

test('V1 scales linearly with weight', () => {
  const p35  = calcKetamineParams({ weight: 35 });
  const p70  = calcKetamineParams({ weight: 70 });
  const p140 = calcKetamineParams({ weight: 140 });
  assertApprox(p35.V1 * 2, p70.V1,  1e-9, 'V1 35→70');
  assertApprox(p70.V1 * 2, p140.V1, 1e-9, 'V1 70→140');
});

test('V2 scales linearly with weight (derived from V1)', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.V2 * 2, p70.V2, 1e-9, 'V2 35→70');
});

test('V3 scales linearly with weight (derived from V1)', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.V3 * 2, p70.V3, 1e-9, 'V3 35→70');
});

test('CL, Q2, Q3 scale linearly with weight (derived from V1)', () => {
  const p35 = calcKetamineParams({ weight: 35 });
  const p70 = calcKetamineParams({ weight: 70 });
  assertApprox(p35.CL * 2, p70.CL, 1e-9, 'CL 35→70');
  assertApprox(p35.Q2 * 2, p70.Q2, 1e-9, 'Q2 35→70');
  assertApprox(p35.Q3 * 2, p70.Q3, 1e-9, 'Q3 35→70');
});

// ── Consistency: derived V and CL match fixed K × V1 ─────────────

test('V2 = (K12/K21) × V1 at all weights', () => {
  for (const w of [40, 70, 100]) {
    const p = calcKetamineParams({ weight: w });
    assertApprox(p.V2, (K12 / K21) * p.V1, 1e-9, `V2 at ${w} kg`);
  }
});

test('V3 = (K13/K31) × V1 at all weights', () => {
  for (const w of [40, 70, 100]) {
    const p = calcKetamineParams({ weight: w });
    assertApprox(p.V3, (K13 / K31) * p.V1, 1e-9, `V3 at ${w} kg`);
  }
});

test('CL = K10 × V1 at all weights', () => {
  for (const w of [40, 70, 100]) {
    const p = calcKetamineParams({ weight: w });
    assertApprox(p.CL, K10 * p.V1, 1e-12, `CL at ${w} kg`);
  }
});

// ── Engine compatibility ──────────────────────────────────────────

test('Q3 >= 0.05 L/min at all clinical weights', () => {
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

// ── Plausible concentration ranges ──────────────────────────────

test('Peak Cp after 1 mg/kg bolus is plausible (2–25 mcg/mL at 70 kg)', () => {
  const weight = 70;
  const p = calcKetamineParams({ weight });
  const peakCp = (1 * weight) / p.V1;  // dose mg / V1 L → mcg/mL
  assert(peakCp > 2,  `Peak Cp too low: ${peakCp.toFixed(2)} mcg/mL`);
  assert(peakCp < 25, `Peak Cp unrealistically high: ${peakCp.toFixed(2)} mcg/mL`);
});

test('Sub-analgesic 0.1 mg/kg bolus gives sub-dissociative Cp (< 5 mcg/mL)', () => {
  const weight = 70;
  const p = calcKetamineParams({ weight });
  const peakCp = (0.1 * weight) / p.V1;
  assert(peakCp > 0.1, `Sub-analgesic bolus gives negligible Cp: ${peakCp.toFixed(3)} mcg/mL`);
  assert(peakCp < 5.0, `0.1 mg/kg should not cause full dissociation: ${peakCp.toFixed(3)} mcg/mL`);
});

// ─────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
