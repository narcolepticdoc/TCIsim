/**
 * upcoming.js — Event-list interpretation for forward-looking displays.
 *
 * Two pure helpers that read the event list and answer "what happens next":
 *
 *   classifyFutureEvents() — per-drug marker kinds for the chart's event flags.
 *   collectUpcoming()      — the curated cross-drug list behind the Next Up panel.
 *
 * `collectUpcoming` does **selection and curation only** — it decides which
 * items belong on a heads-up display and in what order, and returns the raw
 * event objects. It deliberately does no label formatting, so it stays free of
 * display-unit and localStorage reads and can be unit-tested in Node.
 * js/ui/next-up.js formats via js/util/event-label.js.
 *
 * No DOM, no module state, no engine calls.
 */

/**
 * Tuning for the Next Up panel's curation.
 *
 * Pump events and clinical forecasts are selected under **separate** horizons,
 * and the difference is not arbitrary. A pump plan is dense — a TCI scheme
 * queues dozens of rate steps over hours — so it needs a tight horizon to stay
 * a heads-up display instead of a second event log. A forecast is sparse: at
 * most one per drug per kind, and the interesting ones are genuinely distant
 * (a ketamine redose threshold sits 200–600 min out because its Ce decay is
 * that slow). Applying the pump horizon to forecasts hides exactly the drugs
 * that have nothing else scheduled.
 */
export const DEFAULT_HUD_CFG = {
  horizonMin:          20,  // pump events: don't look further ahead than this…
  groupWindowMin:      2,   // …except to keep a tight cluster together
  maxItems:            6,   // hard cap on future pump-event rows
  milestoneHorizonMin: Infinity, // forecasts: distance is the point, not the problem
  maxMilestones:       4,   // …but never more than this many
  elapsedLookbackMin:  10,  // how far back to surface unacknowledged items
  maxElapsed:          3,   // hard cap on elapsed-uncleared rows
};

/** Strictly-future epsilon, in minutes (~6 ms). Matches the rest of the app. */
const TIME_EPS = 0.0001;

/**
 * Stable identity for a milestone, used for acknowledgement state.
 *
 * `drugId:kind` alone is a per-drug *slot*, not an occurrence — and a slot for a
 * recurring forecast never leaves `liveKeys`, so `cleared`/muted entries against
 * it can never be pruned. One tap then silenced that drug's redose for the rest
 * of the case. Callers pass an `occurrence` token (js/ui/next-up.js uses the
 * crossing generation plus whether it is latched) so each occurrence gets its
 * own identity and stale acknowledgements fall out of scope naturally.
 */
export function milestoneKey(ms) {
  const base = `${ms.drugId}:${ms.kind}`;
  return (ms.occurrence != null && ms.occurrence !== '')
    ? `${base}#${ms.occurrence}` : base;
}

/**
 * Classify events into marker kinds by walking one drug's list forward while
 * tracking the running rate. Skips system-generated events (e.g. rate-restore
 * after a bolus). Tags each marker as past or future so the chart can render
 * past events dimmed.
 *
 * Classification compares each rate event against the last *non-zero* rate,
 * not the instantaneous running rate. This way a rate event that follows a
 * pause is labelled by its direction relative to the pre-pause level
 * (decrease/increase) rather than always being called "resume". A true
 * "resume" marker is only used when the new rate matches the prior rate
 * (or when no prior rate has ever been set).
 */
export function classifyFutureEvents(events, now) {
  const out = [];
  for (const m of _walkDrugEvents(events, now)) {
    out.push({ time: m.time, kind: m.chartKind, past: m.past });
  }
  return out;
}

/**
 * Shared forward walk. Yields one entry per human-relevant event, carrying
 * both the chart's marker kind and the HUD's action kind — the two vocabularies
 * differ ('increase'/'decrease' vs a single 'rate') but the rate-tracking rule
 * that produces them is identical and must not drift.
 *
 * @param {Array} events — one drug's events, time-ordered
 * @param {number} now
 * @returns {Array<{evt, time, past, chartKind, kind}>}
 */
function _walkDrugEvents(events, now) {
  let currentRate = 0;
  let lastNonZeroRate = 0;
  const out = [];
  for (const e of events) {
    if (e.source === 'system') continue;
    const past = e.time <= now;
    if (e.type === 'pause' || (e.type === 'rate' && e.value === 0)) {
      out.push({ evt: e, time: e.time, past, chartKind: 'stop', kind: 'stop' });
      currentRate = 0;
    } else if (e.type === 'rate' && e.value > 0) {
      const ref = lastNonZeroRate;
      let chartKind = null;
      if (ref === 0)                  chartKind = 'resume';   // first rate ever set
      else if (e.value > ref)         chartKind = 'increase';
      else if (e.value < ref)         chartKind = 'decrease';
      else if (currentRate === 0)     chartKind = 'resume';   // equal to prior, after a pause
      // else: equal to prior with no pause → no-op, skip
      if (chartKind) {
        out.push({
          evt: e, time: e.time, past, chartKind,
          kind: chartKind === 'resume' ? 'resume' : 'rate',
        });
      }
      currentRate = e.value;
      lastNonZeroRate = e.value;
    } else if (e.type === 'bolus') {
      out.push({ evt: e, time: e.time, past, chartKind: 'bolus', kind: 'bolus' });
    }
  }
  return out;
}

/**
 * Curate the cross-drug list of things that need a human.
 *
 * @param {Object} args
 * @param {Array}  args.events — flat cross-drug event array (model.getEvents()),
 *                 each element carrying `.drug`. Need not be pre-sorted.
 * @param {number} args.now — elapsed minutes.
 * @param {Array}  [args.milestones] — predicted clinical events supplied by the
 *                 caller as `{ drugId, kind, time, ce, actionable?, latched? }`.
 *                 Selected under `milestoneHorizonMin` / `maxMilestones`,
 *                 independently of the pump-event horizon. Set `actionable: true`
 *                 for a forecast that is itself an intervention (a redose becoming
 *                 due) so it can raise the panel alarm; the rest only inform.
 *                 Set `latched: true` for one that has *already happened* and must
 *                 persist until dealt with (a crossed redose threshold): its
 *                 `time` is the moment of the crossing, it is returned as
 *                 `elapsed`, and a bolus at or after that time clears it.
 * @param {Set}    [args.cleared] — item keys the user has already dismissed.
 * @param {Set}    [args.seenFuture] — keys that were still in the future on an
 *                 earlier pass. When supplied, only these can be reported as
 *                 missed: an event the user creates at or behind the clock (a
 *                 manual bolus, a Stop Pump) was never pending, so it must not
 *                 come back as something they failed to do. Omit to treat every
 *                 elapsed item as missable.
 * @param {Object} [args.cfg] — overrides for DEFAULT_HUD_CFG.
 * @returns {Array<Item>} elapsed-uncleared items first (ascending), then the
 *   selected future items (ascending). Item shape:
 *   `{ key, drugId, time, kind, actionable, elapsed, evt, milestone }`
 */
export function collectUpcoming({ events = [], now = 0, milestones = [],
                                  cleared, seenFuture, cfg } = {}) {
  const c = { ...DEFAULT_HUD_CFG, ...(cfg || {}) };
  const isCleared = k => !!(cleared && cleared.has(k));
  const wasPending = k => !seenFuture || seenFuture.has(k);

  // ── Pump interventions, grouped by drug so rate direction tracks per drug ──
  const byDrug = new Map();
  for (const e of events) {
    if (!byDrug.has(e.drug)) byDrug.set(e.drug, []);
    byDrug.get(e.drug).push(e);
  }

  const candidates = [];
  for (const [drugId, list] of byDrug) {
    list.sort((a, b) => a.time - b.time);
    for (const m of _walkDrugEvents(list, now)) {
      if (isCleared(m.evt.id)) continue;
      if (m.time < now - c.elapsedLookbackMin) continue;
      if (m.time <= now && !wasPending(m.evt.id)) continue;
      candidates.push({
        key: m.evt.id,
        drugId,
        time: m.time,
        kind: m.kind,
        actionable: true,
        elapsed: m.time <= now,
        evt: m.evt,
        milestone: null,
      });
    }
  }

  // ── Clinical milestones ────────────────────────────────────────────────────
  for (const ms of milestones) {
    if (!ms) continue;
    const key = milestoneKey(ms);
    if (isCleared(key)) continue;
    const drugEvents = byDrug.get(ms.drugId) || [];

    // A `latched` milestone is one that has already happened and stays until the
    // user deals with it — a crossed redose threshold. Everything else is a
    // forecast, and a forecast in the past is simply stale.
    //
    // Whether a dose has dealt with it is deliberately NOT decided here: "was
    // that dose enough?" needs Ce's direction, which the event list cannot
    // answer. js/ui/settings.js owns it (checkBelowThreshold / noteRedoseDose)
    // and simply stops passing the milestone while a dose is settling.
    if (ms.latched) {
      candidates.push({
        key, drugId: ms.drugId, time: ms.time, kind: ms.kind,
        actionable: ms.actionable === true, elapsed: true, latched: true,
        evt: null, milestone: ms,
      });
      continue;
    }

    if (!(ms.time > now)) continue;
    // A forecast that assumes the current rate holds is void once a scheduled
    // pump event lands before it, so drop those rather than promise them.
    const preempted = drugEvents.some(e =>
      e.source !== 'system' && e.time > now + TIME_EPS && e.time < ms.time);
    if (preempted) continue;
    candidates.push({
      key, drugId: ms.drugId, time: ms.time, kind: ms.kind,
      actionable: ms.actionable === true, elapsed: false, latched: false,
      evt: null, milestone: ms,
    });
  }

  // ── Split, then select ─────────────────────────────────────────────────────
  const elapsed = candidates.filter(i => i.elapsed).sort((a, b) => a.time - b.time);
  const future  = candidates.filter(i => !i.elapsed).sort((a, b) => a.time - b.time);

  // Elapsed pump events: keep the most recent unacknowledged ones — an unbounded
  // backlog would push the actual next intervention off the panel.
  const keptMisses = elapsed
    .filter(i => !i.latched)
    .slice(-c.maxElapsed);

  // Latched crossings get their own budget. They must survive both
  // `elapsedLookbackMin` (a crossing 40 min old is still outstanding) and
  // `maxElapsed` (three pump misses would otherwise evict the one row that is
  // actively alarming).
  const keptLatched = elapsed
    .filter(i => i.latched)
    .slice(0, c.maxMilestones);

  const keptElapsed = [...keptMisses, ...keptLatched].sort((a, b) => a.time - b.time);

  // Pump events: tight horizon, walked in order so the group window can bridge
  // a cluster, and stop at the first item that fails both tests.
  const keptEvents = [];
  for (const item of future) {
    if (item.evt === null) continue;
    if (keptEvents.length >= c.maxItems) break;
    const withinHorizon = (item.time - now) <= c.horizonMin;
    const last = keptEvents[keptEvents.length - 1];
    // Group window: a cluster stays intact even when it straddles the horizon,
    // so a pause never appears without the restart that follows it.
    const withinGroup = last && (item.time - last.time) <= c.groupWindowMin;
    if (!withinHorizon && !withinGroup) break;
    keptEvents.push(item);
  }

  // Forecasts: selected independently, so a distant threshold crossing is not
  // cut off by the pump horizon — nor by an unrelated drug's dense plan.
  const keptMilestones = future
    .filter(i => i.milestone !== null && (i.time - now) <= c.milestoneHorizonMin)
    .slice(0, c.maxMilestones);

  const keptFuture = [...keptEvents, ...keptMilestones].sort((a, b) => a.time - b.time);

  return [...keptElapsed, ...keptFuture];
}

/**
 * Keys still represented in a collected list — used to prune the caller's
 * `cleared` / muted sets so they can't grow unbounded across a long case as
 * events are deleted or replanned out from under them.
 */
export function liveKeys(events = [], milestones = []) {
  const keys = new Set();
  for (const e of events) if (e && e.id) keys.add(e.id);
  for (const m of milestones) if (m) keys.add(milestoneKey(m));
  return keys;
}
