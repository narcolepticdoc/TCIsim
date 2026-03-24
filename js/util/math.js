/**
 * math.js — Linear algebra utilities for PK engine
 * 
 * Provides matrix exponential (Padé approximation) and supporting
 * matrix operations for exact ODE solutions in the 3-compartment
 * + effect-site model.
 * 
 * All matrices are represented as flat Float64Arrays in row-major order
 * for performance. Size is always 4×4 for our use case.
 */

const N = 4; // 4×4 system: [A1, A2, A3, Ce]

/**
 * Create a new 4×4 zero matrix
 */
export function mat4() {
  return new Float64Array(16);
}

/**
 * Create a 4×4 identity matrix
 */
export function eye4() {
  const m = mat4();
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/**
 * Matrix multiply C = A × B (both 4×4, row-major)
 */
export function mul4(A, B) {
  const C = mat4();
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += A[i * N + k] * B[k * N + j];
      }
      C[i * N + j] = sum;
    }
  }
  return C;
}

/**
 * Matrix-vector multiply y = A × x (A is 4×4, x is length-4)
 */
export function mulVec4(A, x) {
  const y = new Float64Array(4);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = 0; j < N; j++) {
      sum += A[i * N + j] * x[j];
    }
    y[i] = sum;
  }
  return y;
}

/**
 * Add two 4×4 matrices: C = A + B
 */
export function add4(A, B) {
  const C = mat4();
  for (let i = 0; i < 16; i++) C[i] = A[i] + B[i];
  return C;
}

/**
 * Subtract two 4×4 matrices: C = A - B
 */
export function sub4(A, B) {
  const C = mat4();
  for (let i = 0; i < 16; i++) C[i] = A[i] - B[i];
  return C;
}

/**
 * Scale a 4×4 matrix: B = s × A
 */
export function scale4(A, s) {
  const B = mat4();
  for (let i = 0; i < 16; i++) B[i] = A[i] * s;
  return B;
}

/**
 * 1-norm of a 4×4 matrix (maximum absolute column sum)
 */
function norm1(A) {
  let maxCol = 0;
  for (let j = 0; j < N; j++) {
    let colSum = 0;
    for (let i = 0; i < N; i++) {
      colSum += Math.abs(A[i * N + j]);
    }
    if (colSum > maxCol) maxCol = colSum;
  }
  return maxCol;
}

/**
 * Invert a 4×4 matrix using Gauss-Jordan elimination.
 * Returns null if singular.
 */
export function inv4(M) {
  // Augmented matrix [M | I] stored as 4×8
  const a = new Float64Array(32);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      a[i * 8 + j] = M[i * N + j];
    }
    a[i * 8 + (N + i)] = 1;
  }

  for (let col = 0; col < N; col++) {
    // Partial pivoting
    let maxVal = Math.abs(a[col * 8 + col]);
    let maxRow = col;
    for (let row = col + 1; row < N; row++) {
      const v = Math.abs(a[row * 8 + col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-15) return null; // Singular

    // Swap rows
    if (maxRow !== col) {
      for (let j = 0; j < 8; j++) {
        const tmp = a[col * 8 + j];
        a[col * 8 + j] = a[maxRow * 8 + j];
        a[maxRow * 8 + j] = tmp;
      }
    }

    // Eliminate column
    const pivot = a[col * 8 + col];
    for (let j = 0; j < 8; j++) a[col * 8 + j] /= pivot;

    for (let row = 0; row < N; row++) {
      if (row === col) continue;
      const factor = a[row * 8 + col];
      for (let j = 0; j < 8; j++) {
        a[row * 8 + j] -= factor * a[col * 8 + j];
      }
    }
  }

  // Extract inverse
  const inv = mat4();
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      inv[i * N + j] = a[i * 8 + (N + j)];
    }
  }
  return inv;
}

/**
 * Matrix exponential via scaling-and-squaring with Padé(13,13) approximation.
 * 
 * Reference: Higham, "The Scaling and Squaring Method for the Matrix
 * Exponential Revisited", SIAM J. Matrix Anal. Appl., 26(4), 2005.
 * 
 * Simplified for 4×4 matrices — uses Padé order 6 which is sufficient
 * for the magnitudes encountered in PK models (‖A·dt‖ typically < 10).
 * 
 * @param {Float64Array} A - 4×4 matrix in row-major order
 * @returns {Float64Array} expm(A) as 4×4 row-major matrix
 */
export function expm4(A) {
  // Padé(6,6) coefficients
  const b = [
    1,                      // b0
    1 / 2,                  // b1
    1 / 12,                 // b2  (= 1/12)
    1 / 120,                // b3  (= 1/6!)
    1 / 1680,               // b4
    1 / 30240,              // b5
    1 / 665280              // b6  (= 1/13! * ... simplified)
  ];

  // Determine scaling: find s such that ‖A / 2^s‖₁ ≤ 0.5
  const nA = norm1(A);
  let s = 0;
  if (nA > 0.5) {
    s = Math.ceil(Math.log2(nA / 0.5));
    if (s < 0) s = 0;
  }
  const As = (s > 0) ? scale4(A, 1 / (1 << s)) : A;

  // Compute powers of As
  const As2 = mul4(As, As);
  const As4 = mul4(As2, As2);
  const As6 = mul4(As2, As4);

  const I = eye4();

  // U = As · (b6·As6 + b4·As4 + b2·As2 + b0·I)
  // V =      b6·As6 + b5·As4 + ... wait, this is Padé(6,6).
  // 
  // Standard Padé(p,p): R(p,p) = D(p)⁻¹ · N(p)
  // where N(p) = sum_{k=0}^{p} c_k · A^k, D(p) = sum_{k=0}^{p} (-1)^k c_k · A^k
  // c_k = (2p - k)! · p! / ((2p)! · k! · (p-k)!)
  
  // Use Padé(6,6) with proper coefficients:
  // c_k for Padé(6,6):
  const c = [1, 1/2, 5/44, 1/66, 1/792, 1/15840, 1/665280];
  
  // Build N and D directly
  // A^0 = I, A^1 = As, A^2 = As2, A^3 = As·As2, A^4 = As4, A^5 = As·As4, A^6 = As6
  const As3 = mul4(As, As2);
  const As5 = mul4(As, As4);
  
  // N = c0·I + c1·As + c2·As2 + c3·As3 + c4·As4 + c5·As5 + c6·As6
  let Nmat = mat4();
  let Dmat = mat4();
  const powers = [I, As, As2, As3, As4, As5, As6];
  
  for (let k = 0; k <= 6; k++) {
    const sign = (k % 2 === 0) ? 1 : -1;
    for (let i = 0; i < 16; i++) {
      Nmat[i] += c[k] * powers[k][i];
      Dmat[i] += sign * c[k] * powers[k][i];
    }
  }

  // expm(As) ≈ D⁻¹ · N
  const Dinv = inv4(Dmat);
  if (!Dinv) {
    // Fallback: if D is singular (shouldn't happen), return I + A (first-order)
    return add4(I, A);
  }
  let result = mul4(Dinv, Nmat);

  // Squaring phase: expm(A) = (expm(A/2^s))^(2^s)
  for (let i = 0; i < s; i++) {
    result = mul4(result, result);
  }

  return result;
}
