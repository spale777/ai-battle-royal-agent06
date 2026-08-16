// Conway's Game of Life on a toroidal canvas. Click to toggle, drag to paint.
// Toroidal because then gliders can travel forever and we don't have to
// worry about clipping them off the edge.

(function () {
  'use strict';

  const COLS = 100;
  const ROWS = 60;
  const CELL = 8;

  const canvas = document.getElementById('life');
  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;
  const ctx = canvas.getContext('2d');

  let grid = new Uint8Array(COLS * ROWS);
  let next = new Uint8Array(COLS * ROWS);
  let generation = 0;
  let aliveCount = 0;
  let playing = false;
  let timer = null;
  let speed = 80;
  let dragging = false;
  let dragValue = 1;

  const idx = (c, r) => ((r + ROWS) % ROWS) * COLS + ((c + COLS) % COLS);

  function step() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            n += grid[idx(c + dc, r + dr)];
          }
        }
        const alive = grid[idx(c, r)];
        if (alive && (n === 2 || n === 3)) next[idx(c, r)] = 1;
        else if (!alive && n === 3) next[idx(c, r)] = 1;
        else next[idx(c, r)] = 0;
      }
    }
    [grid, next] = [next, grid];
    generation++;
    recomputeAlive();
    draw();
  }

  function recomputeAlive() {
    let n = 0;
    for (let i = 0; i < grid.length; i++) n += grid[i];
    aliveCount = n;
  }

  function draw() {
    ctx.fillStyle = getCss('--bg') || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // live cells
    ctx.fillStyle = getCss('--fg') || '#1a1a1a';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[idx(c, r)]) {
          ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }

    // faint grid
    ctx.strokeStyle = getCss('--rule') || '#d8d4c7';
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
    if (stats) stats.textContent = `generation ${generation} · ${aliveCount} alive`;
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function clear() {
    grid = new Uint8Array(COLS * ROWS);
    next = new Uint8Array(COLS * ROWS);
    generation = 0;
    aliveCount = 0;
    draw();
  }

  function randomize() {
    for (let i = 0; i < grid.length; i++) grid[i] = Math.random() < 0.18 ? 1 : 0;
    generation = 0;
    recomputeAlive();
    draw();
  }

  // presets: list of [c, r] offsets, drawn centred.
  const PRESETS = {
    glider: [[0,0],[1,1],[2,1],[0,2],[1,2]],
    lwss:  [[0,0],[1,0],[2,0],[3,0],[1,4],[0,3],[3,3],[3,1],[1,2]],
    pulsar: (() => {
      // period-3 pulsar
      const p = [];
      const ring = (cx, cy) => {
        for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0],[2,1],[2,-1],[1,2],[-1,2],[2,2],[-2,2],[2,-2],[-2,-2],[1,-2],[-1,-2]]) {
          p.push([cx + dx, cy + dy]);
        }
      };
      ring(2, 2); ring(-2, 2); ring(2, -2); ring(-2, -2);
      return p;
    })(),
    gosper: [
      // left block
      [0,4],[0,5],[1,4],[1,5],
      // left ship
      [10,4],[10,5],[10,6],[11,3],[11,7],[12,2],[12,8],[13,2],[13,8],[14,5],[15,3],[15,7],[16,4],[16,5],[16,6],[17,5],
      // right ship
      [20,2],[20,3],[20,4],[21,2],[21,3],[21,4],[22,1],[22,5],[24,0],[24,1],[24,5],[24,6],
      // right block
      [34,2],[34,3],[35,2],[35,3],
    ],
    rpentomino: [[1,0],[0,1],[1,1],[2,1],[1,2]],
    acorn: [[1,0],[3,1],[0,2],[1,2],[4,2],[5,2],[6,2]],
  };

  function placePreset(name) {
    const cells = PRESETS[name];
    if (!cells) return;
    // clear around the centre
    const cc = Math.floor(COLS / 2);
    const cr = Math.floor(ROWS / 2);
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const [c, r] of cells) {
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    const dx = cc - Math.floor((minC + maxC) / 2);
    const dy = cr - Math.floor((minR + maxR) / 2);
    for (const [c, r] of cells) {
      grid[idx(c + dx, r + dy)] = 1;
    }
    generation = 0;
    recomputeAlive();
    draw();
  }

  // mouse
  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return [Math.floor(x / CELL), Math.floor(y / CELL)];
  }

  canvas.addEventListener('mousedown', (ev) => {
    const [c, r] = cellFromEvent(ev);
    dragValue = grid[idx(c, r)] ? 0 : 1;
    grid[idx(c, r)] = dragValue;
    dragging = true;
    recomputeAlive();
    draw();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const [c, r] = cellFromEvent(ev);
    grid[idx(c, r)] = dragValue;
    recomputeAlive();
    draw();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  // touch
  canvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    const t = ev.touches[0];
    const [c, r] = cellFromEvent(t);
    dragValue = grid[idx(c, r)] ? 0 : 1;
    grid[idx(c, r)] = dragValue;
    dragging = true;
    recomputeAlive();
    draw();
  }, { passive: false });
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    if (!dragging) return;
    const t = ev.touches[0];
    const [c, r] = cellFromEvent(t);
    grid[idx(c, r)] = dragValue;
    recomputeAlive();
    draw();
  }, { passive: false });
  canvas.addEventListener('touchend', () => { dragging = false; });

  // buttons
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

  // keyboard
  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === ' ') { ev.preventDefault(); step(); }
    else if (ev.key === 'c') clear();
    else if (ev.key === 'r') randomize();
    else if (ev.key === 'p') setPlaying(!playing);
  });

  // start with a glider so the page isn't empty
  placePreset('glider');
})();
