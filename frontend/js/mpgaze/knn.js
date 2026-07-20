// Hybrid gaze model: global ridge + local kNN correction on its residuals.
//
// Ridge alone is linear-in-features and plateaus (~130px training fit) because the
// iris→screen mapping is locally nonlinear. We keep ridge for a smooth, well-behaved
// global estimate, then correct it with a distance-weighted average of the residuals
// of the nearest calibration samples — capturing local structure ridge misses while
// still extrapolating sanely where there are no nearby samples.

import { GazeRegressor, Standardizer } from './ridge.js';

export class HybridGazeModel {
  // kNN runs over dot-level residual prototypes (~20), so k counts DOTS: 4 blends the
  // nearest few dots' systematic errors. `damp` shrinks the correction toward the
  // ridge estimate — residuals are part signal, part head-drift noise, and applying
  // them at full strength overfits (we measured train 72px / val 188px undamped).
  constructor(lambda = 0.4, k = 4, damp = 0.7) {
    this.ridge = new GazeRegressor(lambda);
    this.k = k;
    this.damp = damp;
    this.ready = false;
  }

  fit(features, yx, yy) {
    this.ridge.fit(features, yx, yy);
    this.scaler = new Standardizer().fit(features);

    // Aggregate residuals PER CALIBRATION DOT (samples sharing a target), so the
    // intra-dot jitter/noise averages out and the kNN sees only the systematic
    // local error of the ridge fit. ~20 clean prototypes instead of ~500 noisy ones.
    const groups = new Map();
    for (let i = 0; i < features.length; i++) {
      const key = yx[i].toFixed(4) + ',' + yy[i].toFixed(4);
      if (!groups.has(key)) groups.set(key, { feats: [], rx: 0, ry: 0, n: 0 });
      const g = groups.get(key);
      const p = this.ridge.predict(features[i]);
      g.feats.push(this.scaler.row(features[i]));
      g.rx += yx[i] - p.x;
      g.ry += yy[i] - p.y;
      g.n++;
    }
    this.pts = []; this.resX = []; this.resY = [];
    for (const g of groups.values()) {
      const d = g.feats[0].length;
      const mean = new Float64Array(d);
      for (const f of g.feats) for (let j = 0; j < d; j++) mean[j] += f[j];
      for (let j = 0; j < d; j++) mean[j] /= g.feats.length;
      this.pts.push(mean);
      this.resX.push(g.rx / g.n);
      this.resY.push(g.ry / g.n);
    }
    this.ready = true;
    return this;
  }

  predict(feature) {
    if (!this.ready) return null;
    const base = this.ridge.predict(feature);
    const q = this.scaler.row(feature);
    const n = this.pts.length;
    // distances to every calibration sample (cheap: ~500 × 21 dims)
    const dists = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; const r = this.pts[i];
      for (let j = 0; j < q.length; j++) { const d = q[j] - r[j]; s += d * d; }
      dists[i] = [s, i];
    }
    dists.sort((a, b) => a[0] - b[0]);
    const kk = Math.min(this.k, n);
    // adaptive bandwidth = mean of the k nearest squared distances (auto-scales)
    let band = 0;
    for (let m = 0; m < kk; m++) band += dists[m][0];
    band = (band / kk) || 1e-6;
    let wsum = 0, rx = 0, ry = 0;
    for (let m = 0; m < kk; m++) {
      const [d2, i] = dists[m];
      const w = Math.exp(-d2 / (2 * band));
      wsum += w; rx += w * this.resX[i]; ry += w * this.resY[i];
    }
    if (wsum > 0) { rx /= wsum; ry /= wsum; }
    return { x: base.x + this.damp * rx, y: base.y + this.damp * ry };
  }
}
