// Small linear-algebra + ridge-regression core.
// The gaze model maps a feature vector (from MediaPipe landmarks) to a screen
// coordinate. We fit it per-participant in the browser after calibration using
// closed-form ridge regression: w = (XᵀX + λI)⁻¹ Xᵀy.  Dimensions are tiny
// (~16 features, a few hundred-thousand samples), so this is instant.

export function transpose(A) {
  const r = A.length, c = A[0].length;
  const T = Array.from({ length: c }, () => new Float64Array(r));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = A[i][j];
  return T;
}

export function matmul(A, B) {
  const r = A.length, n = B.length, c = B[0].length;
  const C = Array.from({ length: r }, () => new Float64Array(c));
  for (let i = 0; i < r; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      const Bk = B[k];
      for (let j = 0; j < c; j++) C[i][j] += a * Bk[j];
    }
  }
  return C;
}

export function matvec(A, v) {
  const r = A.length, c = v.length;
  const out = new Float64Array(r);
  for (let i = 0; i < r; i++) {
    let s = 0;
    const Ai = A[i];
    for (let j = 0; j < c; j++) s += Ai[j] * v[j];
    out[i] = s;
  }
  return out;
}

// Solve A x = b for a square A via Gaussian elimination with partial pivoting.
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) r[j] = row[j];
    r[n] = b[i];
    return r;
  });
  for (let col = 0; col < n; col++) {
    // pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue; // singular-ish; ridge λ should prevent this
    [M[col], M[piv]] = [M[piv], M[col]];
    const pivVal = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pivVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n];
  return x;
}

// Standardize features to zero mean / unit variance — keeps ridge well-conditioned.
export class Standardizer {
  fit(X) {
    const n = X.length, d = X[0].length;
    this.mean = new Float64Array(d);
    this.std = new Float64Array(d);
    for (const row of X) for (let j = 0; j < d; j++) this.mean[j] += row[j];
    for (let j = 0; j < d; j++) this.mean[j] /= n;
    for (const row of X) for (let j = 0; j < d; j++) {
      const dv = row[j] - this.mean[j];
      this.std[j] += dv * dv;
    }
    // Floor the std: a near-constant feature (e.g. face distance when the head is
    // still) otherwise gets divided by ~0 and amplified into noise the model overfits.
    for (let j = 0; j < d; j++) {
      const s = Math.sqrt(this.std[j] / Math.max(1, n));
      this.std[j] = Math.max(s, 1e-2);
    }
    return this;
  }
  row(x) {
    const out = new Float64Array(x.length);
    for (let j = 0; j < x.length; j++) out[j] = (x[j] - this.mean[j]) / this.std[j];
    return out;
  }
  matrix(X) { return X.map(r => this.row(r)); }
}

// Fit ridge regression. X: array of feature rows (already standardized, bias appended).
export function fitRidge(X, y, lambda) {
  const Xt = transpose(X);
  const XtX = matmul(Xt, X);
  for (let i = 0; i < XtX.length; i++) XtX[i][i] += lambda;
  const Xty = matvec(Xt, y);
  return solve(XtX, Xty);
}

export function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

// Two-output ridge model (screen x and screen y) with internal standardization.
export class GazeRegressor {
  constructor(lambda = 1.0) { this.lambda = lambda; this.ready = false; }

  fit(features, targetsX, targetsY) {
    this.scaler = new Standardizer().fit(features);
    const Xs = this.scaler.matrix(features).map(r => withBias(r));
    this.wx = fitRidge(Xs, Float64Array.from(targetsX), this.lambda);
    this.wy = fitRidge(Xs, Float64Array.from(targetsY), this.lambda);
    this.ready = true;
    return this;
  }

  predict(feature) {
    if (!this.ready) return null;
    const xs = withBias(this.scaler.row(feature));
    return { x: dot(this.wx, xs), y: dot(this.wy, xs) };
  }
}

function withBias(row) {
  const out = new Float64Array(row.length + 1);
  out.set(row, 0);
  out[row.length] = 1; // bias term
  return out;
}
