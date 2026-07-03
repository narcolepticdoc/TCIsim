/**
 * cubic.js — Shared cubic solver for the 3-compartment characteristic
 * polynomial.
 *
 * This is the SINGLE implementation of the trigonometric (Viète) method
 * used by both consumers:
 *   - js/pk/eigenvalues.js  cubeRoots()  (per-minute rate constants,
 *     0-indexed [|λ1|,|λ2|,|λ3|] return)
 *   - js/sim/simtiva-reference.js  cube()  (per-second rate constants,
 *     1-indexed [0, λ1, λ2, λ3] return matching SimTIVA's API)
 *
 * History: the two used to be independent copies and drifted — cube() was
 * missing the acos-argument clamp that cubeRoots() had, producing a silent
 * NaN loading bolus for near-degenerate eigenvalues (fixed in 0.5.40.8).
 * The core lives here precisely so that can never happen again. The solver
 * is unit-agnostic: callers pick per-minute or per-second rate constants
 * and get roots in the same unit.
 */

/**
 * Solve the 3-compartment characteristic polynomial for its three real
 * roots (the positive magnitudes |λᵢ| of the system eigenvalues).
 *
 * @param {number} k10 - elimination rate constant
 * @param {number} k12 - transfer 1→2
 * @param {number} k21 - transfer 2→1
 * @param {number} k13 - transfer 1→3
 * @param {number} k31 - transfer 3→1
 * @returns {number[]} [|λ1|, |λ2|, |λ3|] in the callers' rate-constant unit
 */
export function solveCubicRoots(k10, k12, k21, k13, k31) {
  const a0 = k10 * k21 * k31;
  const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
  const a2 = k10 + k12 + k13 + k21 + k31;
  const p = a1 - (a2 * a2 / 3.0);
  const q = (2.0 * a2 * a2 * a2 / 27.0) - (a1 * a2 / 3.0) + a0;
  const r1 = Math.sqrt(-(p * p * p) / 27.0);
  // Clamp: float error can push the ratio past ±1 when two eigenvalues are
  // near-degenerate, and acos(>1) is NaN.
  const cosArg = Math.max(-1, Math.min(1, (-q / 2.0) / r1));
  const phi = Math.acos(cosArg) / 3.0;
  const rc = Math.pow(r1, 1.0 / 3.0);
  return [
    -(Math.cos(phi) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 2.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 4.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
  ];
}
