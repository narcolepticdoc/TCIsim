/**
 * annotations.js — Build the Chart.js annotation configuration.
 *
 * Reads from the shared state object to produce cursor, inspect,
 * target, threshold, steady-state, exit, BIS band, and plateau
 * annotations.
 */

import { COLORS } from '../../util/constants.js';

export function buildAnnotations(s) {
  const annotations = {};

  annotations.cursor = {
    type: 'line',
    xMin: s.cursorTime,
    xMax: s.cursorTime,
    borderColor: '#ffffff',
    borderWidth: 1.5,
    borderDash: [4, 3],
  };

  if (s.inspectTime !== null) {
    annotations.inspect = {
      type: 'line',
      xMin: s.inspectTime,
      xMax: s.inspectTime,
      borderColor: '#f59e0b',
      borderWidth: 1.5,
      borderDash: [],
    };
  }

  if (s.targetCe !== null && s.targetCe > 0) {
    annotations.target = {
      type: 'line',
      yMin: s.targetCe,
      yMax: s.targetCe,
      borderColor: COLORS.target + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [6, 3],
    };
  }

  if (s.thresholdCe !== null && s.thresholdCe > 0) {
    annotations.threshold = {
      type: 'line',
      yMin: s.thresholdCe,
      yMax: s.thresholdCe,
      borderColor: '#f59e0b' + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [4, 3],
    };
  }

  if (s.steadyStateCe !== null && s.steadyStateCe > 0) {
    annotations.ssLine = {
      type: 'line',
      yMin: s.steadyStateCe,
      yMax: s.steadyStateCe,
      borderColor: '#22c55e' + s.overlayAlpha,
      borderWidth: 1.5,
      borderDash: [8, 4],
    };
  }

  if (s.exitCe !== null && s.exitCe > 0) {
    annotations.exitCe = {
      type: 'line',
      yMin: s.exitCe,
      yMax: s.exitCe,
      borderColor: '#ef4444' + s.overlayAlpha,
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
        color: '#ffffff' + labelAlpha,
        font: { size: 9 },
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
      backgroundColor: '#f59e0b' + fillA,
      borderColor: '#f59e0b' + s.overlayAlpha,
      borderWidth: 2,
      drawTime: 'afterDatasetsDraw',
    };
  }

  return annotations;
}
