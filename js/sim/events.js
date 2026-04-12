/**
 * events.js — Re-export shim.
 *
 * The multi-drug event list has been split into sub-modules under
 * js/sim/events/. This file preserves the historical import path
 * ('./events.js') so existing consumers (simulation.js, tests,
 * diagnostic loader) keep working unchanged.
 *
 * See js/sim/events/index.js for the orchestrator and facade wiring.
 * Individual concerns live in delivery.js, replay.js, list-ops.js,
 * query.js and actions.js.
 */

export { createEventList } from './events/index.js';
