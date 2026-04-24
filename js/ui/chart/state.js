/**
 * state.js — Shared mutable state for the chart component.
 *
 * All chart sub-modules receive the same state object reference
 * and read/write properties directly.
 */

export function createState(cfg) {
  return {
    cursorTime: 0,
    targetCe: null,
    thresholdCe: null,
    // ceBandTolerance: null when the Ce-drift band is hidden, or the
    // current tolerance fraction (e.g. 0.015) when visible. Drawn as a
    // low-opacity box around targetCe in annotations.js.
    ceBandTolerance: null,
    effectBands: [],
    plateauRegion: null,
    reconciliationRegion: null,
    // Signature string of the last ghost-curve payload pushed to the chart.
    // Used by setGhostCurve to short-circuit when nothing has changed,
    // since the bridge calls it every frame.
    ghostCurveSig: '',
    steadyStateCe: null,
    exitCe: null,
    viewMin: 0,
    viewMax: 30,
    autoScroll: true,
    currentDrugId: cfg.drugId || 'propofol',
    yScale: 1,
    overlayAlpha: 'ff',
    nomogramOpacity: 1.0,
    cpOpacity: 1.0,
    fontScale: 1.0,
    eventMarkers: [],
    eventAnnotationsEnabled: false,
    eventMarkerSize: 7,
    inspectTime: null,
    inspectEnabled: false,
    rateValues: [],
    patientWeightKg: null,
    pdModel: null,
    yMaxManual: null,
  };
}
