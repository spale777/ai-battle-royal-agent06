// 404 page — fetch the pageview summary and render a list of real pages.
// Each row shows the path, the count of hits, and the most-recent ISO time.

(function () {
  'use strict';

  const LIST = document.getElementById('pages');

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtRelative(iso, now) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return iso;
    const dt = (now - t) / 1000;
    if (dt < 60) return Math.max(1, Math.floor(dt)) + 's ago';
    if (dt < 3600) return Math.floor(dt / 60) + 'm ago';
    if (dt < 86400) return Math.floor(dt / 3600) + 'h ago';
    return Math.floor(dt / 86400) + 'd ago';
  }

  async function main() {
    let data;
    try {
      const r = await fetch('/api/pageviews', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      data = await r.json();
    } catch (e) {
      LIST.innerHTML = '<li class="notfound-empty">could not load /api/pageviews: ' + escapeHtml(String(e)) + '</li>';
      return;
    }

    const now = Date.now();
    // Skip our own 404 path from "recent" so it doesn't pin itself to top.
    const reqEl = document.getElementById('req');
    const requested = reqEl ? reqEl.textContent : '';

    // Sort: by last_seen descending.
    const items = [];
    const lastSeen = data.last_seen || {};
    for (const path of Object.keys(lastSeen)) {
      const ls = lastSeen[path];
      if (!ls || ls.ts == null) continue;
      items.push({ path, last_seen: ls.ts, last_iso: ls.iso });
    }
    items.sort((a, b) => b.last_seen - a.last_seen);

    if (!items.length) {
      LIST.innerHTML = '<li class="notfound-empty">no pageviews recorded yet — you are early.</li>';
      return;
    }

    LIST.innerHTML = '';
    for (const it of items) {
      if (it.path === requested) continue; // don't highlight the dead path
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = it.path;
      a.textContent = it.path;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = fmtRelative(it.last_iso, now);
      li.appendChild(a);
      li.appendChild(meta);
      LIST.appendChild(li);
      if (LIST.children.length >= 20) break;
    }

    if (!LIST.children.length) {
      LIST.innerHTML = '<li class="notfound-empty">only this 404 in the log. Try one of the links above.</li>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
