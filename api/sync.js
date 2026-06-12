/**
 * api/sync.js — Cloud scratch area (de-identified, training only).
 *
 * One serverless function, three payload kinds, all keyed by a shared
 * 6-character pairing code:
 *
 *   patient  (default, no `kind`) — demographics pushed by the separate
 *            scratchpad PWA and pulled by TCIsim on demand. Contract is
 *            frozen: the scratchpad app is deployed separately, so the
 *            no-kind GET/POST shapes must never change.
 *   case     — TCIsim's saved-case blob, pushed/pulled manually so a case
 *            can be moved to another device.
 *   template — TCIsim's starting-dose template (a user preference).
 *
 *   GET  /api/sync?code=ABC234[&kind=case|template]
 *   POST /api/sync   body { code, patient }                  (patient)
 *   POST /api/sync   body { code, kind, payload }            (case/template)
 *
 * Per-kind TTL and size caps live in KINDS below. Case/template payloads get
 * light sanity checks only — full schema validation happens client-side in
 * js/sync/ (the case blob is the app's own save format).
 *
 * Storage: Upstash Redis via REST (env: UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN). CORS allow-list via SYNC_ALLOWED_ORIGINS
 * (comma-separated). Runs only on Vercel — the static site (python
 * http.server) never executes this file, and the front-end buttons degrade
 * gracefully when /api is unavailable.
 *
 * This endpoint is intentionally unauthenticated (the pairing code is the only
 * secret) and last-writer-wins. Acceptable for de-identified training data;
 * do NOT push PHI through it.
 */

// Per-kind retention and payload caps. Patient values are the original
// constants — the scratchpad contract depends on them. The case blob is the
// whole saved case (events + annotations), typically 2–20 KB; 64 KB bounds
// abuse on an unauthenticated endpoint while leaving headroom. The template
// is a small preference with low churn, so it outlives a code rotation.
const KINDS = {
  patient:  { ttl: 30 * 60,           maxBytes: 1024 },
  case:     { ttl: 24 * 60 * 60,      maxBytes: 64 * 1024 },
  template: { ttl: 30 * 24 * 60 * 60, maxBytes: 4 * 1024 },
};

// Raw-body stream cap: largest kind plus envelope slack. Per-kind caps are
// enforced after parse so the patient 1 KB → 413 contract is preserved.
const MAX_STREAM_BYTES = 70 * 1024;

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  // Accept both the native Upstash names and the Vercel KV / Marketplace
  // integration names — which set the function gets depends on how the store
  // was provisioned, and a mismatch is the usual cause of "kv-not-configured".
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV not configured');
  // Lazy require (after the env check) so the module loads — and is
  // unit-testable — without node_modules installed.
  const { Redis } = require('@upstash/redis');
  _redis = new Redis({ url, token });
  return _redis;
}

function allowedOrigins() {
  return (process.env.SYNC_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const allow = allowedOrigins();
  if (origin && allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function normalizeCode(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
}

const isNum = v => typeof v === 'number' && isFinite(v);

/** Validate + normalize an incoming patient. Returns canonical object or null. */
function validatePatient(p) {
  if (!p || typeof p !== 'object') return null;
  const { age, sex, heightCm, weightKg } = p;
  if (!Number.isInteger(age) || age < 1 || age > 120) return null;
  if (sex !== 'male' && sex !== 'female') return null;
  if (!isNum(heightCm) || heightCm < 30 || heightCm > 250) return null;
  if (!isNum(weightKg) || weightKg < 0.5 || weightKg > 300) return null;
  return { age, sex, heightCm, weightKg };
}

/**
 * Light sanity check for case/template payloads. The blob is the app's own
 * save format — full validation happens client-side on pull.
 */
function validateKindPayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!isNum(payload.v)) return false;
  if (kind === 'case') {
    return !!(payload.patient && typeof payload.patient === 'object'
           && payload.events && typeof payload.events === 'object');
  }
  if (kind === 'template') {
    return !!(payload.drugs && typeof payload.drugs === 'object');
  }
  return false;
}

function keyFor(code, kind) {
  return kind === 'patient' || !kind ? `tcisync:${code}` : `tcisync:${code}:${kind}`;
}

async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const code = normalizeCode(req.query && req.query.code);
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'invalid-code' });
        return;
      }
      const kind = (req.query && req.query.kind) || 'patient';
      if (!KINDS[kind]) {
        res.status(400).json({ error: 'invalid-kind' });
        return;
      }
      const stored = await getRedis().get(keyFor(code, kind));
      if (!stored) {
        res.status(200).json({ found: false });
        return;
      }
      // Upstash returns parsed JSON for object values.
      const rec = typeof stored === 'string' ? JSON.parse(stored) : stored;
      if (kind === 'patient') {
        res.status(200).json({ found: true, patient: rec });
      } else {
        res.status(200).json({ found: true, payload: rec.payload, updatedAt: rec.updatedAt });
      }
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req, MAX_STREAM_BYTES);
      if (body === TOO_LARGE) {
        res.status(413).json({ error: 'payload-too-large' });
        return;
      }
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'bad-json' });
        return;
      }
      const code = normalizeCode(body.code);
      if (!CODE_RE.test(code)) {
        res.status(400).json({ error: 'invalid-code' });
        return;
      }
      const kind = body.kind || 'patient';
      if (!KINDS[kind]) {
        res.status(400).json({ error: 'invalid-kind' });
        return;
      }
      const updatedAt = Date.now();

      if (kind === 'patient') {
        // Original contract: whole body capped at 1 KB, strict field validation.
        if (Buffer.byteLength(JSON.stringify(body)) > KINDS.patient.maxBytes) {
          res.status(413).json({ error: 'payload-too-large' });
          return;
        }
        const patient = validatePatient(body.patient);
        if (!patient) {
          res.status(400).json({ error: 'invalid-patient' });
          return;
        }
        const value = { ...patient, updatedAt };
        await getRedis().set(keyFor(code, kind), JSON.stringify(value), { ex: KINDS.patient.ttl });
        res.status(200).json({ ok: true, updatedAt });
        return;
      }

      if (!validateKindPayload(kind, body.payload)) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(body.payload)) > KINDS[kind].maxBytes) {
        res.status(413).json({ error: 'payload-too-large' });
        return;
      }
      await getRedis().set(
        keyFor(code, kind),
        JSON.stringify({ payload: body.payload, updatedAt }),
        { ex: KINDS[kind].ttl }
      );
      res.status(200).json({ ok: true, updatedAt });
      return;
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ error: 'method-not-allowed' });
  } catch (err) {
    const msg = err && err.message === 'KV not configured' ? 'kv-not-configured' : 'server-error';
    res.status(500).json({ error: msg });
  }
}

const TOO_LARGE = Symbol('too-large');

/**
 * Read + parse the JSON request body with a hard size cap. Returns the parsed
 * object, TOO_LARGE if the cap is exceeded, or null on parse failure. Handles
 * both Vercel's pre-parsed req.body and a raw stream.
 */
async function readJsonBody(req, maxBytes) {
  if (req.body != null && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > maxBytes) return TOO_LARGE;
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > maxBytes) return TOO_LARGE;
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return TOO_LARGE;
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

module.exports = handler;
// Internals exposed for the CommonJS test suite only — not part of the API.
module.exports.__test = { KINDS, keyFor, validatePatient, validateKindPayload };
