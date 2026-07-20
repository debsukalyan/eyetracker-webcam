// Turn MediaPipe FaceLandmarker output (478 normalized landmarks) into a compact
// gaze feature vector. The dominant signal is where each IRIS sits inside its eye
// socket; head pose + face scale let the regressor compensate for movement/distance.

// Canonical FaceMesh indices.
const RIGHT_EYE = { outer: 33, inner: 133, top: 159, bottom: 145 };  // subject's right
const LEFT_EYE  = { outer: 263, inner: 362, top: 386, bottom: 374 }; // subject's left
const IRIS_A = [468, 469, 470, 471, 472];
const IRIS_B = [473, 474, 475, 476, 477];
const NOSE = 1;

const centroid = (lm, idxs) => {
  let x = 0, y = 0;
  for (const i of idxs) { x += lm[i].x; y += lm[i].y; }
  return { x: x / idxs.length, y: y / idxs.length };
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function eyeRel(lm, eye, iris) {
  const outer = lm[eye.outer], inner = lm[eye.inner], top = lm[eye.top], bottom = lm[eye.bottom];
  // Offset of iris from the eye CENTRE, in image coordinates, normalized by eye size.
  // Using image-x/-y (not inner→outer) keeps the sign consistent across both eyes, so
  // they reinforce instead of cancelling when averaged.
  const cx = (outer.x + inner.x) / 2, cy = (top.y + bottom.y) / 2;
  const w = Math.abs(outer.x - inner.x) || 1e-6;
  const hgt = Math.abs(bottom.y - top.y) || 1e-6;
  const relX = (iris.x - cx) / w;                 // +ve = iris right of centre (image space)
  const relY = (iris.y - cy) / hgt;               // +ve = iris below centre
  const ear = dist(top, bottom) / (dist(outer, inner) || 1e-6); // openness
  return { relX, relY, ear };
}

// Extract the RAW per-eye components once; assemble a model feature vector from them
// with buildFeature(raw, eyeMode). eyeMode selects which eye(s) drive the gaze signal:
//   'both'  — average of the two irises (default for typical vision)
//   'right' / 'left' — single-eye. Critical for strabismus: a deviated eye's iris does
//   NOT point at the gaze target, and averaging it in poisons every sample. The engine
//   auto-selects the mode that predicts held-out calibration points best.
export function extractFeatures(landmarks) {
  if (!landmarks || landmarks.length < 478) return null;
  const lm = landmarks;

  // Assign the two iris centroids to the correct eye by horizontal proximity.
  // Iris horizontal diameters ride along: physical iris size is ~11.7mm for everyone,
  // so image diameter is a clean distance signal (∝ 1/distance).
  let irisR = centroid(lm, IRIS_A), irisL = centroid(lm, IRIS_B);
  let irisDR = dist(lm[469], lm[471]), irisDL = dist(lm[474], lm[476]);
  if (Math.abs(irisR.x - lm[RIGHT_EYE.outer].x) > Math.abs(irisL.x - lm[RIGHT_EYE.outer].x)) {
    [irisR, irisL] = [irisL, irisR];
    [irisDR, irisDL] = [irisDL, irisDR];
  }

  const R = eyeRel(lm, RIGHT_EYE, irisR);
  const L = eyeRel(lm, LEFT_EYE, irisL);

  // Head pose proxies from landmark geometry (convention-free, robust).
  const eR = lm[RIGHT_EYE.outer], eL = lm[LEFT_EYE.outer], nose = lm[NOSE];
  const eyeMid = { x: (eR.x + eL.x) / 2, y: (eR.y + eL.y) / 2 };
  const faceWidth = dist(eR, eL) || 1e-6;
  const yaw = (nose.x - eyeMid.x) / faceWidth;
  const pitch = (nose.y - eyeMid.y) / faceWidth;
  const roll = Math.atan2(eL.y - eR.y, eL.x - eR.x);

  const ear = (L.ear + R.ear) / 2;
  const raw = {
    Lx: L.relX, Ly: L.relY, Rx: R.relX, Ry: R.relY,
    earL: L.ear, earR: R.ear,
    irisDL: irisDL / faceWidth, irisDR: irisDR / faceWidth,
    yaw, pitch, roll, faceScale: faceWidth,
    faceCx: eyeMid.x, faceCy: eyeMid.y,      // for the head-position guard, not the model
  };
  return {
    raw,
    feature: buildFeature(raw, 'both'),      // back-compat default
    ear, faceScale: faceWidth, eyesOpen: ear > 0.12,
  };
}

export function buildFeature(raw, eyeMode = 'both') {
  // Single-eye modes EXCLUDE the other eye's dimensions entirely: a deviated eye's
  // features are noise, and even as "extra" inputs they degrade the kNN distance
  // metric and invite spurious fits. Each candidate model sees only clean inputs.
  let gx, gy, ear, eyeDims, earDims, irisDims;
  if (eyeMode === 'right') {
    gx = raw.Rx; gy = raw.Ry; ear = raw.earR;
    eyeDims = [raw.Rx, raw.Ry]; earDims = [raw.earR]; irisDims = [raw.irisDR];
  } else if (eyeMode === 'left') {
    gx = raw.Lx; gy = raw.Ly; ear = raw.earL;
    eyeDims = [raw.Lx, raw.Ly]; earDims = [raw.earL]; irisDims = [raw.irisDL];
  } else {
    gx = (raw.Lx + raw.Rx) / 2; gy = (raw.Ly + raw.Ry) / 2; ear = (raw.earL + raw.earR) / 2;
    eyeDims = [raw.Lx, raw.Ly, raw.Rx, raw.Ry];
    earDims = [raw.earL, raw.earR];
    irisDims = [raw.irisDL, raw.irisDR];
  }
  const gx2 = gx * gx, gy2 = gy * gy;
  return [
    gx, gy, ...eyeDims,
    gx2, gy2, gx * gy, gx * gx2, gy * gy2,         // nonlinear gaze terms
    ...earDims, ear, gy * ear,                     // eyelids: the strongest VERTICAL gaze cue
    ...irisDims,                                   // distance via iris diameter
    raw.yaw, raw.pitch, raw.roll, raw.faceScale,   // pose + distance (absolute position dropped)
    gx * raw.yaw, gy * raw.pitch, gx * raw.faceScale, gy * raw.faceScale,
  ];
}
