# In-House Webcam Eye-Tracking Platform

A browser-based webcam gaze-estimation platform for **neuromarketing attention studies** —
an in-house alternative to RealEye for testing ads, packs, shelves, and landing pages.

This is the **MVP** described in the PRD: a WebGazer-based runtime behind a swappable
engine interface, with consent gating, device checks, calibration + validation, a stimulus
runtime, an analysis pipeline, a researcher dashboard, and CSV exports. It deliberately
does **not** attempt the full 12-month platform (custom ML engine, mobile, billing,
white-label) — those are designed-for but out of scope for v1 (PRD §2, §20).

> **Scientific stance:** suitable for *group-level* visual-attention patterns, not
> lab-grade or clinical inference. Heatmaps must always be read alongside AOI metrics.

---

## Quick start

Requires **Python 3.10+** and a webcam. From this folder:

```powershell
./run.ps1
```

Then open **http://localhost:8000/** for the researcher console.

The script creates a virtualenv, installs FastAPI/uvicorn, initializes a local SQLite
database, and serves everything (API + participant runtime + dashboard) from one process.

> Use **Chrome or Edge** for both the researcher and the participant, and always use
> **`localhost`** — *not* `127.0.0.1`. The webcam library (WebGazer) only allows camera
> access on `localhost` or HTTPS and explicitly rejects the `127.0.0.1` form. The app
> auto-redirects `127.0.0.1` → `localhost` to avoid this, but starting from `localhost`
> is cleanest.

### Manual start (any OS)

```bash
cd backend
python -m venv .venv && . .venv/Scripts/activate   # (or .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
python -m uvicorn app:app --port 8000
```

---

## How to run a study (end to end)

1. **New study** → give it a title, pick *Desktop only* (recommended for the MVP).
2. **Stimuli & AOIs** → upload one or more images, set display duration, and **drag
   rectangles** over each image to define Areas of Interest (the regions you want
   attention metrics for).
3. **Build** → optionally edit the consent text and add survey questions (JSON), then
   **▶ Activate study**.
4. **Participants** → generate participation links and share them. Each link is unique,
   single-use, and produces one auditable session.
5. Participant opens the link → consent → device check → face positioning → calibration →
   accuracy check → views the stimuli → optional survey → done.
6. **Results** → heatmaps, AOI tables (viewed-by %, TTFF, dwell, fixations, revisits),
   and per-participant QA.
7. **Exports** → download raw gaze, fixations, AOI summary, QA, events, and responses as CSV.

---

## Sending the study to a remote participant

The app runs on **your** machine at `localhost`, which only you can reach. To let
someone elsewhere take the study you need a public **HTTPS** URL (the webcam only
works over `localhost` or HTTPS).

**Simplest — one command** (starts the app + a public URL together):

```powershell
# one-time: install the tunnel tool
winget install --id Cloudflare.cloudflared

# every session: one command
./start-public.ps1
```

It prints a `https://<random>.trycloudflare.com` URL. **Open the researcher console at
that URL**, go to your study's **Participants** tab, **generate links there**, and share
the `…/study?token=…` links. Keep the window open while participants take the study;
press **Ctrl+C** to stop everything.

> The URL is new each run, so generate fresh participant links each session. Your data
> is unaffected — it persists locally in `backend\data\`.

### Temporary vs. permanent URL

- **Temporary (default):** `serve-public.ps1` gives a new random
  `https://<random>.trycloudflare.com` URL each run. Fine for one-off sessions, but you
  must regenerate participant links each time.
- **Permanent (same URL every time):** run the one-time setup below. Needs a free
  Cloudflare account **and a domain added to it**.
  ```powershell
  ./setup-tunnel.ps1 -Hostname study.yourdomain.com
  ```
  It logs you in (browser), creates a named tunnel, points `study.yourdomain.com` at it,
  and saves the config. After that, `./run.ps1` + `./serve-public.ps1` always serve the
  study at your fixed URL.

For a fully hands-off deployment (no PC kept on), use the included `Dockerfile` to deploy
to any HTTPS host (Render/Fly/Cloud Run/VPS); point `EYETRACK_DB` and `EYETRACK_STORAGE`
at a persistent volume so data survives restarts.

## Optional webcam recording

Off by default. In a study's **Build** tab you can enable *"Record participant webcam
video"*. When on, the participant is shown a **separate, explicit recording consent**
checkbox; only if they accept is their webcam recorded during the stimulus block and
stored. Each recording is viewable/downloadable from that participant's **replay** in the
Participants tab. The server refuses any recording upload that isn't backed by recording
consent. With recording off, webcam frames are never stored (PRD §14).

## Guardrails & checks (built in)

These map directly to the PRD's quality and privacy requirements (§13, §14, §18):

- **Consent gating** — the camera never starts before consent is accepted, and the
  *server rejects* any gaze/calibration data for a session that has no stored consent.
- **No video stored** — only gaze coordinates, quality indicators, device metadata, and
  survey answers are persisted. Raw webcam frames and face images are never uploaded.
- **Device check** — unsupported browser / screen / camera / device-type cases are
  flagged or blocked before the study begins.
- **Face positioning** — a stable face must be detected for ~2.5 s before calibration.
- **Validation with thresholds** — held-out points estimate error; sessions failing the
  median-error threshold trigger recalibration, capped at the configured retry limit,
  after which the session is marked a technical exclusion.
- **QA grading** — every completed session gets a `pass / warn / fail` grade with
  explicit exclusion reasons (low valid-sample %, face-lost %, off-screen %, low FPS,
  failed validation, completion-time outliers).
- **Reproducibility** — all thresholds live in `config/thresholds.json` and are stored
  with each QA report so any report can be reproduced from raw data.
- **Resilient capture** — gaze is uploaded in batches with retry + `localStorage`
  offline buffering, never one sample at a time.

Edit `config/thresholds.json` to tune calibration points, validation thresholds, QA
cutoffs, fixation parameters, and retention defaults.

---

## Architecture

```
frontend/                      Static SPA (no build step) — served by FastAPI
  index.html / js/admin.js     Researcher console: builder, AOI editor, dashboard, exports
  study.html / js/participant.js  Participant runtime (the journey)
  js/engine.js                 GazeEngine interface + WebGazerEngine (swappable — Route A/B/C)
  js/api.js                    API client + offline-buffered BatchQueue
backend/
  app.py                       FastAPI: API surface (PRD §10) + analysis trigger + exports
  db.py                        SQLite schema (PRD §9 data model)
  analysis.py                  Pipeline (PRD §11): smoothing, I-DT fixations, AOI, QA, heatmap
config/thresholds.json         All tunable thresholds (saved with each analysis run)
run.ps1                        One-command launcher
```

### Swapping the gaze engine (Route B/C)

The participant runtime only calls the `GazeEngine` interface
(`start / stop / addCalibrationSample / predict / getQuality / exportDebug`). To add a
MediaPipe/custom regression engine later, implement that interface in
`frontend/js/engine.js` and register it in `createEngine()` — no runtime changes needed.

---

## What's intentionally not built yet

Per the PRD's "do not overbuild" guidance (§2, §19): video stimulus analysis, polygon
AOIs in the editor (rect only for now — the analysis pipeline already supports polygons),
mobile-tuned thresholds, the MediaPipe engine, panel integration, billing, white-labeling,
and the RealEye benchmark harness. The data model, engine abstraction, and config system
are all designed so these slot in without rework.

---

## Validation before client use

Before using results with paying clients, run the PRD §15 validation: a 30–50 participant
technical validation against known targets, a stimulus validation against known
high-salience regions, and a RealEye benchmark on matched stimuli. Treat this tool as a
proprietary *aggregate attention* platform until it passes those checks.
