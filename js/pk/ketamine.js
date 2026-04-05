/**
 * ketamine.js — Domino/Clements 1982 Ketamine PK Parameter Calculator
 *
 * 2-compartment model implemented as a 3-compartment model with a
 * sink V3 (large volume, minimal Q3) so the generic 4×4 engine matrix
 * remains well-conditioned and non-singular.
 *
 * Ce is in mcg/mL (canonical engine unit).
 * Clinical ranges: analgesia ~0.2–0.4 mcg/mL, dissociation ~2–4 mcg/mL.
 *
 * References:
 *   Domino EF et al. Clin Pharmacol Ther 1982;36(5):645-53.
 *   Clements JA, Nimmo WS. Br J Anaesth 1981;53(1):27-30.
 *
 * Note: Q3 is set to the engine's minimum plausible value (0.05 L/min).
 * k31 = Q3/V3 = 0.05/1000 = 5×10⁻⁵ min⁻¹ — effectively a one-way sink.
 * This is intentional (2-compartment approximation), not a unit error.
 *
 * Rate constants are in per-MINUTE units (engine invariant).
 */

/**
 * Calculate Domino 1982 ketamine PK parameters for a given patient.
 *
 * V1, V2, CL, Q2 scale linearly with weight.
 * V3 is a fixed large sink (1000 L); Q3 and ke0 are population constants.
 *
 * @param {Object} patient
 * @param {number} patient.weight - Total body weight in kg
 * @returns {Object} PK parameters with rate constants in per-minute units
 */
export function calcKetamineParams(patient) {
  const { weight } = patient;

  // Volumes (L)
  const V1 = 0.18  * weight;  // Central compartment (0.18 L/kg)
  const V2 = 0.65  * weight;  // Fast peripheral (0.65 L/kg)
  const V3 = 1000;            // Sink compartment — fixed large value

  // Clearances (L/min)
  const CL = 0.019 * weight;  // Metabolic clearance (0.019 L/min/kg)
  const Q2 = 0.074 * weight;  // Inter-compartmental fast (0.074 L/min/kg)
  const Q3 = 0.05;            // Minimal slow peripheral (keeps engine valid)

  // Effect-site equilibration (min⁻¹) — approximate from literature
  const ke0 = 0.5;

  // Micro-rate constants (min⁻¹)
  const k10 = CL / V1;
  const k12 = Q2 / V1;
  const k21 = Q2 / V2;
  const k13 = Q3 / V1;
  const k31 = Q3 / V3;  // = 5×10⁻⁵ min⁻¹ — negligible

  return { V1, V2, V3, CL, Q2, Q3, ke0, k10, k12, k21, k13, k31 };
}
