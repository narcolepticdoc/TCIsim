/**
 * annotations.js — Build the Chart.js annotation configuration.
 *
 * Reads from the shared state object to produce cursor, inspect,
 * target, threshold, steady-state, exit, BIS band, and plateau
 * annotations.
 */

import { COLORS } from '../../util/constants.js';

/**
 * Read the semantic + chart CSS variables annotations rely on. Sampled fresh
 * on every rebuild so theme switches take effect on the next chart.update().
 * Each color is a 6-char hex string so the trailing-alpha concatenation
 * pattern (e.g. `amber + s.overlayAlpha`) keeps producing valid 8-char hex.
 */
function readAnnotationColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    amber:   v('--amber',           '#f59e0b'),
    green:   v('--green',           '#22c55e'),
    red:     v('--red',             '#ef4444'),
    cursor:  v('--chart-label-fg',  '#ffffff'),
    labelFg: v('--chart-label-fg',  '#ffffff'),
  };
}

export function buildAnnotations(s) {
  const annotations = {};
  const c = readAnnotationColors();

  annotations.cursor = {
    type: 'line',
    xMin: s.cursorTime,
    xMax: s.cursorTime,
    borderColor: c.cursor,
    borderWidth: 1.5,
    borderDash: [4, 3],
  };

  if (s.inspectTime !== null) {
    annotations.inspect = {
      type: 'line',
      xMin: s.inspectTime,
      xMax: s.inspectTime,
      borderColor: c.amber,
      borderWidth: 1.5,
      borderDash: [],
    };
  }

  if (s.targetCe !== null && s.targetCe > 0) {
    if (s.ceBandTolerance && s.ceBandTolerance > 0) {
      // Band visible — render as a pair of upper/lower target lines
      // instead of a filled box. Lines are crisp against the BIS nomogram
      // overlays where a 14%-alpha fill is imperceptible. The single
      // centerline is replaced entirely; the zone between the two lines
      // IS the target tolerance window.
      annotations.targetUpper = {
        type: 'line',
        yMin: s.targetCe * (1 + s.ceBandTolerance),
        yMax: s.targetCe * (1 + s.ceBandTolerance),
        borderColor: COLORS.target + s.overlayAlpha,
        borderWidth: 1.5,
        borderDash: [6, 3],
      };
      annotations.targetLower = {
        type: 'line',
        yMin: s.targetCe * (1 - s.ceBandTolerance),
        yMax: s.targetCe * (1 - s.ceBandTolerance),
        borderColor: COLORS.target + s.overlayAlpha,
        borderWidth: 1.5,
        borderDash: [6, 3],
      };
    } else {
      annotations.target = {
        type: 'line',
        yMin: s.targetCe,
        yMax: s.targetCe,
        borderColor: COLORS.target + s.overlayAlpha,
        borderWidth: 1.5,
        borderDash: [6, 3],
      };
    }
  }

  if (s.thresholdCe !== null && s.thresholdCe > 0) {
    annotations.threshold = {
      type: 'line',
      yMin: s.thresholdCe,
      yMax: s.thresholdCe,
      borderColor: c.amber + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [4, 3],
    };
  }

  if (s.steadyStateCe !== null && s.steadyStateCe > 0) {
    annotations.ssLine = {
      type: 'line',
      yMin: s.steadyStateCe,
      yMax: s.steadyStateCe,
      borderColor: c.green + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [8, 4],
    };
  }

  if (s.exitCe !== null && s.exitCe > 0) {
    annotations.exitCe = {
      type: 'line',
      yMin: s.exitCe,
      yMax: s.exitCe,
      borderColor: c.red + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [5, 4],
    };
  }

  s.effectBands.forEach((band, i) => {
    const baseAlpha = parseInt(band.color.slice(7, 9) || '30', 16);
    const scaledAlpha = Math.round(baseAlpha * s.nomogramOpacity).toString(16).padStart(2, '0');
    const labelAlpha = Math.round(0x88 * s.nomogramOpacity).toString(16).padStart(2, '0');
    annotations[`band_${i}`] = {
      type: 'box',
      yMin: band.ceMin,
      yMax: band.ceMax,
      backgroundColor: band.color.slice(0, 7) + scaledAlpha,
      borderWidth: 0,
      label: band.label ? {
        display: true,
        content: band.label,
        position: { x: 'end', y: 'center' },
        xAdjust: -36,
        color: c.labelFg + labelAlpha,
        font: { size: Math.round(9 * (s.fontScale || 1)) },
      } : undefined,
    };
  });

  if (s.plateauRegion) {
    const fillA = Math.round(0x1f * (parseInt(s.overlayAlpha, 16) / 255)).toString(16).padStart(2, '0');
    annotations.plateau = {
      type: 'box',
      xScaleID: 'x',
      yScaleID: 'y',
      xMin: s.plateauRegion.startMin,
      xMax: s.plateauRegion.endMin ?? s.viewMax,
      yMin: s.plateauRegion.ceMin,
      yMax: s.plateauRegion.ceMax,
      backgroundColor: c.amber + fillA,
      borderColor: c.amber + s.overlayAlpha,
      borderWidth: 2,
      drawTime: 'afterDatasetsDraw',
    };
  }

  if (s.reconciliationRegion) {
    // Amber full-height band marking an interval whose concentration values
    // should not be trusted — the model is rebalancing after a retrospective
    // correction bolus. Lighter fill than plateau so the curves underneath
    // stay legible, and a dashed border to read as a "caution" band instead
    // of a target.
    const fillA = Math.round(0x18 * (parseInt(s.overlayAlpha, 16) / 255)).toString(16).padStart(2, '0');
    annotations.reconciliation = {
      type: 'box',
      xScaleID: 'x',
      yScaleID: 'y',
      xMin: s.reconciliationRegion.xMin,
      xMax: s.reconciliationRegion.xMax,
      backgroundColor: c.amber + fillA,
      borderColor: c.amber + s.overlayAlpha,
      borderWidth: 1,
      borderDash: [6, 4],
      drawTime: 'afterDatasetsDraw',
    };
  }

  return annotations;
}
