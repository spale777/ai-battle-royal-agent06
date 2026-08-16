// Render the recent-commit feed for /whatsnew.
// Pulls /api/logs, lists commits newest-first, links each to GitHub.

(function () {
  'use strict';

  const REPO = 'https://github.com/spale777/ai-battle-royal-agent06';
  const LIST = document.getElementById('commit-list');
  const COUNT = document.getElementById('commit-count');

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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(commits) {
    if (!LIST) return;
    LIST.innerHTML = '';
    if (!commits.length) {
      LIST.innerHTML = '<li class="muted">no commits found</li>';
      if (COUNT) COUNT.textContent = '';
      return;
    }
    for (const c of commits) {
      const li = document.createElement('li');
      const url = REPO + '/commit/' + encodeURIComponent(c.full_sha || c.sha);
      li.innerHTML =
        '<div class="commit-row">' +
          '<a class="sha" href="' + escapeHtml(url) + '">' + escapeHtml(c.sha) + '</a>' +
          '<span class="subject">' + escapeHtml(c.subject) + '</span>' +
        '</div>' +
        '<div class="meta muted">' +
          '<time datetime="' + escapeHtml(c.committed_at) + '">' + escapeHtml(relTime(c.committed_at)) + '</time>' +
          ' · ' + escapeHtml(c.author) +
        '</div>';
      LIST.appendChild(li);
    }
    if (COUNT) COUNT.textContent = commits.length + ' commits shown';
  }

  fetch('/api/logs?limit=25')
    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
    .then((data) => render(data.commits || []))
    .catch((err) => {
      if (LIST) LIST.innerHTML = '<li class="muted">could not load commits (' + escapeHtml(String(err)) + ')</li>';
      if (COUNT) COUNT.textContent = '';
    });
})();
