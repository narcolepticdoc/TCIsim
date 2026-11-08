/**
 * dose-sync.js — When had the sim delivered a given total?
 *
 * The clock popover's Pump Total mode. A clinician who started the infusion
 * but never pressed Start knows only what the pump says it has delivered. This
 * finds the case time at which the sim's cumulative dose equals that figure,
 * so the clock can be moved there (which is the same as moving the case start).
 *
 * It solves against getCumulativeDose itself — the function behind the Log's
 * "Total delivered" and the Totals tab — never a copy of its walk. After a
 * sync, those readouts therefore show exactly the number that was typed.
 *
 * Pure: no DOM, no clock.
 */

import { getCumulativeDose } from './events/query.js';
import { bolusDeliveryMinutes, pushDeliveryMinutes } from '../util/constants.js';

/** Bisection stops once the bracket is narrower than this (≈ 6 µs). */
const BISECT_WIDTH_MIN = 1e-7;
/** Hard cap on bisection steps; 60 halvings outrun any case length. */
const BISECT_MAX_STEPS = 60;

/**
 * Every time at which the cumulative dose may change slope: case start, each
 * event, and the end of each bolus delivery. Between two consecutive
 * breakpoints the dose is linear in time (a constant rate, or a bolus being
 * delivered at a constant rate), so these bracket every solution.
 */
function breakpoints(events, drugId, getDeliveryMinutes) {
  const set = new Set([0]);
  for (const evt of events) {
    if (!(evt.time >= 0)) continue;
    set.add(evt.time);
    if (evt.type === 'bolus') {
      const dur = getDeliveryMinutes
        ? getDeliveryMinutes(evt)
        : (evt.deliveryMode === 'push'
            ? pushDeliveryMinutes(evt.value, drugId)
            : bolusDeliveryMinutes(evt.value, drugId));
      if (dur > 0) set.add(evt.time + dur);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * The case time (minutes) at which the drug's cumulative delivered dose equals
 * `targetMg`.
 *
 * The dose is usually rising, so there is one answer. It can have several: it
 * is flat while the pump is paused, and a negative dose reconciliation steps it
 * back down. Among all the answers this returns the one nearest `nearMin` (the
 * clock as it reads now) — the smallest move, and no move at all when the
 * clock already sits on a matching plateau.
 *
 * Past the last event the dose keeps rising at the final rate (every TCI plan
 * ends on a terminal rate), so any larger total is reachable. Only a case that
 * ends stopped has a ceiling.
 *
 * @param {Array} events - one drug's events, sorted by time
 * @param {string} drugId
 * @param {number} targetMg - the pump's total, canonical mg
 * @param {Object} [opts]
 * @param {function} [opts.getDeliveryMinutes] - (evt) => bolus delivery minutes;
 *   pass the event list's getBolusDelivery, as every getCumulativeDose caller does
 * @param {number} [opts.nearMin=0] - prefer the answer nearest this case time
 * @returns {{ ok: true, minutes: number }
 *   | { ok: false, reason: 'invalid'|'nothing'|'unreachable', maxMg?: number }}
 */
export function solveElapsedForTotal(events, drugId, targetMg,
                                     { getDeliveryMinutes, nearMin = 0 } = {}) {
  if (!Number.isFinite(targetMg) || !(targetMg > 0)) return { ok: false, reason: 'invalid' };
  if (!events || events.length === 0) return { ok: false, reason: 'nothing' };

  const dose = t => getCumulativeDose(events, drugId, t, getDeliveryMinutes).totalMg;
  const tol = Math.max(1e-9, targetMg * 1e-9);
  const near = Number.isFinite(nearMin) ? Math.max(0, nearMin) : 0;

  const candidates = [];
  let maxMg = 0;

  // Root of dose(t) = target inside [a, b], where the endpoints straddle it.
  function bisect(a, b, fa) {
    for (let i = 0; i < BISECT_MAX_STEPS && b - a > BISECT_WIDTH_MIN; i++) {
      const m = (a + b) / 2;
      const fm = dose(m) - targetMg;
      if (Math.abs(fm) <= tol) return m;
      if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else { b = m; }
    }
    return (a + b) / 2;
  }

  const bps = breakpoints(events, drugId, getDeliveryMinutes);
  let prevT = bps[0];
  let prevD = dose(prevT);
  for (let i = 1; i < bps.length; i++) {
    const t = bps[i];
    const d = dose(t);
    if (d > maxMg) maxMg = d;
    const lo = Math.min(prevD, d), hi = Math.max(prevD, d);
    if (targetMg >= lo - tol && targetMg <= hi + tol) {
      if (hi - lo <= tol) {
        // Flat at the target (a pause): any time in it fits.
        candidates.push(Math.min(t, Math.max(prevT, near)));
      } else if (Math.abs(prevD - targetMg) <= tol) {
        candidates.push(prevT);
      } else if (Math.abs(d - targetMg) <= tol) {
        candidates.push(t);
      } else {
        candidates.push(bisect(prevT, t, prevD - targetMg));
      }
    }
    prevT = t;
    prevD = d;
  }

  // After the last breakpoint the dose is linear at the final rate.
  const last = prevT;
  const lastD = prevD;
  const slope = dose(last + 1) - lastD; // mg per minute
  if (Math.abs(slope) <= tol) {
    if (Math.abs(lastD - targetMg) <= tol) candidates.push(Math.max(last, near));
  } else {
    const t = last + (targetMg - lastD) / slope;
    if (t >= last) candidates.push(t);
    if (slope > 0) maxMg = Infinity;
  }

  if (candidates.length === 0) {
    if (!(maxMg > 0)) return { ok: false, reason: 'nothing' };
    return { ok: false, reason: 'unreachable', maxMg };
  }

  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - near) < Math.abs(best - near)) best = c;
  }
  return { ok: true, minutes: Math.max(0, best) };
}
