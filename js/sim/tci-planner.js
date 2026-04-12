/**
 * tci-planner.js — Re-export shim.
 *
 * The four TCI planners have been split into separate modules under
 * js/sim/tci/. This file preserves the historical import path
 * ('./tci-planner.js') so existing consumers (simulation.js, tests,
 * index.html cache list) keep working unchanged.
 *
 * See js/sim/tci/index.js for the real entry point and
 * CLAUDE.md "TCI Planner Quick Reference" for the planner overview.
 */

export {
  planTCIScheme,
  planTCISchemeCET,
  planTCISchemeCETConservative,
  planTCISchemeEmulation,
  planTCIFromEvents,
} from './tci/index.js';
