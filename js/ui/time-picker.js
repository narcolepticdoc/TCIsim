/**
 * time-picker.js — Shared case-time / real-time picker for modals.
 *
 * Extracted from event-editor.js and reconcile-modal.js, which carried
 * near-identical copies. One factory, parameterized by the only deliberate
 * divergences between the two:
 *   - labelStyle: 'prefix' (`= RT h:mm`, event editor) vs
 *                 'suffix' (`= h:mm RT`, reconcile modal)
 *   - isRunning: the "real" tab enable source — controls.isCaseStarted()
 *     (event editor) vs wall-clock presence (reconcile modal)
 *
 * The case↔real unit toggle round-trips the in-progress selection through
 * case minutes (CLAUDE.md: unit toggles convert, they don't clear).
 *
 * A real-time pick is resolved against the live case, not pinned to the start's
 * calendar day: in a case that crosses midnight, 00:30 is after the 23:00 start,
 * not 22.5 h before it (see util/clock-time.js).
 */

import { resolveCaseClockTime } from '../util/clock-time.js';

const $ = (id) => document.getElementById(id);

export function buildTimeSelect(selectEl, count, padLen, selectedVal, onchange) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = String(i).padStart(padLen, '0');
    if (i === selectedVal) opt.selected = true;
    selectEl.appendChild(opt);
  }
  selectEl.onchange = onchange;
}

export function getSelectInt(id) {
  const el = $(id);
  return el ? parseInt(el.value, 10) || 0 : 0;
}

/**
 * Case minutes → the [hours, minutes] the selects show. Rounds once, on the
 * total: rounding only the minutes turned 59.6 into 0:60, which matches no
 * option, so the select fell back to 00 and read 0:00 — an hour early.
 */
function splitHM(minutes) {
  const total = Math.round(minutes);
  return [Math.floor(total / 60), total % 60];
}

/**
 * Hour options for a case-time select: 0–23, and never too few for the hour
 * shown. Past ET 24:00 the hour had no option, the select fell back to 00, and
 * saving the event moved it back a day.
 */
function caseHourCount(h) {
  return Math.max(24, h + 1);
}

/**
 * @param {Object} cfg
 * @param {string} cfg.hoursId        - <select> id for hours
 * @param {string} cfg.minutesId      - <select> id for minutes
 * @param {string} cfg.unitRowSel     - querySelector for the case/real .tp-unit buttons
 * @param {string} cfg.conversionId   - element id for the conversion label
 * @param {Function} cfg.getWallClockStart - () => Date|null
 * @param {Function} cfg.getNowMinutes - () => current case time (min); a real-time
 *                                       pick is read relative to it across midnight
 * @param {Function} cfg.isRunning    - () => boolean ("real" tab enabled + case→RT label)
 * @param {'prefix'|'suffix'} cfg.labelStyle
 * @param {Function} [cfg.onChange]   - called after any select change or unit toggle
 * @returns {{ setCaseMinutes, getCaseMinutes, setUnit, getUnit, wireUnitButtons }}
 */
export function makeTimePicker({
  hoursId, minutesId, unitRowSel, conversionId,
  getWallClockStart, getNowMinutes, isRunning, labelStyle, onChange,
}) {
  let timeUnit = 'case'; // 'case' | 'real'

  const wallStart = () => (getWallClockStart ? getWallClockStart() : null);

  function fmtLabel(kind /* 'RT' | 'ET' */, h, mStr) {
    return labelStyle === 'suffix' ? `= ${h}:${mStr} ${kind}` : `= ${kind} ${h}:${mStr}`;
  }

  function handleSelectChange() {
    updateConversion();
    if (onChange) onChange();
  }

  function syncUnitButtons() {
    const running = isRunning();
    document.querySelectorAll(unitRowSel).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === timeUnit);
      if (btn.dataset.unit === 'real') btn.disabled = !running;
    });
  }

  function getCaseMinutes() {
    if (timeUnit === 'case') {
      return getSelectInt(hoursId) * 60 + getSelectInt(minutesId);
    }
    const ws = wallStart();
    if (!ws) return getSelectInt(hoursId) * 60 + getSelectInt(minutesId);
    const nowMin = getNowMinutes ? getNowMinutes() : 0;
    const target = resolveCaseClockTime(getSelectInt(hoursId), getSelectInt(minutesId),
      ws, new Date(ws.getTime() + nowMin * 60000));
    // A time before the start still clamps onto it.
    return Math.max(0, (target - ws) / 60000);
  }

  function updateConversion() {
    const cv = $(conversionId);
    if (!cv) return;
    const ws = wallStart();
    if (timeUnit === 'case') {
      const caseMin = getSelectInt(hoursId) * 60 + getSelectInt(minutesId);
      if (isRunning() && ws) {
        const rd = new Date(ws.getTime() + caseMin * 60000);
        cv.textContent = fmtLabel('RT', rd.getHours(), String(rd.getMinutes()).padStart(2, '0'));
      } else { cv.textContent = ''; }
    } else if (ws) {
      const [h, m] = splitHM(getCaseMinutes());
      cv.textContent = fmtLabel('ET', h, String(m).padStart(2, '0'));
    } else { cv.textContent = ''; }
  }

  /** Reset picker to case mode at the given case time (modal open path). */
  function setCaseMinutes(minutes) {
    timeUnit = 'case';
    const [h, m] = splitHM(minutes);
    buildTimeSelect($(hoursId), caseHourCount(h), 2, h, handleSelectChange);
    buildTimeSelect($(minutesId), 60, 2, m, handleSelectChange);
    syncUnitButtons();
    updateConversion();
  }

  /** Toggle case↔real, converting the in-progress selection. */
  function setUnit(unit) {
    if (unit === timeUnit) return;
    const caseMin = getCaseMinutes();
    timeUnit = unit;
    syncUnitButtons();
    if (unit === 'case') {
      const [h, m] = splitHM(caseMin);
      buildTimeSelect($(hoursId), caseHourCount(h), 2, h, handleSelectChange);
      buildTimeSelect($(minutesId), 60, 2, m, handleSelectChange);
    } else {
      const ws = wallStart();
      if (ws) {
        const realDate = new Date(ws.getTime() + caseMin * 60000);
        buildTimeSelect($(hoursId), 24, 2, realDate.getHours(), handleSelectChange);
        buildTimeSelect($(minutesId), 60, 2, realDate.getMinutes(), handleSelectChange);
      }
    }
    updateConversion();
    if (onChange) onChange();
  }

  /** Bind the case/real toggle buttons (call once at init). */
  function wireUnitButtons() {
    document.querySelectorAll(unitRowSel).forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        setUnit(btn.dataset.unit);
      });
    });
  }

  return {
    setCaseMinutes, getCaseMinutes, setUnit, wireUnitButtons,
    getUnit: () => timeUnit,
    refreshConversion: updateConversion,
    // The pause-duration selects share the select builder and historically
    // refresh the conversion label on change — pass this as their onchange.
    handleSelectChange,
  };
}
