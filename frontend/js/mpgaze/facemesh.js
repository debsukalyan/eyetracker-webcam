// MediaPipe Face Landmarker wrapper: camera + per-frame 478-landmark detection
// (includes iris). Emits landmarks to a callback at camera frame rate.

import { FaceLandmarker, FilesetResolver }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12';

const TASKS_VERSION = '0.10.12';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export class FaceMeshTracker {
  constructor() {
    this.landmarker = null;
    this.video = null;
    this.stream = null;
    this.running = false;
    this._onFrame = null;
    this.lastVideoTime = -1;
    this.fpsTimes = [];
  }

  onFrame(cb) { this._onFrame = cb; }

  async init(onStatus = () => {}) {
    onStatus('Loading vision runtime…');
    const fileset = await FilesetResolver.forVisionTasks(
      `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`);
    onStatus('Loading face model…');
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    onStatus('Model ready');
    return true;
  }

  // Start a camera, robustly. A machine can have several cameras and the default one
  // may be broken (opens but delivers black frames) or busy — so we try the preferred
  // device, then every enumerated camera, and VERIFY frames actually arrive and are
  // not pure black before accepting.
  async startCamera(videoEl, deviceId = null) {
    this.video = videoEl;
    const hi = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const tryList = [];
    if (deviceId) tryList.push({ deviceId: { exact: deviceId }, ...hi });
    tryList.push({ facingMode: 'user', ...hi });

    let lastErr = null;
    for (const video of tryList) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (await this._attach(s)) return true;
      } catch (e) { lastErr = e; }
    }
    // Default route failed — walk every camera on the machine.
    for (const d of await FaceMeshTracker.listCameras()) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: d.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (await this._attach(s)) return true;
      } catch (e) { lastErr = e; }
    }
    throw new Error('No working camera found' + (lastErr ? ' (' + (lastErr.message || lastErr.name) + ')' : ''));
  }

  // Attach a stream and verify it: frames must arrive within 4s and must not be pure
  // black (a dead camera can "open" and stream black frames forever).
  async _attach(stream) {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = stream;
    this.video.srcObject = stream;
    try { await this.video.play(); } catch (e) {}
    const framesOk = await new Promise((res) => {
      const t0 = Date.now();
      const chk = setInterval(() => {
        if (this.video.videoWidth > 0 && this.video.readyState >= 2) { clearInterval(chk); res(true); }
        else if (Date.now() - t0 > 4000) { clearInterval(chk); res(false); }
      }, 100);
    });
    if (framesOk && await this._isBlackFeed()) {
      console.warn('camera opened but streams black frames — trying next device');
      stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      return false;
    }
    if (!framesOk) {
      stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      return false;
    }
    const track = stream.getVideoTracks()[0];
    const st = (track && track.getSettings && track.getSettings()) || {};
    this.activeDeviceId = st.deviceId || null;
    this.activeLabel = (track && track.label) || '';
    if (!this.running) { this.running = true; this._loop(); }
    return true;
  }

  async _isBlackFeed() {
    await new Promise(r => setTimeout(r, 500));   // let exposure settle
    try {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(this.video, 0, 0, 32, 24);
      const d = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return (sum / (d.length / 4) / 3) < 2;      // mean luminance ≈ 0 → dead feed
    } catch (e) { return false; }                  // can't sample → assume it's fine
  }

  async switchCamera(deviceId) {
    return this.startCamera(this.video, deviceId);
  }

  static async listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === 'videoinput');
    } catch (e) { return []; }
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v && v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      const now = performance.now();
      let res = null;
      try { res = this.landmarker.detectForVideo(v, now); } catch (e) { /* transient */ }
      this.fpsTimes.push(now);
      if (this.fpsTimes.length > 30) this.fpsTimes.shift();
      const lm = res && res.faceLandmarks && res.faceLandmarks[0];
      if (this._onFrame) this._onFrame({ landmarks: lm || null, t: Date.now() });
    }
    requestAnimationFrame(() => this._loop());
  }

  fps() {
    if (this.fpsTimes.length < 2) return 0;
    const span = (this.fpsTimes[this.fpsTimes.length - 1] - this.fpsTimes[0]) / 1000;
    return span > 0 ? Math.round((this.fpsTimes.length - 1) / span) : 0;
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
  }
}
