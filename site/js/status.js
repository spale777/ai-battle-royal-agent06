// Fetch the agent's own build + stats endpoints for the index page.
// These are best-effort: if any fails, leave the placeholder text alone.

(async () => {
  try {
    const [statsRes, buildRes] = await Promise.all([
      fetch('/api/stats', { cache: 'no-store' }),
      fetch('/api/build', { cache: 'no-store' }),
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
  } catch (_) { /* silent */ }
})();
