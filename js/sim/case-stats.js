/**
 * case-stats.js — Per-drug delivery statistics for the Totals view.
 *
 * Pure: events in, numbers out. One walk over a drug's event list up to `now`,
 * following getCumulativeDose (events/query.js) step for step, so the total
 * here is the same number as the Log's "Total delivered" and the reconcile
 * baseline — a bolus suspends the infusion for its delivery time, and one still
 * running at `now` counts the fraction delivered so far.
 *
 * On top of that total it splits boluses by route and records when the drug
 * was first and last given. computeCaseStats then measures the case:
 *
 *   - Case time is global, one span for every drug: from the first time any
 *     drug was given, by any route, to the last time any drug was given — the
 *     end of the last delivery, or `now` while something is still being given.
 *     Gaps in between (pauses, TCI holds, time between doses) are not
 *     subtracted.
 *   - Each drug's average rate: its total ÷ the case time. Not the rate while
 *     its pump ran: an overall measure of how much of it the patient needed
 *     per unit time, as the user defined it ("the total amount of drug given
 *     over the case / the case time (in this case simplified to first time
 *     drug was given to last time drug was given)", and "case time should be
 *     global for all drugs").
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

  return {
    totalMg: infusionMg + pumpBolusMg + pushMg,
    infusionMg,
    pumpBolusMg, pumpBolusCount,
    pushMg, pushCount,
    firstGiven, lastGiven, givingNow,
  };
}

/**
 * The whole case: one case time across every drug, and each drug's average
 * over it.
 *
 * The averages need a span to be about: an infusion of any drug, or at least
 * two doses between them. A lone bolus spans only its own delivery time
 * (seconds for a push), and every drug would "average" at its delivery rate.
 *
 * @param {Array<[string, Array]>} drugEvents - [drugId, events] in display order
 * @param {number} now
 * @param {Function} getDeliveryMinutes
 * @returns {{
 *   drugs: Array<Object>,   // computeDrugStats + { drugId, avgRateMgMin }, for drugs that gave anything
 *   firstGiven: number|null, lastGiven: number|null, givingNow: boolean,
 *   caseTimeMin: number, hasSpan: boolean,
 * }}
 */
export function computeCaseStats(drugEvents, now, getDeliveryMinutes) {
  const all = drugEvents.map(([drugId, events]) =>
    ({ drugId, ...computeDrugStats(events, now, getDeliveryMinutes) }));

  let firstGiven = null, lastGiven = null, givingNow = false;
  let infused = false, doses = 0;
  for (const d of all) {
    if (d.firstGiven === null) continue;
    if (firstGiven === null || d.firstGiven < firstGiven) firstGiven = d.firstGiven;
    if (lastGiven === null || d.lastGiven > lastGiven) lastGiven = d.lastGiven;
    givingNow = givingNow || d.givingNow;
    infused = infused || d.infusionMg > 0;
    doses += d.pumpBolusCount + d.pushCount;
  }

  const caseTimeMin = firstGiven === null ? 0 : lastGiven - firstGiven;
  const hasSpan = caseTimeMin > 0 && (infused || doses >= 2);
  const drugs = all
    .filter(d => d.totalMg > 0)
    .map(d => ({ ...d, avgRateMgMin: hasSpan ? d.totalMg / caseTimeMin : null }));
  return { drugs, firstGiven, lastGiven, givingNow, caseTimeMin, hasSpan };
}
