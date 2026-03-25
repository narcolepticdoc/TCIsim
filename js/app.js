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
import { createChart } from './ui/chart.js';
import { ceForBIS } from './pk/pd.js';

const $ = id => document.getElementById(id);

// ---- Application State ----
let model = null;
let confirmedPatient = null;
let selectedDrug = 'propofol';
let chart = null;
let annotations = []; // mode transitions, editorial actions

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

  // Reset modules
  controls.reset();
  mode.reset();
  annotations = [];

  // Reset sim screen state
  $('history-list').innerHTML = '';
  $('history-empty').style.display = 'block';

  // Reset chart placeholder
  const placeholder = $('chart-placeholder');
  const canvas = $('chart-canvas');
  if (placeholder) placeholder.style.display = '';
  if (canvas) canvas.style.display = 'none';

  // Destroy old chart if exists
  if (chart) { chart.destroy(); chart = null; }

  // Create new chart
  if (canvas) {
    chart = createChart(canvas, { drugId: selectedDrug, showCp: true, showCe: true });
    computeEffectOverlay();
  }
}

// ---- Annotations ----

function addAnnotation(text) {
  if (!text) return;
  const t = Math.floor(timer.getElapsedMs() / 1000);
  const m = Math.floor(t / 60);
  const s = t % 60;
  const ts = String(m).padStart(3, '0') + ':' + String(s).padStart(2, '0');
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
  // Compute curve from 0 to current time + 30 min lookahead (or at least 30 min)
  const endTime = Math.max(30, t + 30);
  const curve = model.computeCurve(selectedDrug, 0, endTime, 10 / 60);
  chart.setCurveData(curve);

  // Update target line
  const m = mode.get(selectedDrug);
  const ce = mode.getCeTarget(selectedDrug);
  chart.setTargetLine(m === 'tci' && ce > 0 ? ce : null);
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

// ---- Boot ----

function boot() {
  // Create the model
  model = createModel({ primaryDrug: 'propofol' });

  // Initialize setup screen
  setup.init({
    onConfirm(patient) {
      confirmedPatient = patient;
      model.setPatient(patient);
      initSimScreen(patient);
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
      addAnnotation('Case started');
    },
    onPumpPause() {
      // Pause pump = set rate to zero at current time
      const t = timer.getElapsedMinutes();
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
    onConfirm(type, canonicalValue, displayText) {
      controls.ensureStarted();
      const t = timer.getElapsedMinutes();

      if (type === 'ceTarget') {
        // TCI target
        mode.setCeTarget(selectedDrug, canonicalValue);
        model.planTCI(selectedDrug, t, canonicalValue);
        mode.set(selectedDrug, 'tci', `TCI target Ce=${canonicalValue.toFixed(1)} μg/mL`);
      } else if (type === 'rate') {
        // Manual rate — drops out of TCI
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
        }
        model.addRate(selectedDrug, t, canonicalValue, `Rate ${displayText}`);
        mode.set(selectedDrug, 'manual', `Manual rate: ${displayText}`);
      } else if (type === 'bolus') {
        // Bolus — if in TCI, clear forward plan first, then bolus
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
          mode.set(selectedDrug, 'manual', 'Dropped out of TCI — manual bolus');
        } else if (mode.get(selectedDrug) === 'none') {
          mode.set(selectedDrug, 'manual');
        }
        model.addBolus(selectedDrug, t, canonicalValue, `Bolus ${displayText}`);
        addAnnotation(`Bolus: ${displayText}`);
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
    },
  });

  // Wire new case dialog
  const btnNewCase = $('btn-new-case');
  if (btnNewCase) btnNewCase.addEventListener('click', () => {
    $('modal-new-case').classList.add('open');
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
