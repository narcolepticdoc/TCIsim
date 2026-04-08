/**
 * ketamine.js — Domino 1982 / Navarrete 2024 Ketamine PK Parameter Calculator
 *
 * 3-compartment model. V1 scales linearly with total body weight at 63 mL/kg.
 * All five micro-rate constants are fixed population values (not weight-scaled).
 * V2, V3, and all clearances are derived from V1 and the fixed micro-constants,
 * and therefore scale proportionally with body weight.
 *
 * This is the parameterization validated in Absalom 2007 (Br J Anaesth 98:756),
 * which confirmed predictive performance of the Domino model in clinical TCI.
 *
 * ke0 estimated by Navarrete 2024 using NONMEM fitted to ANI response data
 * from IV ketamine boluses in awake adults (95% CI: 0.20–0.28 /min).
 *
 * Ce is in mcg/mL (canonical engine unit). Clinical display is ng/mL.
 * Therapeutic ranges: analgesia ~200–400 ng/mL, dissociation ~2000–4000 ng/mL.
 *
 * References:
 *   Domino EF et al. "Plasma levels of ketamine and two of its metabolites
 *     in surgical patients." Anesth Analg 1982;61(2):87–92.
 *   Absalom AR et al. "Predictive performance of the Domino, Hijazi, and
 *     Clements models during low-dose target-controlled ketamine infusions."
 *     Br J Anaesth 2007;98(5):756–65.
 *   Navarrete-Ibacache M et al. "Characterization of the temporal profile of
 *     the antinociceptive effects of an IV bolus of ketamine using the
 *     Analgesia Nociception Index (ANI) in non-anesthetized adult patients."
 *     J Clin Monit Comput 2025;39(2):349–354 (Epub 2024 Nov 15).
 *
 * Rate constants are in per-MINUTE units (engine invariant).
 */

/**
 * Display name shown in the ketamine drug card header.
 * Kept short; the UI appends the runtime concentration suffix.
 */
export const MODEL_NAME = 'Domino/Navarrete';

// Fixed micro-rate constants (min⁻¹) — population values, not weight-scaled
const K10 = 0.4381;  // Central elimination
const K12 = 0.5921;  // Central → fast peripheral
const K21 = 0.2470;  // Fast peripheral → central
const K13 = 0.5900;  // Central → slow peripheral
const K31 = 0.0146;  // Slow peripheral → central

// Effect-site equilibration (min⁻¹) — not weight-scaled (Navarrete 2024)
const KE0 = 0.238;

// V1 per-kg scaling factor (Domino 1982, confirmed Absalom 2007)
const V1_PER_KG = 0.063; // L/kg  (63 mL/kg)

/**
 * Calculate Domino/Navarrete ketamine PK parameters for a given patient.
 *
 * V1 scales linearly with weight. V2, V3, CL, Q2, Q3 are derived from
 * V1 and the fixed micro-constants (K10–K31), so they all scale with V1.
 *
 * @param {Object} patient
 * @param {number} patient.weight - Total body weight in kg
 * @returns {Object} PK parameters with rate constants in per-minute units
 */
export function calcKetamineParams(patient) {
  const { weight } = patient;

  // Central volume — sole direct weight coparameter
  const V1 = V1_PER_KG * weight;

  // Derived volumes from fixed micro-constants and V1
  const V2 = (K12 / K21) * V1;   // ≈ 2.3967 × V1
  const V3 = (K13 / K31) * V1;   // ≈ 40.411 × V1

  // Clearances derived from fixed micro-constants and V1 (L/min)
  const CL = K10 * V1;
  const Q2 = K12 * V1;
  const Q3 = K13 * V1;

  return {
    V1, V2, V3, CL, Q2, Q3,
    ke0: KE0,
    // Micro-constants returned directly — they are the fixed population values
    k10: K10, k12: K12, k21: K21, k13: K13, k31: K31,
  };
}
