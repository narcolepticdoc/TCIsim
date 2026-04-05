/**
 * test-fentanyl-pk.js — Fentanyl PK Parameter Tests
 *
 * Validates Shafer 1990 fentanyl PK parameter calculator with
 * Shibutani 2004 pharmacokinetic mass correction for patients >80 kg.
 * Inline implementation mirrors js/pk/fentanyl.js.
 */

// ── Inline fentanyl.js ────────────────────────────────────────────
const REF_WEIGHT = 70;
const REF_V1  =   7.35;
const REF_V2  =  33.94;
const REF_V3  = 275.62;
const REF_CL  =  36.47 / 60;
const REF_Q2  = 207.71 / 60;
const REF_Q3  =  99.22 / 60;
const KE0     = 0.1195;

function pkMass(tbw) {
  if (tbw <= 80) return tbw;
  return 52 / (1 + (196.4 * Math.exp(-0.025 * tbw) - 53.66) / 100);
}

function calcFentanylParams(patient) {
  const { weight } = patient;
  const s = pkMass(weight) / REF_WEIGHT;
  const V1 = REF_V1 * s;
  const V2 = REF_V2 * s;
  const V3 = REF_V3 * s;
  const CL = REF_CL * s;
  const Q2 = REF_Q2 * s;
  const Q3 = REF_Q3 * s;
  const ke0 = KE0;
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

// ── Shibutani 2004 PK mass formula ──────────────────────────────

test('pkMass: TBW ≤ 80 kg returns TBW unchanged', () => {
  for (const w of [30, 50, 70, 80]) {
    assertApprox(pkMass(w), w, 1e-9, `pkMass(${w})`);
  }
});

test('pkMass: 100 kg → ~83.3 kg (Shibutani 2004 Table reference)', () => {
  assertApprox(pkMass(100), 83.3, 0.1, 'pkMass(100)');
});

test('pkMass: 140 kg → ~99.5 kg (Shibutani 2004 Table reference)', () => {
  assertApprox(pkMass(140), 99.5, 0.1, 'pkMass(140)');
});

test('pkMass: monotonically increasing with TBW above 90 kg', () => {
  let prev = pkMass(90);
  for (const w of [100, 120, 140, 160, 200]) {
    const m = pkMass(w);
    assert(m > prev, `pkMass not increasing at ${w} kg: ${m} ≤ ${prev}`);
    prev = m;
  }
});

test('pkMass: always less than TBW for patients >80 kg', () => {
  for (const w of [85, 100, 120, 140, 200]) {
    assert(pkMass(w) < w, `pkMass(${w}) = ${pkMass(w)} is not < TBW`);
  }
});

// ── Reference values at 70 kg (s=1) ─────────────────────────────

test('V1 at 70 kg = 7.35 L', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).V1, 7.35, 1e-9, 'V1');
});

test('V2 at 70 kg = 33.94 L', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).V2, 33.94, 1e-9, 'V2');
});

test('V3 at 70 kg = 275.62 L', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).V3, 275.62, 1e-9, 'V3');
});

test('CL at 70 kg = 36.47/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).CL, 36.47 / 60, 1e-9, 'CL');
});

test('Q2 at 70 kg = 207.71/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).Q2, 207.71 / 60, 1e-9, 'Q2');
});

test('Q3 at 70 kg = 99.22/60 L/min', () => {
  assertApprox(calcFentanylParams({ weight: 70 }).Q3, 99.22 / 60, 1e-9, 'Q3');
});

test('ke0 = 0.1195 min⁻¹ (weight-independent)', () => {
  for (const w of [35, 70, 140]) {
    assertApprox(calcFentanylParams({ weight: w }).ke0, 0.1195, 1e-9, `ke0 at ${w} kg`);
  }
});

// ── Weight scaling (TBW ≤ 80 kg — no PK mass correction) ────────

test('Volumes scale linearly for TBW ≤ 80 kg', () => {
  const p35  = calcFentanylParams({ weight: 35 });
  const p70  = calcFentanylParams({ weight: 70 });
  assertApprox(p35.V1 * 2, p70.V1, 1e-9, 'V1 35→70');
  assertApprox(p35.V2 * 2, p70.V2, 1e-9, 'V2 35→70');
  assertApprox(p35.V3 * 2, p70.V3, 1e-9, 'V3 35→70');
});

test('Clearances scale linearly for TBW ≤ 80 kg', () => {
  const p35 = calcFentanylParams({ weight: 35 });
  const p70 = calcFentanylParams({ weight: 70 });
  assertApprox(p35.CL * 2, p70.CL, 1e-9, 'CL 35→70');
  assertApprox(p35.Q2 * 2, p70.Q2, 1e-9, 'Q2 35→70');
  assertApprox(p35.Q3 * 2, p70.Q3, 1e-9, 'Q3 35→70');
});

test('PK mass correction attenuates V1 growth above 80 kg', () => {
  // At 100 kg TBW with linear scaling: V1 would be 7.35 × (100/70) = 10.5 L
  // With PK mass correction:          V1 = 7.35 × (83.3/70) ≈ 8.74 L < 10.5 L
  const p100 = calcFentanylParams({ weight: 100 });
  const p100Linear = 7.35 * (100 / 70);
  assert(p100.V1 < p100Linear - 0.5,
    `Expected V1 attenuation at 100 kg: ${p100.V1.toFixed(3)} vs linear ${p100Linear.toFixed(3)}`);
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

test('Micro-constants weight-independent for TBW ≤ 80 kg (PK mass = TBW, s cancels)', () => {
  const p35 = calcFentanylParams({ weight: 35 });
  const p70 = calcFentanylParams({ weight: 70 });
  assertApprox(p35.k10, p70.k10, 1e-12, 'k10');
  assertApprox(p35.k12, p70.k12, 1e-12, 'k12');
  assertApprox(p35.k21, p70.k21, 1e-12, 'k21');
  assertApprox(p35.k13, p70.k13, 1e-12, 'k13');
  assertApprox(p35.k31, p70.k31, 1e-12, 'k31');
});

// ── Engine compatibility ──────────────────────────────────────────

test('Q3 >= 0.05 L/min at all clinical weights', () => {
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

// ── Plausible concentration range after 100 mcg bolus ───────────

test('Peak Cp after 100 mcg fentanyl bolus is plausible (1–50 ng/mL at 70 kg)', () => {
  const p = calcFentanylParams({ weight: 70 });
  const peakNgMl = (0.1 / p.V1) * 1000;  // 0.1 mg / V1 L → mcg/mL → ng/mL
  assert(peakNgMl > 1,  `Peak Cp too low: ${peakNgMl.toFixed(2)} ng/mL`);
  assert(peakNgMl < 50, `Peak Cp unrealistically high: ${peakNgMl.toFixed(2)} ng/mL`);
});

// ─────────────────────────────────────────────────────────────────
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
