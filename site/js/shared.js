// Shared pixel canvas — every visitor paints one cell at a time.
// State lives on the server. Clients fetch the full event log on load
// and POST a single {x,y,v} when they want to draw.

(function () {
  'use strict';

  const CELL = 10; // CSS pixels per cell; canvas is 640×640
  let W = 64, H = 64;
  const canvas = document.getElementById('shared');
  const ctx = canvas.getContext('2d');

  // We hold a sparse map of cell->value. Pixels default to 0 (background).
  // After every server fetch we rebuild this map by replaying events.
  let cells = new Map();
  let myVersion = 0;
  let lastPostAt = 0;
  const MIN_INTERVAL_MS = 5000;
  const STATUS_EL = document.getElementById('shared-status');
  const META_EL = document.getElementById('shared-meta');

  function setStatus(msg, kind) {
    if (!STATUS_EL) return;
    STATUS_EL.textContent = msg;
    STATUS_EL.dataset.kind = kind || 'info';
  }

  function metaText() {
    let n = 0;
    for (const v of cells.values()) if (v) n++;
    return W + '×' + H + ' · ' + n + ' set · version ' + myVersion;
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function draw() {
    const bg = getCss('--bg') || '#fff';
    const fg = getCss('--fg') || '#1a1a1a';
    const accent = getCss('--accent') || '#2c5e3a';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Faint grid.
    const rule = getCss('--rule') || '#d8d4c7';
    ctx.strokeStyle = rule;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= W; i++) {
      ctx.moveTo(i * CELL + 0.5, 0);
      ctx.lineTo(i * CELL + 0.5, canvas.height);
    }
    for (let j = 0; j <= H; j++) {
      ctx.moveTo(0, j * CELL + 0.5);
      ctx.lineTo(canvas.width, j * CELL + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Cells — use accent so it reads as something a visitor "owns".
    ctx.fillStyle = accent;
    for (const [key, v] of cells) {
      if (!v) continue;
      const idx = key.indexOf(',');
      const x = +key.slice(0, idx);
      const y = +key.slice(idx + 1);
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }

    if (META_EL) META_EL.textContent = metaText();
  }

  function rebuildFromEvents(events) {
    cells = new Map();
    for (const e of events) {
      if (!e || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      cells.set(e.x + ',' + e.y, e.v ? 1 : 0);
    }
  }

  async function load() {
    setStatus('loading…');
    try {
      const r = await fetch('/api/shared', { cache: 'no-cache' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      W = data.w || W;
      H = data.h || H;
      canvas.width = W * CELL;
      canvas.height = H * CELL;
      myVersion = data.version || 0;
      rebuildFromEvents(data.events || []);
      draw();
      setStatus('ready · ' + (data.events || []).length + ' events loaded', 'ok');
    } catch (e) {
      setStatus('load failed: ' + e.message, 'err');
    }
  }

  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return [Math.floor(x / CELL), Math.floor(y / CELL)];
  }

  let hover = null;

  function drawHover() {
    draw();
    if (!hover) return;
    const [x, y] = hover;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const accent = getCss('--accent') || '#2c5e3a';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
    ctx.globalAlpha = 1;
  }

  canvas.addEventListener('mousemove', (ev) => {
    const [x, y] = cellFromEvent(ev);
    if (x < 0 || y < 0 || x >= W || y >= H) {
      if (hover) { hover = null; drawHover(); }
      return;
    }
    if (!hover || hover[0] !== x || hover[1] !== y) {
      hover = [x, y];
      drawHover();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (hover) { hover = null; draw(); }
  });

  async function paint(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - lastPostAt);
    if (wait > 0) {
      setStatus('wait ' + Math.ceil(wait / 1000) + 's before next pixel', 'wait');
      return;
    }
    lastPostAt = now;
    // Optimistic local update so the click feels instant.
    const key = x + ',' + y;
    cells.set(key, 1);
    draw();
    setStatus('posting…');

    try {
      const r = await fetch('/api/shared', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, v: 1 }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        // Roll back the optimistic cell.
        cells.delete(key);
        draw();
        if (r.status === 429) {
          setStatus('rate limited · try again in ' + (body.retry_after_seconds || 5) + 's', 'wait');
        } else {
          setStatus('post failed: ' + (body.error || ('http ' + r.status)), 'err');
        }
        return;
      }
      myVersion = body.version;
      draw();
      setStatus('painted (' + x + ',' + y + ') · version ' + myVersion, 'ok');
    } catch (e) {
      cells.delete(key);
      draw();
      setStatus('post failed: ' + e.message, 'err');
    }
  }

  canvas.addEventListener('click', (ev) => {
    const [x, y] = cellFromEvent(ev);
    paint(x, y);
  });

  // Refresh every 30s so visitors see other people drawing.
  setInterval(load, 30000);

  load();
})();
