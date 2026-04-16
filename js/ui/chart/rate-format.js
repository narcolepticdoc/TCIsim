/**
 * rate-format.js — Format pump rate in the user's preferred display unit.
 */

import { fromCanonical, getDefaultUnit, getPrefKey, formatValue, getAllowedUnits } from '../../util/units.js';

export function formatRateForDisplay(s, rateMgMin) {
  try {
    const prefKey = getPrefKey(s.currentDrugId, 'rate');
    let displayUnit = getDefaultUnit(s.currentDrugId, 'rate');
    if (prefKey) {
      try {
        const saved = localStorage.getItem(prefKey);
        const allowed = getAllowedUnits(s.currentDrugId, 'rate');
        if (saved && allowed.includes(saved)) displayUnit = saved;
      } catch (e) { /* ignore */ }
    }
    const ctx = { weightKg: s.patientWeightKg || undefined };
    const displayVal = fromCanonical(rateMgMin, displayUnit, s.currentDrugId, 'rate', ctx);
    return formatValue(displayVal, displayUnit) + ' ' + displayUnit;
  } catch (e) {
    return rateMgMin.toFixed(2) + ' mg/min';
  }
}
