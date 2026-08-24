// Home-page "live" strip — two stacked panels above the card grid:
//   1) A 16×16 mini shared canvas. Visitors click a cell to paint it,
//      which posts to /api/shared (same backend the full shared page uses).
//   2) A "what just got built" three-row commit strip pulled from
//      /api/logs?limit=3, each row linked to GitHub.
//
// Both panels auto-refresh on a timer. The strip is intentionally small —
// it's a *signal* of life on the site, not a duplicate of the dedicated
// /pages/shared.html and /pages/whatsnew.html surfaces.

(function () {
  'use strict';

  const REPO = 'https://github.com/spale777/ai-battle-royal-agent06';
  const MINI = 16;                 // 16×16 cells (smaller than the full 64×64)
  const CELL = 16;                 // CSS px per cell, so the canvas is 256×256
  const MINI_W = MINI * CELL;      // 256
  const MINI_H = MINI * CELL;      // 256
  const MIN_INTERVAL_MS = 5000;    // per-visitor rate limit, matches the full page
  const REFRESH_MS = 60000;        // re-pull state every 60s

  // ---- shared mini-canvas state ----
  const canvas = document.getElementById('home-shared-mini');
  const metaEl = document.getElementById('home-shared-mini-meta');
  const statusEl = document.getElementById('home-shared-mini-status');
  const feedEl = document.getElementById('home-shared-mini-feed');
  let cells = new Map();
  let myVersion = 0;
  let lastPostAt = 0;
  let myRecentPaints = [];         // last 3 paints (newest first)
  let totalEventsAcrossCanvas = 0; // total events on the *full* 64x64 canvas, used for meta copy

  // ---- commit-strip state ----
  const commitsEl = document.getElementById('home-recent-commits');
  let commits = [];

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.dataset.kind = kind || 'info';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return iso;
    const dt = (Date.now() - t) / 1000;
    if (dt < 60) return Math.floor(dt) + 's ago';
    if (dt < 3600) return Math.floor(dt / 60) + 'm ago';
    if (dt < 86400) return Math.floor(dt / 3600) + 'h ago';
    if (dt < 86400 * 30) return Math.floor(dt / 86400) + 'd ago';
    if (dt < 86400 * 365) return Math.floor(dt / (86400 * 30)) + 'mo ago';
    return Math.floor(dt / (86400 * 365)) + 'y ago';
  }

  // ---- mini-canvas drawing ----
  function drawMini() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bg = getCss('--bg') || '#fff';
    const fg = getCss('--fg') || '#1a1a1a';
    const accent = getCss('--accent') || '#2c5e3a';
    const rule = getCss('--rule') || '#d8d4c7';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, MINI_W, MINI_H);

    // Faint grid
    ctx.strokeStyle = rule;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= MINI; i++) {
      ctx.moveTo(i * CELL + 0.5, 0);
      ctx.lineTo(i * CELL + 0.5, MINI_H);
    }
    for (let j = 0; j <= MINI; j++) {
      ctx.moveTo(0, j * CELL + 0.5);
      ctx.lineTo(MINI_W, j * CELL + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Cells — accent squares for set pixels
    let setCount = 0;
    ctx.fillStyle = accent;
    for (const [key, v] of cells) {
      if (!v) continue;
      setCount++;
      const idx = key.indexOf(',');
      const x = +key.slice(0, idx);
      const y = +key.slice(idx + 1);
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }

    if (metaEl) {
      // Three states:
      //   - some pixels set in this 16x16 region: "N pixels painted here"
      //   - none here yet, but the *full* canvas has activity: invite the
      //     visitor by naming the whole-canvas count
      //   - completely empty: "be the first"
      // The "across the full canvas" qualifier is the bit that keeps the
      // meta line interesting when the mini is empty (which is the
      // common case given historical paints cluster elsewhere).
      if (setCount > 0) {
        metaEl.textContent = MINI + '×' + MINI + ' · ' + setCount + ' pixel' +
          (setCount === 1 ? '' : 's') + ' painted here';
      } else if (totalEventsAcrossCanvas > 0) {
        metaEl.textContent = MINI + '×' + MINI + ' · empty here · ' +
          totalEventsAcrossCanvas + ' pixels painted across the full canvas';
      } else {
        metaEl.textContent = MINI + '×' + MINI + ' · empty · be the first to paint';
      }
    }
  }

  function drawHoverMini(x, y) {
    drawMini();
    if (x == null || y == null) return;
    if (x < 0 || y < 0 || x >= MINI || y >= MINI) return;
    const ctx = canvas.getContext('2d');
    const accent = getCss('--accent') || '#2c5e3a';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.65;
    ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
    ctx.globalAlpha = 1;
  }

  // Build the cells map from the *last* event per (x,y) so the mini shows
  // the *current* state of the full canvas, not a per-event replay. The
  // full /api/shared event log is too large to faithfully project onto a
  // 16×16 (256-cell) mini, so we collapse to last-write-wins and only
  // include cells that fall within the mini's bounds.
  function rebuildFromEvents(events) {
    cells = new Map();
    for (const e of events) {
      if (!e || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      if (e.x < 0 || e.x >= MINI || e.y < 0 || e.y >= MINI) continue;
      cells.set(e.x + ',' + e.y, e.v ? 1 : 0);
    }
  }

  // Render the most recent paints *that landed within the mini canvas*
  // — paints outside the mini still get sent to the server (and visible
  // on /shared), they just don't show up in this tiny feed because the
  // feed's purpose is to point at "what you can see right here".
  function renderFeed() {
    if (!feedEl) return;
    if (!myRecentPaints.length) {
      feedEl.innerHTML = '<li class="muted small">no paints on the mini yet — click a cell to start</li>';
      return;
    }
    feedEl.innerHTML = '';
    for (const p of myRecentPaints) {
      const li = document.createElement('li');
      li.innerHTML =
        '<span class="mini-feed-coord">(' + p.x + ',' + p.y + ')</span>' +
        '<span class="mini-feed-ago muted">' + escapeHtml(relTime(p.t_iso)) + '</span>';
      feedEl.appendChild(li);
    }
  }

  async function loadMini() {
    setStatus('loading…');
    try {
      const r = await fetch('/api/shared/recent?limit=50', { cache: 'no-cache' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      // Use the recent-paints endpoint to rebuild the cells map (last-write-wins
      // per (x,y) within the mini bounds). It's smaller than /api/shared
      // and gives us a free "recent paints" list at the same time.
      const events = (data.rows || []).slice().reverse();   // oldest first for replay
      rebuildFromEvents(events);
      myVersion = data.version || 0;
      totalEventsAcrossCanvas = data.total_events || 0;

      // Top-3 most recent paints that landed within the mini's bounds
      myRecentPaints = (data.rows || [])
        .filter((p) => p.x >= 0 && p.x < MINI && p.y >= 0 && p.y < MINI)
        .slice(0, 3);
      renderFeed();
      drawMini();
      setStatus('ready · ' + (data.total_events || 0) + ' total events', 'ok');
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
  canvas && canvas.addEventListener('mousemove', (ev) => {
    const [x, y] = cellFromEvent(ev);
    if (x < 0 || y < 0 || x >= MINI || y >= MINI) {
      if (hover) { hover = null; drawHoverMini(null, null); }
      return;
    }
    if (!hover || hover[0] !== x || hover[1] !== y) {
      hover = [x, y];
      drawHoverMini(x, y);
    }
  });
  canvas && canvas.addEventListener('mouseleave', () => {
    if (hover) { hover = null; drawMini(); }
  });

  async function paint(x, y) {
    if (x < 0 || y < 0 || x >= MINI || y >= MINI) return;
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - lastPostAt);
    if (wait > 0) {
      setStatus('wait ' + Math.ceil(wait / 1000) + 's before next pixel', 'wait');
      return;
    }
    lastPostAt = now;
    // Optimistic local update
    const key = x + ',' + y;
    cells.set(key, 1);
    drawMini();
    setStatus('posting…');

    try {
      const r = await fetch('/api/shared', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, v: 1 }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        cells.delete(key);
        drawMini();
        if (r.status === 429) {
          setStatus('rate limited · try again in ' + (body.retry_after_seconds || 5) + 's', 'wait');
        } else {
          setStatus('post failed: ' + (body.error || ('http ' + r.status)), 'err');
        }
        return;
      }
      myVersion = body.version;
      // Prepend the new paint to the local feed so the visitor sees their
      // mark immediately; the next 60s refresh will reconcile with the
      // server-side truth.
      myRecentPaints = [{
        x: x, y: y, t: Math.floor(Date.now() / 1000),
        t_iso: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      }].concat(myRecentPaints).slice(0, 3);
      renderFeed();
      drawMini();
      setStatus('painted (' + x + ',' + y + ') · version ' + myVersion, 'ok');
    } catch (e) {
      cells.delete(key);
      drawMini();
      setStatus('post failed: ' + e.message, 'err');
    }
  }

  canvas && canvas.addEventListener('click', (ev) => {
    const [x, y] = cellFromEvent(ev);
    paint(x, y);
  });

  // ---- commit-strip rendering ----
  function renderCommits() {
    if (!commitsEl) return;
    if (!commits.length) {
      commitsEl.innerHTML = '<li class="muted small">no commits yet</li>';
      return;
    }
    commitsEl.innerHTML = '';
    for (const c of commits) {
      const li = document.createElement('li');
      const url = REPO + '/commit/' + encodeURIComponent(c.full_sha || c.sha);
      li.innerHTML =
        '<a class="commit-sha" href="' + escapeHtml(url) + '">' + escapeHtml(c.sha) + '</a>' +
        '<span class="commit-subject">' + escapeHtml(c.subject) + '</span>' +
        '<span class="commit-ago muted">' + escapeHtml(relTime(c.committed_at)) + '</span>';
      commitsEl.appendChild(li);
    }
  }

  async function loadCommits() {
    try {
      const r = await fetch('/api/logs?limit=3', { cache: 'no-cache' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      commits = data.commits || [];
      renderCommits();
    } catch (e) {
      if (commitsEl) {
        commitsEl.innerHTML = '<li class="muted small">could not load commits (' + escapeHtml(String(e)) + ')</li>';
      }
    }
  }

  // ---- boot ----
  if (canvas) {
    canvas.width = MINI_W;
    canvas.height = MINI_H;
    drawMini();
  }
  loadMini();
  loadCommits();
  setInterval(loadMini, REFRESH_MS);
  setInterval(loadCommits, REFRESH_MS);
})();
