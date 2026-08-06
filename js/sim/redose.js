/**
 * redose.js — "Give that dose again" lookup.
 *
 * The Redose control repeats the last bolus the clinician chose for a drug,
 * in one touch. Finding that dose is the only part with a decision in it, so
 * it lives here as a pure function over an event list — no DOM, no model —
 * and app.js does the committing.
 */

/**
 * The bolus a redose should repeat, or null when there is nothing to repeat.
 *
 * TCI-sourced boluses are deliberately skipped. After a drug drops out of TCI
 * the most recent bolus in the list is usually the planner's loading dose, and
 * offering to repeat a computed 155 mg as though the user had picked it is
 * wrong twice over: they never chose that number, and it was sized for
 * induction from zero rather than for a top-up. Only doses the clinician
 * entered by hand are offered back.
 *
 * System events (rate restores) are not boluses and never match.
 *
 * @param {Array<Object>} events - a drug's events, in time order
 * @returns {{ value: number, deliveryMode: string, time: number }|null}
 *          `value` is canonical mg.
 */
export function findRedoseBolus(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.type !== 'bolus') continue;
    if (e.source !== 'manual') continue;
    if (!Number.isFinite(e.value) || e.value <= 0) continue;
    return { value: e.value, deliveryMode: e.deliveryMode || 'pump', time: e.time };
  }
  return null;
}
