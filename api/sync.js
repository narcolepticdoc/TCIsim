/**
 * api/sync.js — Cloud patient "scratch area" (de-identified, training only).
 *
 * A separate scratchpad PWA POSTs patient demographics here keyed by a shared
 * pairing code; TCIsim GETs the latest for that code on demand. Only age, sex,
 * height (cm), weight (kg) are stored. Entries expire after 30 minutes so a
 * reused code never serves stale demographics.
 *
 * Storage: Upstash Redis via REST (env: UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN). CORS allow-list via SYNC_ALLOWED_ORIGINS
 * (comma-separated). Runs only on Vercel — the static site (python http.server)
 * never executes this file, and the front-end Pull button degrades gracefully
 * when /api is unavailable.
 *
 * This endpoint is intentionally unauthenticated (the pairing code is the only
 * secret) and last-writer-wins. Acceptable for de-identified training data;
 * do NOT push PHI through it.
 */

const { Redis } = require('@upstash/redis');

const TTL_SECONDS = 30 * 60; // 30 min
const MAX_BODY_BYTES = 1024; // 1 KB cap
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV not configured');
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

function keyFor(code) {
  return `tcisync:${code}`;
}

module.exports = async function handler(req, res) {
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
      const stored = await getRedis().get(keyFor(code));
      if (!stored) {
        res.status(200).json({ found: false });
        return;
      }
      // Upstash returns parsed JSON for object values.
      const patient = typeof stored === 'string' ? JSON.parse(stored) : stored;
      res.status(200).json({ found: true, patient });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
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
      const patient = validatePatient(body.patient);
      if (!patient) {
        res.status(400).json({ error: 'invalid-patient' });
        return;
      }
      const updatedAt = Date.now();
      const value = { ...patient, updatedAt };
      await getRedis().set(keyFor(code), JSON.stringify(value), { ex: TTL_SECONDS });
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
async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) return TOO_LARGE;
    return req.body;
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) return TOO_LARGE;
    try { return JSON.parse(req.body); } catch (e) { return null; }
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return TOO_LARGE;
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}
