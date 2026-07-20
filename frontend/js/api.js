// Shared API client + offline-buffered batch uploader.
// PRD section 17: "Implement batch upload queue with retry/offline buffering;
// never upload one gaze point at a time."

const API = {
  async req(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  },
  get(p) { return this.req('GET', p); },
  post(p, b) { return this.req('POST', p, b); },
  patch(p, b) { return this.req('PATCH', p, b); },
  del(p) { return this.req('DELETE', p); },

  async upload(path, file, fields = {}) {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(path, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res.json();
  },
};

// A resilient batch queue: accumulates items, flushes on size or interval,
// retries with backoff, and buffers to localStorage so nothing is lost if the
// tab is closed or the network drops mid-study.
class BatchQueue {
  constructor(endpoint, key, { flushSize = 60, flushMs = 2000, storeKey } = {}) {
    this.endpoint = endpoint;       // function(items) -> POST body builder, or string path
    this.key = key;                 // body key, e.g. 'samples' or 'events'
    this.flushSize = flushSize;
    this.flushMs = flushMs;
    this.storeKey = storeKey || `bq_${key}`;
    this.buffer = this._restore();
    this.sending = false;
    this.lost = 0;
    this.sent = 0;
    this.timer = setInterval(() => this.flush(), this.flushMs);
  }
  _restore() {
    try { return JSON.parse(localStorage.getItem(this.storeKey) || '[]'); }
    catch (e) { return []; }
  }
  _persist() {
    try { localStorage.setItem(this.storeKey, JSON.stringify(this.buffer)); }
    catch (e) {}
  }
  push(item) {
    this.buffer.push(item);
    if (this.buffer.length >= this.flushSize) this.flush();
    else this._persist();
  }
  async flush() {
    if (this.sending || this.buffer.length === 0) return;
    this.sending = true;
    const batch = this.buffer.slice(0, 300);
    try {
      await API.post(this.endpoint, { [this.key]: batch });
      this.buffer = this.buffer.slice(batch.length);
      this.sent += batch.length;
      this._persist();
    } catch (e) {
      // keep buffered; will retry next tick (offline-safe)
      console.warn('batch flush failed, will retry', e.message);
    } finally {
      this.sending = false;
    }
  }
  async drain(maxMs = 8000) {
    const start = Date.now();
    while (this.buffer.length > 0 && Date.now() - start < maxMs) {
      await this.flush();
      if (this.buffer.length > 0) await new Promise(r => setTimeout(r, 400));
    }
    this.lost = this.buffer.length;
    return { sent: this.sent, lost: this.lost };
  }
  stop() { clearInterval(this.timer); }
}

function toast(msg, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

window.API = API;
window.BatchQueue = BatchQueue;
window.toast = toast;
