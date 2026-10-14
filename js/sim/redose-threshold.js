/**
 * redose-threshold.js — When a drug may hold a redose threshold.
 *
 * A redose threshold ("redose when Ce falls to X") is an intermittent-bolus
 * setting. In the user's words: it "should not be set on a drug running TCI or
 * rate based infusions since it is a setting for intermittent bolus mode". So a
 * drug that runs TCI or a rate cannot be given one, and starting either clears
 * one that is set (app.js enforceRedoseThresholdRule, with a notation).
 *
 * "Runs a rate" is the event list's answer, not the mode's. The event editor
 * can add a rate without changing the mode, and a keypad rate of 0 puts the
 * drug in 'manual' with nothing running. A rate scheduled for later counts as
 * well, so the clock passing a scheduled start can never put an infusion under
 * a threshold.
 *
 * Pure: a mode string and an event list in, a reason out. No DOM, no model.
 */

/**
 * Why a drug cannot hold a redose threshold at time `t`, or null if it can.
 *
 *   'tci'       — the drug is in TCI mode
 *   'running'   — a rate above 0 is in force at `t`
 *   'scheduled' — none is running, but a rate above 0 starts after `t`
 *
 * "In force" follows the event list's getRateAtTime: the last rate or pause at
 * or before `t` decides it. Boluses never count; they are what intermittent
 * dosing is. Nor do a dose reconciliation's spread rates (source 'reconcile'):
 * they correct what was delivered in the past, nobody started an infusion,
 * and their restore can land seconds after `now` (deferred past an IV push
 * still being given), which would otherwise read as a rate running now.
 *
 * @param {string} mode - 'none' | 'tci' | 'manual'
 * @param {Array<Object>} events - the drug's events, in time order
 * @param {number} t - case time (min)
 * @returns {'tci'|'running'|'scheduled'|null}
 */
export function redoseThresholdBlock(mode, events, t) {
  if (mode === 'tci') return 'tci';
  let rate = 0;
  let later = false;
  for (const e of events || []) {
    if (!e || (e.type === 'rate' && e.source === 'reconcile')) continue;
    if (e.time <= t) {
      if (e.type === 'rate') rate = e.value;
      else if (e.type === 'pause') rate = 0;
    } else if (e.type === 'rate' && e.value > 0) {
      later = true;
    }
  }
  if (rate > 0) return 'running';
  return later ? 'scheduled' : null;
}

/**
 * What it takes for a case to obey the rule: one fix per drug that needs one.
 *
 *   { drugId, action: 'clear', reason } — the drug runs TCI or a rate (reason
 *       is redoseThresholdBlock's): its threshold goes, with a notation.
 *   { drugId, action: 'leaveManual' }   — it holds a threshold in 'manual' with
 *       nothing running (a keypad rate of 0, or an older save): back to
 *       'none', since a threshold means intermittent dosing and the label,
 *       Stop Pump and bolus route should all say so.
 *
 * Every drug is judged on its own events, at its own time: propofol in TCI
 * says nothing about fentanyl's threshold, and before Start each drug has its
 * own pre-start clock (a pre-case rate set and then set back to 0 has ended
 * by fentanyl's clock, though it still reads as running at case time 0).
 *
 * @param {string[]} drugIds
 * @param {{ getMode: Function, getThreshold: Function, getEvents: Function, getTime: Function }} state
 *        per-drug readers: (drugId) => mode / canonical threshold / events /
 *        the time (min) a new entry for that drug lands at
 * @returns {Array<{drugId: string, action: 'clear'|'leaveManual', reason?: string}>}
 */
export function redoseThresholdFixes(drugIds, { getMode, getThreshold, getEvents, getTime }) {
  const fixes = [];
  for (const drugId of drugIds) {
    if (!(getThreshold(drugId) > 0)) continue;
    const m = getMode(drugId);
    const reason = redoseThresholdBlock(m, getEvents(drugId), getTime(drugId));
    if (reason) fixes.push({ drugId, action: 'clear', reason });
    else if (m === 'manual') fixes.push({ drugId, action: 'leaveManual' });
  }
  return fixes;
}

/** The notation sub-line for a threshold cleared for `block`'s reason. */
export const REDOSE_BLOCK_NOTE = {
  tci: 'TCI Running',
  running: 'Infusion Running',
  scheduled: 'Infusion Scheduled',
};
