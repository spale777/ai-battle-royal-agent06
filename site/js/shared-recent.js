// Shared canvas — "Recent paints" feed on /pages/shared.html.
// Fetches /api/shared/recent?limit=N on init, then refreshes every
// 60s. AbortController cancels an in-flight fetch if a new one
// supersedes it (depth-link click or quick refresh). URL is kept in
// sync via history.replaceState so a visitor can bookmark the depth
// they're looking at. Bad/clamped values get stripped from the URL
// automatically. The depth selector mirrors the guessing-recent
// depth shape: top 5 / 10 / 25 / 50 (the same 5/10/25/50 set the
// guessing-recent page uses, so visitors see the same vocabulary
// across both surfaces).

(function () {
  'use strict';

  const ALLOWED_DEPTHS = [5, 10, 25, 50];
  const DEFAULT_DEPTH = 10;
  const REFRESH_MS = 60000;
  const LS_KEY = 'agent06.shared.recent.depth';

  const LIST_EL = document.getElementById('shared-recent-list');
  const META_EL = document.getElementById('shared-recent-meta');
  const CONTROLS_EL = document.getElementById('shared-recent-controls');
  if (!LIST_EL) return; // Page doesn't have the feed; bail silently.

  function getInitialDepth() {
    // URL ?limit=N first, then localStorage, then default.
    let fromUrl = null;
    try {
      const qs = window.location.search.replace(/^\?/, '');
      for (const kv of qs.split('&')) {
        if (kv.startsWith('limit=')) {
          const v = parseInt(kv.split('=', 1)[1] || kv.slice(6), 10);
          if (Number.isFinite(v) && ALLOWED_DEPTHS.indexOf(v) !== -1) {
            fromUrl = v;
          }
          break;
        }
      }
    } catch (e) { /* ignore */ }
    if (fromUrl !== null) return fromUrl;
    try {
      const v = parseInt(window.localStorage.getItem(LS_KEY) || '', 10);
      if (Number.isFinite(v) && ALLOWED_DEPTHS.indexOf(v) !== -1) {
        return v;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_DEPTH;
  }

  function syncUrl(depth) {
    // Clean ?limit=N into the URL bar so a visitor can bookmark.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('limit') !== String(depth)) {
        url.searchParams.set('limit', String(depth));
        window.history.replaceState({}, '', url.toString());
      }
    } catch (e) { /* ignore */ }
  }

  function humanAge(seconds) {
    if (!seconds || seconds < 1) return 'just now';
    if (seconds < 60) return Math.floor(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? (days + 'd ' + hours + 'h') : (days + 'd');
  }

  function paintMeta(meta, total, count) {
    if (!META_EL) return;
    if (total > 0) {
      meta.textContent = 'showing ' + count + ' of ' + total + ' paint events';
    } else {
      meta.textContent = 'no paints yet — be the first';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function renderRows(rows) {
    if (!rows.length) {
      LIST_EL.innerHTML = '<li class="muted">no paints yet — be the first</li>';
      return;
    }
    const html = rows.map(function (r) {
      const x = parseInt(r.x, 10);
      const y = parseInt(r.y, 10);
      const age = humanAge(r.age_seconds);
      const tip = 'painted at (' + x + ',' + y + ') · ' + escapeHtml(r.t_iso || '');
      return (
        '<li class="shared-recent-row" title="' + escapeHtml(tip) + '">' +
        '<span class="shared-recent-age">' + escapeHtml(age) + '</span>' +
        '<span class="shared-recent-coord mono">(' + x + ',' + y + ')</span>' +
        '<span class="shared-recent-swatch" aria-hidden="true"></span>' +
        '</li>'
      );
    }).join('\n');
    LIST_EL.innerHTML = html;
  }

  function markCurrent(depth) {
    if (!CONTROLS_EL) return;
    const links = CONTROLS_EL.querySelectorAll('a[data-depth]');
    links.forEach(function (a) {
      const d = parseInt(a.getAttribute('data-depth') || '0', 10);
      if (d === depth) a.classList.add('current');
      else a.classList.remove('current');
    });
  }

  let pendingFetch = null;

  function load(depth) {
    if (ALLOWED_DEPTHS.indexOf(depth) === -1) depth = DEFAULT_DEPTH;
    syncUrl(depth);
    markCurrent(depth);
    try { window.localStorage.setItem(LS_KEY, String(depth)); } catch (e) { /* ignore */ }

    if (pendingFetch) pendingFetch.abort();
    const ctrl = new AbortController();
    pendingFetch = ctrl;

    fetch('/api/shared/recent?limit=' + depth, { signal: ctrl.signal, cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (data) {
        pendingFetch = null;
        const rows = data.rows || [];
        renderRows(rows);
        paintMeta(META_EL, data.total_events || 0, rows.length);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // superseded
        pendingFetch = null;
        LIST_EL.innerHTML = '<li class="muted">network error</li>';
        if (META_EL) META_EL.textContent = 'could not load — retrying';
      });
  }

  // Wire depth controls.
  if (CONTROLS_EL) {
    CONTROLS_EL.addEventListener('click', function (ev) {
      const a = ev.target.closest('a[data-depth]');
      if (!a) return;
      ev.preventDefault();
      const d = parseInt(a.getAttribute('data-depth') || '0', 10);
      if (Number.isFinite(d)) load(d);
    });
  }

  // Auto-refresh on the current depth.
  let currentDepth = getInitialDepth();
  load(currentDepth);
  setInterval(function () { load(currentDepth); }, REFRESH_MS);
})();