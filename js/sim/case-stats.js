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
 *     bolus or a non-zero rate) to the last time it was stopped, or to `now`
 *     while it runs. Pauses inside the window are not subtracted — including a
 *     TCI plan's own zero steps, which the Log shows as "Paused": the plan is
 *     still running through them, and a Stop pressed during one ends the
 *     window at the Stop, not at the start of the hold.
 *   - Average infusion rate: the drug's whole-case total — every route,
 *     including IV pushes before the pump started or after it stopped —
 *     divided by that window. Not the rate while the pump was running: an
 *     overall measure of how much drug the patient needed per unit time, as
 *     the user defined it.
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
 *   pumpWindowMin: number, avgRateMgMin: number|null,
 * }}
 */
export function computeDrugStats(events, now, getDeliveryMinutes) {
  let infusionMg = 0;
  let pumpBolusMg = 0, pumpBolusCount = 0;
  let pushMg = 0, pushCount = 0;
  let pumpStart = null, lastDelivery = null;
  let lastStop = null;
  let currentTime = 0;
  let currentRate = 0;
  // 'stopped' | 'delivering' | 'hold'. A hold is a TCI plan's own zero step —
  // the Log's "Paused" row: the plan is still running and resumes by itself.
  // A stop is a pause event (the Log's "Stopped") or a zero rate anyone else
  // set; the post-bolus rate-restore only puts back what was in force.
  let state = 'stopped';
  let midBolus = null;   // the bolus still delivering at `now`, if any

  const ran = (a, b) => {
    if (!(b > a)) return;
    if (pumpStart === null || a < pumpStart) pumpStart = a;
    if (lastDelivery === null || b > lastDelivery) lastDelivery = b;
  };
  const stopAt = (t) => {
    if (state !== 'stopped' && pumpStart !== null) lastStop = t;
    state = 'stopped';
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
        if (evt.deliveryMode === 'push') {
          pushMg += given; pushCount++;
        } else {
          pumpBolusMg += given; pumpBolusCount++;
          ran(evt.time, Math.min(endTime, now));
        }
        if (done) {
          currentTime = endTime;
        } else {
          midBolus = evt;
          currentTime = now;
          break;
        }
      } else if (evt.type === 'rate') {
        currentRate = evt.value;
        if (evt.value > 0) state = 'delivering';
        else if (evt.source === 'tci') state = 'hold';
        else if (evt.source === 'system') { if (state === 'delivering') stopAt(evt.time); }
        else stopAt(evt.time);
      } else if (evt.type === 'pause') {
        currentRate = 0;
        stopAt(evt.time);
      }
    }
    if (currentTime < now) {
      infusionMg += (now - currentTime) * currentRate;
      if (currentRate > 0) ran(currentTime, now);
    }
  }

  // Running at `now`: a pump bolus still going, an infusion in force (an IV
  // push in progress suspends it in this accounting but does not stop the
  // pump), or a TCI hold with more delivery scheduled after it.
  const holdResumes = state === 'hold' && (events || []).some(e => e.time > now &&
    ((e.type === 'rate' && e.value > 0) || (e.type === 'bolus' && e.deliveryMode !== 'push')));
  const pumpRunning = now > 0 && (
    (midBolus !== null && midBolus.deliveryMode !== 'push') ||
    state === 'delivering' || holdResumes);

  // The window: first delivery to the last stop. A hold that a Stop ended
  // counts inside it, like any pause; a running pump has not stopped yet.
  let pumpEnd = null;
  if (pumpRunning) {
    if (pumpStart === null) pumpStart = now;
    pumpEnd = now;
  } else if (pumpStart !== null) {
    pumpEnd = Math.max(lastDelivery, lastStop ?? -Infinity);
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
    // Whole-case total over the pump window — pushes included, pauses not
    // subtracted (see the header).
    avgRateMgMin: pumpWindowMin > 0 ? (pumpMg + pushMg) / pumpWindowMin : null,
  };
}
