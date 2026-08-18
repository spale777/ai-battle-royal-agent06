// Brian's Brain — a 3-state cellular automaton on a toroidal grid.
// State per cell: 0 = dead, 1 = alive, 2 = dying.
// Rule each tick:
//   alive  -> dying
//   dying  -> dead
//   dead   -> alive if exactly 2 alive neighbours, else dead
// (Count neighbours uses only the alive state.)

(function () {
  'use strict';

  const COLS = 100;
  const ROWS = 60;
  const CELL = 8;

  const canvas = document.getElementById('bb');
  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;
  const ctx = canvas.getContext('2d');

  const DEAD = 0;
  const ALIVE = 1;
  const DYING = 2;

  let grid = new Uint8Array(COLS * ROWS);
  let next = new Uint8Array(COLS * ROWS);
  let generation = 0;
  let aliveCount = 0;
  let dyingCount = 0;
  let playing = false;
  let timer = null;
  let speed = 80;
  let dragging = false;
  let dragValue = ALIVE; // we only allow painting alive

  const idx = (c, r) => ((r + ROWS) % ROWS) * COLS + ((c + COLS) % COLS);

  function step() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cur = grid[idx(c, r)];
        if (cur === ALIVE) {
          next[idx(c, r)] = DYING;
        } else if (cur === DYING) {
          next[idx(c, r)] = DEAD;
        } else {
          // DEAD: count alive neighbours
          let n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              if (grid[idx(c + dc, r + dr)] === ALIVE) n++;
            }
          }
          next[idx(c, r)] = (n === 2) ? ALIVE : DEAD;
        }
      }
    }
    [grid, next] = [next, grid];
    generation++;
    recomputeCounts();
    draw();
  }

  function recomputeCounts() {
    let a = 0, d = 0;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v === ALIVE) a++;
      else if (v === DYING) d++;
    }
    aliveCount = a;
    dyingCount = d;
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function draw() {
    const bg = getCss('--bg') || '#fff';
    const fg = getCss('--fg') || '#1a1a1a';
    const rule = getCss('--rule') || '#d8d4c7';
    const accent = getCss('--accent') || '#2c5e3a';
    const dying = '#c25c45';
    const muted = getCss('--muted') || '#6a6a6a';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = grid[idx(c, r)];
        if (v === ALIVE) {
          ctx.fillStyle = accent;
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
        } else if (v === DYING) {
          ctx.fillStyle = dying;
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }

    // faint grid
    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= COLS; c++) {
      ctx.moveTo(c * CELL + 0.5, 0);
      ctx.lineTo(c * CELL + 0.5, ROWS * CELL);
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.moveTo(0, r * CELL + 0.5);
      ctx.lineTo(COLS * CELL, r * CELL + 0.5);
    }
    ctx.stroke();

    const stats = document.getElementById('stats');
    if (stats) {
      stats.textContent =
        `generation ${generation} · ${aliveCount} alive · ${dyingCount} dying`;
      stats.style.color = muted;
    }
    // legend colours next to the words (CSS could do this but inline is fine)
    // No-op — colours are documented in the page text.
  }

  function clear() {
    grid = new Uint8Array(COLS * ROWS);
    next = new Uint8Array(COLS * ROWS);
    generation = 0;
    aliveCount = 0;
    dyingCount = 0;
    draw();
  }

  function randomize() {
    for (let i = 0; i < grid.length; i++) grid[i] = (Math.random() < 0.06) ? ALIVE : DEAD;
    generation = 0;
    recomputeCounts();
    draw();
  }

  // ─── presets ─────────────────────────────────────────────────────────────
  // Each preset is a list of [c, r] offsets. The centre of the pattern is
  // placed near the middle of the grid. Some Brian's Brain patterns need
  // a few DYING cells to start; we encode those as tuples [c, r, state].
  const PRESETS = {
    // Minimal glider — moves diagonally
    glider: [
      [1, 0, ALIVE],
      [0, 1, ALIVE],
      [2, 1, ALIVE],
      [1, 1, DYING],
    ],
    // "Big ship" — a hand-built multi-row shape that propagates rightward.
    // Bounding box ~17x10. Coordinates are relative offsets; the pattern is
    // centred at placement time.
    bigship: [
      // row 0
      [3, 0, ALIVE], [4, 0, ALIVE],
      // row 1
      [2, 1, ALIVE], [3, 1, DYING], [4, 1, DYING],
      // row 2
      [1, 2, ALIVE], [2, 2, DYING], [3, 2, DYING],
      [4, 2, ALIVE], [5, 2, DYING], [6, 2, ALIVE],
      // row 3
      [0, 3, ALIVE], [1, 3, DYING], [2, 3, DYING],
      [3, 3, ALIVE], [4, 3, ALIVE], [5, 3, DYING], [6, 3, DYING],
      [7, 3, ALIVE],
      // row 4
      [0, 4, ALIVE], [1, 4, ALIVE], [2, 4, DYING], [3, 4, DYING],
      [4, 4, ALIVE], [5, 4, ALIVE], [6, 4, DYING], [7, 4, DYING],
      [8, 4, ALIVE],
      // row 5
      [0, 5, ALIVE], [1, 5, DYING], [2, 5, DYING],
      [3, 5, ALIVE], [4, 5, DYING], [5, 5, DYING], [6, 5, ALIVE],
      [8, 5, ALIVE],
      // row 6
      [0, 6, DYING], [1, 6, DYING],
      [3, 6, ALIVE], [4, 6, DYING], [5, 6, DYING], [6, 6, ALIVE],
      [8, 6, ALIVE],
      // row 7
      [1, 7, DYING], [2, 7, DYING],
      [3, 7, ALIVE], [4, 7, DYING], [5, 7, DYING], [6, 7, ALIVE],
      [8, 7, ALIVE],
      // row 8
      [1, 8, DYING], [2, 8, DYING],
      [4, 8, ALIVE], [5, 8, ALIVE],
      [6, 8, ALIVE], [7, 8, ALIVE],
      // row 9
      [3, 9, ALIVE], [4, 9, ALIVE],
    ],
    // "Bigger ship" — a denser cousin that produces more turbulent flow.
    bigger: [
      // top
      [0, 0, ALIVE], [1, 0, ALIVE],
      [2, 0, ALIVE], [3, 0, ALIVE],
      // row 1
      [0, 1, DYING], [1, 1, DYING],
      [2, 1, DYING], [3, 1, DYING],
      [4, 1, ALIVE], [5, 1, ALIVE],
      // row 2
      [0, 2, ALIVE], [1, 2, DYING], [2, 2, DYING], [3, 2, ALIVE],
      [4, 2, DYING], [5, 2, DYING], [6, 2, ALIVE], [7, 2, ALIVE],
      // row 3
      [1, 3, ALIVE], [2, 3, DYING], [3, 3, DYING],
      [4, 3, ALIVE], [5, 3, ALIVE], [6, 3, DYING], [7, 3, DYING],
      [8, 3, ALIVE],
      // row 4
      [0, 4, ALIVE], [1, 4, ALIVE], [2, 4, DYING], [3, 4, DYING],
      [4, 4, ALIVE], [5, 4, ALIVE], [6, 4, DYING], [7, 4, DYING],
      [8, 4, ALIVE], [9, 4, ALIVE],
      // row 5
      [0, 5, ALIVE], [1, 5, DYING], [2, 5, DYING],
      [3, 5, ALIVE], [4, 5, DYING], [5, 5, DYING], [6, 5, ALIVE],
      [9, 5, ALIVE], [10, 5, ALIVE],
      // row 6
      [0, 6, DYING], [1, 6, DYING],
      [3, 6, ALIVE], [4, 6, DYING], [5, 6, DYING], [6, 6, ALIVE],
      [9, 6, DYING], [10, 6, DYING],
      [11, 6, ALIVE], [12, 6, ALIVE],
      // row 7
      [1, 7, DYING], [2, 7, DYING],
      [3, 7, ALIVE], [4, 7, DYING], [5, 7, DYING], [6, 7, ALIVE],
      [11, 7, ALIVE], [12, 7, ALIVE],
      // row 8
      [1, 8, DYING], [2, 8, DYING],
      [4, 8, ALIVE], [5, 8, ALIVE], [6, 8, ALIVE], [7, 8, ALIVE],
      [11, 8, ALIVE], [12, 8, ALIVE],
      // row 9
      [4, 9, ALIVE], [5, 9, ALIVE],
      [11, 9, ALIVE], [12, 9, ALIVE],
    ],
    // A fleet of three diagonal gliders, phase-offset.
    fleet: [
      [20, 5, ALIVE], [19, 6, ALIVE], [21, 6, ALIVE], [20, 6, DYING],
      [30, 15, ALIVE], [29, 16, ALIVE], [31, 16, ALIVE], [30, 16, DYING],
      [40, 25, ALIVE], [39, 26, ALIVE], [41, 26, ALIVE], [40, 26, DYING],
    ],
    // A solid wedge that triggers a wave moving right.
    wedge: (() => {
      const cells = [];
      for (let i = 0; i < 14; i++) {
        cells.push([i, 0, ALIVE]);
      }
      return cells;
    })(),
    // A cross / plus that explodes outward in a symmetric bloom.
    cross: (() => {
      const cells = [];
      const cx = 8, cy = 5;
      const r = 8;
      for (let i = -r; i <= r; i++) {
        cells.push([cx + i, cy, ALIVE]);
        cells.push([cx, cy + i, ALIVE]);
      }
      return cells;
    })(),
  };

  function placePreset(name) {
    const cells = PRESETS[name];
    if (!cells) return;
    // Compute bounding box, then centre the pattern in the grid.
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const [c, r] of cells) {
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    const cc = Math.floor(COLS / 2);
    const cr = Math.floor(ROWS / 2);
    const dx = cc - Math.floor((minC + maxC) / 2);
    const dy = cr - Math.floor((minR + maxR) / 2);
    for (const [c, r, state] of cells) {
      grid[idx(c + dx, r + dy)] = state;
    }
    generation = 0;
    recomputeCounts();
    draw();
  }

  // ─── interaction ─────────────────────────────────────────────────────────
  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return [Math.floor(x / CELL), Math.floor(y / CELL)];
  }

  function paintCell(c, r) {
    // Painting toggles dead ↔ alive. (Dying is "in transit"; ignore.)
    const i = idx(c, r);
    grid[i] = (grid[i] === ALIVE) ? DEAD : ALIVE;
  }

  canvas.addEventListener('mousedown', (ev) => {
    const [c, r] = cellFromEvent(ev);
    paintCell(c, r);
    dragging = true;
    recomputeCounts();
    draw();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const [c, r] = cellFromEvent(ev);
    paintCell(c, r);
    recomputeCounts();
    draw();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  canvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    const t = ev.touches[0];
    const [c, r] = cellFromEvent(t);
    paintCell(c, r);
    dragging = true;
    recomputeCounts();
    draw();
  }, { passive: false });
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    if (!dragging) return;
    const t = ev.touches[0];
    const [c, r] = cellFromEvent(t);
    paintCell(c, r);
    recomputeCounts();
    draw();
  }, { passive: false });
  canvas.addEventListener('touchend', () => { dragging = false; });

  // ─── buttons ─────────────────────────────────────────────────────────────
  document.getElementById('step').addEventListener('click', step);
  document.getElementById('clear').addEventListener('click', clear);
  document.getElementById('random').addEventListener('click', randomize);
  const playBtn = document.getElementById('play');
  function setPlaying(p) {
    playing = p;
    playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play';
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) {
      timer = setInterval(step, speed);
    }
  }
  playBtn.addEventListener('click', () => setPlaying(!playing));

  document.getElementById('speed').addEventListener('change', (ev) => {
    speed = parseInt(ev.target.value, 10) || 80;
    if (playing) setPlaying(true);
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      placePreset(btn.getAttribute('data-preset'));
    });
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === ' ') { ev.preventDefault(); step(); }
    else if (ev.key === 'c') clear();
    else if (ev.key === 'r') randomize();
    else if (ev.key === 'p') setPlaying(!playing);
  });

  // Start with a single glider so the page is alive but quiet.
  placePreset('glider');
})();
