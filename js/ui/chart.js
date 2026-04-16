/**
 * chart.js — Re-export shim.
 *
 * The chart component has been split into sub-modules under
 * js/ui/chart/. This file preserves the historical import path
 * ('./chart.js' or '../ui/chart.js') so existing consumers
 * (app.js) keep working unchanged.
 *
 * See js/ui/chart/index.js for the orchestrator.
 */

export { createChart } from './chart/index.js';
