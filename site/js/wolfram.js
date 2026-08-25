// Wolfram 1D cellular automaton.
//
// A 1D CA is the simplest kind there is. You have a single row of cells,
// each either 0 or 1. To compute the next row, look at every cell and its
// two neighbours (a 3-cell window = 8 possible patterns = rule index in
// 0..255). The rule says, for each of the 8 patterns, what the new value
// of the center cell should be. Rule 30 (00011110), Rule 110 (01101110),
// and Rule 184 (10111000) are the famous ones; rule 30 in particular
// produces chaotic patterns from nothing.
//
// Here we run the CA continuously: each tick shifts the canvas up by one
// row and draws the new row at the bottom. The page keeps a history
// buffer (a circular array of CELL_W columns * HISTORY_H rows of bits),
// so visitors can scroll back up to see the first ~200 generations.
//
// State encoded in URL hash as #rule:seed:speed:wrap where:
//   rule   ∈ 0..255 (Wolfram rule number)
//   seed   ∈ "single" | "random" | "center" | "block" | "rand-n"
//   speed  ∈ 1..60 (frames per second)
//   wrap   ∈ 0|1 (1 = toroidal/periodic, 0 = cells outside edge = 0)
//
// All state lives in URL hash so any combination reproduces itself as a
// shareable link. window.history.replaceState on every state change keeps the
// history from filling with one entry per click.

(function () {
  'use strict';

  // ----- Config ----------------------------------------------------------

  // Cell width in CSS pixels (each cell is a square).
  const CELL_W = 4;
  // How many rows of history to keep (canvas height / CELL_W tall).
  const HISTORY_H = 140;
  // Bit width — width in cells. The canvas width in CSS pixels = BIT_W *
  // CELL_W. We want the canvas to fill ~700px wide, so BIT_W = 175 cells.
  const BIT_W = 175;

  // The history is a flat Uint8Array of BIT_W * HISTORY_H bits. Row 0 is
  // the topmost (oldest), row HISTORY_H-1 is the bottom (newest, where
  // new rows are written).
  let historyBuf = new Uint8Array(BIT_W * HISTORY_H);
  let headRow = HISTORY_H - 1; // index of the row we'll write next
  let rule = 30;
  let ruleTable = null;        // 8-entry lookup table derived from `rule`
  let seed = 'center';         // initial condition
  let speed = 30;              // ticks per second
  let wrap = 1;                // toroidal boundaries by default

  // Canvas / DOM
  const canvas = document.getElementById('wolfram-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = BIT_W * CELL_W;
  canvas.height = HISTORY_H * CELL_W;

  const ruleInput = document.getElementById('wf-rule');
  const seedSelect = document.getElementById('wf-seed');
  const speedInput = document.getElementById('wf-speed');
  const wrapInput = document.getElementById('wf-wrap');
  const presetSelect = document.getElementById('wf-preset');
  const resetBtn = document.getElementById('wf-reset');
  const pauseBtn = document.getElementById('wf-pause');
  const stepBtn = document.getElementById('wf-step');
  const copyBtn = document.getElementById('wf-copy');
  const status = document.getElementById('wf-status');

  let paused = false;
  let lastTick = 0;
  let tickAccumulator = 0;
  let rafId = null;
  let frameCount = 0;

  // ----- Helpers ---------------------------------------------------------

  // Build the 8-entry rule table from the rule number. Bit i of the rule
  // = the new value of the center cell when the 3-cell window is i.
  function buildRuleTable(r) {
    const t = new Uint8Array(8);
    for (let i = 0; i < 8; i++) t[i] = (r >> i) & 1;
    return t;
  }

  // Seed the initial row (row 0) based on the seed name.
  function seedInitial(name) {
    historyBuf.fill(0);
    const row0 = 0; // row 0 of the history buffer
    if (name === 'single') {
      // Single live cell at the centre.
      historyBuf[row0 * BIT_W + (BIT_W >> 1)] = 1;
    } else if (name === 'center') {
      // A small pattern around the centre.
      const mid = BIT_W >> 1;
      historyBuf[row0 * BIT_W + mid - 1] = 1;
      historyBuf[row0 * BIT_W + mid] = 1;
      historyBuf[row0 * BIT_W + mid + 1] = 1;
    } else if (name === 'block') {
      // A solid block in the centre, ~1/4 of the width.
      const start = (BIT_W >> 1) - (BIT_W >> 2);
      const end = (BIT_W >> 1) + (BIT_W >> 2);
      for (let i = start; i < end; i++) historyBuf[row0 * BIT_W + i] = 1;
    } else if (name === 'random') {
      // Random across the whole row.
      for (let i = 0; i < BIT_W; i++) historyBuf[row0 * BIT_W + i] = Math.random() < 0.5 ? 1 : 0;
    } else if (name === 'rand-n') {
      // Random with ~50% density across the whole row (more entropy than
      // the simple 'random' seed).
      for (let i = 0; i < BIT_W; i++) historyBuf[row0 * BIT_W + i] = Math.random() < 0.5 ? 1 : 0;
      // Re-jiggle so it's actually different from 'random' — make sure
      // both 0 and 1 appear.
      let anyOn = false, anyOff = false;
      for (let i = 0; i < BIT_W; i++) {
        if (historyBuf[i] === 1) anyOn = true; else anyOff = true;
        if (anyOn && anyOff) break;
      }
      if (!anyOn) historyBuf[(BIT_W >> 1)] = 1;
      if (!anyOff) historyBuf[(BIT_W >> 1)] = 0;
    }
    headRow = 1; // next row to write is row 1
  }

  // Compute one new row from the previous row using the rule table.
  function step() {
    const prev = headRow - 1;
    if (prev < 0) return; // shouldn't happen if we reset on overflow
    const out = headRow;
    for (let x = 0; x < BIT_W; x++) {
      const left = x === 0 ? (wrap ? BIT_W - 1 : 0) : x - 1;
      const right = x === BIT_W - 1 ? (wrap ? 0 : BIT_W - 1) : x + 1;
      // The 3-cell window, with the center at x. The rule index is
      // (left, center, right) read as 3 bits, center as the high bit.
      const idx = (historyBuf[prev * BIT_W + left] << 2)
                | (historyBuf[prev * BIT_W + x] << 1)
                | historyBuf[prev * BIT_W + right];
      historyBuf[out * BIT_W + x] = ruleTable[idx];
    }
    headRow++;
    if (headRow >= HISTORY_H) {
      // Shift the whole history up by one row to make room. This is the
      // "scroll" effect — visitors see a continuously-scrolling tape.
      historyBuf.copyWithin(0, BIT_W);
      headRow = HISTORY_H - 1;
    }
  }

  // Paint the current history buffer to the visible canvas. We draw with
  // putImageData on a single ImageData the size of the canvas; each bit
  // becomes a CELL_W × CELL_W block of accent or bg color.
  function paint() {
    const img = ctx.createImageData(canvas.width, canvas.height);
    const data = img.data;
    const bg = getCss('--bg') || '#f7f5ef';
    const fg = getCss('--accent') || '#c25c45';
    // Parse the colors once per paint call.
    const bgRgb = parseColor(bg);
    const fgRgb = parseColor(fg);
    for (let y = 0; y < HISTORY_H; y++) {
      for (let x = 0; x < BIT_W; x++) {
        const bit = historyBuf[y * BIT_W + x];
        const r = bit ? fgRgb[0] : bgRgb[0];
        const g = bit ? fgRgb[1] : bgRgb[1];
        const b = bit ? fgRgb[2] : bgRgb[2];
        // Fill the CELL_W × CELL_W block.
        for (let dy = 0; dy < CELL_W; dy++) {
          for (let dx = 0; dx < CELL_W; dx++) {
            const px = (y * CELL_W + dy) * canvas.width + (x * CELL_W + dx);
            data[px * 4 + 0] = r;
            data[px * 4 + 1] = g;
            data[px * 4 + 2] = b;
            data[px * 4 + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function parseColor(s) {
    // Accepts #rrggbb or rgb(r, g, b). Fallback to bg.
    s = (s || '').trim();
    if (s.startsWith('#')) {
      const h = s.slice(1);
      if (h.length === 6) {
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      if (h.length === 3) {
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
      }
    }
    const m = s.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
    return [247, 245, 239];
  }

  // ----- Animation loop --------------------------------------------------

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = now - lastTick;
    lastTick = now;
    if (paused) {
      // Don't paint either — pause means truly frozen.
      return;
    }
    const tickInterval = 1000 / Math.max(1, speed);
    tickAccumulator += dt;
    let didStep = false;
    while (tickAccumulator >= tickInterval) {
      tickAccumulator -= tickInterval;
      step();
      didStep = true;
      frameCount++;
      if (frameCount % 30 === 0) updateStatus();
    }
    if (didStep) paint();
  }

  function updateStatus() {
    const bits = countBits();
    status.textContent =
      `rule ${rule} · ${seed} · ${speed} fps · ` +
      `${bits} live cells · ` +
      `${wrap ? 'toroidal' : 'edges zero'}`;
  }

  function countBits() {
    let n = 0;
    for (let i = 0; i < historyBuf.length; i++) if (historyBuf[i]) n++;
    return n;
  }

  // ----- Controls --------------------------------------------------------

  function applyRule(r) {
    r = Math.max(0, Math.min(255, r | 0));
    rule = r;
    ruleTable = buildRuleTable(r);
  }

  function readRuleFromInput() {
    const v = parseInt(ruleInput.value, 10);
    if (Number.isNaN(v)) {
      ruleInput.value = String(rule);
      return;
    }
    const r = Math.max(0, Math.min(255, v));
    if (r !== v) ruleInput.value = String(r);
    if (r !== rule) {
      applyRule(r);
      fullReset();
    } else {
      applyRule(r);
    }
  }

  function fullReset() {
    seedInitial(seed);
    paint();
    frameCount = 0;
    updateStatus();
  }

  ruleInput.addEventListener('change', readRuleFromInput);
  ruleInput.addEventListener('input', () => {
    // Live-update the rule only if it's in range, but don't reset on
    // every keystroke — wait for change (blur / Enter). The rule is
    // swapped in instantly (no history reset) so visitors can watch the
    // pattern morph as they sweep through the rules; this is the page's
    // main delight. We still write the URL hash so the shareable link
    // reflects the current rule.
    const v = parseInt(ruleInput.value, 10);
    if (!Number.isNaN(v) && v >= 0 && v <= 255 && v !== rule) {
      applyRule(v);
      writeHash();
    }
  });

  seedSelect.addEventListener('change', () => {
    seed = seedSelect.value;
    fullReset();
  });

  speedInput.addEventListener('input', () => {
    const v = parseInt(speedInput.value, 10);
    if (!Number.isNaN(v)) {
      speed = Math.max(1, Math.min(120, v));
      speedInput.value = String(speed);
      updateStatus();
    }
  });

  wrapInput.addEventListener('change', () => {
    wrap = wrapInput.checked ? 1 : 0;
    fullReset();
  });

  presetSelect.addEventListener('change', () => {
    const v = presetSelect.value;
    if (!v) return;
    const r = parseInt(v, 10);
    if (!Number.isNaN(r)) {
      applyRule(r);
      ruleInput.value = String(r);
      fullReset();
    }
    presetSelect.value = '';
  });

  resetBtn.addEventListener('click', () => fullReset());

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });

  stepBtn.addEventListener('click', () => {
    // Step exactly once even when paused.
    if (!paused) {
      paused = true;
      pauseBtn.textContent = 'Resume';
    }
    step();
    paint();
    updateStatus();
  });

  copyBtn.addEventListener('click', () => {
    const hash = '#' + encodeURIComponent(
      [rule, seed, speed, wrap].join(':')
    );
    const url = location.origin + location.pathname + hash;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => flashCopied());
    } else {
      // Fallback: select-and-copy from a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flashCopied(); }
      finally { document.body.removeChild(ta); }
    }
  });

  function flashCopied() {
    const old = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = old; }, 1200);
  }

  // ----- URL hash deep linking -------------------------------------------

  function parseHash() {
    const h = (location.hash || '').replace(/^#/, '');
    if (!h) return null;
    const parts = h.split(':').map(s => decodeURIComponent(s));
    const out = {};
    if (parts[0] !== undefined) out.rule = parseInt(parts[0], 10);
    if (parts[1] !== undefined) out.seed = parts[1];
    if (parts[2] !== undefined) out.speed = parseInt(parts[2], 10);
    if (parts[3] !== undefined) out.wrap = parseInt(parts[3], 10) ? 1 : 0;
    return out;
  }

  function writeHash() {
    const h = [rule, seed, speed, wrap].join(':');
    // window.history.replaceState — note the global is window.history,
    // not our local `history` Uint8Array (which shadows the global name
    // inside this IIFE). Without `window.`, replaceState is undefined.
    window.history.replaceState(null, '', '#' + h);
  }

  function applyHash() {
    const parsed = parseHash();
    if (!parsed) return false;
    if (Number.isFinite(parsed.rule) && parsed.rule >= 0 && parsed.rule <= 255) {
      applyRule(parsed.rule);
      ruleInput.value = String(parsed.rule);
    }
    if (parsed.seed && ['single', 'center', 'block', 'random', 'rand-n'].indexOf(parsed.seed) !== -1) {
      seed = parsed.seed;
      seedSelect.value = seed;
    }
    if (Number.isFinite(parsed.speed) && parsed.speed >= 1 && parsed.speed <= 120) {
      speed = parsed.speed;
      speedInput.value = String(speed);
    }
    if (parsed.wrap === 0 || parsed.wrap === 1) {
      wrap = parsed.wrap;
      wrapInput.checked = !!wrap;
    }
    return true;
  }

  // Initial state: read hash if present, otherwise use defaults.
  applyHash();
  // Always write hash on first load so the URL reflects the actual state.
  writeHash();

  // Listen for hash changes (back/forward, manual edit).
  window.addEventListener('hashchange', () => {
    if (applyHash()) fullReset();
  });

  // Kick off.
  ruleTable = buildRuleTable(rule);
  seedInitial(seed);
  paint();
  updateStatus();
  lastTick = performance.now();
  rafId = requestAnimationFrame(loop);
})();
