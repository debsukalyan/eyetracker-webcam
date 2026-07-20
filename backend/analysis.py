"""Analysis pipeline (PRD section 11) in pure Python — no heavy deps.

Steps implemented:
  - smoothing (moving median, raw preserved)
  - invalid-sample marking (face/eye lost, low confidence, offscreen, out of bounds)
  - fixation detection (I-DT dispersion algorithm)
  - AOI assignment by coordinate + time window
  - participant QA metrics + exclusion flags (PRD section 13)
  - AOI summaries: viewed-by %, TTFF, dwell, fixation count, revisits, total time

Every threshold used is passed in from config/thresholds.json and stored with the
output so a report can be reproduced from raw data (PRD section 17).
"""
import json
import os
import statistics
from collections import defaultdict

CONFIG_PATH = os.environ.get(
    "EYETRACK_CONFIG",
    os.path.join(os.path.dirname(__file__), "..", "config", "thresholds.json"),
)


def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


# ---------------------------------------------------------------------------
# Smoothing
# ---------------------------------------------------------------------------
def moving_median(values, window):
    if window < 2:
        return list(values)
    out = []
    half = window // 2
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        chunk = [v for v in values[lo:hi] if v is not None]
        out.append(statistics.median(chunk) if chunk else values[i])
    return out


# ---------------------------------------------------------------------------
# Fixation detection: I-DT (dispersion threshold)
# ---------------------------------------------------------------------------
def detect_fixations_idt(samples, dispersion_px, min_duration_ms):
    """samples: list of dicts with x, y, t (ms). Returns list of fixation dicts."""
    pts = [s for s in samples if s["x"] is not None and s["y"] is not None]
    fixations = []
    i = 0
    n = len(pts)
    while i < n:
        j = i + 1
        # expand window while duration < min_duration
        while j < n and (pts[j]["t"] - pts[i]["t"]) < min_duration_ms:
            j += 1
        if j > n:
            break
        if _dispersion(pts, i, j) <= dispersion_px:
            # expand while within dispersion
            while j < n and _dispersion(pts, i, j + 1) <= dispersion_px:
                j += 1
            window = pts[i:j]
            fixations.append({
                "start_ms": window[0]["t"],
                "end_ms": window[-1]["t"],
                "duration_ms": window[-1]["t"] - window[0]["t"],
                "x": sum(p["x"] for p in window) / len(window),
                "y": sum(p["y"] for p in window) / len(window),
            })
            i = j
        else:
            i += 1
    return [f for f in fixations if f["duration_ms"] >= min_duration_ms]


def _dispersion(pts, i, j):
    window = pts[i:j]
    if not window:
        return float("inf")
    xs = [p["x"] for p in window]
    ys = [p["y"] for p in window]
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


# ---------------------------------------------------------------------------
# AOI assignment
# ---------------------------------------------------------------------------
def point_in_aoi(x, y, t, aoi):
    """aoi: dict with shape_type, coordinates (normalized 0..1 of stimulus), start_ms/end_ms."""
    start = aoi.get("start_ms")
    end = aoi.get("end_ms")
    if start is not None and t is not None and t < start:
        return False
    if end is not None and t is not None and t > end:
        return False
    c = aoi.get("coordinates") or aoi.get("coordinates_json") or {}
    if isinstance(c, str):
        c = json.loads(c)
    if aoi.get("shape_type", "rect") == "rect":
        return (c["x"] <= x <= c["x"] + c["w"]) and (c["y"] <= y <= c["y"] + c["h"])
    if aoi.get("shape_type") == "polygon":
        return _point_in_polygon(x, y, c.get("points", []))
    return False


def _point_in_polygon(x, y, poly):
    inside = False
    n = len(poly)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]["x"], poly[i]["y"]
        xj, yj = poly[j]["x"], poly[j]["y"]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------------------
# QA metrics (PRD section 13)
# ---------------------------------------------------------------------------
def compute_qa(samples, fps_values, validation, config, expected_ms=None, actual_ms=None):
    qa = config["qa"]
    total = len(samples)
    if total == 0:
        return {
            "valid_sample_pct": 0, "face_lost_pct": 100, "offscreen_pct": 0,
            "fps_median": 0, "quality_grade": "fail",
            "exclusion_reason": "no_gaze_data",
            "thresholds": qa, "details": {},
        }
    face_lost = sum(1 for s in samples if not s.get("face_present"))
    offscreen = sum(1 for s in samples if s.get("offscreen"))
    valid = sum(1 for s in samples if s.get("face_present") and not s.get("offscreen")
                and (s.get("confidence") is None or s.get("confidence") >= 0.0))
    valid_pct = round(100 * valid / total, 1)
    face_lost_pct = round(100 * face_lost / total, 1)
    offscreen_pct = round(100 * offscreen / total, 1)
    fps_median = round(_median(fps_values) or 0, 1)

    reasons = []
    if validation and not validation.get("passed", True):
        reasons.append("validation_failed")
    if valid_pct < qa["min_valid_sample_pct"]:
        reasons.append(f"low_valid_samples({valid_pct}%)")
    if face_lost_pct > qa["max_face_lost_pct"]:
        reasons.append(f"face_lost({face_lost_pct}%)")
    if offscreen_pct > qa["max_offscreen_pct"]:
        reasons.append(f"offscreen({offscreen_pct}%)")
    if fps_median < qa["min_fps_median"]:
        reasons.append(f"low_fps({fps_median}Hz)")
    if expected_ms and actual_ms:
        ratio = actual_ms / expected_ms if expected_ms else 1
        if ratio < qa["completion_time_min_ratio"] or ratio > qa["completion_time_max_ratio"]:
            reasons.append(f"completion_time_outlier(x{round(ratio,2)})")

    grade = "pass" if not reasons else ("warn" if len(reasons) == 1 else "fail")
    return {
        "valid_sample_pct": valid_pct,
        "face_lost_pct": face_lost_pct,
        "offscreen_pct": offscreen_pct,
        "fps_median": fps_median,
        "quality_grade": grade,
        "exclusion_reason": "; ".join(reasons) if reasons else "",
        "thresholds": qa,
        "details": {"total_samples": total, "valid_samples": valid},
    }


# ---------------------------------------------------------------------------
# AOI summary metrics (PRD section 11 / 12)
# ---------------------------------------------------------------------------
def aoi_summary(fixations_by_participant, aoi, trial_duration_hint=None):
    """fixations_by_participant: {participant_id: [fixation dicts assigned to aoi or not]}.

    Returns viewed-by %, TTFF, dwell, fixation count, revisits, total time.
    """
    n_participants = len(fixations_by_participant)
    if n_participants == 0:
        return None
    viewers = 0
    ttffs, dwells, fix_counts, revisit_counts, total_times = [], [], [], [], []
    for pid, fixes in fixations_by_participant.items():
        in_aoi = [f for f in fixes if f.get("assigned_aoi_id") == aoi["id"]]
        if not in_aoi:
            continue
        viewers += 1
        first = min(in_aoi, key=lambda f: f["start_ms"])
        # TTFF relative to trial onset = first fixation start (samples are already onset-relative)
        ttffs.append(first["start_ms"])
        dwell = sum(f["duration_ms"] for f in in_aoi)
        dwells.append(dwell)
        total_times.append(dwell)
        fix_counts.append(len(in_aoi))
        # revisits = number of separate entries into AOI (gaps in fixation sequence)
        revisits = _count_revisits(fixes, aoi["id"])
        revisit_counts.append(revisits)
    return {
        "aoi_id": aoi["id"],
        "aoi_name": aoi["name"],
        "n_participants": n_participants,
        "viewers": viewers,
        "viewed_by_pct": round(100 * viewers / n_participants, 1),
        "ttff_ms_median": round(_median(ttffs), 1) if ttffs else None,
        "dwell_ms_median": round(_median(dwells), 1) if dwells else None,
        "fixation_count_median": round(_median(fix_counts), 1) if fix_counts else None,
        "revisits_median": round(_median(revisit_counts), 1) if revisit_counts else None,
        "total_time_ms_mean": round(sum(total_times) / len(total_times), 1) if total_times else None,
    }


def _count_revisits(fixes, aoi_id):
    """Count contiguous runs of in-AOI fixations (each run = one visit)."""
    visits = 0
    prev_in = False
    for f in sorted(fixes, key=lambda x: x["start_ms"]):
        cur_in = f.get("assigned_aoi_id") == aoi_id
        if cur_in and not prev_in:
            visits += 1
        prev_in = cur_in
    return max(0, visits - 1)  # revisits = visits beyond the first


# ---------------------------------------------------------------------------
# Heatmap grid (down-sampled density for dashboard rendering)
# ---------------------------------------------------------------------------
def heatmap_grid(points, width, height, cell=24):
    cols = max(1, width // cell)
    rows = max(1, height // cell)
    grid = defaultdict(float)
    for p in points:
        if p["x"] is None or p["y"] is None:
            continue
        cx = min(cols - 1, max(0, int(p["x"] / width * cols)))
        cy = min(rows - 1, max(0, int(p["y"] / height * rows)))
        grid[(cx, cy)] += 1
    peak = max(grid.values()) if grid else 1
    return {
        "cols": cols, "rows": rows, "cell": cell, "peak": peak,
        "cells": [{"cx": k[0], "cy": k[1], "v": v} for k, v in grid.items()],
    }
