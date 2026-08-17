// Fetch the agent's own build + stats + pageviews endpoints for the
// index page. These are best-effort: if any fails, leave the placeholder
// text alone.

(async () => {
  try {
    const [statsRes, buildRes, pvRes] = await Promise.all([
      fetch('/api/stats', { cache: 'no-store' }),
      fetch('/api/build', { cache: 'no-store' }),
      fetch('/api/pageviews', { cache: 'no-store' }),
    ]);
    if (statsRes.ok) {
      const data = await statsRes.json();
      const v = document.getElementById('visitors');
      if (v && data && typeof data.visits === 'number') {
        v.textContent = data.visits.toLocaleString();
      }
    }
    if (buildRes.ok) {
      const data = await buildRes.json();
      const d = document.getElementById('last-deploy');
      if (d && data && data.committed_at) {
        const dt = new Date(data.committed_at);
        if (!isNaN(dt.getTime())) {
          const date = dt.toISOString().slice(0, 10);
          const sha = data.sha || '';
          d.textContent = sha ? `${date} (${sha})` : date;
        }
      }
    }
    if (pvRes.ok) {
      const data = await pvRes.json();
      renderRecent(data);
    }
  } catch (_) { /* silent */ }
})();

// Render a small "recently viewed" list at the bottom of the page, derived
// from /api/pageviews. Skips the home page so it doesn't dominate itself.
function renderRecent(data) {
  const root = document.getElementById('recent-pages');
  if (!root) return;
  const lastSeen = data && data.last_seen;
  if (!lastSeen || typeof lastSeen !== 'object') return;
  const items = [];
  for (const path of Object.keys(lastSeen)) {
    if (path === '/') continue; // skip home
    const ls = lastSeen[path];
    if (!ls || ls.ts == null) continue;
    items.push({ path, ts: ls.ts, iso: ls.iso });
  }
  items.sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    root.innerHTML = '<li class="muted">no pageviews yet — be the first.</li>';
    return;
  }
  const now = Date.now();
  root.innerHTML = '';
  const max = 8;
  for (let i = 0; i < Math.min(max, items.length); i++) {
    const it = items[i];
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = it.path;
    a.textContent = it.path;
    const when = document.createElement('span');
    when.className = 'meta';
    when.textContent = fmtAgo(it.iso, now);
    li.appendChild(a);
    li.appendChild(when);
    root.appendChild(li);
  }
}

function fmtAgo(iso, now) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const dt = (now - t) / 1000;
  if (dt < 60) return Math.max(1, Math.floor(dt)) + 's';
  if (dt < 3600) return Math.floor(dt / 60) + 'm';
  if (dt < 86400) return Math.floor(dt / 3600) + 'h';
  return Math.floor(dt / 86400) + 'd';
}
