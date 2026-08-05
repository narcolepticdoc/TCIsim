/**
 * gestures.js — Touch/mouse gesture handlers for the chart canvas.
 *
 * Handles Y-axis finger drag, double-tap recenter, inspect-cursor handle
 * drag, and multi-touch guards. Returns a detach() function for cleanup.
 */

export function attachGestures(canvas, chart, s, recenter, setInspectTime) {
  let yDragActive = false;
  let yDragStartY = 0;
  let yDragStartMax = 0;

  // ── Y-axis drag (left 20px edge) ─────────────────────────────────────────

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

  // ── Double-tap / double-click recenter ──────────────────────────────────

  let lastTap = 0;
  let wasMultiTouch = false;

  // Named (not anonymous) so detach() can remove them — the canvas element
  // outlives the chart, and unremovable handlers stack up on every chart
  // recreation (New Case), with stale closures throwing on double-tap.
  function handleMultiTouchGuard(e) {
    if (e.touches.length >= 2) wasMultiTouch = true;
  }
  function handleDblClick() {
    recenter();
  }
  canvas.addEventListener('touchstart', handleMultiTouchGuard, { passive: true });
  canvas.addEventListener('dblclick', handleDblClick);

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

  // ── Inspect-cursor handle drag ──────────────────────────────────────────
  // Only fires when the touch / click starts inside the handle's hit region
  // (published on `s._inspectHandleHit` by the inspectHandle plugin). Uses
  // capture phase so Chart.js's internal gesture listeners never see the
  // event and pan / zoom on the rest of the chart stay intact.

  let inspectDragActive = false;

  // Helpers to temporarily disable Chart.js pan while the user is dragging
  // the handle. Capture-phase listeners alone aren't enough on iPad — hammerjs
  // pan tracking sometimes survives `stopImmediatePropagation` depending on
  // the recognizer state. Flipping `pan.enabled` at the source of the gesture
  // guarantees hammer refuses to pan while the inspect drag owns the touch.
  function disablePan() {
    try {
      if (chart.options.plugins?.zoom?.pan?.enabled !== undefined) {
        chart.options.plugins.zoom.pan.enabled = false;
      }
    } catch (e) { /* ignore */ }
  }
  function restorePan() {
    try {
      if (chart.options.plugins?.zoom?.pan?.enabled !== undefined) {
        chart.options.plugins.zoom.pan.enabled = true;
      }
    } catch (e) { /* ignore */ }
  }

  function isOnHandle(clientX, clientY) {
    const h = s._inspectHandleHit;
    if (!h) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return x >= h.left && x <= h.right && y >= h.top && y <= h.bottom;
  }

  function xToTime(clientX) {
    const xScl = chart.scales.x;
    const ca = chart.chartArea;
    if (!xScl || !ca) return null;
    const rect = canvas.getBoundingClientRect();
    const raw = clientX - rect.left;
    const clamped = Math.max(ca.left, Math.min(ca.right, raw));
    const t = xScl.getValueForPixel(clamped);
    return Number.isFinite(t) && t >= 0 ? t : null;
  }

  function handleInspectTouchStart(e) {
    if (!setInspectTime) return;
    if (e.touches.length !== 1) return;
    const t0 = e.touches[0];
    if (!isOnHandle(t0.clientX, t0.clientY)) return;
    inspectDragActive = true;
    disablePan();
    const t = xToTime(t0.clientX);
    if (t != null) setInspectTime(t);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handleInspectTouchMove(e) {
    if (!inspectDragActive) return;
    if (e.touches.length !== 1) { inspectDragActive = false; restorePan(); return; }
    const t = xToTime(e.touches[0].clientX);
    if (t != null) setInspectTime(t);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handleInspectTouchEnd(e) {
    if (!inspectDragActive) return;
    inspectDragActive = false;
    restorePan();
    // Swallow the terminating touchend so Chart.js doesn't synthesize a click
    // that would re-fire onClick and snap the cursor to the release point.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function handleInspectMouseDown(e) {
    if (!setInspectTime) return;
    if (e.button !== 0) return;
    if (!isOnHandle(e.clientX, e.clientY)) return;
    inspectDragActive = true;
    disablePan();
    const t = xToTime(e.clientX);
    if (t != null) setInspectTime(t);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handleInspectMouseMove(e) {
    if (!inspectDragActive) return;
    const t = xToTime(e.clientX);
    if (t != null) setInspectTime(t);
  }
  function handleInspectMouseUp() {
    if (!inspectDragActive) return;
    inspectDragActive = false;
    restorePan();
  }

  // ── Plan-handle drag (vertical) ─────────────────────────────────────────
  // Planning mode's retitrate handle. Same capture-phase / pan-disable
  // machinery as the inspect handle above, but reading Y instead of X: the
  // handle's pixel position maps back to a concentration, and planning.js
  // back-solves the dose that reaches it. Hit region is published by the
  // planHandle plugin on `s._planHandleHit`.

  let planDragActive = false;

  function isOnPlanHandle(clientX, clientY) {
    const h = s._planHandleHit;
    if (!h) return false;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return x >= h.left && x <= h.right && y >= h.top && y <= h.bottom;
  }

  function yToCe(clientY) {
    const yScl = chart.scales.y;
    const ca = chart.chartArea;
    if (!yScl || !ca) return null;
    const rect = canvas.getBoundingClientRect();
    const raw = clientY - rect.top;
    const clamped = Math.max(ca.top, Math.min(ca.bottom, raw));
    const ce = yScl.getValueForPixel(clamped);
    return Number.isFinite(ce) && ce >= 0 ? ce : null;
  }

  function reportPlanDrag(clientY) {
    const fn = s._onPlanDrag;
    if (!fn) return;
    const ce = yToCe(clientY);
    if (ce != null) fn(ce);
  }

  // The y-axis autoscale is frozen for the duration of a drag. Without it the
  // proposal's own curve would grow the axis on every frame and slide out from
  // under the finger that is dragging it.
  function beginPlanDrag() {
    planDragActive = true;
    s._planDragging = true;
    disablePan();
  }
  function endPlanDrag() {
    planDragActive = false;
    s._planDragging = false;
    restorePan();
    if (typeof s._onPlanDragEnd === 'function') s._onPlanDragEnd();
  }

  function handlePlanTouchStart(e) {
    if (!s._onPlanDrag) return;
    if (e.touches.length !== 1) return;
    if (!isOnPlanHandle(e.touches[0].clientX, e.touches[0].clientY)) return;
    beginPlanDrag();
    reportPlanDrag(e.touches[0].clientY);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handlePlanTouchMove(e) {
    if (!planDragActive) return;
    if (e.touches.length !== 1) { endPlanDrag(); return; }
    reportPlanDrag(e.touches[0].clientY);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handlePlanTouchEnd(e) {
    if (!planDragActive) return;
    endPlanDrag();
    // Swallow the terminating touchend, as the inspect handle does, so
    // Chart.js can't synthesize a click out of the release.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function handlePlanMouseDown(e) {
    if (!s._onPlanDrag) return;
    if (e.button !== 0) return;
    if (!isOnPlanHandle(e.clientX, e.clientY)) return;
    beginPlanDrag();
    reportPlanDrag(e.clientY);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function handlePlanMouseMove(e) {
    if (!planDragActive) return;
    reportPlanDrag(e.clientY);
  }
  function handlePlanMouseUp() {
    if (!planDragActive) return;
    endPlanDrag();
  }

  // Capture phase on the canvas PARENT so our listener fires during the actual
  // ancestor-capture phase — before any target-phase listeners on the canvas
  // itself (including Chart.js / hammerjs). On the target element, all
  // listeners fire in registration order regardless of useCapture, so binding
  // capture:true directly on canvas would still run AFTER Chart.js's
  // earlier-registered hammer listeners. Binding on the parent dodges that.
  const captureTarget = canvas.parentElement || canvas;
  // Plan handle binds FIRST. Both handles stopImmediatePropagation on a hit,
  // and on the same element listeners run in registration order — so if the
  // proposal's handle happens to land on top of the inspect handle near the
  // bottom of the plot, retitrating wins. That's the right precedence: the
  // handle only exists at all while the user is actively planning a dose.
  captureTarget.addEventListener('touchstart', handlePlanTouchStart, { passive: false, capture: true });
  captureTarget.addEventListener('touchmove',  handlePlanTouchMove,  { passive: false, capture: true });
  captureTarget.addEventListener('touchend',   handlePlanTouchEnd,   { capture: true });
  captureTarget.addEventListener('touchcancel', handlePlanTouchEnd,  { capture: true });
  captureTarget.addEventListener('mousedown',  handlePlanMouseDown,  { capture: true });
  window.addEventListener('mousemove', handlePlanMouseMove);
  window.addEventListener('mouseup',   handlePlanMouseUp);

  captureTarget.addEventListener('touchstart', handleInspectTouchStart, { passive: false, capture: true });
  captureTarget.addEventListener('touchmove',  handleInspectTouchMove,  { passive: false, capture: true });
  captureTarget.addEventListener('touchend',   handleInspectTouchEnd,   { capture: true });
  captureTarget.addEventListener('touchcancel', handleInspectTouchEnd,  { capture: true });
  captureTarget.addEventListener('mousedown',  handleInspectMouseDown,  { capture: true });
  // Mouse move/up bind on window so the drag tracks when the pointer
  // briefly leaves the canvas (normal web drag-handle pattern).
  window.addEventListener('mousemove', handleInspectMouseMove);
  window.addEventListener('mouseup',   handleInspectMouseUp);

  return function detach() {
    canvas.removeEventListener('touchstart', handleYTouchStart);
    canvas.removeEventListener('touchmove', handleYTouchMove);
    canvas.removeEventListener('touchend', handleYTouchEnd);
    canvas.removeEventListener('touchend', handleTouchEnd);
    canvas.removeEventListener('touchstart', handleMultiTouchGuard);
    canvas.removeEventListener('dblclick', handleDblClick);
    captureTarget.removeEventListener('touchstart', handleInspectTouchStart, { capture: true });
    captureTarget.removeEventListener('touchmove',  handleInspectTouchMove,  { capture: true });
    captureTarget.removeEventListener('touchend',   handleInspectTouchEnd,   { capture: true });
    captureTarget.removeEventListener('touchcancel', handleInspectTouchEnd,  { capture: true });
    captureTarget.removeEventListener('mousedown',  handleInspectMouseDown,  { capture: true });
    window.removeEventListener('mousemove', handleInspectMouseMove);
    window.removeEventListener('mouseup',   handleInspectMouseUp);
    captureTarget.removeEventListener('touchstart', handlePlanTouchStart, { capture: true });
    captureTarget.removeEventListener('touchmove',  handlePlanTouchMove,  { capture: true });
    captureTarget.removeEventListener('touchend',   handlePlanTouchEnd,   { capture: true });
    captureTarget.removeEventListener('touchcancel', handlePlanTouchEnd,  { capture: true });
    captureTarget.removeEventListener('mousedown',  handlePlanMouseDown,  { capture: true });
    window.removeEventListener('mousemove', handlePlanMouseMove);
    window.removeEventListener('mouseup',   handlePlanMouseUp);
  };
}
