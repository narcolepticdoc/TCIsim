/**
 * case-stats.js — Per-drug delivery statistics for the Totals view.
 *
 * Pure: events in, numbers out. One walk over a drug's event list up to `now`,
 * following getCumulativeDose (events/query.js) step for step, so the total
 * here is the same number as the Log's "Total delivered" and the reconcile
 * baseline — a bolus suspends the infusion for its delivery time, and one still
 * running at `now` counts the fraction delivered so far.
 *
 * On top of that total it splits boluses by route and measures the case:
 *
 *   - Case time: from the first time the drug was given, by any route, to the
 *     last time it was given — the end of the last delivery, or `now` while an
 *     infusion or bolus is still running. Gaps in between (pauses, TCI holds,
 *     time between pushes) are not subtracted.
 *   - Average rate: the drug's total ÷ case time. Not the rate while the pump
 *     ran: an overall measure of how much drug the patient needed per unit
 *     time, as the user defined it ("the total amount of drug given over the
 *     case / the case time, simplified to first time drug was given to last
 *     time drug was given").
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
 *   firstGiven: number|null, lastGiven: number|null, givingNow: boolean,
 *   caseTimeMin: number, avgRateMgMin: number|null,
 * }}
 */
export function computeDrugStats(events, now, getDeliveryMinutes) {
  let infusionMg = 0;
  let pumpBolusMg = 0, pumpBolusCount = 0;
  let pushMg = 0, pushCount = 0;
  let firstGiven = null, lastGiven = null;
  let currentTime = 0;
  let currentRate = 0;
  let midBolus = false;   // a bolus (either route) still delivering at `now`

  const gave = (a, b) => {
    if (!(b > a)) return;
    if (firstGiven === null || a < firstGiven) firstGiven = a;
    if (lastGiven === null || b > lastGiven) lastGiven = b;
  };

  if (events && events.length && now > 0) {
    for (const evt of events) {
      if (evt.time > now) break;
      if (evt.time > currentTime) {
        infusionMg += (evt.time - currentTime) * currentRate;
        if (currentRate > 0) gave(currentTime, evt.time);
        currentTime = evt.time;
      }
      if (evt.type === 'bolus') {
        const duration = getDeliveryMinutes(evt);
        const endTime = evt.time + duration;
        const done = endTime <= now;
        const given = done
          ? evt.value
          : evt.value * Math.max(0, Math.min(1, (now - evt.time) / duration));
        if (evt.deliveryMode === 'push') { pushMg += given; pushCount++; }
        else { pumpBolusMg += given; pumpBolusCount++; }
        gave(evt.time, Math.min(endTime, now));
        if (done) {
          currentTime = endTime;
        } else {
          midBolus = true;
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
      if (currentRate > 0) gave(currentTime, now);
    }
  }

  // Still being given at `now`: a bolus mid-delivery, or an infusion in force
  // (an IV push in progress suspends it in this accounting, but it is running).
  const givingNow = now > 0 && (midBolus || currentRate > 0);
  if (givingNow) {
    if (firstGiven === null) firstGiven = now;
    lastGiven = now;
  }

  const totalMg = infusionMg + pumpBolusMg + pushMg;
  const caseTimeMin = firstGiven === null ? 0 : lastGiven - firstGiven;
  return {
    totalMg, infusionMg,
    pumpBolusMg, pumpBolusCount,
    pushMg, pushCount,
    firstGiven, lastGiven, givingNow,
    caseTimeMin,
    avgRateMgMin: caseTimeMin > 0 ? totalMg / caseTimeMin : null,
  };
}
