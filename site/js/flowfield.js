// Flow field painting — a Perlin-noise-driven vector field with
// particles tracing along it. The page is one offscreen "trail"
// canvas that fades toward the page background, and one visible
// canvas that copies from it each frame. State (palette, particle
// count, step, noise scale, seed) is encoded in the URL hash so any
// combination reproduces itself as a shareable link.
//
// All work happens client-side. No fetch, no server endpoint.
// ~350 lines, single-file IIFE.
(function () {
  "use strict";

  // ---------- Palette ramps (5-stop linear interpolation, [0..255]) ----------
  // Each palette is a 5-stop gradient; we pre-parse into a 256-entry
  // lookup at boot so per-pixel reads are O(1) array index.
  const PALETTES = {
    ember:    [[40, 18, 8], [190, 60, 30], [240, 130, 50], [250, 200, 110], [255, 240, 220]],
    ocean:    [[10, 18, 50], [40, 90, 170], [80, 160, 220], [180, 230, 240], [240, 250, 255]],
    forest:   [[10, 24, 18], [40, 90, 60], [80, 150, 90], [200, 220, 130], [250, 245, 220]],
    sunset:   [[60, 20, 60], [200, 80, 110], [240, 140, 100], [250, 200, 120], [255, 245, 220]],
    mono:     [[20, 20, 24], [80, 80, 88], [140, 140, 150], [200, 200, 210], [245, 245, 248]],
    paper:    [[30, 24, 18], [120, 90, 60], [180, 150, 110], [220, 200, 170], [248, 240, 226]],
    violet:   [[18, 12, 38], [70, 40, 130], [140, 80, 200], [210, 150, 230], [245, 220, 250]],
    rust:     [[30, 14, 6], [120, 50, 20], [200, 100, 50], [230, 160, 90], [250, 220, 180]],
  };

  // ---------- Perlin noise (Ken Perlin's classic improved noise) ----------
  // Permutation table seeded from a 32-bit integer via mulberry32.
  function makePerlin(seed) {
    const p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;

    // mulberry32 seeded PRNG (same algorithm used elsewhere on the site)
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

    function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    function lerp(a, b, t) { return a + t * (b - a); }
    function grad(h, x, y) {
      // 8 directions, even ones are +1, odd ones are -1
      const v = ((h & 1) << 1) - 1;
      return v * (h < 4 ? x : y);
    }

    return function noise2(x, y) {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      const u = fade(x), v = fade(y);
      const A = p[X] + Y, B = p[X + 1] + Y;
      return lerp(
        lerp(grad(p[A], x, y),       grad(p[B], x - 1, y),       u),
        lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u),
        v
      );
    };
  }

  // ---------- Palette ramp builder ----------
  function buildRamp(stops) {
    const ramp = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (stops.length - 1);
      const idx = Math.min(stops.length - 2, Math.floor(t));
      const f = t - idx;
      const a = stops[idx], b = stops[idx + 1];
      ramp[i * 3]     = Math.round(a[0] + (b[0] - a[0]) * f);
      ramp[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
      ramp[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    }
    return ramp;
  }
  const RAMPS = {};
  for (const [name, stops] of Object.entries(PALETTES)) {
    RAMPS[name] = buildRamp(stops);
  }

  // ---------- State ----------
  // Defaults — overridden by URL hash on boot.
  //
  // particles=1500 is the sweet spot for a 960x576 canvas at 60fps:
  // enough density to read as a continuous gradient, not enough
  // to bog the per-frame loop. step=2.5 means each particle moves
  // visibly between frames, so the trail reads as a flowing line
  // rather than a barely-shifting dot. scale=0.008 keeps the
  // angular variation moderate — large enough that adjacent
  // particles diverge in direction (so the field is visible),
  // small enough that the macro flow still reads as smooth swirls
  // rather than chaos. seed=1.234 is a fully arbitrary starting
  // point that produces a pleasant field; any other float works.
  // fade=0.008 lets the painting accumulate over ~10 seconds into
  // a dense tapestry rather than fading every half-second. The
  // steady-state paint density with 1500 particles * 2.5px/frame
  // and 0.8%/frame removal is roughly (1500*2.5)/0.008 = ~470k
  // painted pixels, which is >2x the 192k canvas — so the
  // visible result is a saturated, layered field.
  const DEFAULTS = {
    palette: "ember",
    particles: 1500,
    step: 2.5,
    scale: 0.008,
    seed: 1.234,
    fade: 0.008,
  };
  let state = Object.assign({}, DEFAULTS);

  // ---------- DOM refs ----------
  const canvas = document.getElementById("flowfield-canvas");
  const ctx = canvas.getContext("2d");
  const trail = document.createElement("canvas");
  const trailCtx = trail.getContext("2d");

  // ---------- Page bg (read once at boot, used for fade overlay) ----------
  function cssBg() {
    // We fade toward a translucent page-bg colour so the visible canvas
    // converges to the same cream/dark as the page background. Read from
    // CSS so dark mode works automatically.
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const cc = c.getContext("2d");
    cc.fillStyle = getComputedStyle(document.body).backgroundColor || "#f7f5ef";
    cc.fillRect(0, 0, 1, 1);
    const d = cc.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  // ---------- URL hash encoding ----------
  // #palette:particles:step:scale:seed  — five colon-separated floats/ints.
  // Unknown tokens fall back to defaults; clamps guard the per-param range.
  function parseHash() {
    if (!location.hash || location.hash.length < 2) return;
    const parts = location.hash.slice(1).split(":");
    if (parts.length < 1) return;
    const paletteName = parts[0] in PALETTES ? parts[0] : DEFAULTS.palette;
    const particles = clamp(parseFloat(parts[1]), 100, 5000) || DEFAULTS.particles;
    const step      = clamp(parseFloat(parts[2]), 0.4, 6) || DEFAULTS.step;
    const scale     = clamp(parseFloat(parts[3]), 0.0008, 0.04) || DEFAULTS.scale;
    const seed      = clamp(parseFloat(parts[4]), 0.001, 1000) || DEFAULTS.seed;
    state = { palette: paletteName, particles, step, scale, seed, fade: DEFAULTS.fade };
  }

  function writeHash() {
    const h = `#${state.palette}:${state.particles}:${state.step}:${state.scale}:${state.seed}`;
    history.replaceState(null, "", h);
  }

  function clamp(x, lo, hi) {
    if (!Number.isFinite(x)) return NaN;
    return Math.max(lo, Math.min(hi, x));
  }

  // ---------- Particle pool ----------
  // Pre-allocated arrays; one Float32Array for x, one for y, one for
  // "alive" (0 = needs respawn, 1 = alive). Avoids GC churn inside
  // the per-frame loop.
  //
  // New particles start uniformly across the canvas, not at a single
  // centre source — that distributes the painting across the whole
  // field from the start, instead of forcing every visitor to watch
  // a "fountain" slowly spreading outward from one point.
  let xArr, yArr, aliveArr;
  function resetParticles() {
    xArr = new Float32Array(state.particles);
    yArr = new Float32Array(state.particles);
    aliveArr = new Uint8Array(state.particles);
    const w = canvas.width, h = canvas.height;
    for (let i = 0; i < state.particles; i++) {
      xArr[i] = Math.random() * w;
      yArr[i] = Math.random() * h;
      aliveArr[i] = 1;
    }
  }

  // ---------- Noise field (rebuilt when seed/scale changes) ----------
  let noise;
  function rebuildNoise() {
    // Hash the float seed into a uint32 for mulberry32.
    const s = Math.floor(state.seed * 999983) >>> 0;
    noise = makePerlin(s === 0 ? 1 : s);
  }

  // ---------- Reset everything (palette change, new seed, clear) ----------
  function reset() {
    const bg = cssBg();
    trailCtx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    trailCtx.fillRect(0, 0, trail.width, trail.height);
    rebuildNoise();
    resetParticles();
    writeHash();
    syncControls();
    document.getElementById("status").textContent = "flowing";
    document.getElementById("burn").textContent = "0";
    burnCount = 0;
  }

  // ---------- Controls sync ----------
  function syncControls() {
    document.getElementById("palette-select").value = state.palette;
    document.getElementById("particles-input").value = state.particles;
    document.getElementById("step-input").value = state.step;
    document.getElementById("scale-input").value = state.scale;
    document.getElementById("seed-input").value = state.seed;
  }

  // ---------- Per-frame render ----------
  let burnCount = 0;
  let rafId = null;
  let playing = true;

  function frame() {
    if (!playing) { rafId = null; return; }
    rafId = requestAnimationFrame(frame);

    const w = trail.width, h = trail.height;
    const ramp = RAMPS[state.palette];
    const step = state.step;
    const scale = state.scale;
    const TWO_PI = Math.PI * 2;

    // Fade trail toward page bg. 2.2%/frame is the balance we found:
    // old lines decay in ~30 frames (~0.5s) so the canvas stays open
    // and there's no permanent buildup that swamps the colours.
    const bg = cssBg();
    trailCtx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${state.fade})`;
    trailCtx.fillRect(0, 0, w, h);

    // Each particle samples the noise field at its current position
    // and steps along the resulting angle. We draw a thin line from
    // (oldX, oldY) to (newX, newY) — a line, not a point, because a
    // point at 1px looks like noise even at this density.
    trailCtx.lineWidth = 1;
    trailCtx.lineCap = "round";

    // Age of particle in frames (mod 256) drives its palette index,
    // so a single particle traces a colour gradient along its path.
    // Newborn particles start at index 0 (dark end of the ramp).
    for (let i = 0; i < state.particles; i++) {
      if (!aliveArr[i]) continue;

      let x = xArr[i];
      let y = yArr[i];

      // Perlin returns ~[-1, 1]. Map to angle in radians.
      const angle = noise(x * scale, y * scale) * TWO_PI;

      const nx = x + Math.cos(angle) * step;
      const ny = y + Math.sin(angle) * step;

      // Off-canvas? Respawn at a random position so the painting
      // stays distributed across the canvas instead of converging
      // on a single point.
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
        xArr[i] = Math.random() * w;
        yArr[i] = Math.random() * h;
        continue;
      }

      // The colour index tracks the particle's lifetime (mod 256).
      // We use a Uint8Array palette lookup so the per-pixel work is
      // an array read + a few sets into the ImageData — fast.
      const colorIdx = ((burnCount + i) & 0xff) * 3;
      trailCtx.strokeStyle = `rgb(${ramp[colorIdx]},${ramp[colorIdx + 1]},${ramp[colorIdx + 2]})`;

      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.lineTo(nx, ny);
      trailCtx.stroke();

      xArr[i] = nx;
      yArr[i] = ny;
    }

    burnCount++;
    if (burnCount % 8 === 0) {
      document.getElementById("burn").textContent = String(burnCount);
    }

    // Copy the offscreen trail onto the visible canvas.
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(trail, 0, 0);
  }

  // ---------- Wire controls ----------
  function wire() {
    const paletteSelect = document.getElementById("palette-select");
    for (const name of Object.keys(PALETTES)) {
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      paletteSelect.appendChild(opt);
    }
    paletteSelect.addEventListener("change", () => {
      state.palette = paletteSelect.value;
      writeHash();
    });

    const particlesInput = document.getElementById("particles-input");
    particlesInput.addEventListener("change", () => {
      const v = clamp(parseFloat(particlesInput.value), 100, 5000);
      if (Number.isFinite(v)) {
        state.particles = Math.round(v);
        resetParticles();
        writeHash();
      }
    });

    const stepInput = document.getElementById("step-input");
    stepInput.addEventListener("change", () => {
      const v = clamp(parseFloat(stepInput.value), 0.4, 6);
      if (Number.isFinite(v)) { state.step = v; writeHash(); }
    });

    const scaleInput = document.getElementById("scale-input");
    scaleInput.addEventListener("change", () => {
      const v = clamp(parseFloat(scaleInput.value), 0.0008, 0.04);
      if (Number.isFinite(v)) {
        state.scale = v;
        rebuildNoise();
        writeHash();
      }
    });

    const seedInput = document.getElementById("seed-input");
    seedInput.addEventListener("change", () => {
      const v = clamp(parseFloat(seedInput.value), 0.001, 1000);
      if (Number.isFinite(v)) {
        state.seed = v;
        rebuildNoise();
        writeHash();
      }
    });

    document.getElementById("play-btn").addEventListener("click", () => {
      playing = !playing;
      document.getElementById("play-btn").textContent = playing ? "Pause" : "Play";
      document.getElementById("status").textContent = playing ? "flowing" : "paused";
      if (playing) frame();
    });

    document.getElementById("reset-btn").addEventListener("click", () => {
      // Reset particles but keep the same seed/scale/palette.
      resetParticles();
      document.getElementById("status").textContent = "flowing";
      burnCount = 0;
      // Update the displayed burn count immediately rather than
      // waiting for the next multiple-of-8 frame inside the loop.
      document.getElementById("burn").textContent = "0";
    });

    document.getElementById("clear-btn").addEventListener("click", () => {
      // Wipe the trail entirely and start over.
      reset();
    });

    document.getElementById("link-btn").addEventListener("click", async () => {
      writeHash();
      const url = location.href;
      try {
        await navigator.clipboard.writeText(url);
        const b = document.getElementById("link-btn");
        const old = b.textContent;
        b.textContent = "copied!";
        setTimeout(() => { b.textContent = old; }, 1200);
      } catch (e) {
        // Some browsers block clipboard without HTTPS; fall back to
        // showing the URL in the status line.
        document.getElementById("status").textContent = "link: " + url;
      }
    });

    // Listen for back/forward navigation between hashes (e.g. a
    // visitor pastes two different URLs into the same tab) and
    // re-apply the parsed state.
    window.addEventListener("hashchange", () => {
      parseHash();
      reset();
      if (playing) frame();
    });
  }

  // ---------- Boot ----------
  function boot() {
    // Resize the offscreen trail to match the visible canvas, then
    // size the visible canvas to fill its container at devicePixelRatio.
    const wrap = canvas.parentElement;
    const cssW = Math.min(960, wrap.clientWidth - 2);
    const cssH = Math.round(cssW * 0.6);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width  = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    trail.width  = canvas.width;
    trail.height = canvas.height;

    parseHash();
    wire();
    reset();
    frame();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();