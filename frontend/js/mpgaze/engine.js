// MediaPipe gaze engine. Implements the same surface as the platform's GazeEngine
// (start / addCalibrationSample / predict / getQuality / faceDetected / onGaze) so it
// can replace the WebGazer engine once accuracy is validated.
//
// Pipeline:  camera → FaceLandmarker (478 + iris) → per-eye features → EYE-MODE
// selection (both/right/left — handles strabismus) → per-participant ridge+kNN model
// (trained after calibration) → One Euro smoothing → screen gaze.

import { FaceMeshTracker } from './facemesh.js';
import { extractFeatures, buildFeature } from './features.js';
import { HybridGazeModel } from './knn.js';
import { OneEuro2D } from './oneeuro.js';

export class MediaPipeGazeEngine {
  constructor({ lambda = 1.0 } = {}) {
    this.name = 'mediapipe';
    this.tracker = new FaceMeshTracker();
    this.regressor = new HybridGazeModel(lambda);
    this.smoother = new OneEuro2D({ minCutoff: 0.8, beta: 0.012 });
    this.calib = [];           // {raw, nx, ny}
    this.latestFeat = null;    // {raw, feature, ear, eyesOpen, faceScale}
    this.lastGaze = null;      // {x, y} px (smoothed)
    this.lastRaw = null;       // {x, y} px (unsmoothed)
    this._onGaze = null;
    this.facePresent = false;
    this.eyeMode = 'both';     // 'both' | 'right' | 'left' — auto-selected at train()
    this.eyeModeErrors = null; // px error per candidate mode, for QA
    this.headBaseline = null;  // {cx, cy, scale} face position captured at calibration
  }

  onGaze(cb) { this._onGaze = cb; }

  async start(videoEl, onStatus = () => {}, deviceId = null) {
    await this.tracker.init(onStatus);
    this.tracker.onFrame(({ landmarks, t }) => this._frame(landmarks, t));
    await this.tracker.startCamera(videoEl, deviceId);
    return true;
  }

  // Camera management (multi-camera machines; broken defaults).
  async listCameras() { return (await import('./facemesh.js')).FaceMeshTracker.listCameras(); }
  async switchCamera(deviceId) { return this.tracker.switchCamera(deviceId); }
  activeCamera() { return { deviceId: this.tracker.activeDeviceId, label: this.tracker.activeLabel }; }

  _frame(landmarks, t) {
    if (!landmarks) {
      this.facePresent = false;
      this.latestFeat = null;
      if (this._onGaze) this._onGaze({ x: null, y: null, facePresent: false, confidence: 0, fps: this.tracker.fps(), t });
      return;
    }
    this.facePresent = true;
    const f = extractFeatures(landmarks);
    this.latestFeat = f;
    if (f && this.regressor.ready) {
      // Off-screen gaze detection: eyes outside the calibrated range (looking at the
      // keyboard/phone) must NOT be mapped onto the screen. But the gate must be able
      // to SELF-HEAL: after a posture change (leave & return), the eye geometry can sit
      // permanently outside the old range — blocking forever would brick the session
      // (measured: no gaze at all after a participant returned to the camera).
      if (this.gazeRange) {
        const c = this._composite(f.raw);
        const r = this.gazeRange;
        const out = c.gx < r.gxLo || c.gx > r.gxHi || c.gy < r.gyLo || c.gy > r.gyHi;
        if (out) {
          if (!this._outSince) this._outSince = t;
          if (t - this._outSince > 2500) {
            // Persistently out with a tracked face → range is stale. Widen the violated
            // bounds to re-admit current gaze (keyboard glances are transient and never
            // reach this branch).
            const padX = (r.gxHi - r.gxLo) * 0.1, padY = (r.gyHi - r.gyLo) * 0.1;
            if (c.gx < r.gxLo) r.gxLo = c.gx - padX;
            if (c.gx > r.gxHi) r.gxHi = c.gx + padX;
            if (c.gy < r.gyLo) r.gyLo = c.gy - padY;
            if (c.gy > r.gyHi) r.gyHi = c.gy + padY;
            this._outSince = null;
          } else {
            this.lastRaw = null;
            this.lastGaze = null;
            if (this._onGaze) this._onGaze({ x: null, y: null, facePresent: true,
              confidence: 0, fps: this.tracker.fps(), t });
            return;
          }
        } else {
          this._outSince = null;
        }
      }
      const norm = this.regressor.predict(buildFeature(f.raw, this.eyeMode)); // normalized [0,1]
      const rawPx = { x: norm.x * window.innerWidth, y: norm.y * window.innerHeight };
      this.lastRaw = rawPx;
      this.lastGaze = this.smoother.filter(rawPx, t);
      const conf = f.eyesOpen ? 1 : 0.3;
      if (this._onGaze) this._onGaze({
        x: this.lastGaze.x, y: this.lastGaze.y, facePresent: true,
        confidence: conf, fps: this.tracker.fps(), t,
      });
    } else if (this._onGaze) {
      this._onGaze({ x: null, y: null, facePresent: true, confidence: 0, fps: this.tracker.fps(), t });
    }
  }

  // --- calibration ---------------------------------------------------------
  // Record the CURRENT frame's raw eye components labelled with a screen target.
  addCalibrationSample(targetXpx, targetYpx) {
    const f = this.latestFeat;
    if (!f || !f.eyesOpen) return false;
    this.calib.push({
      raw: { ...f.raw },
      nx: targetXpx / window.innerWidth,
      ny: targetYpx / window.innerHeight,
    });
    return true;
  }

  calibrationCount() { return this.calib.length; }

  // Fit candidate models for each eye mode, score them on an interleaved held-out
  // quarter of the calibration data, and keep the winner. This is what makes the
  // engine work for strabismus: a deviated eye's iris misreports gaze, and the
  // both-eyes average inherits that error — the good eye alone scores far better.
  train(opts = {}) {
    if (this.calib.length < 20) return false;
    const clean = this._trimOutliers(this.calib);
    // Mid-session refresh: keep the already-selected eye mode (re-competing modes on a
    // few fresh samples mid-study could flip the mapping under the participant).
    const modes = opts.keepEyeMode && this.eyeModeErrors ? [this.eyeMode] : ['both', 'right', 'left'];
    let best = null;
    const scores = {};
    for (const mode of modes) {
      const X = clean.map(c => buildFeature(c.raw, mode));
      const yx = clean.map(c => c.nx);
      const yy = clean.map(c => c.ny);
      // interleaved 75/25 split: every 4th sample is held out (spreads dots + time)
      const trX = [], trYx = [], trYy = [], teX = [], teYx = [], teYy = [];
      for (let i = 0; i < X.length; i++) {
        if (i % 4 === 3) { teX.push(X[i]); teYx.push(yx[i]); teYy.push(yy[i]); }
        else { trX.push(X[i]); trYx.push(yx[i]); trYy.push(yy[i]); }
      }
      if (trX.length < 15 || teX.length < 5) continue;
      const m = new HybridGazeModel(this.regressor.ridge ? this.regressor.ridge.lambda : 0.4);
      try { m.fit(trX, trYx, trYy); } catch (e) { continue; }
      let err = 0;
      for (let i = 0; i < teX.length; i++) {
        const p = m.predict(teX[i]);
        err += Math.hypot((p.x - teYx[i]) * window.innerWidth, (p.y - teYy[i]) * window.innerHeight);
      }
      err /= teX.length;
      scores[mode] = Math.round(err);
      if (!best || err < best.err) best = { mode, err };
    }
    if (!best) return false;
    this.eyeMode = best.mode;
    this.eyeModeErrors = scores;
    // Final model: winning mode, ALL cleaned samples.
    const X = clean.map(c => buildFeature(c.raw, this.eyeMode));
    this.regressor.fit(X, clean.map(c => c.nx), clean.map(c => c.ny));
    this.smoother = new OneEuro2D({ minCutoff: 0.8, beta: 0.012 });
    // Head-position baseline (median face position/scale over calibration) for the
    // virtual-chinrest guard.
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    this.headBaseline = {
      cx: med(clean.map(c => c.raw.faceCx)),
      cy: med(clean.map(c => c.raw.faceCy)),
      scale: med(clean.map(c => c.raw.faceScale)),
    };
    // Off-screen gaze detection range. Purpose: catch gaze that is WILDLY outside the
    // screen (keyboard/phone — several screen-heights of eye rotation away), NOT to
    // police borderline frames. The margin must be generous: the vertical eye signal
    // drifts over minutes, and a tight margin (we shipped 30% once) silently discards
    // most genuine on-screen gaze — 87% of a real session was nulled by it.
    const gxs = clean.map(c => this._composite(c.raw).gx);
    const gys = clean.map(c => this._composite(c.raw).gy);
    const gxLo = Math.min(...gxs), gxHi = Math.max(...gxs);
    const gyLo = Math.min(...gys), gyHi = Math.max(...gys);
    const mx = Math.max((gxHi - gxLo) * 0.75, 0.1), my = Math.max((gyHi - gyLo) * 0.75, 0.1);
    this.gazeRange = { gxLo: gxLo - mx, gxHi: gxHi + mx, gyLo: gyLo - my, gyHi: gyHi + my };
    return true;
  }

  _composite(raw) {
    if (this.eyeMode === 'right') return { gx: raw.Rx, gy: raw.Ry };
    if (this.eyeMode === 'left') return { gx: raw.Lx, gy: raw.Ly };
    return { gx: (raw.Lx + raw.Rx) / 2, gy: (raw.Ly + raw.Ry) / 2 };
  }

  // Per-dot outlier trimming: within each calibration dot's samples, drop frames whose
  // core gaze signal (both-eyes gx/gy) deviates >3×MAD from the dot's median —
  // micro-saccades, attention lapses, and re-fixations otherwise become mislabelled
  // training data.
  _trimOutliers(calib) {
    const groups = new Map();
    for (const c of calib) {
      const key = c.nx.toFixed(4) + ',' + c.ny.toFixed(4);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const gxOf = (c) => (c.raw.Lx + c.raw.Rx) / 2;
    const gyOf = (c) => (c.raw.Ly + c.raw.Ry) / 2;
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 6) { out.push(...g); continue; }
      const gxs = g.map(gxOf), gys = g.map(gyOf);
      const mx = med(gxs), my = med(gys);
      const madX = med(gxs.map(v => Math.abs(v - mx))) + 1e-6;
      const madY = med(gys.map(v => Math.abs(v - my))) + 1e-6;
      const kept = g.filter(c =>
        Math.abs(gxOf(c) - mx) <= 3 * madX && Math.abs(gyOf(c) - my) <= 3 * madY);
      // never drop a whole dot — keep at least half
      out.push(...(kept.length >= g.length / 2 ? kept : g));
    }
    return out;
  }

  resetCalibration() {
    this.calib = [];
    this.regressor.ready = false;
    this.eyeMode = 'both';
    this.eyeModeErrors = null;
    this.headBaseline = null;
    this.gazeRange = null;
  }

  // --- head-position guard (virtual chinrest) -------------------------------
  // Deviation of the CURRENT face position/scale from the calibration baseline,
  // normalized so ~0.1 ≈ "moved a head-width's tenth". ok=false → ask to re-center.
  headDeviation() {
    if (!this.headBaseline || !this.latestFeat) return null;
    const r = this.latestFeat.raw;
    const b = this.headBaseline;
    const dx = (r.faceCx - b.cx) / b.scale;      // in face-width units
    const dy = (r.faceCy - b.cy) / b.scale;
    const scaleRatio = r.faceScale / b.scale;    // distance change
    // RECOVERY / between-image threshold. This is the drift RESET: it runs before every
    // image, so making it tight enough to catch the slow forward/down lean people
    // accumulate over a session (measured: scale 1.01→1.04, dy →0.10) means images 2-3
    // restart from the same posture as image 0 (which always tracked well). Asymmetric:
    // vertical (eyelid-based) is ~3× more head-sensitive, and distance (scale) is held
    // tight because leaning in is the dominant drift. Stays tighter than the in-trial
    // trigger (dx 0.24 / dy 0.15 / scale 0.89-1.13) so there's no oscillation.
    const ok = Math.abs(dx) < 0.15 && Math.abs(dy) < 0.08 &&
               scaleRatio > 0.94 && scaleRatio < 1.06;
    return { dx, dy, scaleRatio, ok };
  }

  // --- prediction / quality ------------------------------------------------
  predict() { return this.lastGaze ? { x: this.lastGaze.x, y: this.lastGaze.y } : null; }
  predictRaw() { return this.lastRaw; }

  faceDetected() { return this.facePresent && !!this.latestFeat; }

  getQuality() {
    return {
      facePresent: this.facePresent,
      fps: this.tracker.fps(),
      eyesOpen: this.latestFeat ? this.latestFeat.eyesOpen : false,
      calibrated: this.regressor.ready,
      eyeMode: this.eyeMode,
    };
  }

  // Self error on calibration data (px), a quick fit sanity check.
  trainingError() {
    if (!this.regressor.ready) return null;
    let sum = 0;
    for (const c of this.calib) {
      const p = this.regressor.predict(buildFeature(c.raw, this.eyeMode));
      sum += Math.hypot((p.x - c.nx) * window.innerWidth, (p.y - c.ny) * window.innerHeight);
    }
    return sum / this.calib.length;
  }

  exportDebug() {
    return { engine: this.name, fps: this.tracker.fps(), calibSamples: this.calib.length,
             calibrated: this.regressor.ready, eyeMode: this.eyeMode,
             eyeModeErrors: this.eyeModeErrors };
  }

  stop() { this.tracker.stop(); }
}
