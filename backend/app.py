"""In-House Webcam/Mobile Eye-Tracking Platform — API + static host.

Single FastAPI service that:
  - serves the participant runtime and researcher dashboard (frontend/)
  - implements the API surface from PRD section 10
  - runs the analysis pipeline (analysis.py) on session completion
  - produces CSV/JSON exports (PRD sections 11, 12, 18)

Guardrails enforced server-side (defence in depth — the UI also enforces them):
  - no gaze rows accepted for a session until consent is stored
  - validation pass/fail computed against config thresholds; retries capped
  - QA grading + exclusion flags computed for every session
  - raw webcam video / face images are never accepted or stored (privacy, PRD 14)
"""
import csv
import io
import json
import os
import time

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import db
import analysis

app = FastAPI(title="In-House Eye-Tracking Platform", version="0.1.0")

BASE = os.path.dirname(__file__)
FRONTEND = os.path.join(BASE, "..", "frontend")
# Storage (uploaded stimuli + recordings) — point EYETRACK_STORAGE at a persistent
# volume in production so files survive restarts/redeploys.
STORAGE = os.environ.get("EYETRACK_STORAGE", os.path.join(BASE, "data", "storage"))
os.makedirs(STORAGE, exist_ok=True)


@app.on_event("startup")
def _startup():
    db.init_db()


@app.middleware("http")
async def no_cache(request: Request, call_next):
    """Disable browser caching of the frontend so code changes always take effect
    on reload (avoids stale JS/CSS during active development)."""
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


def now_ms():
    return int(time.time() * 1000)


# ===========================================================================
# Studies
# ===========================================================================
@app.post("/api/studies")
async def create_study(req: Request):
    body = await req.json()
    sid = db.new_id("study")
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO studies (id,org_id,title,description,type,status,device_allowed,"
            "consent_version,consent_text,config_json,created_by,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, "org_default", body.get("title", "Untitled study"),
             body.get("description", ""), body.get("type", "image"), "draft",
             body.get("device_allowed", "desktop"), body.get("consent_version", "v1"),
             body.get("consent_text", DEFAULT_CONSENT),
             json.dumps(body.get("config", {})), "user_admin", now_ms()),
        )
    return get_study(sid)


@app.get("/api/studies")
def list_studies():
    with db.get_conn() as conn:
        rows = conn.execute("SELECT * FROM studies ORDER BY created_at DESC").fetchall()
        out = []
        for r in rows:
            s = db.row_to_dict(r)
            s["counts"] = _study_counts(conn, s["id"])
            out.append(s)
    return {"studies": out}


@app.get("/api/studies/{sid}")
def get_study(sid: str):
    with db.get_conn() as conn:
        r = conn.execute("SELECT * FROM studies WHERE id=?", (sid,)).fetchone()
        if not r:
            raise HTTPException(404, "study not found")
        study = db.row_to_dict(r)
        study["stimuli"] = [_stimulus_with_aois(conn, db.row_to_dict(s))
                            for s in conn.execute(
                "SELECT * FROM stimuli WHERE study_id=? ORDER BY order_index", (sid,)).fetchall()]
        study["counts"] = _study_counts(conn, sid)
    return study


@app.patch("/api/studies/{sid}")
async def update_study(sid: str, req: Request):
    body = await req.json()
    allowed = {"title", "description", "type", "status", "device_allowed",
               "consent_version", "consent_text"}
    sets, vals = [], []
    for k, v in body.items():
        if k in allowed:
            sets.append(f"{k}=?")
            vals.append(v)
        elif k == "config":
            sets.append("config_json=?")
            vals.append(json.dumps(v))
    if sets:
        vals.append(sid)
        with db.get_conn() as conn:
            conn.execute(f"UPDATE studies SET {','.join(sets)} WHERE id=?", vals)
    return get_study(sid)


@app.delete("/api/studies/{sid}")
def delete_study(sid: str):
    """Delete a study and everything under it (stimuli, AOIs, participants, sessions,
    gaze, fixations, events, responses, QA, exports). Irreversible."""
    with db.get_conn() as conn:
        if not conn.execute("SELECT id FROM studies WHERE id=?", (sid,)).fetchone():
            raise HTTPException(404, "study not found")
        sess_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM sessions WHERE study_id=?", (sid,)).fetchall()]
        trial_ids = [r["id"] for r in conn.execute(
            "SELECT id FROM trials WHERE session_id IN "
            "(SELECT id FROM sessions WHERE study_id=?)", (sid,)).fetchall()]

        def _del_in(table, col, ids):
            for i in range(0, len(ids), 400):
                chunk = ids[i:i + 400]
                ph = ",".join(["?"] * len(chunk))
                conn.execute(f"DELETE FROM {table} WHERE {col} IN ({ph})", chunk)

        if trial_ids:
            _del_in("fixations", "trial_id", trial_ids)
        if sess_ids:
            for t in ("gaze_samples", "events", "responses", "qa_reports",
                      "validations", "calibrations", "trials"):
                _del_in(t, "session_id", sess_ids)
        conn.execute("DELETE FROM aois WHERE stimulus_id IN "
                     "(SELECT id FROM stimuli WHERE study_id=?)", (sid,))
        conn.execute("DELETE FROM stimuli WHERE study_id=?", (sid,))
        conn.execute("DELETE FROM sessions WHERE study_id=?", (sid,))
        conn.execute("DELETE FROM participants WHERE study_id=?", (sid,))
        conn.execute("DELETE FROM study_conditions WHERE study_id=?", (sid,))
        conn.execute("DELETE FROM exports WHERE study_id=?", (sid,))
        conn.execute("DELETE FROM studies WHERE id=?", (sid,))
    return {"ok": True, "deleted": sid}


def _study_counts(conn, sid):
    total = conn.execute(
        "SELECT COUNT(*) c FROM participants WHERE study_id=?", (sid,)).fetchone()["c"]
    completed = conn.execute(
        "SELECT COUNT(*) c FROM participants WHERE study_id=? AND status='complete'",
        (sid,)).fetchone()["c"]
    usable = conn.execute(
        "SELECT COUNT(*) c FROM qa_reports q JOIN sessions s ON q.session_id=s.id "
        "WHERE s.study_id=? AND q.quality_grade IN ('pass','warn')", (sid,)).fetchone()["c"]
    return {"participants": total, "completed": completed, "usable": usable}


# ===========================================================================
# Stimuli + AOIs
# ===========================================================================
@app.post("/api/studies/{sid}/stimuli")
async def upload_stimulus(sid: str, file: UploadFile = File(...),
                          duration_ms: int = Form(5000),
                          type: str = Form("image"),
                          width_px: int = Form(0),
                          height_px: int = Form(0)):
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"}:
        raise HTTPException(400, "unsupported stimulus file type")
    stid = db.new_id("stim")
    fname = f"{stid}{ext}"
    path = os.path.join(STORAGE, fname)
    data = await file.read()
    with open(path, "wb") as f:      # local fast path
        f.write(data)
    # Also persist to the DB so it survives an ephemeral-disk wipe (hosted free tier).
    db.save_blob(fname, file.content_type, data)
    with db.get_conn() as conn:
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index),-1)+1 n FROM stimuli WHERE study_id=?",
            (sid,)).fetchone()["n"]
        conn.execute(
            "INSERT INTO stimuli (id,study_id,condition_id,type,file_url,duration_ms,"
            "width_px,height_px,order_index) VALUES (?,?,?,?,?,?,?,?,?)",
            (stid, sid, None, type, f"/storage/{fname}", duration_ms,
             width_px or 1000, height_px or 1000, order))
    return {"id": stid, "file_url": f"/storage/{fname}", "order_index": order}


@app.post("/api/studies/{sid}/stimuli/url")
async def add_url_stimulus(sid: str, req: Request):
    """A live website as a stimulus: no file, just a URL the runtime loads in an
    iframe and tracks gaze over. file_url holds the URL; type='url'."""
    body = await req.json()
    url = (body.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "URL must start with http:// or https://")
    stid = db.new_id("stim")
    duration_ms = int(body.get("duration_ms") or 15000)
    with db.get_conn() as conn:
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index),-1)+1 n FROM stimuli WHERE study_id=?",
            (sid,)).fetchone()["n"]
        conn.execute(
            "INSERT INTO stimuli (id,study_id,condition_id,type,file_url,duration_ms,"
            "width_px,height_px,order_index) VALUES (?,?,?,?,?,?,?,?,?)",
            (stid, sid, None, "url", url, duration_ms, 0, 0, order))
    return {"id": stid, "file_url": url, "type": "url", "order_index": order}


@app.get("/api/studies/{sid}/stimuli")
def list_stimuli(sid: str):
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM stimuli WHERE study_id=? ORDER BY order_index", (sid,)).fetchall()
        return {"stimuli": [_stimulus_with_aois(conn, db.row_to_dict(r)) for r in rows]}


@app.delete("/api/stimuli/{stid}")
def delete_stimulus(stid: str):
    with db.get_conn() as conn:
        conn.execute("DELETE FROM aois WHERE stimulus_id=?", (stid,))
        conn.execute("DELETE FROM stimuli WHERE id=?", (stid,))
    return {"ok": True}


def _stimulus_with_aois(conn, stim):
    stim["aois"] = [db.row_to_dict(a) for a in conn.execute(
        "SELECT * FROM aois WHERE stimulus_id=?", (stim["id"],)).fetchall()]
    return stim


@app.post("/api/stimuli/{stid}/aois")
async def create_aoi(stid: str, req: Request):
    body = await req.json()
    aid = db.new_id("aoi")
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO aois (id,stimulus_id,name,shape_type,coordinates_json,start_ms,"
            "end_ms,parent_aoi_id) VALUES (?,?,?,?,?,?,?,?)",
            (aid, stid, body.get("name", "AOI"), body.get("shape_type", "rect"),
             json.dumps(body.get("coordinates", {})), body.get("start_ms"),
             body.get("end_ms"), body.get("parent_aoi_id")))
        return db.row_to_dict(conn.execute("SELECT * FROM aois WHERE id=?", (aid,)).fetchone())


@app.patch("/api/aois/{aid}")
async def update_aoi(aid: str, req: Request):
    body = await req.json()
    sets, vals = [], []
    for k in ("name", "shape_type", "start_ms", "end_ms"):
        if k in body:
            sets.append(f"{k}=?")
            vals.append(body[k])
    if "coordinates" in body:
        sets.append("coordinates_json=?")
        vals.append(json.dumps(body["coordinates"]))
    if sets:
        vals.append(aid)
        with db.get_conn() as conn:
            conn.execute(f"UPDATE aois SET {','.join(sets)} WHERE id=?", vals)
    return {"ok": True}


@app.delete("/api/aois/{aid}")
def delete_aoi(aid: str):
    with db.get_conn() as conn:
        conn.execute("DELETE FROM aois WHERE id=?", (aid,))
    return {"ok": True}


# ===========================================================================
# Participants (token generation) — researcher side
# ===========================================================================
@app.post("/api/studies/{sid}/participants")
async def create_participants(sid: str, req: Request):
    body = await req.json()
    n = int(body.get("count", 1))
    source = body.get("source", "manual")
    created = []
    with db.get_conn() as conn:
        for _ in range(n):
            pid = db.new_id("p")
            token = db.new_id()
            conn.execute(
                "INSERT INTO participants (id,study_id,token,source,demographics_json,"
                "status,consented_at,completed_at) VALUES (?,?,?,?,?,?,?,?)",
                (pid, sid, token, source, "{}", "invited", None, None))
            created.append({"id": pid, "token": token, "link": f"/study?token={token}"})
    return {"participants": created}


@app.get("/api/studies/{sid}/participants")
def list_participants(sid: str):
    with db.get_conn() as conn:
        # One row per participant, showing their most recent session's QA/validation.
        # We pick that session with a correlated subquery instead of GROUP BY p.id:
        # SQLite tolerates selecting non-aggregated columns alongside GROUP BY (it
        # returns an arbitrary row), but Postgres rejects it outright, which 500'd
        # this endpoint on the hosted deploy. The subquery is portable to both.
        rows = conn.execute(
            "SELECT p.*, s.id AS session_id, s.recording_url, s.started_at, s.ended_at, "
            "q.quality_grade, q.exclusion_reason, q.valid_sample_pct, q.face_lost_pct, "
            "q.offscreen_pct, q.fps_median, v.median_error_px, v.passed AS validation_passed "
            "FROM participants p "
            "LEFT JOIN sessions s ON s.id = ("
            "  SELECT s2.id FROM sessions s2 WHERE s2.participant_id = p.id "
            "  ORDER BY s2.started_at DESC LIMIT 1) "
            "LEFT JOIN qa_reports q ON q.session_id=s.id "
            "LEFT JOIN validations v ON v.session_id=s.id "
            "WHERE p.study_id=? ORDER BY p.id", (sid,)).fetchall()
        return {"participants": [dict(r) for r in rows]}


# ===========================================================================
# Participant runtime endpoints (PRD section 10)
# ===========================================================================
@app.post("/api/participant/start")
async def participant_start(req: Request):
    body = await req.json()
    token = body.get("token")
    with db.get_conn() as conn:
        p = conn.execute("SELECT * FROM participants WHERE token=?", (token,)).fetchone()
        if not p:
            raise HTTPException(404, "invalid participant token")
        p = db.row_to_dict(p)
        if p["status"] == "complete":
            raise HTTPException(409, "this participant link is already completed")
        # Prevent duplicate active sessions; reuse only a RECENT incomplete session.
        # Resuming a days-old session mixes its stale gaze samples into the new run's
        # QA (observed: a 7/12 session resumed on 7/14 reported 52.5% valid).
        existing = conn.execute(
            "SELECT * FROM sessions WHERE participant_id=? AND status!='complete' "
            "ORDER BY started_at DESC LIMIT 1", (p["id"],)).fetchone()
        if existing and (now_ms() - (existing["started_at"] or 0)) < 2 * 3600 * 1000:
            session_id = existing["id"]
        else:
            session_id = db.new_id("sess")
            conn.execute(
                "INSERT INTO sessions (id,participant_id,study_id,started_at,status) "
                "VALUES (?,?,?,?,?)", (session_id, p["id"], p["study_id"], now_ms(), "started"))
            conn.execute("UPDATE participants SET status='started' WHERE id=?", (p["id"],))
        study = get_study(p["study_id"])
    return {"session_id": session_id, "participant_id": p["id"], "study": study}


@app.post("/api/session/{sess}/consent")
async def store_consent(sess: str, req: Request):
    body = await req.json()
    if not body.get("accepted"):
        raise HTTPException(400, "consent not accepted")
    rec = 1 if body.get("recording_accepted") else 0
    with db.get_conn() as conn:
        s = conn.execute("SELECT participant_id FROM sessions WHERE id=?", (sess,)).fetchone()
        if not s:
            raise HTTPException(404, "session not found")
        conn.execute(
            "UPDATE participants SET consented_at=?, status='consented', recording_consented=? "
            "WHERE id=?", (now_ms(), rec, s["participant_id"]))
        conn.execute("UPDATE sessions SET status='consented' WHERE id=?", (sess,))
    return {"ok": True, "consented_at": now_ms(), "recording_consented": bool(rec)}


def _require_consent(conn, sess):
    row = conn.execute(
        "SELECT p.consented_at FROM sessions s JOIN participants p ON p.id=s.participant_id "
        "WHERE s.id=?", (sess,)).fetchone()
    if not row:
        raise HTTPException(404, "session not found")
    if not row["consented_at"]:
        raise HTTPException(403, "consent required before any gaze/camera data is accepted")


@app.post("/api/session/{sess}/recording")
async def store_recording(sess: str, file: UploadFile = File(...)):
    """Optional webcam session recording. Only accepted when the participant gave the
    separate recording consent (PRD §14)."""
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT p.recording_consented, p.consented_at FROM sessions s "
            "JOIN participants p ON p.id=s.participant_id WHERE s.id=?", (sess,)).fetchone()
        if not row:
            raise HTTPException(404, "session not found")
        if not row["consented_at"]:
            raise HTTPException(403, "consent required")
        if not row["recording_consented"]:
            raise HTTPException(403, "participant did not consent to recording")
    ext = os.path.splitext(file.filename or "")[1].lower() or ".webm"
    fname = f"rec_{sess}{ext}"
    data = await file.read()
    with open(os.path.join(STORAGE, fname), "wb") as f:
        f.write(data)
    db.save_blob(fname, file.content_type, data)   # survive ephemeral-disk wipe
    with db.get_conn() as conn:
        conn.execute("UPDATE sessions SET recording_url=? WHERE id=?",
                     (f"/storage/{fname}", sess))
    return {"ok": True, "recording_url": f"/storage/{fname}"}


@app.post("/api/session/{sess}/screen-recording")
async def store_screen_recording(sess: str, file: UploadFile = File(...),
                                 gaze_track: str = Form("[]")):
    """Screen recording of the study (what the participant actually saw — scrolling
    websites, playing videos) + a time-synced screen-normalized gaze track for the
    replay overlay. gaze_track is JSON: [[t_ms_from_recording_start, x, y], ...]
    with x,y normalized to the viewport (0..1)."""
    with db.get_conn() as conn:
        if not conn.execute("SELECT id FROM sessions WHERE id=?", (sess,)).fetchone():
            raise HTTPException(404, "session not found")
    ext = os.path.splitext(file.filename or "")[1].lower() or ".webm"
    fname = f"screen_{sess}{ext}"
    data = await file.read()
    try:
        with open(os.path.join(STORAGE, fname), "wb") as f:
            f.write(data)
    except Exception:
        pass
    db.save_blob(fname, file.content_type, data)   # survive ephemeral-disk wipe
    with db.get_conn() as conn:
        conn.execute("UPDATE sessions SET screen_recording_url=?, screen_gaze_json=? WHERE id=?",
                     (f"/storage/{fname}", gaze_track or "[]", sess))
    return {"ok": True, "screen_recording_url": f"/storage/{fname}"}


@app.get("/api/session/{sess}/screen-replay")
def get_screen_replay(sess: str):
    """Replay payload: the screen recording URL + the synced gaze track."""
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT screen_recording_url, screen_gaze_json FROM sessions WHERE id=?",
            (sess,)).fetchone()
    if not row:
        raise HTTPException(404, "session not found")
    try:
        gaze = json.loads(row["screen_gaze_json"] or "[]")
    except (ValueError, TypeError):
        gaze = []
    return {"screen_recording_url": row["screen_recording_url"], "gaze": gaze}


@app.post("/api/session/{sess}/device")
async def store_device(sess: str, req: Request):
    body = await req.json()
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE sessions SET device_json=?, browser_json=?, screen_width=?, "
            "screen_height=?, dpr=?, timezone=?, engine=? WHERE id=?",
            (json.dumps(body.get("device", {})), json.dumps(body.get("browser", {})),
             body.get("screen_width"), body.get("screen_height"), body.get("dpr"),
             body.get("timezone"), body.get("engine", "webgazer"), sess))
    return {"ok": True}


@app.post("/api/session/{sess}/calibration")
async def store_calibration(sess: str, req: Request):
    body = await req.json()
    with db.get_conn() as conn:
        _require_consent(conn, sess)
        cid = db.new_id("cal")
        conn.execute(
            "INSERT INTO calibrations (id,session_id,engine,points_json,model_params_json,"
            "calibration_quality_json,created_at) VALUES (?,?,?,?,?,?,?)",
            (cid, sess, body.get("engine", "webgazer"),
             json.dumps(body.get("points", [])), json.dumps(body.get("model_params", {})),
             json.dumps(body.get("quality", {})), now_ms()))
    return {"ok": True, "calibration_id": cid}


@app.post("/api/session/{sess}/validation")
async def store_validation(sess: str, req: Request):
    body = await req.json()
    cfg = analysis.load_config()
    # Keep only finite numbers — a dropped/NaN prediction must not 500 the request.
    errors = [float(e) for e in body.get("errors_px", [])
              if isinstance(e, (int, float)) and e == e]  # per-point euclidean error
    device = body.get("device_type", "desktop")
    thresh = cfg["validation"][
        "pass_median_error_px_mobile" if device == "mobile" else "pass_median_error_px_desktop"]
    median_err = analysis._median(errors) if errors else None
    mean_err = sum(errors) / len(errors) if errors else None
    precision = (max(errors) - min(errors)) if errors else None
    retry = int(body.get("retry_count", 0))
    passed = bool(median_err is not None and median_err <= thresh)
    with db.get_conn() as conn:
        _require_consent(conn, sess)
        vid = db.new_id("val")
        conn.execute(
            "INSERT INTO validations (id,session_id,mean_error_px,median_error_px,precision_px,"
            "passed,retry_count,details_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (vid, sess, mean_err, median_err, precision, 1 if passed else 0, retry,
             json.dumps({"errors_px": errors, "points": body.get("points"),
                         "threshold_px": thresh, "device_type": device}),
             now_ms()))
    max_retries = cfg["calibration"]["max_retries"]
    return {
        "passed": passed, "median_error_px": median_err, "threshold_px": thresh,
        "retry_count": retry, "retries_remaining": max(0, max_retries - retry),
        "must_stop": (not passed and retry >= max_retries),
    }


@app.post("/api/session/{sess}/trial")
async def create_trial(sess: str, req: Request):
    body = await req.json()
    tid = db.new_id("trial")
    with db.get_conn() as conn:
        _require_consent(conn, sess)
        conn.execute(
            "INSERT INTO trials (id,session_id,stimulus_id,condition_id,trial_index,"
            "planned_onset_ts,onset_ts,first_frame_ts,offset_ts,completed) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (tid, sess, body.get("stimulus_id"), body.get("condition_id"),
             body.get("trial_index", 0), body.get("planned_onset_ts"),
             body.get("onset_ts"), body.get("first_frame_ts"), None, 0))
    return {"trial_id": tid}


@app.patch("/api/trial/{tid}")
async def update_trial(tid: str, req: Request):
    body = await req.json()
    with db.get_conn() as conn:
        conn.execute("UPDATE trials SET offset_ts=?, completed=1 WHERE id=?",
                     (body.get("offset_ts", now_ms()), tid))
    return {"ok": True}


@app.post("/api/session/{sess}/gaze/batch")
async def gaze_batch(sess: str, req: Request):
    body = await req.json()
    samples = body.get("samples", [])
    with db.get_conn() as conn:
        _require_consent(conn, sess)
        conn.executemany(
            "INSERT INTO gaze_samples (trial_id,session_id,timestamp_ms,raw_x,raw_y,"
            "smooth_x,smooth_y,confidence,face_present,eye_present,fps,offscreen) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(s.get("trial_id"), sess, s.get("t"), s.get("x"), s.get("y"), None, None,
              s.get("confidence"), 1 if s.get("face_present") else 0,
              1 if s.get("eye_present", s.get("face_present")) else 0, s.get("fps"),
              1 if s.get("offscreen") else 0) for s in samples])
    return {"ok": True, "stored": len(samples)}


@app.post("/api/session/{sess}/events/batch")
async def events_batch(sess: str, req: Request):
    body = await req.json()
    events = body.get("events", [])
    with db.get_conn() as conn:
        conn.executemany(
            "INSERT INTO events (session_id,trial_id,event_type,timestamp_ms,x,y,value_json) "
            "VALUES (?,?,?,?,?,?,?)",
            [(sess, e.get("trial_id"), e.get("event_type"), e.get("t"), e.get("x"),
              e.get("y"), json.dumps(e.get("value", {}))) for e in events])
    return {"ok": True, "stored": len(events)}


@app.post("/api/session/{sess}/responses")
async def store_responses(sess: str, req: Request):
    body = await req.json()
    with db.get_conn() as conn:
        for r in body.get("responses", []):
            conn.execute(
                "INSERT INTO responses (id,session_id,question_id,response_value,response_time_ms) "
                "VALUES (?,?,?,?,?)",
                (db.new_id("resp"), sess, r.get("question_id"),
                 json.dumps(r.get("value")), r.get("response_time_ms")))
    return {"ok": True}


@app.post("/api/session/{sess}/complete")
def complete_session(sess: str):
    with db.get_conn() as conn:
        s = conn.execute("SELECT participant_id FROM sessions WHERE id=?", (sess,)).fetchone()
        if not s:
            raise HTTPException(404, "session not found")
        conn.execute("UPDATE sessions SET ended_at=?, status='complete' WHERE id=?",
                     (now_ms(), sess))
        conn.execute("UPDATE participants SET status='complete', completed_at=? WHERE id=?",
                     (now_ms(), s["participant_id"]))
    _process_session(sess)  # QA + fixations immediately so dashboards are live
    return {"ok": True}


# ===========================================================================
# Analysis pipeline (PRD section 11)
# ===========================================================================
def _process_session(sess: str):
    cfg = analysis.load_config()
    with db.get_conn() as conn:
        trials = [db.row_to_dict(t) for t in conn.execute(
            "SELECT * FROM trials WHERE session_id=?", (sess,)).fetchall()]
        validation = db.row_to_dict(conn.execute(
            "SELECT * FROM validations WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
            (sess,)).fetchone())
        all_samples, fps_values = [], []
        conn.execute("DELETE FROM fixations WHERE trial_id IN "
                     "(SELECT id FROM trials WHERE session_id=?)", (sess,))
        for tr in trials:
            stim = db.row_to_dict(conn.execute(
                "SELECT * FROM stimuli WHERE id=?", (tr["stimulus_id"],)).fetchone()) or {}
            aois = [db.row_to_dict(a) for a in conn.execute(
                "SELECT * FROM aois WHERE stimulus_id=?", (tr["stimulus_id"],)).fetchall()]
            rows = conn.execute(
                "SELECT * FROM gaze_samples WHERE trial_id=? ORDER BY timestamp_ms",
                (tr["id"],)).fetchall()
            samples = [db.row_to_dict(r) for r in rows]
            all_samples.extend(samples)
            fps_values.extend([s["fps"] for s in samples if s.get("fps")])

            onset = tr.get("onset_ts") or (samples[0]["timestamp_ms"] if samples else 0)
            # Build (x,y,t) in normalized stimulus space; valid samples only.
            valid = [s for s in samples if s.get("face_present") and not s.get("offscreen")
                     and s.get("raw_x") is not None]
            w = stim.get("width_px") or 1000
            h = stim.get("height_px") or 1000
            pts = [{"x": s["raw_x"] * w, "y": s["raw_y"] * h, "t": s["timestamp_ms"] - onset}
                   for s in valid]
            xs = analysis.moving_median([p["x"] for p in pts], cfg["smoothing"]["window"])
            ys = analysis.moving_median([p["y"] for p in pts], cfg["smoothing"]["window"])
            for p, sx, sy in zip(pts, xs, ys):
                p["x"], p["y"] = sx, sy
            fixes = analysis.detect_fixations_idt(
                pts, cfg["fixation"]["dispersion_px"], cfg["fixation"]["min_duration_ms"])
            for fx in fixes:
                nx, ny = fx["x"] / w, fx["y"] / h
                assigned = None
                for a in aois:
                    if analysis.point_in_aoi(nx, ny, fx["start_ms"], a):
                        assigned = a["id"]
                        break
                conn.execute(
                    "INSERT INTO fixations (id,trial_id,start_ms,end_ms,duration_ms,x,y,"
                    "assigned_aoi_id) VALUES (?,?,?,?,?,?,?,?)",
                    (db.new_id("fix"), tr["id"], fx["start_ms"], fx["end_ms"],
                     fx["duration_ms"], nx, ny, assigned))

        qa = analysis.compute_qa(all_samples, fps_values, validation, cfg)
        conn.execute("DELETE FROM qa_reports WHERE session_id=?", (sess,))
        conn.execute(
            "INSERT INTO qa_reports (id,session_id,valid_sample_pct,face_lost_pct,offscreen_pct,"
            "fps_median,quality_grade,exclusion_reason,thresholds_json,details_json,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (db.new_id("qa"), sess, qa["valid_sample_pct"], qa["face_lost_pct"],
             qa["offscreen_pct"], qa["fps_median"], qa["quality_grade"],
             qa["exclusion_reason"], json.dumps(qa["thresholds"]),
             json.dumps(qa["details"]), now_ms()))
    return qa


@app.post("/api/studies/{sid}/process")
def reprocess_study(sid: str):
    with db.get_conn() as conn:
        sessions = [r["id"] for r in conn.execute(
            "SELECT id FROM sessions WHERE study_id=? AND status='complete'", (sid,)).fetchall()]
    for sess in sessions:
        _process_session(sess)
    return {"ok": True, "processed_sessions": len(sessions)}


# ===========================================================================
# Dashboard data (PRD section 12)
# ===========================================================================
@app.get("/api/studies/{sid}/overview")
def study_overview(sid: str):
    with db.get_conn() as conn:
        study = db.row_to_dict(conn.execute("SELECT * FROM studies WHERE id=?", (sid,)).fetchone())
        if not study:
            raise HTTPException(404, "study not found")
        counts = _study_counts(conn, sid)
        device_rows = conn.execute(
            "SELECT device_json FROM sessions WHERE study_id=? AND status='complete'",
            (sid,)).fetchall()
        device_split = {}
        for r in device_rows:
            try:
                dj = json.loads(r["device_json"] or "{}")
                key = dj.get("type", "unknown")
            except (ValueError, TypeError):
                key = "unknown"
            device_split[key] = device_split.get(key, 0) + 1
        grades = conn.execute(
            "SELECT q.quality_grade, COUNT(*) c FROM qa_reports q JOIN sessions s "
            "ON q.session_id=s.id WHERE s.study_id=? GROUP BY q.quality_grade", (sid,)).fetchall()
        grade_split = {r["quality_grade"]: r["c"] for r in grades}
        excluded = grade_split.get("fail", 0)
        completion = round(100 * counts["completed"] / counts["participants"], 1) if counts["participants"] else 0
    return {
        "study": study, "counts": counts, "device_split": device_split,
        "grade_split": grade_split, "excluded": excluded, "completion_rate": completion,
    }


@app.get("/api/studies/{sid}/benchmark")
def study_benchmark(sid: str):
    """Aggregate accuracy/QA across all completed sessions (PRD §15 validation artifact).

    This is the honest 'vs RealEye' report: a distribution of accuracy across sessions,
    per-screen-region error, QA pass rates, and model held-out error — not a single run.
    """
    with db.get_conn() as conn:
        sessions = [r["id"] for r in conn.execute(
            "SELECT id FROM sessions WHERE study_id=? AND status='complete'", (sid,)).fetchall()]
        val_medians, held_out, region = [], [], {}
        grade_counts = {"pass": 0, "warn": 0, "fail": 0}
        eye_modes = {}
        for sess in sessions:
            v = db.row_to_dict(conn.execute(
                "SELECT median_error_px, details_json FROM validations WHERE session_id=? "
                "ORDER BY created_at DESC LIMIT 1", (sess,)).fetchone())
            if v and v.get("median_error_px") is not None:
                val_medians.append(v["median_error_px"])
                det = v.get("details") or {}
                pts, errs = det.get("points") or [], det.get("errors_px") or []
                for i, p in enumerate(pts):
                    if i < len(errs) and errs[i] is not None:
                        key = f"{int(round(p['x']*100))},{int(round(p['y']*100))}"
                        region.setdefault(key, []).append(errs[i])
            q = conn.execute(
                "SELECT quality_grade FROM qa_reports WHERE session_id=?", (sess,)).fetchone()
            if q and q["quality_grade"] in grade_counts:
                grade_counts[q["quality_grade"]] += 1
            c = db.row_to_dict(conn.execute(
                "SELECT model_params_json FROM calibrations WHERE session_id=? "
                "ORDER BY created_at DESC LIMIT 1", (sess,)).fetchone())
            mp = (c or {}).get("model_params") or {}
            if mp.get("eye_mode"):
                eye_modes[mp["eye_mode"]] = eye_modes.get(mp["eye_mode"], 0) + 1
            if mp.get("eye_mode_errors_px", {}).get("both") is not None:
                held_out.append(mp["eye_mode_errors_px"]["both"])

    def stats(a):
        if not a:
            return None
        s = sorted(a)
        return {"n": len(a), "min": round(min(a), 1), "max": round(max(a), 1),
                "median": round(s[len(s) // 2], 1), "mean": round(sum(a) / len(a), 1)}

    regions = [{"x": int(k.split(",")[0]), "y": int(k.split(",")[1]),
                "mean_px": round(sum(v) / len(v), 1), "n": len(v)}
               for k, v in region.items()]
    regions.sort(key=lambda r: (r["y"], r["x"]))
    usable = grade_counts["pass"] + grade_counts["warn"]
    total = sum(grade_counts.values())
    return {
        "n_sessions": len(sessions),
        "validation_px": stats(val_medians),
        "model_heldout_px": stats(held_out),
        "regions": regions,
        "grade_counts": grade_counts,
        "eye_modes": eye_modes,
        "usable_pct": round(100 * usable / total, 1) if total else 0,
        "realeye_ref_px": 106,
    }


@app.get("/api/studies/{sid}/sessions")
def list_sessions(sid: str):
    """Completed sessions with their start/end times + QA grade (for the Results selector)."""
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT s.id AS session_id, s.participant_id, s.started_at, s.ended_at, s.status, "
            "s.recording_url, s.screen_recording_url, "
            "q.quality_grade, q.valid_sample_pct, v.median_error_px "
            "FROM sessions s "
            "LEFT JOIN qa_reports q ON q.session_id=s.id "
            "LEFT JOIN validations v ON v.session_id=s.id "
            "WHERE s.study_id=? AND s.status='complete' "
            "ORDER BY s.ended_at DESC", (sid,)).fetchall()
        return {"sessions": [dict(r) for r in rows]}


@app.get("/api/stimuli/{stid}/analysis")
def stimulus_analysis(stid: str, include: str = "usable", session: str = None):
    """Heatmap points + AOI summary table for one stimulus (PRD 12).

    Pass ?session=<id> to restrict the analysis to a single session; otherwise the
    result aggregates across sessions selected by QA grade (?include=usable|all)."""
    with db.get_conn() as conn:
        stim = db.row_to_dict(conn.execute("SELECT * FROM stimuli WHERE id=?", (stid,)).fetchone())
        if not stim:
            raise HTTPException(404, "stimulus not found")
        aois = [db.row_to_dict(a) for a in conn.execute(
            "SELECT * FROM aois WHERE stimulus_id=?", (stid,)).fetchall()]
        params = [stid]
        if session:
            extra = "AND t.session_id = ?"
            params.append(session)
        else:
            extra = "" if include == "all" else "AND q.quality_grade IN ('pass','warn')"
        fix_rows = conn.execute(
            f"SELECT f.*, t.session_id FROM fixations f "
            f"JOIN trials t ON f.trial_id=t.id "
            f"LEFT JOIN qa_reports q ON q.session_id=t.session_id "
            f"WHERE t.stimulus_id=? {extra}", params).fetchall()
        fixations = [dict(r) for r in fix_rows]
        # group fixations by participant (via session)
        by_part = {}
        for f in fixations:
            by_part.setdefault(f["session_id"], []).append(f)
        summaries = [analysis.aoi_summary(by_part, a) for a in aois]
        summaries = [s for s in summaries if s]
        # heatmap: normalized fixation points weighted by duration
        pts = [{"x": f["x"], "y": f["y"]} for f in fixations]
    return {
        "stimulus": stim, "aois": aois, "aoi_summary": summaries,
        "n_sessions": len(by_part),
        "heatmap_points": [{"x": p["x"], "y": p["y"]} for p in pts],
    }


@app.get("/api/session/{sess}/replay")
def session_replay(sess: str):
    with db.get_conn() as conn:
        trials = [db.row_to_dict(t) for t in conn.execute(
            "SELECT * FROM trials WHERE session_id=? ORDER BY trial_index", (sess,)).fetchall()]
        for tr in trials:
            tr["samples"] = [dict(r) for r in conn.execute(
                "SELECT timestamp_ms,raw_x,raw_y,face_present,offscreen FROM gaze_samples "
                "WHERE trial_id=? ORDER BY timestamp_ms", (tr["id"],)).fetchall()]
            tr["fixations"] = [dict(r) for r in conn.execute(
                "SELECT * FROM fixations WHERE trial_id=? ORDER BY start_ms", (tr["id"],)).fetchall()]
        qa = db.row_to_dict(conn.execute(
            "SELECT * FROM qa_reports WHERE session_id=?", (sess,)).fetchone())
        sess_row = conn.execute(
            "SELECT recording_url, started_at, ended_at FROM sessions WHERE id=?",
            (sess,)).fetchone()
        # Diagnostics: latest validation (per-point errors) + eye mode from calibration.
        val = db.row_to_dict(conn.execute(
            "SELECT median_error_px, passed, retry_count, details_json FROM validations "
            "WHERE session_id=? ORDER BY created_at DESC LIMIT 1", (sess,)).fetchone())
        cal = db.row_to_dict(conn.execute(
            "SELECT model_params_json FROM calibrations WHERE session_id=? "
            "ORDER BY created_at DESC LIMIT 1", (sess,)).fetchone())
    rec = dict(sess_row) if sess_row else {}
    eye = (cal or {}).get("model_params") or {}
    return {"trials": trials, "qa": qa, "recording_url": rec.get("recording_url"),
            "started_at": rec.get("started_at"), "ended_at": rec.get("ended_at"),
            "validation": val,
            "eye_mode": eye.get("eye_mode"), "eye_mode_errors_px": eye.get("eye_mode_errors_px")}


# ===========================================================================
# Exports (PRD sections 11, 12, 18)
# ===========================================================================
def _csv_response(rows, headers, filename):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    for r in rows:
        w.writerow(r)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"})


@app.get("/api/studies/{sid}/export/{kind}")
def export_csv(sid: str, kind: str):
    with db.get_conn() as conn:
        if kind == "raw_gaze":
            rows = conn.execute(
                "SELECT g.session_id,g.trial_id,g.timestamp_ms,g.raw_x,g.raw_y,g.confidence,"
                "g.face_present,g.offscreen,g.fps FROM gaze_samples g "
                "JOIN sessions s ON g.session_id=s.id WHERE s.study_id=? ORDER BY g.id",
                (sid,)).fetchall()
            return _csv_response(
                [db.row_values(r) for r in rows],
                ["session_id", "trial_id", "t_ms", "norm_x", "norm_y", "confidence",
                 "face_present", "offscreen", "fps"], f"{sid}_raw_gaze.csv")
        if kind == "fixations":
            rows = conn.execute(
                "SELECT t.session_id,f.trial_id,f.start_ms,f.end_ms,f.duration_ms,f.x,f.y,"
                "f.assigned_aoi_id FROM fixations f JOIN trials t ON f.trial_id=t.id "
                "WHERE t.session_id IN (SELECT id FROM sessions WHERE study_id=?) ORDER BY f.id",
                (sid,)).fetchall()
            return _csv_response(
                [db.row_values(r) for r in rows],
                ["session_id", "trial_id", "start_ms", "end_ms", "duration_ms", "norm_x",
                 "norm_y", "aoi_id"], f"{sid}_fixations.csv")
        if kind == "qa":
            rows = conn.execute(
                "SELECT q.session_id,q.valid_sample_pct,q.face_lost_pct,q.offscreen_pct,"
                "q.fps_median,q.quality_grade,q.exclusion_reason FROM qa_reports q "
                "JOIN sessions s ON q.session_id=s.id WHERE s.study_id=?", (sid,)).fetchall()
            return _csv_response(
                [db.row_values(r) for r in rows],
                ["session_id", "valid_sample_pct", "face_lost_pct", "offscreen_pct",
                 "fps_median", "quality_grade", "exclusion_reason"], f"{sid}_qa.csv")
        if kind == "events":
            rows = conn.execute(
                "SELECT e.session_id,e.trial_id,e.event_type,e.timestamp_ms,e.x,e.y,e.value_json "
                "FROM events e JOIN sessions s ON e.session_id=s.id WHERE s.study_id=?",
                (sid,)).fetchall()
            return _csv_response(
                [db.row_values(r) for r in rows],
                ["session_id", "trial_id", "event_type", "t_ms", "x", "y", "value"],
                f"{sid}_events.csv")
        if kind == "responses":
            rows = conn.execute(
                "SELECT r.session_id,r.question_id,r.response_value,r.response_time_ms "
                "FROM responses r JOIN sessions s ON r.session_id=s.id WHERE s.study_id=?",
                (sid,)).fetchall()
            return _csv_response(
                [db.row_values(r) for r in rows],
                ["session_id", "question_id", "response_value", "response_time_ms"],
                f"{sid}_responses.csv")
        if kind == "aoi_summary":
            stimuli = conn.execute("SELECT id FROM stimuli WHERE study_id=?", (sid,)).fetchall()
            out = []
            for st in stimuli:
                a = stimulus_analysis(st["id"])
                for s in a["aoi_summary"]:
                    out.append((st["id"], s["aoi_name"], s["viewed_by_pct"], s["ttff_ms_median"],
                                s["dwell_ms_median"], s["fixation_count_median"],
                                s["revisits_median"], s["total_time_ms_mean"]))
            return _csv_response(
                out, ["stimulus_id", "aoi_name", "viewed_by_pct", "ttff_ms", "dwell_ms",
                      "fixation_count", "revisits", "total_time_ms"], f"{sid}_aoi_summary.csv")
    raise HTTPException(400, f"unknown export kind: {kind}")


DEFAULT_CONSENT = (
    "This study uses your webcam to estimate where you look on the screen. "
    "We do NOT record or store video or images of your face. We store only "
    "gaze coordinates, quality indicators, your device/browser details, and your "
    "survey answers. This is a market-research attention study and makes no medical "
    "or diagnostic claims. Participation is voluntary; you may withdraw at any time "
    "by closing the tab, and you may request deletion of your data afterwards. "
    "By continuing you consent to webcam-based gaze estimation for this study."
)


# ===========================================================================
# Static hosting (frontend + stimulus storage)
# ===========================================================================
@app.get("/storage/{fname}")
def serve_storage(fname: str, request: Request):
    fname = os.path.basename(fname)
    path = os.path.join(STORAGE, fname)
    if os.path.exists(path):        # local disk fast path (FileResponse does ranges)
        return FileResponse(path)
    blob = db.load_blob(fname)      # fall back to DB (hosted / after disk wipe)
    if not blob:
        raise HTTPException(404, "file not found")
    ct, data = blob
    ct = ct or "application/octet-stream"
    total = len(data)
    # HTML5 <video> requires HTTP Range support (206 partial content) to play/seek;
    # a plain 200 full-body response makes videos fail (black screen) on the hosted
    # deploy where they're served from the DB, not disk. Honour a single byte-range.
    rng = request.headers.get("range")
    if rng and rng.startswith("bytes="):
        try:
            first, last = rng.split("=", 1)[1].split(",")[0].strip().split("-")
            start = int(first) if first else 0
            end = int(last) if last else total - 1
            start = max(0, start)
            end = min(end, total - 1)
            if start > end:
                return Response(status_code=416,
                                headers={"Content-Range": f"bytes */{total}"})
            chunk = data[start:end + 1]
            return Response(
                content=chunk, status_code=206, media_type=ct,
                headers={"Content-Range": f"bytes {start}-{end}/{total}",
                         "Accept-Ranges": "bytes", "Content-Length": str(len(chunk))})
        except (ValueError, IndexError):
            pass   # malformed Range → fall through to full response
    return Response(content=data, media_type=ct,
                    headers={"Accept-Ranges": "bytes", "Content-Length": str(total)})


@app.get("/config/thresholds.json")
def serve_config():
    return JSONResponse(analysis.load_config())


@app.get("/study")
def study_page():
    return FileResponse(os.path.join(FRONTEND, "study.html"))


# Mount the SPA/static frontend last so /api routes win.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    # Host/port come from env in production (cloud hosts inject PORT); default to local.
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app:app", host=host, port=port, reload=False)
