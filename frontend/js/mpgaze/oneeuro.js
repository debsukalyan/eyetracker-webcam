// One Euro filter (Casiez et al.) — adaptive low-pass that gives low jitter when
// the gaze is still and low lag when it moves. Far better than a fixed median for
// gaze smoothing (PRD §7 "Kalman/One Euro filter; keep both raw and smoothed").

class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y == null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
}

export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilt = new LowPass();
    this.dxFilt = new LowPass();
    this.lastTime = null;
    this.lastX = null;
  }
  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, tMs) {
    if (this.lastTime == null) { this.lastTime = tMs; this.lastX = x; this.xFilt.filter(x, 1); return x; }
    let dt = (tMs - this.lastTime) / 1000;
    if (dt <= 0) dt = 1 / 30;
    this.lastTime = tMs;
    const dx = (x - this.lastX) / dt;
    this.lastX = x;
    const edx = this.dxFilt.filter(dx, this._alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilt.filter(x, this._alpha(cutoff, dt));
  }
}

// Convenience: smooth a 2D point stream.
export class OneEuro2D {
  constructor(opts) { this.fx = new OneEuro(opts); this.fy = new OneEuro(opts); }
  filter(p, tMs) { return { x: this.fx.filter(p.x, tMs), y: this.fy.filter(p.y, tMs) }; }
}
