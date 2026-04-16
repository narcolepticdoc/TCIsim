/**
 * gestures.js — Touch/mouse gesture handlers for the chart canvas.
 *
 * Handles Y-axis finger drag, double-tap recenter, and multi-touch guards.
 * Returns a detach() function for cleanup.
 */

export function attachGestures(canvas, chart, s, recenter) {
  let yDragActive = false;
  let yDragStartY = 0;
  let yDragStartMax = 0;

  function handleYTouchStart(e) {
    if (e.touches.length !== 1) return;
    const chartArea = chart.chartArea;
    if (!chartArea) return;

    const rect = canvas.getBoundingClientRect();
    const touchX = e.touches[0].clientX - rect.left;

    if (touchX > chartArea.left + 20) return;

    yDragActive = true;
    yDragStartY = e.touches[0].clientY;
    yDragStartMax = chart.options.scales.y.max || chart.options.scales.y.suggestedMax || 10;
    e.preventDefault();
  }

  function handleYTouchMove(e) {
    if (!yDragActive || e.touches.length !== 1) return;
    e.preventDefault();

    const deltaY = e.touches[0].clientY - yDragStartY;
    const chartArea = chart.chartArea;
    const chartHeight = chartArea ? (chartArea.bottom - chartArea.top) : 200;

    const ratio = deltaY / chartHeight;
    const newMax = Math.max(1, yDragStartMax * (1 + ratio * 2));

    s.yMaxManual = newMax;
    chart.options.scales.y.max = newMax;
    try { localStorage.setItem('chart-ymax-' + s.currentDrugId, String(newMax)); } catch (e) { /* ignore */ }
    chart.update('none');
  }

  function handleYTouchEnd() {
    yDragActive = false;
  }

  canvas.addEventListener('touchstart', handleYTouchStart, { passive: false });
  canvas.addEventListener('touchmove', handleYTouchMove, { passive: false });
  canvas.addEventListener('touchend', handleYTouchEnd);

  // Double-tap / double-click recenter
  let lastTap = 0;
  let wasMultiTouch = false;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) wasMultiTouch = true;
  }, { passive: true });

  canvas.addEventListener('dblclick', () => {
    recenter();
  });

  function handleTouchEnd(e) {
    if (yDragActive) return;
    if (e.touches.length > 0) return;
    if (wasMultiTouch) {
      wasMultiTouch = false;
      return;
    }
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      recenter();
    }
    lastTap = now;
  }

  canvas.addEventListener('touchend', handleTouchEnd);

  return function detach() {
    canvas.removeEventListener('touchstart', handleYTouchStart);
    canvas.removeEventListener('touchmove', handleYTouchMove);
    canvas.removeEventListener('touchend', handleYTouchEnd);
    canvas.removeEventListener('touchend', handleTouchEnd);
  };
}
