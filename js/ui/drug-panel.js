/**
 * drug-panel.js — Re-export shim.
 *
 * The drug panel display has been split into sub-modules under
 * js/ui/drug-panel/. This file preserves the historical import path
 * ('./drug-panel.js' or '../ui/drug-panel.js') so existing consumers
 * (app.js) keep working unchanged.
 *
 * See js/ui/drug-panel/index.js for the orchestrator.
 */

export {
  init,
  stop,
  setCurveData,
  _estimateTimeToTarget,
  getPlateauRegion,
  getSteadyStateCe,
  forceUpdate,
} from './drug-panel/index.js';
