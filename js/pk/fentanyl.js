/**
 * fentanyl.js — Shafer 1990 Fentanyl PK Parameter Calculator
 *              with Shibutani 2004 pharmacokinetic mass correction
 *
 * 3-compartment model. Weight is the sole coparameter.
 * All volumes and clearances scale linearly with effective body weight.
 * Micro-rate constants are weight-independent (scaling factor cancels).
 *
 * For patients >80 kg, actual body weight is replaced by a
 * "pharmacokinetic mass" (Shibutani 2004) that accounts for the
 * nonlinear relationship between obesity and fentanyl distribution.
 *
 * Ce is in mcg/mL (canonical engine unit). Clinical display is ng/mL.
 * Therapeutic range: ~1–5 ng/mL (0.001–0.005 mcg/mL) intraoperative.
 *
 * References:
 *   Shafer SL, Varvel JR, Aziz N, Scott JC. "Pharmacokinetics of fentanyl
 *     administered by computer-controlled infusion pump."
 *     Anesthesiology 1990;73:1091–102.
 *   Shibutani K, Inchiosa MA Jr, Sawada K, Bairamian M. "Accuracy of
 *     pharmacokinetic models for predicting plasma fentanyl concentrations
 *     in lean and obese surgical patients: derivation of dosing weight
 *     ('pharmacokinetic mass')." Anesthesiology 2004;101(3):603–13.
 *
 * Rate constants are in per-MINUTE units (engine invariant).
 */

// Reference patient weight for parameter scaling
const REF_WEIGHT = 70; // kg

// Shafer 1990 population parameters at REF_WEIGHT
const REF_V1  =   7.35;        // L
const REF_V2  =  33.94;        // L
const REF_V3  = 275.62;        // L
const REF_CL  =  36.47 / 60;  // L/min  (36.47 L/h)
const REF_Q2  = 207.71 / 60;  // L/min  (207.71 L/h)
const REF_Q3  =  99.22 / 60;  // L/min  (99.22 L/h)
const KE0     = 0.1195;        // /min  (Shafer 1990)

/**
 * Shibutani 2004 pharmacokinetic mass.
 *
 * For TBW ≤ 80 kg, returns TBW unchanged.
 * For TBW > 80 kg, returns the PK mass from the nonlinear formula derived
 * in Shibutani 2004 (Anesthesiology 101:603), which corrects for the
 * over-prediction of fentanyl concentrations in obese patients.
 *
 * Key reference values: 83.3 kg at TBW=100, 99.5 kg at TBW=140.
 *
 * @param {number} tbw - Total body weight in kg
 * @returns {number} Effective pharmacokinetic weight in kg
 */
export function pkMass(tbw) {
  if (tbw <= 80) return tbw;
  return 52 / (1 + (196.4 * Math.exp(-0.025 * tbw) - 53.66) / 100);
}

/**
 * Calculate Shafer 1990 fentanyl PK parameters for a given patient.
 *
 * @param {Object} patient
 * @param {number} patient.weight - Total body weight in kg
 * @returns {Object} PK parameters with rate constants in per-minute units
 */
export function calcFentanylParams(patient) {
  const { weight } = patient;
  const s = pkMass(weight) / REF_WEIGHT;

  // Volumes (L) and clearances (L/min) — linear scaling with PK mass
  const V1 = REF_V1 * s;
  const V2 = REF_V2 * s;
  const V3 = REF_V3 * s;
  const CL = REF_CL * s;
  const Q2 = REF_Q2 * s;
  const Q3 = REF_Q3 * s;

  // Effect-site equilibration (min⁻¹) — not weight-scaled
  const ke0 = KE0;

  // Micro-rate constants (min⁻¹) — weight-independent (s cancels)
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k21 = Q2 / V2;
  const k13 = Q3 / V1;
  const k31 = Q3 / V3;

  return { V1, V2, V3, CL, Q2, Q3, ke0, k10, k12, k21, k13, k31 };
}
