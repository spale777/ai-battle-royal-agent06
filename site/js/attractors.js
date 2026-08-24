// Attractors — four 3D strange attractors projected to 2D.
//
// Each attractor is a system of three coupled ODEs whose trajectory
// never settles down: it folds back on itself through an infinite
// braid that traces a fractal of dimension strictly between 2 and 3.
// We integrate each with a 4th-order Runge-Kutta solver (RK4) — much
// more accurate than Euler at the same step size, which matters for
// stiff systems like the Lorenz attractor near its saddle point.
//
// The full 3D trajectory is rendered as a 2D projection (the choice
// of which two axes to plot is part of the attractor's character).
// Each point is plotted with low alpha so dense regions accumulate
// brightness — the visual signature of an attractor is "where the
// trajectory spends time", not "where it goes".
//
// State is encoded in the URL hash so any attractor / palette / seed
// triple reproduces itself as a shareable link: e.g.
//   #lorenz:sunset:42:1.5

(function () {
  'use strict';

  // ----- Attractor definitions -------------------------------------------

  // Each attractor is { name, init, deriv, project, defaults }.
  //   init:    [x, y, z] start state
  //   deriv:   function (t, [x,y,z], dst) — fills dst with [dx,dy,dz]/dt
  //   project: function (x,y,z, dst) — fills dst with [u,v] on canvas
  //   defaults: { sigma, rho, beta } or similar params the user can tweak

  const ATTRACTORS = {
    lorenz: {
      label: 'Lorenz',
      sub: 'σ=10, ρ=28, β=8/3',
      // The classic 1963 atmospheric-convection paper. Two-lobed
      // butterfly shape; the orbit switches lobes at seemingly
      // random times — sensitive dependence on initial conditions.
      init: [1.0, 1.0, 1.0],
      defaults: { sigma: 10.0, rho: 28.0, beta: 8.0 / 3.0 },
      deriv: function (t, s, dst, p) {
        const [x, y, z] = s;
        dst[0] = p.sigma * (y - x);
        dst[1] = x * (p.rho - z) - y;
        dst[2] = x * y - p.beta * z;
      },
      project: function (x, y, z, dst, rot) {
        // Rotate around the z-axis, then drop y. A rotation slider
        // lets the visitor see how the XZ silhouette changes as the
        // shape spins.
        const cs = Math.cos(rot), sn = Math.sin(rot);
        dst[0] = x * cs - y * sn;
        dst[1] = x * sn + y * cs - z * 0.5;
      },
    },

    rossler: {
      label: 'Rössler',
      sub: 'a=0.2, b=0.2, c=5.7',
      // Simpler than Lorenz, with one slow direction and one fast
      // "fold" direction — produces a single scroll that wraps around
      // and grows inward. Famous for the funnel-like spiral near the
      // origin.
      init: [1.0, 1.0, 0.0],
      defaults: { a: 0.2, b: 0.2, c: 5.7 },
      deriv: function (t, s, dst, p) {
        const [x, y, z] = s;
        dst[0] = -y - z;
        dst[1] = x + p.a * y;
        dst[2] = p.b + z * (x - p.c);
      },
      project: function (x, y, z, dst, rot) {
        const cs = Math.cos(rot), sn = Math.sin(rot);
        dst[0] = x * cs - y * sn;
        dst[1] = -z + y * 0.3;
      },
    },

    aizawa: {
      label: 'Aizawa',
      sub: 'a=0.95, b=0.7, c=0.6, d=3.5, e=0.25, f=0.1',
      // A 1991 attractor with a spherical attractor topology — looks
      // like a fuzzy sphere with a swirling tunnel through the middle.
      // Surprisingly delicate: parameters slightly off collapse the
      // geometry to a fixed point.
      init: [0.1, 0.0, 0.0],
      defaults: {
        a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1,
      },
      deriv: function (t, s, dst, p) {
        const [x, y, z] = s;
        const A = (p.b * z - p.c) * x;
        dst[0] = (z - p.b) * x - p.d * y + A;
        dst[1] = p.d * x + (z - p.b) * y + A * p.e * x;
        const cz = z * z * z;
        dst[2] = p.f + p.a * z - cz / 3.0 - (x * x + y * y) * (1.0 + p.e) + 0.1 * z * x * x * x;
      },
      project: function (x, y, z, dst, rot) {
        const cs = Math.cos(rot), sn = Math.sin(rot);
        dst[0] = x * cs - z * sn;
        dst[1] = y - z * 0.4;
      },
    },

    halvorsen: {
      label: 'Halvorsen',
      sub: 'a=1.89',
      // A 1993 attractor with three-fold rotational symmetry: every
      // orbit traces a fractal sphere whose three projections (xy,
      // yz, zx) are identical. The "trefoil" shape is unmistakable
      // once you've seen it.
      init: [1.0, 0.0, 0.0],
      defaults: { a: 1.89 },
      deriv: function (t, s, dst, p) {
        const [x, y, z] = s;
        dst[0] = -p.a * x - 4 * y - 4 * z - y * y;
        dst[1] = -p.a * y - 4 * z - 4 * x - z * z;
        dst[2] = -p.a * z - 4 * x - 4 * y - x * x;
      },
      project: function (x, y, z, dst, rot) {
        const cs = Math.cos(rot), sn = Math.sin(rot);
        dst[0] = x * cs - y * sn;
        dst[1] = (x + y + z) * 0.35 - x * 0.4;
      },
    },
  };

  // ----- Palettes ---------------------------------------------------------
  // Each palette is a 5-stop ramp from "trail start" to "trail end".
  // The head of the trajectory is plotted with the last stop, the
  // tail (oldest) with the first — so a long-burn trajectory naturally
  // builds up the lower-numbered colours.

  const PALETTES = [
    { name: 'ember',  stops: ['#1a0d05', '#5e2010', '#b8501f', '#f0a060', '#fde2a8'] },
    { name: 'ocean',  stops: ['#06182a', '#0e3a5a', '#1d6f96', '#5fb4d0', '#cfeaf2'] },
    { name: 'forest', stops: ['#0c1f10', '#1d3a22', '#3a7038', '#7fb069', '#d5e8a8'] },
    { name: 'sunset', stops: ['#2a0c20', '#7a2b40', '#d04860', '#f4a040', '#fde0a0'] },
    { name: 'mono',   stops: ['#0a0a0a', '#3a3a3a', '#6a6a6a', '#9a9a9a', '#e0e0e0'] },
    { name: 'paper',  stops: ['#1a1a18', '#3d3a30', '#7a7460', '#bfb59a', '#f0e8d0'] },
    { name: 'violet', stops: ['#10081e', '#3a1e60', '#7240b0', '#c084d8', '#f0d0f5'] },
    { name: 'rust',   stops: ['#1a0c08', '#4a2010', '#a04030', '#e08040', '#f5d090'] },
  ];

  // ----- RK4 integrator ---------------------------------------------------
  // Standard textbook RK4. We allocate one scratch array per call so
  // a hot loop (running at ~60 fps with 16 steps/frame) doesn't
  // trigger GC pressure from constant object churn.
  function rk4Step(deriv, t, s, dt, dst, k1, k2, k3, k4, tmp, p) {
    const h = dt;
    const half = h * 0.5;
    deriv(t,           s,   k1, p);
    tmp[0] = s[0] + half * k1[0];
    tmp[1] = s[1] + half * k1[1];
    tmp[2] = s[2] + half * k1[2];
    deriv(t + half,    tmp, k2, p);
    tmp[0] = s[0] + half * k2[0];
    tmp[1] = s[1] + half * k2[1];
    tmp[2] = s[2] + half * k2[2];
    deriv(t + half,    tmp, k3, p);
    tmp[0] = s[0] + h * k3[0];
    tmp[1] = s[1] + h * k3[1];
    tmp[2] = s[2] + h * k3[2];
    deriv(t + h,       tmp, k4, p);
    dst[0] = s[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    dst[1] = s[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    dst[2] = s[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
  }

  // ----- Colour ramps -----------------------------------------------------
  // Pre-parse palette stops into RGB triples once, then linearly
  // interpolate along the ramp at paint time. 256 stops per palette
  // (one per index into the colour table) gives 24-bit resolution
  // without per-pixel string concatenation.

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function buildRamp(stops) {
    const rgb = stops.map(hexToRgb);
    const ramp = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const pos = t * (rgb.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, rgb.length - 1);
      const f = pos - lo;
      const a = rgb[lo], b = rgb[hi];
      ramp[i * 3]     = a[0] + (b[0] - a[0]) * f;
      ramp[i * 3 + 1] = a[1] + (b[1] - a[1]) * f;
      ramp[i * 3 + 2] = a[2] + (b[2] - a[2]) * f;
    }
    return ramp;
  }

  // ----- Main -------------------------------------------------------------
  const canvas = document.getElementById('attractors-canvas');
  const ctx = canvas.getContext('2d');
  const attrSelect = document.getElementById('attr-select');
  const paletteSelect = document.getElementById('palette-select');
  const seedInput = document.getElementById('seed-input');
  const stepInput = document.getElementById('step-input');
  const rotationInput = document.getElementById('rotation-input');
  const zoomInput = document.getElementById('zoom-input');
  const playBtn = document.getElementById('play-btn');
  const resetBtn = document.getElementById('reset-btn');
  const clearBtn = document.getElementById('clear-btn');
  const statusEl = document.getElementById('status');
  const burnEl = document.getElementById('burn');
  const linkBtn = document.getElementById('link-btn');
  const subEl = document.getElementById('attractor-sub');

  // State that the URL hash encodes.
  let attractorName = 'lorenz';
  let paletteName = 'ember';
  let seed = 1;       // Multiplies the default init vector by a small jitter.
  let stepScale = 1;  // 1 = default step size for the attractor.
  let rotation = 0.4;
  let zoom = 1.0;
  let isPlaying = true;

  // Per-frame computation state.
  let state = [0, 0, 0];
  let t = 0;
  let age = 0;          // Iterations since last clear.
  let pointsPerFrame = 16;
  let lastFrame = 0;
  let currentRamp = buildRamp(PALETTES[0].stops);

  // Scratch arrays for RK4 — allocated once, reused forever.
  const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];
  const tmp = [0, 0, 0], next = [0, 0, 0];
  const proj = [0, 0];

  // Faded canvas for the "trail" effect.
  let trailCtx = null;
  let trailCanvas = null;

  // ----- URL hash sync ----------------------------------------------------
  // Format: #<attractor>:<palette>:<seed>:<stepScale>:<zoom>:<rotation>
  // We accept partial hashes (e.g. #lorenz) and ignore unknown fields,
  // so old links stay valid.

  function encodeHash() {
    return [
      attractorName,
      paletteName,
      Math.round(seed * 1000) / 1000,
      Math.round(stepScale * 1000) / 1000,
      Math.round(zoom * 1000) / 1000,
      Math.round(rotation * 1000) / 1000,
    ].join(':');
  }

  function writeHash() {
    const s = '#' + encodeHash();
    if (location.hash !== s) {
      history.replaceState(null, '', s);
    }
  }

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return;
    const parts = h.split(':');
    if (parts[0] && ATTRACTORS[parts[0]]) attractorName = parts[0];
    if (parts[1] && PALETTES.find((p) => p.name === parts[1])) paletteName = parts[1];
    if (parts[2] != null) {
      const v = parseFloat(parts[2]);
      if (Number.isFinite(v)) seed = clamp(v, 0.001, 8);
    }
    if (parts[3] != null) {
      const v = parseFloat(parts[3]);
      if (Number.isFinite(v)) stepScale = clamp(v, 0.2, 5);
    }
    if (parts[4] != null) {
      const v = parseFloat(parts[4]);
      if (Number.isFinite(v)) zoom = clamp(v, 0.4, 6);
    }
    if (parts[5] != null) {
      const v = parseFloat(parts[5]);
      if (Number.isFinite(v)) rotation = clamp(v, -Math.PI, Math.PI);
    }
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ----- Controls ---------------------------------------------------------
  function syncControls() {
    attrSelect.value = attractorName;
    paletteSelect.value = paletteName;
    seedInput.value = String(Math.round(seed * 1000) / 1000);
    stepInput.value = String(Math.round(stepScale * 1000) / 1000);
    rotationInput.value = String(Math.round(rotation * 1000) / 1000);
    zoomInput.value = String(Math.round(zoom * 1000) / 1000);
  }

  // The "<attractor> — <params>" subtitle under the controls. Kept
  // here in the same module so a single change() handler covers it.
  function updateSubtitle() {
    if (!subEl) return;
    const def = ATTRACTORS[attractorName];
    if (!def) return;
    subEl.textContent = def.label + ' — ' + def.sub;
  }

  attrSelect.addEventListener('change', () => {
    attractorName = attrSelect.value;
    updateSubtitle();
    reseed(false);
  });
  paletteSelect.addEventListener('change', () => {
    paletteName = paletteSelect.value;
    const p = PALETTES.find((x) => x.name === paletteName);
    currentRamp = buildRamp(p.stops);
    writeHash();
  });
  seedInput.addEventListener('change', () => {
    const v = parseFloat(seedInput.value);
    if (Number.isFinite(v) && v > 0) seed = clamp(v, 0.001, 8);
    reseed(false);
  });
  stepInput.addEventListener('change', () => {
    const v = parseFloat(stepInput.value);
    if (Number.isFinite(v) && v > 0) stepScale = clamp(v, 0.2, 5);
    writeHash();
  });
  rotationInput.addEventListener('input', () => {
    const v = parseFloat(rotationInput.value);
    if (Number.isFinite(v)) rotation = clamp(v, -Math.PI, Math.PI);
    writeHash();
  });
  zoomInput.addEventListener('input', () => {
    const v = parseFloat(zoomInput.value);
    if (Number.isFinite(v) && v > 0) zoom = clamp(v, 0.4, 6);
    writeHash();
  });

  playBtn.addEventListener('click', () => {
    isPlaying = !isPlaying;
    playBtn.textContent = isPlaying ? 'Pause' : 'Play';
  });
  resetBtn.addEventListener('click', () => reseed(true));
  clearBtn.addEventListener('click', () => clearTrail());

  linkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      linkBtn.textContent = 'copied';
      setTimeout(() => { linkBtn.textContent = 'copy link'; }, 1200);
    } catch (err) {
      // Fallback for older browsers: select-and-prompt.
      window.prompt('Copy this URL:', location.href);
    }
  });

  // ----- Attractor setup --------------------------------------------------

  function reseed(clearScreen) {
    const def = ATTRACTORS[attractorName];
    state = def.init.slice();
    // Multiply by the seed jitter so a new seed gives a visibly
    // different trajectory. Anything in (0, 8] works — the attractors
    // are robust enough that seed=0.5 or seed=4.0 still settles onto
    // the strange attractor within a few hundred iterations.
    const jitter = (Math.sin(seed * 17.31) * 0.5 + 0.5) * 0.9 + 0.1;
    state[0] *= jitter;
    state[1] *= jitter;
    state[2] *= jitter;
    t = 0;
    age = 0;
    if (clearScreen) clearTrail();
    writeHash();
  }

  function clearTrail() {
    if (trailCtx) {
      trailCtx.fillStyle = getCssBg();
      trailCtx.fillRect(0, 0, trailCanvas.width, trailCanvas.height);
    }
    age = 0;
    burnEl.textContent = '0';
  }

  // Read the CSS body background colour so the trail canvas can fade
  // to it (light or dark mode) instead of always fading to black.
  function getCssBg() {
    return getComputedStyle(document.body).backgroundColor || '#f7f5ef';
  }

  // ----- Trail canvas management -----------------------------------------
  // We keep an offscreen canvas the same size as the visible canvas
  // and run the trail there. Each frame, fade it slightly toward the
  // page background (cheap motion blur), then plot the latest segment.

  function ensureTrailCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.floor(rect.width * dpr));
    const H = Math.max(2, Math.floor(rect.height * dpr));
    if (!trailCanvas || trailCanvas.width !== W || trailCanvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      trailCanvas = document.createElement('canvas');
      trailCanvas.width = W;
      trailCanvas.height = H;
      trailCtx = trailCanvas.getContext('2d');
      trailCtx.fillStyle = getCssBg();
      trailCtx.fillRect(0, 0, W, H);
      // Project the (u, v) coordinate space to fill the canvas.
      bbox = computeBBox();
    }
  }

  // The bounding box of an attractor is approximately fixed (modulo
  // tiny seed jitters). We compute it by sampling 5000 iterations
  // and taking min/max of the projected (u, v) coords. Cached after
  // the first compute per attractor+seed.
  let bbox = null;
  function computeBBox() {
    const def = ATTRACTORS[attractorName];
    const scratch = [0, 0, 0];
    const s = state.slice();
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < 5000; i++) {
      rk4Step(def.deriv, t, s, 0.01, scratch, k1, k2, k3, k4, tmp, def.defaults);
      s[0] = scratch[0]; s[1] = scratch[1]; s[2] = scratch[2];
      def.project(s[0], s[1], s[2], proj, rotation);
      if (proj[0] < minU) minU = proj[0];
      if (proj[0] > maxU) maxU = proj[0];
      if (proj[1] < minV) minV = proj[1];
      if (proj[1] > maxV) maxV = proj[1];
    }
    // Re-derive step size from the diagonal so each attractor fills
    // the canvas regardless of its intrinsic scale.
    const du = maxU - minU || 1;
    const dv = maxV - minV || 1;
    return {
      minU, maxU, minV, maxV,
      scale: Math.min(canvas.width / du, canvas.height / dv) * 0.9 * zoom,
    };
  }

  // ----- Frame loop -------------------------------------------------------

  function frame(now) {
    if (lastFrame === 0) lastFrame = now;
    const elapsed = (now - lastFrame) / 1000;
    lastFrame = now;
    ensureTrailCanvas();
    const def = ATTRACTORS[attractorName];

    if (isPlaying) {
      // Fade the trail slightly each frame so old trajectory fades
      // to the page background. We use a transparent rectangle over
      // the existing trail canvas — cheaper than reading+pixel-blending.
      // 1.5% per frame gives the head ~3 seconds before it noticeably
      // starts fading — long enough that a freshly painted segment
      // is unambiguously bright, short enough that the trail doesn't
      // saturate the canvas after a few minutes of running.
      trailCtx.fillStyle = hexToRgba(getCssBg(), 0.015);
      trailCtx.fillRect(0, 0, trailCanvas.width, trailCanvas.height);

      // Choose step size: each attractor has a natural time scale.
      // We pick a step that's small enough that RK4 stays stable but
      // large enough that 16 steps/frame visibly progresses.
      const baseDt = 0.008 * stepScale;
      for (let i = 0; i < pointsPerFrame; i++) {
        rk4Step(def.deriv, t, state, baseDt, next, k1, k2, k3, k4, tmp, def.defaults);
        // Catch blow-ups: if the trajectory escapes to infinity
        // (shouldn't, but numerical error can), reseed silently.
        if (!Number.isFinite(next[0]) || !Number.isFinite(next[1]) || !Number.isFinite(next[2])) {
          reseed(false);
          break;
        }
        state[0] = next[0]; state[1] = next[1]; state[2] = next[2];
        t += baseDt;
        age++;
      }

      // Plot the latest segment. We draw a short stroke (the last
      // ~16 steps) so individual plot iterations read as a continuous
      // line instead of dots, which gives the orbit a "drawn" feel.
      drawLatestSegment(def);

      burnEl.textContent = age.toLocaleString();
      statusEl.textContent = 'burning';
    } else {
      statusEl.textContent = 'paused';
    }

    // Copy trail canvas to the visible canvas.
    ctx.drawImage(trailCanvas, 0, 0);

    requestAnimationFrame(frame);
  }

  function drawLatestSegment(def) {
    // We re-project the last `segPoints` states by replaying them
    // — cheaper than caching because the segment is short.
    const segPoints = Math.min(age, pointsPerFrame);
    if (segPoints < 2) return;

    // Age-based colour: newer = brighter stop of the palette.
    // The head moves with `age`, so a long-burn trajectory
    // smoothly cycles through the palette.
    const palette = currentRamp;
    const idx = Math.min(255, Math.max(0, Math.floor(255 - (age % 4096) / 4096 * 255)));
    const r = palette[idx * 3];
    const g = palette[idx * 3 + 1];
    const b = palette[idx * 3 + 2];

    trailCtx.strokeStyle = `rgba(${r},${g},${b},0.75)`;
    trailCtx.lineWidth = Math.max(0.9, canvas.width / 500);
    trailCtx.lineCap = 'round';
    trailCtx.lineJoin = 'round';

    // Walk backwards from the current state to find segPoints-1 prior.
    // Cheaper than storing history because the scratch arrays are
    // already allocated.
    const seg = [];
    const s = [state[0], state[1], state[2]];
    const tt = t;
    const dt = -0.008 * stepScale;
    const scratch = [0, 0, 0];
    seg.push([s[0], s[1], s[2]]);
    for (let i = 1; i < segPoints; i++) {
      // RK4 with negative dt = backwards integration. Mathematically
      // valid because the attractor is time-reversible.
      rk4Step(def.deriv, tt + dt * (i - 1), s, dt, scratch, k1, k2, k3, k4, tmp, def.defaults);
      s[0] = scratch[0]; s[1] = scratch[1]; s[2] = scratch[2];
      seg.push([s[0], s[1], s[2]]);
    }
    // The seg is in reverse temporal order — flip for drawing.
    seg.reverse();

    trailCtx.beginPath();
    let first = true;
    for (let i = 0; i < seg.length; i++) {
      const [x, y, z] = seg[i];
      def.project(x, y, z, proj, rotation);
      const [px, py] = projectToCanvas(proj[0], proj[1]);
      if (first) {
        trailCtx.moveTo(px, py);
        first = false;
      } else {
        trailCtx.lineTo(px, py);
      }
    }
    trailCtx.stroke();
  }

  function projectToCanvas(u, v) {
    const w = canvas.width, h = canvas.height;
    const cu = (u - bbox.minU) * bbox.scale + (w - (bbox.maxU - bbox.minU) * bbox.scale) / 2;
    const cv = h - ((v - bbox.minV) * bbox.scale + (h - (bbox.maxV - bbox.minV) * bbox.scale) / 2);
    return [cu, cv];
  }

  function hexToRgba(hex, alpha) {
    // Accept either #RRGGBB or rgb(r,g,b) (from getComputedStyle).
    if (hex.startsWith('#')) {
      const v = parseInt(hex.slice(1), 16);
      return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
    }
    const m = hex.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((s) => s.trim());
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
    }
    return `rgba(0,0,0,${alpha})`;
  }

  // ----- Click-to-zoom (canvas-relative) ---------------------------------
  // Click anywhere on the canvas: zoom in (factor 1.4, centered on the
  // click). Right-click zooms out (factor 0.7). Shift-click also zooms
  // out (modifiers override the default). Both directions keep the
  // trajectory in roughly the same canvas position because we recompute
  // the bbox in lockstep — the visual effect is a magnification rather
  // than a translate. The zoom slider is kept in sync and the URL hash
  // is rewritten so a deep-zoom position is bookmarkable.

  canvas.addEventListener('click', (ev) => {
    ev.preventDefault();
    const factor = ev.shiftKey ? 0.7 : 1.4;
    zoom = clamp(zoom * factor, 0.4, 6);
    zoomInput.value = String(Math.round(zoom * 1000) / 1000);
    bbox = computeBBox();
    writeHash();
  });
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    zoom = clamp(zoom * 0.7, 0.4, 6);
    zoomInput.value = String(Math.round(zoom * 1000) / 1000);
    bbox = computeBBox();
    writeHash();
  });

  // ----- Boot -------------------------------------------------------------

  parseHash();
  syncControls();
  const pal = PALETTES.find((p) => p.name === paletteName);
  currentRamp = buildRamp(pal.stops);

  // Populate the dropdowns once we know which items to default-select.
  function populate() {
    attrSelect.innerHTML = Object.entries(ATTRACTORS).map(
      ([k, v]) => `<option value="${k}">${v.label}</option>`
    ).join('');
    paletteSelect.innerHTML = PALETTES.map(
      (p) => `<option value="${p.name}">${p.name}</option>`
    ).join('');
    syncControls();
    updateSubtitle();
  }
  populate();

  reseed(true);
  requestAnimationFrame(frame);
})();