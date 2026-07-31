// Participant runtime controller (PRD sections 4, 5, 8).
// Drives the journey: token -> consent -> device -> face -> calibrate ->
// validate -> stimulus -> survey -> end. Talks only to the GazeEngine interface.

(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => {
    document.querySelectorAll('.stage').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
  };

  const state = {
    token: new URLSearchParams(location.search).get('token'),
    sessionId: null,
    study: null,
    engine: null,
    config: null,
    deviceType: 'desktop',
    gazeQueue: null,
    eventQueue: null,
    retryCount: 0,
    capturing: false,
    currentTrialId: null,
    stimRect: null,
    surveyStart: 0,
    gazeOffset: { dx: 0, dy: 0 },
  };

  // ---- bootstrap -------------------------------------------------------
  async function boot() {
    if (!state.token) {
      $('load-msg').textContent = 'Missing participation token. Please use the link you were given.';
      return;
    }
    try {
      state.config = await API.get('/config/thresholds.json');
      const res = await API.post('/api/participant/start', { token: state.token });
      state.sessionId = res.session_id;
      state.study = res.study;
      setupConsent();
      show('consent-stage');
    } catch (e) {
      $('load-msg').textContent = 'Could not start study: ' + e.message;
    }
  }

  // ---- 1. consent ------------------------------------------------------
  function setupConsent() {
    $('study-title').textContent = state.study.title || 'Attention Study';
    $('consent-text').textContent = state.study.consent_text || '';

    state.recordSession = !!(state.study.config && state.study.config.record_session);
    state.recordScreen = !!(state.study.config && state.study.config.record_screen);
    // When recording is enabled, require a SEPARATE explicit consent (PRD §14).
    if (state.recordSession) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;color:var(--text);margin-top:10px';
      wrap.innerHTML = '<input type="checkbox" id="rec-consent-check" style="width:auto" />' +
        ' I also consent to my webcam <strong>video being recorded</strong> during this study.';
      $('consent-check').parentElement.insertAdjacentElement('afterend', wrap);
    }

    const updateAccept = () => {
      const main = $('consent-check').checked;
      const rec = state.recordSession ? (document.getElementById('rec-consent-check') || {}).checked : true;
      $('consent-accept').disabled = !(main && rec);
    };
    $('consent-check').addEventListener('change', updateAccept);
    if (state.recordSession) {
      document.getElementById('rec-consent-check').addEventListener('change', updateAccept);
    }
    $('consent-decline').addEventListener('click', () => {
      show('end-stage');
      $('end-title').textContent = 'No problem';
      $('end-msg').textContent = 'You declined to participate. You may close this tab.';
    });
    $('consent-accept').addEventListener('click', async () => {
      state.recordingConsented = state.recordSession &&
        document.getElementById('rec-consent-check').checked;
      await API.post(`/api/session/${state.sessionId}/consent`, {
        accepted: true, recording_accepted: state.recordingConsented,
      });
      runDeviceCheck();
    });
  }

  // ---- 2. device check -------------------------------------------------
  async function runDeviceCheck() {
    show('device-stage');
    const ul = $('device-checks');
    ul.innerHTML = '';
    const checks = [];
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    state.deviceType = isMobile ? 'mobile' : 'desktop';
    const allowed = state.study.device_allowed || 'desktop';

    // Phones are portrait and far smaller than a laptop — judge them by a phone-
    // appropriate minimum, not the 800×600 desktop bar (which wrongly flagged every
    // phone as "dimensions don't agree" even on mobile-allowed studies).
    const minW = isMobile ? 320 : 800, minH = isMobile ? 480 : 600;
    const shortSide = Math.min(window.screen.width, window.screen.height);
    const longSide = Math.max(window.screen.width, window.screen.height);
    const screenOk = shortSide >= minW && longSide >= minH;
    const browser = detectBrowser();
    const browserOk = ['Chrome', 'Edge', 'Opera'].includes(browser);
    const hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const deviceOk = allowed === 'both' || allowed === state.deviceType ||
                     (allowed === 'desktop' && !isMobile);

    checks.push(['Browser', browser, browserOk, 'Chrome or Edge recommended for accuracy']);
    checks.push(['Screen size', `${window.screen.width}×${window.screen.height}`, screenOk,
      isMobile ? `Minimum ${minW}×${minH}` : 'Minimum 800×600']);
    checks.push(['Camera API', hasCam ? 'available' : 'missing', hasCam, 'A webcam is required']);
    checks.push(['Device type', state.deviceType, deviceOk,
      allowed === 'desktop' ? 'This study requires a desktop/laptop' : 'OK']);

    let blockers = 0;
    for (const [label, val, ok, note] of checks) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="icon">${ok ? '✅' : '⚠️'}</span>
        <strong>${label}:</strong>&nbsp;${val}
        ${ok ? '' : `<span class="muted">&nbsp;— ${note}</span>`}`;
      ul.appendChild(li);
      if (!ok && (label === 'Camera API' || label === 'Device type')) blockers++;
    }
    state.device = { type: state.deviceType, browser, screen: `${screen.width}x${screen.height}` };

    if (blockers > 0) {
      const w = $('device-warn');
      w.style.display = 'block';
      w.textContent = 'Your device does not meet the minimum requirements for this study. ' +
        'You will not be able to continue.';
      $('device-continue').disabled = true;
    } else {
      $('device-continue').disabled = false;
    }
    $('device-continue').onclick = startCamera;
  }

  function detectBrowser() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'Unknown';
  }

  // ---- 3. camera + face positioning ------------------------------------
  async function startCamera() {
    show('facepos-stage');
    // Mobile is supported when the phone is kept STATIONARY (propped up, not held) —
    // the calibration assumes a fixed head↔screen geometry, which a handheld phone
    // breaks. Swap in phone-specific guidance so participants set up correctly.
    if (state.deviceType === 'mobile') {
      const note = $('mobile-setup-note'); if (note) note.style.display = '';
      const desc = $('facepos-desc'); if (desc) desc.style.display = 'none';
    }
    // Engine is chosen per study (Build tab). 'mediapipe' = in-house engine (Route B),
    // 'webgazer' = legacy fallback. The runtime only talks to the GazeEngine interface.
    state.engineName = (state.study.config && state.study.config.engine) || 'mediapipe';
    // Release any previous engine's camera first (retry path) — a held stream makes
    // the same camera report "in use" on the next attempt.
    if (state.engine && state.engine.stop) { try { state.engine.stop(); } catch (e) {} }
    state.engine = createEngine(state.engineName);
    state.cameraReady = false;
    state.cameraError = null;

    // Kick off the gaze engine WITHOUT blocking the UI, so the status poller below
    // can show live progress while the face model downloads (first load is slow).
    state.engine.start({ showPreview: true }).then(async () => {
      state.cameraReady = true;
      state.engine.attachPreviewTo($('facebox'));
      populateCameraPicker();      // multi-camera machines: let people switch
      try {
        await API.post(`/api/session/${state.sessionId}/device`, {
          device: state.device,
          browser: { name: detectBrowser(), ua: navigator.userAgent },
          screen_width: window.innerWidth, screen_height: window.innerHeight,
          dpr: window.devicePixelRatio,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, engine: state.engineName,
        });
      } catch (e) { /* non-fatal */ }
    }).catch((e) => { state.cameraError = e; });

    runFaceposPoller();
    // Live setup coaching: measure lighting / distance / camera speed every second and
    // show actionable hints. Two identical runs proved conditions dominate accuracy
    // (chair + still head: 51px "followed absolutely"; slouched: 91px "partial") — so
    // the product must coach the setup instead of hoping participants know.
    if (state.setupTick) clearInterval(state.setupTick);
    state.setupTick = setInterval(setupCoachTick, 1000);
    $('facepos-continue').onclick = async () => {
      clearInterval(state.setupTick);
      // Attach the final setup snapshot to the session's device record for QA.
      try {
        await API.post(`/api/session/${state.sessionId}/device`, {
          device: { ...state.device, setup: state.setupSnapshot || null },
          browser: { name: detectBrowser(), ua: navigator.userAgent },
          screen_width: window.innerWidth, screen_height: window.innerHeight,
          dpr: window.devicePixelRatio,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, engine: state.engineName,
        });
      } catch (e) { /* non-fatal */ }
      show('calibration-stage'); setupCalibration();
    };
  }

  function setupCoachTick() {
    const list = $('setup-hints');
    if (!list) return;
    const items = [];
    let q = {};
    try { q = state.engine.getQuality() || {}; } catch (e) {}
    const lum = state.engine.videoLuma ? state.engine.videoLuma() : null;
    const fm = state.engine.faceMetrics ? state.engine.faceMetrics() : null;
    if (q.fps) {
      items.push(q.fps >= 20 ? ['✅', `Camera speed good (${q.fps} fps)`]
                             : ['⚠️', `Camera slow (${q.fps} fps) — close other apps/tabs`]);
    }
    if (lum) {
      if (lum.mean < 50) items.push(['⚠️', 'Too dark — add light in FRONT of you']);
      else if (lum.mean > 215) items.push(['⚠️', 'Washed out — reduce direct light on the camera']);
      else items.push(['✅', 'Lighting level good']);
      if (Math.abs(lum.left - lum.right) / Math.max(lum.mean, 1) > 0.35) {
        items.push(['⚠️', 'Uneven lighting — one side of your face is much darker']);
      }
    }
    if (fm) {
      if (fm.faceScale < 0.11) items.push(['⚠️', 'You seem far away — move a little closer']);
      else if (fm.faceScale > 0.34) items.push(['⚠️', 'Very close — move back a little']);
      else items.push(['✅', 'Distance good']);
    }
    list.innerHTML = items.map(([ic, txt]) =>
      `<li><span class="icon">${ic}</span>${txt}</li>`).join('');
    state.setupSnapshot = {
      fps: q.fps || null,
      luma: lum ? Math.round(lum.mean) : null,
      luma_asym: lum ? +((lum.left - lum.right) / Math.max(lum.mean, 1)).toFixed(2) : null,
      face_scale: fm ? +fm.faceScale.toFixed(3) : null,
    };
  }

  // Live status poller for the face-positioning stage. Re-callable (camera retry/switch).
  function runFaceposPoller() {
    if (state.faceposTick) clearInterval(state.faceposTick);
    let stableMs = 0;
    const need = 2500;
    const dbg = () => (state.engine.faceDebug ? '  [' + state.engine.faceDebug() + ']' : '');
    state.faceposTick = setInterval(() => {
      if (state.cameraError) {
        clearInterval(state.faceposTick);
        $('facepos-hint').textContent = 'Camera error: ' + state.cameraError.message +
          '. Pick another camera below or retry.';
        populateCameraPicker();    // offer whatever cameras exist + a retry
        $('cam-retry').style.display = '';
        $('cam-retry').onclick = () => { $('cam-retry').style.display = 'none'; startCamera(); };
        return;
      }
      let face = false;
      try { face = state.engine.getQuality().facePresent; } catch (e) {}
      if (!state.cameraReady && !face) {
        $('facepos-hint').textContent = 'Starting camera & loading face model…' + dbg();
        return;
      }
      // Live face marker + directional guidance so the participant can align their
      // face inside the target oval (the outline) for the best tracking data.
      const marker = $('face-marker');
      const fm = (face && state.engine.faceMetrics) ? state.engine.faceMetrics() : null;
      // Default true so engines without position metrics (e.g. WebGazer) aren't blocked.
      let centered = true;
      if (fm && fm.cx != null) {
        // Video is mirrored (scaleX -1), so display x = 1 - cx. cy is top-origin.
        marker.style.display = 'block';
        marker.style.left = ((1 - fm.cx) * 100) + '%';
        marker.style.top = (fm.cy * 100) + '%';
        const dx = fm.cx - 0.5, dy = fm.cy - 0.45;       // offset from target centre
        const scale = fm.faceScale || 0.2;
        let dir = '';
        if (scale < 0.11) dir = 'move a bit closer';
        else if (scale > 0.34) dir = 'move back a little';
        else if (Math.abs(dx) > 0.12) dir = dx > 0 ? 'move right' : 'move left';  // mirror-correct
        else if (Math.abs(dy) > 0.13) dir = dy > 0 ? 'move up' : 'move down';
        centered = !dir;
        state._faceDir = dir;
      } else {
        marker.style.display = 'none';
        state._faceDir = '';
      }
      // Progress is gated ONLY on face presence — never on centering. The marker +
      // directional hints are purely advisory (a too-strict centering gate left the
      // button permanently disabled even with a well-positioned face). Face present
      // = you can proceed; the hint just nudges toward the ideal position.
      if (face) {
        stableMs += 200;
        $('facebox').classList.toggle('good', centered);
        $('facepos-hint').textContent = (centered
          ? 'Great — hold still…'
          : 'Good — for best accuracy, ' + state._faceDir) + dbg();
      } else {
        stableMs = Math.max(0, stableMs - 400);
        $('facebox').classList.remove('good');
        marker.style.display = 'none';
        $('facepos-hint').textContent = 'Move into the frame and ensure good lighting…' + dbg();
      }
      $('facepos-progress').style.width = Math.min(100, 100 * stableMs / need) + '%';
      if (stableMs >= need) {
        $('facepos-continue').disabled = false;
        $('facepos-hint').textContent = 'Face detected. You may start calibration.';
        clearInterval(state.faceposTick);
      }
    }, 200);
  }

  // Camera dropdown: lists every camera on the machine; switching restarts the feed
  // on the chosen device and remembers it for next time.
  async function populateCameraPicker() {
    if (!state.engine || !state.engine.listCameras) return;
    let cams = [];
    try { cams = await state.engine.listCameras(); } catch (e) {}
    if (!cams.length) return;
    const active = (state.engine.activeCamera && state.engine.activeCamera()) || {};
    const sel = $('cam-select');
    sel.innerHTML = '';
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || ('Camera ' + (i + 1));
      if (c.deviceId === active.deviceId) o.selected = true;
      sel.appendChild(o);
    });
    // Show the picker whenever there's a choice to make (or the default failed).
    $('cam-picker').style.display = (cams.length > 1 || state.cameraError) ? '' : 'none';
    sel.onchange = async () => {
      $('facepos-hint').textContent = 'Switching camera…';
      try {
        const ok = await state.engine.switchCamera(sel.value);
        if (ok) {
          state.cameraError = null;
          state.cameraReady = true;
          $('facepos-continue').disabled = true;
          $('cam-retry').style.display = 'none';
          runFaceposPoller();      // re-run the face check on the new feed
        } else {
          $('facepos-hint').textContent = 'That camera did not produce a usable picture — try another.';
        }
      } catch (e) {
        $('facepos-hint').textContent = 'Could not switch camera: ' + e.message;
      }
    };
  }

  // ---- 4. calibration (corner dots + gaze-burst spinners) --------------
  const CLICKS_PER_POINT = 4;
  function calibrationPoints() {
    // 4 corners (emphasized) + center + 4 edge midpoints = spread training data
    // for better edge accuracy than a tight 3x3 grid.
    return [
      { x: 0.08, y: 0.10 }, { x: 0.92, y: 0.10 }, { x: 0.08, y: 0.90 }, { x: 0.92, y: 0.90 },
      { x: 0.50, y: 0.50 },
      { x: 0.50, y: 0.10 }, { x: 0.50, y: 0.90 }, { x: 0.08, y: 0.50 }, { x: 0.92, y: 0.50 },
    ];
  }
  function spinnerPoints() {
    // Three spinners in the mid-zones to add gaze-contingent training where the
    // click grid is sparse (PRD §7 head-pose coverage).
    return [{ x: 0.50, y: 0.30 }, { x: 0.27, y: 0.70 }, { x: 0.73, y: 0.70 }];
  }

  function renderPills(container, total, done) {
    container.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const s = document.createElement('i');
      if (i < done) s.classList.add('on');
      container.appendChild(s);
    }
  }

  function setupCalibration() {
    // Engine-appropriate instructions: MediaPipe needs no clicking at all.
    if (state.engineName === 'mediapipe') {
      $('cal-intro').innerHTML = `<h1>Calibration</h1>
        <p class="muted">We'll go full-screen. <strong>Just look at each dot until it
        fills</strong> — no clicking needed. Keep your head still; only your eyes move.
        Takes about 30 seconds.</p>
        <button class="btn lg" id="cal-start">Start calibration</button>`;
    }
    $('cal-start').onclick = async () => {
      $('cal-intro').style.display = 'none';
      try { await document.documentElement.requestFullscreen(); } catch (e) {}
      $('cal-hud').style.display = 'block';
      runCalibration();
    };
  }

  function runCalibration() {
    if (state.engineName === 'mediapipe') runDwellCalibration();
    else runClickCalibration();
  }

  // Shuffle dot order: with an ordered sweep, slow posture drift correlates with dot
  // position and the model learns the drift as if it were gaze (lab-measured failure).
  function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- Dwell calibration (MediaPipe): look at each dot until it fills ----
  function dwellPoints() {
    // 17 points — the PROVEN layout (41px validation, 91% valid sessions). Do NOT add
    // dots at the exact screen extremes (0.04/0.96): the iris saturates under the eye
    // corner there, those samples carry distorted features, and the polynomial model
    // bends globally to fit them — measured A/B: 25-dot extreme layout DEGRADED
    // held-out error 36px→52px despite 65% more samples. Shuffled per run.
    return shuffled([
      { x: 0.07, y: 0.09 }, { x: 0.5, y: 0.09 }, { x: 0.93, y: 0.09 },
      { x: 0.07, y: 0.5 },  { x: 0.5, y: 0.5 },  { x: 0.93, y: 0.5 },
      { x: 0.07, y: 0.91 }, { x: 0.5, y: 0.91 }, { x: 0.93, y: 0.91 },
      { x: 0.28, y: 0.28 }, { x: 0.72, y: 0.28 }, { x: 0.28, y: 0.72 }, { x: 0.72, y: 0.72 },
      { x: 0.93, y: 0.28 }, { x: 0.93, y: 0.72 },   // extra RIGHT edge
      { x: 0.07, y: 0.28 }, { x: 0.07, y: 0.72 },   // extra LEFT edge
    ]);
  }

  // (RealEye-style 3-background calibration tried 2026-07-19 and REVERTED: their DNN
  // sees the raw eye image and can learn the pupil-size/brightness relationship; our
  // geometric features contain no pupil-size signal, so multi-brightness variance is
  // unlearnable label noise — the model degraded until spinners wouldn't burst.
  // Calibrating on ONE bright background matched to typical stimuli remains correct
  // for THIS engine.)
  async function runDwellCalibration() {
    const stage = $('calibration-stage');
    const pts = dwellPoints();
    $('cal-hud-text').innerHTML = 'Follow the dot with your <strong>eyes only</strong> — it fills as you look.';
    renderPills($('cal-pills'), pts.length, 0);
    const collected = [];
    for (let i = 0; i < pts.length; i++) {
      await dwellPoint(stage, pts[i], collected);
      renderPills($('cal-pills'), pts.length, i + 1);
    }
    // (Pose-robustness phases tried 2026-07-19 and REVERTED: shifting the head left/
    // right mid-calibration was cumbersome, and with no guided return to neutral the
    // accuracy check ran off-pose — 140px + forced retry. Head tolerance must come from
    // the model, not from participant gymnastics.)
    afterDotCalibration(collected, pts);
  }

  function poseInstruction(html, ms) {
    return new Promise(r => { $('cal-hud-text').innerHTML = html; setTimeout(r, ms); });
  }

  async function posePhase(stage, dir, collected) {
    await poseInstruction(
      `Now move your head <strong>slightly to the ${dir}</strong> (a couple of centimetres) ` +
      `and HOLD it there — keep following the dots with your <strong>eyes</strong>.`, 3200);
    // NOTE: these coordinates must NOT collide with dwellPoints() — the per-dot outlier
    // trimmer groups by dot position, and pose-shifted samples merged into a main-pose
    // dot's group would be discarded as outliers (the exact data we're here to collect).
    const dots = dir === 'left'
      ? [{ x: 0.45, y: 0.55 }, { x: 0.22, y: 0.3 }, { x: 0.78, y: 0.7 }]
      : [{ x: 0.55, y: 0.45 }, { x: 0.22, y: 0.68 }, { x: 0.78, y: 0.32 }];
    for (const p of shuffled(dots)) {
      await dwellPoint(stage, p, collected);
    }
  }

  function dwellPoint(stage, p, collected) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'corner-dot dwell';
      el.style.left = (p.x * 100) + '%';
      el.style.top = (p.y * 100) + '%';
      const fill = document.createElement('div');
      fill.className = 'dfill';
      el.appendChild(fill);
      stage.appendChild(el);
      const cx = p.x * window.innerWidth, cy = p.y * window.innerHeight;
      // 450ms settle (saccade lands), then ~1s of per-frame labelled samples.
      setTimeout(() => {
        const dur = 1000, t0 = performance.now();
        const tick = setInterval(() => {
          const elapsed = performance.now() - t0;
          fill.style.clipPath = `inset(0 0 ${Math.max(0, 100 - (elapsed / dur) * 100)}% 0)`;
          if (state.engine.faceDetected && state.engine.faceDetected()) {
            state.engine.addCalibrationSample(cx, cy);
            collected.push({ x: p.x, y: p.y });
          }
          if (elapsed >= dur) { clearInterval(tick); el.remove(); resolve(); }
        }, 45);
      }, 450);
    });
  }

  // ---- Click calibration (WebGazer legacy): tap each dot while looking ----
  function runClickCalibration() {
    const stage = $('calibration-stage');
    const pts = calibrationPoints();
    const collected = [];
    let remaining = pts.length;
    renderPills($('cal-pills'), pts.length, 0);

    pts.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'corner-dot';
      el.style.left = (p.x * 100) + '%';
      el.style.top = (p.y * 100) + '%';
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = CLICKS_PER_POINT;
      el.appendChild(count);
      let clicks = 0;
      const onHit = (ev) => {
        ev.preventDefault();
        state.engine.addCalibrationSample(p.x * window.innerWidth, p.y * window.innerHeight);
        clicks++;
        count.textContent = Math.max(0, CLICKS_PER_POINT - clicks);
        collected.push({ x: p.x, y: p.y });
        if (clicks >= CLICKS_PER_POINT) {
          el.classList.add('done');
          el.style.pointerEvents = 'none';
          count.textContent = '✓';
          remaining--;
          renderPills($('cal-pills'), pts.length, pts.length - remaining);
          if (remaining === 0) afterDotCalibration(collected, pts);
        }
      };
      el.addEventListener('click', onHit);
      el.addEventListener('touchstart', onHit, { passive: false });
      stage.appendChild(el);
    });
  }

  function afterDotCalibration(collected, pts) {
    $('cal-hud').style.display = 'none';
    document.querySelectorAll('#calibration-stage .corner-dot').forEach(e => e.remove());
    // Interim train so the spinner game has live gaze predictions to react to
    // (MediaPipe predicts nothing until trained; final re-train happens after spinners).
    if (typeof state.engine.train === 'function') state.engine.train();
    show('spinner-stage');
    runSpinnerGame(collected, pts);
  }

  // Gaze-burst spinners: the spinner pops only when the participant LOOKS at it,
  // and while they look we record calibration samples there (gamified accuracy).
  function buildSpinner() {
    const el = document.createElement('div');
    el.className = 'spinner';
    el.innerHTML =
      '<div class="ring" style="opacity:0"></div>' +
      '<div class="wheel"><div class="arm a1"></div><div class="arm a2"></div><div class="arm a3"></div></div>' +
      '<div class="hub"></div>';
    return el;
  }

  function burstAt(cx, cy) {
    const b = document.createElement('div');
    b.className = 'burst';
    b.style.left = cx + 'px';
    b.style.top = cy + 'px';
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      const ang = (i / 16) * Math.PI * 2;
      const dist = 60 + Math.random() * 50;
      s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      s.style.background = i % 2 ? 'var(--warn)' : 'var(--accent-2)';
      b.appendChild(s);
    }
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 700);
  }

  // The spinners are a QUALITY GATE, not decoration: they can only be popped by GAZE.
  // If the model can't put the participant's gaze on a big target they're staring at,
  // validation is guaranteed to fail (measured: ~400-500px) — so we recalibrate NOW
  // instead of walking them through a pointless accuracy check.
  function runSpinnerGame(collected, allPts) {
    const stage = $('spinner-stage');
    const pts = spinnerPoints();
    renderPills($('spinner-pills'), pts.length, 0);
    const DWELL_NEED = 900, RADIUS = 120, SPINNER_TIMEOUT = 8000;
    let idx = 0, gazeBursts = 0;

    function nextSpinner() {
      if (idx >= pts.length) return afterSpinners();
      const p = pts[idx];
      const cx = p.x * window.innerWidth, cy = p.y * window.innerHeight;
      const el = buildSpinner();
      el.style.left = (p.x * 100) + '%';
      el.style.top = (p.y * 100) + '%';
      stage.appendChild(el);
      const ring = el.querySelector('.ring');
      let dwell = 0;

      // No tap fallback: a spinner that won't pop by gaze is a failed check, and
      // letting people tap through was masking exactly that. It moves on by itself.
      const giveUp = setTimeout(() => {
        clearInterval(poll);
        el.remove();
        pushEvent('spinner_missed', { index: idx });
        idx++; renderPills($('spinner-pills'), pts.length, idx);
        setTimeout(nextSpinner, 350);
      }, SPINNER_TIMEOUT);

      function pop() {
        clearInterval(poll); clearTimeout(giveUp);
        gazeBursts++;
        pushEvent('spinner_popped', { index: idx });
        burstAt(cx, cy); el.remove();
        idx++; renderPills($('spinner-pills'), pts.length, idx);
        setTimeout(nextSpinner, 450);
      }

      const poll = setInterval(() => {
        const pr = state.engine.predict();
        const looking = pr && Math.hypot(pr.x - cx, pr.y - cy) < RADIUS;
        if (looking) {
          dwell += 60;
          el.classList.add('charging');
          ring.style.opacity = '1';
          state.engine.addCalibrationSample(cx, cy); // gaze-contingent training sample
        } else {
          dwell = Math.max(0, dwell - 120);
          el.classList.remove('charging');
        }
        if (dwell >= DWELL_NEED) pop();
      }, 60);
    }

    async function afterSpinners() {
      if (gazeBursts >= 2) return finishSpinners(collected, allPts.concat(pts));
      // Gate failed → the calibration is unusable. Recalibrate instead of validating.
      state.retryCount++;
      const maxR = (state.config && state.config.calibration &&
                    state.config.calibration.max_retries != null)
        ? state.config.calibration.max_retries : 2;
      pushEvent('spinner_gate_failed', { gaze_bursts: gazeBursts, retry: state.retryCount });
      if (state.retryCount > maxR) {
        show('end-stage');
        $('end-title').textContent = "We couldn't reach reliable tracking";
        $('end-msg').textContent = 'This can happen with certain lighting, glasses, or camera setups. ' +
          'Thank you for your time — your session will be marked as a technical exclusion.';
        await finishAsTechnicalFail();
        return;
      }
      show('calibration-stage');
      $('cal-hud').style.display = 'none';
      $('cal-intro').style.display = '';
      $('cal-intro').innerHTML = `<h1>Let's fine-tune</h1>
        <p class="muted">Tracking isn't accurate enough yet (${gazeBursts}/3 spinners popped by gaze).
        We'll quickly recalibrate — sit like before, keep your head still, and follow the dots
        with your eyes. Attempt ${state.retryCount + 1} of ${maxR + 1}.</p>
        <button class="btn lg" id="cal-start">Recalibrate</button>`;
      if (state.engine.mp) state.engine.mp.resetCalibration();
      $('cal-start').onclick = () => {
        $('cal-intro').style.display = 'none';
        $('cal-hud').style.display = 'block';
        runCalibration();
      };
    }
    nextSpinner();
  }

  async function finishSpinners(collected, allPts) {
    // MediaPipe trains its per-participant model from the collected samples now;
    // WebGazer has no train step (it learns incrementally) — the call is a no-op there.
    if (typeof state.engine.train === 'function') state.engine.train();
    // Record which eye mode the model selected (both/right/left) — key QA info for
    // participants with strabismus or a weaker eye.
    const dbg = (state.engine.mp && state.engine.mp.exportDebug) ? state.engine.mp.exportDebug() : {};
    await API.post(`/api/session/${state.sessionId}/calibration`, {
      engine: state.engineName,
      points: allPts,
      model_params: { regression: 'ridge+knn', spinner_game: true,
        eye_mode: dbg.eyeMode || 'both', eye_mode_errors_px: dbg.eyeModeErrors || null },
      quality: { samples: collected.length },
    });
    show('validation-stage');
    setupValidation();
  }

  // ---- 5. validation ---------------------------------------------------
  function validationPoints() {
    // The PROVEN 7-point set. Extreme-corner probes (0.94,0.08 / 0.06,0.92) were tried
    // and removed: they mechanically inflate the median (~+20px) against a threshold
    // tuned for this set, forcing needless recalibration retries. Corner accuracy is
    // tracked in the Benchmark tab instead, without punishing participants for it.
    return [ {x:0.2,y:0.2}, {x:0.8,y:0.2}, {x:0.5,y:0.5}, {x:0.2,y:0.8}, {x:0.8,y:0.8},
             {x:0.93,y:0.5}, {x:0.07,y:0.5} ];
  }

  function setupValidation() {
    $('val-result').style.display = 'none';
    $('val-intro').style.display = '';
    $('val-start').onclick = runValidation;
  }

  async function runValidation() {
    $('val-intro').style.display = 'none';
    const stage = $('validation-stage');
    const canonical = validationPoints();
    // Present in random order (no temporal pattern), but store errors indexed by the
    // canonical point list so per-point diagnostics map to screen positions.
    const order = shuffled(canonical.map((p, i) => ({ p, i })));
    const errors = new Array(canonical.length).fill(9999);
    try {
      for (const { p, i } of order) {
        const el = document.createElement('div');
        el.className = 'cal-point';
        el.style.background = 'var(--warn)';
        el.style.left = (p.x * 100) + '%';
        el.style.top = (p.y * 100) + '%';
        stage.appendChild(el);
        // 750ms settle: a full-screen saccade takes ~300ms and fixation must
        // stabilize — sampling earlier measures eye travel, not accuracy.
        await wait(750);
        const samples = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 1000) {
          // Raw (unsmoothed) predictions: the display smoother lags on jumps and
          // would be measured as model error. Gate on face presence (blinks).
          const pr = (state.engine.predictRaw && state.engine.predictRaw()) || state.engine.predict();
          if (pr && Number.isFinite(pr.x) && Number.isFinite(pr.y)) samples.push(pr);
          await wait(40);
        }
        el.remove();
        if (samples.length >= 3) {
          // median per axis — robust to the odd wild frame in the window
          const mx = median(samples.map(s => s.x)), my = median(samples.map(s => s.y));
          const tx = p.x * window.innerWidth, ty = p.y * window.innerHeight;
          const err = Math.hypot(mx - tx, my - ty);
          errors[i] = Number.isFinite(err) ? err : 9999;
        }
      }
      const res = await API.post(`/api/session/${state.sessionId}/validation`, {
        errors_px: errors, points: canonical,
        device_type: state.deviceType, retry_count: state.retryCount,
      });
      showValidationResult(res);
    } catch (e) {
      const box = $('val-result');
      box.style.display = 'block';
      box.innerHTML = `<h1>Something went wrong</h1>
        <p class="muted">The accuracy check could not be completed: ${e.message}</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn lg'; btn.textContent = 'Retry accuracy check';
      btn.onclick = () => { box.style.display = 'none'; runValidation(); };
      box.appendChild(btn);
    }
  }

  function showValidationResult(res) {
    const box = $('val-result');
    box.style.display = 'block';
    // Remember the measured accuracy — the drift correction is sanity-checked against
    // it (a "drift" larger than the validation error is a bad measurement, not drift).
    state.valMedian = res.median_error_px || 80;
    const med = res.median_error_px != null ? Math.round(res.median_error_px) : '—';
    if (res.passed) {
      box.innerHTML = `<h1>Accuracy check passed ✅</h1>
        <p class="muted">Median error: <strong>${med}px</strong> (threshold ${res.threshold_px}px).</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn lg'; btn.textContent = 'Continue';
      btn.onclick = () => { show('ready-stage'); setupStimulus(); };
      box.appendChild(btn);
    } else if (res.must_stop) {
      box.innerHTML = `<h1>We couldn't reach the required accuracy</h1>
        <p class="muted">Median error ${med}px exceeded ${res.threshold_px}px after the allowed retries.
        Thank you for your time — your session will be marked as a technical exclusion.</p>`;
      finishAsTechnicalFail();
    } else {
      box.innerHTML = `<h1>Let's try again</h1>
        <p class="muted">Median error ${med}px is above the ${res.threshold_px}px threshold.
        ${res.retries_remaining} retr${res.retries_remaining === 1 ? 'y' : 'ies'} remaining.
        We'll recalibrate.</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn lg'; btn.textContent = 'Recalibrate';
      btn.onclick = () => {
        state.retryCount++;
        box.style.display = 'none';
        // Fresh calibration set on retry — stale samples from a shifted posture are
        // exactly what failed; mixing them in would fight the new ones.
        if (typeof state.engine.mp === 'object' && state.engine.mp) state.engine.mp.resetCalibration();
        show('calibration-stage');
        $('cal-hud').style.display = 'block';
        runCalibration();
      };
      box.appendChild(btn);
    }
  }

  async function finishAsTechnicalFail() {
    await API.post(`/api/session/${state.sessionId}/complete`);
  }

  // ---- 6. stimulus block ----------------------------------------------
  function setupStimulus() {
    $('stim-begin').onclick = async () => {
      // Screen-share MUST be requested inside the click gesture, BEFORE any await,
      // or the browser rejects getDisplayMedia. Skips silently on phones/denied.
      if (state.recordScreen) await startScreenRecording();
      try { await document.documentElement.requestFullscreen(); } catch (e) {}
      startStimulusBlock();
    };
  }

  // Screen recording of the whole study block + a screen-normalized gaze track for the
  // replay overlay. Time-changing stimuli (scrolling websites, videos) can't be reduced
  // to one static heatmap, so we capture what was actually on screen with gaze over time.
  async function startScreenRecording() {
    state.screenRec = null; state.screenGaze = [];
    try {
      const md = navigator.mediaDevices;
      if (!md || !md.getDisplayMedia || typeof MediaRecorder === 'undefined') return; // mobile/unsupported
      const stream = await md.getDisplayMedia({
        video: { frameRate: { ideal: 15 } }, audio: false,
        preferCurrentTab: true,            // Chrome hint: offer "this tab" first
      });
      const prefer = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime = prefer.find(m => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1200000 } : {});
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(1000);
      // If the participant stops sharing from the browser bar, just finalize gracefully.
      stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { try { rec.stop(); } catch (e) {} }));
      state.screenRec = { rec, chunks, stream, startMs: Date.now() };
    } catch (e) {
      console.warn('screen recording not started (non-fatal):', e && e.message);
      state.screenRec = null;   // declined or unsupported — study continues normally
    }
  }

  async function stopAndUploadScreenRecording() {
    const sr = state.screenRec;
    if (!sr) return;
    state.screenRec = null;
    try {
      const blob = await new Promise((resolve) => {
        sr.rec.onstop = () => resolve(new Blob(sr.chunks, { type: 'video/webm' }));
        if (sr.rec.state !== 'inactive') { try { sr.rec.stop(); } catch (e) { resolve(null); } }
        else resolve(new Blob(sr.chunks, { type: 'video/webm' }));
      });
      try { sr.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      if (blob && blob.size) {
        const fd = new FormData();
        fd.append('file', new File([blob], 'screen.webm', { type: 'video/webm' }));
        fd.append('gaze_track', JSON.stringify(state.screenGaze || []));
        await fetch(`/api/session/${state.sessionId}/screen-recording`, { method: 'POST', body: fd });
      }
    } catch (e) { console.warn('screen recording upload failed', e); }
  }

  function setupQueues() {
    state.gazeQueue = new BatchQueue(`/api/session/${state.sessionId}/gaze/batch`, 'samples',
      { flushSize: 60, flushMs: 1500, storeKey: `gaze_${state.sessionId}` });
    state.eventQueue = new BatchQueue(`/api/session/${state.sessionId}/events/batch`, 'events',
      { flushSize: 20, flushMs: 2000, storeKey: `evt_${state.sessionId}` });

    // capture gaze into the queue, normalized to the current stimulus rect
    // (drift-corrected: state.gazeOffset is re-measured before every stimulus)
    state.engine.onGaze((g) => {
      // Screen-replay track: gaze in SCREEN-normalized coords vs. the recording clock,
      // independent of the per-stimulus rect (so it overlays the screen recording).
      if (state.screenRec && g.x != null) {
        const sx = (g.x + state.gazeOffset.dx) / window.innerWidth;
        const sy = (g.y + state.gazeOffset.dy) / window.innerHeight;
        if (sx >= -0.05 && sx <= 1.05 && sy >= -0.05 && sy <= 1.05) {
          state.screenGaze.push([Date.now() - state.screenRec.startMs,
            +sx.toFixed(4), +sy.toFixed(4)]);
        }
      }
      if (!state.capturing || !state.currentTrialId) return;
      let nx = null, ny = null, off = true;
      if (g.x != null && state.stimRect) {
        const gx = g.x + state.gazeOffset.dx, gy = g.y + state.gazeOffset.dy;
        nx = (gx - state.stimRect.left) / state.stimRect.width;
        ny = (gy - state.stimRect.top) / state.stimRect.height;
        // 6% margin: gaze just outside the image edge (or in the letterbox) is still
        // the participant looking at the screen — don't tank valid% for edge viewing.
        off = nx < -0.06 || nx > 1.06 || ny < -0.06 || ny > 1.06;
      }
      state.gazeQueue.push({
        trial_id: state.currentTrialId, t: g.t, x: nx, y: ny,
        confidence: g.confidence, face_present: g.facePresent, fps: g.fps, offscreen: off,
      });
    });

    // behavioral events (PRD section 17): visibility + fullscreen exits + clicks
    document.addEventListener('visibilitychange', () => pushEvent('visibility',
      { hidden: document.hidden }));
    document.addEventListener('fullscreenchange', () => pushEvent('fullscreen',
      { active: !!document.fullscreenElement }));
    $('stimulus-stage').addEventListener('click', (e) => {
      if (!state.capturing) return;
      pushEvent('click', { x: e.clientX, y: e.clientY }, e.clientX, e.clientY);
    });

    // Keep the stimulus fitted (and gaze normalization correct) when the viewport
    // changes mid-trial — mobile toolbar show/hide or a device rotation. Debounced.
    let refitT = null;
    const onViewportChange = () => {
      clearTimeout(refitT);
      refitT = setTimeout(() => { refitActiveStimulus(); pushEvent('viewport',
        { w: window.innerWidth, h: window.innerHeight }); }, 180);
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 250));
  }

  function pushEvent(type, value, x = null, y = null) {
    if (!state.eventQueue) return;
    state.eventQueue.push({ trial_id: state.currentTrialId, event_type: type,
      t: Date.now(), x, y, value });
  }

  async function startStimulusBlock() {
    setupQueues();
    state.gazeOffset = { dx: 0, dy: 0 };
    state.driftInit = false;    // first accepted anchor sets the baseline
    state.driftCount = 0;       // anchor rotation starts at centre
    // Begin optional webcam recording (only if the participant consented).
    // Guarded: recording is a nice-to-have and must NEVER block the study from
    // starting (a missing/failed recorder previously threw here and stranded the
    // participant on the "You're calibrated" screen).
    if (state.recordingConsented) {
      try {
        state.recording = state.engine.startRecording ? state.engine.startRecording() : false;
      } catch (e) { console.warn('recording start failed (non-fatal):', e && e.message); state.recording = false; }
    }
    show('stimulus-stage');
    const dot = $('gaze-dot');
    dot.style.display = 'block';
    state.engine.onGazeRaw = true;
    // live gaze dot for participant feedback (drift-corrected). Hide it when there is
    // no valid prediction — a frozen stale dot reads as "tracking is broken".
    const dotTimer = setInterval(() => {
      if (state.hideDot) { dot.style.display = 'none'; return; }
      const p = state.engine.predict();
      if (p) {
        dot.style.display = 'block';
        dot.style.left = (p.x + state.gazeOffset.dx) + 'px';
        dot.style.top = (p.y + state.gazeOffset.dy) + 'px';
      } else {
        dot.style.display = 'none';
      }
    }, 60);

    const stimuli = state.study.stimuli || [];
    let idx = 0;
    for (const stim of stimuli) {
      // Head back in the calibration pose before every stimulus (virtual chinrest).
      // NO drift/offset correction: proven by data (2026-07-17) that with head control
      // the raw model is more accurate than the raw model + a single-point offset —
      // image 0 (offset 0) hit medX/Y ≈ 0.47/0.48, image 1 (offset −112) drifted to 0.34.
      await headGuard();
      // Quick 3-dot MODEL refresh (~3.5s) before EVERY image, including the first: by
      // image 1 the calibration is already ~a minute old (spinners + validation), and
      // the 7/19 session showed image 1 tracking worst while refreshed images 2-3 were
      // better. Fresh labelled samples retrain to the participant's CURRENT eye state;
      // eye mode stays frozen, only the fit updates.
      await microRefresh();
      await showStimulus(stim, idx++);
    }
    clearInterval(dotTimer);
    dot.style.display = 'none';
    await endStimulusBlock();
  }

  // Head-position guard (virtual chinrest): before each stimulus, require the head to
  // be roughly where it was at calibration. The model is only valid near that pose —
  // this is what makes "I moved my head a bit and it broke" recoverable.
  function headGuard() {
    return new Promise((resolve) => {
      const dev0 = state.engine.headDeviation && state.engine.headDeviation();
      if (!dev0 || dev0.ok) return resolve();   // in position (or engine can't measure)
      $('stimulus-img').style.display = 'none';
      $('stimulus-video').style.display = 'none';
      state.hideDot = true;                      // no gaze dot over the re-center screen
      const ov = document.createElement('div');
      // Bright like calibration/drift screens: a dark interlude re-dilates the pupils
      // and shifts the vertical gaze signal for the seconds that follow.
      ov.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;background:#d9dde2;z-index:5;text-align:center';
      ov.innerHTML = '<h2 style="margin:0 0 10px;color:#1c2733">Re-center your head</h2>' +
        '<div class="hg-facebox"><div class="ring"></div>' +
        '<div class="face-marker" id="hg-marker"></div>' +
        '<div class="hg-target-label">get the dot into the circle</div></div>' +
        '<p id="hg-hint" style="max-width:420px;color:#5a6672;margin-top:10px"></p>' +
        '<button id="hg-skip" class="btn" style="display:none;margin-top:8px">Continue anyway</button>';
      $('stimulus-stage').appendChild(ov);
      pushEvent('head_guard', { dx: dev0.dx, dy: dev0.dy, scale: dev0.scaleRatio });
      let okMs = 0, waited = 0, done = false;
      const finish = (reason) => {
        if (done) return; done = true;
        clearInterval(tick); ov.remove(); state.hideDot = false;
        pushEvent('head_guard_done', { reason });
        resolve();
      };
      const tick = setInterval(() => {
        waited += 150;
        const d = state.engine.headDeviation();
        // A "Continue anyway" escape appears after 6s, and we auto-continue after 18s —
        // the re-center check must NEVER be able to trap a participant forever (this hung
        // "Begin study" on mobile, where the pose check rarely reads ok).
        if (waited >= 6000) { const b = $('hg-skip'); if (b) { b.style.display = ''; b.onclick = () => finish('manual'); } }
        if (waited >= 18000) return finish('timeout');
        if (!d) return;
        // Visual reference frame: the dashed circle is the calibration pose (target),
        // the dot is the head's CURRENT offset from it. Move so the dot sits in the
        // circle — far more effective than a text-only instruction.
        const marker = $('hg-marker');
        if (marker) {
          const k = 85;   // face-width offset units -> % of the box
          const mx = Math.max(10, Math.min(90, 50 + d.dx * k));
          const my = Math.max(10, Math.min(90, 50 + d.dy * k));
          marker.style.left = mx + '%'; marker.style.top = my + '%';
          marker.classList.toggle('good', !!d.ok);
        }
        const hint = $('hg-hint');
        if (hint) {
          const dir = [];
          if (d.dx > 0.35) dir.push('move left'); if (d.dx < -0.35) dir.push('move right');
          if (d.dy > 0.35) dir.push('move up');   if (d.dy < -0.35) dir.push('move down');
          if (d.scaleRatio <= 0.85) dir.push('come closer');
          if (d.scaleRatio >= 1.18) dir.push('move back a little');
          hint.textContent = d.ok ? 'Perfect — hold still…' :
            'Sit like you did during calibration — ' + (dir.join(', ') || 'adjust slightly') + '.';
        }
        okMs = d.ok ? okMs + 150 : 0;
        if (okMs >= 900) finish('ok');
      }, 150);
    });
  }

  // 3-dot mid-session MODEL refresh: collect fresh labelled samples at safe (non-extreme)
  // positions and retrain with the eye mode frozen. Counters within-session model aging
  // (eye state/posture shifts the mapping over minutes even with the head in position).
  async function microRefresh() {
    if (state.engineName !== 'mediapipe' || !state.engine.train) return;
    const stage = $('stimulus-stage');
    $('stimulus-img').style.display = 'none';
    $('stimulus-video').style.display = 'none';
    state.hideDot = true;
    $('gaze-dot').style.display = 'none';
    const bg = document.createElement('div');
    bg.style.cssText = 'position:absolute;inset:0;background:#d9dde2;z-index:4';
    stage.appendChild(bg);
    const pts = shuffled([{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.35 }, { x: 0.75, y: 0.65 }]);
    for (const p of pts) {
      await new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'cal-point';
        el.style.left = (p.x * 100) + '%'; el.style.top = (p.y * 100) + '%';
        el.style.pointerEvents = 'none'; el.style.zIndex = '5';
        stage.appendChild(el);
        const cx = p.x * window.innerWidth, cy = p.y * window.innerHeight;
        setTimeout(() => {              // settle: let the saccade land before labelling
          const t0 = performance.now();
          const tick = setInterval(() => {
            if (state.engine.faceDetected && state.engine.faceDetected()) {
              state.engine.addCalibrationSample(cx, cy);
            }
            if (performance.now() - t0 >= 700) { clearInterval(tick); el.remove(); resolve(); }
          }, 45);
        }, 450);
      });
    }
    bg.remove();
    const ok = state.engine.train({ keepEyeMode: true });
    pushEvent('micro_refresh', { ok, samples: state.engine.mp ? state.engine.mp.calibrationCount() : null });
    state.hideDot = false;
  }

  // Fixate a CENTRE dot; the median raw prediction's offset from it is posture drift,
  // subtracted from subsequent gaze. Deliberately conservative: the model's error is
  // strongly POSITION-DEPENDENT (measured: +114px at centre vs −110px just left of it),
  // so a single global offset can only ever correct slow, uniform drift — never the
  // spatial error. It therefore:
  //   • uses ONE fixed anchor (centre) — rotating anchors mixed position-dependent
  //     errors and made things worse;
  //   • REJECTS any offset larger than the just-measured validation error (a "drift"
  //     bigger than the model's own accuracy is a bad fixation, not drift);
  //   • blends gently (60/40) with the previous accepted offset.
  function driftCheck() {
    return new Promise((resolve) => {
      $('stimulus-img').style.display = 'none';
      $('stimulus-video').style.display = 'none';
      state.hideDot = true;
      $('gaze-dot').style.display = 'none';
      const bg = document.createElement('div');
      bg.style.cssText = 'position:absolute;inset:0;background:#d9dde2;z-index:4';
      $('stimulus-stage').appendChild(bg);
      const el = document.createElement('div');
      el.className = 'cal-point';
      el.style.left = '50%'; el.style.top = '50%';
      el.style.pointerEvents = 'none'; el.style.zIndex = '5';
      $('stimulus-stage').appendChild(el);
      const cap = document.createElement('p');
      cap.textContent = 'Look at the dot';
      cap.style.cssText = 'position:absolute;left:50%;top:56%;transform:translateX(-50%);' +
        'color:#5a6672;font-size:15px;pointer-events:none;z-index:5';
      $('stimulus-stage').appendChild(cap);
      const tx = window.innerWidth * 0.5, ty = window.innerHeight * 0.5;
      setTimeout(() => {                       // settle done — caption gone before sampling
        cap.remove();
        const xs = [], ys = [];
        const t0 = Date.now();
        const tick = setInterval(() => {
          const pr = (state.engine.predictRaw && state.engine.predictRaw()) || state.engine.predict();
          if (pr && Number.isFinite(pr.x)) { xs.push(pr.x); ys.push(pr.y); }
          if (Date.now() - t0 >= 1100) {
            clearInterval(tick); el.remove(); bg.remove();
            let accepted = false, reason = '';
            if (xs.length >= 6) {
              const mx = median(xs), my = median(ys);
              const madX = median(xs.map(v => Math.abs(v - mx)));
              const madY = median(ys.map(v => Math.abs(v - my)));
              const dx = tx - mx, dy = ty - my;
              // Cap: an offset bigger than the validation error can't be real drift.
              const cap = Math.max(120, (state.valMedian || 80) * 1.6);
              // Vertical gaze is inherently noisier (eyelid signal) — a tight vertical
              // dispersion gate was rejecting every check, leaving the vertical bias
              // uncorrected. Allow more vertical spread.
              if (madX > 90 || madY > 150) reason = 'unsteady';
              else if (Math.hypot(dx, dy) > cap) reason = 'too_large(' + Math.round(Math.hypot(dx, dy)) + '>' + Math.round(cap) + ')';
              else {
                state.gazeOffset = state.driftInit
                  ? { dx: 0.6 * state.gazeOffset.dx + 0.4 * dx, dy: 0.6 * state.gazeOffset.dy + 0.4 * dy }
                  : { dx, dy };
                state.driftInit = true;
                accepted = true;
              }
            } else reason = 'few_samples';
            pushEvent('drift_check', { dx: state.gazeOffset.dx, dy: state.gazeOffset.dy,
              samples: xs.length, accepted, reason });
            state.hideDot = false;
            resolve();
          }
        }, 40);
      }, 650);
    });
  }

  function fitRect(natW, natH) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / natW, vh / natH);
    const w = natW * scale, h = natH * scale;
    return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
  }

  // Re-fit the currently displayed stimulus and refresh state.stimRect. On mobile the
  // browser toolbar showing/hiding (or a rotation) changes innerWidth/innerHeight
  // mid-trial; without this, gaze would normalize against a stale rectangle.
  function refitActiveStimulus() {
    const a = state.activeStim;
    if (!a) return;
    if (a.kind === 'url') {
      const f = $('stimulus-frame');
      Object.assign(f.style, { width: window.innerWidth + 'px', height: window.innerHeight + 'px' });
      state.stimRect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    } else if (a.el) {
      const nw = a.kind === 'video' ? (a.el.videoWidth || 1280) : a.el.naturalWidth;
      const nh = a.kind === 'video' ? (a.el.videoHeight || 720) : a.el.naturalHeight;
      const r = fitRect(nw, nh);
      Object.assign(a.el.style, { left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px' });
      state.stimRect = r;
    }
  }

  function showStimulus(stim, index) {
    return new Promise(async (resolve) => {
      const trial = await API.post(`/api/session/${state.sessionId}/trial`, {
        stimulus_id: stim.id, trial_index: index, planned_onset_ts: Date.now(),
        onset_ts: null, first_frame_ts: null,
      });
      state.currentTrialId = trial.trial_id;
      const isUrl = stim.type === 'url';
      const isVideo = !isUrl && ((stim.type === 'video') ||
        /\.(mp4|webm|ogg)$/i.test(stim.file_url || ''));

      let finished = false;
      const finishTrial = async () => {
        if (finished) return;           // video 'ended' + clock cap can both fire
        finished = true;
        state.activeStim = null;
        if (state.trialClock) { clearInterval(state.trialClock); state.trialClock = null; }
        state.capturing = false;
        await API.patch(`/api/trial/${trial.trial_id}`, { offset_ts: Date.now() });
        await state.gazeQueue.flush();
        resolve();
      };
      const beginCapture = () => {
        state.capturing = true;
        pushEvent('stim_onset', { stimulus_id: stim.id, onset: Date.now() });
      };

      if (isUrl) {
        // Live website: load in a full-viewport iframe, track gaze over the whole screen.
        const frame = $('stimulus-frame');
        $('stimulus-img').style.display = 'none';
        $('stimulus-video').style.display = 'none';
        frame.style.display = 'block';
        Object.assign(frame.style, { left: '0', top: '0',
          width: window.innerWidth + 'px', height: window.innerHeight + 'px' });
        state.stimRect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        let started = false;
        const start = () => {
          if (started) return; started = true;
          beginCapture();
          runTrialClock((stim.duration_ms && stim.duration_ms > 0) ? stim.duration_ms : 15000,
            null, finishTrial);
        };
        state.activeStim = { kind: 'url' };
        frame.onload = start;
        frame.src = stim.file_url;
        // Sites that block embedding (X-Frame-Options) never fire onload — start anyway.
        setTimeout(start, 1800);
      } else if (isVideo) {
        const video = $('stimulus-video');
        $('stimulus-img').style.display = 'none';
        $('stimulus-frame').style.display = 'none';
        video.style.display = 'block';
        video.onloadedmetadata = () => {
          const r = fitRect(video.videoWidth || 1280, video.videoHeight || 720);
          Object.assign(video.style, { left: r.left + 'px', top: r.top + 'px',
            width: r.width + 'px', height: r.height + 'px' });
          state.stimRect = r;
        };
        state.activeStim = { kind: 'video', el: video };
        video.onplay = beginCapture;
        // End on natural end of video, or the configured cap if set (>0).
        video.onended = finishTrial;
        video.src = stim.file_url;
        video.play().catch(() => { beginCapture(); });
        runTrialClock((stim.duration_ms && stim.duration_ms > 0) ? stim.duration_ms : Infinity,
          video, finishTrial);
      } else {
        const img = $('stimulus-img');
        $('stimulus-video').style.display = 'none';
        $('stimulus-frame').style.display = 'none';
        img.style.display = 'block';
        img.onload = () => {
          const r = fitRect(img.naturalWidth, img.naturalHeight);
          Object.assign(img.style, { left: r.left + 'px', top: r.top + 'px',
            width: r.width + 'px', height: r.height + 'px' });
          state.stimRect = r;
          state.activeStim = { kind: 'image', el: img };
          beginCapture();
          runTrialClock(stim.duration_ms || 5000, null, finishTrial);
        };
        img.src = stim.file_url;
      }
    });
  }

  // Trial countdown + IN-TRIAL head monitor. The pre-trial guard can't catch posture
  // change DURING a 10s stimulus (slouching down mid-trial shifts all predictions up).
  // When the head stays out of position for ~1s: pause the trial, require re-centering,
  // re-measure drift, then resume — the stimulus clock only ticks while capturing, so
  // total exposure time is preserved. Everything is logged for QA.
  function runTrialClock(durationMs, videoEl, finishTrial) {
    let remaining = durationMs;
    let badMs = 0, logMs = 0, graceMs = 0;
    let pausing = false;
    if (state.trialClock) clearInterval(state.trialClock);
    state.trialClock = setInterval(async () => {
      if (pausing || !state.capturing) return;
      remaining -= 200;
      // Grace window right after a resume: don't immediately re-arm the pause trigger.
      if (graceMs > 0) { graceMs -= 200; }
      const d = state.engine.headDeviation && state.engine.headDeviation();
      // Instrument: log head deviation every ~1.5s during the trial so we can correlate
      // in-tolerance head movement with gaze error afterward (diagnosing the val→task gap).
      logMs += 200;
      if (d && logMs >= 1500) { logMs = 0;
        pushEvent('head_pos', { dx: +d.dx.toFixed(3), dy: +d.dy.toFixed(3), scale: +d.scaleRatio.toFixed(3) }); }
      // Pause trigger — deliberately LOOSER (0.24) than the recovery threshold (0.16 in
      // headDeviation.ok). The 0.08 gap is hysteresis: it stops the pause/resume
      // oscillation that hit image 3, and avoids pausing for small natural drift that
      // (per the data) tracks fine anyway.
      const bad = d && graceMs <= 0 && (Math.abs(d.dx) > 0.24 || Math.abs(d.dy) > 0.15 ||
                        d.scaleRatio < 0.89 || d.scaleRatio > 1.13);
      badMs = bad ? badMs + 200 : 0;
      if (badMs >= 800) {
        badMs = 0;
        pausing = true;
        state.capturing = false;
        pushEvent('trial_paused', { reason: 'head_moved',
          dx: +d.dx.toFixed(3), dy: +d.dy.toFixed(3), scale: +d.scaleRatio.toFixed(3) });
        if (videoEl) { try { videoEl.pause(); } catch (e) {} }
        await headGuard();          // re-center to the calibration pose (no offset needed)
        if (videoEl) { videoEl.style.display = 'block'; try { await videoEl.play(); } catch (e) {} }
        else $('stimulus-img').style.display = 'block';
        pushEvent('trial_resumed', {});
        graceMs = 1200;   // settle window before the trigger can re-arm
        state.capturing = true;
        pausing = false;
      }
      if (Number.isFinite(remaining) && remaining <= 0) {
        if (videoEl) { try { videoEl.pause(); } catch (e) {} }
        finishTrial();
      }
    }, 200);
  }

  async function endStimulusBlock() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) {}
    await state.gazeQueue.drain();
    await state.eventQueue.drain();
    // Finalize + upload the optional webcam recording.
    if (state.recording) {
      try {
        const blob = await state.engine.stopRecording();
        if (blob && blob.size) {
          const file = new File([blob], 'session.webm', { type: 'video/webm' });
          await API.upload(`/api/session/${state.sessionId}/recording`, file);
        }
      } catch (e) { console.warn('recording upload failed', e); }
    }
    // Finalize + upload the optional screen recording + gaze replay track.
    await stopAndUploadScreenRecording();
    const survey = (state.study.config && state.study.config.survey) || [];
    if (survey.length) { setupSurvey(survey); show('survey-stage'); }
    else finishStudy();
  }

  // ---- 7. survey -------------------------------------------------------
  function setupSurvey(questions) {
    const box = $('survey-questions');
    box.innerHTML = '';
    state.surveyStart = Date.now();
    questions.forEach((q, i) => {
      // Fall back to a positional id when the survey JSON omits "id" — otherwise
      // every answer is keyed "undefined" and the responses collide/are useless.
      const qid = q.id || ('q' + (i + 1));
      const wrap = document.createElement('div');
      wrap.style.marginBottom = '18px';
      const lbl = document.createElement('label');
      lbl.textContent = q.prompt || ('Question ' + (i + 1));
      lbl.style.color = 'var(--text)';
      wrap.appendChild(lbl);
      if (q.type === 'choice') {
        const sel = document.createElement('select');
        sel.dataset.qid = qid;
        (q.options || []).forEach(o => {
          const op = document.createElement('option'); op.value = o; op.textContent = o; sel.appendChild(op);
        });
        wrap.appendChild(sel);
      } else if (q.type === 'scale') {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:12px';
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = 1; inp.max = 5; inp.value = 3; inp.dataset.qid = qid;
        const val = document.createElement('span');
        val.textContent = '3'; val.style.cssText = 'color:var(--text);min-width:1.5em;text-align:center';
        inp.oninput = () => { val.textContent = inp.value; };
        row.appendChild(inp); row.appendChild(val);
        wrap.appendChild(row);
      } else {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.dataset.qid = qid;
        wrap.appendChild(inp);
      }
      box.appendChild(wrap);
    });
    $('survey-submit').onclick = submitSurvey;
  }

  async function submitSurvey() {
    const btn = $('survey-submit');
    btn.disabled = true;
    const inputs = document.querySelectorAll('#survey-questions [data-qid]');
    const responses = [];
    inputs.forEach(el => responses.push({
      question_id: el.dataset.qid, value: el.value,
      response_time_ms: Date.now() - state.surveyStart,
    }));
    // Don't strand the participant on the survey if the save call fails — record
    // what we can, then always advance to the end screen.
    try { await API.post(`/api/session/${state.sessionId}/responses`, { responses }); }
    catch (e) { console.warn('survey save failed', e); }
    finishStudy();
  }

  // ---- 8. finish -------------------------------------------------------
  async function finishStudy() {
    try { state.engine && state.engine.stop(); } catch (e) {}
    await API.post(`/api/session/${state.sessionId}/complete`);
    show('end-stage');
    $('end-detail').textContent = 'Reference: ' + state.sessionId;
  }

  // ---- utils -----------------------------------------------------------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  boot();
})();
