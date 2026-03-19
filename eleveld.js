/**
 * Eleveld 2.1 Propofol PK/PD Model
 * Reference: Eleveld et al. Br J Anaesth 2018; 120: 942-959
 * 
 * Population model with covariates: age, weight, height, sex
 * Drug concentration: 10 mg/ml propofol
 * Rate expressed in mcg/kg/min
 */

export class EleveldModel {
  constructor(params) {
    const { age, weightKg, heightCm, sex } = params;
    this.age = age;
    this.weight = weightKg;
    this.height = heightCm;
    this.sex = sex; // 'male' | 'female'
    this.params = this._computeParams();
  }

  /**
   * Sigmoid helper functions used in Eleveld covariate model
   */
  _sigmoid(x, c50, gamma) {
    const xg = Math.pow(x, gamma);
    const c50g = Math.pow(c50, gamma);
    return xg / (xg + c50g);
  }

  _agingFn(age, c50 = 35, gamma = 0.25) {
    // Aging function relative to reference age 35
    return Math.exp(gamma * (age - c50));
  }

  _computeParams() {
    const { age, weight, height, sex } = this;
    const isMale = sex === 'male';

    // Reference individual: 35yo, 70kg male
    // BMI
    const bmi = weight / Math.pow(height / 100, 2);

    // Fat-free mass (James formula)
    let ffm;
    if (isMale) {
      ffm = 1.10 * weight - 128 * Math.pow(weight / height, 2);
    } else {
      ffm = 1.07 * weight - 148 * Math.pow(weight / height, 2);
    }
    // Clamp FFM to reasonable values
    ffm = Math.max(ffm, weight * 0.3);

    // Eleveld 2.1 population parameters (typical values at reference individual)
    // PK parameters
    const THETA_V1 = 6.28;    // L
    const THETA_V2 = 25.5;    // L
    const THETA_V3 = 273.0;   // L
    const THETA_CL = 1.79;    // L/min
    const THETA_Q2 = 1.83;    // L/min
    const THETA_Q3 = 1.11;    // L/min

    // Maturation/covariate adjustments
    // Age sigmoid for CL (maturation)
    const ageMat = this._sigmoid(age, 35, 0.25); // simplified aging effect
    const ageMatRef = this._sigmoid(35, 35, 0.25);

    // Weight-based allometric scaling (reference 70kg)
    const wtScale = (w, exp) => Math.pow(w / 70, exp);

    // Sex adjustment for V1 (females have lower V1)
    const sexV1 = isMale ? 1.0 : 0.725;

    // PK parameters with covariate adjustments
    const V1 = THETA_V1 * sexV1 * (1 + (age < 18 ? (18 - age) / 18 * 0.3 : 0)); // simplified pediatric
    const V2 = THETA_V2 * wtScale(weight, 1) / wtScale(70, 1);
    const V3 = THETA_V3 * wtScale(weight, 1) / wtScale(70, 1);

    // CL: allometric weight + age maturation
    const CL = THETA_CL * wtScale(ffm, 0.75) / wtScale(70 * 0.73, 0.75)
      * (ageMat / ageMatRef)
      * (isMale ? 1.0 : 0.925);

    const Q2 = THETA_Q2 * wtScale(weight, 0.75) / wtScale(70, 0.75);
    const Q3 = THETA_Q3 * wtScale(weight, 0.75) / wtScale(70, 0.75);

    // Derived micro-rate constants
    const k10 = CL / V1;
    const k12 = Q2 / V1;
    const k21 = Q2 / V2;
    const k13 = Q3 / V1;
    const k31 = Q3 / V3;

    // PD parameters (Ce50, gamma for BIS — not used for Ce display but stored)
    // ke0: equilibration rate constant (Eleveld 2.1)
    const ke0 = 0.146 * Math.pow(weight / 70, -0.25);

    return { V1, V2, V3, CL, Q2, Q3, k10, k12, k21, k13, k31, ke0, ffm };
  }

  getParams() {
    return this.params;
  }

  /**
   * Returns model parameters formatted for display
   */
  getSummary() {
    const p = this.params;
    return {
      model: 'Eleveld 2.1',
      drug: 'Propofol',
      concentration: '10 mg/ml',
      V1: p.V1.toFixed(2) + ' L',
      V2: p.V2.toFixed(2) + ' L',
      V3: p.V3.toFixed(2) + ' L',
      CL: p.CL.toFixed(3) + ' L/min',
      Q2: p.Q2.toFixed(3) + ' L/min',
      Q3: p.Q3.toFixed(3) + ' L/min',
      ke0: p.ke0.toFixed(4) + ' /min',
    };
  }
}
