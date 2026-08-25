// Mandelbrot / Julia explorer.
// Single-file IIFE. Same canvas, two modes:
//   - mode='mandelbrot': parameter space c, iterate z -> z^2 + c
//   - mode='julia':      fixed c (set by URL/drag), iterate z -> z^2 + c
// Click to zoom in (×1.6 per click). Shift-click to zoom out (÷1.6).
// In Julia mode, drag with the mouse to recenter the c-value.
// Palette is a 5-stop linear ramp parsed once at boot into a Uint8 RGB
// array of length 256, so per-pixel reads are an index.
// State encoded in URL hash as
//   #<mode>:<palette>:<cx>:<cy>:<zoom>:<maxiter>:<cReal>:<cImag>
// e.g. #mandelbrot:ember:0:0:1:200:-0.7269:0.1889 (default view).

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Palette definitions. Each is a list of [offset, "#rrggbb"] stops
  // from t=0 (inside-set) to t=1 (well-escaped). The intermediate
  // ramp is built once into a 256-entry Uint8 RGB table.
  // ------------------------------------------------------------------
  const PALETTES = {
    ember:   { stops: [[0.0, '#1a0a08'], [0.25, '#7a2818'], [0.55, '#e8702a'], [0.8, '#f5d56a'], [1.0, '#fff7e0']] },
    ocean:   { stops: [[0.0, '#0a0e1f'], [0.25, '#1a3a6a'], [0.55, '#2a8acc'], [0.8, '#a8d8f0'], [1.0, '#ffffff']] },
    forest:  { stops: [[0.0, '#0a1a0a'], [0.25, '#1f4a2a'], [0.55, '#5a9a4a'], [0.8, '#c8e0a8'], [1.0, '#f5f0d8']] },
    sunset:  { stops: [[0.0, '#1a0820'], [0.25, '#5a1850'], [0.55, '#d04088'], [0.8, '#f5b860'], [1.0, '#fff0c8']] },
    mono:    { stops: [[0.0, '#0a0a0a'], [0.25, '#3a3a3a'], [0.55, '#7a7a7a'], [0.8, '#c0c0c0'], [1.0, '#ffffff']] },
    paper:   { stops: [[0.0, '#3a2a18'], [0.25, '#7a5a30'], [0.55, '#c8a868'], [0.8, '#e8d8a8'], [1.0, '#fff8e8']] },
    violet:  { stops: [[0.0, '#0a0418'], [0.25, '#2a1858'], [0.55, '#7838c8'], [0.8, '#c8a0e8'], [1.0, '#fff0ff']] },
    rust:    { stops: [[0.0, '#1a0a04'], [0.25, '#5a2818'], [0.55, '#a86038'], [0.8, '#e8b890'], [1.0, '#fff0d8']] },
  };
  const PALETTE_NAMES = Object.keys(PALETTES);

  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  // Build a 256-entry RGB ramp. The inside-set color is at index 0;
  // the outside (smooth) colors go from 1..255, so iterCount n with
  // n>0 maps to index 1 + ((n-1) * 255 / maxIter) % 255.
  function buildRamp(paletteName) {
    const stops = PALETTES[paletteName].stops;
    const ramp = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = 0;
      while (lo < stops.length - 1 && stops[lo + 1][0] < t) lo++;
      const hi = Math.min(lo + 1, stops.length - 1);
      const tLo = stops[lo][0];
      const tHi = stops[hi][0];
      const f = (tHi === tLo) ? 0 : (t - tLo) / (tHi - tLo);
      const cLo = hexToRgb(stops[lo][1]);
      const cHi = hexToRgb(stops[hi][1]);
      ramp[i * 3 + 0] = Math.round(cLo[0] + f * (cHi[0] - cLo[0]));
      ramp[i * 3 + 1] = Math.round(cLo[1] + f * (cHi[1] - cLo[1]));
      ramp[i * 3 + 2] = Math.round(cLo[2] + f * (cHi[2] - cLo[2]));
    }
    return ramp;
  }

  // ------------------------------------------------------------------
  // Default views. cx/cy is the complex-plane centre; zoom is half-width.
  // Mode 'mandelbrot' uses the canonical full set view; mode 'julia'
  // uses a fixed c that lands the visitor in a richly-detailed basin.
  // ------------------------------------------------------------------
  const VIEWS = {
    mandelbrot: {
      cx: -0.5, cy: 0, zoom: 1.6, maxIter: 200,
      cReal: -0.7269, cImag: 0.1889,  // unused in mandelbrot mode but kept
                                      // so URL round-trip is uniform.
    },
    julia: {
      cx: 0, cy: 0, zoom: 1.6, maxIter: 200,
      cReal: -0.7269, cImag: 0.1889,  // the canonical "dendrite" Julia c
    },
  };

  const MODE_NAMES = ['mandelbrot', 'julia'];

  // ------------------------------------------------------------------
  // DOM references
  // ------------------------------------------------------------------
  const canvas = document.getElementById('mandel-canvas');
  const ctx = canvas.getContext('2d');
  const modeSel = document.getElementById('mode-select');
  const palSel = document.getElementById('palette-select');
  const iterInput = document.getElementById('iter-input');
  const resetBtn = document.getElementById('reset-btn');
  const linkBtn = document.getElementById('link-btn');
  const statusEl = document.getElementById('status');
  const zoomEl = document.getElementById('zoom');
  const cxEl = document.getElementById('cx');
  const cyEl = document.getElementById('cy');
  const cRealEl = document.getElementById('creal');
  const cImagEl = document.getElementById('cimag');

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let mode = 'mandelbrot';
  let paletteName = 'ember';
  let ramp = buildRamp(paletteName);
  let cx = VIEWS.mandelbrot.cx;
  let cy = VIEWS.mandelbrot.cy;
  let zoom = VIEWS.mandelbrot.zoom;
  let maxIter = VIEWS.mandelbrot.maxIter;
  let cReal = VIEWS.julia.cReal;
  let cImag = VIEWS.julia.cImag;

  // Drag state (Julia mode).
  let dragging = false;
  let dragLastX = 0;
  let dragLastY = 0;

  // ------------------------------------------------------------------
  // Populate select dropdowns
  // ------------------------------------------------------------------
  for (const name of PALETTE_NAMES) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    palSel.appendChild(o);
  }
  palSel.value = paletteName;
  for (const name of MODE_NAMES) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    modeSel.appendChild(o);
  }
  modeSel.value = mode;

  // ------------------------------------------------------------------
  // Hash round-trip: #mode:palette:cx:cy:zoom:maxiter:cReal:cImag
  // Numbers may be negative; the leading # is dropped by location.hash.
  // Unknown palette/mode falls back to defaults. Out-of-range numeric
  // values get clamped.
  // ------------------------------------------------------------------
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function parseHash() {
    const h = (location.hash || '').replace(/^#/, '');
    if (!h) return false;
    const parts = h.split(':');
    if (parts.length < 4) return false;
    const m = parts[0];
    if (MODE_NAMES.indexOf(m) >= 0) mode = m;
    const p = parts[1];
    if (PALETTE_NAMES.indexOf(p) >= 0) {
      paletteName = p;
      ramp = buildRamp(paletteName);
    }
    const fcx = parseFloat(parts[2]);
    const fcy = parseFloat(parts[3]);
    const fz = parseFloat(parts[4]);
    const fi = parseInt(parts[5], 10);
    const fcr = parseFloat(parts[6]);
    const fci = parseFloat(parts[7]);
    if (Number.isFinite(fcx)) cx = fcx;
    if (Number.isFinite(fcy)) cy = fcy;
    if (Number.isFinite(fz) && fz > 0) zoom = clamp(fz, 0.0000001, 4);
    if (Number.isFinite(fi) && fi >= 16) maxIter = clamp(fi, 16, 2000);
    if (Number.isFinite(fcr)) cReal = clamp(fcr, -2, 2);
    if (Number.isFinite(fci)) cImag = clamp(fci, -2, 2);
    return true;
  }

  function writeHash() {
    // Use round-trippable floats. Fixed precision is fine for sharing.
    const parts = [
      mode,
      paletteName,
      cx.toFixed(8),
      cy.toFixed(8),
      zoom.toFixed(8),
      String(maxIter),
      cReal.toFixed(8),
      cImag.toFixed(8),
    ];
    const newHash = '#' + parts.join(':');
    if (location.hash !== newHash) {
      // replaceState so we don't fill history on every interaction.
      history.replaceState(null, '', newHash);
    }
  }

  // ------------------------------------------------------------------
  // Render: walks the canvas pixel by pixel and writes iteration count
  // through the palette ramp. Plain JS keeps the per-pixel branch
  // tight; the inner loop is the hot path.
  // ------------------------------------------------------------------
  function render() {
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const halfW = zoom;
    const halfH = zoom * (h / w);  // preserve aspect ratio
    const xMin = cx - halfW;
    const yMin = cy - halfH;
    const dx = (2 * halfW) / w;
    const dy = (2 * halfH) / h;

    // In Julia mode, the seed c is (cReal, cImag) and z_0 = (a, b).
    // In Mandelbrot mode, c = (a, b) and z_0 = (0, 0).
    const isJulia = (mode === 'julia');
    const cr0 = cReal;
    const ci0 = cImag;

    let p = 0;
    for (let j = 0; j < h; j++) {
      const y0 = yMin + j * dy;
      for (let i = 0; i < w; i++) {
        const x0 = xMin + i * dx;
        let zr = isJulia ? x0 : 0;
        let zi = isJulia ? y0 : 0;
        const cr = isJulia ? cr0 : x0;
        const ci = isJulia ? ci0 : y0;
        let n = 0;
        let zr2 = zr * zr;
        let zi2 = zi * zi;
        // Escape radius 4 is standard (squared magnitude > 4 -> escapes).
        while (n < maxIter && zr2 + zi2 < 4) {
          zi = 2 * zr * zi + ci;
          zr = zr2 - zi2 + cr;
          zr2 = zr * zr;
          zi2 = zi * zi;
          n++;
        }
        if (n >= maxIter) {
          // Inside-set pixel: opaque dark (palette index 0).
          data[p++] = ramp[0];
          data[p++] = ramp[1];
          data[p++] = ramp[2];
        } else {
          // Smooth colouring: t = n + 1 - log(log|z|)/log(2)
          // Optional polish — without it the bands look "stepped".
          const mod = Math.sqrt(zr2 + zi2);
          const smooth = n + 1 - Math.log(Math.log(Math.max(mod, 1.0001))) / Math.log(2);
          const idx = 1 + Math.floor((smooth * 5) % 255);  // *5 cycles for visual variety
          data[p++] = ramp[idx * 3 + 0];
          data[p++] = ramp[idx * 3 + 1];
          data[p++] = ramp[idx * 3 + 2];
        }
        data[p++] = 255;  // alpha
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------------
  // HUD: a small monospace line below the canvas with the current
  // state — view centre, zoom half-width, iteration count, c (Julia).
  // ------------------------------------------------------------------
  function updateHud() {
    statusEl.textContent = 'rendered';
    zoomEl.textContent = 'zoom ' + zoom.toExponential(2);
    cxEl.textContent = 'cx ' + cx.toFixed(6);
    cyEl.textContent = 'cy ' + cy.toFixed(6);
    cRealEl.textContent = 'c.r ' + cReal.toFixed(4);
    cImagEl.textContent = 'c.i ' + cImag.toFixed(4);
  }

  // ------------------------------------------------------------------
  // Click-to-zoom. Convert click position into complex coords, then
  // recentre cx/cy there and shrink zoom by 1/1.6 (or ×1.6 for shift).
  // ------------------------------------------------------------------
  canvas.addEventListener('click', (ev) => {
    if (dragging) return;  // click after drag is a no-op
    const rect = canvas.getBoundingClientRect();
    const fx = (ev.clientX - rect.left) / rect.width;
    const fy = (ev.clientY - rect.top) / rect.height;
    const halfW = zoom;
    const halfH = zoom * (rect.height / rect.width);
    cx = cx - halfW + fx * (2 * halfW);
    cy = cy - halfH + fy * (2 * halfH);
    if (ev.shiftKey) {
      zoom = clamp(zoom * 1.6, 0.0000001, 4);
    } else {
      zoom = clamp(zoom / 1.6, 0.0000001, 4);
    }
    iterInput.value = Math.min(2000, Math.max(16, Math.round(maxIter + 20)));
    maxIter = parseInt(iterInput.value, 10);
    render();
    updateHud();
    writeHash();
  });

  // Drag the c-value in Julia mode. Screen dx/dy maps to complex-plane
  // increments at the same scale as a click would.
  canvas.addEventListener('mousedown', (ev) => {
    if (mode !== 'julia') return;
    dragging = true;
    dragLastX = ev.clientX;
    dragLastY = ev.clientY;
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const halfW = 2;  // full c-plane range; c lives in [-2, 2] for typical Julia sets.
    const halfH = halfW * (rect.height / rect.width);
    const dxFrac = (ev.clientX - dragLastX) / rect.width;
    const dyFrac = (ev.clientY - dragLastY) / rect.height;
    cReal = clamp(cReal - dxFrac * (2 * halfW), -2, 2);
    cImag = clamp(cImag - dyFrac * (2 * halfH), -2, 2);
    dragLastX = ev.clientX;
    dragLastY = ev.clientY;
    render();
    updateHud();
    writeHash();
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  // ------------------------------------------------------------------
  // UI bindings
  // ------------------------------------------------------------------
  modeSel.addEventListener('change', () => {
    mode = modeSel.value;
    // Reset to the mode's canonical view; keeps the experience simple.
    const v = VIEWS[mode];
    cx = v.cx; cy = v.cy; zoom = v.zoom; maxIter = v.maxIter;
    cReal = v.cReal; cImag = v.cImag;
    iterInput.value = maxIter;
    render();
    updateHud();
    writeHash();
  });

  palSel.addEventListener('change', () => {
    paletteName = palSel.value;
    ramp = buildRamp(paletteName);
    render();
    updateHud();
    writeHash();
  });

  iterInput.addEventListener('change', () => {
    const v = parseInt(iterInput.value, 10);
    if (!Number.isFinite(v)) return;
    maxIter = clamp(v, 16, 2000);
    iterInput.value = maxIter;
    render();
    updateHud();
    writeHash();
  });

  resetBtn.addEventListener('click', () => {
    const v = VIEWS[mode];
    cx = v.cx; cy = v.cy; zoom = v.zoom; maxIter = v.maxIter;
    cReal = v.cReal; cImag = v.cImag;
    iterInput.value = maxIter;
    render();
    updateHud();
    writeHash();
  });

  linkBtn.addEventListener('click', () => {
    const url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        const prev = linkBtn.textContent;
        linkBtn.textContent = 'copied!';
        setTimeout(() => { linkBtn.textContent = prev; }, 1200);
      });
    } else {
      // Fallback for non-clipboard environments (older browsers).
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* noop */ }
      document.body.removeChild(ta);
      const prev = linkBtn.textContent;
      linkBtn.textContent = 'copied!';
      setTimeout(() => { linkBtn.textContent = prev; }, 1200);
    }
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  parseHash();
  // Sync inputs to whatever the hash gave us (or defaults).
  palSel.value = paletteName;
  modeSel.value = mode;
  iterInput.value = maxIter;
  render();
  updateHud();
  writeHash();
})();