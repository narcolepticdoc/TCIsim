/**
 * TCI Simulator — UI Controller
 * Wires DOM events to app state, renders history and concentrations
 */

import * as App from './app.js';
import { TCIChart } from './chart.js';

// ─── Elements ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

let chart = null;
let chartAnimFrame = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  setupSetupScreen();
  setupMainScreen();
  
  // Bind app events
  App.on('patientChanged', onPatientChanged);
  App.on('stateChanged', onStateChanged);
  App.on('traceUpdated', onTraceUpdated);
  App.on('tick', onTick);
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────

function setupSetupScreen() {
  const btnMale = $('btn-male');
  const btnFemale = $('btn-female');
  let selectedSex = 'male';

  btnMale.addEventListener('click', () => {
    selectedSex = 'male';
    btnMale.classList.add('active');
    btnFemale.classList.remove('active');
  });

  btnFemale.addEventListener('click', () => {
    selectedSex = 'female';
    btnFemale.classList.add('active');
    btnMale.classList.remove('active');
  });

  $('btn-begin').addEventListener('click', () => {
    const age = parseFloat($('inp-age').value);
    const weight = parseFloat($('inp-weight').value);
    const height = parseFloat($('inp-height').value);

    if (!age || !weight || !height || age < 1 || age > 120 || weight < 20 || height < 100) {
      alert('Please enter valid patient parameters.');
      return;
    }

    App.setupPatient({ age, weightKg: weight, heightCm: height, sex: selectedSex });
    showScreen('main');
  });
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

function setupMainScreen() {
  // Chart
  const canvas = $('main-canvas');
  chart = new TCIChart(canvas);

  // Start / stop
  $('btn-start-case').addEventListener('click', () => {
    const offsetStr = $('inp-offset').value.trim();
    let offsetMin = 0;
    if (offsetStr) {
      // Parse "HH:MM" or plain minutes
      if (offsetStr.includes(':')) {
        const [h, m] = offsetStr.split(':').map(Number);
        offsetMin = (h || 0) * 60 + (m || 0);
      } else {
        offsetMin = parseFloat(offsetStr) || 0;
      }
    }
    App.startCase(offsetMin);
    $('btn-start-case').style.display = 'none';
    $('btn-stop-case').style.display = 'block';
    $('offset-row').style.display = 'none';
  });

  $('btn-stop-case').addEventListener('click', () => {
    App.stopCase();
    $('btn-start-case').style.display = 'block';
    $('btn-stop-case').style.display = 'none';
    $('offset-row').style.display = 'flex';
  });

  // Rate
  $('btn-set-rate').addEventListener('click', () => {
    const rate = parseFloat($('inp-rate').value);
    if (isNaN(rate) || rate < 0) return;
    App.addRateEvent(rate);
    updateCurrentRateDisplay(rate);
  });

  // Bolus
  $('btn-set-bolus').addEventListener('click', () => {
    const val = $('inp-bolus').value.trim();
    if (!val) return;
    let bolusMg = parseFloat(val);
    if (isNaN(bolusMg) || bolusMg <= 0) return;
    
    const unit = $('bolus-unit').value;
    if (unit === 'ml') bolusMg *= 10; // 10 mg/ml
    
    App.addBolusEvent(bolusMg);
    $('inp-bolus').value = '';
  });

  // TCI target
  $('btn-set-tci').addEventListener('click', () => {
    const target = parseFloat($('inp-tci').value);
    if (isNaN(target) || target <= 0) return;
    App.setTCITarget(target);
  });

  $('btn-cancel-tci').addEventListener('click', () => {
    App.cancelTCI();
  });

  // Back to setup
  $('btn-back').addEventListener('click', () => {
    App.stopCase();
    showScreen('setup');
  });

  // Modal
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) closeModal();
  });
  $('btn-cancel-modal').addEventListener('click', closeModal);
  $('btn-save-modal').addEventListener('click', saveModal);

  // Start render loop
  startRenderLoop();
}

// ─── Render Loop ──────────────────────────────────────────────────────────────

function startRenderLoop() {
  function loop() {
    if (chart) {
      chart.setCurrentTime(App.state.currentTimeMin);
      chart.render();
    }
    chartAnimFrame = requestAnimationFrame(loop);
  }
  loop();
}

// ─── App Event Handlers ───────────────────────────────────────────────────────

function onPatientChanged(patient) {
  const summary = App.state.model.getSummary();
  
  // Update patient badge
  const sex = patient.sex === 'male' ? 'M' : 'F';
  $('patient-badge').innerHTML =
    `<strong>${patient.age}y ${sex} · ${patient.weightKg}kg · ${patient.heightCm}cm</strong>` +
    ` — Eleveld 2.1 · 10 mg/ml`;

  // PK params
  renderPKParams(summary);
}

function onStateChanged() {
  // Rebuild trace if needed
  if (App.state.traceNeedsRebuild) {
    App.rebuildTrace();
  }
  
  renderHistory();
  updateTCIStatus();
}

function onTraceUpdated(trace) {
  if (chart) chart.setTrace(trace);
}

function onTick(timeMin) {
  // Update timer
  $('case-timer').textContent = App.formatTime(timeMin);
  
  // Update concentration displays
  const { Cp, Ce } = App.getCurrentConcentrations();
  $('disp-cp').textContent = Cp.toFixed(2);
  $('disp-ce').textContent = Ce.toFixed(2);
}

// ─── History ──────────────────────────────────────────────────────────────────

function renderHistory() {
  const list = $('history-list');
  const events = App.state.events.filter(e => e.source !== 'tci'); // hide TCI schedule from history
  const allWithTCI = App.state.events;
  
  // Show manual events + TCI meta events (tci_target, tci_cancel)
  const displayed = allWithTCI.filter(e =>
    e.source === 'manual' || e.type === 'tci_target' || e.type === 'tci_cancel'
  );
  
  list.innerHTML = '';

  // Show most recent first
  const sorted = [...displayed].sort((a, b) => b.timeMin - a.timeMin);

  sorted.forEach(ev => {
    const div = document.createElement('div');
    div.className = 'history-item';
    
    const dotClass = ev.type;
    div.innerHTML = `
      <div class="ev-type-dot ${dotClass}"></div>
      <span class="time">${App.formatTime(ev.timeMin)}</span>
      <span class="event-label">${ev.label}</span>
      <div class="ev-actions">
        ${ev.type !== 'tci_cancel' && ev.type !== 'tci_target' ? `<button class="ev-btn edit" data-id="${ev.id}">EDIT</button>` : ''}
        <button class="ev-btn del" data-id="${ev.id}">DEL</button>
      </div>
    `;
    
    list.appendChild(div);
  });

  // Bind actions
  list.querySelectorAll('.ev-btn.del').forEach(btn => {
    btn.addEventListener('click', () => App.deleteEvent(btn.dataset.id));
  });
  
  list.querySelectorAll('.ev-btn.edit').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });
}

// ─── TCI Status ───────────────────────────────────────────────────────────────

function updateTCIStatus() {
  const statusEl = $('tci-status');
  if (App.state.tciActive) {
    statusEl.classList.remove('hidden');
    $('tci-target-display').textContent = `Ce target ${App.state.tciTarget.toFixed(1)} mcg/ml`;
  } else {
    statusEl.classList.add('hidden');
  }
}

function updateCurrentRateDisplay(rate) {
  $('current-rate-val').textContent = rate.toFixed(0);
}

// ─── PK Params ────────────────────────────────────────────────────────────────

function renderPKParams(summary) {
  const grid = $('pk-grid');
  const keys = [
    ['V1', 'V2', 'V3'],
    ['CL', 'Q2', 'Q3'],
    ['ke0'],
  ];
  grid.innerHTML = '';
  Object.entries(summary)
    .filter(([k]) => !['model', 'drug', 'concentration'].includes(k))
    .forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'pk-row';
      row.innerHTML = `<span class="pk-label">${k}</span><span class="pk-value">${v}</span>`;
      grid.appendChild(row);
    });
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

let _editingId = null;

function openEditModal(id) {
  const ev = App.state.events.find(e => e.id === id);
  if (!ev) return;
  _editingId = id;
  
  $('modal-title').textContent = `Edit: ${ev.type === 'rate' ? 'Infusion Rate' : 'Bolus'}`;
  
  // Time field (HH:MM:SS)
  $('modal-time').value = App.formatTime(ev.timeMin);
  
  // Value field
  const isRate = ev.type === 'rate';
  $('modal-value-label').textContent = isRate ? 'Rate (mcg/kg/min)' : 'Dose (mg)';
  $('modal-value').value = ev.value !== null ? ev.value.toFixed(isRate ? 0 : 1) : '';
  
  $('modal-overlay').classList.add('open');
  $('modal-time').focus();
}

function closeModal() {
  $('modal-overlay').classList.remove('open');
  _editingId = null;
}

function saveModal() {
  if (!_editingId) return;
  const ev = App.state.events.find(e => e.id === _editingId);
  if (!ev) return;
  
  // Parse time
  const timeStr = $('modal-time').value.trim();
  let newTime = ev.timeMin;
  if (timeStr.includes(':')) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) newTime = parts[0] * 60 + parts[1] + parts[2] / 60;
    else if (parts.length === 2) newTime = parts[0] + parts[1] / 60;
  } else {
    newTime = parseFloat(timeStr) * 60 || ev.timeMin;
  }
  
  const newValue = parseFloat($('modal-value').value);
  
  const updates = { timeMin: newTime };
  if (!isNaN(newValue)) {
    updates.value = newValue;
    updates.label = ev.type === 'rate'
      ? `Rate → ${newValue.toFixed(0)} mcg/kg/min`
      : `Bolus ${newValue.toFixed(1)} mg propofol`;
  }
  
  App.editEvent(_editingId, updates);
  closeModal();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}
