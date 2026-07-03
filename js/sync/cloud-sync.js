/**
 * cloud-sync.js — Generic push/pull transport for the cloud scratch area.
 *
 * Extends the patient-sync pairing-code scheme to additional payload kinds
 * served by the same /api/sync function:
 *
 *   'case'     — the saved-case blob (persist.js shape), 24 h TTL server-side,
 *                so a running or finished case can be moved to another device.
 *   'template' — the starting-dose template (dose-template.js shape), 30 d TTL.
 *
 * The pure helpers (prepareCaseForPush, validateIncomingCase) are DOM/network
 * free and unit-tested in tests/test-cloud-sync.js. The transport functions
 * never throw — failures resolve to result objects mirroring fetchPatient's
 * error contract so the UI error mapping is shared.
 */

import { SYNC_ENDPOINT, normalizeCode, isValidCode, fetchWithTimeout, _timeoutOrNetwork } from './patient-sync.js';

// Mirrors the server-side cap for kind 'case' (api/sync.js KINDS).
export const CASE_MAX_BYTES = 64 * 1024;

// ---- Impure: network ----

/**
 * Push a payload for `code` under `kind`. Never throws.
 *
 * @returns {Promise<{ok:boolean, updatedAt?:number, error?:string,
 *                     status?:number, serverError?:string}>}
 *          error: 'invalid-code' | 'network' | 'http'
 */
export async function pushPayload(code, kind, payload, { endpoint = SYNC_ENDPOINT, fetchImpl = fetch } = {}) {
  const c = normalizeCode(code);
  if (!isValidCode(c)) return { ok: false, error: 'invalid-code' };
  try {
    const res = await fetchWithTimeout(fetchImpl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ code: c, kind, payload }),
    });
    if (!res.ok) {
      let serverError;
      try { serverError = (await res.json()).error; } catch (e) { /* non-JSON body */ }
      return { ok: false, error: 'http', status: res.status, serverError };
    }
    const body = await res.json();
    return { ok: true, updatedAt: body && body.updatedAt };
  } catch (e) {
    return { ok: false, error: _timeoutOrNetwork(e) };
  }
}

/**
 * Fetch the latest payload for `code` under `kind`. Never throws.
 *
 * @returns {Promise<{found:boolean, payload:object|null, updatedAt?:number,
 *                     error?:string, status?:number, serverError?:string}>}
 *          error: 'invalid-code' | 'network' | 'http'
 */
export async function fetchPayload(code, kind, { endpoint = SYNC_ENDPOINT, fetchImpl = fetch } = {}) {
  const c = normalizeCode(code);
  if (!isValidCode(c)) return { found: false, payload: null, error: 'invalid-code' };
  try {
    const res = await fetchWithTimeout(fetchImpl, `${endpoint}?code=${encodeURIComponent(c)}&kind=${encodeURIComponent(kind)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      let serverError;
      try { serverError = (await res.json()).error; } catch (e) { /* non-JSON body */ }
      return { found: false, payload: null, error: 'http', status: res.status, serverError };
    }
    const body = await res.json();
    if (!body || body.found !== true || !body.payload || typeof body.payload !== 'object') {
      return { found: false, payload: null };
    }
    return { found: true, payload: body.payload, updatedAt: body.updatedAt };
  } catch (e) {
    return { found: false, payload: null, error: _timeoutOrNetwork(e) };
  }
}

// ---- Pure: case blob preparation / validation ----

/**
 * Size a saved-case blob for push. Under the cap it's returned unchanged.
 * Oversize, a copy without reconciliationGhosts (cosmetic chart overlay
 * point arrays — by far the largest optional field) is tried. Still
 * oversize → null, the caller reports "case too large".
 */
export function prepareCaseForPush(caseObj, maxBytes = CASE_MAX_BYTES) {
  if (!caseObj || typeof caseObj !== 'object') return null;
  const size = o => new TextEncoder().encode(JSON.stringify(o)).length;
  if (size(caseObj) <= maxBytes) return caseObj;
  const slim = { ...caseObj, reconciliationGhosts: {} };
  if (size(slim) <= maxBytes) return slim;
  return null;
}

/**
 * Validate a pulled case payload before it's written into local storage and
 * restored. Checks the fields session.restore() can't survive without; the
 * restore itself is wrapped in try/catch for everything finer-grained.
 *
 * @returns {object|null}
 */
export function validateIncomingCase(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.v !== 'number' || !isFinite(payload.v)) return null;
  const p = payload.patient;
  if (!p || typeof p !== 'object') return null;
  const num = v => typeof v === 'number' && isFinite(v);
  if (!num(p.age) || !num(p.weight) || !num(p.height) || typeof p.male !== 'boolean') return null;
  if (!payload.events || typeof payload.events !== 'object' || Array.isArray(payload.events)) return null;
  // Validate per-drug event shapes so a crafted/truncated payload is rejected
  // here rather than surfacing as NaN concentrations or a mid-restore throw.
  const EVENT_TYPES = new Set(['rate', 'bolus', 'pause']);
  for (const drugEvents of Object.values(payload.events)) {
    if (!Array.isArray(drugEvents)) return null;
    for (const evt of drugEvents) {
      if (!evt || typeof evt !== 'object') return null;
      if (!EVENT_TYPES.has(evt.type)) return null;
      if (!num(evt.time) || evt.time < 0) return null;
      // pause events carry no value; rate/bolus values must be finite ≥ 0
      if (evt.type !== 'pause' && (!num(evt.value) || evt.value < 0)) return null;
    }
  }
  return payload;
}
