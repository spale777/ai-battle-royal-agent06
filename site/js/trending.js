// agent-06 — Trending page
//
// Standalone surface for /api/pageviews/trending. The server already
// renders the initial state so the page is correct on first paint;
// this script takes over and refetches every 60s so the row order /
// delta magnitudes stay fresh without a full page reload.
//
// Server contract:
//   GET /api/pageviews/trending?top=N -> {
//     today_day_key, yesterday_day_key, top, today_unique, yesterday_unique,
//     rows: [
//       { path, today, yesterday, delta, direction: "up|down|new|gone|flat" },
//       ...
//     ]
//   }
//
// Top is clamped to 1..20 server-side; the JS passes it through and
// clicks on the depth links update the URL + reload the fetch + flip
// the "current" highlight.

(function () {
  'use strict';

  const LIST_ID = 'trending-list';
  const META_ID = 'trending-meta';
  const ROW_COUNT_ID = 'trending-rows-count';
  const REFRESH_MS = 60000;
  const MIN_TOP = 1;
  const MAX_TOP = 20;
  const DEFAULT_TOP = 6;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readTopFromUrl() {
    try {
      const u = new URL(window.location.href);
      const raw = u.searchParams.get('top');
      if (raw == null) return DEFAULT_TOP;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return DEFAULT_TOP;
      return Math.max(MIN_TOP, Math.min(MAX_TOP, n));
    } catch (e) {
      return DEFAULT_TOP;
    }
  }

  function clampTop(n) {
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) return DEFAULT_TOP;
    return Math.max(MIN_TOP, Math.min(MAX_TOP, n));
  }

  function renderRow(r) {
    const path = r.path || '/';
    const display = path.length <= 32 ? path : (path.slice(0, 29) + '…');
    const safePath = escapeHtml(path);
    const safeDisplay = escapeHtml(display);
    const d = parseInt(r.delta, 10) || 0;
    const direction = r.direction || 'flat';
    const today = parseInt(r.today, 10) || 0;
    const yesterday = parseInt(r.yesterday, 10) || 0;

    let arrow, signClass, deltaText;
    if (direction === 'new') {
      arrow = '★';
      signClass = 'trending-new';
      deltaText = 'new · ' + today;
    } else if (direction === 'gone') {
      arrow = '·';
      signClass = 'trending-gone';
      deltaText = 'gone · was ' + yesterday;
    } else if (d > 0) {
      arrow = '▲';
      signClass = 'trending-up';
      deltaText = '+' + d;
    } else if (d < 0) {
      arrow = '▼';
      signClass = 'trending-down';
      // Unicode minus to balance "+"
      deltaText = '−' + Math.abs(d);
    } else {
      arrow = '—';
      signClass = 'trending-flat';
      deltaText = '0';
    }

    const tip = ' title="path: ' + safePath + ' · today: ' + today +
                ' · yesterday: ' + yesterday + ' · delta: ' + d + '"';

    return (
      '<li class="trending-row"' + tip + '>' +
      '<span class="trending-arrow ' + signClass + '">' + escapeHtml(arrow) + '</span>' +
      '<span class="trending-path"><a href="' + safePath + '">' + safeDisplay + '</a></span>' +
      '<span class="trending-delta ' + signClass + '">' + escapeHtml(deltaText) + '</span>' +
      '</li>'
    );
  }

  function renderList(rows) {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    if (!rows || !rows.length) {
      list.innerHTML = '<li class="muted">no per-path data yet</li>';
      return;
    }
    list.innerHTML = rows.map(renderRow).join('');
  }

  function updateMeta(payload) {
    const meta = document.getElementById(META_ID);
    if (!meta) return;
    const today = payload && payload.today_day_key || '—';
    const yest = payload && payload.yesterday_day_key || '—';
    const rows = (payload && payload.rows) || [];
    meta.innerHTML =
      'today (' + escapeHtml(today) + ') vs yesterday (' + escapeHtml(yest) + ') · ' +
      '<span id="' + ROW_COUNT_ID + '">' + rows.length + '</span> row(s) · ' +
      'refresh every 60s';
  }

  function updateDepthLinks(top) {
    // Flip the "current" marker on depth links so the highlighted
    // choice matches the rendered depth — useful when the user
    // bookmarks /trending?top=15 and we add 15 to the chip row.
    const links = document.querySelectorAll('.trending-controls a[data-top]');
    links.forEach(function (a) {
      const n = parseInt(a.getAttribute('data-top'), 10);
      if (n === top) {
        a.classList.add('current');
      } else {
        a.classList.remove('current');
      }
    });
  }

  function renderError(msg) {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    list.innerHTML = '<li class="muted">' + escapeHtml(msg) + '</li>';
  }

  let currentTop = DEFAULT_TOP;
  let pendingFetch = null;

  async function load(top) {
    currentTop = clampTop(top);
    // Reflect the chosen top in the URL without reloading the page so
    // the user can bookmark the depth they're looking at.
    try {
      const u = new URL(window.location.href);
      if (currentTop === DEFAULT_TOP) {
        u.searchParams.delete('top');
      } else {
        u.searchParams.set('top', String(currentTop));
      }
      window.history.replaceState({}, '', u.toString());
    } catch (e) {
      // Ignore URL failures — the fetch below still works.
    }

    // Skip the request if there's a more-recent one already in flight.
    if (pendingFetch) {
      try { pendingFetch.abort(); } catch (e) {}
    }
    const controller = new AbortController();
    pendingFetch = controller;
    try {
      const resp = await fetch(
        '/api/pageviews/trending?top=' + currentTop,
        { cache: 'no-cache', signal: controller.signal }
      );
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      renderList(data.rows || []);
      updateMeta(data);
      updateDepthLinks(currentTop);
      // Keep data-top on the list in sync with what was rendered.
      const list = document.getElementById(LIST_ID);
      if (list) list.setAttribute('data-top', String(currentTop));
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      renderError('could not load: ' + (err && err.message || err));
    } finally {
      if (pendingFetch === controller) pendingFetch = null;
    }
  }

  function bindDepthLinks() {
    const links = document.querySelectorAll('.trending-controls a[data-top]');
    links.forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        const n = parseInt(a.getAttribute('data-top'), 10);
        load(n);
      });
    });
  }

  function init() {
    if (!document.getElementById(LIST_ID)) return;
    bindDepthLinks();
    // Refetch immediately on first load so any drift between the
    // server-rendered snapshot and the live /api response is fixed
    // within a few hundred ms. The user's chosen depth drives both
    // the first fetch and the periodic refresh.
    load(readTopFromUrl());
    setInterval(function () { load(currentTop); }, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
