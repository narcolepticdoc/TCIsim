/**
 * settings-ui.js — Settings modal DOM wiring.
 *
 * Extracted from app.js. Handles slider/checkbox initialization,
 * live value display updates, tab switching, and open/close buttons
 * for the settings modal.
 */

import { syncPortraitLayout } from './portrait-layout.js';

const $ = id => document.getElementById(id);

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

const INFO_TEXTS = {
  notifications: 'Configure how the simulator alerts you to upcoming pump events. Prep alerts provide early visual warning with an amber pulse on drug cards. Alert popups appear closer to the event with optional sound cues. The status indicator colors the drug card edge based on event proximity.',
  simulation: 'Fine-tune how the simulator evaluates targets and steady-state. Target tolerance sets how close the effect-site concentration must get to target before it is considered reached \u2014 lower values are stricter. Plateau slope tolerance determines how flat the concentration curve must be to qualify as steady-state.',
  appearance: 'Adjust the visual presentation of the chart and readouts. Reducing Cp line opacity pushes the plasma concentration curve into the background so the effect-site (Ce) curve stands out more clearly. Text size enlarges the drug-panel and history informational text; it is gated to screens that have the space for it.',
};

/** Apply the text-size body class. Only one of `.text-lg` / `.text-xl` / `.text-xxl` is active at a time. */
function applyTextSize(size) {
  const cls = document.body.classList;
  cls.remove('text-lg', 'text-xl', 'text-xxl');
  if (size === 'large') cls.add('text-lg');
  else if (size === 'xl') cls.add('text-xl');
  else if (size === 'xxl') cls.add('text-xxl');
  // Drug-card height may have changed — re-sync the portrait grid rows.
  try { syncPortraitLayout(); } catch (e) { /* module may not have been init'd yet */ }
}

/**
 * Wire the settings modal: populate controls from saved settings,
 * attach input listeners that persist changes, wire tab switching
 * and open/close buttons.
 *
 * @param {{ getSettings: Function, setSettings: Function }} opts
 */
export function initSettingsUI({ getSettings, setSettings }) {
  const savedSettings     = getSettings();
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
  const cpOpacitySlider   = $('set-cp-opacity');
  const cpOpacityVal      = $('set-cp-opacity-val');
  const nomogramSlider    = $('set-nomogram-opacity');
  const nomogramVal       = $('set-nomogram-opacity-val');
  const overlaySlider     = $('set-overlay-opacity');
  const overlayVal        = $('set-overlay-opacity-val');
  const markerSizeSlider  = $('set-event-marker-size');
  const markerSizeVal     = $('set-event-marker-size-val');
  const textSizeGroup     = $('set-text-size');
  const textSizeBtns      = textSizeGroup ? [...textSizeGroup.querySelectorAll('.seg-btn')] : [];
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
  if (cpOpacitySlider)   cpOpacitySlider.value         = Math.round((savedSettings.cpOpacity ?? 1.0) * 100);
  if (cpOpacityVal)      cpOpacityVal.textContent      = Math.round((savedSettings.cpOpacity ?? 1.0) * 100) + '%';
  if (nomogramSlider)    nomogramSlider.value          = Math.round((savedSettings.nomogramOpacity ?? 1.0) * 100);
  if (nomogramVal)       nomogramVal.textContent       = Math.round((savedSettings.nomogramOpacity ?? 1.0) * 100) + '%';
  if (overlaySlider)     overlaySlider.value           = Math.round((savedSettings.overlayOpacity ?? 1.0) * 100);
  if (overlayVal)        overlayVal.textContent        = Math.round((savedSettings.overlayOpacity ?? 1.0) * 100) + '%';
  if (markerSizeSlider)  markerSizeSlider.value        = (savedSettings.eventMarkerSize ?? 7);
  if (markerSizeVal)     markerSizeVal.textContent     = (savedSettings.eventMarkerSize ?? 7) + ' px';
  let currentTextSize = savedSettings.textSize ?? 'normal';
  for (const btn of textSizeBtns) btn.classList.toggle('active', btn.dataset.size === currentTextSize);
  applyTextSize(currentTextSize);

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
    const cpOpacityPct      = cpOpacitySlider ? parseInt(cpOpacitySlider.value, 10) : 100;
    const cpOpacity         = cpOpacityPct / 100;
    const nomogramPct       = nomogramSlider ? parseInt(nomogramSlider.value, 10) : 100;
    const nomogramOpacity   = nomogramPct / 100;
    const overlayPct        = overlaySlider ? parseInt(overlaySlider.value, 10) : 100;
    const overlayOpacity    = overlayPct / 100;
    const eventMarkerSize   = markerSizeSlider ? parseInt(markerSizeSlider.value, 10) : 7;
    const textSize          = currentTextSize;
    if (prepVal)         prepVal.textContent         = prepSec           + 's';
    if (alertVal)        alertVal.textContent        = alertSec          + 's';
    if (statusWarnVal)   statusWarnVal.textContent   = statusWarnMinutes + ' min';
    if (tciFractionVal)  tciFractionVal.textContent  = tciFractionPct    + '%';
    if (ssSlopeVal)      ssSlopeVal.textContent      = ssSlopeLabel(ssSlopeTol);
    if (exitBandVal)     exitBandVal.textContent     = '±' + exitBandInt + '%';
    if (cpOpacityVal)    cpOpacityVal.textContent    = cpOpacityPct      + '%';
    if (nomogramVal)     nomogramVal.textContent     = nomogramPct       + '%';
    if (overlayVal)      overlayVal.textContent      = overlayPct        + '%';
    if (markerSizeVal)   markerSizeVal.textContent   = eventMarkerSize   + ' px';
    setSettings({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, tciFraction, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, eventMarkerSize, textSize });
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
  if (cpOpacitySlider)   cpOpacitySlider.addEventListener('input',   saveAll);
  if (nomogramSlider)    nomogramSlider.addEventListener('input',    saveAll);
  if (overlaySlider)     overlaySlider.addEventListener('input',     saveAll);
  if (markerSizeSlider)  markerSizeSlider.addEventListener('input',  saveAll);
  for (const btn of textSizeBtns) {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      if (!size || size === currentTextSize) return;
      currentTextSize = size;
      for (const b of textSizeBtns) b.classList.toggle('active', b.dataset.size === size);
      applyTextSize(size);
      saveAll();
    });
  }

  // Tab switching + info panel
  const infoText = $('settings-info-text');
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
}
