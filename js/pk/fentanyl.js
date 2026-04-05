/**
 * fentanyl.js — Shafer/Varvel 1990 Fentanyl PK Parameter Calculator
 *
 * 3-compartment model with linear weight scaling from a 70 kg reference.
 * No PD model (no validated effect-site/BIS equivalent for opioids).
 *
 * Ce is in mcg/mL (canonical engine unit). Clinical display is ng/mL.
 * Therapeutic range: ~1–5 ng/mL (0.001–0.005 mcg/mL) intraoperative.
 *
 * Reference: Shafer SL, Varvel JR. "Pharmacokinetics, pharmacodynamics,
 *   and rational opioid selection." Anesthesiology 1991;74(1):53-63.
 *
 * Rate constants are in per-MINUTE units (engine invariant).
 */

const REF_WEIGHT = 70; // kg — reference population weight

/**
 * Calculate Shafer 1990 fentanyl PK parameters for a given patient.
 *
 * All volumes and clearances scale linearly with weight.
 * ke0 does not scale with weight (population estimate from Hull et al.).
 *
 * @param {Object} patient
 * @param {number} patient.weight - Total body weight in kg
 * @returns {Object} PK parameters with rate constants in per-minute units
 */
export function calcFentanylParams(patient) {
  const { weight } = patient;
  const s = weight / REF_WEIGHT;

  // Volumes (L) — linear weight scaling
  const V1 = 6.09  * s;   // Central compartment
  const V2 = 28.2  * s;   // Fast peripheral
  const V3 = 228   * s;   // Slow peripheral

  // Clearances (L/min) — linear weight scaling
  const CL = 0.789 * s;   // Metabolic clearance
  const Q2 = 1.435 * s;   // Inter-compartmental (fast)
  const Q3 = 0.196 * s;   // Inter-compartmental (slow)

  // Effect-site equilibration (min⁻¹) — no weight scaling
  const ke0 = 0.105;

  // Micro-rate constants (min⁻¹)
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k21 = Q2 / V2;
  const k13 = Q3 / V1;
  const k31 = Q3 / V3;

  return { V1, V2, V3, CL, Q2, Q3, ke0, k10, k12, k21, k13, k31 };
}
