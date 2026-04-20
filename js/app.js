/**
 * app.js — Application Entry Point
 *
 * Creates the simulation model, initializes UI modules, manages
 * screen navigation. Sub-modules under js/app/ handle:
 *   settings-ui.js  — Settings modal DOM wiring
 *   tci-modal.js    — TCI delay + first-step countdown modals
 *   session.js      — Case save / restore / new case
 *   chart-bridge.js — Chart refresh, effect overlay, per-frame updates
 */

import { createModel, NO_TCI_DRUGS } from './sim/simulation.js';
import * as setup from './ui/setup.js';
import * as timer from './ui/timer.js';
import * as controls from './ui/controls.js';
import * as keypad from './ui/keypad.js';
import * as mode from './ui/mode.js';
import * as drugPanel from './ui/drug-panel.js';
import * as history from './ui/history.js';
import * as eventEditor from './ui/event-editor.js';
import { createChart } from './ui/chart.js';
import { bolusDeliveryMinutes, APP_VERSION, DRUG_IDS, isPumpEnabled } from './util/constants.js';
import { getQuantizeConfig } from './util/units.js';
import * as persist from './ui/persist.js';
import * as settings from './ui/settings.js';
import { initSettingsUI } from './app/settings-ui.js';
import { createTciModal } from './app/tci-modal.js';
import { createSession } from './app/session.js';
import { createChartBridge } from './app/chart-bridge.js';

const $ = id => document.getElementById(id);

// ---- Application State ----
let model = null;
let confirmedPatient = null;
let selectedDrug = 'propofol';
let chart = null;
const preStartClock = {}; // { [drugId]: minutes } — per-drug so multi-drug events can overlap
function getPreStartClock(drugId) { return preStartClock[drugId] || 0; }
function advancePreStartClock(drugId, by) { preStartClock[drugId] = (preStartClock[drugId] || 0) + by; }
let annotations = []; // mode transitions, editorial actions

// Controllers — created in boot()
let tciModal = null;
let session = null;
let chartBridge = null;

// ---- Screen Navigation ----

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---- Sim Screen Initialization ----

function initSimScreen(patient) {
  const p = patient;
  const bmi = (p.weight / Math.pow(p.height / 100, 2)).toFixed(1);
  $('patient-summary').innerHTML =
    `<span class="ps-val">${p.age}y</span> ` +
    `<span class="ps-val">${p.male ? 'M' : 'F'}</span> ` +
    `<span class="ps-val">${p.weight}kg</span> ` +
    `<span class="ps-val">${p.height}cm</span> ` +
    `BMI <span class="ps-val">${bmi}</span>`;

  // Update drug model labels. Model names come from model.getModelName()
  // so swapping in a different PK model later is a one-place change.
  const modelLabel = $('propofol-model-label');
  if (modelLabel) {
    const conc = $('input-concentration')?.value || '10';
    const opioid = p.opioid ? ' · +opioid' : '';
    const tciMode = setup.getTciMode ? setup.getTciMode() : 'stepped';
    const modeLabel = tciMode === 'cet' ? ' · CET' :
                      tciMode === 'cet-conservative' ? ' · CET(C)' :
                      tciMode === 'cet-emulation' ? ' · CET(E)' : '';
    modelLabel.textContent = `${model.getModelName('propofol')} · ${conc} mg/mL${opioid}${modeLabel}`;
  }
  const fentLabel = $('fentanyl-model-label');
  if (fentLabel) {
    const fConc = $('input-fentanyl-concentration')?.value || '0.05';
    const fConcMcg = (parseFloat(fConc) * 1000).toFixed(0);
    fentLabel.textContent = `${model.getModelName('fentanyl')} · ${fConcMcg} mcg/mL`;
  }
  const ketLabel = $('ketamine-model-label');
  if (ketLabel) {
    const kConc = $('input-ketamine-concentration')?.value || '10';
    ketLabel.textContent = `${model.getModelName('ketamine')} · ${kConc} mg/mL`;
  }

  // Reset modules
  controls.reset();
  mode.reset();
  Object.keys(preStartClock).forEach(k => delete preStartClock[k]);
  annotations = [];

  // Reset drug selection to propofol (default)
  selectedDrug = 'propofol';
  document.querySelectorAll('.drug-card').forEach(c => c.classList.remove('active'));
  document.getElementById('drug-propofol')?.classList.add('active');
  keypad.setDrug('propofol');
  eventEditor.setDrug('propofol');
  history.setDrug('propofol');

  // Reset sim screen state
  $('history-list').innerHTML = '';
  $('history-empty').style.display = 'block';

  // Reset chart placeholder
  const placeholder = $('chart-placeholder');
  const canvas = $('chart-canvas');
  const chartControls = $('chart-controls');
  if (placeholder) placeholder.style.display = '';
  if (canvas) canvas.style.display = 'none';
  if (chartControls) chartControls.style.display = 'none';

  // Reset chart-control button state so it matches the fresh chart below.
  // The new chart starts with inspect/event-annotations off and unexpanded,
  // but the `.active` classes (and expand glyph) persist across cases.
  $('btn-chart-tooltip')?.classList.remove('active');
  $('btn-chart-events')?.classList.remove('active');
  const btnExpand = $('btn-chart-expand');
  if (btnExpand) {
    btnExpand.classList.remove('active');
    btnExpand.textContent = '⤢';
    btnExpand.title = 'Expand chart';
  }
  $('sim-content')?.classList.remove('chart-expanded');

  // Destroy old chart if exists
  if (chart) { chart.destroy(); chart = null; }

  // Create new chart
  if (canvas) {
    try {
      chart = createChart(canvas, { drugId: selectedDrug, showCp: true, showCe: true });
      // Give chart access to PD model for BIS in tooltips
      const pd = model.getPDModel(selectedDrug);
      if (pd) chart.setPDModel(pd);
      // Give chart patient weight for rate unit conversion in tooltip
      try { const pt = model.getPatient(); if (pt) chart.setPatientWeight(pt.weight); } catch (e) {}
      // Apply per-drug y-axis config (label, scale, default range)
      const initCfg = chartBridge.getConfig(selectedDrug);
      chart.switchDrug(selectedDrug, initCfg.yLabel, initCfg.yDefault, initCfg.yScale);
      chartBridge.computeEffectOverlay();
    } catch (err) {
      console.error('[TCI Sim] Chart creation failed:', err);
    }
  }
}

// ---- Annotations ----

function addAnnotation(text) {
  if (!text) return;
  const t = Math.floor(timer.getElapsedMs() / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ts = h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  annotations.push({ time: ts, text });

  // Render to history panel (temporary — will be replaced by event-driven rendering)
  const list = $('history-list');
  const empty = $('history-empty');
  if (list && empty) {
    empty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = `<span class="h-step">${annotations.length - 1}</span>` +
      `<span class="h-desc"></span>` +
      `<span class="h-time">${ts}</span>`;
    row.querySelector('.h-desc').textContent = text;
    list.appendChild(row);
  }
}

// ---- Boot ----

function boot() {
  // Display app version
  const vt = document.getElementById('app-version-tag');
  if (vt) vt.textContent = 'v' + APP_VERSION;

  // Create the model
  model = createModel({ primaryDrug: 'propofol' });

  // Create chart bridge (refreshChart, effect overlay, onFrame).
  // Uses late-binding for session.save() since session is created below.
  chartBridge = createChartBridge({
    getChart: () => chart,
    getModel: () => model,
    timer,
    getSelectedDrug: () => selectedDrug,
    mode, drugPanel, history, settings,
    save: () => session.save(),
  });

  // Convenience alias — many call sites in boot() use refreshChart()
  const refreshChart = () => chartBridge.refresh();

  // Create TCI modal controller
  tciModal = createTciModal({ model, timer, mode, refreshChart, closeModal });

  // Create session controller (save/restore/new case)
  session = createSession({
    getModel: () => model,
    getConfirmedPatient: () => confirmedPatient,
    setConfirmedPatient: (p) => { confirmedPatient = p; },
    getSelectedDrug: () => selectedDrug,
    getAnnotations: () => annotations,
    setAnnotations: (a) => { annotations = a; },
    getChart: () => chart,
    destroyChart: () => { if (chart) { chart.destroy(); chart = null; } },
    timer, mode, settings, controls, setup,
    initSimScreen, showScreen, addAnnotation, refreshChart,
  });

  // Show restore button if saved case exists
  const btnRestore = $('btn-restore');
  if (btnRestore) {
    if (persist.hasSavedCase()) {
      const summary = persist.getSavedCaseSummary();
      btnRestore.innerHTML = `Restore Last Case${summary ? `<span class="restore-summary">${summary}</span>` : ''}`;
      btnRestore.style.display = '';
      btnRestore.addEventListener('click', () => session.restore());
    } else {
      btnRestore.style.display = 'none';
    }
  }

  // Initialize setup screen
  setup.init({
    onConfirm(patient) {
      try {
        confirmedPatient = patient;
        model.setPatient(patient);
        // Refresh drug configs for secondary drugs (pump settings may have changed)
        model.refreshDrugConfig('fentanyl');
        model.refreshDrugConfig('ketamine');
        initSimScreen(patient);
      } catch (err) {
        console.error('[TCI Sim] onConfirm error:', err);
      }
      showScreen('sim-screen');
    },
  });

  // Initialize timer
  timer.init({
    onTick(elapsedMs) {
      // Will drive live readout in Step 4
    },
  });

  // Initialize controls (start case / pause pump)
  controls.init({
    timer,
    onCaseStart() {
      Object.keys(preStartClock).forEach(k => delete preStartClock[k]);
      addAnnotation('Case started');
      // Re-evaluate button visibility now that case has started —
      // hides Stop Pump for drugs without a pump.
      mode.refreshUI(selectedDrug);
    },
    onPumpPause() {
      if (!isPumpEnabled(selectedDrug)) return; // no pump to pause
      const t = timer.getElapsedMinutes();
      // Guard: don't pause if already manually paused (rate=0 in non-TCI mode)
      // Allow the button to fire in TCI mode even when rate=0 (TCI-scheduled pause),
      // so the user can clear all future TCI events and stop the pump.
      try {
        const conc = model.getConcentrationsAt(selectedDrug, t);
        if (conc.rate === 0 && mode.get(selectedDrug) !== 'tci') return;
      } catch (e) {}

      model.addPause(selectedDrug, t, 'Pump stopped');
      addAnnotation('Pump stopped');
      // Stop drops out of current mode and clears future events
      if (mode.get(selectedDrug) === 'tci') {
        model.clearAfter(selectedDrug, t);
      }
      if (mode.get(selectedDrug) !== 'none') {
        mode.set(selectedDrug, 'none', 'Pump stopped');
      }
      refreshChart();
    },
  });

  // Initialize mode tracking
  mode.init({
    onModeChange(drugId, newMode, oldMode, detail) {
      if (detail) addAnnotation(detail);
      // Keep history filter in sync — show bolus-only when threshold is set
      // and no infusion is running (pure intermittent mode)
      if (drugId === selectedDrug) {
        const hasThreshold = mode.getIntermittentThreshold(drugId) > 0;
        history.setBolusOnly(!isPumpEnabled(drugId) || (hasThreshold && newMode !== 'manual'));
      }
    },
  });

  // Initialize keypad
  keypad.init({
    getPatient: () => model ? model.getPatient() : null,
    getMode: () => mode.get(selectedDrug),
    getCeTarget: () => mode.getCeTarget(selectedDrug),
    isTciDrug: () => !NO_TCI_DRUGS.has(selectedDrug),
    getExitCe: () => mode.getExitCe(selectedDrug),
    getIntermittentThreshold: () => mode.getIntermittentThreshold(selectedDrug),
    isPumpEnabled: () => isPumpEnabled(selectedDrug),
    onConfirm(type, canonicalValue, displayText, deliveryMode) {
      let t;
      if (controls.isCaseStarted()) {
        t = timer.getElapsedMinutes();
      } else {
        // Pre-start plan mode: each drug has its own clock so multi-drug events can overlap
        t = getPreStartClock(selectedDrug);
      }

      if (type === 'ceTarget') {
        const tciMode = setup.getTciMode ? setup.getTciMode() : 'stepped';
        if (controls.isCaseStarted()) {
          // During running case: show delay modal so user can pre-set the pump.
          // planTCI is deferred to when the user confirms the delay.
          tciModal.setPending({ drugId: selectedDrug, ceTarget: canonicalValue, tciMode });
          tciModal.showDelay(canonicalValue, selectedDrug);
          return; // skip refreshChart — nothing committed yet
        } else {
          // Pre-case: plan immediately, no delay needed
          mode.setCeTarget(selectedDrug, canonicalValue);
          model.planTCI(selectedDrug, t, canonicalValue, { tciMode, ...getQuantizeConfig(selectedDrug) });
          mode.set(selectedDrug, 'tci', `TCI target Ce=${canonicalValue.toFixed(1)} μg/mL`);
          advancePreStartClock(selectedDrug, 0.01);
        }
      } else if (type === 'rate') {
        if (!isPumpEnabled(selectedDrug)) return; // no pump — rate not available
        // Manual rate — drops out of TCI
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
        }
        model.addRate(selectedDrug, t, canonicalValue, `Rate ${displayText}`);
        mode.set(selectedDrug, 'manual', `Manual rate: ${displayText}`);
        // Rate change is near-instantaneous
        if (!controls.isCaseStarted()) advancePreStartClock(selectedDrug, 0.01);
      } else if (type === 'intermittent') {
        // Redose threshold — independent overlay, does not change mode
        if (canonicalValue <= 0) {
          mode.clearIntermittentThreshold(selectedDrug);
          addAnnotation('Redose threshold cleared');
        } else {
          mode.setIntermittentThreshold(selectedDrug, canonicalValue);
          addAnnotation(`Redose threshold ${displayText}`);
        }
        mode.refreshUI(selectedDrug);
        // Update history filter for the new threshold state
        const isInfusing = mode.get(selectedDrug) === 'manual';
        history.setBolusOnly(!isPumpEnabled(selectedDrug) || !isInfusing);
        refreshChart();
        return; // refreshChart already called
      } else if (type === 'exitCe') {
        if (canonicalValue <= 0) {
          mode.clearExitCe(selectedDrug);
          addAnnotation('Exit Ce cleared');
        } else {
          // Extract just the numeric part the user typed (e.g. "1.5" from "1.5 mcg/mL")
          const numLabel = displayText.split(' ')[0];
          mode.setExitCe(selectedDrug, canonicalValue, numLabel);
          addAnnotation(`Exit Ce set to ${displayText}`);
        }
        refreshChart();   // updates the exit line with correct yScale
        return;
      } else if (type === 'bolus') {
        const pumpOn = isPumpEnabled(selectedDrug);
        // Bolus — if in TCI, clear forward plan first, then bolus
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
          mode.set(selectedDrug, 'manual', 'Dropped out of TCI — manual bolus');
        } else if (mode.get(selectedDrug) === 'none' && !NO_TCI_DRUGS.has(selectedDrug) && pumpOn) {
          // TCI-capable drug with pump: bolus from 'none' implies manual mode
          mode.set(selectedDrug, 'manual');
        }
        // No pump, or threshold set + no infusion → always IV Push; otherwise respect keypad choice
        const hasThreshold = mode.getIntermittentThreshold(selectedDrug) > 0;
        const isInfusing = mode.get(selectedDrug) === 'manual';
        const dm = (!pumpOn || (hasThreshold && !isInfusing)) ? 'push' : (deliveryMode || 'pump');
        const label = dm === 'push' ? 'IV Push' : 'Pump Bolus';
        model.addBolus(selectedDrug, t, canonicalValue, `${label} ${displayText}`, {
          deliveryMode: dm,
        });
        // Advance this drug's clock by its bolus delivery duration
        if (!controls.isCaseStarted()) {
          const deliveryMin = dm === 'push'
            ? 10 / 60  // 10 seconds
            : bolusDeliveryMinutes(canonicalValue, selectedDrug);
          advancePreStartClock(selectedDrug, deliveryMin);
        }
      }

      refreshChart();
    },
  });

  // Wire drug card selection
  document.querySelectorAll('.drug-card').forEach(card => {
    card.addEventListener('click', () => {
      const drugId = card.id.replace('drug-', '');
      selectedDrug = drugId;
      keypad.setDrug(drugId);
      eventEditor.setDrug(drugId);
      mode.refreshUI(drugId);
      const hasThreshold = mode.getIntermittentThreshold(drugId) > 0;
      history.setBolusOnly(!isPumpEnabled(drugId) || (hasThreshold && mode.get(drugId) !== 'manual'));
      history.setDrug(drugId);
      history.render();
      // Switch chart to new drug's y-axis config (label, scale, persisted range)
      if (chart) {
        const cfg = chartBridge.getConfig(drugId);
        chart.switchDrug(drugId, cfg.yLabel, cfg.yDefault, cfg.yScale);
      }
      refreshChart();
      document.querySelectorAll('.drug-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // Initialize drug panel (live readout)
  drugPanel.init({
    model,
    timer,
    getMode: () => mode.get(selectedDrug),
    getCeTarget: () => {
      // Non-TCI drugs: ceTarget is the redose threshold (independent of mode)
      if (NO_TCI_DRUGS.has(selectedDrug)) return mode.getIntermittentThreshold(selectedDrug);
      return mode.getCeTarget(selectedDrug);
    },
    getIntermittentThreshold: () => mode.getIntermittentThreshold(selectedDrug),
    getDrugId: () => selectedDrug,
    getDrugIds: () => DRUG_IDS,
    getModeForDrug: (drugId) => mode.get(drugId),
    getIntermittentThresholdForDrug: (drugId) => mode.getIntermittentThreshold(drugId),
    getCeTargetForDrug: (drugId) => mode.getCeTarget(drugId),
    getExitCeForDrug: (drugId) => mode.getExitCe(drugId),
    getExitCeLabelForDrug: (drugId) => mode.getExitCeLabel(drugId),
    getTciFraction: () => settings.getSettings().tciFraction,
    getSsSlopeTol:  () => settings.getSettings().ssSlopeTol,
    getSsExitBand:  () => settings.getSettings().exitBandPct,
    onFrame: (t) => chartBridge.onFrame(t),
  });

  history.init({
    model,
    getElapsedMinutes: () => timer.getElapsedMinutes(),
    getPatient: () => model ? model.getPatient() : { weight: 70 },
    getWallClockStart: () => timer.getWallClockStart(),
    onEventTap: (evtId) => eventEditor.openEdit(evtId),
  });

  eventEditor.init({
    model,
    mode,
    timer,
    controls,
    refreshChart,
    getPatient: () => model ? model.getPatient() : { weight: 70 },
  });

  // Initialize warnings
  settings.init({
    model,
    getDrugIds: () => DRUG_IDS,
    getPatient:  () => model ? model.getPatient() : null,
  });

  // Wire settings modal (sliders, checkboxes, tabs, open/close)
  initSettingsUI({ getSettings: () => settings.getSettings(), setSettings: s => settings.setSettings(s) });

  // Wire new case dialog
  const btnNewCase = $('btn-new-case');
  if (btnNewCase) btnNewCase.addEventListener('click', () => {
    $('modal-new-case').classList.add('open');
  });

  // Wire chart controls
  const btnChartReset = $('btn-chart-reset');
  if (btnChartReset) btnChartReset.addEventListener('click', () => {
    if (chart) chart.resetView();
  });
  const btnChartExpand = $('btn-chart-expand');
  if (btnChartExpand) btnChartExpand.addEventListener('click', () => {
    const sc = $('sim-content');
    const expanded = sc.classList.toggle('chart-expanded');
    btnChartExpand.textContent = expanded ? '⤡' : '⤢';
    btnChartExpand.title = expanded ? 'Restore split view' : 'Expand chart';
    btnChartExpand.classList.toggle('active', expanded);
    if (chart) setTimeout(() => chart.chart.resize(), 0);
  });
  const btnChartTooltip = $('btn-chart-tooltip');
  if (btnChartTooltip) btnChartTooltip.addEventListener('click', () => {
    if (chart) {
      const enabled = chart.toggleInspect();
      btnChartTooltip.classList.toggle('active', enabled);
    }
  });
  const btnChartEvents = $('btn-chart-events');
  if (btnChartEvents) btnChartEvents.addEventListener('click', () => {
    if (chart) {
      const enabled = chart.toggleEventAnnotations();
      btnChartEvents.classList.toggle('active', enabled);
    }
  });
  const btnNewCaseConfirm = $('btn-new-case-confirm');
  if (btnNewCaseConfirm) btnNewCaseConfirm.addEventListener('click', () => {
    closeModal('modal-new-case');
    session.newCase();
  });
  const btnNewCaseCancel = $('btn-new-case-cancel');
  if (btnNewCaseCancel) btnNewCaseCancel.addEventListener('click', () => {
    closeModal('modal-new-case');
  });

  // Wire TCI delay and first-step countdown modals
  tciModal.initListeners();

  // Wire modal close (click overlay or Escape)
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target !== o) return;
      if (o.id === 'modal-tci-delay') tciModal.cleanupDelay();
      if (o.id === 'modal-tci-firststep') tciModal.cleanupFirstStep();
      o.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('modal-tci-delay').classList.contains('open')) tciModal.cleanupDelay();
      if ($('modal-tci-firststep').classList.contains('open')) tciModal.cleanupFirstStep();
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });

  // Wire view tabs (chart/history) — basic toggle for now
  const viewChart = $('view-chart');
  const viewHistory = $('view-history');
  if (viewChart) viewChart.addEventListener('click', () => setView('chart'));
  if (viewHistory) viewHistory.addEventListener('click', () => setView('history'));

  // Orientation lock removed — portrait layout now supported on phones
}

function closeModal(id) {
  $(id).classList.remove('open');
}

function setView(v) {
  // Tab buttons (kept in sync even on tablet in case of resize back to phone)
  $('view-chart').classList.toggle('active', v === 'chart');
  $('view-history').classList.toggle('active', v === 'history');
  // On tablet (split layout ≥1020px), both panels are always visible via CSS
  if (window.innerWidth < 1020) {
    $('panel-chart').classList.toggle('active', v === 'chart');
    $('panel-history').classList.toggle('active', v === 'history');
  }
}

// ---- Expose for shim compatibility and debugging ----
window.__tciSim = {
  get model() { return model; },
  get timer() { return timer; },
  get controls() { return controls; },
  addAnnotation,
};

// ---- Go ----
try {
  boot();
  window.__tciSimLoaded = true;
  console.log('[TCI Sim] app.js loaded successfully');
} catch (err) {
  console.error('[TCI Sim] boot failed:', err);
  const el = document.getElementById('derived-bar');
  if (el) {
    el.style.display = 'flex';
    el.innerHTML = `<div style="color:red;font-size:12px">App failed to initialize: ${err.message}</div>`;
  }
}
