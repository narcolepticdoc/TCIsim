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
    // Signature of the last emergence-trajectory payload pushed to the chart.
    // Mirrors ghostCurveSig — the bridge calls setEmergenceTrajectory every
    // frame, so the setter short-circuits when nothing has changed.
    emergenceTrajSig: '',
    // Per-drug ghost trace signatures (multi-drug peripheral-awareness
    // ghosts). Distinct from `ghostCurveSig` (the single pre-reconcile
    // ghost) — keyed by drugId.
    ghostTracesSigs: {},
    // Per-drug decay projections for background drugs, keyed by drugId:
    //   { traj: [{x, y}], exitCe, thresholdCe }   — all already y-scaled to
    // that drug's own ghost axis. The crossover-dots plugin interpolates the
    // threshold crossings out of `traj` and draws them dimmed. Populated only
    // while ghost traces are enabled; `{}` otherwise.
    ghostCrossings: {},
    ghostCrossingsSigs: {},
    ghostOpacity: 0.5,
    ghostEnabled: false,
    // Foreground drug color (chart Ce trace + UI tinting). Cached so the
    // bridge's per-frame setDrugColor() call short-circuits when nothing
    // has changed. Resolved at construction from cfg.drugId.
    drugColor: null,
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
    // X-axis time-scale display: 'min' (sim minutes), 'hmin' (h:mm), or
    // 'rt' (wall-clock). wallClockStartMs anchors 'rt' — epoch ms for sim t=0,
    // pushed each frame by the bridge from timer.getWallClockStart().
    timeAxisMode: 'min',
    wallClockStartMs: null,
  };
}
