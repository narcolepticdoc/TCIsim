/**
 * clock-time.js — Resolve a bare clock time (HH:MM, no date) to a real moment.
 *
 * Every clock time the user types is hours and minutes only, and a case can
 * run past midnight. Pinning the HH:MM to a fixed day broke as soon as it did:
 * a 23:15 start typed at 00:40 landed on *tonight* ("in the future") and was
 * dropped, and an RT event at 00:30 in a case started at 23:00 landed 22.5 h
 * before the start and was clamped onto ET 0:00.
 *
 * Both resolvers keep the old same-day reading wherever it was valid, and only
 * cross midnight when the same-day reading is impossible *and* the other day is
 * the nearer one. That leaves every input that worked before unchanged, and a
 * time a few minutes the wrong side of the clock stays an error (or a clamp)
 * instead of becoming a day-long jump.
 *
 * Days are stepped with setDate(), never ±86 400 000 ms, so the wall-clock time
 * holds across a DST change. Elapsed time is still plain Date subtraction, so a
 * case that crosses a DST change measures its real length.
 */

/** HH:MM on the local calendar day `dayOffset` days from `ref`'s. */
function atClockTime(ref, h, m, dayOffset) {
  const d = new Date(ref.getTime());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * The case start a typed HH:MM refers to, or null if it is in the future.
 *
 * Today's HH:MM if it has passed (the current minute counts). Otherwise
 * yesterday's, if that is nearer to now than today's is — 23:15 typed at 00:40
 * is 1 h 25 min ago, not 22 h 35 min ahead. A time just ahead of the clock
 * (10:05 typed at 10:04, a clock-skew slip) is still in the future.
 *
 * @param {number} h - 0–23
 * @param {number} m - 0–59
 * @param {Date} now
 * @returns {Date|null}
 */
export function resolveStartTime(h, m, now) {
  const today = atClockTime(now, h, m, 0);
  if (today <= now) return today;
  const yesterday = atClockTime(now, h, m, -1);
  return (now - yesterday) < (today - now) ? yesterday : null;
}

/**
 * The moment an in-case HH:MM refers to.
 *
 * The HH:MM on the start's day if that is not before the start. Otherwise it is
 * either after midnight (the next day's) or from before the case began; it goes
 * to whichever of those is nearer to the live case. With the case started at
 * 23:00 and now 00:40: 00:30 is 10 min ago, 02:00 is in 80 min, and 22:55 is
 * just before the start — which the caller clamps onto ET 0:00, as before —
 * rather than tomorrow night.
 *
 * Compared against the start at minute resolution, so picking the start's own
 * minute reads as the start however many seconds into it the case began.
 *
 * @param {number} h - 0–23
 * @param {number} m - 0–59
 * @param {Date} start - case wall-clock start
 * @param {Date} [now] - case wall-clock now; defaults to the start
 * @returns {Date} may precede `start`; the caller clamps
 */
export function resolveCaseClockTime(h, m, start, now = start) {
  const startMinute = new Date(start.getTime());
  startMinute.setSeconds(0, 0);
  const sameDay = atClockTime(start, h, m, 0);
  if (sameDay >= startMinute) return sameDay;
  const nextDay = atClockTime(start, h, m, 1);
  return (nextDay - now) < (start - sameDay) ? nextDay : sameDay;
}
