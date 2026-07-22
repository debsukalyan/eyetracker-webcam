"""Persistence layer for the in-house eye-tracking platform.

Implements the data model from PRD section 9. SQLite is the default (zero
external services for local dev). If DATABASE_URL is set (e.g. Render's free
Postgres add-on), this module talks to Postgres instead — same schema, same
query text (all call sites use '?' placeholders and dict-like rows; a thin
wrapper below adapts psycopg2 to that same shape) so app.py/analysis.py never
need to know which backend is active. Postgres is what makes hosted/shared
deploys durable: unlike a container's local disk, it isn't wiped when the
free-tier web service sleeps and wakes back up.
"""
import json
import os
import time
import uuid
from contextlib import contextmanager

DB_PATH = os.environ.get(
    "EYETRACK_DB",
    os.path.join(os.path.dirname(__file__), "data", "eyetrack.db"),
)
DATABASE_URL = os.environ.get("DATABASE_URL")
USE_PG = bool(DATABASE_URL)

if USE_PG:
    import psycopg2
    import psycopg2.extras

    class _PGConn:
        """Adapts a psycopg2 connection to the sqlite3.Connection surface
        app.py already uses: conn.execute()/.executemany() returning a
        cursor with dict-like rows, no separate cursor() call needed."""

        def __init__(self, raw):
            self._raw = raw

        def execute(self, sql, params=()):
            cur = self._raw.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql.replace("?", "%s"), params)
            return cur

        def executemany(self, sql, seq_of_params):
            cur = self._raw.cursor()
            cur.executemany(sql.replace("?", "%s"), list(seq_of_params))
            return cur

        def executescript(self, sql):
            cur = self._raw.cursor()
            cur.execute(sql)
            cur.close()

        def commit(self):
            self._raw.commit()

        def close(self):
            self._raw.close()
else:
    import sqlite3


def _now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "") -> str:
    return (prefix + "_" if prefix else "") + uuid.uuid4().hex[:16]


@contextmanager
def get_conn():
    if USE_PG:
        raw = psycopg2.connect(DATABASE_URL)
        conn = _PGConn(raw)
        try:
            yield conn
            raw.commit()
        finally:
            raw.close()
    else:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY, name TEXT, plan TEXT, billing_contact TEXT,
    data_region TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT,
    organization_id TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS studies (
    id TEXT PRIMARY KEY, org_id TEXT, title TEXT, description TEXT,
    type TEXT, status TEXT, device_allowed TEXT, consent_version TEXT,
    consent_text TEXT, config_json TEXT, created_by TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS study_conditions (
    id TEXT PRIMARY KEY, study_id TEXT, condition_name TEXT,
    randomization_weight REAL, notes TEXT
);

CREATE TABLE IF NOT EXISTS stimuli (
    id TEXT PRIMARY KEY, study_id TEXT, condition_id TEXT, type TEXT,
    file_url TEXT, duration_ms INTEGER, width_px INTEGER, height_px INTEGER,
    order_index INTEGER
);

CREATE TABLE IF NOT EXISTS aois (
    id TEXT PRIMARY KEY, stimulus_id TEXT, name TEXT, shape_type TEXT,
    coordinates_json TEXT, start_ms INTEGER, end_ms INTEGER, parent_aoi_id TEXT
);

CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY, study_id TEXT, token TEXT UNIQUE, source TEXT,
    demographics_json TEXT, status TEXT, consented_at INTEGER, completed_at INTEGER,
    recording_consented INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, participant_id TEXT, study_id TEXT, device_json TEXT,
    browser_json TEXT, screen_width INTEGER, screen_height INTEGER, dpr REAL,
    timezone TEXT, engine TEXT, started_at INTEGER, ended_at INTEGER, status TEXT,
    recording_url TEXT
);

CREATE TABLE IF NOT EXISTS calibrations (
    id TEXT PRIMARY KEY, session_id TEXT, engine TEXT, points_json TEXT,
    model_params_json TEXT, calibration_quality_json TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS validations (
    id TEXT PRIMARY KEY, session_id TEXT, mean_error_px REAL, median_error_px REAL,
    precision_px REAL, passed INTEGER, retry_count INTEGER, details_json TEXT,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS trials (
    id TEXT PRIMARY KEY, session_id TEXT, stimulus_id TEXT, condition_id TEXT,
    trial_index INTEGER, planned_onset_ts INTEGER, onset_ts INTEGER,
    first_frame_ts INTEGER, offset_ts INTEGER, completed INTEGER
);

CREATE TABLE IF NOT EXISTS gaze_samples (
    id {AUTOINCREMENT}, trial_id TEXT, session_id TEXT,
    timestamp_ms INTEGER, raw_x REAL, raw_y REAL, smooth_x REAL, smooth_y REAL,
    confidence REAL, face_present INTEGER, eye_present INTEGER, fps REAL,
    offscreen INTEGER
);

CREATE TABLE IF NOT EXISTS fixations (
    id TEXT PRIMARY KEY, trial_id TEXT, start_ms INTEGER, end_ms INTEGER,
    duration_ms INTEGER, x REAL, y REAL, assigned_aoi_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id {AUTOINCREMENT}, session_id TEXT, trial_id TEXT,
    event_type TEXT, timestamp_ms INTEGER, x REAL, y REAL, value_json TEXT
);

CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY, session_id TEXT, question_id TEXT, response_value TEXT,
    response_time_ms INTEGER
);

CREATE TABLE IF NOT EXISTS qa_reports (
    id TEXT PRIMARY KEY, session_id TEXT, valid_sample_pct REAL, face_lost_pct REAL,
    offscreen_pct REAL, fps_median REAL, quality_grade TEXT, exclusion_reason TEXT,
    thresholds_json TEXT, details_json TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY, study_id TEXT, export_type TEXT, file_url TEXT,
    created_at INTEGER, created_by TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
    fname TEXT PRIMARY KEY, content_type TEXT, data {BLOB}, created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gaze_trial ON gaze_samples(trial_id);
CREATE INDEX IF NOT EXISTS idx_gaze_session ON gaze_samples(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_stimuli_study ON stimuli(study_id);
CREATE INDEX IF NOT EXISTS idx_sessions_study ON sessions(study_id);
""".replace(
    "{AUTOINCREMENT}",
    "BIGSERIAL PRIMARY KEY" if USE_PG else "INTEGER PRIMARY KEY AUTOINCREMENT",
).replace(
    # Raw file bytes: BYTEA on Postgres, BLOB on SQLite.
    "{BLOB}", "BYTEA" if USE_PG else "BLOB",
)

if USE_PG:
    # SQLite's "INTEGER" is dynamically sized (effectively 64-bit) so it never
    # complained about millisecond epoch timestamps (~1.7e12). Postgres's
    # INTEGER is a strict 32-bit type (max ~2.1e9) and rejects them outright
    # (NumericValueOutOfRange) — every INTEGER column here needs to be BIGINT.
    SCHEMA = SCHEMA.replace("INTEGER", "BIGINT")


# Columns added after initial release — applied to existing databases on startup.
_MIGRATIONS = [
    ("sessions", "recording_url", "TEXT"),
    ("participants", "recording_consented", "INTEGER DEFAULT 0"),
]


def _migrate(conn):
    for table, col, decl in _MIGRATIONS:
        if USE_PG:
            cols = [r["column_name"] for r in conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name=?",
                (table,)).fetchall()]
        else:
            cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        # Seed a default organization + researcher so the dashboard works out of the box.
        cur = conn.execute("SELECT COUNT(*) AS c FROM organizations")
        if cur.fetchone()["c"] == 0:
            conn.execute(
                "INSERT INTO organizations (id,name,plan,billing_contact,data_region,created_at)"
                " VALUES (?,?,?,?,?,?)",
                ("org_default", "In-House Research", "internal", "", "local", _now_ms()),
            )
            conn.execute(
                "INSERT INTO users (id,name,email,role,organization_id,created_at)"
                " VALUES (?,?,?,?,?,?)",
                ("user_admin", "Researcher", "researcher@local", "admin",
                 "org_default", _now_ms()),
            )


def row_values(row):
    """Column values in order, for CSV export. Works on both backends:
    tuple(sqlite3.Row) yields values, but tuple() of the dict-style rows
    psycopg2 returns yields the KEYS — so exports came out as repeated column
    names on Postgres. Pull .values() for dict rows instead."""
    if isinstance(row, dict):
        return tuple(row.values())
    return tuple(row)


def row_to_dict(row):
    if row is None:
        return None
    d = dict(row)
    # auto-parse *_json fields for convenience
    for k, v in list(d.items()):
        if k.endswith("_json") and isinstance(v, str) and v:
            try:
                d[k[:-5]] = json.loads(v)
            except (ValueError, TypeError):
                pass
    return d


# ---------------------------------------------------------------------------
# Blob storage. Uploaded stimulus images / recordings live in the DB, not on
# local disk: hosted free tiers (Render) have an EPHEMERAL filesystem that is
# wiped whenever the container sleeps/restarts, so disk-stored images 404 after
# the first spin-down. The database persists, so the bytes must live there.
# ---------------------------------------------------------------------------
def save_blob(fname, content_type, data):
    payload = psycopg2.Binary(data) if USE_PG else sqlite3.Binary(data)
    with get_conn() as conn:
        # Portable upsert: delete-then-insert (avoids ON CONFLICT dialect diffs).
        conn.execute("DELETE FROM blobs WHERE fname=?", (fname,))
        conn.execute(
            "INSERT INTO blobs (fname,content_type,data,created_at) VALUES (?,?,?,?)",
            (fname, content_type or "application/octet-stream", payload, _now_ms()))


def load_blob(fname):
    """Return (content_type, bytes) for a stored file, or None if absent."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content_type, data FROM blobs WHERE fname=?", (fname,)).fetchone()
    if not row:
        return None
    ct, data = row["content_type"], row["data"]
    if isinstance(data, memoryview):   # psycopg2 returns BYTEA as memoryview
        data = data.tobytes()
    return ct, bytes(data)
