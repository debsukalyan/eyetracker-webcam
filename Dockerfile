# Portable container for the In-House Eye-Tracking Platform.
# Works on Render, Fly.io, Railway, Google Cloud Run, or any Docker host.
FROM python:3.12-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# App code.
COPY backend ./backend
COPY frontend ./frontend
COPY config ./config

# Persist DB + uploaded stimuli/recordings on a mounted volume at /data.
ENV EYETRACK_DB=/data/eyetrack.db \
    EYETRACK_STORAGE=/data/storage \
    EYETRACK_CONFIG=/app/config/thresholds.json \
    HOST=0.0.0.0 \
    PORT=8000
VOLUME ["/data"]
EXPOSE 8000

WORKDIR /app/backend
# Respect the platform-injected $PORT (Render/Cloud Run/Railway set it).
CMD ["sh", "-c", "python -m uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
