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
 */

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
 * @param {Object} cfg
 * @param {string} cfg.hoursId        - <select> id for hours
 * @param {string} cfg.minutesId      - <select> id for minutes
 * @param {string} cfg.unitRowSel     - querySelector for the case/real .tp-unit buttons
 * @param {string} cfg.conversionId   - element id for the conversion label
 * @param {Function} cfg.getWallClockStart - () => Date|null
 * @param {Function} cfg.isRunning    - () => boolean ("real" tab enabled + case→RT label)
 * @param {'prefix'|'suffix'} cfg.labelStyle
 * @param {Function} [cfg.onChange]   - called after any select change or unit toggle
 * @returns {{ setCaseMinutes, getCaseMinutes, setUnit, getUnit, wireUnitButtons }}
 */
export function makeTimePicker({
  hoursId, minutesId, unitRowSel, conversionId,
  getWallClockStart, isRunning, labelStyle, onChange,
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
    const target = new Date(ws);
    target.setHours(getSelectInt(hoursId), getSelectInt(minutesId), 0, 0);
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
      const caseMin = getCaseMinutes();
      cv.textContent = fmtLabel('ET',
        Math.floor(caseMin / 60), String(Math.round(caseMin % 60)).padStart(2, '0'));
    } else { cv.textContent = ''; }
  }

  /** Reset picker to case mode at the given case time (modal open path). */
  function setCaseMinutes(minutes) {
    timeUnit = 'case';
    buildTimeSelect($(hoursId), 24, 2, Math.floor(minutes / 60), handleSelectChange);
    buildTimeSelect($(minutesId), 60, 2, Math.round(minutes % 60), handleSelectChange);
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
      buildTimeSelect($(hoursId), 24, 2, Math.floor(caseMin / 60), handleSelectChange);
      buildTimeSelect($(minutesId), 60, 2, Math.round(caseMin % 60), handleSelectChange);
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
