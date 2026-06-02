/**
 * test-patient-sync.js — Cloud patient pull pure-logic tests.
 *
 * Exercises the real exports from js/sync/patient-sync.js via dynamic import
 * (the module has no top-level DOM/network access, so it loads cleanly in
 * Node). Covers pairing-code normalization/validation, incoming-payload
 * normalization + range checks, canonical-metric → display-unit conversion,
 * and relative-time formatting.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function near(a, b, tol, m) { ok(Math.abs(a - b) < tol, `${m} (${a} ≈ ${b})`); }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

(async () => {
  const modUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'sync', 'patient-sync.js')).href;
  const {
    normalizeCode, isValidCode, normalizeIncomingPatient,
    canonicalToDisplay, formatRelativeTime,
  } = await import(modUrl);

  // ---- normalizeCode ----
  ok(normalizeCode('abc234') === 'ABC234', 'lowercases');
  ok(normalizeCode('  ab c2 34 ') === 'ABC234', 'strips whitespace');
  ok(normalizeCode(null) === '', 'null → empty');
  ok(normalizeCode(undefined) === '', 'undefined → empty');

  // ---- isValidCode ----
  ok(isValidCode('ABC234') === true, 'valid 6-char code');
  ok(isValidCode('abc234') === true, 'valid after normalization');
  ok(isValidCode('ABC23') === false, 'too short');
  ok(isValidCode('ABC2345') === false, 'too long');
  ok(isValidCode('ABO234') === false, 'rejects ambiguous O');
  ok(isValidCode('ABI234') === false, 'rejects ambiguous I');
  ok(isValidCode('ABC011') === false, 'rejects ambiguous 0/1');
  ok(isValidCode('') === false, 'empty invalid');

  // ---- normalizeIncomingPatient ----
  {
    const good = { age: 45, sex: 'male', heightCm: 180, weightKg: 80, updatedAt: 1700000000000 };
    const r = normalizeIncomingPatient(good);
    ok(r && r.age === 45 && r.sex === 'male', 'valid payload passes');
    near(r.heightCm, 180, 1e-9, 'height preserved');
    near(r.weightKg, 80, 1e-9, 'weight preserved');
    ok(r.updatedAt === 1700000000000, 'updatedAt preserved');
    ok(!('opioid' in r), 'opioid field not carried');
  }
  {
    // unwraps { patient: {...} } envelope
    const r = normalizeIncomingPatient({ patient: { age: 30, sex: 'female', heightCm: 165, weightKg: 60, updatedAt: 1 } });
    ok(r && r.sex === 'female', 'unwraps patient envelope');
  }
  {
    // ignores a stray opioid field
    const r = normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: 170, weightKg: 70, opioid: true, updatedAt: 1 });
    ok(r && !('opioid' in r), 'stray opioid ignored');
  }
  ok(normalizeIncomingPatient(null) === null, 'null → null');
  ok(normalizeIncomingPatient({ age: 0, sex: 'male', heightCm: 170, weightKg: 70 }) === null, 'age below range → null');
  ok(normalizeIncomingPatient({ age: 121, sex: 'male', heightCm: 170, weightKg: 70 }) === null, 'age above range → null');
  ok(normalizeIncomingPatient({ age: 30.5, sex: 'male', heightCm: 170, weightKg: 70 }) === null, 'non-integer age → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'x', heightCm: 170, weightKg: 70 }) === null, 'bad sex → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: 20, weightKg: 70 }) === null, 'height below range → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: 300, weightKg: 70 }) === null, 'height above range → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: 170, weightKg: 0.1 }) === null, 'weight below range → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: 170, weightKg: 400 }) === null, 'weight above range → null');
  ok(normalizeIncomingPatient({ age: 30, sex: 'male', heightCm: '170', weightKg: 70 }) === null, 'non-numeric height → null');

  // ---- canonicalToDisplay ----
  {
    const p = { age: 45, sex: 'male', heightCm: 180, weightKg: 80 };
    const m = canonicalToDisplay(p, 'metric');
    ok(m.age === '45' && m.sex === 'male', 'metric: age/sex strings');
    ok(m.height === '180', 'metric: height cm unchanged');
    ok(m.weight === '80', 'metric: weight kg unchanged');
    const i = canonicalToDisplay(p, 'imperial');
    near(parseFloat(i.height), 70.9, 0.05, 'imperial: 180cm → ~70.9 in');
    near(parseFloat(i.weight), 176.4, 0.1, 'imperial: 80kg → ~176.4 lbs');
  }

  // ---- formatRelativeTime ----
  {
    const now = 1_000_000_000_000;
    ok(formatRelativeTime(now - 3000, now) === 'just now', '<10s → just now');
    ok(formatRelativeTime(now - 45_000, now) === '45 sec ago', '45s → sec ago');
    ok(formatRelativeTime(now - 60_000, now) === '1 min ago', '60s → 1 min ago');
    ok(formatRelativeTime(now - 59 * 60_000, now) === '59 min ago', '59 min ago');
    ok(formatRelativeTime(now - 60 * 60_000, now) === '1 hr ago', '60 min → 1 hr ago');
    ok(formatRelativeTime(now - 5 * 3_600_000, now) === '5 hr ago', '5 hr ago');
    ok(formatRelativeTime(now - 25 * 3_600_000, now) === 'over a day ago', '25 hr → over a day');
    ok(formatRelativeTime(NaN, now) === '', 'NaN → empty');
  }

  summary();
})().catch(err => {
  console.error(err);
  failed++;
  summary();
});
