/**
 * drug-panel/index.js — Drug Panel Live Display orchestrator.
 *
 * Updates every drug card with live values from the model:
 * Ce, Cp, approach countdown, status+rate, BIS, step-bar. Runs on rAF.
 *
 * Sub-modules handle the heavy lifting:
 *   approach.js     — approach line computation & rendering
 *   step-bar.js     — step bar progress + countdown
 *   exit-readout.js — "time to Exit Ce if stopped now"
 *   formatters.js   — display formatting helpers
 *
 * This file owns the shared ctx object, the rAF lifecycle, and the
 * per-frame update() loop that calls into each sub-module.
 */

import * as settings from '../settings.js';
import { isPumpEnabled } from '../../util/constants.js';
import { fmtCe, fmtRateInline, bisColor, isInBolusPhase, fmtCountdown,
         TCI_FRACTION_DEFAULT, SS_SLOPE_DEFAULT, EXIT_BAND_DEFAULT } from './formatters.js';
import { setCurveData, updateApproachLine, _getApproachCache,
         getPlateauRegion, getSteadyStateCe, invalidateAll,
         _estimateTimeToTarget } from './approach.js';
import { updateStepBar, _intermittentBarPct } from './step-bar.js';
import { updateExitReadout } from './exit-readout.js';

// ── Shared context — populated by init(), read by all sub-modules ──

const ctx = {
  $: id => document.getElementById(id),
  model: null,
  timer: null,
  getMode: null,
  getCeTarget: null,
  getIntermittentThreshold: null,
  getDrugId: null,
  getDrugIds: null,
  getModeForDrug: null,
  getIntermittentThresholdForDrug: null,
  getCeTargetForDrug: null,
  getExitCeForDrug: null,
  getExitCeLabelForDrug: null,
  getTciFraction: () => TCI_FRACTION_DEFAULT,
  getSsSlopeTol: () => SS_SLOPE_DEFAULT,
  getSsExitBand: () => EXIT_BAND_DEFAULT,
};

let rafId   = null;
let onFrame = null;   // callback: (elapsedMinutes) => void

// ── Lifecycle ────────────────────────────────────────────────────

export function init(opts = {}) {
  ctx.model                         = opts.model;
  ctx.timer                         = opts.timer;
  ctx.getMode                       = opts.getMode                       || (() => 'none');
  ctx.getCeTarget                   = opts.getCeTarget                   || (() => 0);
  ctx.getIntermittentThreshold      = opts.getIntermittentThreshold      || (() => 0);
  ctx.getDrugId                     = opts.getDrugId                     || (() => 'propofol');
  ctx.getDrugIds                    = opts.getDrugIds                    || (() => ['propofol', 'fentanyl', 'ketamine']);
  ctx.getModeForDrug                = opts.getModeForDrug                || null;
  ctx.getIntermittentThresholdForDrug = opts.getIntermittentThresholdForDrug || null;
  ctx.getCeTargetForDrug            = opts.getCeTargetForDrug            || null;
  ctx.getExitCeForDrug              = opts.getExitCeForDrug              || (() => 0);
  ctx.getExitCeLabelForDrug         = opts.getExitCeLabelForDrug         || (() => '');
  onFrame                           = opts.onFrame                       || null;
  ctx.getTciFraction                = opts.getTciFraction                || (() => TCI_FRACTION_DEFAULT);
  ctx.getSsSlopeTol                 = opts.getSsSlopeTol                 || (() => SS_SLOPE_DEFAULT);
  ctx.getSsExitBand                 = opts.getSsExitBand                 || (() => EXIT_BAND_DEFAULT);
  loop();
}

export function stop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function loop() {
  update();
  rafId = requestAnimationFrame(loop);
}

// ── Main per-frame update ────────────────────────────────────────

function update() {
  if (!ctx.model || !ctx.timer) return;

  const t           = ctx.timer.getElapsedMinutes();
  const caseStarted = ctx.timer.isRunning() || t > 0;
  const allDrugs    = ctx.getDrugIds ? ctx.getDrugIds() : [ctx.getDrugId()];

  for (const dId of allDrugs) {
    const m         = ctx.getModeForDrug ? ctx.getModeForDrug(dId) : 'none';
    const threshold = ctx.getIntermittentThresholdForDrug ? ctx.getIntermittentThresholdForDrug(dId) : 0;
    // For the approach line and warnings, ceTarget is the TCI target or the
    // redose threshold, depending on drug type.
    const ceTarget = (threshold > 0 && m !== 'tci')
      ? threshold
      : (ctx.getCeTargetForDrug ? ctx.getCeTargetForDrug(dId) : 0);

    let Ce = 0, Cp = 0, rate = 0, bis = null;
    if (caseStarted && t > 0) {
      try {
        const conc = ctx.model.getConcentrationsAt(dId, t);
        Ce = conc.Ce; Cp = conc.Cp; rate = conc.rate;
        try { bis = ctx.model.predictBIS(dId, t); } catch (e) {}
      } catch (e) {}
    }

    // ── Ce / Cp ──────────────────────────────────────────────────
    const ceEl = ctx.$(dId + '-ce');
    const cpEl = ctx.$(dId + '-cp');
    if (ceEl) ceEl.textContent = fmtCe(Ce, dId);
    if (cpEl) cpEl.textContent = fmtCe(Cp, dId);

    // ── Approach line ─────────────────────────────────────────────
    if (caseStarted) {
      updateApproachLine(ctx, dId, t, m, Ce, ceTarget, rate);
      settings.checkBelowThreshold(dId, threshold > 0 && Ce <= ceTarget);
    } else {
      const el = ctx.$(dId + '-approach');
      if (el) el.innerHTML = '';
    }

    // ── Exit Ce readout (upper-right of drug card) ─────────────────
    updateExitReadout(ctx, dId, t, Ce, caseStarted);

    // ── Status + rate ─────────────────────────────────────────────
    const statusEl = ctx.$(dId + '-status');
    const rateEl   = ctx.$(dId + '-rate');

    if (statusEl) {
      let label = 'Stopped', cls = 'stopped';
      const pumpOn = isPumpEnabled(dId);
      if (!caseStarted) {
        label = 'Stopped'; cls = 'stopped';
      } else if (!pumpOn || (m === 'none' && threshold > 0) || (threshold > 0 && m !== 'manual')) {
        // No pump, or threshold-only (no infusion): show bolus status during delivery, blank otherwise
        if (isInBolusPhase(ctx, dId, t) || rate > 50) { label = 'Bolus'; cls = 'bolus'; }
        else { label = ''; cls = ''; }
      } else if (m === 'none') {
        label = 'Stopped'; cls = 'stopped';
      } else if (rate === 0) {
        label = 'Paused'; cls = 'paused';
      } else if (isInBolusPhase(ctx, dId, t) || rate > 50) {
        label = 'Bolus'; cls = 'bolus';
      } else {
        label = 'Infusing'; cls = 'infusing';
      }
      statusEl.textContent = label;
      statusEl.className   = 'drug-status ' + cls;
    }

    if (rateEl) {
      rateEl.textContent = (caseStarted && rate > 0) ? fmtRateInline(ctx, dId, rate) : '';
    }

    // ── eBIS header-row placement (propofol-only; empty hides via :empty CSS rule) ──
    // Label is muted + smaller; value carries the color from bisColor().
    const bisHeaderEl = ctx.$(dId + '-bis-header');
    if (bisHeaderEl) {
      const bisVis = bis !== null && caseStarted && t > 0;
      if (bisVis) {
        bisHeaderEl.innerHTML = `<span class="bis-label">eBIS</span> <span class="bis-value">${bis.toFixed(0)}</span>`;
        const valEl = bisHeaderEl.querySelector('.bis-value');
        if (valEl) valEl.style.color = bisColor(bis);
      } else {
        bisHeaderEl.innerHTML = '';
      }
    }

    // ── Step bar ──────────────────────────────────────────────────
    if (caseStarted) {
      if (threshold === 0) {
        updateStepBar(ctx, dId, t);
      } else {
        // Threshold set: during bolus delivery show progress normally;
        // after delivery show the redose countdown from the approach cache.
        const barEl = ctx.$(dId + '-bar');
        const cntEl = ctx.$(dId + '-bar-countdown');
        let hasNextEvt = false;
        try { hasNextEvt = ctx.model.getEvents(dId).some(e => e.time > t + 0.0001); } catch (e) {}

        const cache = _getApproachCache(dId);
        if (hasNextEvt) {
          updateStepBar(ctx, dId, t);
          barEl?.parentElement?.classList.remove('step-bar-below');
        } else if (cache.arrivalMin !== null) {
          const rem = cache.arrivalMin - t;
          barEl?.parentElement?.classList.remove('step-bar-below');
          if (barEl) barEl.style.width = _intermittentBarPct(ctx, dId, t, cache.arrivalMin) + '%';
          if (cntEl) {
            const ceStr = fmtCe(ceTarget, dId, 1);
            const newHtml = rem > 0
              ? `Redose Threshold <span class="appr-val">${ceStr}</span> in <span class="appr-time">${fmtCountdown(rem)}</span>` : '';
            if (cntEl.innerHTML !== newHtml) cntEl.innerHTML = newHtml;
          }
        } else if (m === 'manual') {
          // Combined state (infusion + threshold) with no redose needed —
          // the infusion keeps Ce above threshold. Show normal step bar.
          updateStepBar(ctx, dId, t);
          barEl?.parentElement?.classList.remove('step-bar-below');
          if (cntEl && cntEl.innerHTML !== '') cntEl.innerHTML = '';
        } else {
          // Threshold-only, Ce below threshold — red "below" indicator
          barEl?.parentElement?.classList.add('step-bar-below');
          if (barEl) barEl.style.width = '0%';
          if (cntEl && cntEl.innerHTML !== '') cntEl.innerHTML = '';
        }
      }
    } else {
      // Case not started — clear stale step bar data from previous case
      const barEl = ctx.$(dId + '-bar');
      const cntEl = ctx.$(dId + '-bar-countdown');
      if (barEl) barEl.style.width = '0%';
      if (cntEl && cntEl.innerHTML !== '') cntEl.innerHTML = '';
      barEl?.parentElement?.classList.remove('step-bar-below');
    }

    // ── Right-side status indicator ───────────────────────────────
    const cardEl = document.getElementById('drug-' + dId);
    if (cardEl) {
      let status = 'off';
      if (caseStarted && (m !== 'none' || threshold > 0)) {
        if (threshold > 0 && ceTarget > 0 && Ce <= ceTarget) {
          status = 'alert';                      // below redose threshold
        } else if (rate === 0 && threshold === 0) {
          status = 'alert';                      // pump paused / stopped (no threshold)
        } else {
          const warnMin = settings.getSettings().statusWarnMinutes ?? 2;
          let isWarn = false;
          // Next scheduled manual event (rate change, bolus, pause, TCI step)
          try {
            const evts    = ctx.model.getEvents(dId);
            const nextEvt = evts.find(e => e.time > t + 0.0001 && e.source !== 'system');
            if (nextEvt && (nextEvt.time - t) <= warnMin) isWarn = true;
          } catch (e) {}
          // Redose due within warn window (whenever threshold is set)
          if (!isWarn && threshold > 0) {
            const cache = _getApproachCache(dId);
            if (cache.arrivalMin !== null && (cache.arrivalMin - t) <= warnMin) isWarn = true;
          }
          status = isWarn ? 'warn' : 'ok';
        }
      }
      if (cardEl.dataset.status !== status) cardEl.dataset.status = status;
    }
  }

  // ── Notify app.js for chart cursor ─────────────────────────────
  if (onFrame) onFrame(t);
}

// ── Public API (re-exported through the shim) ────────────────────

export { setCurveData, _estimateTimeToTarget, getPlateauRegion, getSteadyStateCe };

/** Force an immediate update (after a model mutation). */
export function forceUpdate() {
  invalidateAll();
  update();
}
