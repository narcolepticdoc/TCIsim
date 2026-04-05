/**
 * eleveld.js — Eleveld 2018 Propofol PK-PD Parameter Calculator
 * 
 * Aligned to match SimTIVA (luktinghin/simtiva) pharmacology.js exactly.
 * Cross-validated at 0.0000% across 7 demographic test cases.
 * 
 * Note on provenance: We validated against SimTIVA's code directly.
 * Separately, Frank Engbers (TivaTrainer developer) states on eurosiva.eu
 * that TivaTrainer's calculations were checked with Douglas Eleveld after
 * a typo was found in the original publication. We have not independently
 * verified that SimTIVA and TivaTrainer produce identical results.
 * 
 * Reference: Eleveld DJ, Colin P, Absalom AR, Struys MMRF.
 *   BJA 2018;120(5):942-959. Corrigendum: BJA 2018;121(2):519.
 * 
 * Rate constants are output in per-MINUTE units (our engine uses minutes).
 * SimTIVA converts to per-second internally; we do not.
 * 
 * PEDIATRIC SUPPORT:
 *   This calculator fully supports pediatric patients including neonates.
 *   The Eleveld model was validated from 27 weeks PMA to 88 years (0.68–160 kg).
 *   The maturation functions (fclmaturation for CL, fq3maturation for Q2/Q3)
 *   handle the neonatal-to-adult transition. The Al-Sallami FFM equation
 *   includes age-dependent sigmoid terms that model pediatric body composition.
 * 
 *   No code changes are needed here for pediatric use. The only requirement
 *   is a UI that can:
 *     1. Accept age in sub-year units (days, weeks, months) and convert to
 *        decimal years for the `age` parameter.
 *     2. Accept a direct PMA input (in weeks) for premature neonates, passed
 *        as the `pma` field in the patient object. Without this, PMA defaults
 *        to age × 52.1429 + 40, which assumes term birth at 40 weeks.
 *        Example: a 28-week preemie now 4 weeks old has PMA=32, but the
 *        default derivation would incorrectly compute PMA≈44.
 * 
 *   SimTIVA handles this identically: paedi_mode enables a PMA input field,
 *   otherwise it uses the same age-to-PMA conversion we do.
 */

// ============================================================
// HELPER FUNCTIONS (matched to SimTIVA's fcentral, fageing, etc.)
// ============================================================

/**
 * Sigmoid function: x^γ / (x^γ + E50^γ)
 * SimTIVA: fsigmoid(x,y,z)
 */
function fsigmoid(x, e50, gamma) {
  return Math.pow(x, gamma) / (Math.pow(x, gamma) + Math.pow(e50, gamma));
}

/**
 * Central volume weight scaling (sigmoid with E50=33.6, hill=1)
 * SimTIVA: fcentral(x)
 */
function fcentral(x) {
  return fsigmoid(x, 33.6, 1);
}

/**
 * Aging exponential: exp(coefficient * (age - 35))
 * SimTIVA: fageing(x) where x is the coefficient
 */
function fageing(coefficient, age) {
  return Math.exp(coefficient * (age - 35));
}

/**
 * CL maturation: sigmoid of PMA with E50=42.3, hill=9.06
 * SimTIVA: fclmaturation(x) where x is PMA in weeks
 */
function fclmaturation(pmaWeeks) {
  return fsigmoid(pmaWeeks, 42.3, 9.06);
}

/**
 * Q3 maturation: sigmoid of (age_weeks + 40) with E50=68.3, hill=1
 * SimTIVA: fq3maturation(x) where x is age in WEEKS (not years!)
 * Note: adds 40 internally (approximating PMA)
 */
function fq3maturation(ageWeeks) {
  return fsigmoid(ageWeeks + 40, 68.3, 1);
}

/**
 * Fat-Free Mass — Al-Sallami equation
 * SimTIVA: fffm() — uses global gender (0=male, 1=female)
 * 
 * @param {number} weight - kg
 * @param {number} height - cm
 * @param {number} age    - years
 * @param {boolean} male
 * @returns {number} FFM in kg
 */
export function fatFreeMass(weight, height, age, male) {
  const bmi = weight / Math.pow(height / 100, 2);
  if (male) {
    return (0.88 + (1 - 0.88) / (1 + Math.pow(age / 13.4, -12.7))) *
           ((9270 * weight) / (6680 + 216 * bmi));
  } else {
    return (1.11 + (1 - 1.11) / (1 + Math.pow(age / 7.1, -1.1))) *
           ((9270 * weight) / (8780 + 244 * bmi));
  }
}

// Weeks per year — SimTIVA uses 52.1429
const WEEKS_PER_YEAR = 52.1429;

// FFM for the reference individual (35y, 70kg, 170cm, male)
// BMI = 70 / (1.7^2) = 24.22145
// SimTIVA hardcodes this: (0.88 + (1-0.88)/(1+Math.pow((35/13.4),-12.7))) * ((9270*70)/(6680+216*24.22145))
const FFM_REF = (0.88 + (1 - 0.88) / (1 + Math.pow(35 / 13.4, -12.7))) *
                ((9270 * 70) / (6680 + 216 * 24.22145));


// ============================================================
// MAIN PARAMETER CALCULATOR
// ============================================================

/**
 * Calculate Eleveld 2018 PK parameters for a given patient.
 * Exactly matches SimTIVA pharmacology.js lines 5762-5833.
 * 
 * @param {Object} patient
 * @param {number} patient.age     - Age in years
 * @param {number} patient.weight  - Total body weight in kg
 * @param {number} patient.height  - Height in cm
 * @param {boolean} patient.male   - True if male
 * @param {boolean} patient.opioid - True if concomitant opioid
 * @param {number} [patient.pma]   - Post-menstrual age in weeks (for neonates)
 * @returns {Object} PK-PD parameters with rate constants in per-minute units
 */
export function calcEleveldParams(patient) {
  const { age, weight, height, male, opioid, ce50OpioidCorrection, pma: pmaInput } = patient;

  const bmi = weight / Math.pow(height / 100, 2);
  const ffm = fatFreeMass(weight, height, age, male);

  // PMA in weeks — SimTIVA: age * 52.1429 + 40
  const PMA = (pmaInput != null && pmaInput > 0)
    ? pmaInput
    : age * WEEKS_PER_YEAR + 40;

  const opioidFlag = opioid ? 1 : 0;

  // Reference PMA for 35-year-old
  const PMA_REF = 35 * WEEKS_PER_YEAR + 40;

  // ---- V1: Central volume ----
  // SimTIVA: 6.28 * fcentral(mass) / fcentral(70)
  const V1 = 6.28 * fcentral(weight) / fcentral(70);

  // ---- V2: Fast peripheral volume ----
  // SimTIVA: 25.5 * mass/70 * fageing(-0.0156)
  const V2 = 25.5 * (weight / 70) * fageing(-0.0156, age);

  // ---- V3: Slow peripheral volume ----
  // SimTIVA: 273 * fffm()/ffmref [* exp(-0.0138*age) if opioid]
  let V3;
  if (opioid) {
    V3 = 273 * (ffm / FFM_REF) * Math.exp(-0.0138 * age);
  } else {
    V3 = 273 * (ffm / FFM_REF);
  }

  // ---- CL: Metabolic clearance ----
  // SimTIVA: Male=1.79, Female=2.1 (separate base values, not a multiplier)
  // * (mass/70)^0.75 * (fclmaturation(PMA)/fclmaturation(35*weeks+40))
  // [* exp(-0.00286*age) if opioid]
  const clBase = male ? 1.79 : 2.1;
  let CL = clBase * Math.pow(weight / 70, 0.75) *
           (fclmaturation(PMA) / fclmaturation(PMA_REF));
  if (opioid) {
    CL *= Math.exp(-0.00286 * age);
  }

  // ---- Q2: Inter-compartmental clearance (fast) ----
  // SimTIVA: 1.75 * (v2/v2ref)^0.75 * (1 + 1.3*(1 - fq3maturation(age*weeks)))
  const V2_REF = 25.5;
  const Q2 = 1.75 * Math.pow(V2 / V2_REF, 0.75) *
             (1 + 1.3 * (1 - fq3maturation(age * WEEKS_PER_YEAR)));

  // ---- Q3: Inter-compartmental clearance (slow) ----
  // SimTIVA: 1.11 * (v3/v3ref)^0.75 * (fq3maturation(age*weeks)/fq3maturation(35*weeks))
  const V3_REF = 273;
  const Q3 = 1.11 * Math.pow(V3 / V3_REF, 0.75) *
             (fq3maturation(age * WEEKS_PER_YEAR) / fq3maturation(35 * WEEKS_PER_YEAR));

  // ---- ke0: Effect-site equilibration ----
  // SimTIVA: 0.146 * (mass/70)^(-0.25)
  const ke0 = 0.146 * Math.pow(weight / 70, -0.25);

  // ---- Micro-rate constants (per minute) ----
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k21 = Q2 / V2;
  const k13 = Q3 / V1;
  const k31 = Q3 / V3;

  // ---- PD parameters ----
  // Ce50: Eleveld 2018 Table 3, E50 = 3.08 * Fage(-0.00635)
  // Confirmed against TivaTrainer DiY4 (cell G22) and Vandemoortele 2022 review.
  // Previous value -0.0517 was ln(2)/13.4 — a copy-paste error from Al-Sallami FFM.
  //
  // Opioid correction (exp(-0.567)): present in the Eleveld 2018 paper, but NOT
  // implemented by SimTIVA. Disabled by default (ce50OpioidCorrection=false) to
  // match SimTIVA. Enable via the setup UI toggle to use the paper formula.
  const ce50OpioidFlag = (opioid && ce50OpioidCorrection) ? 1 : 0;
  const Ce50 = 3.08 * Math.exp(-0.00635 * (age - 35)) *
               Math.exp(-0.567 * ce50OpioidFlag);

  // Split-gamma: asymmetric sigmoid Emax curve.
  // TivaTrainer DiY4: IF(Ce <= Ce50, 1.89, 1.47)
  // gamma1 is used when Ce <= Ce50 (steeper below midpoint)
  // gamma2 is used when Ce > Ce50 (shallower above midpoint)
  const gamma1 = 1.89;
  const gamma2 = 1.47;
  const BIS_baseline = 93.0;

  return {
    // Patient demographics (echo)
    patient: { age, weight, height, male, opioid, bmi, ffm, pma: PMA },

    // PK volumes (L)
    V1, V2, V3,

    // PK clearances (L/min)
    CL, Q2, Q3,

    // Effect-site (min⁻¹)
    ke0,

    // Micro-rate constants (min⁻¹)
    k10, k12, k21, k13, k31,

    // PD parameters
    Ce50, gamma1, gamma2, BIS_baseline,
  };
}
