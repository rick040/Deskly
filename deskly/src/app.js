(() => {
  const T = window.__TAURI__;
  const GRID = 20;
  const ACCENTS = ['#7c9cff', '#5eead4', '#f59e8b', '#c4a7ff', '#f5d36e', '#8be28b'];
  const SIZES = {
    fence: [360, 220], clock: [300, 140], notes: [280, 220],
    todo: [280, 260], stats: [240, 130], web: [520, 440],
  };
  const stage = document.getElementById('stage');
  const modalEl = document.getElementById('modal');

  // ---------- backend bridge (falls back to localStorage in a plain browser) ----------
  async function invoke(cmd, args = {}) {
    if (T) return T.core.invoke(cmd, args);
    switch (cmd) {
      case 'load_config': return localStorage.getItem('deskly');
      case 'save_config': localStorage.setItem('deskly', args.json); return;
      case 'list_apps': return [
        { name: 'Google Chrome', path: 'C:\\chrome.lnk' }, { name: 'Notion', path: 'C:\\notion.lnk' },
        { name: 'Spotify', path: 'C:\\spotify.lnk' }, { name: 'Visual Studio Code', path: 'C:\\code.lnk' },
        { name: 'Figma', path: 'C:\\figma.lnk' }, { name: 'WhatsApp', path: 'C:\\wa.lnk' },
      ];
      case 'sys_stats': return [20 + Math.random() * 40, 45 + Math.random() * 15];
      default: return null;
    }
  }

  // ---------- state ----------
  const uid = () => Math.random().toString(36).slice(2, 9);
  const snap = (v) => Math.round(v / GRID) * GRID;
  let state = null;
  let edit = false;
  let timers = [];
  let webIds = new Set();
  let appCache = null;

  const defaults = () => ({
    accent: ACCENTS[0],
    panels: [
      { id: uid(), type: 'clock', x: 40, y: 40, w: 300, h: 140 },
      { id: uid(), type: 'fence', title: 'Apps', color: ACCENTS[0], x: 40, y: 200, w: 360, h: 220, items: [] },
    ],
  });

  let saveT;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => invoke('save_config', { json: JSON.stringify(state) }), 300);
  }
  let renderQ = false;
  function renderSoon() {
    if (renderQ) return;
    renderQ = true;
    requestAnimationFrame(() => { renderQ = false; render(); });
  }

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const place = (e, p) => {
    e.style.left = p.x + 'px'; e.style.top = p.y + 'px';
    e.style.width = p.w + 'px'; e.style.height = p.h + 'px';
  };
  const baseName = (path) => path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || path;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const normUrl = (u) => (/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);

  // ---------- modal ----------
  function openModal(build) {
    invoke('web_hide_all', { hidden: true });
    modalEl.innerHTML = '';
    const box = el('div', 'modal');
    modalEl.append(box);
    modalEl.hidden = false;
    const close = () => { modalEl.hidden = true; modalEl.innerHTML = ''; invoke('web_hide_all', { hidden: false }); };
    modalEl.onclick = (e) => { if (e.target === modalEl) close(); };
    build(box, close);
  }

  function askUrl(current, cb) {
    openModal((box, close) => {
      box.append(el('h3', null, 'Web page'));
      const inp = el('input'); inp.type = 'text'; inp.placeholder = 'https://www.notion.so'; inp.value = current || '';
      box.append(inp);
      const row = el('div', 'row');
      const cancel = el('button', null, 'Cancel'); cancel.onclick = close;
      const ok = el('button', 'primary', 'Save');
      const go = () => { const v = inp.value.trim(); if (v) { close(); cb(normUrl(v)); } };
      ok.onclick = go; inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      row.append(cancel, ok); box.append(row);
      setTimeout(() => inp.focus(), 30);
    });
  }

  async function openPicker(p) {
    if (!appCache) appCache = (await invoke('list_apps')) || [];
    openModal((box, close) => {
      box.append(el('h3', null, 'Add apps to "' + (p.title || 'Fence') + '"'));
      const q = el('input'); q.type = 'text'; q.placeholder = 'Search installed apps...';
      const list = el('div', 'list');
      box.append(q, list);
      const draw = () => {
        const s = q.value.toLowerCase();
        list.innerHTML = '';
        appCache.filter((a) => a.name.toLowerCase().includes(s)).slice(0, 80).forEach((a) => {
          const added = p.items.some((i) => i.path === a.path);
          const li = el('div', 'li' + (added ? ' added' : ''));
          li.append(el('span', null, a.name), el('span', null, added ? 'added' : '+'));
          li.onclick = () => { if (!added) { addItems(p, [a]); draw(); } };
          list.append(li);
        });
        if (!list.children.length) list.append(el('div', 'empty', 'No apps found'));
      };
      q.oninput = draw; draw();
      const row = el('div', 'row');
      const done = el('button', 'primary', 'Done'); done.onclick = close;
      row.append(done); box.append(row);
      setTimeout(() => q.focus(), 30);
    });
  }

  // ---------- items ----------
  function addItems(p, entries) {
    entries.forEach((en) => {
      if (p.items.some((i) => i.path === en.path)) return;
      const it = { name: en.name || baseName(en.path), path: en.path, icon: null };
      p.items.push(it);
      invoke('get_icon', { path: it.path }).then((icon) => {
        if (icon) { it.icon = icon; save(); renderSoon(); }
      });
    });
    save(); renderSoon();
  }

  // ---------- panels ----------
  function buildPanel(p) {
    const e = el('section', 'panel ' + p.type);
    e.dataset.id = p.id;
    if (p.color) e.style.setProperty('--pc', p.color);
    place(e, p);

    const head = el('header');
    const title = el('span', 'title', p.title || (p.type === 'web' ? host(p.url) : p.type));
    head.append(title);
    if (edit) {
      if (p.type === 'fence' || p.type === 'web') {
        title.contentEditable = 'true';
        title.oninput = () => { p.title = title.textContent; save(); };
        title.onpointerdown = (ev) => ev.stopPropagation();
      }
      if (p.type === 'fence') {
        const add = el('button', 'hbtn', '+'); add.title = 'Add apps';
        add.onpointerdown = (ev) => ev.stopPropagation();
        add.onclick = () => openPicker(p);
        const dot = el('button', 'dot'); dot.title = 'Color';
        dot.onpointerdown = (ev) => ev.stopPropagation();
        dot.onclick = () => {
          const i = ACCENTS.indexOf(p.color);
          p.color = ACCENTS[(i + 1) % ACCENTS.length]; save(); renderSoon();
        };
        head.append(dot, add);
      }
      if (p.type === 'web') {
        const re = el('button', 'hbtn', '\u21BB'); re.title = 'Change URL';
        re.onpointerdown = (ev) => ev.stopPropagation();
        re.onclick = () => askUrl(p.url, (u) => { p.url = u; p.title = ''; invoke('web_close', { id: p.id }).then(renderSoon); save(); });
        head.append(re);
      }
      const del = el('button', 'hbtn', '\u2715'); del.title = 'Remove';
      del.onpointerdown = (ev) => ev.stopPropagation();
      del.onclick = () => { state.panels = state.panels.filter((x) => x !== p); save(); render(); };
      head.append(del);
      head.onpointerdown = (ev) => startDrag(ev, p, e, 'move');
    }
    e.append(head);

    const body = el('div', 'body');
    ({ fence: fenceBody, clock: clockBody, notes: notesBody, todo: todoBody, stats: statsBody, web: webBody }[p.type])(p, body);
    e.append(body);

    if (edit) {
      const rz = el('div', 'rz');
      rz.onpointerdown = (ev) => startDrag(ev, p, e, 'resize');
      e.append(rz);
    }
    return e;
  }

  function fenceBody(p, body) {
    if (!p.items.length) {
      body.append(el('div', 'empty', edit ? 'Press + to pick apps, or drop files here' : 'Empty fence'));
      return;
    }
    const grid = el('div', 'grid');
    p.items.forEach((it, idx) => {
      const b = el('div', 'item'); b.title = it.path;
      const ic = el('div', 'ic');
      if (it.icon) { const im = new Image(); im.src = it.icon; ic.append(im); }
      else ic.textContent = (it.name[0] || '?').toUpperCase();
      b.append(ic, el('span', null, it.name));
      b.onclick = () => { if (!edit) invoke('launch', { path: it.path }); };
      if (edit) {
        const x = el('button', 'x', '\u00D7');
        x.onclick = (ev) => { ev.stopPropagation(); p.items.splice(idx, 1); save(); renderSoon(); };
        b.append(x);
      }
      grid.append(b);
    });
    body.append(grid);
  }

  function clockBody(p, body) {
    const t = el('div', 'time'); const d = el('div', 'date');
    body.append(t, d);
    const tick = () => {
      const n = new Date();
      t.textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      d.textContent = n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    };
    tick(); timers.push(setInterval(tick, 10000));
  }

  function notesBody(p, body) {
    const ta = el('textarea'); ta.placeholder = 'Notes...'; ta.value = p.text || '';
    ta.oninput = () => { p.text = ta.value; save(); };
    body.append(ta);
  }

  function todoBody(p, body) {
    p.tasks = p.tasks || [];
    const list = el('div');
    const inp = el('input', 'add'); inp.placeholder = 'Add a task and press Enter';
    const draw = () => {
      list.innerHTML = '';
      p.tasks.forEach((t, i) => {
        const r = el('div', 'row' + (t.done ? ' done' : ''));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!t.done;
        cb.onchange = () => { t.done = cb.checked; save(); draw(); };
        const lb = el('label', null, t.text);
        const x = el('button', 'del', '\u2715');
        x.onclick = () => { p.tasks.splice(i, 1); save(); draw(); };
        r.append(cb, lb, x); list.append(r);
      });
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && inp.value.trim()) { p.tasks.push({ text: inp.value.trim(), done: false }); inp.value = ''; save(); draw(); }
    };
    draw(); body.append(list, inp);
  }

  function statsBody(p, body) {
    const mk = (name) => {
      const m = el('div', 'm'); const top = el('div'); const v = el('span', null, '-');
      top.append(el('span', null, name), v);
      const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill); m.append(top, bar); body.append(m);
      return (val) => { v.textContent = Math.round(val) + '%'; fill.style.width = Math.min(100, val) + '%'; };
    };
    const setCpu = mk('CPU'); const setRam = mk('Memory');
    const poll = async () => { const s = await invoke('sys_stats'); if (s) { setCpu(s[0]); setRam(s[1]); } };
    poll(); timers.push(setInterval(poll, 2500));
  }

  function webBody(p, body) {
    body.append(el('div', 'web-slot'));
  }

  // ---------- drag / resize ----------
  function startDrag(ev, p, e, mode) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget; handle.setPointerCapture(ev.pointerId);
    const sx = ev.clientX, sy = ev.clientY, o = { x: p.x, y: p.y, w: p.w, h: p.h };
    const move = (m) => {
      const dx = m.clientX - sx, dy = m.clientY - sy;
      if (mode === 'move') {
        p.x = Math.max(0, Math.min(innerWidth - p.w, snap(o.x + dx)));
        p.y = Math.max(0, Math.min(innerHeight - 40, snap(o.y + dy)));
      } else {
        p.w = Math.max(120, snap(o.w + dx)); p.h = Math.max(100, snap(o.h + dy));
      }
      place(e, p); syncWeb();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  // ---------- native web views ----------
  let syncQ = false;
  function syncWeb() {
    if (syncQ) return;
    syncQ = true;
    requestAnimationFrame(() => {
      syncQ = false;
      state.panels.filter((p) => p.type === 'web').forEach((p) => {
        const slot = stage.querySelector('[data-id="' + p.id + '"] .web-slot');
        if (!slot) return;
        const r = slot.getBoundingClientRect();
        invoke('web_set', { id: p.id, url: p.url, x: r.left, y: r.top, w: r.width, h: r.height });
      });
    });
  }

  // ---------- click-through ----------
  // Outside edit mode only the panels and the gear catch the mouse; everywhere else
  // clicks fall through to the desktop icons underneath. Calls are chained so an
  // older region can never land after a newer one.
  let hitQ = false;
  let hitChain = Promise.resolve();
  function syncHit() {
    if (hitQ) return;
    hitQ = true;
    requestAnimationFrame(() => {
      hitQ = false;
      const rects = edit ? null : [...stage.querySelectorAll('.panel'), document.getElementById('gear')].map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      hitChain = hitChain.then(() => invoke('set_hit_area', { rects })).catch(() => {});
    });
  }

  // ---------- render ----------
  function render() {
    timers.forEach(clearInterval); timers = [];
    stage.innerHTML = '';
    document.body.classList.toggle('edit', edit);
    document.getElementById('toolbar').hidden = !edit;
    document.documentElement.style.setProperty('--accent', state.accent);
    document.querySelectorAll('#swatches i').forEach((s) => s.classList.toggle('on', s.dataset.c === state.accent));
    const live = new Set();
    state.panels.forEach((p) => { stage.append(buildPanel(p)); if (p.type === 'web') live.add(p.id); });
    webIds.forEach((id) => { if (!live.has(id)) invoke('web_close', { id }); });
    webIds = live;
    syncWeb();
    syncHit();
  }

  function setEdit(v) { edit = v; render(); }

  function freeSpot(w, h) {
    const hit = (x, y) => state.panels.some((q) => x < q.x + q.w + GRID && x + w + GRID > q.x && y < q.y + q.h + GRID && y + h + GRID > q.y);
    for (let y = 80; y + h <= innerHeight; y += GRID)
      for (let x = 40; x + w <= innerWidth; x += GRID) if (!hit(x, y)) return [x, y];
    const n = state.panels.length % 8;
    return [snap(120 + n * 40), snap(120 + n * 40)];
  }

  function addPanel(type) {
    const make = (url) => {
      const [w, h] = SIZES[type];
      const [x, y] = freeSpot(w, h);
      const p = { id: uid(), type, x, y, w, h };
      if (type === 'fence') { p.title = 'New fence'; p.items = []; p.color = state.accent; }
      if (type === 'web') p.url = url;
      state.panels.push(p); save(); render();
    };
    if (type === 'web') askUrl('https://www.notion.so', make); else make();
  }

  // ---------- init ----------
  async function init() {
    if (!T) document.body.classList.add('preview');
    try { const raw = await invoke('load_config'); state = raw ? JSON.parse(raw) : defaults(); }
    catch { state = defaults(); }
    if (!state.panels) state = defaults();

    const sw = document.getElementById('swatches');
    ACCENTS.forEach((c) => {
      const i = el('i'); i.style.background = c; i.dataset.c = c;
      i.onclick = () => { state.accent = c; save(); render(); };
      sw.append(i);
    });
    document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => addPanel(b.dataset.add); });
    document.getElementById('done').onclick = () => setEdit(false);
    document.getElementById('gear').onclick = () => setEdit(true);
    addEventListener('resize', () => { syncWeb(); syncHit(); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && edit && modalEl.hidden) setEdit(false); });

    if (T) {
      T.event.listen('toggle-edit', () => setEdit(!edit));
      T.webview.getCurrentWebview().onDragDropEvent((ev) => {
        const pl = ev.payload;
        if (pl.type !== 'drop') return;
        const x = pl.position.x / devicePixelRatio, y = pl.position.y / devicePixelRatio;
        const fences = state.panels.filter((p) => p.type === 'fence');
        const f = fences.find((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) || fences[0];
        if (f) addItems(f, pl.paths.map((path) => ({ name: baseName(path), path })));
      });
    }
    render();
  }
  init();
})();
