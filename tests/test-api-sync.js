/**
 * test-api-sync.js — Serverless /api/sync handler tests.
 *
 * Exercises api/sync.js directly with fake req/res objects. Upstash env vars
 * are cleared so every request that reaches Redis fails with the diagnostic
 * 'kv-not-configured' 500 — which doubles as proof that validation passed.
 * All validation/routing failures short-circuit before Redis, so they're
 * fully testable offline.
 *
 * The patient kind is the frozen scratchpad-app contract: those tests guard
 * that the kind-discriminator extension didn't change its behavior.
 */

const handler = require('../api/sync.js');
const { KINDS, keyFor, validatePatient, validateKindPayload } = handler.__test;

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

// Ensure no ambient KV config leaks in — requests reaching Redis must 500.
for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SYNC_ALLOWED_ORIGINS']) {
  delete process.env[k];
}

function makeReq({ method = 'GET', query = {}, body, headers = {} } = {}) {
  return { method, query, body, headers };
}

function makeRes() {
  return {
    statusCode: null, body: null, headers: {}, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; },
  };
}

async function call(reqOpts) {
  const res = makeRes();
  await handler(makeReq(reqOpts), res);
  return res;
}

const VALID_PATIENT = { age: 45, sex: 'male', heightCm: 180, weightKg: 80 };
const VALID_CASE = { v: 1, patient: { age: 45, weight: 80, height: 180, male: true }, events: { propofol: [] } };
const VALID_TEMPLATE = { v: 1, updatedAt: 1, drugs: { propofol: { bolus: { value: 100, unit: 'mg' }, rate: null } } };

(async () => {
  // ---- internals ----
  ok(keyFor('ABC234', 'patient') === 'tcisync:ABC234', 'keyFor patient unchanged (scratchpad contract)');
  ok(keyFor('ABC234', 'case') === 'tcisync:ABC234:case', 'keyFor case namespaced');
  ok(keyFor('ABC234', 'template') === 'tcisync:ABC234:template', 'keyFor template namespaced');
  ok(KINDS.patient.ttl === 30 * 60 && KINDS.patient.maxBytes === 1024, 'patient TTL/cap unchanged');
  ok(KINDS.case.ttl === 24 * 60 * 60, 'case TTL 24 h');
  ok(KINDS.template.ttl === 30 * 24 * 60 * 60, 'template TTL 30 d');

  ok(validatePatient(VALID_PATIENT) !== null, 'validatePatient accepts valid');
  ok(validatePatient({ ...VALID_PATIENT, age: 0 }) === null, 'validatePatient rejects age 0');

  ok(validateKindPayload('case', VALID_CASE) === true, 'case payload valid');
  ok(validateKindPayload('case', { ...VALID_CASE, v: 'x' }) === false, 'case payload non-numeric v rejected');
  ok(validateKindPayload('case', { v: 1, events: {} }) === false, 'case payload missing patient rejected');
  ok(validateKindPayload('case', { v: 1, patient: {} }) === false, 'case payload missing events rejected');
  ok(validateKindPayload('case', [1, 2]) === false, 'case payload array rejected');
  ok(validateKindPayload('template', VALID_TEMPLATE) === true, 'template payload valid');
  ok(validateKindPayload('template', { v: 1 }) === false, 'template payload missing drugs rejected');
  ok(validateKindPayload('bogus', VALID_CASE) === false, 'unknown kind payload rejected');

  // ---- OPTIONS / method routing ----
  {
    const res = await call({ method: 'OPTIONS' });
    ok(res.statusCode === 204 && res.ended, 'OPTIONS → 204');
  }
  {
    const res = await call({ method: 'PUT', body: {} });
    ok(res.statusCode === 405 && res.body.error === 'method-not-allowed', 'PUT → 405');
  }

  // ---- CORS ----
  {
    process.env.SYNC_ALLOWED_ORIGINS = 'https://a.example, https://b.example';
    const res = await call({ method: 'OPTIONS', headers: { origin: 'https://b.example' } });
    ok(res.headers['Access-Control-Allow-Origin'] === 'https://b.example', 'CORS echoes allow-listed origin');
    const res2 = await call({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    ok(!res2.headers['Access-Control-Allow-Origin'], 'CORS withholds non-listed origin');
    delete process.env.SYNC_ALLOWED_ORIGINS;
  }

  // ---- GET ----
  {
    const res = await call({ method: 'GET', query: { code: 'nope' } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-code', 'GET bad code → 400');
  }
  {
    const res = await call({ method: 'GET', query: { code: 'ABC234', kind: 'bogus' } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-kind', 'GET unknown kind → 400');
  }
  {
    const res = await call({ method: 'GET', query: { code: 'ABC234' } });
    ok(res.statusCode === 500 && res.body.error === 'kv-not-configured',
      'GET patient (no kind) passes validation → reaches KV');
  }
  {
    const res = await call({ method: 'GET', query: { code: 'ABC234', kind: 'case' } });
    ok(res.statusCode === 500 && res.body.error === 'kv-not-configured',
      'GET kind=case passes validation → reaches KV');
  }

  // ---- POST: shared ----
  {
    const res = await call({ method: 'POST', body: 'not-json{' });
    ok(res.statusCode === 400 && res.body.error === 'bad-json', 'POST unparseable body → 400');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'nope', patient: VALID_PATIENT } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-code', 'POST bad code → 400');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'bogus', payload: VALID_CASE } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-kind', 'POST unknown kind → 400');
  }
  {
    const big = 'x'.repeat(80 * 1024);
    const res = await call({ method: 'POST', body: JSON.stringify({ code: 'ABC234', kind: 'case', payload: { v: 1, big } }) });
    ok(res.statusCode === 413 && res.body.error === 'payload-too-large', 'POST body over stream cap → 413');
  }

  // ---- POST: patient (frozen scratchpad contract) ----
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', patient: { ...VALID_PATIENT, sex: 'x' } } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-patient', 'POST invalid patient → 400');
  }
  {
    // Whole patient body over 1 KB must still 413 even though the stream cap is larger.
    const res = await call({ method: 'POST', body: { code: 'ABC234', patient: VALID_PATIENT, junk: 'x'.repeat(1100) } });
    ok(res.statusCode === 413 && res.body.error === 'payload-too-large', 'POST patient body >1 KB → 413 (contract)');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', patient: VALID_PATIENT } });
    ok(res.statusCode === 500 && res.body.error === 'kv-not-configured', 'POST valid patient passes validation → reaches KV');
  }

  // ---- POST: case ----
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'case' } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-payload', 'POST case without payload → 400');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'case', payload: { v: 1, events: {} } } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-payload', 'POST case payload missing patient → 400');
  }
  {
    const payload = { ...VALID_CASE, filler: 'x'.repeat(65 * 1024) };
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'case', payload } });
    ok(res.statusCode === 413 && res.body.error === 'payload-too-large', 'POST case payload >64 KB → 413');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'case', payload: VALID_CASE } });
    ok(res.statusCode === 500 && res.body.error === 'kv-not-configured', 'POST valid case passes validation → reaches KV');
  }

  // ---- POST: template ----
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'template', payload: { v: 1 } } });
    ok(res.statusCode === 400 && res.body.error === 'invalid-payload', 'POST template payload missing drugs → 400');
  }
  {
    const payload = { ...VALID_TEMPLATE, filler: 'x'.repeat(5 * 1024) };
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'template', payload } });
    ok(res.statusCode === 413 && res.body.error === 'payload-too-large', 'POST template payload >4 KB → 413');
  }
  {
    const res = await call({ method: 'POST', body: { code: 'ABC234', kind: 'template', payload: VALID_TEMPLATE } });
    ok(res.statusCode === 500 && res.body.error === 'kv-not-configured', 'POST valid template passes validation → reaches KV');
  }

  summary();
})().catch(err => {
  console.error(err);
  failed++;
  summary();
});
