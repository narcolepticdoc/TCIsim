/**
 * settings-ui.js — Settings modal DOM wiring.
 *
 * Extracted from app.js. Handles slider/checkbox initialization,
 * live value display updates, tab switching, and open/close buttons
 * for the settings modal.
 */

import { syncPortraitLayout } from './portrait-layout.js';
import { getStoredCode, setStoredCode, normalizeCode, isValidCode } from '../sync/patient-sync.js';
import { pushPayload, fetchPayload } from '../sync/cloud-sync.js';
import { collectPrefs, applyPrefs, isPrefsEmpty, isNewerPrefsSchema } from '../sync/prefs-sync.js';
import { getGlobalMaxPumpRate, setGlobalMaxPumpRate } from '../ui/setup.js';

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

// Plateau exit band — ±% band on a half-percent grid (1–5% range).
// Stored as a fraction (0.025 = ±2.5%). Snap to the 0.5% slider grid, then
// format without a trailing ".0" so whole percents read as "±5%".
const exitBandGridPct = (pct) => Math.round(pct * 200) / 2;   // fraction → %, snapped
const exitBandToSlider = (pct) => exitBandGridPct(pct).toFixed(1);
const exitBandLabel    = (pct) => '±' + exitBandGridPct(pct).toFixed(1).replace(/\.0$/, '') + '%';

const INFO_TEXTS = {
  notifications: 'Configure how the simulator alerts you to upcoming pump events. Prep alerts provide early visual warning with an amber pulse on drug cards. Alert popups appear closer to the event with optional sound cues. The status indicator colors the drug card edge based on event proximity.',
  simulation: 'Fine-tune how the simulator generates TCI plans. Max pump rate is the global delivery rate (mL/h) shared by every pumped drug; it caps the infusion rate and sets how fast boluses are delivered, and can be changed mid-case (it affects subsequent plans and boluses, not already-delivered events). Ce drift tolerance sets how far the effect-site concentration is allowed to drift from target before the planner emits a new pump rate step \u2014 lower values give tighter tracking at the cost of more frequent rate changes; higher values produce simpler plans with more visible Ce variation. The default (1.5%) is already tighter than a live clinician could hold manually. Plateau slope tolerance determines how flat the concentration curve must be to qualify as steady-state.',
  appearance: 'Adjust the visual presentation of the chart and readouts. Reducing Cp line opacity pushes the plasma concentration curve into the background so the effect-site (Ce) curve stands out more clearly. The Ce drift band highlights the \u00b1drift tolerance around each TCI target \u2014 Ce may briefly touch this boundary at planned step transitions by design. Text size enlarges the drug-panel and history informational text; it is gated to screens that have the space for it. Theme switches the entire app between dark and light color schemes.',
  sync: 'Pair this simulator with a separate scratchpad app to pull patient demographics from the cloud. Enter the 6-character code that the scratchpad app displays; both apps then share a private scratch area. On the patient setup screen, tap \u201cPull patient from cloud\u201d to fetch the latest demographics (age, sex, height, weight) \u2014 the timestamp confirms how recent they are. The same code also moves your last case and starting-dose template between devices: push the case here (or from the setup screen) and pull it on the other device within 24 hours. De-identified / training use only; do not transfer protected health information.',
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

const THEME_META_COLORS = { dark: '#0a0f1a', light: '#f4f6fa' };

/**
 * Apply the app color theme by setting `data-theme` on `<html>`. CSS variable
 * blocks under `:root[data-theme="…"]` cascade through every surface. Also
 * updates the browser-chrome `<meta name="theme-color">` and dispatches a
 * `tci:theme-change` event so the chart can re-read CSS vars.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META_COLORS[theme] || THEME_META_COLORS.dark);
  document.dispatchEvent(new CustomEvent('tci:theme-change', { detail: { theme } }));
}

/**
 * Wire the settings modal: populate controls from saved settings,
 * attach input listeners that persist changes, wire tab switching
 * and open/close buttons.
 *
 * @param {{ getSettings: Function, setSettings: Function }} opts
 */
export function initSettingsUI({ getSettings, setSettings, onMaxPumpRateChange }) {
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
  const reactDelaySlider  = $('set-reaction-delay');
  const reactDelayVal     = $('set-reaction-delay-val');
  const ceTolSlider       = $('set-tci-fraction');
  const ceTolVal          = $('set-tci-fraction-val');
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
  const ghostOpacSlider   = $('set-ghost-opacity');
  const ghostOpacVal      = $('set-ghost-opacity-val');
  const markerSizeSlider  = $('set-event-marker-size');
  const markerSizeVal     = $('set-event-marker-size-val');
  const showCeBandChk     = $('set-show-ce-band');
  const textSizeGroup     = $('set-text-size');
  const textSizeBtns      = textSizeGroup ? [...textSizeGroup.querySelectorAll('.seg-btn')] : [];
  const themeGroup        = $('set-theme');
  const themeBtns         = themeGroup ? [...themeGroup.querySelectorAll('.seg-btn')] : [];
  const timeAxisGroup     = $('set-time-axis');
  const timeAxisBtns      = timeAxisGroup ? [...timeAxisGroup.querySelectorAll('.seg-btn')] : [];
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
  if (reactDelaySlider)  reactDelaySlider.value        = (savedSettings.reactionDelaySec ?? 0).toFixed(1);
  if (reactDelayVal)     reactDelayVal.textContent     = (savedSettings.reactionDelaySec ?? 0).toFixed(1) + ' s';
  // Slider value represents tenths of a percent: 5..30 step 5 maps to 0.5%..3.0%.
  // Stored ceTolerance is a fraction (0.005..0.030); slider value = ceTolerance * 1000.
  if (ceTolSlider) ceTolSlider.value                   = Math.round((savedSettings.ceTolerance ?? 0.015) * 1000);
  if (ceTolVal)    ceTolVal.textContent                = ((savedSettings.ceTolerance ?? 0.015) * 100).toFixed(1) + '%';
  if (ssSlopeSlider)     ssSlopeSlider.value           = ssSlopeToSlider(savedSettings.ssSlopeTol ?? SS_SLOPE_DEFAULT);
  if (ssSlopeVal)        ssSlopeVal.textContent        = ssSlopeLabel(savedSettings.ssSlopeTol ?? SS_SLOPE_DEFAULT);
  if (exitBandSlider)    exitBandSlider.value          = exitBandToSlider(savedSettings.exitBandPct ?? 0.025);
  if (exitBandVal)       exitBandVal.textContent       = exitBandLabel(savedSettings.exitBandPct ?? 0.025);
  if (cpOpacitySlider)   cpOpacitySlider.value         = Math.round((savedSettings.cpOpacity ?? 1.0) * 100);
  if (cpOpacityVal)      cpOpacityVal.textContent      = Math.round((savedSettings.cpOpacity ?? 1.0) * 100) + '%';
  if (nomogramSlider)    nomogramSlider.value          = Math.round((savedSettings.nomogramOpacity ?? 1.0) * 100);
  if (nomogramVal)       nomogramVal.textContent       = Math.round((savedSettings.nomogramOpacity ?? 1.0) * 100) + '%';
  if (overlaySlider)     overlaySlider.value           = Math.round((savedSettings.overlayOpacity ?? 1.0) * 100);
  if (overlayVal)        overlayVal.textContent        = Math.round((savedSettings.overlayOpacity ?? 1.0) * 100) + '%';
  if (ghostOpacSlider)   ghostOpacSlider.value         = Math.round((savedSettings.ghostOpacity ?? 0.5) * 100);
  if (ghostOpacVal)      ghostOpacVal.textContent      = Math.round((savedSettings.ghostOpacity ?? 0.5) * 100) + '%';
  if (markerSizeSlider)  markerSizeSlider.value        = (savedSettings.eventMarkerSize ?? 7);
  if (markerSizeVal)     markerSizeVal.textContent     = (savedSettings.eventMarkerSize ?? 7) + ' px';
  if (showCeBandChk)     showCeBandChk.checked         = savedSettings.showCeBand ?? false;
  let currentTextSize = savedSettings.textSize ?? 'normal';
  for (const btn of textSizeBtns) btn.classList.toggle('active', btn.dataset.size === currentTextSize);
  applyTextSize(currentTextSize);
  let currentTheme = savedSettings.theme ?? 'dark';
  for (const btn of themeBtns) btn.classList.toggle('active', btn.dataset.theme === currentTheme);
  applyTheme(currentTheme);
  let currentTimeAxis = savedSettings.timeAxisMode ?? 'min';
  for (const btn of timeAxisBtns) btn.classList.toggle('active', btn.dataset.mode === currentTimeAxis);

  function saveAll() {
    const prepSec           = parseInt(prepSlider.value,  10);
    const alertSec          = parseInt(alertSlider.value, 10);
    const prepSound         = prepSoundChk      ? prepSoundChk.checked      : false;
    const alertSound        = alertSoundChk     ? alertSoundChk.checked     : true;
    const redoseSound       = redoseSoundChk    ? redoseSoundChk.checked    : true;
    const statusWarnMinutes = statusWarnSlider ? parseInt(statusWarnSlider.value, 10) : 2;
    const reactionDelayRaw  = reactDelaySlider ? parseFloat(reactDelaySlider.value) : 0;
    const reactionDelaySec  = Math.round(Math.max(0, Math.min(2, reactionDelayRaw)) * 2) / 2;
    const ceTolTenths       = ceTolSlider ? parseInt(ceTolSlider.value, 10) : 15;
    const ceTolerance       = ceTolTenths / 1000;
    const ssSlopePct        = ssSlopeSlider ? parseFloat(ssSlopeSlider.value) : 0.10;
    const ssSlopeTol        = ssSlopePct / 100;
    const exitBandPct       = exitBandSlider ? parseFloat(exitBandSlider.value) / 100 : 0.025;
    const cpOpacityPct      = cpOpacitySlider ? parseInt(cpOpacitySlider.value, 10) : 100;
    const cpOpacity         = cpOpacityPct / 100;
    const nomogramPct       = nomogramSlider ? parseInt(nomogramSlider.value, 10) : 100;
    const nomogramOpacity   = nomogramPct / 100;
    const overlayPct        = overlaySlider ? parseInt(overlaySlider.value, 10) : 100;
    const overlayOpacity    = overlayPct / 100;
    const ghostOpacPct      = ghostOpacSlider ? parseInt(ghostOpacSlider.value, 10) : 50;
    const ghostOpacity      = ghostOpacPct / 100;
    // Ghost on/off lives on the chart-controls strip, not in the settings
    // modal. Re-read the persisted flag so saveAll() doesn't lose it when
    // a slider/checkbox in this modal is changed.
    const ghostTracesEnabled = !!getSettings().ghostTracesEnabled;
    const eventMarkerSize   = markerSizeSlider ? parseInt(markerSizeSlider.value, 10) : 7;
    const textSize          = currentTextSize;
    const theme             = currentTheme;
    const showCeBand        = showCeBandChk ? showCeBandChk.checked : false;
    const timeAxisMode      = currentTimeAxis;
    if (prepVal)         prepVal.textContent         = prepSec           + 's';
    if (alertVal)        alertVal.textContent        = alertSec          + 's';
    if (statusWarnVal)   statusWarnVal.textContent   = statusWarnMinutes + ' min';
    if (reactDelayVal)   reactDelayVal.textContent   = reactionDelaySec.toFixed(1) + ' s';
    if (ceTolVal)        ceTolVal.textContent        = (ceTolTenths / 10).toFixed(1) + '%';
    if (ssSlopeVal)      ssSlopeVal.textContent      = ssSlopeLabel(ssSlopeTol);
    if (exitBandVal)     exitBandVal.textContent     = exitBandLabel(exitBandPct);
    if (cpOpacityVal)    cpOpacityVal.textContent    = cpOpacityPct      + '%';
    if (nomogramVal)     nomogramVal.textContent     = nomogramPct       + '%';
    if (overlayVal)      overlayVal.textContent      = overlayPct        + '%';
    if (ghostOpacVal)    ghostOpacVal.textContent    = ghostOpacPct      + '%';
    if (markerSizeVal)   markerSizeVal.textContent   = eventMarkerSize   + ' px';
    setSettings({ prepSec, prepSound, alertSec, alertSound, redoseSound, statusWarnMinutes, reactionDelaySec, ceTolerance, ssSlopeTol, exitBandPct, cpOpacity, nomogramOpacity, overlayOpacity, ghostOpacity, ghostTracesEnabled, eventMarkerSize, textSize, theme, showCeBand, timeAxisMode });
  }

  prepSlider.addEventListener('input',    saveAll);
  alertSlider.addEventListener('input',   saveAll);
  if (prepSoundChk)      prepSoundChk.addEventListener('change',     saveAll);
  if (alertSoundChk)     alertSoundChk.addEventListener('change',    saveAll);
  if (redoseSoundChk)    redoseSoundChk.addEventListener('change',   saveAll);
  if (statusWarnSlider)  statusWarnSlider.addEventListener('input',  saveAll);
  if (reactDelaySlider)  reactDelaySlider.addEventListener('input',  saveAll);
  if (ceTolSlider)       ceTolSlider.addEventListener('input',       saveAll);
  if (ssSlopeSlider)     ssSlopeSlider.addEventListener('input',     saveAll);
  if (exitBandSlider)    exitBandSlider.addEventListener('input',    saveAll);
  if (cpOpacitySlider)   cpOpacitySlider.addEventListener('input',   saveAll);
  if (nomogramSlider)    nomogramSlider.addEventListener('input',    saveAll);
  if (overlaySlider)     overlaySlider.addEventListener('input',     saveAll);
  if (ghostOpacSlider)   ghostOpacSlider.addEventListener('input',   saveAll);
  if (markerSizeSlider)  markerSizeSlider.addEventListener('input',  saveAll);
  if (showCeBandChk)     showCeBandChk.addEventListener('change',    saveAll);
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
  for (const btn of themeBtns) {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      if (!theme || theme === currentTheme) return;
      currentTheme = theme;
      for (const b of themeBtns) b.classList.toggle('active', b.dataset.theme === theme);
      applyTheme(theme);
      saveAll();
    });
  }
  for (const btn of timeAxisBtns) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === currentTimeAxis) return;
      currentTimeAxis = mode;
      for (const b of timeAxisBtns) b.classList.toggle('active', b.dataset.mode === mode);
      saveAll();
    });
  }

  // Pairing code (cloud patient sync) — persisted separately from the settings
  // blob under its own localStorage key (see patient-sync.js).
  const syncCodeInput  = $('set-sync-code');
  const syncCodeStatus = $('set-sync-code-status');
  const renderSyncStatus = (code) => {
    if (!syncCodeStatus) return;
    syncCodeStatus.classList.remove('is-ok', 'is-error');
    if (!code) {
      syncCodeStatus.textContent = 'Enter the 6-character code shown in your scratchpad app.';
    } else if (isValidCode(code)) {
      syncCodeStatus.textContent = 'Paired — pull demographics from the patient setup screen.';
      syncCodeStatus.classList.add('is-ok');
    } else {
      syncCodeStatus.textContent = 'Code must be 6 characters (letters/digits, no 0/O/1/I).';
      syncCodeStatus.classList.add('is-error');
    }
  };
  if (syncCodeInput) {
    syncCodeInput.value = getStoredCode();
    renderSyncStatus(syncCodeInput.value);
    // The code saves on every keystroke; the prefs offer fires only when a
    // VALID code first appears (and once per distinct code) — the moment a
    // fresh install becomes recoverable.
    let lastOfferedCode = isValidCode(getStoredCode()) ? getStoredCode() : null;
    syncCodeInput.addEventListener('input', () => {
      const norm = normalizeCode(syncCodeInput.value);
      if (syncCodeInput.value !== norm) syncCodeInput.value = norm;
      setStoredCode(norm);
      renderSyncStatus(norm);
      document.dispatchEvent(new CustomEvent('tci:sync-code-change', { detail: { code: getStoredCode() } }));
      if (isValidCode(norm) && norm !== lastOfferedCode) {
        lastOfferedCode = norm;
        offerCloudPrefs(norm);
      }
    });
  }

  // ---- Preferences cloud sync (kind 'prefs') ----
  const setPrefsStatus = (text, cls) => {
    const el = $('prefs-sync-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-ok', 'is-error');
    if (cls) el.classList.add(cls);
  };
  const applyPulledPrefs = (payload) => {
    const applied = applyPrefs(payload);
    if (applied === null) {
      setPrefsStatus(isNewerPrefsSchema(payload)
        ? 'These preferences were saved by a newer app version — update this device first'
        : 'Received preferences were invalid', 'is-error');
      return;
    }
    setPrefsStatus('Preferences applied — reloading…', 'is-ok');
    setTimeout(() => location.reload(), 400);
  };
  // Right after pairing: if preferences exist in the cloud for this code,
  // offer to apply them (the fresh-install recovery flow).
  const offerCloudPrefs = async (code) => {
    try {
      const res = await fetchPayload(code, 'prefs');
      if (!res.found || isPrefsEmpty(res.payload)) return;
      if (window.confirm('Preferences found in the cloud for this code — apply them to this device?')) {
        applyPulledPrefs(res.payload);
      }
    } catch (e) { /* offer is best-effort — pairing itself already succeeded */ }
  };
  const btnPushPrefs = $('btn-sync-push-prefs');
  if (btnPushPrefs) {
    btnPushPrefs.addEventListener('click', async () => {
      const code = getStoredCode();
      if (!code) { setPrefsStatus('Enter a sync code above first', 'is-error'); return; }
      const blob = collectPrefs();
      if (isPrefsEmpty(blob)) { setPrefsStatus('No preferences to push yet', 'is-error'); return; }
      btnPushPrefs.disabled = true;
      setPrefsStatus('Pushing…', 'is-ok');
      const res = await pushPayload(code, 'prefs', blob);
      btnPushPrefs.disabled = false;
      if (res.ok) setPrefsStatus('Preferences pushed — kept in the cloud for 30 days', 'is-ok');
      else setPrefsStatus(res.error === 'invalid-code' ? 'Invalid pairing code' : 'Push failed — check connection', 'is-error');
    });
  }
  const btnPullPrefs = $('btn-sync-pull-prefs');
  if (btnPullPrefs) {
    btnPullPrefs.addEventListener('click', async () => {
      const code = getStoredCode();
      if (!code) { setPrefsStatus('Enter a sync code above first', 'is-error'); return; }
      btnPullPrefs.disabled = true;
      setPrefsStatus('Pulling…', 'is-ok');
      const res = await fetchPayload(code, 'prefs');
      btnPullPrefs.disabled = false;
      if (!res.found) {
        setPrefsStatus('No preferences found for that code yet', 'is-error');
        return;
      }
      applyPulledPrefs(res.payload);
    });
  }

  // Max pump rate (mL/h) — global delivery rate, changeable mid-case. Not part
  // of the settings blob; it drives runtime pump settings via setup.js (which
  // persists it under tci-pump-max-rate and syncs the setup-screen control).
  const maxPumpRateEl = $('set-max-pump-rate');
  const syncMaxPumpRateSelect = () => {
    if (maxPumpRateEl) maxPumpRateEl.value = String(getGlobalMaxPumpRate());
  };
  syncMaxPumpRateSelect();
  if (maxPumpRateEl) {
    maxPumpRateEl.addEventListener('change', () => {
      // Capture the rate in effect BEFORE the change so the model can
      // re-anchor existing bolus deliveries from the old bolus-ends to the
      // corrected ones (whole-timeline). A pump max-rate change is treated
      // as a correction that applies across the whole case.
      const oldRate = getGlobalMaxPumpRate();
      setGlobalMaxPumpRate(maxPumpRateEl.value);
      const newRate = getGlobalMaxPumpRate();
      if (onMaxPumpRateChange) onMaxPumpRateChange(oldRate, newRate);
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
  if (btnSettingsOpen)  btnSettingsOpen.addEventListener('click',  () => {
    syncMaxPumpRateSelect(); // reflect current pump rate (may have changed via case restore)
    $('modal-settings').classList.add('open');
  });
  if (btnSettingsClose) btnSettingsClose.addEventListener('click', () => $('modal-settings').classList.remove('open'));
}
