/**
 * PK Simulation Engine
 * 3-compartment model with effect-site compartment
 * Euler integration at 1-second resolution
 * 
 * State: [A1, A2, A3, Ce] amounts in mg, Ce in mcg/ml
 * Rate input: mcg/kg/min → converted to mg/min for integration
 */

export class PKEngine {
  constructor(model, weightKg) {
    this.model = model;       // EleveldModel instance
    this.weight = weightKg;
    this.p = model.getParams();
    this.reset();
  }

  reset() {
    // Compartment amounts in mg
    this.A1 = 0;
    this.A2 = 0;
    this.A3 = 0;
    this.Ce = 0;  // mcg/ml (effect site concentration)
    this.timeMin = 0;
  }

  /**
   * Step simulation forward by dt minutes
   * @param {number} rateUgKgMin - infusion rate in mcg/kg/min
   * @param {number} bolusMg - bolus dose in mg (added instantaneously at start of step)
   * @param {number} dtMin - time step in minutes
   */
  step(rateUgKgMin, bolusMg = 0, dtMin = 1 / 60) {
    const { k10, k12, k21, k13, k31, ke0, V1 } = this.p;

    // Add bolus to central compartment
    if (bolusMg > 0) {
      this.A1 += bolusMg;
    }

    // Infusion rate: mcg/kg/min → mg/min
    const rateMgMin = (rateUgKgMin * this.weight) / 1000;

    // Euler integration
    const dA1 = rateMgMin - k10 * this.A1 - k12 * this.A1 + k21 * this.A2 - k13 * this.A1 + k31 * this.A3;
    const dA2 = k12 * this.A1 - k21 * this.A2;
    const dA3 = k13 * this.A1 - k31 * this.A3;

    // Cp in mcg/ml = (mg in V1) / (L) = mg/L → mcg/ml (same units)
    const Cp = this.A1 / V1;

    // Effect site: dCe/dt = ke0 * (Cp - Ce)
    const dCe = ke0 * (Cp - this.Ce);

    this.A1 += dA1 * dtMin;
    this.A2 += dA2 * dtMin;
    this.A3 += dA3 * dtMin;
    this.Ce += dCe * dtMin;

    // Clamp negatives (numerical safety)
    this.A1 = Math.max(0, this.A1);
    this.A2 = Math.max(0, this.A2);
    this.A3 = Math.max(0, this.A3);
    this.Ce = Math.max(0, this.Ce);

    this.timeMin += dtMin;
  }

  getCp() {
    return this.A1 / this.p.V1;  // mcg/ml
  }

  getCe() {
    return this.Ce;  // mcg/ml
  }

  getState() {
    return {
      timeMin: this.timeMin,
      A1: this.A1, A2: this.A2, A3: this.A3,
      Cp: this.getCp(),
      Ce: this.Ce,
    };
  }

  setState(state) {
    this.timeMin = state.timeMin;
    this.A1 = state.A1;
    this.A2 = state.A2;
    this.A3 = state.A3;
    this.Ce = state.Ce;
  }

  cloneState() {
    return { ...this.getState() };
  }
}

/**
 * Run a full simulation from t=0 given a list of events
 * Returns array of {timeMin, Cp, Ce} at 10-second resolution
 * 
 * events: [{timeMin, type, value}]
 *   type 'rate'   → value = mcg/kg/min
 *   type 'bolus'  → value = mg
 */
export function simulateTrace(model, weightKg, events, totalMin, dtSec = 10) {
  const engine = new PKEngine(model, weightKg);
  const dtMin = dtSec / 60;
  const steps = Math.ceil(totalMin / dtMin);
  const trace = [];

  // Sort events by time
  const sorted = [...events].sort((a, b) => a.timeMin - b.timeMin);
  let currentRate = 0;
  let eventIdx = 0;

  for (let i = 0; i <= steps; i++) {
    const tMin = i * dtMin;

    // Apply any events that fire at or before this time
    while (eventIdx < sorted.length && sorted[eventIdx].timeMin <= tMin) {
      const ev = sorted[eventIdx];
      if (ev.type === 'rate') {
        currentRate = ev.value;
      } else if (ev.type === 'bolus') {
        engine.A1 += ev.value;
      }
      eventIdx++;
    }

    trace.push({
      timeMin: tMin,
      Cp: engine.getCp(),
      Ce: engine.getCe(),
    });

    engine.step(currentRate, 0, dtMin);
  }

  return trace;
}
