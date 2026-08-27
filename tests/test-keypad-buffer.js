/**
 * test-keypad-buffer.js — Shared keypad-buffer semantics.
 *
 * Pins the CLAUDE.md invariants now centralized in js/ui/keypad-buffer.js:
 *   - prefilled buffers replace on first keypress (digit/decimal/backspace)
 *   - unit toggles convert (canonical round-trip) and re-arm prefilled
 * plus the delivery-time formatters shared by keypad.js / event-editor.js.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

// units.js reads localStorage for pref keys
const _store = new Map();
global.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};

const u = (...p) => pathToFileURL(path.join(__dirname, '..', ...p)).href;

(async () => {
  const { applyBufferKey, convertBufferUnit, fmtDeliveryTime, bolusTimeText } =
    await import(u('js', 'ui', 'keypad-buffer.js'));

  console.log('\n===== Keypad buffer semantics =====\n');

  // ---- applyBufferKey: plain typing ----
  let s = { buffer: '', prefilled: false };
  s = applyBufferKey(s, '1'); s = applyBufferKey(s, '2'); s = applyBufferKey(s, '.'); s = applyBufferKey(s, '5');
  ok(s.buffer === '12.5', 'digits + decimal append normally');
  s = applyBufferKey(s, '.');
  ok(s.buffer === '12.5', 'second decimal point is a no-op');
  s = applyBufferKey(s, 'back');
  ok(s.buffer === '12.', 'backspace deletes one char when not prefilled');
  s = applyBufferKey(s, 'clear');
  ok(s.buffer === '' && s.prefilled === false, 'clear empties and disarms');

  // '.' on empty buffer produces '0.'
  ok(applyBufferKey({ buffer: '', prefilled: false }, '.').buffer === '0.',
    'decimal on empty buffer yields "0."');

  // ---- prefilled: first keypress replaces ----
  ok(applyBufferKey({ buffer: '3.0', prefilled: true }, '5').buffer === '5',
    'first digit on prefilled buffer replaces');
  ok(applyBufferKey({ buffer: '3.0', prefilled: true }, '.').buffer === '0.',
    'first decimal on prefilled buffer replaces');
  ok(applyBufferKey({ buffer: '3.0', prefilled: true }, 'back').buffer === '',
    'backspace on prefilled buffer clears whole value');
  ok(applyBufferKey({ buffer: '3.0', prefilled: true }, '5').prefilled === false,
    'prefill disarms after the replacing keypress');

  // ---- maxLen / allowDecimal ----
  ok(applyBufferKey({ buffer: '123456', prefilled: false }, '7', { maxLen: 6 }).buffer === '123456',
    'digit beyond maxLen is ignored');
  ok(applyBufferKey({ buffer: '42', prefilled: false }, '.', { allowDecimal: false }).buffer === '42',
    'decimal ignored when allowDecimal is false');
  ok(applyBufferKey({ buffer: '', prefilled: false }, 'x').buffer === '',
    'unknown key is a no-op');

  // ---- immutability ----
  const orig = { buffer: '7', prefilled: true };
  applyBufferKey(orig, '9');
  ok(orig.buffer === '7' && orig.prefilled === true, 'input state is not mutated');

  // ---- convertBufferUnit ----
  const ctx = { weightKg: 70 };
  const conv = convertBufferUnit('100', 'mg', 'mL', 'propofol', 'bolus', ctx);
  ok(conv !== null && conv.prefilled === true, 'unit conversion re-arms prefilled');
  ok(conv !== null && parseFloat(conv.buffer) === 10, '100 mg propofol @10 mg/mL = 10 mL');
  ok(convertBufferUnit('', 'mg', 'mL', 'propofol', 'bolus', ctx) === null,
    'empty buffer → null (caller leaves buffer alone)');
  ok(convertBufferUnit('50', 'mg', 'mg', 'propofol', 'bolus', ctx) === null,
    'same unit → null (no-op)');

  // A toggle may not round away what the unit's display cap cannot express.
  // Fentanyl's rate grid (0.01 mcg/kg/min) is finer than the 1 dp cap, so the
  // old formatValue path returned '0.1' for 0.07 and '0' for a mcg/h value.
  const fctx = { weightKg: 65.8 };
  const r1 = convertBufferUnit('0.07', 'mcg/kg/min', 'mcg/h', 'fentanyl', 'rate', fctx);
  const r2 = convertBufferUnit(r1.buffer, 'mcg/h', 'mcg/kg/min', 'fentanyl', 'rate', fctx);
  ok(Math.abs(parseFloat(r2.buffer) - 0.07) < 1e-9,
    'fentanyl 0.07 mcg/kg/min survives a mcg/h round trip');
  const r3 = convertBufferUnit('3', 'mcg/h', 'mcg/kg/min', 'fentanyl', 'rate', fctx);
  ok(r3 !== null && parseFloat(r3.buffer) > 0,
    '3 mcg/h → mcg/kg/min stays non-zero rather than collapsing to 0');
  const r4 = convertBufferUnit('0.35', 'ng/mL', 'ng/mL', 'fentanyl', 'ceTarget', fctx);
  ok(r4 === null, 'same-unit ceTarget toggle is still a no-op');

  // ---- fmtDeliveryTime ----
  ok(fmtDeliveryTime(0.5) === '30s', '0.5 min → "30s"');
  ok(fmtDeliveryTime(0.001) === '1s', 'sub-second clamps to "1s"');
  ok(fmtDeliveryTime(1.5) === '1:30', '1.5 min → "1:30"');
  ok(fmtDeliveryTime(10) === '10:00', '10 min → "10:00"');

  // ---- bolusTimeText ----
  ok(bolusTimeText(0, 'propofol', { pushOnly: false }) === '', 'zero dose → empty string');
  ok(/^Given over ~.+ pump · ~.+ push$/.test(bolusTimeText(100, 'propofol', { pushOnly: false })),
    'pump mode shows both pump and push times');
  ok(/^Given over ~[^·]+$/.test(bolusTimeText(0.1, 'fentanyl', { pushOnly: true })),
    'pushOnly shows a single push time');

  summary();
})().catch(err => {
  console.error('FATAL:', err);
  failed++;
  summary();
});
