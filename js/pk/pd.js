/**
 * pd.js — Pharmacodynamic Model for BIS Prediction
 * 
 * Implements the Eleveld 2018 sigmoid Emax model for predicting
 * Bispectral Index (BIS) from effect-site concentration (Ce).
 * 
 * BIS = baseline × (1 - Effect)
 * Effect = Ce^γ / (Ce^γ + Ce50^γ)
 * 
 * The Eleveld model uses a split-gamma approach:
 *   γ = γ1 (1.89) when Ce ≤ Ce50  (steeper below midpoint)
 *   γ = γ2 (1.47) when Ce > Ce50   (shallower above midpoint)
 * This accounts for the asymmetry of the concentration-effect curve.
 * Source: TivaTrainer DiY4 spreadsheet, confirmed by Eleveld 2018 BJA.
 */


/**
 * Calculate drug effect (0 to 1) from effect-site concentration.
 * 
 * Uses the split-gamma sigmoid Emax model:
 *   - Below Ce50: steepness = gamma1
 *   - At/above Ce50: steepness = gamma2
 * 
 * @param {number} Ce     - Effect-site concentration (μg/mL)
 * @param {number} Ce50   - Concentration for 50% effect (μg/mL)
 * @param {number} gamma1 - Hill coefficient below Ce50
 * @param {number} gamma2 - Hill coefficient at/above Ce50
 * @returns {number} Drug effect (0 = no effect, 1 = maximal effect)
 */
export function drugEffect(Ce, Ce50, gamma1, gamma2) {
  if (Ce <= 0) return 0;
  if (Ce50 <= 0) return 1;
  
  // Select gamma based on Ce vs Ce50
  // TivaTrainer: IF(Ce <= Ce50, 1.89, 1.47)
  const gamma = (Ce <= Ce50) ? gamma1 : gamma2;
  
  const ratio = Ce / Ce50;
  const rg = Math.pow(ratio, gamma);
  
  return rg / (1 + rg);
}


/**
 * Predict BIS from effect-site concentration.
 * 
 * @param {number} Ce       - Effect-site concentration (μg/mL)
 * @param {Object} pdParams - PD parameters { Ce50, gamma1, gamma2, BIS_baseline }
 * @returns {number} Predicted BIS (0–100 scale)
 */
export function predictBIS(Ce, pdParams) {
  const { Ce50, gamma1, gamma2, BIS_baseline } = pdParams;
  
  const effect = drugEffect(Ce, Ce50, gamma1, gamma2);
  const bis = BIS_baseline * (1 - effect);
  
  // Clamp to valid range
  return Math.max(0, Math.min(100, bis));
}


/**
 * Inverse BIS prediction: given a desired BIS, what Ce is needed?
 * 
 * Useful for setting initial targets (e.g., "what Ce gives BIS = 50?").
 * 
 * @param {number} targetBIS - Desired BIS value (0–100)
 * @param {Object} pdParams  - PD parameters
 * @returns {number} Required Ce (μg/mL), or 0 if BIS ≥ baseline
 */
export function ceForBIS(targetBIS, pdParams) {
  const { Ce50, gamma1, gamma2, BIS_baseline } = pdParams;
  
  if (targetBIS >= BIS_baseline) return 0;
  if (targetBIS <= 0) return Infinity;
  
  // effect = 1 - BIS/baseline
  const effect = 1 - (targetBIS / BIS_baseline);
  
  // effect = ratio^γ / (1 + ratio^γ)
  // ratio^γ = effect / (1 - effect)
  // ratio = (effect / (1 - effect))^(1/γ)
  // Ce = Ce50 × ratio
  
  // effect < 0.5  ↔  Ce < Ce50  (by definition of Ce50)
  // effect ≥ 0.5  ↔  Ce ≥ Ce50
  // So this branch is exact — no refinement needed.
  const gamma = (effect < 0.5) ? gamma1 : gamma2;
  
  const ratio = Math.pow(effect / (1 - effect), 1 / gamma);
  return Ce50 * ratio;
}


/**
 * Create a PD model instance with fixed parameters.
 * Provides convenience methods bound to the patient's PD parameters.
 * 
 * @param {Object} pdParams - { Ce50, gamma1, gamma2, BIS_baseline }
 * @returns {Object} PD model with bound methods
 */
export function createPDModel(pdParams) {
  const params = { ...pdParams };
  
  return {
    /**
     * Predict BIS from Ce.
     * @param {number} Ce - Effect-site concentration (μg/mL)
     * @returns {number} Predicted BIS
     */
    predict(Ce) {
      return predictBIS(Ce, params);
    },
    
    /**
     * Get drug effect (0–1) from Ce.
     * @param {number} Ce
     * @returns {number} Effect fraction
     */
    effect(Ce) {
      return drugEffect(Ce, params.Ce50, params.gamma1, params.gamma2);
    },
    
    /**
     * Calculate Ce needed for a target BIS.
     * @param {number} targetBIS
     * @returns {number} Required Ce (μg/mL)
     */
    ceForBIS(targetBIS) {
      return ceForBIS(targetBIS, params);
    },
    
    /**
     * Get the Ce50 for this patient (useful for display).
     */
    get Ce50() { return params.Ce50; },
    
    /**
     * Get the BIS baseline.
     */
    get baseline() { return params.BIS_baseline; },
    
    /**
     * Get all PD parameters.
     */
    get params() { return { ...params }; },
  };
}
