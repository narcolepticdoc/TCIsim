/**
 * app.js — Application Entry Point
 * 
 * Creates the simulation model, initializes UI modules, manages
 * screen navigation. This replaces the inline <script> in index.html.
 * 
 * Phase 2, Step 1: Setup screen wired to model.
 * Subsequent steps will add timer, keypad, drug panel, chart.
 */

import { createModel } from './sim/simulation.js';
import * as setup from './ui/setup.js';
import * as timer from './ui/timer.js';
import * as controls from './ui/controls.js';

const $ = id => document.getElementById(id);

// ---- Application State ----
let model = null;
let confirmedPatient = null;
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
  annotations = [];

  // Reset sim screen state
  $('history-list').innerHTML = '';
  $('history-empty').style.display = 'block';

  // Drug panel defaults (will be driven by model in Step 4)
  $('propofol-ce').textContent = '0.00';
  $('propofol-target-disp').textContent = '';
  $('propofol-status').textContent = 'Stopped';
  $('propofol-status').className = 'drug-status stopped';
  $('propofol-rate').textContent = '';

  // Mode UI defaults (will be driven by mode.js in Step 3)
  $('mode-label').textContent = 'NO MODE';
  $('mode-label').className = 'mode-label no-mode';
  $('btn-target').textContent = 'Set Target';
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

// ---- New Case ----

function handleNewCase() {
  // Reset model
  if (model) model.reset();
  confirmedPatient = null;
  annotations = [];

  // Reset UI modules
  controls.reset();
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
