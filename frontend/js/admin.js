// Researcher console (PRD sections 5, 12): study builder, stimuli + AOI editor,
// participant links, QA dashboard, heatmaps, AOI tables, exports.

(function () {
  const app = () => document.getElementById('app');
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return e;
  };
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

  document.getElementById('nav-studies').onclick = renderList;
  document.getElementById('nav-new').onclick = newStudyForm;

  // ===================================================================
  // Study list
  // ===================================================================
  async function renderList() {
    const root = app(); clear(root);
    const { studies } = await API.get('/api/studies');
    root.appendChild(h('h1', {}, 'Studies'));
    if (!studies.length) {
      root.appendChild(h('div', { class: 'empty' },
        'No studies yet. Click "+ New study" to create your first attention study.'));
      return;
    }
    const grid = h('div', { class: 'grid cols-3' });
    studies.forEach(s => {
      grid.appendChild(h('div', { class: 'card', style: 'cursor:pointer',
        onclick: () => openStudy(s.id) },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:start' },
          h('h3', { style: 'color:var(--text);text-transform:none;font-size:16px' }, s.title),
          statusBadge(s.status)),
        h('p', { class: 'muted', style: 'min-height:38px' }, s.description || 'No description'),
        h('div', { class: 'kv' }, h('span', {}, 'Participants'), h('span', {}, String(s.counts.participants))),
        h('div', { class: 'kv' }, h('span', {}, 'Completed'), h('span', {}, String(s.counts.completed))),
        h('div', { class: 'kv' }, h('span', {}, 'Usable (QA)'), h('span', {}, String(s.counts.usable))),
      ));
    });
    root.appendChild(grid);
  }

  function statusBadge(status) {
    const map = { draft: 'muted', active: 'ok', closed: 'warn' };
    return h('span', { class: 'badge ' + (map[status] || 'muted') }, status);
  }

  // ===================================================================
  // New study
  // ===================================================================
  function newStudyForm() {
    const root = app(); clear(root);
    root.appendChild(h('h1', {}, 'New study'));
    const title = h('input', { placeholder: 'e.g. Q3 Pack Shelf Test' });
    const desc = h('textarea', { placeholder: 'What is being tested and why' });
    const type = h('select', {}, h('option', { value: 'image' }, 'Static images'),
      h('option', { value: 'video' }, 'Video'),
      h('option', { value: 'url' }, 'Website (URL)'));
    const device = h('select', {},
      h('option', { value: 'desktop' }, 'Desktop only (recommended)'),
      h('option', { value: 'both' }, 'Desktop + mobile'));
    const card = h('div', { class: 'card', style: 'max-width:640px' },
      h('label', {}, 'Title'), title,
      h('label', {}, 'Description'), desc,
      h('label', {}, 'Stimulus type'), type,
      h('label', {}, 'Allowed devices'), device,
      h('div', { class: 'btn-row', style: 'margin-top:18px' },
        h('button', { class: 'btn', onclick: async () => {
          if (!title.value.trim()) return toast('Please enter a title');
          const s = await API.post('/api/studies', {
            title: title.value, description: desc.value, type: type.value,
            device_allowed: device.value,
          });
          openStudy(s.id);
        } }, 'Create study'),
        h('button', { class: 'btn secondary', onclick: renderList }, 'Cancel')));
    root.appendChild(card);
  }

  // ===================================================================
  // Study detail (tabs)
  // ===================================================================
  const TABS = ['Overview', 'Build', 'Stimuli & AOIs', 'Participants', 'Results', 'Benchmark', 'Exports'];
  async function openStudy(id, tab = 'Overview') {
    const study = await API.get('/api/studies/' + id);
    const root = app(); clear(root);
    root.appendChild(h('div', { style: 'display:flex;align-items:center;gap:12px' },
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderList(); } }, '← Studies'),
      h('h1', { style: 'margin:6px 0' }, study.title), statusBadge(study.status)));
    const nav = h('div', { class: 'pill-nav' });
    TABS.forEach(t => nav.appendChild(h('button', {
      class: t === tab ? 'active' : '', onclick: () => openStudy(id, t) }, t)));
    root.appendChild(nav);
    const body = h('div', { id: 'tab-body' });
    root.appendChild(body);
    const render = {
      'Overview': () => tabOverview(study, body),
      'Build': () => tabBuild(study, body),
      'Stimuli & AOIs': () => tabStimuli(study, body),
      'Participants': () => tabParticipants(study, body),
      'Results': () => tabResults(study, body),
      'Benchmark': () => tabBenchmark(study, body),
      'Exports': () => tabExports(study, body),
    };
    render[tab]();
  }

  // ---- Overview (PRD section 12) --------------------------------------
  async function tabOverview(study, body) {
    clear(body);
    const o = await API.get(`/api/studies/${study.id}/overview`);
    const grid = h('div', { class: 'grid cols-4' });
    const stat = (label, val, sub) => h('div', { class: 'card' },
      h('h3', {}, label), h('div', { class: 'stat' }, String(val)),
      sub ? h('div', { class: 'stat-sub' }, sub) : null);
    grid.appendChild(stat('Participants', o.counts.participants, 'invited / started'));
    grid.appendChild(stat('Completed', o.counts.completed, o.completion_rate + '% completion'));
    grid.appendChild(stat('Usable (QA)', o.counts.usable, 'pass + warn'));
    grid.appendChild(stat('Excluded', o.excluded, 'failed QA'));
    body.appendChild(grid);

    const split = h('div', { class: 'grid cols-2', style: 'margin-top:16px' });
    split.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Device split'),
      ...Object.entries(o.device_split).map(([k, v]) =>
        h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(v)))) ||
      [h('p', { class: 'muted' }, 'No data')]));
    split.appendChild(h('div', { class: 'card' }, h('h3', {}, 'QA grade split'),
      ...Object.entries(o.grade_split).map(([k, v]) =>
        h('div', { class: 'kv' }, gradeBadge(k), h('span', {}, String(v))))));
    body.appendChild(split);

    if (study.status === 'draft') {
      body.appendChild(h('div', { class: 'banner info', style: 'margin-top:16px' },
        'This study is a draft. Add stimuli and AOIs, then activate it from the Build tab to invite participants.'));
    }
  }

  function gradeBadge(g) { return h('span', { class: 'badge ' + g }, g); }

  // ---- Build ----------------------------------------------------------
  async function tabBuild(study, body) {
    clear(body);
    const title = h('input', { value: study.title });
    const desc = h('textarea', {}, study.description || '');
    const device = h('select', {},
      ...['desktop', 'both'].map(d => h('option', { value: d, ...(study.device_allowed === d ? { selected: 'selected' } : {}) },
        d === 'desktop' ? 'Desktop only' : 'Desktop + mobile')));
    const consent = h('textarea', { style: 'min-height:150px' }, study.consent_text || '');

    // Visual survey builder (replaces the old raw-JSON textarea, which threw
    // "invalid JSON" the moment a non-technical user typed a question by hand).
    const surveyList = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    function surveyRow(q = {}) {
      const typeSel = h('select', { style: 'max-width:150px' },
        ...[['choice', 'Multiple choice'], ['scale', 'Rating scale 1–5'], ['text', 'Free text']]
          .map(([v, l]) => h('option', { value: v, ...(q.type === v ? { selected: 'selected' } : {}) }, l)));
      const promptI = h('input', { type: 'text', placeholder: 'Question text (e.g. Which pack do you prefer?)', value: q.prompt || '' });
      const optsI = h('input', { type: 'text', placeholder: 'Answer options, comma-separated (e.g. Pack A, Pack B, Pack C)', value: (q.options || []).join(', ') });
      const optWrap = h('div', {}, optsI);
      const syncOpts = () => { optWrap.style.display = typeSel.value === 'choice' ? '' : 'none'; };
      typeSel.addEventListener('change', syncOpts); syncOpts();
      const row = h('div', { class: 'card', style: 'padding:12px;margin:0;display:flex;flex-direction:column;gap:8px' },
        h('div', { style: 'display:flex;gap:10px;align-items:center' },
          typeSel,
          h('button', { class: 'btn sm danger', style: 'margin-left:auto', onclick: () => row.remove() }, 'Remove')),
        promptI, optWrap);
      row._get = () => {
        const prompt = promptI.value.trim();
        if (!prompt) return null;               // skip blank questions
        const out = { type: typeSel.value, prompt };
        if (typeSel.value === 'choice') out.options = optsI.value.split(',').map(s => s.trim()).filter(Boolean);
        return out;
      };
      return row;
    }
    ((study.config && study.config.survey) || []).forEach(q => surveyList.appendChild(surveyRow(q)));
    const addQBtn = h('button', { class: 'btn sm', style: 'margin-top:8px',
      onclick: () => surveyList.appendChild(surveyRow()) }, '+ Add question');

    const recordChk = h('input', { type: 'checkbox', style: 'width:auto',
      ...(study.config && study.config.record_session ? { checked: 'checked' } : {}) });
    const screenChk = h('input', { type: 'checkbox', style: 'width:auto',
      ...(study.config && study.config.record_screen ? { checked: 'checked' } : {}) });
    const curEngine = (study.config && study.config.engine) || 'mediapipe';
    const engineSel = h('select', {},
      h('option', { value: 'mediapipe', ...(curEngine === 'mediapipe' ? { selected: 'selected' } : {}) },
        'MediaPipe — in-house engine (recommended)'),
      h('option', { value: 'webgazer', ...(curEngine === 'webgazer' ? { selected: 'selected' } : {}) },
        'WebGazer — legacy prototype engine'));

    body.appendChild(h('div', { class: 'card', style: 'max-width:760px' },
      h('label', {}, 'Title'), title,
      h('label', {}, 'Description'), desc,
      h('label', {}, 'Allowed devices'), device,
      h('label', {}, 'Gaze engine'), engineSel,
      h('p', { class: 'hint' },
        'MediaPipe is our owned engine (iris tracking + per-participant model, ~130px median in lab validation). WebGazer is the earlier prototype.'),
      h('label', {}, 'Consent text (shown before camera starts)'), consent,
      h('label', {}, 'Survey questions (shown after the study)'), surveyList, addQBtn,
      h('p', { class: 'hint' },
        'Add one row per question. Multiple-choice shows a dropdown, rating scale shows a 1–5 slider, free text shows a text box. Leave blank to add none.'),
      h('label', { style: 'display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--text)' },
        recordChk, 'Record participant webcam video (asks for separate consent; stored per session)'),
      h('p', { class: 'hint' },
        'Off by default. When on, participants must give an extra recording consent, and the webcam video is stored and viewable from each participant’s replay. Webcam frames are otherwise never stored.'),
      h('label', { style: 'display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--text)' },
        screenChk, 'Record the screen + gaze replay (recommended for websites & videos)'),
      h('p', { class: 'hint' },
        'Captures what the participant actually saw (scrolling websites, playing videos) with a time-synced gaze overlay you can replay — the right tool when a static heatmap can’t capture a time-changing stimulus. Desktop only (the participant approves a one-time screen-share prompt); silently skipped on phones and if declined.'),
      h('div', { class: 'btn-row', style: 'margin-top:16px' },
        h('button', { class: 'btn', onclick: async () => {
          // Build survey JSON from the visual rows — auto-assign stable ids so
          // answers never collide (the old hand-typed JSON was the failure point).
          const surveyJson = [...surveyList.children]
            .map((r) => (r._get ? r._get() : null))
            .filter(Boolean)
            .map((q, i) => ({ id: 'q' + (i + 1), ...q }));
          await API.patch('/api/studies/' + study.id, {
            title: title.value, description: desc.value, device_allowed: device.value,
            consent_text: consent.value,
            config: { ...(study.config || {}), survey: surveyJson,
              record_session: recordChk.checked, record_screen: screenChk.checked,
              engine: engineSel.value },
          });
          toast('Saved'); openStudy(study.id, 'Build');
        } }, 'Save'),
        study.status === 'draft'
          ? h('button', { class: 'btn ghost', onclick: async () => {
              if (!study.stimuli.length) return toast('Add at least one stimulus first');
              await API.patch('/api/studies/' + study.id, { status: 'active' });
              toast('Study activated'); openStudy(study.id, 'Participants');
            } }, '▶ Activate study')
          : h('button', { class: 'btn secondary', onclick: async () => {
              await API.patch('/api/studies/' + study.id, { status: 'closed' });
              toast('Study closed'); openStudy(study.id, 'Build');
            } }, 'Close study'),
      )));
  }

  // ---- Stimuli & AOIs -------------------------------------------------
  async function tabStimuli(study, body) {
    clear(body);

    // Unified "Add stimulus": choose the type first (static image / video / website),
    // then only the relevant input is shown.
    const typeSel = h('select', { style: 'max-width:200px' },
      h('option', { value: 'image' }, 'Static image'),
      h('option', { value: 'video' }, 'Video'),
      h('option', { value: 'url' }, 'Website (URL)'));
    const fileInput = h('input', { type: 'file', accept: 'image/*', style: 'max-width:340px' });
    const urlInput = h('input', { type: 'url', placeholder: 'https://example.com', style: 'min-width:300px' });
    const dur = h('input', { type: 'number', value: '5000', style: 'max-width:180px' });
    const fileLabel = h('label', {}, 'Image file');
    const fileField = h('div', {}, fileLabel, fileInput);
    const urlField = h('div', {}, h('label', {}, 'Website URL'), urlInput);
    const durField = h('div', {}, h('label', {}, 'Duration ms'), dur);
    const hint = h('p', { class: 'hint' }, '');

    function syncType() {
      const t = typeSel.value;
      fileField.style.display = (t === 'image' || t === 'video') ? '' : 'none';
      urlField.style.display = t === 'url' ? '' : 'none';
      if (t === 'image') { fileInput.accept = 'image/*'; fileLabel.textContent = 'Image file'; }
      if (t === 'video') { fileInput.accept = 'video/mp4,video/webm'; fileLabel.textContent = 'Video file'; }
      if (t === 'url' && (dur.value === '5000' || !dur.value)) dur.value = '15000';
      hint.textContent = t === 'image'
        ? 'JPG / PNG / WebP. Shown for the duration you set.'
        : t === 'video'
        ? 'MP4 / WebM. Set duration to 0 to play the full clip.'
        : 'The participant sees the live website full-screen while we track their gaze. It renders responsively (mobile participants see the mobile layout). Some sites (Google, YouTube, banks) block embedding and show blank — check with Preview after adding.';
    }
    typeSel.addEventListener('change', syncType); syncType();

    const addBtn = h('button', { class: 'btn', onclick: async () => {
      const t = typeSel.value;
      try {
        if (t === 'url') {
          const url = urlInput.value.trim();
          if (!/^https?:\/\//i.test(url)) return toast('Enter a full URL starting with http:// or https://');
          await API.post(`/api/studies/${study.id}/stimuli/url`, { url, duration_ms: +dur.value || 15000 });
        } else {
          const f = fileInput.files[0];
          if (!f) return toast('Choose a ' + t + ' file');
          const isVideo = t === 'video';
          const dims = isVideo ? await videoDims(f) : await imageDims(f);
          await API.upload(`/api/studies/${study.id}/stimuli`, f,
            { duration_ms: dur.value, type: isVideo ? 'video' : 'image', width_px: dims.w, height_px: dims.h });
        }
        toast('Stimulus added'); openStudy(study.id, 'Stimuli & AOIs');
      } catch (e) { toast('Could not add: ' + e.message); }
    } }, 'Add stimulus');

    body.appendChild(h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('h3', {}, 'Add stimulus'),
      h('div', { style: 'display:flex;gap:12px;align-items:end;flex-wrap:wrap' },
        h('div', {}, h('label', {}, 'Type'), typeSel),
        fileField, urlField, durField, addBtn),
      hint));

    const stimuli = study.stimuli || [];
    if (!stimuli.length) {
      body.appendChild(h('div', { class: 'empty' }, 'No stimuli yet. Add an image, video, or website above.'));
      return;
    }
    stimuli.forEach(st => body.appendChild(stimulusEditor(study, st)));
  }

  function imageDims(file) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    });
  }

  function videoDims(file) {
    return new Promise(res => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => res({ w: v.videoWidth || 1280, h: v.videoHeight || 720 });
      v.onerror = () => res({ w: 1280, h: 720 });
      v.src = URL.createObjectURL(file);
    });
  }

  function stimulusEditor(study, st) {
    const isUrl = st.type === 'url';
    const wrap = h('div', { class: 'card', style: 'margin-bottom:16px' });
    wrap.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
      h('h3', { style: 'color:var(--text);text-transform:none' },
        (isUrl ? 'Website · ' : 'Stimulus · ') + st.duration_ms + 'ms'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (confirm('Delete this stimulus and its AOIs?')) {
          await API.del('/api/stimuli/' + st.id); openStudy(study.id, 'Stimuli & AOIs');
        }
      } }, 'Delete')));

    if (isUrl) {
      wrap.appendChild(h('p', { class: 'hint' },
        'Live website stimulus. Participants view it full-screen while we track gaze. AOIs and heatmap-over-page are not available for live sites (cross-origin). Use Preview to confirm the site allows embedding.'));
      wrap.appendChild(h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
        h('a', { href: st.file_url, target: '_blank', class: 'mono', style: 'color:var(--accent)' }, st.file_url),
        h('button', { class: 'btn sm', onclick: () => {
          const box = wrap.querySelector('.url-preview');
          if (box.style.display === 'none') {
            box.style.display = 'block';
            box.innerHTML = `<iframe src="${st.file_url}" style="width:100%;height:420px;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe>`
              + '<p class="hint">If this stays blank, the site blocks embedding and cannot be used as a stimulus.</p>';
          } else { box.style.display = 'none'; box.innerHTML = ''; }
        } }, 'Preview')));
      wrap.appendChild(h('div', { class: 'url-preview', style: 'display:none;margin-top:12px' }));
      return wrap;
    }

    wrap.appendChild(h('p', { class: 'hint' },
      'Draw rectangular AOIs by dragging on the image. Drag a box to move, drag its corner to resize, double-click to rename, right-click to delete.'));

    const holder = h('div', { style: 'position:relative;display:inline-block;max-width:100%' });
    const isVideo = st.type === 'video' || /\.(mp4|webm|ogg)$/i.test(st.file_url || '');
    let media;
    if (isVideo) {
      media = h('video', { src: st.file_url, controls: 'controls',
        style: 'max-width:100%;display:block;user-select:none' });
      media.addEventListener('loadeddata', () => initAoiEditor(holder, media, st), { once: true });
      wrap.appendChild(h('p', { class: 'hint' },
        'Video stimulus — AOIs apply across the whole clip. Scrub to a representative frame, then draw AOIs over it.'));
    } else {
      media = h('img', { src: st.file_url, style: 'max-width:100%;display:block;user-select:none' });
      media.onload = () => initAoiEditor(holder, media, st);
    }
    holder.appendChild(media);
    wrap.appendChild(holder);
    return wrap;
  }

  function initAoiEditor(holder, img, st) {
    const rectW = () => img.clientWidth, rectH = () => img.clientHeight;
    const aois = [...(st.aois || [])];
    const overlay = h('div', { style: 'position:absolute;inset:0' });
    holder.appendChild(overlay);

    function draw() {
      clear(overlay);
      aois.forEach(a => {
        const c = a.coordinates || JSON.parse(a.coordinates_json || '{}');
        const el = h('div', { class: 'aoi-rect',
          style: `left:${c.x * rectW()}px;top:${c.y * rectH()}px;width:${c.w * rectW()}px;height:${c.h * rectH()}px` });
        el.appendChild(h('div', { class: 'label' }, a.name));
        el.appendChild(h('div', { class: 'handle' }));
        el.oncontextmenu = (e) => { e.preventDefault();
          if (confirm('Delete AOI "' + a.name + '"?')) { API.del('/api/aois/' + a.id);
            aois.splice(aois.indexOf(a), 1); draw(); } };
        el.ondblclick = async () => { const n = prompt('AOI name', a.name); if (n) {
          a.name = n; await API.patch('/api/aois/' + a.id, { name: n }); draw(); } };
        makeDraggable(el, a, c);
        overlay.appendChild(el);
      });
    }

    function makeDraggable(el, a, c) {
      let mode = null, sx, sy, orig;
      el.onmousedown = (e) => {
        e.stopPropagation();
        mode = e.target.classList.contains('handle') ? 'resize' : 'move';
        sx = e.clientX; sy = e.clientY; orig = { ...c };
        const move = (ev) => {
          const dx = (ev.clientX - sx) / rectW(), dy = (ev.clientY - sy) / rectH();
          if (mode === 'move') { c.x = clamp(orig.x + dx, 0, 1 - c.w); c.y = clamp(orig.y + dy, 0, 1 - c.h); }
          else { c.w = clamp(orig.w + dx, 0.02, 1 - c.x); c.h = clamp(orig.h + dy, 0.02, 1 - c.y); }
          el.style.left = c.x * rectW() + 'px'; el.style.top = c.y * rectH() + 'px';
          el.style.width = c.w * rectW() + 'px'; el.style.height = c.h * rectH() + 'px';
        };
        const up = async () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          await API.patch('/api/aois/' + a.id, { coordinates: c });
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      };
    }

    // draw new AOI by dragging on empty overlay
    overlay.onmousedown = (e) => {
      if (e.target !== overlay) return;
      const rect = img.getBoundingClientRect();
      const x0 = (e.clientX - rect.left) / rectW(), y0 = (e.clientY - rect.top) / rectH();
      const box = h('div', { class: 'aoi-rect' });
      overlay.appendChild(box);
      const move = (ev) => {
        const x1 = (ev.clientX - rect.left) / rectW(), y1 = (ev.clientY - rect.top) / rectH();
        const x = Math.min(x0, x1), y = Math.min(y0, y1);
        box.style.left = x * rectW() + 'px'; box.style.top = y * rectH() + 'px';
        box.style.width = Math.abs(x1 - x0) * rectW() + 'px'; box.style.height = Math.abs(y1 - y0) * rectH() + 'px';
      };
      const up = async (ev) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const x1 = (ev.clientX - rect.left) / rectW(), y1 = (ev.clientY - rect.top) / rectH();
        const c = { x: clamp(Math.min(x0, x1), 0, 1), y: clamp(Math.min(y0, y1), 0, 1),
          w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        box.remove();
        if (c.w < 0.02 || c.h < 0.02) return;
        const name = prompt('AOI name', 'AOI ' + (aois.length + 1)) || ('AOI ' + (aois.length + 1));
        const saved = await API.post('/api/stimuli/' + st.id + '/aois',
          { name, shape_type: 'rect', coordinates: c });
        aois.push(saved); draw();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
    draw();
  }

  // ---- Participants ---------------------------------------------------
  async function tabParticipants(study, body) {
    clear(body);
    const count = h('input', { type: 'number', value: '5', style: 'max-width:120px' });
    body.appendChild(h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('h3', {}, 'Generate participation links'),
      study.status !== 'active'
        ? h('div', { class: 'banner warn' }, 'Activate the study (Build tab) before sharing links.')
        : null,
      h('div', { style: 'display:flex;gap:12px;align-items:end' },
        h('div', {}, h('label', {}, 'How many'), count),
        h('button', { class: 'btn', onclick: async () => {
          const r = await API.post(`/api/studies/${study.id}/participants`, { count: +count.value });
          toast(`${r.participants.length} links created`); openStudy(study.id, 'Participants');
        } }, 'Generate'))));

    const { participants } = await API.get(`/api/studies/${study.id}/participants`);
    if (!participants.length) { body.appendChild(h('div', { class: 'empty' }, 'No participants yet.')); return; }
    const table = h('table');
    table.appendChild(h('tr', {}, ...['Link', 'Status', 'Completed', 'QA', 'Val. error', 'Valid %', 'Replay']
      .map(t => h('th', {}, t))));
    participants.forEach(p => {
      const link = `${location.origin}/study?token=${p.token}`;
      table.appendChild(h('tr', {},
        h('td', {}, h('a', { href: link, target: '_blank', class: 'mono' }, '/study?token=' + p.token.slice(0, 8) + '…'),
          h('button', { class: 'btn ghost', style: 'margin-left:8px;padding:2px 8px',
            onclick: () => { navigator.clipboard.writeText(link); toast('Link copied'); } }, 'copy')),
        h('td', {}, p.status || 'invited'),
        h('td', { class: 'muted' }, p.ended_at ? fmtTime(p.ended_at) : '—'),
        h('td', {}, p.quality_grade ? gradeBadge(p.quality_grade) : h('span', { class: 'muted' }, '—')),
        h('td', {}, p.median_error_px != null ? Math.round(p.median_error_px) + 'px' : '—'),
        h('td', {}, p.valid_sample_pct != null ? p.valid_sample_pct + '%' : '—'),
        h('td', {}, p.session_id
          ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openReplay(p.session_id); } }, 'view')
          : h('span', { class: 'muted' }, '—'))));
    });
    body.appendChild(table);
  }

  // ---- Results: heatmaps + AOI tables (PRD section 12) ----------------
  async function tabResults(study, body) {
    clear(body);
    const stimuli = study.stimuli || [];
    const { sessions } = await API.get(`/api/studies/${study.id}/sessions`);

    // Session selector: aggregate (all usable) or one specific session by time.
    const selector = h('select', { style: 'max-width:440px' },
      h('option', { value: '' }, `All usable sessions (${sessions.length} completed)`));
    sessions.forEach(s => {
      const bits = [fmtTime(s.ended_at), s.quality_grade || 'ungraded'];
      if (s.median_error_px != null) bits.push(Math.round(s.median_error_px) + 'px');
      selector.appendChild(h('option', { value: s.session_id }, bits.join('  ·  ')));
    });

    body.appendChild(h('div', { class: 'btn-row', style: 'margin-bottom:14px;align-items:center' },
      h('button', { class: 'btn secondary', onclick: async () => {
        const r = await API.post(`/api/studies/${study.id}/process`);
        toast(`Re-processed ${r.processed_sessions} sessions`); openStudy(study.id, 'Results');
      } }, '↻ Re-run analysis'),
      h('label', { style: 'margin:0;color:var(--muted)' }, 'View:'), selector));

    const results = h('div', {});
    body.appendChild(results);

    async function renderResults(sessionId) {
      clear(results);
      if (!stimuli.length) {
        results.appendChild(h('div', { class: 'empty' }, 'No stimuli to analyze.')); return;
      }
      if (sessionId) {
        const s = sessions.find(x => x.session_id === sessionId);
        if (s) results.appendChild(h('div', { class: 'banner info' },
          `Single session — started ${fmtTime(s.started_at)}, ended ${fmtTime(s.ended_at)} · ` +
          `QA ${s.quality_grade || 'ungraded'}`));
        // Screen recording + gaze replay (for time-changing stimuli).
        if (s && s.screen_recording_url) {
          try { results.appendChild(await gazeReplayPlayer(sessionId)); }
          catch (e) { console.warn('replay load failed', e); }
        }
      }
      for (const st of stimuli) results.appendChild(await stimulusResult(st, sessionId));
    }
    selector.addEventListener('change', () => renderResults(selector.value));
    renderResults('');
  }

  async function stimulusResult(st, sessionId) {
    const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    const data = await API.get(`/api/stimuli/${st.id}/analysis${q}`);
    const wrap = h('div', { class: 'card', style: 'margin-bottom:18px' });
    wrap.appendChild(h('h3', { style: 'color:var(--text);text-transform:none' },
      sessionId ? 'Stimulus · selected session'
                : `Stimulus · ${data.n_sessions} usable session(s)`));
    if (data.n_sessions === 0) {
      wrap.appendChild(h('p', { class: 'muted' }, 'No usable gaze data yet for this stimulus.'));
      return wrap;
    }
    // Website stimulus: cross-origin, can't be captured to a canvas, so show the
    // gaze heatmap on a blank viewport-shaped panel with a link to the site.
    if (st.type === 'url') {
      wrap.appendChild(h('p', { class: 'hint' },
        h('span', {}, 'Website: '),
        h('a', { href: st.file_url, target: '_blank', class: 'mono', style: 'color:var(--accent)' }, st.file_url)));
      const holder = h('div', { style: 'position:relative;width:100%;max-width:640px;aspect-ratio:16/9;background:var(--panel-2);border:1px solid var(--border);border-radius:8px' });
      const canvas = h('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
      holder.appendChild(canvas);
      wrap.appendChild(holder);
      const drawWhenSized = () => {
        const w = holder.clientWidth, hh = holder.clientHeight;
        if (!w || !hh) { requestAnimationFrame(drawWhenSized); return; }
        canvas.width = w; canvas.height = hh;
        try { drawHeatmap(canvas, data.heatmap_points); } catch (e) { console.warn('heatmap draw failed', e); }
      };
      requestAnimationFrame(drawWhenSized);
      wrap.appendChild(h('p', { class: 'hint' }, 'Heatmap shows where gaze concentrated on screen (relative to the full viewport).'));
      return wrap;
    }
    // heatmap canvas over the stimulus (image or video frame)
    const isVideo = st.type === 'video' || /\.(mp4|webm|ogg)$/i.test(st.file_url || '');
    const holder = h('div', { style: 'position:relative;display:inline-block;max-width:100%' });
    const media = isVideo
      ? h('video', { src: st.file_url, controls: 'controls', style: 'max-width:100%;display:block' })
      : h('img', { src: st.file_url, style: 'max-width:100%;display:block' });
    const canvas = h('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
    holder.appendChild(media); holder.appendChild(canvas);
    // Draw only once the media is laid out in the document (clientWidth > 0).
    const sizeAndDraw = () => {
      const w = media.clientWidth, hh = media.clientHeight;
      if (!w || !hh) { requestAnimationFrame(sizeAndDraw); return; }
      canvas.width = w; canvas.height = hh;
      try {
        drawHeatmap(canvas, data.heatmap_points);
        drawAoiOverlay(holder, media, data.aois);
      } catch (e) { console.warn('heatmap draw failed', e); }
    };
    media.addEventListener(isVideo ? 'loadeddata' : 'load', () => requestAnimationFrame(sizeAndDraw));
    if (!isVideo && media.complete && media.naturalWidth) requestAnimationFrame(sizeAndDraw);
    wrap.appendChild(holder);

    // AOI table
    if (data.aoi_summary.length) {
      const t = h('table', { style: 'margin-top:14px' });
      t.appendChild(h('tr', {}, ...['AOI', 'Viewed-by %', 'TTFF (ms)', 'Dwell (ms)', 'Fixations', 'Revisits', 'Total time (ms)']
        .map(x => h('th', {}, x))));
      data.aoi_summary.forEach(s => t.appendChild(h('tr', {},
        h('td', {}, s.aoi_name),
        h('td', {}, s.viewed_by_pct + '%'),
        h('td', {}, fmt(s.ttff_ms_median)),
        h('td', {}, fmt(s.dwell_ms_median)),
        h('td', {}, fmt(s.fixation_count_median)),
        h('td', {}, fmt(s.revisits_median)),
        h('td', {}, fmt(s.total_time_ms_mean)))));
      wrap.appendChild(t);
    } else {
      wrap.appendChild(h('p', { class: 'hint' }, 'No AOIs defined — add AOIs in the Stimuli tab for attention metrics.'));
    }
    wrap.appendChild(h('p', { class: 'hint' },
      '⚠ Interpret heatmaps alongside AOI metrics and behavioral outcomes — never alone (PRD §19).'));
    return wrap;
  }

  // Gaze replay: plays the session screen recording with a time-synced gaze dot +
  // trail overlaid — the right view for time-changing stimuli (scrolling sites, video).
  async function gazeReplayPlayer(sessionId) {
    const data = await API.get(`/api/session/${sessionId}/screen-replay`);
    const wrap = h('div', { class: 'card', style: 'margin-bottom:18px' });
    wrap.appendChild(h('h3', { style: 'color:var(--text);text-transform:none' },
      '▶ Gaze replay — what they saw + where they looked'));
    if (!data.screen_recording_url) {
      wrap.appendChild(h('p', { class: 'muted' }, 'No screen recording for this session.'));
      return wrap;
    }
    const gaze = (data.gaze || []).map(g => ({ t: g[0], x: g[1], y: g[2] }));
    const holder = h('div', { style: 'position:relative;display:inline-block;max-width:100%' });
    const video = h('video', { src: data.screen_recording_url, controls: 'controls',
      style: 'max-width:100%;display:block;border-radius:8px;background:#000' });
    const canvas = h('canvas', { style: 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none' });
    holder.appendChild(video); holder.appendChild(canvas);
    wrap.appendChild(holder);
    wrap.appendChild(h('p', { class: 'hint' },
      `${gaze.length} gaze points · red ring = current gaze, blue trail = last ~1.5 s. Scrub the video to any moment.`));

    const ctx = canvas.getContext('2d');
    let raf = null;
    function drawOnce() {
      const w = video.clientWidth, hh = video.clientHeight;
      if (w && hh && (canvas.width !== w || canvas.height !== hh)) { canvas.width = w; canvas.height = hh; }
      if (!canvas.width) return;
      const tms = video.currentTime * 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const recent = gaze.filter(g => g.t <= tms && g.t >= tms - 1500);
      for (const g of recent) {
        const age = (tms - g.t) / 1500;                 // 0 newest .. 1 oldest
        const px = g.x * canvas.width, py = g.y * canvas.height;
        ctx.beginPath();
        ctx.arc(px, py, 3 + 6 * (1 - age), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(79,156,249,${0.08 + 0.32 * (1 - age)})`;
        ctx.fill();
      }
      const cur = recent.length ? recent[recent.length - 1] : null;
      if (cur) {
        const px = cur.x * canvas.width, py = cur.y * canvas.height;
        ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,60,0,0.9)'; ctx.lineWidth = 3; ctx.stroke();
      }
    }
    function loop() { drawOnce(); raf = (!video.paused && !video.ended) ? requestAnimationFrame(loop) : null; }
    video.addEventListener('play', () => { if (!raf) loop(); });
    video.addEventListener('seeked', drawOnce);
    video.addEventListener('timeupdate', () => { if (video.paused) drawOnce(); });
    video.addEventListener('loadeddata', drawOnce);
    return wrap;
  }

  function drawHeatmap(canvas, points) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    // accumulate intensity
    const acc = ctx.createImageData(W, H);
    const heat = new Float32Array(W * H);
    const r = Math.max(24, Math.round(W * 0.05));
    points.forEach(p => {
      if (p.x == null) return;
      const px = p.x * W, py = p.y * H;
      const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(W, Math.ceil(px + r));
      const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(H, Math.ceil(py + r));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        heat[y * W + x] += Math.exp(-d2 / (2 * (r / 2) ** 2));
      }
    });
    let peak = 0; for (let i = 0; i < heat.length; i++) peak = Math.max(peak, heat[i]);
    if (peak === 0) return;
    for (let i = 0; i < heat.length; i++) {
      const v = Math.min(1, heat[i] / peak);
      if (v < 0.02) continue;
      const [rr, gg, bb] = heatColor(v);
      acc.data[i * 4] = rr; acc.data[i * 4 + 1] = gg; acc.data[i * 4 + 2] = bb;
      acc.data[i * 4 + 3] = Math.round(200 * v);
    }
    ctx.putImageData(acc, 0, 0);
  }

  function heatColor(v) {
    // blue -> green -> yellow -> red
    if (v < 0.33) return [0, Math.round(120 + v * 300), 255];
    if (v < 0.66) return [Math.round((v - 0.33) * 765), 220, Math.round(255 - (v - 0.33) * 765)];
    return [255, Math.round(220 - (v - 0.66) * 600), 0];
  }

  function drawAoiOverlay(holder, img, aois) {
    aois.forEach(a => {
      const c = a.coordinates || JSON.parse(a.coordinates_json || '{}');
      const el = h('div', { class: 'aoi-rect', style:
        `left:${c.x * img.clientWidth}px;top:${c.y * img.clientHeight}px;` +
        `width:${c.w * img.clientWidth}px;height:${c.h * img.clientHeight}px;pointer-events:none;background:none` });
      el.appendChild(h('div', { class: 'label' }, a.name));
      holder.appendChild(el);
    });
  }

  // ---- Session replay -------------------------------------------------
  async function openReplay(sessionId) {
    const data = await API.get(`/api/session/${sessionId}/replay`);
    const root = app(); clear(root);
    root.appendChild(h('a', { href: '#', onclick: (e) => { e.preventDefault(); history.back(); renderList(); } }, '← Back'));
    root.appendChild(h('h1', {}, 'Session replay'));
    root.appendChild(h('p', { class: 'muted', style: 'margin-top:-6px' },
      `Started ${fmtTime(data.started_at)} · Ended ${fmtTime(data.ended_at)}`));
    if (data.qa) {
      const q = data.qa;
      root.appendChild(h('div', { class: 'grid cols-4' },
        miniStat('QA grade', q.quality_grade), miniStat('Valid %', q.valid_sample_pct + '%'),
        miniStat('Face lost %', q.face_lost_pct + '%'), miniStat('FPS', q.fps_median)));
      if (q.exclusion_reason) root.appendChild(h('div', { class: 'banner warn', style: 'margin-top:12px' },
        'Exclusion flags: ' + q.exclusion_reason));
    }
    // Accuracy diagnostics: which eye(s) the model chose + per-point validation errors.
    if (data.eye_mode) {
      const em = data.eye_mode_errors_px || {};
      root.appendChild(h('p', { class: 'muted', style: 'margin-top:14px' },
        `Eye mode: ${data.eye_mode}` +
        (em.both != null ? `  (held-out px — both: ${em.both}, right: ${em.right}, left: ${em.left})` : '')));
    }
    if (data.validation && data.validation.details) {
      const d = data.validation.details;
      const errs = d.errors_px || [];
      const pts = d.points || [];
      const label = (p) => p ? `(${Math.round(p.x * 100)}%,${Math.round(p.y * 100)}%)` : '';
      root.appendChild(h('p', { class: 'muted' },
        `Validation: median ${Math.round(data.validation.median_error_px || 0)}px, ` +
        `retry ${data.validation.retry_count} — per point: ` +
        errs.map((e, i) => `${label(pts[i])} ${Math.round(e)}px`).join(' · ')));
    }
    if (data.recording_url) {
      root.appendChild(h('h3', { style: 'margin-top:20px;color:var(--muted)' }, 'Session recording'));
      const vid = h('video', { src: data.recording_url, controls: 'controls',
        style: 'max-width:480px;border-radius:8px;border:1px solid var(--border)' });
      root.appendChild(h('div', {}, vid));
      root.appendChild(h('div', { class: 'btn-row', style: 'margin-top:8px' },
        h('a', { class: 'btn ghost', href: data.recording_url, download: '' }, '⬇ Download recording')));
    }
    data.trials.forEach((tr, i) => {
      root.appendChild(h('p', { class: 'muted', style: 'margin-top:18px' },
        `Trial ${i + 1}: ${tr.samples.length} gaze samples, ${tr.fixations.length} fixations`));
    });
  }
  function miniStat(l, v) { return h('div', { class: 'card' }, h('h3', {}, l), h('div', { class: 'stat' }, String(v))); }

  // ---- Benchmark: aggregate accuracy vs RealEye (PRD §15) -------------
  async function tabBenchmark(study, body) {
    clear(body);
    const b = await API.get(`/api/studies/${study.id}/benchmark`);
    if (!b.n_sessions) {
      body.appendChild(h('div', { class: 'empty' },
        'No completed sessions yet. Run a few participants, then this report aggregates their accuracy.'));
      return;
    }
    const ref = b.realeye_ref_px;
    const v = b.validation_px, m = b.model_heldout_px;
    const better = v && v.median < ref;

    body.appendChild(h('div', { class: 'banner ' + (better ? 'info' : 'warn') },
      better
        ? `Across ${v.n} sessions, median accuracy is ${v.median}px — better than RealEye's published ~${ref}px reference.`
        : `Across ${v.n} sessions, median accuracy is ${v ? v.median : '—'}px vs RealEye's ~${ref}px reference.`));

    // headline stats
    const grid = h('div', { class: 'grid cols-4' },
      miniStat('Sessions', b.n_sessions),
      miniStat('Usable', b.usable_pct + '%'),
      miniStat('Median accuracy', (v ? v.median : '—') + 'px'),
      miniStat('Model held-out', (m ? m.median : '—') + 'px'));
    body.appendChild(grid);

    // distribution
    const dist = h('div', { class: 'grid cols-2', style: 'margin-top:16px' });
    dist.appendChild(h('div', { class: 'card' }, h('h3', {}, 'Validation accuracy (px, across sessions)'),
      v ? distTable(v, ref) : h('p', { class: 'muted' }, 'no data')));
    dist.appendChild(h('div', { class: 'card' }, h('h3', {}, 'QA grade split'),
      ...['pass', 'warn', 'fail'].map(g => h('div', { class: 'kv' },
        gradeBadge(g), h('span', {}, String(b.grade_counts[g] || 0))))));
    body.appendChild(dist);

    // per-region accuracy map
    body.appendChild(h('div', { class: 'card', style: 'margin-top:16px' },
      h('h3', {}, 'Accuracy by screen region (mean px, lower = better)'),
      regionMap(b.regions, ref)));

    // eye modes
    if (Object.keys(b.eye_modes).length) {
      body.appendChild(h('div', { class: 'card', style: 'margin-top:16px' },
        h('h3', {}, 'Eye mode selected (strabismus / weak-eye handling)'),
        ...Object.entries(b.eye_modes).map(([k, n]) =>
          h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(n) + ' sessions')))));
    }
    body.appendChild(h('p', { class: 'hint', style: 'margin-top:14px' },
      'This is the honest benchmark: aggregate accuracy across real sessions, not a single ' +
      'run. Judge the product here — one participant’s momentary head movement averages out.'));
  }

  function distTable(s, ref) {
    const wrap = h('div', {});
    [['Best', s.min], ['Median', s.median], ['Mean', s.mean], ['Worst', s.max]].forEach(([label, val]) => {
      const pct = Math.min(100, (val / (ref * 2)) * 100);
      const good = val < ref;
      wrap.appendChild(h('div', { style: 'margin:8px 0' },
        h('div', { style: 'display:flex;justify-content:space-between;font-size:13px' },
          h('span', { class: 'muted' }, label),
          h('span', { style: `color:${good ? 'var(--ok)' : 'var(--warn)'}` }, val + 'px')),
        h('div', { style: 'height:7px;background:var(--panel-2);border-radius:99px;overflow:hidden;margin-top:3px' },
          h('div', { style: `height:100%;width:${pct}%;background:${good ? 'var(--ok)' : 'var(--warn)'}` }))));
    });
    wrap.appendChild(h('p', { class: 'hint' }, `Dashed line = RealEye ~${ref}px reference.`));
    return wrap;
  }

  function regionMap(regions, ref) {
    // 3x3-ish grid positioned by x/y percentage
    const box = h('div', { style: 'position:relative;width:100%;max-width:520px;aspect-ratio:16/10;' +
      'background:var(--panel-2);border:1px solid var(--border);border-radius:8px;margin-top:8px' });
    regions.forEach(r => {
      const good = r.mean_px < ref;
      box.appendChild(h('div', { style:
        `position:absolute;left:${r.x}%;top:${r.y}%;transform:translate(-50%,-50%);` +
        `background:${good ? 'rgba(54,194,122,.22)' : 'rgba(232,161,58,.22)'};` +
        `border:1px solid ${good ? 'var(--ok)' : 'var(--warn)'};border-radius:6px;` +
        'padding:4px 8px;font-size:12px;font-weight:600;white-space:nowrap',
        title: `screen ${r.x}%,${r.y}% · ${r.n} sessions` },
        r.mean_px + 'px'));
    });
    return box;
  }

  // ---- Exports --------------------------------------------------------
  function tabExports(study, body) {
    clear(body);
    const kinds = [
      ['raw_gaze', 'Raw gaze (normalized)', 'Every gaze sample, reproducible source data'],
      ['fixations', 'Fixations', 'Detected fixations with AOI assignment'],
      ['aoi_summary', 'AOI summary', 'Viewed-by %, TTFF, dwell, revisits per AOI'],
      ['qa', 'QA report', 'Per-session quality + exclusion flags'],
      ['events', 'Events', 'Clicks, visibility, fullscreen, onsets'],
      ['responses', 'Survey responses', 'Participant answers'],
    ];
    const grid = h('div', { class: 'grid cols-2' });
    kinds.forEach(([k, label, desc]) => grid.appendChild(h('div', { class: 'card' },
      h('h3', { style: 'color:var(--text);text-transform:none' }, label),
      h('p', { class: 'muted' }, desc),
      h('a', { class: 'btn', href: `/api/studies/${study.id}/export/${k}` }, '⬇ Download CSV'))));
    body.appendChild(grid);
    body.appendChild(h('div', { class: 'banner info', style: 'margin-top:16px' },
      'All exports derive from stored raw data so any report can be reproduced (PRD §11, §18).'));
  }

  // ---- utils ----------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmt = (v) => v == null ? '—' : (typeof v === 'number' ? Math.round(v) : v);
  const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';

  renderList();
})();
