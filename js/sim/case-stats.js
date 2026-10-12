/**
 * case-stats.js — Per-drug delivery statistics for the Totals view.
 *
 * Pure: events in, numbers out. One walk over a drug's event list up to `now`,
 * following getCumulativeDose (events/query.js) step for step, so the total
 * here is the same number as the Log's "Total delivered" and the reconcile
 * baseline — a bolus suspends the infusion for its delivery time, and one still
 * running at `now` counts the fraction delivered so far.
 *
 * On top of that total it splits boluses by route and measures the pump:
 *
 *   - Pump window: from the first moment the pump delivered anything (a pump
 *     bolus or a non-zero rate) to the last moment it stopped, or to `now` if
 *     it is still running. Pauses inside the window are not subtracted.
 *   - Average pump rate: everything the pump delivered — infusion plus pump
 *     boluses, so a TCI case's induction and step-up boluses count — divided by
 *     that window. IV pushes are given by hand and never count.
 *
 * A bolus is a pump bolus unless `deliveryMode === 'push'`, the same test
 * getCumulativeDose uses to pick its delivery time.
 */

/**
 * @param {Array} events - one drug's event list, time-sorted
 * @param {number} now - case time (min); nothing after it counts
 * @param {Function} getDeliveryMinutes - (bolusEvt) => delivery time in minutes
 * @returns {{
 *   totalMg: number, infusionMg: number,
 *   pumpBolusMg: number, pumpBolusCount: number,
 *   pushMg: number, pushCount: number,
 *   pumpMg: number,
 *   pumpStart: number|null, pumpEnd: number|null, pumpRunning: boolean,
 *   pumpWindowMin: number, avgPumpRateMgMin: number|null,
 * }}
 */
export function computeDrugStats(events, now, getDeliveryMinutes) {
  let infusionMg = 0;
  let pumpBolusMg = 0, pumpBolusCount = 0;
  let pushMg = 0, pushCount = 0;
  let pumpStart = null, pumpEnd = null;
  let currentTime = 0;
  let currentRate = 0;
  let pumpRunning = false;

  const ran = (a, b) => {
    if (!(b > a)) return;
    if (pumpStart === null || a < pumpStart) pumpStart = a;
    if (pumpEnd === null || b > pumpEnd) pumpEnd = b;
  };

  if (events && events.length && now > 0) {
    for (const evt of events) {
      if (evt.time > now) break;
      if (evt.time > currentTime) {
        infusionMg += (evt.time - currentTime) * currentRate;
        if (currentRate > 0) ran(currentTime, evt.time);
        currentTime = evt.time;
      }
      if (evt.type === 'bolus') {
        const duration = getDeliveryMinutes(evt);
        const endTime = evt.time + duration;
        const done = endTime <= now;
        const given = done
          ? evt.value
          : evt.value * Math.max(0, Math.min(1, (now - evt.time) / duration));
        const isPush = evt.deliveryMode === 'push';
        if (isPush) {
          pushMg += given; pushCount++;
        } else {
          pumpBolusMg += given; pumpBolusCount++;
          ran(evt.time, Math.min(endTime, now));
        }
        if (done) {
          currentTime = endTime;
        } else {
          // Still delivering at `now`. A push suspends the infusion in this
          // accounting, but it does not stop the pump: an infusion set before
          // it is still running.
          pumpRunning = !isPush || currentRate > 0;
          currentTime = now;
          break;
        }
      } else if (evt.type === 'rate') {
        currentRate = evt.value;
      } else if (evt.type === 'pause') {
        currentRate = 0;
      }
    }
    if (currentTime < now) {
      infusionMg += (now - currentTime) * currentRate;
      if (currentRate > 0) ran(currentTime, now);
    }
    if (currentRate > 0) pumpRunning = true;
    // A running pump has not stopped yet: the window runs to `now`.
    if (pumpRunning) {
      if (pumpStart === null) pumpStart = now;
      pumpEnd = now;
    }
  }

  const pumpMg = infusionMg + pumpBolusMg;
  const pumpWindowMin = pumpStart === null ? 0 : pumpEnd - pumpStart;
  return {
    totalMg: pumpMg + pushMg,
    infusionMg,
    pumpBolusMg, pumpBolusCount,
    pushMg, pushCount,
    pumpMg,
    pumpStart, pumpEnd, pumpRunning,
    pumpWindowMin,
    avgPumpRateMgMin: pumpWindowMin > 0 ? pumpMg / pumpWindowMin : null,
  };
}
