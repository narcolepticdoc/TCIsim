/**
 * test-dose-template.js — Starting-dose template tests.
 *
 * Exercises the pure exports of js/sync/dose-template.js via dynamic import
 * (schema normalization against the real DRUG_TASK_UNITS, and dose planning
 * with real toCanonical conversions). The localStorage wrappers are not
 * tested here — they're thin try/catch shims.
 */

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function near(a, b, tol, m) { ok(Math.abs(a - b) < tol, `${m} (${a} ≈ ${b})`); }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}\n`);
  process.exit(failed ? 1 : 0);
}

(async () => {
  const modUrl = pathToFileURL(path.join(__dirname, '..', 'js', 'sync', 'dose-template.js')).href;
  const { normalizeTemplate, isTemplateEmpty, buildTemplateDoses } = await import(modUrl);

  // ---- normalizeTemplate ----
  {
    const t = normalizeTemplate({
      v: 1, updatedAt: 42,
      drugs: { propofol: { bolus: { value: 100, unit: 'mg' }, rate: { value: 30, unit: 'mL/h' } } },
    });
    ok(t.v === 1 && t.updatedAt === 42, 'valid template: v + updatedAt preserved');
    ok(t.drugs.propofol.bolus.value === 100 && t.drugs.propofol.bolus.unit === 'mg', 'valid bolus preserved');
    ok(t.drugs.propofol.rate.value === 30 && t.drugs.propofol.rate.unit === 'mL/h', 'valid rate preserved');
  }
  {
    const t = normalizeTemplate({ drugs: { propofol: { bolus: { value: 0, unit: 'mg' } } } });
    ok(!t.drugs.propofol, 'zero value dropped');
  }
  {
    const t = normalizeTemplate({ drugs: { propofol: { bolus: { value: -5, unit: 'mg' } } } });
    ok(!t.drugs.propofol, 'negative value dropped');
  }
  {
    const t = normalizeTemplate({ drugs: { propofol: { bolus: { value: NaN, unit: 'mg' } } } });
    ok(!t.drugs.propofol, 'NaN value dropped');
  }
  {
    const t = normalizeTemplate({ drugs: { propofol: { bolus: { value: 100, unit: 'gallons' } } } });
    ok(!t.drugs.propofol, 'unknown unit dropped');
  }
  {
    // ng/mL is a ceTarget unit, not a bolus unit — task-specific allow-list applies
    const t = normalizeTemplate({ drugs: { fentanyl: { bolus: { value: 1, unit: 'ng/mL' } } } });
    ok(!t.drugs.fentanyl, 'unit from wrong task dropped');
  }
  {
    const t = normalizeTemplate({ drugs: { unicorn: { bolus: { value: 100, unit: 'mg' } } } });
    ok(Object.keys(t.drugs).length === 0, 'unknown drug dropped');
  }
  {
    const t = normalizeTemplate({
      drugs: { fentanyl: { bolus: { value: 100, unit: 'mcg' }, rate: { value: 0, unit: 'mcg/h' } } },
    });
    ok(t.drugs.fentanyl.bolus.value === 100 && t.drugs.fentanyl.rate === null,
      'mixed entry: valid bolus kept, invalid rate nulled');
  }
  ok(Object.keys(normalizeTemplate(null).drugs).length === 0, 'null → empty template');
  ok(Object.keys(normalizeTemplate('junk').drugs).length === 0, 'string → empty template');
  ok(Object.keys(normalizeTemplate({ drugs: 7 }).drugs).length === 0, 'non-object drugs → empty');

  // ---- isTemplateEmpty ----
  ok(isTemplateEmpty(normalizeTemplate(null)) === true, 'empty template detected');
  ok(isTemplateEmpty(null) === true, 'null is empty');
  ok(isTemplateEmpty(normalizeTemplate({ drugs: { propofol: { bolus: { value: 100, unit: 'mg' } } } })) === false,
    'template with a dose is not empty');

  // ---- buildTemplateDoses ----
  const CTX = {
    weightKg: 80,
    pump: {
      propofol: { concentration: 10, pumpEnabled: true },
      fentanyl: { concentration: 0.05, pumpEnabled: false },
      ketamine: { concentration: 10, pumpEnabled: false },
    },
    noTciDrugs: new Set(['fentanyl', 'ketamine']),
  };

  {
    const t = normalizeTemplate({
      drugs: { propofol: { bolus: { value: 100, unit: 'mg' }, rate: { value: 30, unit: 'mL/h' } } },
    });
    const items = buildTemplateDoses(t, CTX);
    ok(items.length === 2, 'propofol bolus+rate → 2 items');
    ok(items[0].type === 'rate' && items[1].type === 'bolus', 'rate ordered before bolus');
    near(items[0].canonicalValue, 5, 1e-9, 'rate 30 mL/h @ 10 mg/mL → 5 mg/min');
    ok(items[0].setManualMode === true, 'rate sets manual mode');
    near(items[1].canonicalValue, 100, 1e-9, 'bolus 100 mg → 100 mg canonical');
    ok(items[1].deliveryMode === 'pump', 'pump-on bolus delivered via pump');
    ok(items[1].setManualMode === true, 'pump bolus on TCI-capable drug sets manual mode');
    ok(items[0].displayText === '30.0 mL/h', 'rate displayText formatted');
    ok(items[1].displayText === '100.0 mg', 'bolus displayText formatted');
  }
  {
    const t = normalizeTemplate({ drugs: { fentanyl: { bolus: { value: 100, unit: 'mcg' } } } });
    const items = buildTemplateDoses(t, CTX);
    ok(items.length === 1, 'fentanyl bolus → 1 item');
    near(items[0].canonicalValue, 0.1, 1e-9, '100 mcg → 0.1 mg canonical');
    ok(items[0].deliveryMode === 'push', 'pump-off bolus → IV push');
    ok(items[0].setManualMode === false, 'pump-off bolus does not set manual mode');
  }
  {
    const t = normalizeTemplate({ drugs: { fentanyl: { bolus: { value: 1, unit: 'mcg/kg' } } } });
    const items = buildTemplateDoses(t, CTX);
    near(items[0].canonicalValue, 0.08, 1e-9, '1 mcg/kg @ 80 kg → 0.08 mg canonical');
  }
  {
    const t = normalizeTemplate({ drugs: { fentanyl: { rate: { value: 1, unit: 'mcg/kg/min' } } } });
    const items = buildTemplateDoses(t, CTX);
    ok(items.length === 1 && items[0].error === 'rate-needs-pump', 'rate with pump off → rate-needs-pump');
    ok(!('canonicalValue' in items[0]) || items[0].canonicalValue === undefined, 'errored item has no canonical value');
  }
  {
    const t = normalizeTemplate({ drugs: { propofol: { bolus: { value: 500, unit: 'mcg/kg' } } } });
    const items = buildTemplateDoses(t, { ...CTX, weightKg: undefined });
    ok(items.length === 1 && items[0].error === 'conversion-failed', 'weight-based dose without weight → conversion-failed');
  }
  {
    const t = normalizeTemplate({
      drugs: { fentanyl: { bolus: { value: 50, unit: 'mcg' }, rate: { value: 30, unit: 'mcg/h' } } },
    });
    const pumpOnCtx = { ...CTX, pump: { ...CTX.pump, fentanyl: { concentration: 0.05, pumpEnabled: true } } };
    const items = buildTemplateDoses(t, pumpOnCtx);
    ok(items[0].type === 'rate' && !items[0].error, 'pump-on fentanyl rate delivered');
    near(items[0].canonicalValue, 0.0005, 1e-12, '30 mcg/h → 0.0005 mg/min');
    ok(items[1].deliveryMode === 'pump', 'pump-on fentanyl bolus via pump');
    ok(items[1].setManualMode === false, 'pump bolus on no-TCI drug does not set manual mode');
  }
  {
    const t = normalizeTemplate({
      drugs: {
        propofol: { bolus: { value: 100, unit: 'mg' } },
        ketamine: { bolus: { value: 0.5, unit: 'mg/kg' } },
      },
    });
    const items = buildTemplateDoses(t, CTX);
    ok(items.length === 2, 'multi-drug template → item per dose');
    near(items.find(i => i.drugId === 'ketamine').canonicalValue, 40, 1e-9, 'ketamine 0.5 mg/kg @ 80 kg → 40 mg');
  }
  ok(buildTemplateDoses(normalizeTemplate(null), CTX).length === 0, 'empty template → no items');
  ok(buildTemplateDoses(null, CTX).length === 0, 'null template → no items');

  summary();
})().catch(err => {
  console.error(err);
  failed++;
  summary();
});
