/**
 * fentanyl.js — Shafer 1990 Fentanyl PK Parameter Calculator
 *              with Shibutani 2004 pharmacokinetic mass correction
 *
 * 3-compartment model. Weight is the sole coparameter.
 * All volumes and clearances scale linearly with effective body weight.
 * Micro-rate constants are weight-independent (scaling factor cancels).
 *
 * The Shibutani 2004 PK mass correction applies only to patients meeting
 * both entry criteria of the derivation study: TBW ≥ 85 kg AND BMI > 30.
 * Patients who are tall and lean (high TBW, low BMI) use TBW directly.
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
 * Shibutani 2004 pharmacokinetic mass formula.
 *
 * Applies only when TBW ≥ 85 kg AND BMI > 30 — the inclusion criteria for the
 * obese group in the Shibutani 2004 derivation study. Outside those bounds,
 * TBW is returned unchanged.
 *
 * Key reference values (obese patients): 83.3 kg at TBW=100, 99.5 kg at TBW=140.
 *
 * @param {number} tbw - Total body weight in kg
 * @param {number} bmi - Body mass index (kg/m²)
 * @returns {number} Effective pharmacokinetic weight in kg
 */
export function pkMass(tbw, bmi) {
  if (tbw >= 85 && bmi > 30) {
    return 52 / (1 + (196.4 * Math.exp(-0.025 * tbw) - 53.66) / 100);
  }
  return tbw;
}

/**
 * Calculate Shafer 1990 fentanyl PK parameters for a given patient.
 *
 * @param {Object} patient
 * @param {number} patient.weight - Total body weight in kg
 * @param {number} patient.height - Height in cm
 * @returns {Object} PK parameters with rate constants in per-minute units
 */
export function calcFentanylParams(patient) {
  const { weight, height } = patient;
  const heightM = height / 100;
  const bmi = weight / (heightM * heightM);
  const s = pkMass(weight, bmi) / REF_WEIGHT;

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
