/**
 * shapes.js — Canvas drawing primitives for chart event markers.
 *
 * Pure drawing helpers — no state dependencies.
 */

export function drawOctagon(ctx, cx, cy, r, fill) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + k * Math.PI / 4;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

export function drawTriangle(ctx, cx, cy, r, dir, fill) {
  const h = r * 1.1;
  ctx.beginPath();
  if (dir === 'up') {
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx - h, cy + h * 0.7);
    ctx.lineTo(cx + h, cy + h * 0.7);
  } else if (dir === 'down') {
    ctx.moveTo(cx, cy + h);
    ctx.lineTo(cx - h, cy - h * 0.7);
    ctx.lineTo(cx + h, cy - h * 0.7);
  } else {
    ctx.moveTo(cx + h, cy);
    ctx.lineTo(cx - h * 0.7, cy - h);
    ctx.lineTo(cx - h * 0.7, cy + h);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

export function drawDoubleUpArrow(ctx, cx, cy, r, fill) {
  const w = r * 1.1;
  const h = r * 0.75;
  const gap = r * 0.25;
  ctx.fillStyle = fill;

  ctx.beginPath();
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx - w, cy + gap + h);
  ctx.lineTo(cx + w, cy + gap + h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy - gap - h);
  ctx.lineTo(cx - w, cy - gap);
  ctx.lineTo(cx + w, cy - gap);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
