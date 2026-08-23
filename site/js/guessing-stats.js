// agent-06 — Guessing leaderboard
//
// Server contract:
//   GET /api/guessing/stats -> { ok, today_day_key, range, budget,
//                                 modes: { random: {lifetime, today},
//                                          daily:  {lifetime, today} } }
//
//   Each bucket has: active, won, lost, abandoned, total,
//   won_with_full_history (only sessions whose history survived cold-load),
//   win_rate_pct (null when no decided games exist).
//
// Refreshes every 60s. Aborts in-flight fetches if a new one starts so
// quick page-state changes (rare here, but the pattern is cheap).

(function () {
  'use strict';

  const $tbody = document.getElementById('leaderboard-tbody');
  const $meta = document.getElementById('leaderboard-meta');
  if (!$tbody) return;  // only runs on /pages/guessing.html

  let pendingAbort = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtRate(pct) {
    if (pct == null) return '—';
    return pct.toFixed(1) + '%';
  }

  function renderRow(mode, window, bucket) {
    if (!bucket || typeof bucket !== 'object') return '';
    return (
      '<tr>' +
      '<td>' + esc(mode) + '</td>' +
      '<td>' + esc(window) + '</td>' +
      '<td class="num">' + (bucket.won || 0) + '</td>' +
      '<td class="num">' + (bucket.lost || 0) + '</td>' +
      '<td class="num">' + (bucket.abandoned || 0) + '</td>' +
      '<td class="num">' + (bucket.active || 0) + '</td>' +
      '<td class="num"><strong>' + (bucket.total || 0) + '</strong></td>' +
      '<td class="num">' + esc(fmtRate(bucket.win_rate_pct)) + '</td>' +
      '</tr>'
    );
  }

  function render(data) {
    if (!data || !data.modes) {
      $tbody.innerHTML = '<tr><td colspan="8" class="muted">no data</td></tr>';
      if ($meta) $meta.textContent = '';
      return;
    }
    const rows = [];
    // Stable order: random first (the original / most-played), then daily.
    for (const mode of ['random', 'daily']) {
      const m = data.modes[mode];
      if (!m) continue;
      if (m.lifetime) rows.push(renderRow(mode, 'lifetime', m.lifetime));
      if (m.today)    rows.push(renderRow(mode, 'today (' + (data.today_day_key || '') + ')', m.today));
    }
    $tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="8" class="muted">no data</td></tr>';
    // Meta line: lifecycle caveat + timestamp.
    const m = data.modes;
    const totalLifetime = (m.random && m.random.lifetime && m.random.lifetime.total || 0)
                       + (m.daily  && m.daily.lifetime  && m.daily.lifetime.total  || 0);
    let caveat = 'lifetime total: ' + totalLifetime + ' games logged.';
    const withHist = (m.random && m.random.lifetime && m.random.lifetime.won_with_full_history || 0)
                   + (m.daily  && m.daily.lifetime  && m.daily.lifetime.won_with_full_history  || 0);
    if (withHist > 0) {
      caveat += ' ' + withHist + ' won with full guess history still on disk (most finished games drop their history on cold-load, so this is usually smaller than the total wins column).';
    }
    if ($meta) {
      $meta.textContent = caveat;
      $meta.setAttribute('data-fetched-at', String(Math.floor(Date.now() / 1000)));
    }
  }

  function refresh() {
    if (pendingAbort) pendingAbort.abort();
    const ctrl = new AbortController();
    pendingAbort = ctrl;
    fetch('/api/guessing/stats', { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) {
          $tbody.innerHTML = '<tr><td colspan="8" class="muted">could not load stats</td></tr>';
          return;
        }
        render(data);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;  // superseded — silent
        $tbody.innerHTML = '<tr><td colspan="8" class="muted">network error</td></tr>';
      });
  }

  refresh();
  setInterval(refresh, 60 * 1000);
})();
