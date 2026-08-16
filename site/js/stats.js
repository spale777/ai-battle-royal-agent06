// Render the stats-over-time sparkline.
// Pulls /api/stats/history, downsamples to the canvas width, draws.

(function () {
  'use strict';

  const canvas = document.getElementById('spark');
  const meta = document.getElementById('spark-meta');
  const now = document.getElementById('now');

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return d.toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');
  }

  function draw(samples) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const nums = samples.map((s) => (typeof s.v === 'number' ? s.v : null)).filter((v) => v !== null);
    if (nums.length === 0) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
      ctx.font = '12px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('no data yet — visit a page first', w / 2, h / 2);
      if (meta) meta.textContent = '0 samples';
      return;
    }

    const minV = Math.min(...nums);
    const maxV = Math.max(...nums);
    const pad = (maxV - minV > 0 ? (maxV - minV) * 0.15 : 1);
    const lo = Math.max(0, minV - pad);
    const hi = maxV + pad;

    // Background grid (3 lines).
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--rule').trim() || '#ddd';
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const y = (h / 3) * i + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Downsample to ~w points by bucketing.
    const n = samples.length;
    const buckets = Math.min(w, n);
    const bucketSize = Math.max(1, Math.floor(n / buckets));
    const points = [];
    for (let b = 0; b < buckets; b++) {
      const start = b * bucketSize;
      const end = Math.min(n, start + bucketSize);
      let best = null;
      for (let i = start; i < end; i++) {
        const v = samples[i].v;
        if (typeof v === 'number') { best = v; break; }
      }
      if (best === null) {
        // find nearest valid
        for (let i = start; i < end; i++) {
          if (typeof samples[i].v === 'number') { best = samples[i].v; break; }
        }
      }
      points.push(best);
    }

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2c5e3a';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < points.length; i++) {
      const v = points[i];
      if (v === null) continue;
      const x = (i / Math.max(1, points.length - 1)) * (w - 1);
      const y = h - ((v - lo) / Math.max(1, hi - lo)) * (h - 4) - 2;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Last value dot.
    const last = nums[nums.length - 1];
    const lx = w - 2;
    const ly = h - ((last - lo) / Math.max(1, hi - lo)) * (h - 4) - 2;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fill();

    if (meta) {
      const first = samples.find((s) => typeof s.v === 'number');
      const t0 = first ? first.t : null;
      const t1 = samples[samples.length - 1].t;
      meta.textContent = `${nums.length} samples · current ${last} · min ${minV} · max ${maxV}` +
        (t0 ? ` · ${fmtTime(t0)} → ${fmtTime(t1)}` : '');
    }
  }

  function load() {
    fetch('/api/stats/history')
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => draw(data.samples || []))
      .catch((err) => {
        if (meta) meta.textContent = 'failed to load history (' + err + ')';
      });
  }

  if (now) now.textContent = 'as of ' + fmtTime(Math.floor(Date.now() / 1000));
  load();
  // Auto-refresh every minute.
  setInterval(load, 60000);
})();
