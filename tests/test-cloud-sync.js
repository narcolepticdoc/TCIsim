/**
 * test-cloud-sync.js — Generic cloud push/pull transport tests.
 *
 * Exercises js/sync/cloud-sync.js via dynamic import. Network calls use an
 * injected fetchImpl mock, so the transport's error mapping (invalid-code /
 * network / http) and request shapes are verified offline. The pure helpers
 * (prepareCaseForPush, validateIncomingCase) are tested directly.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

const mockFetch = (impl) => {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
};
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

(async () => {
  const modUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'sync', 'cloud-sync.js')).href;
  const { pushPayload, fetchPayload, prepareCaseForPush, validateIncomingCase, CASE_MAX_BYTES } = await import(modUrl);

  const TEMPLATE = { v: 1, updatedAt: 5, drugs: { propofol: { bolus: { value: 100, unit: 'mg' }, rate: null } } };

  // ---- pushPayload ----
  {
    const f = mockFetch(() => jsonRes(200, { ok: true, updatedAt: 123 }));
    const r = await pushPayload('bad', 'template', TEMPLATE, { fetchImpl: f });
    ok(r.ok === false && r.error === 'invalid-code', 'push: invalid code rejected');
    ok(f.calls.length === 0, 'push: invalid code never hits network');
  }
  {
    const f = mockFetch(() => jsonRes(200, { ok: true, updatedAt: 123 }));
    const r = await pushPayload('abc234', 'template', TEMPLATE, { fetchImpl: f });
    ok(r.ok === true && r.updatedAt === 123, 'push: success returns updatedAt');
    ok(f.calls[0].opts.method === 'POST', 'push: uses POST');
    const sent = JSON.parse(f.calls[0].opts.body);
    ok(sent.code === 'ABC234', 'push: code normalized in body');
    ok(sent.kind === 'template', 'push: kind in body');
    ok(sent.payload && sent.payload.v === 1, 'push: payload in body');
  }
  {
    const f = mockFetch(() => jsonRes(413, { error: 'payload-too-large' }));
    const r = await pushPayload('ABC234', 'case', TEMPLATE, { fetchImpl: f });
    ok(r.ok === false && r.error === 'http' && r.status === 413 && r.serverError === 'payload-too-large',
      'push: http error surfaces status + serverError');
  }
  {
    const f = mockFetch(() => { throw new Error('offline'); });
    const r = await pushPayload('ABC234', 'case', TEMPLATE, { fetchImpl: f });
    ok(r.ok === false && r.error === 'network', 'push: thrown fetch → network error');
  }

  // ---- fetchPayload ----
  {
    const f = mockFetch(() => jsonRes(200, { found: true, payload: TEMPLATE, updatedAt: 99 }));
    const r = await fetchPayload('bad!!', 'template', { fetchImpl: f });
    ok(r.found === false && r.error === 'invalid-code', 'fetch: invalid code rejected');
  }
  {
    const f = mockFetch(() => jsonRes(200, { found: true, payload: TEMPLATE, updatedAt: 99 }));
    const r = await fetchPayload('abc234', 'template', { fetchImpl: f });
    ok(r.found === true && r.payload.v === 1 && r.updatedAt === 99, 'fetch: success returns payload + updatedAt');
    ok(f.calls[0].url.includes('code=ABC234') && f.calls[0].url.includes('kind=template'),
      'fetch: URL carries code + kind');
  }
  {
    const f = mockFetch(() => jsonRes(200, { found: false }));
    const r = await fetchPayload('ABC234', 'case', { fetchImpl: f });
    ok(r.found === false && !r.error, 'fetch: not-found is not an error');
  }
  {
    const f = mockFetch(() => jsonRes(200, { found: true, payload: 'junk' }));
    const r = await fetchPayload('ABC234', 'case', { fetchImpl: f });
    ok(r.found === false, 'fetch: non-object payload → not found');
  }
  {
    const f = mockFetch(() => jsonRes(500, { error: 'kv-not-configured' }));
    const r = await fetchPayload('ABC234', 'case', { fetchImpl: f });
    ok(r.found === false && r.error === 'http' && r.serverError === 'kv-not-configured',
      'fetch: http error surfaces serverError');
  }
  {
    const f = mockFetch(() => { throw new Error('offline'); });
    const r = await fetchPayload('ABC234', 'case', { fetchImpl: f });
    ok(r.found === false && r.error === 'network', 'fetch: thrown fetch → network error');
  }

  // ---- prepareCaseForPush ----
  const CASE = { v: 1, patient: { age: 45, weight: 80, height: 180, male: true }, events: { propofol: [] }, reconciliationGhosts: {} };
  {
    const r = prepareCaseForPush(CASE);
    ok(r === CASE, 'prepare: under cap returned unchanged');
  }
  {
    const fat = { ...CASE, reconciliationGhosts: { propofol: { points: 'x'.repeat(CASE_MAX_BYTES) } } };
    const r = prepareCaseForPush(fat);
    ok(r !== null && r !== fat, 'prepare: oversize ghosts → slimmed copy');
    ok(r && JSON.stringify(r.reconciliationGhosts) === '{}', 'prepare: ghosts stripped');
    ok(r && r.events === fat.events, 'prepare: other fields preserved');
  }
  {
    const hopeless = { ...CASE, events: { propofol: 'x'.repeat(CASE_MAX_BYTES) } };
    ok(prepareCaseForPush(hopeless) === null, 'prepare: still oversize → null');
  }
  ok(prepareCaseForPush(null) === null, 'prepare: null → null');

  // ---- validateIncomingCase ----
  {
    const r = validateIncomingCase(CASE);
    ok(r === CASE, 'validate: valid case passes through');
  }
  ok(validateIncomingCase(null) === null, 'validate: null rejected');
  ok(validateIncomingCase([1]) === null, 'validate: array rejected');
  ok(validateIncomingCase({ ...CASE, v: undefined }) === null, 'validate: missing v rejected');
  ok(validateIncomingCase({ ...CASE, patient: null }) === null, 'validate: missing patient rejected');
  ok(validateIncomingCase({ ...CASE, patient: { age: 45, weight: 80, height: 180, male: 'yes' } }) === null,
    'validate: non-boolean male rejected');
  ok(validateIncomingCase({ ...CASE, patient: { age: 45, height: 180, male: true } }) === null,
    'validate: missing weight rejected');
  ok(validateIncomingCase({ ...CASE, events: undefined }) === null, 'validate: missing events rejected');
  ok(validateIncomingCase({ ...CASE, events: [] }) === null, 'validate: array events rejected');

  // ---- schema-version gate ----
  const { isNewerSchema } = await import(modUrl);
  ok(validateIncomingCase({ ...CASE, v: 2 }) === null, 'validate: v:2 (newer schema) rejected');
  ok(isNewerSchema({ ...CASE, v: 2 }) === true, 'isNewerSchema flags v:2');
  ok(isNewerSchema(CASE) === false, 'isNewerSchema passes v:1');
  ok(isNewerSchema(null) === false, 'isNewerSchema tolerates null');

  summary();
})().catch(err => {
  console.error(err);
  failed++;
  summary();
});
