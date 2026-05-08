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
import * as reconcileModal from './ui/reconcile-modal.js';
import { createChart } from './ui/chart.js';
import { bolusDeliveryMinutes, APP_VERSION, DRUG_IDS, DRUG_DEFS, isPumpEnabled } from './util/constants.js';
import { hexToRgba } from './util/color.js';
import { getQuantizeConfig } from './util/units.js';
import * as persist from './ui/persist.js';
import * as settings from './ui/settings.js';
import { initSettingsUI } from './app/settings-ui.js';
import { createTciModal } from './app/tci-modal.js';
import { createSession } from './app/session.js';
import { initPortraitLayout, syncPortraitLayout } from './app/portrait-layout.js';
import { createChartBridge } from './app/chart-bridge.js';
import { initCompartmentViz } from './ui/compartment-viz.js';
import './app/sw-register.js';

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
let compartmentViz = null;

// ---- Screen Navigation ----

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  // When the sim screen becomes visible, re-measure the drug panel for the
  // portrait-layout dynamic row sizing — scrollHeight lies while display:none.
  if (id === 'sim-screen') {
    requestAnimationFrame(() => requestAnimationFrame(syncPortraitLayout));
  }
  // Notify sw-register so it can gate version checks/reloads to the setup
  // screen — we never want the SW to swap out from under a running case.
  document.dispatchEvent(new CustomEvent('tcisim:screenchange', { detail: { id } }));
}

// ---- Analysis (retrospective) screen ----
// Teleports the .chart-area DOM node between sim-screen and analysis-screen
// so the chart instance (and its inspect cursor) is shared across both.
let chartAreaHomeParent = null;

function teleportChart(targetHost) {
  const chartArea = document.querySelector('.chart-area');
  if (!chartArea || !targetHost) return;
  if (!chartAreaHomeParent) chartAreaHomeParent = chartArea.parentElement;
  targetHost.appendChild(chartArea);
  if (chart && chart.chart) {
    requestAnimationFrame(() => { try { chart.chart.resize(); } catch (_) {} });
  }
}

function syncAnalysisDrugButtons() {
  document.querySelectorAll('.btn-analysis-drug').forEach(b => {
    b.classList.toggle('active', b.dataset.drug === selectedDrug);
  });
}

/**
 * Push DRUG_DEFS[drugId].color into the CSS custom properties that drive
 * every drug-keyed UI surface (drug-card border/highlight, analysis-screen
 * drug button, future drug-tinted panels). Called once at boot so the
 * per-drug color is sourced from a single place — DRUG_DEFS.
 */
function applyDrugColorVars() {
  for (const drugId of DRUG_IDS) {
    const def = DRUG_DEFS[drugId];
    if (!def || !def.color) continue;
    const card = document.getElementById('drug-' + drugId);
    if (card) {
      card.style.setProperty('--drug-color', def.color);
      card.style.setProperty('--drug-color-muted', hexToRgba(def.color, 0.25));
    }
    document.querySelectorAll('.btn-analysis-drug[data-drug="' + drugId + '"]').forEach(btn => {
      btn.style.setProperty('--drug-color', def.color);
      btn.style.setProperty('--drug-color-muted', hexToRgba(def.color, 0.25));
    });
  }
}

function enterAnalysisScreen() {
  if (!model) return;
  teleportChart($('analysis-chart-host'));
  if (compartmentViz) compartmentViz.setActive(true);
  syncAnalysisDrugButtons();
  showScreen('analysis-screen');
}

function exitAnalysisScreen() {
  if (compartmentViz) compartmentViz.setActive(false);
  if (chartAreaHomeParent) teleportChart(chartAreaHomeParent);
  showScreen('sim-screen');
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
  // Ghost-trace toggle is persisted via settings; reflect that on the
  // fresh chart's button so the user's preference survives New Case.
  const btnGhosts = $('btn-chart-ghosts');
  if (btnGhosts) btnGhosts.classList.toggle('active', !!settings.getSettings().ghostTracesEnabled);
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

  // Push DRUG_DEFS[].color into the per-element CSS custom properties so
  // drug-card highlights and analysis buttons read from the single source
  // of truth. Done before any drug surface paints.
  applyDrugColorVars();

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

  // Compartment-flow visualization (self-contained; ripout-able).
  compartmentViz = initCompartmentViz({
    getModel: () => model,
    getSelectedDrug: () => selectedDrug,
    getInspectTime: () => (chart && 'inspectTime' in chart) ? chart.inspectTime : null,
  });

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
      // Probe current rate and any events queued in the future. During a
      // case replay (current time set into the past) the user may sit on a
      // momentary rate=0 gap with rate-resume / bolus events scheduled
      // ahead — Stop Pump must still fire there to cancel them.
      let conc = null;
      let hasFuture = false;
      try {
        conc = model.getConcentrationsAt(selectedDrug, t);
        hasFuture = model.getEvents(selectedDrug).some(e => e.time > t + 0.0001);
      } catch (e) {}
      const m = mode.get(selectedDrug);
      // No-op only when pump is genuinely idle: rate=0, not TCI, and nothing queued ahead.
      if (conc && conc.rate === 0 && m !== 'tci' && !hasFuture) return;

      model.addPause(selectedDrug, t, 'Pump stopped');
      addAnnotation('Pump stopped');
      // Stop drops out of current mode and clears all future events,
      // regardless of mode — the user is asking to halt forward delivery.
      model.clearAfter(selectedDrug, t);
      if (m !== 'none') {
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
    onConfirm(type, canonicalValue, displayText, deliveryMode, extras) {
      let t;
      if (controls.isCaseStarted()) {
        t = timer.getElapsedMinutes();
      } else {
        // Pre-start plan mode: each drug has its own clock so multi-drug events can overlap
        t = getPreStartClock(selectedDrug);
      }

      if (type === 'ceTarget') {
        const tciMode = setup.getTciMode ? setup.getTciMode() : 'stepped';
        const override = extras?.roundOverride;
        const quantConfig = getQuantizeConfig(selectedDrug,
          typeof override === 'boolean' ? override : undefined);
        if (controls.isCaseStarted()) {
          // During running case: show delay modal so user can pre-set the pump.
          // planTCI is deferred to when the user confirms the delay.
          tciModal.setPending({ drugId: selectedDrug, ceTarget: canonicalValue, tciMode, ceTolerance: settings.getSettings().ceTolerance, quantConfig });
          tciModal.showDelay(canonicalValue, selectedDrug);
          return; // skip refreshChart — nothing committed yet
        } else {
          // Pre-case re-target: a new "Set Target" defines the plan from
          // scratch. Wipe any prior events for this drug and rewind the
          // per-drug pre-start clock to 0 so the fresh plan starts at the
          // case origin — otherwise the prior plan's loading bolus at t=0
          // survives clearAfter(advancedClock) and stacks with the new one.
          preStartClock[selectedDrug] = 0;
          model.clearFrom(selectedDrug, 0);
          t = 0;
          mode.setCeTarget(selectedDrug, canonicalValue);
          model.planTCI(selectedDrug, t, canonicalValue, { tciMode, ceTolerance: settings.getSettings().ceTolerance, ...quantConfig });
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
    // tciFraction (time-to-target band for drug panel) is now a hardcoded
    // clinical default — the user-facing slider controls ceTolerance instead.
    getTciFraction: () => 0.95,
    getSsSlopeTol:  () => settings.getSettings().ssSlopeTol,
    getSsExitBand:  () => settings.getSettings().exitBandPct,
    onFrame: (t) => { chartBridge.onFrame(t); compartmentViz.onFrame(t); },
  });

  history.init({
    model,
    getElapsedMinutes: () => timer.getElapsedMinutes(),
    getPatient: () => model ? model.getPatient() : { weight: 70 },
    getWallClockStart: () => timer.getWallClockStart(),
    onEventTap: (evtId) => eventEditor.openEdit(evtId),
  });

  const btnHistoryTime = $('btn-history-time');
  if (btnHistoryTime) {
    const etEl = btnHistoryTime.querySelector('.t-et');
    const rtEl = btnHistoryTime.querySelector('.t-rt');
    btnHistoryTime.addEventListener('click', () => {
      const fmt = history.toggleTimeFormat();
      if (etEl) etEl.classList.toggle('active', fmt === 'et');
      if (rtEl) rtEl.classList.toggle('active', fmt === 'rt');
    });
  }
  const btnHistoryEdit = $('btn-history-edit');
  if (btnHistoryEdit) {
    btnHistoryEdit.addEventListener('click', () => {
      const on = history.toggleEditMode();
      btnHistoryEdit.classList.toggle('active', on);
    });
  }

  const btnReconcile = $('btn-reconcile');
  if (btnReconcile) {
    btnReconcile.addEventListener('click', () => reconcileModal.open(selectedDrug));
  }

  initPortraitLayout();

  eventEditor.init({
    model,
    mode,
    timer,
    controls,
    refreshChart,
    getPatient: () => model ? model.getPatient() : { weight: 70 },
  });

  reconcileModal.init({
    model,
    timer,
    refreshChart,
    addAnnotation,
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

  // Wire retrospective Analysis screen (teleports the chart canvas
  // into a side-by-side layout with the compartment visualization).
  $('btn-analyze')?.addEventListener('click', () => enterAnalysisScreen());
  $('btn-analysis-back')?.addEventListener('click', () => exitAnalysisScreen());

  // Drug-switcher buttons in the analysis topbar — programmatically click
  // the matching drug card so all the existing switch logic runs.
  document.querySelectorAll('.btn-analysis-drug').forEach(btn => {
    btn.addEventListener('click', () => {
      const drugId = btn.dataset.drug;
      if (!drugId) return;
      document.getElementById('drug-' + drugId)?.click();
      syncAnalysisDrugButtons();
    });
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
  const btnChartGhosts = $('btn-chart-ghosts');
  if (btnChartGhosts) btnChartGhosts.addEventListener('click', () => {
    if (!chart) return;
    const enabled = chart.toggleGhostTraces();
    btnChartGhosts.classList.toggle('active', enabled);
    // Persist via the settings store so the toggle survives reload.
    const cur = settings.getSettings();
    settings.setSettings({ ...cur, ghostTracesEnabled: enabled });
    // Push fresh ghost curves immediately so toggling on doesn't wait
    // for the next refresh trigger (e.g. an event edit or rAF tick).
    chartBridge.refresh();
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
