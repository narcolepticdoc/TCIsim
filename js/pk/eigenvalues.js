/**
 * eigenvalues.js — PK system eigenvalue analysis.
 *
 * Decomposes a 3-compartment mammillary A matrix into its three (real,
 * negative) eigenvalues and returns the half-life of the intermediate
 * mode — the mode that dominates error decay when the model's total-dose
 * history is corrected retrospectively.
 *
 * Used by the dose-reconciliation feature to size the post-correction
 * "untrustworthy" convergence window: window = 3 × t½_intermediate
 * decays the intermediate mode to ~12.5 % while the fast mode is
 * effectively zero. The slow mode typically carries small residual error
 * because deep V3 loading accrues slowly; waiting out the slow mode
 * (hours) is impractical.
 *
 * The math is a per-minute port of the cubic solver in
 * simtiva-reference.js (which works in per-second units). All rates
 * here are per-minute to match engine convention.
 */

import { calcEleveldParams } from './eleveld.js';
import { calcFentanylParams } from './fentanyl.js';
import { calcKetamineParams } from './ketamine.js';

// Clamp the convergence window to a sensible clinical range. Upper bound
// keeps the user-facing "reconciling for N min" message honest — anything
// longer than ~2 hours is beyond useful for an active case, and anything
// shorter than 15 min misrepresents the fact that intermediate
// redistribution is still ongoing.
const MIN_WINDOW_MIN = 15;
const MAX_WINDOW_MIN = 120;

/**
 * Solve the 3-compartment characteristic polynomial.
 * Returns three positive values |λᵢ| (the negative of the eigenvalues of A).
 *
 * @param {number} k10 - elimination rate (per minute)
 * @param {number} k12
 * @param {number} k21
 * @param {number} k13
 * @param {number} k31
 * @returns {number[]} [|λ1|, |λ2|, |λ3|]
 */
function cubeRoots(k10, k12, k21, k13, k31) {
  const a0 = k10 * k21 * k31;
  const a1 = k10 * k31 + k21 * k31 + k21 * k13 + k10 * k21 + k31 * k12;
  const a2 = k10 + k12 + k13 + k21 + k31;
  const p = a1 - (a2 * a2 / 3.0);
  const q = (2.0 * a2 * a2 * a2 / 27.0) - (a1 * a2 / 3.0) + a0;
  const r1 = Math.sqrt(-(p * p * p) / 27.0);
  const cosArg = Math.max(-1, Math.min(1, (-q / 2.0) / r1));
  const phi = Math.acos(cosArg) / 3.0;
  const rc = Math.pow(r1, 1.0 / 3.0);
  return [
    -(Math.cos(phi) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 2.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
    -(Math.cos(phi + 4.0 * Math.PI / 3.0) * 2.0 * rc - a2 / 3.0),
  ];
}

function eigenvaluesFromPK(pk) {
  const { V1, V2, V3, CL, Q2, Q3 } = pk;
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k13 = Q3 / V1;
  const k21 = Q2 / V2;
  const k31 = Q3 / V3;
  return cubeRoots(k10, k12, k21, k13, k31);
}

const CALC_BY_DRUG = {
  propofol:  calcEleveldParams,
  fentanyl:  calcFentanylParams,
  ketamine:  calcKetamineParams,
};

/**
 * Compute the half-life of the intermediate eigenmode for this drug
 * and patient, in minutes.
 *
 * "Intermediate" = middle magnitude of |λ1|, |λ2|, |λ3|.
 *
 * @param {string} drugId
 * @param {Object} patient - { age, weight, height, male, ... }
 * @returns {number} t½ in minutes
 */
export function getIntermediateHalfLife(drugId, patient) {
  const calc = CALC_BY_DRUG[drugId];
  if (!calc) return MIN_WINDOW_MIN / 3;
  const pk = calc(patient);
  const [a, b, c] = eigenvaluesFromPK(pk).map(Math.abs);
  const sorted = [a, b, c].sort((x, y) => x - y);
  const mid = sorted[1]; // intermediate magnitude
  if (!(mid > 0) || !isFinite(mid)) return MIN_WINDOW_MIN / 3;
  return Math.log(2) / mid;
}

/**
 * Compute the reconciliation convergence window in minutes for the
 * given drug and patient.
 *
 *   window = clamp(3 × t½_intermediate, [MIN, MAX])
 *
 * @param {string} drugId
 * @param {Object} patient
 * @returns {number} window duration in minutes
 */
export function getConvergenceWindow(drugId, patient) {
  const hl = getIntermediateHalfLife(drugId, patient);
  const raw = 3 * hl;
  return Math.max(MIN_WINDOW_MIN, Math.min(MAX_WINDOW_MIN, raw));
}
