/**
 * test-util-math.mjs — js/util/math.js (4×4 linear algebra) + js/util/color.js.
 *
 * math.js is the numerical core the PK engine is built on (inv4 + expm4 back
 * the matrix-exponential advance). The engine's end-to-end matrix-exp is
 * validated at 0.0000% vs the analytical eigenvalue solution in test-vs-simtiva;
 * this file pins the primitives directly against INDEPENDENT closed-form facts
 * (diagonal exp = elementwise exp, nilpotent exp = I + N, A·A⁻¹ = I) so a bug
 * in the algebra layer is caught at the source, not just in aggregate.
 *
 * color.js backs drug-keyed chart tints; small pure hex/alpha helpers.
 */

import { mat4, eye4, mul4, mulVec4, add4, sub4, scale4, inv4, expm4 } from '../js/util/math.js';
import { lighten, hexToRgba, alphaToHex } from '../js/util/color.js';

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function matNear(A, B, tol, m) {
  let mx = 0;
  for (let i = 0; i < 16; i++) mx = Math.max(mx, Math.abs(A[i] - B[i]));
  ok(mx < tol, `${m} (max diff ${mx.toExponential(2)})`);
}
const diag = (a, b, c, d) => { const M = mat4(); M[0] = a; M[5] = b; M[10] = c; M[15] = d; return M; };

console.log('\n=== math.js — 4×4 linear algebra ===\n');

// ── Constructors ────────────────────────────────────────────────────────────
{
  const z = mat4();
  ok(z.length === 16 && z.every(v => v === 0), 'mat4() is a 16-element zero matrix');
  const I = eye4();
  ok(I[0] === 1 && I[5] === 1 && I[10] === 1 && I[15] === 1, 'eye4() has unit diagonal');
  ok(I[1] === 0 && I[4] === 0 && I[14] === 0, 'eye4() off-diagonal is zero');
}

// ── mul4 / mulVec4 ──────────────────────────────────────────────────────────
{
  const I = eye4();
  const A = diag(2, 3, 4, 5);
  matNear(mul4(I, A), A, 1e-12, 'mul4(I, A) = A');
  matNear(mul4(A, I), A, 1e-12, 'mul4(A, I) = A');
  matNear(mul4(A, A), diag(4, 9, 16, 25), 1e-12, 'mul4(diag, diag) multiplies diagonals');

  // Non-diagonal product spot-check: row·column.
  const B = new Float64Array([1, 2, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]);
  const C = mul4(B, B); // [[1,4,..],[0,1,..],..]  since B is I + strictly-upper
  ok(C[1] === 4 && C[0] === 1 && C[5] === 1, 'mul4 upper-triangular product correct (C[0,1]=4)');

  const y = mulVec4(diag(2, 3, 4, 5), new Float64Array([1, 1, 1, 1]));
  ok(y[0] === 2 && y[1] === 3 && y[2] === 4 && y[3] === 5, 'mulVec4(diag, ones) = diagonal');
}

// ── add4 / sub4 / scale4 ────────────────────────────────────────────────────
{
  const A = diag(1, 2, 3, 4), B = diag(4, 3, 2, 1);
  matNear(add4(A, B), diag(5, 5, 5, 5), 1e-12, 'add4');
  matNear(sub4(A, B), diag(-3, -1, 1, 3), 1e-12, 'sub4');
  matNear(scale4(A, 2), diag(2, 4, 6, 8), 1e-12, 'scale4');
}

// ── inv4 ────────────────────────────────────────────────────────────────────
{
  matNear(inv4(eye4()), eye4(), 1e-12, 'inv4(I) = I');
  matNear(inv4(diag(2, 4, 5, 8)), diag(0.5, 0.25, 0.2, 0.125), 1e-12, 'inv4(diag) inverts each diagonal');

  // Dense invertible matrix: A·A⁻¹ = I.
  const A = new Float64Array([4, 1, 0, 2,  0, 3, 1, 0,  1, 0, 2, 1,  0, 1, 0, 3]);
  const Ai = inv4(A);
  ok(Ai !== null, 'inv4 of a dense invertible matrix is non-null');
  matNear(mul4(A, Ai), eye4(), 1e-9, 'A · inv4(A) = I');

  // Singular matrix (row of zeros) → null.
  const S = new Float64Array([1, 2, 3, 4,  0, 0, 0, 0,  1, 0, 1, 0,  0, 1, 0, 1]);
  ok(inv4(S) === null, 'inv4 of a singular matrix returns null');
}

// ── expm4 — against independent closed forms ────────────────────────────────
{
  matNear(expm4(mat4()), eye4(), 1e-12, 'expm4(0) = I');

  // Diagonal: exp is elementwise on the diagonal.
  const D = diag(0, 1, -1, 2);
  matNear(expm4(D), diag(Math.exp(0), Math.exp(1), Math.exp(-1), Math.exp(2)), 1e-9,
    'expm4(diag) = diag(exp) — small norm');

  // Large-norm diagonal exercises the scaling-and-squaring branch.
  const DL = diag(6, -6, 3, 0);
  matNear(expm4(DL), diag(Math.exp(6), Math.exp(-6), Math.exp(3), 1), 1e-4,
    'expm4(diag) correct through scaling-squaring (‖A‖ large)');

  // Nilpotent N (N² = 0) ⇒ expm(N) = I + N exactly.
  const N = new Float64Array([0, 1, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0]);
  ok(mul4(N, N).every(v => v === 0), 'test nilpotent has N² = 0');
  matNear(expm4(N), add4(eye4(), N), 1e-12, 'expm4(nilpotent) = I + N');

  // Group property: expm(A)·expm(−A) = I for a general small matrix.
  const A = new Float64Array([0.1, 0.2, 0, 0,  -0.1, 0.05, 0.1, 0,  0, 0.2, -0.2, 0.1,  0, 0, 0.1, -0.05]);
  matNear(mul4(expm4(A), expm4(scale4(A, -1))), eye4(), 1e-9, 'expm4(A) · expm4(−A) = I');
}

console.log('\n=== color.js — hex / alpha helpers ===\n');

{
  ok(hexToRgba('#ff0000', 1) === 'rgba(255,0,0,1)', "hexToRgba('#ff0000',1) = rgba(255,0,0,1)");
  ok(hexToRgba('#00ff80', 0.5) === 'rgba(0,255,128,0.5)', 'hexToRgba mid-channel + alpha');
  ok(hexToRgba('#abc', 1) === 'rgba(170,187,204,1)', 'hexToRgba expands 3-digit hex');
  ok(hexToRgba('#000000', 5) === 'rgba(0,0,0,1)', 'hexToRgba clamps alpha > 1 to 1');
  ok(hexToRgba('#000000', -1) === 'rgba(0,0,0,0)', 'hexToRgba clamps alpha < 0 to 0');

  ok(alphaToHex(1) === 'ff', 'alphaToHex(1) = ff');
  ok(alphaToHex(0) === '00', 'alphaToHex(0) = 00');
  ok(alphaToHex(0.5) === '80', 'alphaToHex(0.5) = 80 (round 127.5→128)');
  ok(alphaToHex(5) === 'ff', 'alphaToHex clamps > 1');
  ok(alphaToHex(-3) === '00', 'alphaToHex clamps < 0');

  // lighten raises luminance and stays a valid #rrggbb.
  const lit = lighten('#808080', 0.25);
  ok(/^#[0-9a-f]{6}$/.test(lit), `lighten returns a #rrggbb (${lit})`);
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255); };
  ok(lum(lit) > lum('#808080'), 'lighten raises overall luminance');
  ok(lighten('#000000', 0.5) !== '#000000', 'lighten pulls pure black off the floor');
  ok(lighten('#ffffff', 0.25) === '#ffffff', 'lighten of white stays white (L clamps at 1)');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
