/**
 * controls.js — Playback Controls
 * 
 * Manages the Start/Pause/Resume button and playback state.
 * Delegates to timer.js for actual time tracking.
 * Notifies app.js of state changes via callbacks.
 */

const $ = id => document.getElementById(id);

let playbackState = 'stopped'; // 'stopped' | 'running' | 'paused'
let timer = null;
let onStateChange = null; // callback: (newState, oldState) => void

/**
 * Initialize controls.
 * @param {Object} opts
 * @param {Object} opts.timer - timer module
 * @param {Function} [opts.onStateChange] - called on playback state change
 */
export function init(opts = {}) {
  timer = opts.timer;
  onStateChange = opts.onStateChange || null;

  const btn = $('btn-pause');
  if (btn) btn.addEventListener('click', togglePause);
}

export function togglePause() {
  const oldState = playbackState;

  if (playbackState === 'stopped') {
    playbackState = 'running';
    timer.start();
  } else if (playbackState === 'paused') {
    playbackState = 'running';
    timer.resume();
  } else {
    playbackState = 'paused';
    timer.pause();
  }

  updateButton();
  if (onStateChange) onStateChange(playbackState, oldState);
}

export function getState() { return playbackState; }

export function stop() {
  const oldState = playbackState;
  playbackState = 'stopped';
  timer.reset();
  updateButton();
  if (onStateChange) onStateChange(playbackState, oldState);
}

export function reset() {
  playbackState = 'stopped';
  timer.reset();
  updateButton();
}

/**
 * Ensure playback is running (auto-start if stopped/paused).
 * Used by keypad confirm — setting a target should start the sim.
 * @returns {boolean} true if state changed
 */
export function ensureRunning() {
  if (playbackState === 'running') return false;
  const oldState = playbackState;
  playbackState = 'running';
  timer.start();
  updateButton();
  if (onStateChange) onStateChange(playbackState, oldState);
  return true;
}

function updateButton() {
  const btn = $('btn-pause');
  if (!btn) return;

  if (playbackState === 'running') {
    btn.textContent = 'Pause';
    btn.className = 'btn-ctrl btn-ctrl-pause is-running';
  } else if (playbackState === 'paused') {
    btn.textContent = 'Resume';
    btn.className = 'btn-ctrl btn-ctrl-pause is-stopped';
  } else {
    btn.textContent = 'Start';
    btn.className = 'btn-ctrl btn-ctrl-pause is-stopped';
  }
}
