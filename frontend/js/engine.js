// Gaze engine abstraction (PRD sections 6, 7, 17).
//
// The study runtime talks ONLY to this interface, never to WebGazer directly:
//   start(), stop(), calibrate(point), validate(point), predict(),
//   getQuality(), exportDebug()
//
// This lets us swap in a MediaPipe/custom regression engine later (Route B/C)
// without touching the participant runtime. WebGazerEngine is the concrete
// MVP implementation (Route A).

class GazeEngine {
  constructor() { this.name = 'base'; this._onGaze = null; }
  onGaze(cb) { this._onGaze = cb; }
  async start() { throw new Error('not implemented'); }
  stop() {}
  addCalibrationSample(x, y) {}      // associate current eye features with screen (x,y)
  predict() { return null; }          // -> {x, y} viewport px, or null
  getQuality() { return { facePresent: false, fps: 0 }; }
  exportDebug() { return {}; }

  // --- optional session (webcam) recording, shared by all engines ----------
  // Records from this.video's stream (set by MediaPipeEngine). WebGazer overrides
  // these to use its own feed element. Previously ONLY WebGazer had these, so a
  // MediaPipe study with recording enabled threw "startRecording is not a function"
  // on Begin study and stranded the participant — this base impl prevents that.
  startRecording() {
    try {
      if (typeof MediaRecorder === 'undefined') return false;
      const stream = this.video && this.video.srcObject;
      if (!stream) return false;
      this._chunks = [];
      const prefer = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime = prefer.find(m => MediaRecorder.isTypeSupported(m)) || '';
      this._recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 600000 } : {});
      this._recorder.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
      this._recorder.start(1000);
      return true;
    } catch (e) { console.warn('recording failed to start:', e && e.message); return false; }
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this._recorder || this._recorder.state === 'inactive') return resolve(null);
      this._recorder.onstop = () => resolve(new Blob(this._chunks || [], { type: 'video/webm' }));
      try { this._recorder.stop(); } catch (e) { resolve(null); }
    });
  }
}

class WebGazerEngine extends GazeEngine {
  constructor() {
    super();
    this.name = 'webgazer';
    this.last = null;
    this.facePresent = false;
    this.frameTimes = [];
    this._loopHandle = null;
  }

  async _ensureLib() {
    if (window.webgazer) return;
    // Pinned, battle-tested build (jsPsych and most published webcam-ET studies use
    // 2.x). The brown.edu "latest" build throws internally on some machines.
    const sources = [
      'https://cdn.jsdelivr.net/npm/webgazer@2.1.0/dist/webgazer.min.js',
      'https://unpkg.com/webgazer@2.1.0/dist/webgazer.js',
      'https://webgazer.cs.brown.edu/webgazer.js',
    ];
    let lastErr = null;
    for (const src of sources) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          s.onerror = () => reject(new Error('load failed: ' + src));
          document.head.appendChild(s);
        });
        if (window.webgazer) return;
      } catch (e) { lastErr = e; }
    }
    throw new Error('Could not load the gaze library (offline?). ' + (lastErr ? lastErr.message : ''));
  }

  async start({ showPreview = false } = {}) {
    await this._ensureLib();
    const wg = window.webgazer;
    // Any single cosmetic toggle that throws must NOT abort startup.
    const safe = (label, fn) => {
      try { fn(); } catch (e) { console.warn('webgazer ' + label + ' skipped:', e && e.message); }
    };
    safe('showGazeDot', () => { wg.params.showGazeDot = false; });
    safe('setRegression', () => wg.setRegression('ridge'));   // ridge regression (PRD §7)
    safe('saveData', () => wg.saveDataAcrossSessions(false));
    safe('setGazeListener', () => wg.setGazeListener((data, ts) => {
      const now = performance.now();
      this.frameTimes.push(now);
      if (this.frameTimes.length > 30) this.frameTimes.shift();
      if (data) {
        this.last = { x: data.x, y: data.y, t: Date.now() };
        this.facePresent = true;
      } else {
        this.facePresent = false;
      }
      if (this._onGaze) {
        this._onGaze({
          x: data ? data.x : null,
          y: data ? data.y : null,
          facePresent: this.facePresent,
          confidence: data ? 1 : 0,
          fps: this.fps(),
          t: Date.now(),
        });
      }
    }));
    // Some WebGazer builds throw internally (e.g. "t is not a function") AFTER the
    // camera + tracking loop are already live. That spurious throw must not abort the
    // study: we catch it and instead confirm the camera is actually running.
    let beginError = null;
    try {
      await wg.begin();
    } catch (e) {
      beginError = e;
      console.warn('webgazer.begin() threw; verifying camera is live:', e && e.message);
    }
    await this._waitForTracking(12000, beginError);
    // Cosmetic preview + dot toggles — guarded so a quirky build can't break the flow.
    safe('showVideoPreview', () => wg.showVideoPreview(showPreview));
    safe('showFaceOverlay', () => wg.showFaceOverlay(showPreview));
    safe('showFaceFeedbackBox', () => wg.showFaceFeedbackBox(showPreview));
    safe('showPredictionPoints', () => wg.showPredictionPoints(false));
    return true;
  }

  // Resolve once the GAZE LOOP is actually firing (frames flowing through our
  // listener) — i.e. the facemesh pipeline is alive, not just the camera. If the loop
  // never starts, surface the real begin() error so we can diagnose it.
  _waitForTracking(timeoutMs, beginError) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (this.frameTimes.length >= 3) return resolve(true);  // loop is running
        if (Date.now() - startedAt > timeoutMs) {
          let msg;
          if (beginError && /denied|permission/i.test(beginError.message || '')) {
            msg = 'Camera permission was denied';
          } else if (beginError) {
            const stack = (beginError.stack || '').split('\n').slice(0, 3).join(' | ');
            msg = 'Gaze tracking failed to start: ' + (beginError.message || beginError) +
                  (stack ? '  [' + stack + ']' : '');
          } else {
            const v = document.getElementById('webgazerVideoFeed');
            msg = (v && v.videoWidth > 0)
              ? 'Camera is on but the face-tracking model did not start. Try reloading.'
              : 'Camera did not start (no webcam, or it is in use by another app)';
          }
          return reject(new Error(msg));
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  stop() {
    try { window.webgazer && window.webgazer.end(); } catch (e) {}
  }

  pause() { try { window.webgazer.pause(); } catch (e) {} }
  resume() { try { window.webgazer.resume(); } catch (e) {} }

  // --- optional session (webcam) recording -------------------------------
  startRecording() {
    try {
      if (typeof MediaRecorder === 'undefined') return false;
      const v = document.getElementById('webgazerVideoFeed');
      const stream = v && v.srcObject;
      if (!stream) return false;
      this._chunks = [];
      const prefer = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime = prefer.find(m => MediaRecorder.isTypeSupported(m)) || '';
      this._recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 600000 } : {});
      this._recorder.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
      this._recorder.start(1000);
      return true;
    } catch (e) { console.warn('recording failed to start:', e && e.message); return false; }
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this._recorder || this._recorder.state === 'inactive') return resolve(null);
      this._recorder.onstop = () => resolve(new Blob(this._chunks || [], { type: 'video/webm' }));
      try { this._recorder.stop(); } catch (e) { resolve(null); }
    });
  }

  // Add a labelled training sample: current eye features -> screen (x,y).
  addCalibrationSample(x, y) {
    try { window.webgazer.recordScreenPosition(x, y, 'click'); } catch (e) {}
  }

  predict() {
    // Return the latest gaze captured by the listener. NOTE: webgazer 2.x's
    // getCurrentPrediction() is async (returns a Promise), so reading .x/.y off it
    // synchronously yields NaN — we use the listener's last value instead.
    if (this.last && Number.isFinite(this.last.x) && Number.isFinite(this.last.y)) {
      return { x: this.last.x, y: this.last.y };
    }
    return null;
  }

  fps() {
    if (this.frameTimes.length < 2) return 0;
    const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
    return span > 0 ? Math.round((this.frameTimes.length - 1) / span) : 0;
  }

  // True when the face mesh currently has a detection. Works BEFORE calibration
  // (unlike gaze prediction, which is null until the model is trained). Used by the
  // face-positioning step.
  faceDetected() {
    try {
      const tr = window.webgazer.getTracker();
      if (tr) {
        // getPositions() returns the face-mesh landmark array when a face is present,
        // and null otherwise — and works BEFORE calibration. This is the primary signal.
        if (typeof tr.getPositions === 'function') {
          const p = tr.getPositions();
          if (p && p.length) return true;
        }
        if (tr.predictionReady === true) return true;
      }
    } catch (e) {}
    return false;
  }

  // Raw signal values, surfaced for on-screen diagnostics during face positioning.
  faceDebug() {
    let pos = 'n/a', ready = 'n/a';
    try {
      const tr = window.webgazer.getTracker();
      if (tr) {
        if (typeof tr.getPositions === 'function') {
          const p = tr.getPositions();
          pos = p == null ? 'null' : (p.length || 0);
        }
        ready = String(tr.predictionReady);
      }
    } catch (e) { pos = 'err'; }
    return `pos=${pos} ready=${ready} fps=${this.fps()}`;
  }

  getQuality() {
    return { facePresent: this.faceDetected(), fps: this.fps() };
  }

  // Move WebGazer's own video element into a host container for the
  // face-positioning preview, so the participant sees their framing.
  attachPreviewTo(hostEl) {
    const tryAttach = () => {
      const vc = document.getElementById('webgazerVideoContainer');
      if (vc && hostEl) {
        vc.style.position = 'absolute';
        vc.style.top = '0'; vc.style.left = '0';
        vc.style.zIndex = '1';
        hostEl.appendChild(vc);
        return true;
      }
      return false;
    };
    if (!tryAttach()) {
      const iv = setInterval(() => { if (tryAttach()) clearInterval(iv); }, 200);
      setTimeout(() => clearInterval(iv), 5000);
    }
  }

  exportDebug() {
    return { engine: this.name, fps: this.fps(), facePresent: this.facePresent };
  }
}

// ---------------------------------------------------------------------------
// MediaPipeEngine (Route B — the in-house engine). Adapter over the ES-module
// engine in /js/mpgaze/: MediaPipe FaceLandmarker iris features + per-participant
// ridge + local-kNN correction, trained in-browser after calibration.
// Validated in the accuracy lab at ~125-140px median (PRD §8 pass: <150px).
// ---------------------------------------------------------------------------
class MediaPipeEngine extends GazeEngine {
  constructor() {
    super();
    this.name = 'mediapipe';
    this.mp = null;          // MediaPipeGazeEngine instance (ES module)
    this.video = null;
    this._burst = null;
  }

  async start({ showPreview = false } = {}) {
    const mod = await import('/js/mpgaze/engine.js');
    this.mp = new mod.MediaPipeGazeEngine({ lambda: 0.4 });
    // The engine drives its own <video>; keep it offscreen until attachPreviewTo.
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.style.cssText =
      'position:fixed;left:-9999px;top:0;width:320px;height:240px;';
    document.body.appendChild(this.video);
    this.mp.onGaze((g) => { if (this._onGaze) this._onGaze(g); });
    // Try the participant's previously-chosen camera first (multi-camera machines).
    let preferred = null;
    try { preferred = localStorage.getItem('eyetrack_camera') || null; } catch (e) {}
    await this.mp.start(this.video, () => {}, preferred);
    return true;
  }

  async listCameras() { return this.mp ? this.mp.listCameras() : []; }

  async switchCamera(deviceId) {
    if (!this.mp) return false;
    const ok = await this.mp.switchCamera(deviceId);
    if (ok) { try { localStorage.setItem('eyetrack_camera', deviceId); } catch (e) {} }
    return ok;
  }

  activeCamera() { return this.mp ? this.mp.activeCamera() : null; }

  // --- setup-quality probes (pre-calibration coaching) --------------------
  faceMetrics() {
    const f = this.mp && this.mp.latestFeat;
    return f ? { faceScale: f.raw.faceScale, cx: f.raw.faceCx, cy: f.raw.faceCy } : null;
  }

  // Mean luminance of the camera frame + left/right halves (uneven-lighting check).
  videoLuma() {
    try {
      const v = this.video;
      if (!v || !v.videoWidth) return null;
      const c = document.createElement('canvas');
      c.width = 48; c.height = 36;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 48, 36);
      const d = ctx.getImageData(0, 0, 48, 36).data;
      let sum = 0, sumL = 0, sumR = 0;
      for (let y = 0; y < 36; y++) {
        for (let x = 0; x < 48; x++) {
          const i = (y * 48 + x) * 4;
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          sum += l;
          if (x < 24) sumL += l; else sumR += l;
        }
      }
      const n = 48 * 36;
      return { mean: sum / n, left: sumL / (n / 2), right: sumR / (n / 2) };
    } catch (e) { return null; }
  }

  attachPreviewTo(hostEl) {
    if (!this.video || !hostEl) return;
    this.video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';
    hostEl.appendChild(this.video);
  }

  // Label the CURRENT frame's eye features with the target. The dwell calibration
  // calls this every tick while the participant looks at a dot — continuous clean
  // samples, no clicking required.
  addCalibrationSample(x, y) {
    if (this.mp) this.mp.addCalibrationSample(x, y);
  }

  train(opts) { return this.mp ? this.mp.train(opts) : false; }

  predict() {
    if (!this.mp || !this.mp.facePresent) return null;
    return this.mp.predict();
  }

  // Unsmoothed prediction — used for validation and drift checks, where the One Euro
  // filter's travel lag would otherwise be measured as model error.
  predictRaw() {
    if (!this.mp || !this.mp.facePresent) return null;
    return this.mp.predictRaw();
  }

  faceDetected() { return this.mp ? this.mp.faceDetected() : false; }

  // Virtual-chinrest guard: how far the head has moved from its calibration position.
  headDeviation() { return this.mp && this.mp.headDeviation ? this.mp.headDeviation() : null; }

  fps() { return this.mp ? this.mp.tracker.fps() : 0; }

  getQuality() {
    return this.mp ? this.mp.getQuality() : { facePresent: false, fps: 0 };
  }

  faceDebug() {
    if (!this.mp) return 'mp=loading';
    const q = this.mp.getQuality();
    return `face=${q.facePresent} fps=${q.fps} cal=${this.mp.calibrationCount()}`;
  }

  exportDebug() { return this.mp ? this.mp.exportDebug() : {}; }

  stop() {
    try { this.mp && this.mp.stop(); } catch (e) {}
    try { this.video && this.video.remove(); } catch (e) {}
  }
}

// Factory keeps the runtime engine-agnostic (PRD §6 Route C: swappable engines).
function createEngine(name = 'webgazer') {
  switch (name) {
    case 'webgazer': return new WebGazerEngine();
    case 'mediapipe': return new MediaPipeEngine();
    default: throw new Error('unknown engine: ' + name);
  }
}

window.createEngine = createEngine;
window.GazeEngine = GazeEngine;
