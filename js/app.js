/**
 * app.js — Application Entry Point
 * 
 * Creates the simulation model, initializes UI modules, manages
 * screen navigation. This replaces the inline <script> in index.html.
 * 
 * Phase 2, Steps 1-3: Setup, timer, controls, keypad, mode wired.
 */

import { createModel } from './sim/simulation.js';
import * as setup from './ui/setup.js';
import * as timer from './ui/timer.js';
import * as controls from './ui/controls.js';
import * as keypad from './ui/keypad.js';
import * as mode from './ui/mode.js';
import * as drugPanel from './ui/drug-panel.js';
import * as history from './ui/history.js';
import * as eventEditor from './ui/event-editor.js';
import { createChart } from './ui/chart.js';
import { ceForBIS } from './pk/pd.js';
import { bolusDeliveryMinutes, setPumpSettings } from './util/constants.js';
import * as persist from './ui/persist.js';

const $ = id => document.getElementById(id);

// ---- Application State ----
let model = null;
let confirmedPatient = null;
let selectedDrug = 'propofol';
let chart = null;
let preStartClock = 0; // running time for pre-start events (minutes)
let annotations = []; // mode transitions, editorial actions
let lastHistoryDimUpdate = 0; // throttle timestamp for history dimming

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

  // Update drug model label
  const modelLabel = $('propofol-model-label');
  if (modelLabel) {
    const conc = $('input-concentration')?.value || '10';
    const opioid = p.opioid ? ' · +opioid' : '';
    const tciMode = setup.getTciMode ? setup.getTciMode() : 'stepped';
    const modeLabel = tciMode === 'cet' ? ' · CET' :
                      tciMode === 'cet-conservative' ? ' · CET(C)' : '';
    modelLabel.textContent = `Eleveld 2018 · ${conc} mg/mL${opioid}${modeLabel}`;
  }

  // Reset modules
  controls.reset();
  mode.reset();
  preStartClock = 0;
  annotations = [];

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

  // Destroy old chart if exists
  if (chart) { chart.destroy(); chart = null; }

  // Create new chart
  if (canvas) {
    try {
      chart = createChart(canvas, { drugId: selectedDrug, showCp: true, showCe: true });
      // Give chart access to PD model for BIS in tooltips
      const pd = model.getPDModel(selectedDrug);
      if (pd) chart.setPDModel(pd);
      computeEffectOverlay();
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
      `<span class="h-desc">${text}</span>` +
      `<span class="h-time">${ts}</span>`;
    list.appendChild(row);
  }
}

// ---- Chart ----

/**
 * Recompute the curve and refresh the chart.
 * Called after every model mutation.
 */
function refreshChart() {
  if (!chart || !model) return;
  const t = timer.getElapsedMinutes();

  // Compute end time: furthest event + 120 min decay buffer, minimum 120 min
  const events = model.getEvents(selectedDrug);
  const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
  const endTime = Math.max(120, t + 120, lastEventTime + 120);

  const curve = model.computeCurve(selectedDrug, 0, endTime, 10 / 60);
  chart.setCurveData(curve);

  // Show chart controls
  const cc = $('chart-controls');
  if (cc) cc.style.display = 'flex';

  // Update target line
  const m = mode.get(selectedDrug);
  const ce = mode.getCeTarget(selectedDrug);
  chart.setTargetLine(m === 'tci' && ce > 0 ? ce : null);

  // Update history panel
  history.render(selectedDrug);

  // Auto-save state
  saveState();
}

// ---- Persistence ----

function saveState() {
  if (!model || !confirmedPatient) return;

  // Collect events for all drugs (strip snapshot — Float64Array won't serialize)
  const eventsByDrug = {};
  for (const drugId of ['propofol']) { // extend for multi-drug
    eventsByDrug[drugId] = model.getEvents(drugId).map(evt => ({
      drug: evt.drug,
      time: evt.time,
      type: evt.type,
      value: evt.value,
      source: evt.source,
      deliveryMode: evt.deliveryMode,
      annotation: evt.annotation,
    }));
  }

  // Collect mode state
  const modes = {};
  const ceTargets = {};
  for (const drugId of ['propofol']) {
    modes[drugId] = mode.get(drugId);
    ceTargets[drugId] = mode.getCeTarget(drugId);
  }

  persist.saveCase({
    patient: confirmedPatient,
    events: eventsByDrug,
    wallClockStart: timer.getWallClock() ? new Date(timer.getWallClock().getTime() - timer.getElapsedMs()).toISOString() : null,
    modes,
    ceTargets,
    annotations,
    primaryDrug: selectedDrug,
  });
}

/**
 * Compute BIS overlay bands from the PD model.
 * Bands are drawn at Ce levels corresponding to BIS thresholds.
 */
function computeEffectOverlay() {
  if (!chart || !model) return;
  const pd = model.getPDModel(selectedDrug);
  if (!pd) { chart.setEffectOverlay([]); return; }

  const params = pd.params;
  // Use ceForBIS to find Ce values at BIS boundaries
  const ce85 = ceForBIS(85, params);  // awake/sedation boundary
  const ce60 = ceForBIS(60, params);  // sedation/GA boundary
  const ce40 = ceForBIS(40, params);  // GA/deep boundary

  chart.setEffectOverlay([
    { ceMin: 0, ceMax: ce40, color: '#ef444418', label: 'Deep' },
    { ceMin: ce40, ceMax: ce60, color: '#22c55e18', label: 'GA 40-60' },
    { ceMin: ce60, ceMax: ce85, color: '#f59e0b12', label: 'Sedation' },
  ]);
}

// ---- New Case ----

function handleNewCase() {
  // Reset model
  if (model) model.reset();
  confirmedPatient = null;
  annotations = [];

  // Destroy chart
  if (chart) { chart.destroy(); chart = null; }

  // Reset UI modules
  controls.reset();
  mode.reset();
  setup.reset();
  showScreen('setup-screen');
}

// ---- Restore Case ----

function restoreCase() {
  const saved = persist.loadCase();
  if (!saved || !saved.patient) return;

  try {
    // Apply saved pump settings before resetting model
    try {
      const savedConc = localStorage.getItem('tci-pump-concentration');
      const savedRate = localStorage.getItem('tci-pump-rate');
      if (savedConc || savedRate) {
        setPumpSettings('propofol', {
          concentration: parseFloat(savedConc) || 10,
          bolusRateMlH: parseFloat(savedRate) || 750,
        });
      }
    } catch (e) {}

    // Reset model and set patient
    model.reset();
    model.setPatient(saved.patient);
    confirmedPatient = saved.patient;

    // Replay saved events (skip system-generated rate-restore events)
    if (saved.events) {
      for (const [drugId, drugEvents] of Object.entries(saved.events)) {
        for (const evt of drugEvents) {
          // Skip system events (rate restores after bolus) — addBolus generates these
          if (evt.source === 'system') continue;
          if (evt.type === 'rate') {
            model.addRate(drugId, evt.time, evt.value, evt.annotation || '');
          } else if (evt.type === 'bolus') {
            model.addBolus(drugId, evt.time, evt.value, evt.annotation || '', {
              deliveryMode: evt.deliveryMode || 'pump', // default for old saved cases
              source: evt.source || 'manual',
            });
          } else if (evt.type === 'pause') {
            model.addPause(drugId, evt.time, evt.annotation || '');
          }
        }
      }
    }

    // Initialize sim screen
    initSimScreen(saved.patient);
    showScreen('sim-screen');

    // Restore wall clock / timer
    if (saved.wallClockStart) {
      const startDate = new Date(saved.wallClockStart);
      timer.setWallClockStart(startDate);
    }

    // Restore modes
    if (saved.modes) {
      for (const [drugId, m] of Object.entries(saved.modes)) {
        mode.set(drugId, m);
      }
    }
    if (saved.ceTargets) {
      for (const [drugId, ce] of Object.entries(saved.ceTargets)) {
        if (ce > 0) mode.setCeTarget(drugId, ce);
      }
    }

    // Restore annotations
    if (saved.annotations) {
      annotations = saved.annotations;
      const list = $('history-list');
      const empty = $('history-empty');
      if (list && empty) {
        empty.style.display = 'none';
        list.innerHTML = '';
        annotations.forEach((a, i) => {
          const row = document.createElement('div');
          row.className = 'history-row';
          row.innerHTML = `<span class="h-step">${i}</span>` +
            `<span class="h-desc">${a.text}</span>` +
            `<span class="h-time">${a.time}</span>`;
          list.appendChild(row);
        });
      }
    }

    // Start the case (timer)
    controls.ensureStarted();

    // Refresh chart
    refreshChart();

    addAnnotation('Case restored');
  } catch (err) {
    console.error('[TCI Sim] Restore failed:', err);
    addAnnotation('⚠ Restore failed: ' + err.message);
  }
}

// ---- Boot ----

function boot() {
  // Create the model
  model = createModel({ primaryDrug: 'propofol' });

  // Show restore button if saved case exists
  const btnRestore = $('btn-restore');
  if (btnRestore) {
    if (persist.hasSavedCase()) {
      const summary = persist.getSavedCaseSummary();
      btnRestore.innerHTML = `Restore Last Case${summary ? `<span class="restore-summary">${summary}</span>` : ''}`;
      btnRestore.style.display = '';
      btnRestore.addEventListener('click', restoreCase);
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
      preStartClock = 0;
      addAnnotation('Case started');
    },
    onPumpPause() {
      const t = timer.getElapsedMinutes();
      // Guard: don't pause if already paused (rate already 0)
      try {
        const conc = model.getConcentrationsAt(selectedDrug, t);
        if (conc.rate === 0) return; // already paused
      } catch (e) {}

      model.addPause(model.primaryDrug, t, 'Pump paused');
      addAnnotation('Pump paused');
      // Pause drops out of TCI
      if (mode.get(selectedDrug) === 'tci') {
        model.clearAfter(selectedDrug, t);
        mode.set(selectedDrug, 'manual', 'Pump paused');
      }
      refreshChart();
    },
  });

  // Initialize mode tracking
  mode.init({
    onModeChange(drugId, newMode, oldMode, detail) {
      if (detail) addAnnotation(detail);
    },
  });

  // Initialize keypad
  keypad.init({
    getPatient: () => model ? model.getPatient() : null,
    getMode: () => mode.get(selectedDrug),
    getCeTarget: () => mode.getCeTarget(selectedDrug),
    onConfirm(type, canonicalValue, displayText, deliveryMode) {
      let t;
      if (controls.isCaseStarted()) {
        t = timer.getElapsedMinutes();
      } else {
        // Pre-start plan mode: advance clock by execution duration of each action
        t = preStartClock;
      }

      if (type === 'ceTarget') {
        // TCI target — pass selected planning mode
        mode.setCeTarget(selectedDrug, canonicalValue);
        const tciMode = setup.getTciMode ? setup.getTciMode() : 'stepped';
        model.planTCI(selectedDrug, t, canonicalValue, { tciMode });
        mode.set(selectedDrug, 'tci', `TCI target Ce=${canonicalValue.toFixed(1)} μg/mL`);
        // TCI plan starts immediately, advance by a small offset
        if (!controls.isCaseStarted()) preStartClock = t + 0.01;
      } else if (type === 'rate') {
        // Manual rate — drops out of TCI
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
        }
        model.addRate(selectedDrug, t, canonicalValue, `Rate ${displayText}`);
        mode.set(selectedDrug, 'manual', `Manual rate: ${displayText}`);
        // Rate change is near-instantaneous
        if (!controls.isCaseStarted()) preStartClock = t + 0.01;
      } else if (type === 'bolus') {
        // Bolus — if in TCI, clear forward plan first, then bolus
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
          mode.set(selectedDrug, 'manual', 'Dropped out of TCI — manual bolus');
        } else if (mode.get(selectedDrug) === 'none') {
          mode.set(selectedDrug, 'manual');
        }
        const dm = deliveryMode || 'pump';
        const label = dm === 'push' ? 'IV Push' : 'Pump Bolus';
        model.addBolus(selectedDrug, t, canonicalValue, `${label} ${displayText}`, {
          deliveryMode: dm,
        });
        // Advance clock by bolus delivery duration
        if (!controls.isCaseStarted()) {
          const deliveryMin = dm === 'push'
            ? 10 / 60  // 10 seconds
            : bolusDeliveryMinutes(canonicalValue, selectedDrug);
          preStartClock = t + deliveryMin;
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
      document.querySelectorAll('.drug-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // Initialize drug panel (live readout)
  drugPanel.init({
    model,
    timer,
    getMode: () => mode.get(selectedDrug),
    getCeTarget: () => mode.getCeTarget(selectedDrug),
    getDrugId: () => selectedDrug,
    onFrame(t) {
      // Update chart cursor — throttled to every 500ms
      if (chart && t > 0) {
        const now = Date.now();
        if (!chart._lastCursorUpdate || now - chart._lastCursorUpdate > 500) {
          chart._lastCursorUpdate = now;
          chart.setCursorTime(t);
        }
      }
      // Update history past/future dimming — throttled to every 2s
      {
        const now = Date.now();
        if (!lastHistoryDimUpdate || now - lastHistoryDimUpdate > 2000) {
          lastHistoryDimUpdate = now;
          history.updateDimming();
        }
      }
    },
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
  const btnChartTooltip = $('btn-chart-tooltip');
  if (btnChartTooltip) btnChartTooltip.addEventListener('click', () => {
    if (chart) {
      const enabled = chart.toggleTooltip();
      btnChartTooltip.classList.toggle('active', enabled);
    }
  });
  const btnNewCaseConfirm = $('btn-new-case-confirm');
  if (btnNewCaseConfirm) btnNewCaseConfirm.addEventListener('click', () => {
    closeModal('modal-new-case');
    handleNewCase();
  });
  const btnNewCaseCancel = $('btn-new-case-cancel');
  if (btnNewCaseCancel) btnNewCaseCancel.addEventListener('click', () => {
    closeModal('modal-new-case');
  });

  // Wire modal close (click overlay or Escape)
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target === o) o.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });

  // Wire view tabs (chart/history) — basic toggle for now
  const viewChart = $('view-chart');
  const viewHistory = $('view-history');
  if (viewChart) viewChart.addEventListener('click', () => setView('chart'));
  if (viewHistory) viewHistory.addEventListener('click', () => setView('history'));

  // Orientation lock attempt
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  } catch (e) {}
}

function closeModal(id) {
  $(id).classList.remove('open');
}

function setView(v) {
  // Tab buttons
  $('view-chart').classList.toggle('active', v === 'chart');
  $('view-history').classList.toggle('active', v === 'history');
  // Content panels
  $('panel-chart').classList.toggle('active', v === 'chart');
  $('panel-history').classList.toggle('active', v === 'history');
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
