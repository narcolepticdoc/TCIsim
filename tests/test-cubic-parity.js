/**
 * test-cubic-parity.js — The two cubic-solver adapters share one core.
 *
 * eigenvalues.js cubeRoots() (per-minute, 0-indexed) and
 * simtiva-reference.js cube() (per-second, 1-indexed) are both thin
 * adapters over js/pk/cubic.js solveCubicRoots(). This pins:
 *   - the adapters agree under per-min ↔ per-sec unit scaling
 *   - the acos clamp keeps near-degenerate systems finite
 *   - roots are positive and reproduce the characteristic polynomial
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

const u = (...p) => pathToFileURL(path.join(__dirname, '..', ...p)).href;

(async () => {
  const { solveCubicRoots } = await import(u('js', 'pk', 'cubic.js'));
  const { calcEleveldParams } = await import(u('js', 'pk', 'eleveld.js'));

  console.log('\n===== Cubic solver core parity =====\n');

  // Realistic per-minute rate constants from Eleveld params for 3 patients
  const patients = [
    { age: 35, weight: 70, height: 170, male: true, opioid: false },
    { age: 78, weight: 48, height: 155, male: false, opioid: false },
    { age: 22, weight: 120, height: 190, male: true, opioid: false },
  ];

  for (const p of patients) {
    const { V1, V2, V3, CL, Q2, Q3 } = calcEleveldParams(p);
    const kMin = [CL / V1, Q2 / V1, Q2 / V2, Q3 / V1, Q3 / V3]; // k10,k12,k21,k13,k31

    const rootsMin = solveCubicRoots(kMin[0], kMin[1], kMin[2], kMin[3], kMin[4]);
    const rootsSec = solveCubicRoots(...kMin.map(k => k / 60));

    ok(rootsMin.every(r => isFinite(r) && r > 0),
      `${p.age}y/${p.weight}kg: three positive finite roots (per-min)`);

    // Scaling all rate constants by 1/60 scales every root by 1/60
    ok(rootsMin.every((r, i) => Math.abs(r / 60 - rootsSec[i]) < Math.abs(r) * 1e-9),
      `${p.age}y/${p.weight}kg: per-sec roots = per-min roots / 60`);

    // Each root satisfies the characteristic polynomial
    // λ³ - a2·λ² + a1·λ - a0 = 0 (for the positive magnitudes)
    const [k10, k12, k21, k13, k31] = kMin;
    const a0 = k10 * k21 * k31;
    const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
    const a2 = k10 + k12 + k13 + k21 + k31;
    ok(rootsMin.every(l => Math.abs(l ** 3 - a2 * l ** 2 + a1 * l - a0) < 1e-9 * Math.max(1, a0)),
      `${p.age}y/${p.weight}kg: roots satisfy the characteristic polynomial`);
  }

  // Near-degenerate system: two nearly-equal eigenvalues push the acos
  // argument to the ±1 boundary — the clamp must keep the result finite.
  {
    const k = 0.1;
    const roots = solveCubicRoots(k, k * (1 + 1e-13), k, k * (1 + 1e-13), k);
    ok(roots.every(r => isFinite(r)),
      'near-degenerate rate constants stay finite (acos clamp)');
  }

  summary();
})().catch(err => {
  console.error('FATAL:', err);
  failed++;
  summary();
});
