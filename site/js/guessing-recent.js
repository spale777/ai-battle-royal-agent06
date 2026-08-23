// Render the "Recent games" section on /pages/guessing.html.
// Pulls /api/guessing/recent?limit=N, lists newest-first finished
// games, and re-fetches every 60s. Mirrors the layout of the
// "Recent games" card on /now (the row HTML is the same shape;
// see site/css/site.css for .recent-game-*).
//
// Depth selector: top 5 / 10 / 25 / 50. Clicks update the URL
// via history.replaceState so a visitor can bookmark the depth
// they're looking at. The chosen depth is also persisted in
// localStorage so a refresh keeps the chosen depth.

(function () {
  'use strict';

  var LIST = document.getElementById('recent-games-list');
  var META = document.getElementById('recent-games-meta');
  var LINKS = document.querySelectorAll('.recent-link');
  if (!LIST) return;

  var ALLOWED = [5, 10, 25, 50];
  var DEFAULT_DEPTH = 5;
  var STORAGE_KEY = 'agent06.guessing.recent.depth';

  function clampDepth(n) {
    var x = parseInt(n, 10);
    if (isNaN(x)) return null;
    if (ALLOWED.indexOf(x) >= 0) return x;
    return null;
  }

  function readQueryDepth() {
    try {
      var qs = new URLSearchParams(window.location.search);
      var raw = qs.get('limit') || qs.get('top');
      if (raw === null) return null;
      return clampDepth(raw);  // null if invalid
    } catch (e) {
      // URLSearchParams may be missing in very old browsers; fall
      // through to defaults.
    }
    return null;
  }

  function readStorageDepth() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return null;
      var v = clampDepth(raw);  // null if invalid
      if (v !== null) return v;
      // Stored value was bad; evict it so future reads aren't poisoned.
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // localStorage may throw in private mode; ignore.
    }
    return null;
  }

  function writeStorageDepth(n) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(n));
    } catch (e) {
      // localStorage may throw in private mode; ignore.
    }
  }

  function writeQueryDepth(n) {
    try {
      var u = new URL(window.location.href);
      if (n === DEFAULT_DEPTH) {
        // Strip the param when on default so a clean URL is the
        // canonical "top 5" link.
        u.searchParams.delete('limit');
        u.searchParams.delete('top');
      } else {
        u.searchParams.set('limit', String(n));
      }
      window.history.replaceState({}, '', u.toString());
    } catch (e) {
      // history.replaceState may throw in some embedded contexts;
      // not fatal — the page still works.
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function humanAge(seconds) {
    if (seconds <= 0) return 'instant';
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
    return Math.floor(seconds / 86400) + 'd';
  }

  function relativeTime(unixSec, now) {
    var dt = now - unixSec;
    if (dt < 60) return Math.floor(dt) + 's ago';
    if (dt < 3600) return Math.floor(dt / 60) + 'm ago';
    if (dt < 86400) return Math.floor(dt / 3600) + 'h ago';
    if (dt < 86400 * 30) return Math.floor(dt / 86400) + 'd ago';
    if (dt < 86400 * 365) return Math.floor(dt / (86400 * 30)) + 'mo ago';
    return Math.floor(dt / (86400 * 365)) + 'y ago';
  }

  function renderRows(rows, now) {
    if (!rows.length) {
      return '<li class="muted">no finished games yet</li>';
    }
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var status = String(r.status || '');
      if (status !== 'won' && status !== 'lost' && status !== 'abandoned') {
        continue;
      }
      var mode = String(r.mode || 'random');
      var sid = String(r.sid || '');
      var secret = parseInt(r.secret, 10);
      if (isNaN(secret)) continue;
      var duration = parseInt(r.duration_seconds, 10) || 0;
      var created = parseInt(r.created, 10) || 0;
      var dayKey = String(r.day_key || '');
      var age = isNaN(created) ? '' : relativeTime(created, now);
      var durationStr = humanAge(duration);

      var tipParts = [
        'mode: ' + mode,
        'sid: ' + sid,
        'duration: ' + durationStr,
      ];
      if (mode === 'daily' && dayKey) tipParts.push('day_key: ' + dayKey);
      if (age) tipParts.push('finished: ' + age);

      out.push(
        '<li class="recent-game-row recent-game-' + status + '"' +
        ' title="' + escapeHtml(tipParts.join(' \u00b7 ')) + '">' +
          '<span class="recent-game-status recent-game-status-' + status + '">' +
            escapeHtml(status) +
          '</span>' +
          '<span class="recent-game-mode">' + escapeHtml(mode) + '</span>' +
          '<span class="recent-game-secret">' + escapeHtml(String(secret)) + '</span>' +
          '<span class="recent-game-sid muted">' + escapeHtml(sid) + '</span>' +
        '</li>'
      );
    }
    return out.join('\n');
  }

  function setActiveLink(depth) {
    for (var i = 0; i < LINKS.length; i++) {
      var link = LINKS[i];
      var linkDepth = parseInt(link.getAttribute('data-recent-top'), 10);
      if (linkDepth === depth) {
        link.classList.add('current');
      } else {
        link.classList.remove('current');
      }
    }
  }

  var pendingFetch = null;
  function load(depth) {
    if (pendingFetch) {
      try { pendingFetch.abort(); } catch (e) { /* noop */ }
    }
    var controller = (typeof AbortController === 'function') ?
      new AbortController() : null;
    pendingFetch = controller;
    var url = '/api/guessing/recent?limit=' + encodeURIComponent(depth);
    var fetchInit = {};
    if (controller) {
      fetchInit.signal = controller.signal;
    }
    fetch(url, fetchInit)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var now = Math.floor(Date.now() / 1000);
        var rows = data.rows || [];
        LIST.innerHTML = renderRows(rows, now);
        var total = data.total_finished_known || 0;
        if (META) {
          if (total === 0) {
            META.textContent = 'no finished games yet \u2014 play to seed this card';
          } else {
            META.textContent =
              'showing ' + rows.length + ' of ' + total +
              ' finished games \u00b7 refreshes every 60s';
          }
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          // Stale fetch superseded by a newer one; ignore.
          return;
        }
        if (LIST) {
          LIST.innerHTML = '<li class="muted">could not load recent games (' +
            escapeHtml(String(err && err.message ? err.message : err)) + ')</li>';
        }
        if (META) META.textContent = '';
      });
  }

  // Pick the initial depth: URL ?limit= wins, then localStorage,
  // then default.
  var depth = readQueryDepth() || readStorageDepth() || DEFAULT_DEPTH;
  setActiveLink(depth);
  if (!readQueryDepth()) writeQueryDepth(depth); // canonicalise URL

  load(depth);

  // Auto-refresh the same depth every 60s.
  setInterval(function () { load(depth); }, 60000);

  for (var i = 0; i < LINKS.length; i++) {
    (function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var n = parseInt(link.getAttribute('data-recent-top'), 10);
        if (isNaN(n)) return;
        depth = n;
        setActiveLink(depth);
        writeQueryDepth(depth);
        writeStorageDepth(depth);
        load(depth);
      });
    })(LINKS[i]);
  }
})();
