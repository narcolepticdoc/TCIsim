/**
 * patient-sync.js — Cloud patient pull (de-identified, training only).
 *
 * A separate "scratchpad" PWA on another device continuously pushes patient
 * demographics (age / sex / height / weight, in canonical metric) to a small
 * cloud scratch area (Vercel serverless + Upstash KV) keyed by a shared pairing
 * code. TCIsim pulls the latest payload for that code on demand and injects it
 * into the existing setup pipeline via the patient-modal _writeHidden() path.
 *
 * Only age, sex, height, weight transfer. Opioid is NOT synced — the user's
 * existing opioid setting is left untouched on pull.
 *
 * The pure functions (normalizeCode, isValidCode, normalizeIncomingPatient,
 * canonicalToDisplay, formatRelativeTime) are DOM/network-free and unit-tested
 * in tests/test-patient-sync.js. The impure wrappers (fetchPatient,
 * applyPatientToInputs) take their dependencies by injection.
 */

export const SYNC_ENDPOINT = '/api/sync';
export const CODE_STORAGE_KEY = 'tci-sync-code';

// Shared pairing-code format: 6 uppercase alphanumerics, no ambiguous 0/O/1/I.
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// ---- Pure: pairing code ----

/** Normalize a raw pairing code: strip whitespace, uppercase. */
export function normalizeCode(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, '').toUpperCase();
}

/** True when `code` (already normalized) matches the shared format. */
export function isValidCode(code) {
  return CODE_RE.test(normalizeCode(code));
}

// ---- Pure: payload normalization ----

const isNum = v => typeof v === 'number' && isFinite(v);

/**
 * Normalize + validate a raw GET payload's patient object into a canonical
 * patient, or null if invalid. Range checks mirror the serverless validator.
 * Ignores any stray fields (e.g. opioid) — only age/sex/height/weight/updatedAt
 * are carried forward.
 *
 * @returns {{age:number, sex:'male'|'female', heightCm:number, weightKg:number,
 *            updatedAt:number} | null}
 */
export function normalizeIncomingPatient(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload.patient && typeof payload.patient === 'object' ? payload.patient : payload;

  const age = p.age;
  const sex = p.sex;
  const heightCm = p.heightCm;
  const weightKg = p.weightKg;

  if (!Number.isInteger(age) || age < 1 || age > 120) return null;
  if (sex !== 'male' && sex !== 'female') return null;
  if (!isNum(heightCm) || heightCm < 30 || heightCm > 250) return null;
  if (!isNum(weightKg) || weightKg < 0.5 || weightKg > 300) return null;

  const updatedAt = isNum(p.updatedAt) ? p.updatedAt
                  : isNum(payload.updatedAt) ? payload.updatedAt
                  : NaN;

  return { age, sex, heightCm, weightKg, updatedAt };
}

// ---- Pure: canonical metric -> display-unit strings ----

const round1 = n => String(Math.round(n * 10) / 10);

/**
 * Convert a canonical (metric) patient into the display-unit string values the
 * hidden inputs expect for the given units ('metric' | 'imperial').
 *
 * @returns {{age:string, sex:string, height:string, weight:string}}
 */
export function canonicalToDisplay(patient, units) {
  const imperial = units === 'imperial';
  return {
    age: String(patient.age),
    sex: patient.sex,
    height: imperial ? round1(patient.heightCm / 2.54) : round1(patient.heightCm),
    weight: imperial ? round1(patient.weightKg / 0.453592) : round1(patient.weightKg),
  };
}

// ---- Pure: relative timestamp ----

/** Human "updated N ago" string for a server epoch-ms timestamp. */
export function formatRelativeTime(updatedAtMs, nowMs = Date.now()) {
  if (!isNum(updatedAtMs)) return '';
  const sec = Math.max(0, Math.round((nowMs - updatedAtMs) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return 'over a day ago';
}

// ---- Persistence (localStorage) ----

/** Read the stored pairing code (normalized), or '' if none/invalid. */
export function getStoredCode() {
  try {
    const code = normalizeCode(localStorage.getItem(CODE_STORAGE_KEY));
    return isValidCode(code) ? code : '';
  } catch (e) {
    return '';
  }
}

/** Persist a pairing code. Stores when valid, clears the key otherwise. */
export function setStoredCode(raw) {
  const code = normalizeCode(raw);
  try {
    if (isValidCode(code)) localStorage.setItem(CODE_STORAGE_KEY, code);
    else localStorage.removeItem(CODE_STORAGE_KEY);
  } catch (e) {}
  return isValidCode(code) ? code : '';
}

// ---- Impure: network ----

// A stalled connection (captive portal, dropped Wi-Fi) may never reject the
// fetch — without a deadline the sync buttons stay disabled and the status
// line reads "Pulling…" forever. 15 s is generous for a <64 KB payload.
export const SYNC_TIMEOUT_MS = 15000;

/**
 * fetch with an AbortController deadline. Shared by every sync transport.
 * Throws like fetch does; on timeout the error has name 'AbortError' —
 * callers map that to error: 'timeout'.
 */
export async function fetchWithTimeout(fetchImpl, url, opts = {}, timeoutMs = SYNC_TIMEOUT_MS) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const timeoutOrNetwork = (e) => (e && e.name === 'AbortError' ? 'timeout' : 'network');
export { timeoutOrNetwork as _timeoutOrNetwork };

/**
 * Fetch the latest patient for `code`. Never throws — any failure resolves to
 * { found:false, patient:null, error }. On an HTTP error the response status
 * and the server's `{error}` string (if any) are surfaced for diagnostics.
 *
 * @returns {Promise<{found:boolean, patient:object|null, error?:string,
 *                     status?:number, serverError?:string}>}
 */
export async function fetchPatient(code, { endpoint = SYNC_ENDPOINT, fetchImpl = fetch } = {}) {
  const c = normalizeCode(code);
  if (!isValidCode(c)) return { found: false, patient: null, error: 'invalid-code' };
  try {
    const res = await fetchWithTimeout(fetchImpl, `${endpoint}?code=${encodeURIComponent(c)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      let serverError;
      try { serverError = (await res.json()).error; } catch (e) { /* non-JSON body */ }
      return { found: false, patient: null, error: 'http', status: res.status, serverError };
    }
    const body = await res.json();
    if (!body || body.found !== true) return { found: false, patient: null };
    const patient = normalizeIncomingPatient(body.patient);
    if (!patient) return { found: false, patient: null, error: 'bad-payload' };
    return { found: true, patient };
  } catch (e) {
    return { found: false, patient: null, error: timeoutOrNetwork(e) };
  }
}

// ---- Impure: DOM injection ----

/**
 * Inject a canonical patient into the hidden setup inputs, converting to the
 * current display units. Reuses the injected writeHidden (patient-modal's
 * _writeHidden) so the existing setup.js reactive pipeline recomputes
 * previews / derived / summary. Touches only age/sex/height/weight.
 *
 * @param {object} patient   canonical { age, sex, heightCm, weightKg }
 * @param {object} deps
 * @param {Function} deps.getUnits     () => 'metric' | 'imperial'
 * @param {Function} deps.writeHidden  (id, value) => void
 */
export function applyPatientToInputs(patient, { getUnits, writeHidden }) {
  const units = (getUnits && getUnits()) || 'metric';
  const d = canonicalToDisplay(patient, units);
  writeHidden('input-age', d.age);
  writeHidden('input-sex', d.sex);
  writeHidden('input-height', d.height);
  writeHidden('input-weight', d.weight);
}
