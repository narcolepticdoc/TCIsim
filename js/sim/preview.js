/**
 * preview.js — Non-destructive dose projection ("what if I gave this?").
 *
 * Planning mode needs to answer "what would the curve look like if I gave
 * THIS dose right now" without touching the case. The answer has to be
 * exact: whatever the preview draws is what the user gets when they hit
 * Confirm, so the projection replays the same mutations the commit path
 * (app.js `onConfirm`) performs — on a throwaway copy of the model.
 *
 * Why a clone rather than mutate-and-revert on the live model:
 *   - `addBolus` MERGES into an in-flight bolus (events/actions.js) and
 *     rewrites the existing event's value, so `deleteEvent` is not an undo.
 *   - `addRate` / `addPause` defer to the bolus end and delete the paired
 *     system rate-restore, which a revert would have to reconstruct.
 * A fresh clone carrying a full TCI plan costs ~0.8 ms, so rebuilding it on
 * every keystroke is both cheaper and safer than getting the undo right.
 *
 * Why not the in-place snapshot-and-advance pattern used by
 * `simulation.js computeDecayTrajectory`: that ignores every event already
 * queued in the future, which is exactly the situation whenever a TCI plan
 * is running — the common case this feature exists to serve.
 */

import { createModel } from './simulation.js';

/**
 * Sampling steps.
 *
 * `engine.js getExpm()` caches the matrix exponential only for
 * dt ∈ {0.1, 1, 10, 60} minutes; every other step recomputes a Padé(6,6)
 * approximant per sample and costs ~11× more. The chart's own 10/60 step is
 * NOT one of them (81 ms for a 12 h curve, against 0.79 ms at step 1), which
 * is far too slow to sit behind a keystroke.
 *
 * So the preview samples in two cached segments: a fine one over the first
 * FINE_WINDOW minutes — 6 s resolution, enough to resolve a bolus peak — and
 * a coarse one at 1 min out to the horizon.
 */
export const FINE_STEP = 0.1;
export const COARSE_STEP = 1;
export const FINE_WINDOW = 20;

/** How far past `t` a rate change is judged, for the drag handle's back-solve. */
export const RATE_PROBE_MIN = 30;

/** Tasks that move a horizontal line only and never touch the model. */
const LINE_TASKS = new Set(['intermittent', 'exitCe']);

/**
 * Rehydrate an event list into a model via the public add* commands.
 *
 * System events (`source: 'system'` rate-restores) are skipped because
 * `addBolus` regenerates them; replaying them would double them up.
 *
 * Shared with `session.js restore()` so the two rebuild paths cannot drift.
 *
 * @param {Object} model                 - target model (mutated)
 * @param {Object} eventsByDrug          - { [drugId]: event[] }
 */
export function rehydrateEvents(model, eventsByDrug) {
  for (const [drugId, drugEvents] of Object.entries(eventsByDrug)) {
    if (!drugEvents) continue;
    for (const evt of drugEvents) {
      if (evt.source === 'system') continue;
      if (evt.type === 'rate') {
        model.addRate(drugId, evt.time, evt.value, evt.annotation || '', {
          source: evt.source || 'manual', // preserve the 'tci' tag
        });
      } else if (evt.type === 'bolus') {
        model.addBolus(drugId, evt.time, evt.value, evt.annotation || '', {
          deliveryMode: evt.deliveryMode || 'pump',
          source: evt.source || 'manual',
        });
      } else if (evt.type === 'pause') {
        model.addPause(drugId, evt.time, evt.annotation || '');
      }
    }
  }
}

/**
 * Build an isolated copy of a model: same patient, same per-drug delivery
 * config, same events. The copy gets its own engines, so nothing it does can
 * reach the live simulation.
 *
 * Delivery config is copied from the source event list rather than re-read
 * from `getPumpSettings()`, so a case restored at a different concentration
 * previews at the concentration it was planned under.
 */
export function cloneModel(srcModel) {
  const clone = createModel({ primaryDrug: srcModel.primaryDrug });
  clone.setPatient(srcModel.getPatient());

  const srcList = srcModel.getEventList();
  const dstList = clone.getEventList();
  for (const drugId of dstList.getDrugIds()) {
    const cfg = srcList.getDrugConfig(drugId);
    if (cfg) dstList.registerDrugConfig(drugId, cfg);
  }

  const byDrug = {};
  for (const drugId of srcList.getDrugIds()) {
    byDrug[drugId] = srcModel.getEvents(drugId);
  }
  rehydrateEvents(clone, byDrug);
  return clone;
}

/**
 * Apply a planned action to a model, mirroring the commit path in
 * `app.js onConfirm` exactly. Any divergence here shows up as a preview
 * that doesn't match what Confirm produces, so the two must be read
 * side by side when either changes.
 *
 * @param {Object} model
 * @param {string} drugId
 * @param {number} t         - entry time (elapsed minutes)
 * @param {Object} action
 * @param {'bolus'|'rate'|'ceTarget'} action.type
 * @param {number} action.value          - canonical mg | mg/min | µg/mL
 * @param {boolean} [action.wasTci]      - drug is currently in TCI mode
 * @param {boolean} [action.caseStarted] - a case is running (vs pre-case planning)
 * @param {'pump'|'push'} [action.deliveryMode]
 * @param {Object} [action.tciConfig]    - { tciMode, ceTolerance, ...quantConfig }
 * @param {number} [action.tciDelayMin]  - TCI delay before the first step
 * @returns {number} the time the projection should start from
 */
export function applyAction(model, drugId, t, action) {
  if (action.type === 'bolus') {
    // app.js: a bolus out of TCI wipes the forward plan and drops to manual.
    if (action.wasTci) model.clearAfter(drugId, t);
    // A zero dose still projects — it is the baseline the dose is measured
    // against, and it keeps a curve (and therefore a drag handle) on screen
    // when the user pulls the handle all the way down. Inserting a 0 mg
    // bolus event would be meaningless, so only the clear happens.
    if (action.value > 0) {
      model.addBolus(drugId, t, action.value, '', {
        deliveryMode: action.deliveryMode || 'pump',
      });
    }
    return t;
  }

  if (action.type === 'rate') {
    if (action.wasTci) model.clearAfter(drugId, t);
    model.addRate(drugId, t, action.value, '');
    return t;
  }

  if (action.type === 'ceTarget') {
    const tciConfig = action.tciConfig || {};
    if (action.caseStarted) {
      // Running case: the plan starts after the pre-set delay the TCI delay
      // modal will apply on commit. planTCI clears forward events itself.
      const from = t + (action.tciDelayMin || 0);
      model.planTCI(drugId, from, action.value, tciConfig);
      return t;
    }
    // Pre-case: a new target defines the plan from scratch, so the prior
    // plan is wiped and the clock rewinds to the case origin.
    model.clearFrom(drugId, 0);
    model.planTCI(drugId, 0, action.value, tciConfig);
    return 0;
  }

  return t;
}

/**
 * Sample a model's curve over [startTime, endTime] using only cached
 * engine steps. See the FINE_STEP / COARSE_STEP note above.
 *
 * @returns {Array<{time:number, Cp:number, Ce:number}>}
 */
export function sampleCurve(model, drugId, startTime, endTime) {
  if (!(endTime > startTime)) return [];

  const fineEnd = Math.min(endTime, startTime + FINE_WINDOW);
  const points = model.computeCurve(drugId, startTime, fineEnd, FINE_STEP);

  if (endTime > fineEnd) {
    const coarse = model.computeCurve(drugId, fineEnd, endTime, COARSE_STEP);
    const last = points[points.length - 1];
    // The two segments share the boundary sample — drop the duplicate.
    const from = (last && coarse.length && Math.abs(coarse[0].time - last.time) < 1e-9) ? 1 : 0;
    for (let i = from; i < coarse.length; i++) points.push(coarse[i]);
  }
  return points;
}

/** Peak Ce (and when it occurs) over a curve, optionally up to `until`. */
function findPeak(points, until = Infinity) {
  let peak = null;
  for (const p of points) {
    if (p.time > until) break;
    if (!peak || p.Ce > peak.Ce) peak = { time: p.time, Ce: p.Ce };
  }
  return peak;
}

/** The sample at or just past `time`. */
function sampleAt(points, time) {
  for (const p of points) if (p.time >= time) return { time: p.time, Ce: p.Ce };
  const last = points[points.length - 1];
  return last ? { time: last.time, Ce: last.Ce } : null;
}

/**
 * Where the drag handle sits, and therefore which number the back-solve has
 * to hit. The two must agree or dragging would chase a value the solver
 * isn't targeting, so both go through this one function.
 *
 * A bolus is judged on its own peak — the maximum inside FINE_WINDOW, NOT the
 * maximum over the whole horizon, which for a drug left infusing is just the
 * far end of the chart and has nothing to do with the dose being entered.
 * A rate is judged at a fixed probe distance, where the change has had time
 * to show.
 *
 * Returns null for `ceTarget` (the handle rides the target line, which the
 * caller already knows) and for line tasks.
 */
export function anchorPoint(points, action, startTime) {
  if (!points || !points.length) return null;
  if (action.type === 'rate') return sampleAt(points, startTime + RATE_PROBE_MIN);
  if (action.type === 'bolus') return findPeak(points, startTime + FINE_WINDOW);
  return null;
}

/**
 * Create a preview session.
 *
 * Holds no state between calls beyond a scratch counter — every projection
 * rebuilds its clone, which is what makes it safe to call at keystroke rate.
 */
export function createPreview() {
  let lastCloneCount = 0;

  /**
   * Project an action without committing it.
   *
   * @param {Object} srcModel
   * @param {string} drugId
   * @param {number} t
   * @param {Object} action  - see applyAction; `type` may also be a line task
   * @param {Object} [opts]  - { endTime }
   * @returns {{points, peak, anchor, startTime} | null}
   *          `peak` is the maximum over the whole projection (the readout);
   *          `anchor` is where the drag handle belongs (see anchorPoint).
   *          null for line tasks — nothing about the curve changes.
   */
  function project(srcModel, drugId, t, action, opts = {}) {
    if (!srcModel || !action || LINE_TASKS.has(action.type)) return null;
    // Zero is a real value here (a stopped pump; a dose dragged to nothing) —
    // only a missing or negative one has no projection.
    if (!Number.isFinite(action.value) || action.value < 0) return null;

    const clone = cloneModel(srcModel);
    lastCloneCount++;
    const startTime = applyAction(clone, drugId, t, action);

    const endTime = opts.endTime ?? (startTime + 360);
    const points = sampleCurve(clone, drugId, startTime, endTime);
    return {
      points,
      peak: findPeak(points),
      anchor: anchorPoint(points, action, startTime),
      startTime,
      // The proposed plan's own events. A TCI retarget emits a whole scheme of
      // rate steps that exists only on the clone, so the caller needs them to
      // draw step markers on the proposal — there is nothing in the live model
      // to read them from.
      events: clone.getEvents(drugId),
    };
  }

  /**
   * The value the drag handle reads off the curve for a given dose — the
   * same quantity `anchorPoint` positions the handle on. Strictly increasing
   * in the dose, which is what makes the solve below well-posed.
   *
   * Only the window that matters is sampled: a single point query for a rate
   * (0.03 ms), the fine window for a bolus. The solver runs this a dozen
   * times per drag frame, so the horizon deliberately stays short.
   */
  function characteristicCe(srcModel, drugId, t, action, dose) {
    const clone = cloneModel(srcModel);
    lastCloneCount++;
    const startTime = applyAction(clone, drugId, t, { ...action, value: dose });

    if (action.type === 'rate') {
      return clone.getConcentrationsAt(drugId, startTime + RATE_PROBE_MIN).Ce;
    }
    const pts = clone.computeCurve(drugId, startTime, startTime + FINE_WINDOW, FINE_STEP);
    const peak = findPeak(pts);
    return peak ? peak.Ce : 0;
  }

  /**
   * Back-solve the dose whose curve passes through `targetCe`.
   *
   * The PK system is linear and the input is non-negative, so the
   * characteristic Ce is strictly increasing in dose — a bracket always
   * exists and bisection always converges. Secant is tried first for speed
   * and falls back to the bracket midpoint whenever it would step outside,
   * which keeps it from running away on the flat tail.
   *
   * @param {Object} srcModel
   * @param {string} drugId
   * @param {number} t
   * @param {Object} action    - type/wasTci/deliveryMode as for applyAction
   * @param {number} targetCe  - canonical µg/mL to hit
   * @param {Object} [opts]    - { seed, cap, tol, maxIter }
   * @returns {number|null} canonical dose, or null when unsolvable
   */
  function solveDose(srcModel, drugId, t, action, targetCe, opts = {}) {
    if (!srcModel || !Number.isFinite(targetCe) || targetCe <= 0) return null;
    if (LINE_TASKS.has(action.type) || action.type === 'ceTarget') return null;

    const cap = opts.cap ?? (action.type === 'rate' ? 1000 : 5000);
    const tol = opts.tol ?? 0.005;
    const maxIter = opts.maxIter ?? 12;

    const f = dose => characteristicCe(srcModel, drugId, t, action, dose);

    // A zero dose is the floor: if the target is already below what the
    // case delivers on its own, no dose can reach it.
    let lo = 0;
    let flo = f(0);
    if (flo >= targetCe) return 0;

    // Grow an upper bracket from the current dose (or a small seed).
    let hi = Math.max(opts.seed || 0, action.type === 'rate' ? 1 : 10);
    let fhi = f(hi);
    let grow = 0;
    while (fhi < targetCe && hi < cap && grow++ < 20) {
      lo = hi; flo = fhi;
      hi = Math.min(hi * 2, cap);
      fhi = f(hi);
    }
    if (fhi < targetCe) return cap; // target is beyond what the pump can reach

    let mid = hi;
    for (let i = 0; i < maxIter; i++) {
      // Secant step, guarded to stay strictly inside the bracket.
      const span = fhi - flo;
      let next = Math.abs(span) > 1e-12
        ? lo + (targetCe - flo) * (hi - lo) / span
        : 0.5 * (lo + hi);
      if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);

      mid = next;
      const fmid = f(mid);
      if (Math.abs(fmid - targetCe) <= tol * targetCe) return mid;
      if (fmid < targetCe) { lo = mid; flo = fmid; } else { hi = mid; fhi = fmid; }
    }
    return mid;
  }

  return {
    project,
    solveDose,
    /** Diagnostic — number of clones built this session. */
    get cloneCount() { return lastCloneCount; },
  };
}
