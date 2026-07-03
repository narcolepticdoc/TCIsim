/**
 * engine.js — 3-Compartment + Effect-Site PK Engine
 * 
 * Solves the linear ODE system exactly using matrix exponential
 * for constant infusion rate intervals. Falls back to Euler
 * integration for quick previews.
 * 
 * State vector: x = [A1, A2, A3, Ce]
 *   A1 = drug amount in central compartment (mg)
 *   A2 = drug amount in fast peripheral (mg)
 *   A3 = drug amount in slow peripheral (mg)
 *   Ce = effect-site concentration (μg/mL)
 * 
 * Concentrations:
 *   Cp = A1/V1, C2 = A2/V2, C3 = A3/V3
 */

import { mat4, mulVec4, scale4, inv4, expm4 } from '../util/math.js';

/**
 * Build the 4×4 system matrix A for the PK-PD model.
 * 
 * dx/dt = A·x + B·u
 * 
 * where x = [A1, A2, A3, Ce]ᵀ, u = R(t) infusion rate (mg/min)
 * 
 * @param {Object} params - PK parameters from eleveld.js
 * @returns {Float64Array} 4×4 system matrix in row-major order
 */
export function buildSystemMatrix(params) {
  const { V1, V2, V3, CL, Q2, Q3, ke0 } = params;
  
  const A = mat4();
  
  // Row 0: dA1/dt = -(CL+Q2+Q3)/V1 · A1 + Q2/V2 · A2 + Q3/V3 · A3 + R(t)
  A[0]  = -(CL + Q2 + Q3) / V1;  // A1 coefficient
  A[1]  = Q2 / V2;                // A2 coefficient
  A[2]  = Q3 / V3;                // A3 coefficient
  A[3]  = 0;                      // Ce coefficient
  
  // Row 1: dA2/dt = Q2/V1 · A1 - Q2/V2 · A2
  A[4]  = Q2 / V1;
  A[5]  = -Q2 / V2;
  A[6]  = 0;
  A[7]  = 0;
  
  // Row 2: dA3/dt = Q3/V1 · A1 - Q3/V3 · A3
  A[8]  = Q3 / V1;
  A[9]  = 0;
  A[10] = -Q3 / V3;
  A[11] = 0;
  
  // Row 3: dCe/dt = ke0 · (A1/V1 - Ce) = ke0/V1 · A1 - ke0 · Ce
  // Note: Ce is driven by concentration C1 = A1/V1, not amount A1
  A[12] = ke0 / V1;
  A[13] = 0;
  A[14] = 0;
  A[15] = -ke0;
  
  return A;
}

/**
 * Build the input vector B.
 * B = [1, 0, 0, 0]ᵀ — drug enters central compartment only.
 * u = R(t) in mg/min.
 */
export function buildInputVector() {
  return new Float64Array([1, 0, 0, 0]);
}


/**
 * Validate PK parameters for plausible per-minute units.
 * Catches the most dangerous silent error: per-second values passed to our
 * per-minute engine (concentrations decay 60x too fast or slow).
 * 
 * @param {Object} p - PK parameters
 * @returns {{ valid: boolean, warnings: string[] }}
 */
export function validateParams(p) {
  const warnings = [];
  const required = ['V1', 'V2', 'V3', 'CL', 'Q2', 'Q3', 'ke0'];

  for (const k of required) {
    if (p[k] == null || typeof p[k] !== 'number' || !isFinite(p[k])) {
      warnings.push(`Missing or invalid parameter: ${k}`);
    }
  }
  if (warnings.length > 0) return { valid: false, warnings };

  for (const k of required) {
    if (p[k] <= 0) warnings.push(`${k} must be positive (got ${p[k]})`);
  }

  // Plausibility for propofol per-minute units (covers neonates to morbidly obese).
  // Per-second values would be ~60x smaller — easily caught.
  if (p.CL < 0.1)  warnings.push(`CL=${p.CL.toFixed(4)} L/min seems too low. If per-second, multiply by 60. Expected: 0.3–4.5 L/min.`);
  if (p.Q2 < 0.1)  warnings.push(`Q2=${p.Q2.toFixed(4)} L/min seems too low. Per-second values need ×60.`);
  if (p.Q3 < 0.05) warnings.push(`Q3=${p.Q3.toFixed(4)} L/min seems too low. Per-second values need ×60.`);
  if (p.ke0 < 0.01) warnings.push(`ke0=${p.ke0.toFixed(6)} min⁻¹ seems too low. If per-second, multiply by 60. Expected: 0.05–0.5 min⁻¹.`);

  const k10 = p.CL / p.V1;
  if (k10 > 2.0) warnings.push(`Derived k10=${k10.toFixed(3)} min⁻¹ is unusually high (t½=${(0.693/k10).toFixed(1)} min).`);

  return { valid: warnings.length === 0, warnings };
}

/**
 * Create a PK engine instance for a given set of parameters.
 * 
 * @param {Object} params - PK parameters from calcEleveldParams()
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.skipValidation=false] - Skip parameter validation
 * @returns {Object} Engine with state and methods
 */
export function createEngine(params, opts = {}) {
  if (!opts.skipValidation) {
    const check = validateParams(params);
    if (!check.valid) {
      console.warn('[PK Engine] Parameter validation warnings:');
      check.warnings.forEach(w => console.warn('  ⚠', w));
    }
  }

  const A = buildSystemMatrix(params);
  const B = buildInputVector();
  const { V1, V2, V3 } = params;
  
  // State vector: [A1, A2, A3, Ce]
  let state = new Float64Array(4);
  
  // Pre-computed matrix exponentials for common time steps (cached)
  const expmCache = new Map();

  // A is constant for the engine's lifetime; its inverse is too. Computed
  // lazily on the first infused advance() — planners call advance() tens of
  // thousands of times per plan, so recomputing per call is pure waste.
  // `undefined` = not yet computed; `null` = singular (Euler fallback).
  let AinvCached;
  
  /**
   * Get or compute expm(A·dt) for a given dt.
   * Caches results for reuse at common intervals.
   */
  function getExpm(dt) {
    // Round to nearest 0.001 for cache key
    const key = Math.round(dt * 1000);
    if (expmCache.has(key)) return expmCache.get(key);
    
    const Adt = scale4(A, dt);
    const eAdt = expm4(Adt);
    
    // Only cache common intervals to avoid memory bloat
    if (key === 1000 || key === 10000 || key === 100 || key === 60000) {
      expmCache.set(key, eAdt);
    }
    return eAdt;
  }
  
  /**
   * Advance state by dt seconds under constant infusion rate R (mg/min).
   * Uses exact matrix exponential solution.
   * 
   * x(t+dt) = expm(A·dt) · x(t) + A⁻¹ · (expm(A·dt) - I) · B · R
   * 
   * @param {number} dt - Time step in MINUTES
   * @param {number} R  - Infusion rate in mg/min
   */
  function advance(dt, R) {
    if (dt <= 0) return;
    
    const eAdt = getExpm(dt);
    
    // Homogeneous part: expm(A·dt) · x
    const xHom = mulVec4(eAdt, state);
    
    if (R === 0) {
      // No infusion — just the homogeneous solution
      state = xHom;
      return;
    }
    
    // Particular part: A⁻¹ · (expm(A·dt) - I) · B · R
    // = A⁻¹ · (eAdt - I) · B · R
    if (AinvCached === undefined) AinvCached = inv4(A);
    const Ainv = AinvCached;
    if (!Ainv) {
      // Fallback to Euler if A is singular (shouldn't happen)
      advanceEuler(dt, R, 0.01);
      return;
    }

    // Since B = [1,0,0,0], only column 0 of A⁻¹·(eAdt - I) matters:
    // particular[i] = Σ_j Ainv[i][j] · (eAdt[j][0] - I[j][0]) · R
    for (let i = 0; i < 4; i++) {
      let sum = 0;
      for (let j = 0; j < 4; j++) {
        sum += Ainv[i * 4 + j] * (eAdt[j * 4 + 0] - (j === 0 ? 1 : 0));
      }
      state[i] = xHom[i] + sum * R;
    }
  }
  
  /**
   * Euler forward integration (backup / preview method).
   * 
   * @param {number} dt    - Total time in minutes
   * @param {number} R     - Infusion rate (mg/min)
   * @param {number} step  - Euler step size (minutes), default 1/60 (1 second)
   */
  function advanceEuler(dt, R, step = 1 / 60) {
    const nSteps = Math.ceil(dt / step);
    const actualStep = dt / nSteps;
    
    for (let n = 0; n < nSteps; n++) {
      const dx = new Float64Array(4);
      // dx = A·x + B·R
      for (let i = 0; i < 4; i++) {
        let sum = 0;
        for (let j = 0; j < 4; j++) {
          sum += A[i * 4 + j] * state[j];
        }
        dx[i] = sum + B[i] * R;
      }
      for (let i = 0; i < 4; i++) {
        state[i] += actualStep * dx[i];
      }
    }
  }
  
  /**
   * Get current concentrations.
   * 
   * @returns {Object} { Cp, C2, C3, Ce, A1, A2, A3 }
   */
  function getConcentrations() {
    return {
      Cp: state[0] / V1,     // Plasma (central)
      C2: state[1] / V2,     // Fast peripheral
      C3: state[2] / V3,     // Slow peripheral
      Ce: state[3],           // Effect-site (already a concentration)
      A1: state[0],           // Amount in central (mg)
      A2: state[1],           // Amount in fast peripheral (mg)
      A3: state[2],           // Amount in slow peripheral (mg)
    };
  }
  
  /**
   * Predict Ce at a future time under given infusion rate,
   * WITHOUT modifying the current state.
   * 
   * @param {number} dt - Time ahead in minutes
   * @param {number} R  - Infusion rate (mg/min)
   * @returns {number} Predicted Ce
   */
  function predictCe(dt, R) {
    const savedState = new Float64Array(state);
    advance(dt, R);
    const ce = state[3];
    state = savedState; // Restore
    return ce;
  }
  
  /**
   * Predict full concentrations at a future time without modifying state.
   */
  function predictConcentrations(dt, R) {
    const savedState = new Float64Array(state);
    advance(dt, R);
    const conc = getConcentrations();
    state = savedState;
    return conc;
  }
  
  /**
   * Reset state to zero (new simulation).
   */
  function reset() {
    state = new Float64Array(4);
    expmCache.clear();
  }
  
  /**
   * Get a snapshot of the current state vector.
   */
  function getState() {
    return new Float64Array(state);
  }
  
  /**
   * Restore state from a snapshot.
   */
  function setState(s) {
    state = new Float64Array(s);
  }
  
  /**
   * Get the system matrix (for debugging/display).
   */
  function getSystemMatrix() {
    return new Float64Array(A);
  }
  
  return {
    advance,
    advanceEuler,
    getConcentrations,
    predictCe,
    predictConcentrations,
    reset,
    getState,
    setState,
    getSystemMatrix,
    get params() { return params; },
  };
}
