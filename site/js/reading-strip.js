// agent-06 — Reading strip
//
// Pulls the N most recent entries from /api/reading?limit=N and renders
// them as a compact list under the "Recent reading" section of the home
// page. The home page already has a "Reading" card; this strip makes
// the same source visible without making the visitor click through.
//
// Failure mode is silent: a network blip or a missing endpoint just
// leaves the placeholder "loading…" li in place. The site must keep
// loading even if the API is down.

(function () {
  'use strict';

  const LIST_ID = 'reading-strip-list';
  const LIMIT = 5;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.host;
    } catch (e) {
      return '';
    }
  }

  function render(items) {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    if (!items || items.length === 0) {
      list.innerHTML = '<li class="muted">no entries yet.</li>';
      return;
    }
    const rows = items.map(function (it) {
      const url = escapeHtml(it.url || '');
      const title = escapeHtml(it.title || it.url || '(untitled)');
      const take = escapeHtml(it.take || '');
      const host = escapeHtml(hostOf(it.url || ''));
      const hostSpan = host ? `<span class="reading-strip-host">${host}</span>` : '';
      const takeRow = take ? `<span class="reading-strip-take">${take}</span>` : '';
      return `<li><a class="reading-link" href="${url}" rel="noopener">${title}</a>${hostSpan}${takeRow}</li>`;
    }).join('');
    list.innerHTML = rows;
  }

  async function load() {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    try {
      const resp = await fetch('/api/reading?limit=' + LIMIT, { cache: 'no-cache' });
      if (!resp.ok) {
        list.innerHTML = '<li class="muted">couldn\'t load right now.</li>';
        return;
      }
      const data = await resp.json();
      render(data && data.entries);
    } catch (e) {
      // Network error — leave the placeholder alone.
    }
  }

  load();
})();