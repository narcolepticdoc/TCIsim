/**
 * app.js — Application Entry Point
 * 
 * Creates the simulation model, initializes UI modules, manages
 * screen navigation. This replaces the inline <script> in index.html.
 * 
 * Phase 2, Steps 1-3: Setup, timer, controls, keypad, mode wired.
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
import { ceForBIS } from './pk/pd.js';
import { bolusDeliveryMinutes, setPumpSettings, getPumpSettings, APP_VERSION } from './util/constants.js';
import { fromCanonical, getAllowedUnits, getDefaultUnit, formatValue } from './util/units.js';
import { playAlert } from './ui/alert-sound.js';
import * as persist from './ui/persist.js';
import * as warnings from './ui/warnings.js';

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
let lastHistoryDimUpdate = 0; // throttle timestamp for history dimming

// TCI delay popup state
let pendingTCI = null;       // { drugId, ceTarget, tciMode } — held while delay modal is open
let tciDelaySeconds = 10;    // last-selected delay, persists within session
let tciCountdownInterval = null;

// ---- Per-Drug Chart Configuration ----
// yScale: multiply canonical mcg/mL curve values before passing to chart
// yLabel: y-axis title
// yDefault: suggestedMax when no saved value exists
const CHART_DRUG_CONFIG = {
  propofol:     { yScale: 1,    yLabel: 'μg/mL', yDefault: 10 },
  remifentanil: { yScale: 1,    yLabel: 'μg/mL', yDefault: 10 },
  fentanyl:     { yScale: 1000, yLabel: 'ng/mL',  yDefault: 10 },
  ketamine:     { yScale: 1000, yLabel: 'ng/mL',  yDefault: 10000 },
};
function getChartDrugConfig(drugId) {
  return CHART_DRUG_CONFIG[drugId] || { yScale: 1, yLabel: 'μg/mL', yDefault: 10 };
}

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
      // Give chart patient weight for rate unit conversion in tooltip
      try { const pt = model.getPatient(); if (pt) chart.setPatientWeight(pt.weight); } catch (e) {}
      // Apply per-drug y-axis config (label, scale, default range)
      const initCfg = getChartDrugConfig(selectedDrug);
      chart.switchDrug(selectedDrug, initCfg.yLabel, initCfg.yDefault, initCfg.yScale);
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
      `<span class="h-desc"></span>` +
      `<span class="h-time">${ts}</span>`;
    row.querySelector('.h-desc').textContent = text;
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

  // Compute end time: furthest event + 360 min forward buffer, minimum 360 min.
  // Matches the slope-based steady-state predictor's 6 h search horizon so the
  // chart can display the full predicted plateau region when users pan out.
  const events = model.getEvents(selectedDrug);
  const lastEventTime = events.length > 0 ? events[events.length - 1].time : 0;
  const endTime = Math.max(360, t + 360, lastEventTime + 360);

  const rawCurve = model.computeCurve(selectedDrug, 0, endTime, 10 / 60);
  const { yScale, yLabel, yDefault } = getChartDrugConfig(selectedDrug);
  const chartCurve = yScale === 1 ? rawCurve : rawCurve.map(pt => ({
    ...pt, Ce: pt.Ce * yScale, Cp: pt.Cp * yScale,
  }));
  // Keep the chart's PD model in sync with the currently selected drug
  // so the eBIS tooltip line reflects the right drug (null clears it
  // for fentanyl/ketamine which have no PD model).
  chart.setPDModel(model.getPDModel(selectedDrug));
  chart.setCurveData(chartCurve);
  drugPanel.setCurveData(rawCurve);  // drug-panel uses canonical mcg/mL for threshold comparisons
  computeEffectOverlay();  // clears BIS bands for drugs without a PD model

  // Show chart controls
  const cc = $('chart-controls');
  if (cc) cc.style.display = 'flex';

  // Update target line (scale Ce target to match chart units)
  const m = mode.get(selectedDrug);
  const ce = mode.getCeTarget(selectedDrug);
  chart.setTargetLine(m === 'tci' && ce > 0 ? ce * yScale : null);

  // Intermittent threshold line (amber dashed, analogous to TCI target line)
  const threshold = mode.getIntermittentThreshold(selectedDrug);
  chart.setThresholdLine(m === 'intermittent' && threshold > 0 ? threshold * yScale : null);

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
  for (const drugId of ['propofol', 'fentanyl', 'ketamine']) {
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

  // Collect mode state for all drugs
  const modes = {};
  const ceTargets = {};
  const intermittentThresholds = {};
  for (const drugId of ['propofol', 'fentanyl', 'ketamine']) {
    modes[drugId] = mode.get(drugId);
    ceTargets[drugId] = mode.getCeTarget(drugId);
    intermittentThresholds[drugId] = mode.getIntermittentThreshold(drugId);
  }

  persist.saveCase({
    patient: confirmedPatient,
    events: eventsByDrug,
    wallClockStart: timer.getWallClock() ? new Date(timer.getWallClock().getTime() - timer.getElapsedMs()).toISOString() : null,
    modes,
    ceTargets,
    intermittentThresholds,
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
  // ceForBIS(N) returns the Ce concentration at which BIS = N.
  // More drug → lower BIS → higher Ce, so: ce90 < ce80 < ce60 < ce40 < ce20 numerically.
  const ce90 = ceForBIS(90, params);  // Light Sedation upper boundary
  const ce80 = ceForBIS(80, params);  // Light Sedation / Deep Sedation boundary
  const ce60 = ceForBIS(60, params);  // Deep Sedation / GA boundary
  const ce40 = ceForBIS(40, params);  // GA / Deep Anesthesia boundary
  const ce20 = ceForBIS(20, params);  // Deep Anesthesia lower boundary

  chart.setEffectOverlay([
    { ceMin: ce90, ceMax: ce80, color: '#ef444430', label: 'Light Sedation' },  // Red    BIS 80-90
    { ceMin: ce80, ceMax: ce60, color: '#f9731630', label: 'Deep Sedation' },   // Orange BIS 60-80
    { ceMin: ce60, ceMax: ce40, color: '#eab30830', label: 'GA' },              // Yellow BIS 40-60
    { ceMin: ce40, ceMax: ce20, color: '#22c55e30', label: 'Deep Anesthesia' }, // Green  BIS 20-40
  ]);
}

// ---- New Case ----

function handleNewCase() {
  // Reset model
  if (model) model.reset();
  confirmedPatient = null;
  annotations = [];
  warnings.reset();

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
    if (saved.intermittentThresholds) {
      for (const [drugId, thr] of Object.entries(saved.intermittentThresholds)) {
        if (thr > 0) mode.setIntermittentThreshold(drugId, thr);
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
            `<span class="h-desc"></span>` +
            `<span class="h-time">${a.time}</span>`;
          row.querySelector('.h-desc').textContent = a.text;
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
  // Display app version
  const vt = document.getElementById('app-version-tag');
  if (vt) vt.textContent = 'v' + APP_VERSION;

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
    },
    onPumpPause() {
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
      // Stop drops out of TCI and clears future events
      if (mode.get(selectedDrug) === 'tci') {
        model.clearAfter(selectedDrug, t);
        mode.set(selectedDrug, 'manual', 'Pump stopped');
      }
      refreshChart();
    },
  });

  // Initialize mode tracking
  mode.init({
    onModeChange(drugId, newMode, oldMode, detail) {
      if (detail) addAnnotation(detail);
      // Keep history filter in sync with mode changes for the selected drug
      if (drugId === selectedDrug) {
        history.setBolusOnly(newMode === 'intermittent');
      }
    },
  });

  // Initialize keypad
  keypad.init({
    getPatient: () => model ? model.getPatient() : null,
    getMode: () => mode.get(selectedDrug),
    getCeTarget: () => mode.getCeTarget(selectedDrug),
    isTciDrug: () => !NO_TCI_DRUGS.has(selectedDrug),
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
          pendingTCI = { drugId: selectedDrug, ceTarget: canonicalValue, tciMode };
          showTciDelayModal(canonicalValue, selectedDrug);
          return; // skip refreshChart — nothing committed yet
        } else {
          // Pre-case: plan immediately, no delay needed
          mode.setCeTarget(selectedDrug, canonicalValue);
          model.planTCI(selectedDrug, t, canonicalValue, { tciMode });
          mode.set(selectedDrug, 'tci', `TCI target Ce=${canonicalValue.toFixed(1)} μg/mL`);
          advancePreStartClock(selectedDrug, 0.01);
        }
      } else if (type === 'rate') {
        // Manual rate — drops out of TCI
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
        }
        model.addRate(selectedDrug, t, canonicalValue, `Rate ${displayText}`);
        mode.set(selectedDrug, 'manual', `Manual rate: ${displayText}`);
        // Rate change is near-instantaneous
        if (!controls.isCaseStarted()) advancePreStartClock(selectedDrug, 0.01);
      } else if (type === 'intermittent') {
        // Intermittent bolus mode — store threshold, no model changes
        mode.setIntermittentThreshold(selectedDrug, canonicalValue);
        mode.set(selectedDrug, 'intermittent', `Intermittent mode, redose threshold ${displayText}`);
        refreshChart();
        return; // refreshChart already called
      } else if (type === 'bolus') {
        // Bolus — if in TCI, clear forward plan first, then bolus
        if (mode.get(selectedDrug) === 'tci') {
          model.clearAfter(selectedDrug, t);
          mode.set(selectedDrug, 'manual', 'Dropped out of TCI — manual bolus');
        } else if (mode.get(selectedDrug) === 'none') {
          mode.set(selectedDrug, 'manual');
        }
        // Intermittent mode: stay in intermittent, always use IV Push (no pump)
        const dm = (mode.get(selectedDrug) === 'intermittent') ? 'push' : (deliveryMode || 'pump');
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
      history.setBolusOnly(mode.get(drugId) === 'intermittent');
      history.setDrug(drugId);
      history.render();
      // Switch chart to new drug's y-axis config (label, scale, persisted range)
      if (chart) {
        const cfg = getChartDrugConfig(drugId);
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
      const m = mode.get(selectedDrug);
      if (m === 'intermittent') return mode.getIntermittentThreshold(selectedDrug);
      return mode.getCeTarget(selectedDrug);
    },
    getIntermittentThreshold: () => mode.getIntermittentThreshold(selectedDrug),
    getDrugId: () => selectedDrug,
    getDrugIds: () => ['propofol', 'fentanyl', 'ketamine'],
    getModeForDrug: (drugId) => mode.get(drugId),
    getIntermittentThresholdForDrug: (drugId) => mode.getIntermittentThreshold(drugId),
    getCeTargetForDrug: (drugId) => mode.getCeTarget(drugId),
    getTciFraction: () => warnings.getSettings().tciFraction,
    getSsSlopeTol:  () => warnings.getSettings().ssSlopeTol,
    getSsExitBand:  () => warnings.getSettings().exitBandPct,
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
      // Chart annotations — updated per-frame so they reflect the
      // freshly-computed approach data (which runs in the rAF loop BEFORE
      // this callback). Putting it in refreshChart would race: refreshChart
      // reads the data before updateApproachLine has computed it.
      if (chart) {
        const m = mode.get(selectedDrug);
        const { yScale: ys } = getChartDrugConfig(selectedDrug);

        // Steady-state horizontal line (manual mode only)
        const ssCe = drugPanel.getSteadyStateCe(selectedDrug);
        if (ssCe && m === 'manual') {
          const scaled = ssCe * ys;
          if (chart._lastSsCe !== scaled) {
            chart._lastSsCe = scaled;
            chart.setSteadyStateLine(scaled);
          }
        } else if (chart._lastSsCe) {
          chart._lastSsCe = null;
          chart.setSteadyStateLine(null);
        }

        // Plateau region bounding box (manual mode only)
        const plat = drugPanel.getPlateauRegion(selectedDrug);
        if (plat && m === 'manual') {
          // Compute chart end time for permanent plateaus (endMin === null)
          const events = model ? model.getEvents(selectedDrug) : [];
          const lastEvt = events.length > 0 ? events[events.length - 1].time : 0;
          const chartEnd = Math.max(360, t + 360, lastEvt + 360);
          const region = {
            startMin: plat.startMin,
            endMin:   plat.endMin ?? chartEnd,
            ceMin:    plat.ceMin * ys,
            ceMax:    plat.ceMax * ys,
          };
          // Only update chart when region actually changed
          const prev = chart._lastPlateauRegion;
          if (!prev || prev.startMin !== region.startMin || prev.endMin !== region.endMin ||
              Math.abs(prev.ceMin - region.ceMin) > 1e-9 || Math.abs(prev.ceMax - region.ceMax) > 1e-9) {
            chart._lastPlateauRegion = region;
            chart.setPlateauRegion(region);
          }
        } else if (chart._lastPlateauRegion) {
          chart._lastPlateauRegion = null;
          chart.setPlateauRegion(null);
        }
      }
      // Check for upcoming events requiring advance warning
      if (t > 0) warnings.check(t);
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

  // Initialize warnings
  warnings.init({
    model,
    getDrugIds: () => ['propofol', 'fentanyl', 'ketamine'],
    getPatient:  () => model ? model.getPatient() : null,
  });

  // Wire settings modal
  (function initSettings() {
    // Plateau slope tolerance — continuous range 0.05–0.20 %/min.
    // Stored as a dimensionless per-minute relative slope (e.g. 0.0010 = 0.10 %/min).
    // Slider value is in %/min (0.05–0.20); divide by 100 to get the fraction.
    const SS_SLOPE_DEFAULT = 0.0010;   // 0.10 %/min
    const SS_SLOPE_MIN     = 0.0005;   // 0.05 %/min
    const SS_SLOPE_MAX     = 0.0020;   // 0.20 %/min
    const ssSlopeLabel = (tol) => (tol * 100).toFixed(2) + ' %/min';
    const ssSlopeToSlider = (tol) => {
      // Clamp saved value into slider range, express as %/min
      const pct = Math.max(SS_SLOPE_MIN, Math.min(SS_SLOPE_MAX, tol)) * 100;
      return pct.toFixed(2);
    };

    const savedSettings     = warnings.getSettings();
    const prepSlider        = $('set-prep');
    const alertSlider       = $('set-alert');
    const prepVal           = $('set-prep-val');
    const alertVal          = $('set-alert-val');
    const prepSoundChk      = $('set-prep-sound');
    const alertSoundChk     = $('set-alert-sound');
    const redoseSoundChk    = $('set-redose-sound');
    const statusWarnSlider  = $('set-status-warn');
    const statusWarnVal     = $('set-status-warn-val');
    const tciFractionSlider = $('set-tci-fraction');
    const tciFractionVal    = $('set-tci-fraction-val');
    const ssSlopeSlider     = $('set-ss-slope');
    const ssSlopeVal        = $('set-ss-slope-val');
    const exitBandSlider    = $('set-exit-band');
    const exitBandVal       = $('set-exit-band-val');
    if (!prepSlider || !alertSlider) return;

    // Populate controls from saved settings
    prepSlider.value  = savedSettings.prepSec;
    alertSlider.value = savedSettings.alertSec;
    if (prepVal)           prepVal.textContent           = savedSettings.prepSec    + 's';
    if (alertVal)          alertVal.textContent          = savedSettings.alertSec   + 's';
    if (prepSoundChk)      prepSoundChk.checked          = savedSettings.prepSound;
    if (alertSoundChk)     alertSoundChk.checked         = savedSettings.alertSound;
    if (redoseSoundChk)    redoseSoundChk.checked        = savedSettings.redoseSound ?? true;
    if (statusWarnSlider)  statusWarnSlider.value        = savedSettings.statusWarnMinutes ?? 2;
    if (statusWarnVal)     statusWarnVal.textContent     = (savedSettings.statusWarnMinutes ?? 2) + ' min';
    if (tciFractionSlider) tciFractionSlider.value       = Math.round((savedSettings.tciFraction ?? 0.95) * 100);
    if (tciFractionVal)    tciFractionVal.textContent    = Math.round((savedSettings.tciFraction ?? 0.95) * 100) + '%';
    if (ssSlopeSlider)     ssSlopeSlider.value           = ssSlopeToSlider(savedSettings.ssSlopeTol ?? SS_SLOPE_DEFAULT);
    if (ssSlopeVal)        ssSlopeVal.textContent        = ssSlopeLabel(savedSettings.ssSlopeTol ?? SS_SLOPE_DEFAULT);
    if (exitBandSlider)    exitBandSlider.value          = Math.round((savedSettings.exitBandPct ?? 0.05) * 100);
    if (exitBandVal)       exitBandVal.textContent       = '±' + Math.round((savedSettings.exitBandPct ?? 0.05) * 100) + '%';

    function saveAll() {
      const prepSec           = parseInt(prepSlider.value,  10);
      const alertSec          = parseInt(alertSlider.value, 10);
      const prepSound         = prepSoundChk      ? prepSoundChk.checked      : false;
      const alertSound        = alertSoundChk     ? alertSoundChk.checked     : true;
      const redoseSound       = redoseSoundChk    ? redoseSoundChk.checked    : true;
      const statusWarnMinutes = statusWarnSlider ? parseInt(statusWarnSlider.value, 10) : 2;
      const tciFractionPct    = tciFractionSlider ? parseInt(tciFractionSlider.value, 10) : 95;
      const tciFraction       = tciFractionPct / 100;
      const ssSlopePct        = ssSlopeSlider ? parseFloat(ssSlopeSlider.value) : 0.10;
      const ssSlopeTol        = ssSlopePct / 100;
      const exitBandInt       = exitBandSlider ? parseInt(exitBandSlider.value, 10) : 5;
      const exitBandPct       = exitBandInt / 100;
      if (prepVal)         prepVal.textContent         = prepSec           + 's';
      if (alertVal)        alertVal.textContent        = alertSec          + 's';
      if (statusWarnVal)   statusWarnVal.textContent   = statusWarnMinutes + ' min';
      if (tciFractionVal)  tciFractionVal.textContent  = tciFractionPct    + '%';
      if (ssSlopeVal)      ssSlopeVal.textContent      = ssSlopeLabel(ssSlopeTol);
      if (exitBandVal)     exitBandVal.textContent     = '±' + exitBandInt + '%';
      warnings.setSettings({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, tciFraction, ssSlopeTol, exitBandPct });
    }

    prepSlider.addEventListener('input',    saveAll);
    alertSlider.addEventListener('input',   saveAll);
    if (prepSoundChk)      prepSoundChk.addEventListener('change',     saveAll);
    if (alertSoundChk)     alertSoundChk.addEventListener('change',    saveAll);
    if (redoseSoundChk)    redoseSoundChk.addEventListener('change',   saveAll);
    if (statusWarnSlider)  statusWarnSlider.addEventListener('input',  saveAll);
    if (tciFractionSlider) tciFractionSlider.addEventListener('input', saveAll);
    if (ssSlopeSlider)     ssSlopeSlider.addEventListener('input',     saveAll);
    if (exitBandSlider)    exitBandSlider.addEventListener('input',    saveAll);

    // Tab switching + info panel
    const infoText = $('settings-info-text');
    const INFO_TEXTS = {
      notifications: 'Configure how the simulator alerts you to upcoming pump events. Prep alerts provide early visual warning with an amber pulse on drug cards. Alert popups appear closer to the event with optional sound cues. The status indicator colors the drug card edge based on event proximity.',
      simulation: 'Fine-tune how the simulator evaluates targets and steady-state. Target tolerance sets how close the effect-site concentration must get to target before it is considered reached \u2014 lower values are stricter. Plateau slope tolerance determines how flat the concentration curve must be to qualify as steady-state.',
    };
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = $('pane-' + tab.dataset.tab);
        if (pane) pane.classList.add('active');
        if (infoText) infoText.textContent = INFO_TEXTS[tab.dataset.tab] || '';
      });
    });

    const btnSettingsOpen  = $('btn-settings');
    const btnSettingsClose = $('btn-settings-close');
    if (btnSettingsOpen)  btnSettingsOpen.addEventListener('click',  () => $('modal-settings').classList.add('open'));
    if (btnSettingsClose) btnSettingsClose.addEventListener('click', () => $('modal-settings').classList.remove('open'));
  })();

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

  // Wire TCI delay modal
  const btnTciDelayConfirm = $('tci-delay-confirm');
  if (btnTciDelayConfirm) btnTciDelayConfirm.addEventListener('click', () => commitTciDelay());
  const btnTciDelayCancel = $('tci-delay-cancel');
  if (btnTciDelayCancel) btnTciDelayCancel.addEventListener('click', () => {
    pendingTCI = null;
    closeModal('modal-tci-delay');
  });

  // Wire TCI first-step countdown modal
  const btnTciFsOk = $('tci-fs-ok');
  if (btnTciFsOk) btnTciFsOk.addEventListener('click', () => {
    if (tciCountdownInterval) { clearInterval(tciCountdownInterval); tciCountdownInterval = null; }
    closeModal('modal-tci-firststep');
  });

  // Wire modal close (click overlay or Escape)
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target !== o) return;
      if (o.id === 'modal-tci-delay') pendingTCI = null;
      if (o.id === 'modal-tci-firststep' && tciCountdownInterval) {
        clearInterval(tciCountdownInterval); tciCountdownInterval = null;
      }
      o.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('modal-tci-delay').classList.contains('open')) pendingTCI = null;
      if ($('modal-tci-firststep').classList.contains('open') && tciCountdownInterval) {
        clearInterval(tciCountdownInterval); tciCountdownInterval = null;
      }
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

// ---- TCI Delay Modal ----

const TCI_DELAY_OPTIONS = [5, 10, 15, 20, 30]; // seconds

function showTciDelayModal(ceTarget, drugId) {
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

function commitTciDelay() {
  if (!pendingTCI) return;
  const { drugId, ceTarget, tciMode } = pendingTCI;
  pendingTCI = null;

  const futureTime = timer.getElapsedMinutes() + tciDelaySeconds / 60;
  mode.setCeTarget(drugId, ceTarget);
  const { scheme } = model.planTCI(drugId, futureTime, ceTarget, { tciMode });
  mode.set(drugId, 'tci', `TCI target Ce=${ceTarget.toFixed(1)} μg/mL`);
  refreshChart();

  closeModal('modal-tci-delay');
  showTciFirstStepModal(scheme, drugId, tciDelaySeconds);
}

// ---- TCI First-Step Countdown Modal ----

function showTciFirstStepModal(scheme, drugId, delaySeconds) {
  const firstStep = scheme && scheme[0];
  if (!firstStep) return;

  const patient = model.getPatient();
  const ps = getPumpSettings(drugId);
  const ctx = { weightKg: patient.weight, concentration: ps.concentration };

  function buildActionHtml(task, canonicalValue, prefix) {
    const allowed = getAllowedUnits(drugId, task);
    const primary = getDefaultUnit(drugId, task) || allowed[0];
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

  let remainingMs = delaySeconds * 1000;
  const intervalMs = 100;

  let _zeroChimeFired = false;
  function tick() {
    const secs = remainingMs / 1000;
    $('tci-fs-countdown').textContent = secs > 0 ? `in ${secs.toFixed(1)}s` : 'Now!';
    if (remainingMs <= 0) {
      if (!_zeroChimeFired) {
        _zeroChimeFired = true;
        playAlert('info');
      }
      clearInterval(tciCountdownInterval);
      tciCountdownInterval = null;
      setTimeout(() => closeModal('modal-tci-firststep'), 1500);
    }
    remainingMs -= intervalMs;
  }
  tick();
  tciCountdownInterval = setInterval(tick, intervalMs);
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
