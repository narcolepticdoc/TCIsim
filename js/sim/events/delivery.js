/**
 * events/delivery.js — Bolus delivery calculations.
 *
 * Pure helpers that compute how a bolus event is physically delivered
 * by the pump, and advance an engine through a bolus. Used by replay,
 * query, and actions modules.
 */

// PUSH_RATE_MLH: rapid IV push delivery rate (1 mL/s = 3600 mL/h).
// Push duration is volume-derived with a 1-second minimum.
// Pump boluses use the drug's configured bolusRateMlH (typically 750 mL/h)
// with a 3-second minimum — a different, slower rate by design.
const PUSH_RATE_MLH = 3600;

export function createDelivery(state) {
  /**
   * Compute bolus delivery duration and infusion rate for a bolus event.
   * @param {Object} evt - bolus event
   * @returns {{ duration: number, rate: number }} duration in minutes, rate in mg/min
   */
  function getBolusDelivery(evt) {
    const cfg = state.drugConfigs[evt.drug];
    const concentration = cfg?.concentration || 10;
    const volumeMl = evt.value / concentration;
    if (evt.deliveryMode === 'push') {
      // Rapid IV push: volume-derived at 3600 mL/h (1 mL/s), minimum 1 second
      const duration = Math.max(1 / 60, volumeMl / PUSH_RATE_MLH * 60);
      return { duration, rate: evt.value / duration };
    }
    if (!cfg || !cfg.bolusRateMlH) {
      // Fallback: pump rate unknown, use push rate
      const duration = Math.max(1 / 60, volumeMl / PUSH_RATE_MLH * 60);
      return { duration, rate: evt.value / duration };
    }
    // Pump bolus: volume / pump bolus rate, minimum 3 seconds
    const durationMin = volumeMl / cfg.bolusRateMlH * 60;
    const duration = Math.max(0.05, durationMin); // minimum 3 seconds
    return { duration, rate: evt.value / duration };
  }

  /**
   * Advance the engine through a bolus event.
   * @param {Object} engine
   * @param {Object} evt - bolus event
   * @returns {number} delivery duration in minutes
   */
  function advanceBolus(engine, evt) {
    const { duration, rate } = getBolusDelivery(evt);
    engine.advance(duration, rate);
    return duration;
  }

  return { getBolusDelivery, advanceBolus };
}
