// Render the "by hour of day" chart on /pages/stats.html.
// Pulls /api/visitors/hourly?days=N, draws 24 bars (one per UTC hour).
// Day-window selector at the top lets the visitor swap the window
// (today / 3 days / 7 days / 14 days / 30 days). Current UTC hour is
// highlighted. Refreshes every 60 seconds with the current window.

(function () {
  'use strict';

  const strip = document.getElementById('hourly-strip');
  const meta = document.getElementById('hourly-meta');
  const source = document.getElementById('hourly-source');
  const links = Array.from(document.querySelectorAll('.hourly-link'));

  let currentDays = 7;
  let pendingFetch = null;

  function fmtHour(h) {
    return String(h).padStart(2, '0');
  }

  function render(data) {
    if (!strip) return;
    strip.innerHTML = '';

    // Pick the right aggregate:
    //   days=1: today_by_hour (raw peak per hour for today)
    //   days>1: avg_peak_by_hour (mean across days; max_peak shown in tooltip)
    let buckets;
    let isAvg = data.days > 1;
    if (isAvg) {
      buckets = data.avg_peak_by_hour || [];
    } else {
      buckets = data.today_by_hour || [];
    }
    if (!buckets.length) {
      strip.innerHTML = '<li class="muted">no data</li>';
      if (meta) meta.textContent = 'no data';
      return;
    }

    // Bar math lives in CSS via the --bar custom property; server
    // already gives us avg_peak / max_peak per hour. Pick the larger of
    // (avg_peak across all hours, max_peak across all hours) so a bar
    // with max_peak=6 but avg_peak=2 still scales appropriately.
    let numeric;
    let valueForBar;
    if (isAvg) {
      numeric = buckets
        .map((b) => (b.avg_peak != null ? Number(b.avg_peak) : null))
        .filter((v) => v !== null);
      valueForBar = (b) => (b.avg_peak != null ? Number(b.avg_peak) : null);
    } else {
      numeric = buckets
        .map((b) => (b.peak_v != null ? Number(b.peak_v) : null))
        .filter((v) => v !== null);
      valueForBar = (b) => (b.peak_v != null ? Number(b.peak_v) : null);
    }
    const maxVal = numeric.length ? Math.max(...numeric) : 0;

    const todayHour = data.today_hour;
    const todayPartial = !!data.today_partial;
    const todayDayKey = data.day_keys ? data.day_keys[data.day_keys.length - 1] : '';

    const frag = document.createDocumentFragment();
    buckets.forEach((b) => {
      const h = b.hour;
      const v = valueForBar(b);
      const li = document.createElement('li');
      li.className = 'hourly-hour';
      if (todayHour != null && h === todayHour) {
        li.classList.add('is-current-hour');
      }
      let bar = 0;
      let countText = '—';
      let tooltip = '';
      if (v !== null && v !== undefined) {
        bar = maxVal > 0 ? Math.max(1, Math.round((v / maxVal) * 12)) : 0;
        const vStr = (isAvg ? v.toFixed(2).replace(/\.00$/, '') : String(v));
        countText = vStr;
        const parts = [fmtHour(h) + ':00 UTC'];
        if (isAvg) {
          parts.push('avg peak ' + vStr);
          if (b.max_peak != null) parts.push('max ' + b.max_peak);
          if (b.days_with_data != null) parts.push(b.days_with_data + ' days');
        } else {
          parts.push('peak ' + vStr);
          parts.push((b.sample_count || 0) + ' samples');
        }
        tooltip = parts.join(' · ');
      } else {
        tooltip = fmtHour(h) + ':00 UTC · no data';
      }
      if (tooltip) li.title = tooltip;

      const label = document.createElement('span');
      label.className = 'hourly-hour-label';
      label.textContent = fmtHour(h);

      const barEl = document.createElement('span');
      barEl.className = 'hourly-hour-bar';
      barEl.style.setProperty('--bar', String(bar));

      const count = document.createElement('span');
      count.className = 'hourly-hour-count';
      count.textContent = countText;

      li.appendChild(label);
      li.appendChild(barEl);
      li.appendChild(count);
      frag.appendChild(li);
    });
    strip.appendChild(frag);

    // Meta line under the chart.
    if (meta) {
      const windowLabel = data.days === 1
        ? 'today (' + todayDayKey + ')'
        : 'last ' + data.days + ' days (' + data.day_keys[0] + ' → ' + todayDayKey + ')';
      const aggregateLabel = isAvg
        ? 'mean of per-day peaks'
        : (todayPartial ? 'today, partial' : 'today, complete');
      const maxLabel = maxVal > 0 ? ' · max ' + maxVal : '';
      meta.textContent = windowLabel + ' · ' + aggregateLabel + maxLabel;
    }
    if (source) {
      source.textContent = '/api/visitors/hourly?days=' + data.days;
    }
  }

  function setActive(days) {
    links.forEach((a) => {
      if (Number(a.getAttribute('data-days')) === days) {
        a.classList.add('current');
      } else {
        a.classList.remove('current');
      }
    });
  }

  function load(days) {
    if (!strip) return;
    days = Number(days);
    if (!Number.isFinite(days) || days < 1) days = 7;
    days = Math.max(1, Math.min(days, 30));
    currentDays = days;

    // Abort any in-flight request so a quick window swap doesn't pile up.
    if (pendingFetch) {
      try { pendingFetch.abort(); } catch (e) { /* ignore */ }
    }
    const ctrl = new AbortController();
    pendingFetch = ctrl;

    fetch('/api/visitors/hourly?days=' + days, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => {
        if (ctrl.signal.aborted) return;
        render(data);
        setActive(days);
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (meta) meta.textContent = 'failed to load hourly (' + err + ')';
      });
  }

  // Wire the day-window links.
  links.forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const days = Number(a.getAttribute('data-days'));
      load(days);
      // Keep the URL in sync without a reload.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('days', String(days));
        window.history.replaceState({}, '', url.toString());
      } catch (e) { /* ignore older browsers */ }
    });
  });

  // Pick up ?days=N from the URL on load (defensive against bad input).
  let initialDays = 7;
  try {
    const params = new URL(window.location.href).searchParams;
    const qd = Number(params.get('days'));
    if (Number.isFinite(qd) && qd >= 1) {
      initialDays = Math.max(1, Math.min(qd, 30));
    }
  } catch (e) { /* ignore */ }
  load(initialDays);

  // Auto-refresh every 60 seconds with the current window. The poller
  // does NOT swap windows, so a visitor who picked "30 days" stays on
  // 30 days for the lifetime of the page.
  setInterval(() => load(currentDays), 60000);
})();