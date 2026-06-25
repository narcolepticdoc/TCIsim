/**
 * tci-modal.js — TCI delay and first-step countdown modals.
 *
 * Extracted from app.js. Manages the TCI plan delay selection modal
 * and the first-step countdown modal that appears after the user
 * commits a TCI plan during a running case.
 */

import { getAllowedUnits, getDefaultUnit, getPrefKey, fromCanonical, formatValue, getQuantizeConfig } from '../util/units.js';
import { getPumpSettings, DRUG_DEFS } from '../util/constants.js';
import { playAlert } from '../ui/alert-sound.js';
import { getSettings } from '../ui/settings.js';

const $ = id => document.getElementById(id);

const TCI_DELAY_OPTIONS = [5, 10, 15, 20, 30]; // seconds

/**
 * Create TCI modal controller.
 *
 * @param {{
 *   model: object,
 *   timer: object,
 *   mode: object,
 *   refreshChart: Function,
 *   closeModal: Function,
 *   addAnnotation: Function,
 * }} deps
 */
export function createTciModal({ model, timer, mode, refreshChart, closeModal, addAnnotation }) {
  // Internal state — previously module-scope vars in app.js
  let pendingTCI           = null;  // { drugId, ceTarget, tciMode }
  let tciDelaySeconds      = 10;    // last-selected delay, persists within session
  let tciCountdownInterval = null;
  let activeStep           = null;  // { drugId, ceTarget, tciMode, ceTolerance, quantConfig, firstStepTime }
  let _autoCloseTimeout    = null;  // ref so "Missed it" can cancel the auto-close

  function showDelay(ceTarget, drugId) {
    const allowed = getAllowedUnits(drugId || 'propofol', 'ceTarget');
    const ceText = allowed.length
      ? allowed.map(u => `${formatValue(fromCanonical(ceTarget, u, drugId, 'ceTarget', {}), u)} ${u}`).join(' / ')
      : `${ceTarget.toFixed(2)} µg/mL`;
    $('tci-delay-subtitle').textContent = `Ce = ${ceText}`;

    // Render delay option pills
    const container = $('tci-delay-options');
    container.innerHTML = '';
    TCI_DELAY_OPTIONS.forEach(sec => {
      const btn = document.createElement('button');
      btn.className = 'tci-delay-opt' + (sec === tciDelaySeconds ? ' active' : '');
      btn.textContent = `${sec}s`;
      btn.addEventListener('click', () => {
        tciDelaySeconds = sec;
        container.querySelectorAll('.tci-delay-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      container.appendChild(btn);
    });

    $('modal-tci-delay').classList.add('open');
  }

  function commit() {
    if (!pendingTCI) return;
    const { drugId, ceTarget, tciMode, ceTolerance, quantConfig } = pendingTCI;
    pendingTCI = null;

    const futureTime = timer.getElapsedMinutes() + tciDelaySeconds / 60;
    mode.setCeTarget(drugId, ceTarget);
    // Prefer the per-plan rounding choice captured by the keypad modal; fall
    // back to the global config when the caller didn't supply one (older
    // entry points that haven't been updated yet).
    const qc = quantConfig || getQuantizeConfig(drugId);
    const { scheme } = model.planTCI(drugId, futureTime, ceTarget, { tciMode, ceTolerance, ...qc });
    activeStep = { drugId, ceTarget, tciMode, ceTolerance, quantConfig: qc, firstStepTime: futureTime };
    mode.set(drugId, 'tci');
    if (addAnnotation) {
      // Show the target in the drug's display unit (e.g. ng/mL for fentanyl /
      // ketamine), not the canonical mcg/mL — mirrors the delay modal's Ce text.
      const ceUnit = getAllowedUnits(drugId, 'ceTarget')[0] || 'mcg/mL';
      const ceDisp = `${formatValue(fromCanonical(ceTarget, ceUnit, drugId, 'ceTarget', {}), ceUnit)} ${ceUnit}`;
      addAnnotation({ heading: 'TCI Target Set', sub: `Ce ${ceDisp}` }, drugId);
    }
    refreshChart();

    closeModal('modal-tci-delay');
    showFirstStep(scheme, drugId, tciDelaySeconds);
  }

  function showFirstStep(scheme, drugId, delaySeconds) {
    const firstStep = scheme && scheme[0];
    if (!firstStep) return;

    // Inject drug name and color into the modal title
    const drugDef  = DRUG_DEFS[drugId] || {};
    const drugName = drugDef.name || drugId;
    const titleEl  = $('tci-fs-title');
    if (titleEl) titleEl.innerHTML =
      `<span class="tci-fs-drug-name">${drugName}</span>` +
      `<span class="tci-fs-step-label">First Step</span>`;
    const modalEl = $('modal-tci-firststep');
    if (modalEl && drugDef.color) modalEl.style.setProperty('--drug-color', drugDef.color);

    // Cancel any leftover auto-close from a previous showing
    if (_autoCloseTimeout) { clearTimeout(_autoCloseTimeout); _autoCloseTimeout = null; }

    const patient = model.getPatient();
    const ps = getPumpSettings(drugId);
    const ctx = { weightKg: patient.weight, concentration: ps.concentration };

    function buildActionHtml(task, canonicalValue, prefix) {
      const allowed = getAllowedUnits(drugId, task);
      // Prefer the clinician's saved display unit (same as history / step bar /
      // drug panel); fall back to the static default when no pref is stored.
      let primary = getDefaultUnit(drugId, task) || allowed[0];
      const prefKey = getPrefKey(drugId, task);
      if (prefKey) {
        try {
          const saved = localStorage.getItem(prefKey);
          if (saved && allowed.includes(saved)) primary = saved;
        } catch (e) { /* ignore */ }
      }
      const primaryVal = fromCanonical(canonicalValue, primary, drugId, task, ctx);
      const primaryStr = `${prefix}${formatValue(primaryVal, primary)} ${primary}`;
      const secondaryParts = allowed
        .filter(u => u !== primary)
        .map(u => `${formatValue(fromCanonical(canonicalValue, u, drugId, task, ctx), u)} ${u}`);
      const secondaryHtml = secondaryParts.length
        ? `<span class="tci-fs-secondary">= ${secondaryParts.join(' · ')}</span>`
        : '';
      return `${primaryStr}${secondaryHtml}`;
    }

    let actionHtml;
    if (firstStep.type === 'bolus') {
      actionHtml = buildActionHtml('bolus', firstStep.value, 'Bolus ');
    } else if (firstStep.value === 0) {
      actionHtml = 'Hold infusion (pump off)';
    } else {
      actionHtml = buildActionHtml('rate', firstStep.value, 'Set rate: ');
    }

    $('tci-fs-action').innerHTML = actionHtml;
    $('modal-tci-firststep').classList.add('open');

    // Clear any existing countdown
    if (tciCountdownInterval) clearInterval(tciCountdownInterval);

    // Reaction-delay bias: the first step is a TCI user action, so reach "Now!"
    // reactionDelaySec ahead of the planned event time — matching the drug-panel
    // step bar and the alert popup. Without this the modal counted to the real
    // event time, finishing reactionDelaySec later than every other cue.
    const reactionDelaySec = getSettings().reactionDelaySec || 0;
    let remainingMs = Math.max(0, delaySeconds - reactionDelaySec) * 1000;
    const intervalMs = 100;

    let _zeroChimeFired = false;
    function tick() {
      const secs = remainingMs / 1000;
      if (secs > 0) {
        $('tci-fs-countdown').textContent = `in ${secs.toFixed(1)}s`;
      } else {
        const wc = timer.getWallClock();
        $('tci-fs-countdown').textContent = wc ? `Now (${timer.formatWallClock()} RT)` : 'Now!';
      }
      if (remainingMs <= 0) {
        if (!_zeroChimeFired) {
          _zeroChimeFired = true;
          playAlert('info');
        }
        clearInterval(tciCountdownInterval);
        tciCountdownInterval = null;
        _autoCloseTimeout = setTimeout(() => closeModal('modal-tci-firststep'), 1500);
      }
      remainingMs -= intervalMs;
    }
    tick();
    tciCountdownInterval = setInterval(tick, intervalMs);
  }

  /** Store pending TCI plan (called from keypad onConfirm). */
  function setPending(tci) { pendingTCI = tci; }

  /** Clear pending state (cancel / overlay / Escape). */
  function cleanupDelay() { pendingTCI = null; }

  /** Clear countdown interval, auto-close timeout, and confirm panel state. */
  function cleanupFirstStep() {
    if (tciCountdownInterval) { clearInterval(tciCountdownInterval); tciCountdownInterval = null; }
    if (_autoCloseTimeout)    { clearTimeout(_autoCloseTimeout);    _autoCloseTimeout = null;    }
    activeStep = null;
    const panel = $('tci-fs-confirm-panel');
    const main  = $('tci-fs-main-actions');
    if (panel) panel.style.display = 'none';
    if (main)  main.style.display  = '';
  }

  /** Wire all modal buttons. */
  function initListeners() {
    const btnConfirm = $('tci-delay-confirm');
    if (btnConfirm) btnConfirm.addEventListener('click', () => commit());
    const btnCancel = $('tci-delay-cancel');
    if (btnCancel) btnCancel.addEventListener('click', () => {
      cleanupDelay();
      closeModal('modal-tci-delay');
    });
    const btnFsOk = $('tci-fs-ok');
    if (btnFsOk) btnFsOk.addEventListener('click', () => {
      cleanupFirstStep();
      closeModal('modal-tci-firststep');
    });

    // "Missed it — Recalculate" → show inline confirmation
    $('tci-fs-missed')?.addEventListener('click', () => {
      if (!activeStep) return;
      if (_autoCloseTimeout) { clearTimeout(_autoCloseTimeout); _autoCloseTimeout = null; }
      const drugName = (DRUG_DEFS[activeStep.drugId] || {}).name || activeStep.drugId;
      const ceUnit   = getAllowedUnits(activeStep.drugId, 'ceTarget')[0] || 'mcg/mL';
      const ceDisp   = `${formatValue(fromCanonical(activeStep.ceTarget, ceUnit, activeStep.drugId, 'ceTarget', {}), ceUnit)} ${ceUnit}`;
      $('tci-fs-confirm-text').innerHTML =
        `TCI events from the missed <b>${drugName}</b> step will be cleared ` +
        `and the target (Ce ${ceDisp}) will be recalculated from now.`;
      $('tci-fs-main-actions').style.display = 'none';
      $('tci-fs-confirm-panel').style.display = '';
    });

    // "No — Go back" → restore main buttons
    $('tci-fs-confirm-no')?.addEventListener('click', () => {
      $('tci-fs-confirm-panel').style.display = 'none';
      $('tci-fs-main-actions').style.display  = '';
    });

    // "Yes, Recalculate" → clear missed events, replan, show new first step
    $('tci-fs-confirm-yes')?.addEventListener('click', () => {
      if (!activeStep) return;
      const { drugId, ceTarget, tciMode, ceTolerance, quantConfig, firstStepTime } = activeStep;
      model.clearFrom(drugId, firstStepTime);
      const currentTime = timer.getElapsedMinutes();
      const qc = quantConfig || getQuantizeConfig(drugId);
      const { scheme: newScheme } = model.planTCI(drugId, currentTime, ceTarget, { tciMode, ceTolerance, ...qc });
      mode.set(drugId, 'tci');
      mode.setCeTarget(drugId, ceTarget);
      if (addAnnotation) addAnnotation({ heading: 'TCI Recalculated', sub: 'Missed step — restarted from now' }, drugId);
      refreshChart();
      cleanupFirstStep();
      closeModal('modal-tci-firststep');
      if (newScheme && newScheme.length) {
        activeStep = { drugId, ceTarget, tciMode, ceTolerance, quantConfig: qc, firstStepTime: currentTime };
        showFirstStep(newScheme, drugId, 0);
      }
    });
  }

  /**
   * Called by app.js after a warn-popup recalculate to show the new first step.
   * stepCtx = { ceTarget, tciMode, ceTolerance, quantConfig }
   */
  function showFirstStepImmediate(scheme, drugId, stepCtx) {
    activeStep = {
      drugId,
      firstStepTime: timer.getElapsedMinutes(),
      ceTarget:    stepCtx.ceTarget,
      tciMode:     stepCtx.tciMode,
      ceTolerance: stepCtx.ceTolerance,
      quantConfig: stepCtx.quantConfig,
    };
    showFirstStep(scheme, drugId, 0);
  }

  return {
    showDelay,
    commit,
    setPending,
    initListeners,
    cleanupDelay,
    cleanupFirstStep,
    showFirstStepImmediate,
  };
}
