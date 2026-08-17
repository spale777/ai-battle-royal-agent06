// One-bit pixel art editor. 32×32 grid, paint/erase, fill, mirror modes,
// undo, export PNG, save/load via URL hash.
// State is also stashed in localStorage so the editor survives reloads.

(function () {
  'use strict';

  const SIZE = 32;
  const PIXEL = 12; // CSS pixels per cell

  const canvas = document.getElementById('pixel');
  const ctx = canvas.getContext('2d');
  canvas.width = SIZE * PIXEL;
  canvas.height = SIZE * PIXEL;

  // Tools: 'paint', 'erase', 'fill'. Drawing mode below.
  let tool = 'paint';
  let mirror = { h: false, v: false, d: false }; // h=horizontal, v=vertical, d=diagonal
  let grid = new Uint8Array(SIZE * SIZE); // 1 = on, 0 = off
  let undoStack = [];
  const UNDO_MAX = 50;

  // ---- state ---------------------------------------------------------------

  function cloneGrid() { return new Uint8Array(grid); }
  function pushUndo() {
    undoStack.push(cloneGrid());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  function undo() {
    if (undoStack.length === 0) return;
    grid = undoStack.pop();
    draw();
    persist();
  }

  function inBounds(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

  function setCell(x, y, v) {
    if (!inBounds(x, y)) return;
    grid[y * SIZE + x] = v;
  }
  function getCell(x, y) {
    if (!inBounds(x, y)) return 0;
    return grid[y * SIZE + x];
  }

  // Apply a value at (x, y) and (optionally) its mirrored partners.
  function applyAt(x, y, v) {
    if (!inBounds(x, y)) return;
    setCell(x, y, v);
    if (mirror.h) setCell(SIZE - 1 - x, y, v);
    if (mirror.v) setCell(x, SIZE - 1 - y, v);
    if (mirror.d) setCell(SIZE - 1 - x, SIZE - 1 - y, v);
  }

  // ---- drawing -------------------------------------------------------------

  function draw() {
    // background
    const bg = getCss('--bg') || '#fff';
    const fg = getCss('--fg') || '#1a1a1a';
    const rule = getCss('--rule') || '#d8d4c7';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // cells
    ctx.fillStyle = fg;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (grid[y * SIZE + x]) {
          ctx.fillRect(x * PIXEL, y * PIXEL, PIXEL, PIXEL);
        }
      }
    }

    // grid lines (every cell, very faint)
    ctx.strokeStyle = rule;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= SIZE; i++) {
      ctx.moveTo(i * PIXEL + 0.5, 0);
      ctx.lineTo(i * PIXEL + 0.5, canvas.height);
      ctx.moveTo(0, i * PIXEL + 0.5);
      ctx.lineTo(canvas.width, i * PIXEL + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    updateMeta();
  }

  function getCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function updateMeta() {
    let n = 0;
    for (let i = 0; i < grid.length; i++) n += grid[i];
    const meta = document.getElementById('pixel-meta');
    if (meta) meta.textContent = SIZE + '×' + SIZE + ' · ' + n + ' set';
  }

  // ---- tools ---------------------------------------------------------------

  function floodFill(x, y, v) {
    const target = getCell(x, y);
    if (target === v) return;
    const stack = [[x, y]];
    const seen = new Uint8Array(SIZE * SIZE);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!inBounds(cx, cy)) continue;
      if (seen[cy * SIZE + cx]) continue;
      if (getCell(cx, cy) !== target) continue;
      seen[cy * SIZE + cx] = 1;
      applyAt(cx, cy, v);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  // ---- input ---------------------------------------------------------------

  let dragging = false;
  let lastCell = null; // dedup consecutive paints on same cell

  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return [Math.floor(x / PIXEL), Math.floor(y / PIXEL)];
  }

  function handleDown(ev) {
    ev.preventDefault();
    const [x, y] = cellFromEvent(ev);
    if (!inBounds(x, y)) return;
    dragging = true;
    pushUndo();
    lastCell = null;
    act(x, y, ev);
  }

  function handleMove(ev) {
    if (!dragging) return;
    const [x, y] = cellFromEvent(ev);
    if (lastCell && lastCell[0] === x && lastCell[1] === y) return;
    if (!inBounds(x, y)) return;
    act(x, y, ev);
    lastCell = [x, y];
  }

  function act(x, y, ev) {
    const v = (tool === 'erase') ? 0 : 1;
    if (tool === 'fill') {
      floodFill(x, y, v);
      pushUndo(); // also remember for undo (flood can be undone)
    } else {
      // toggle semantics: if shift is held, force erase; otherwise paint
      const finalV = ev.shiftKey ? 0 : v;
      applyAt(x, y, finalV);
    }
    draw();
  }

  canvas.addEventListener('mousedown', handleDown);
  canvas.addEventListener('mousemove', handleMove);
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mouseleave', () => { dragging = false; });

  // touch
  canvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    const t = ev.touches[0];
    handleDown({ preventDefault: () => {}, clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    const t = ev.touches[0];
    handleMove({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });
  canvas.addEventListener('touchend', () => { dragging = false; });

  // ---- buttons -------------------------------------------------------------

  function setTool(name) {
    tool = name;
    document.querySelectorAll('[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tool') === name);
    });
  }

  function setMirror(key) {
    mirror[key] = !mirror[key];
    const btn = document.querySelector('[data-mirror="' + key + '"]');
    if (btn) btn.classList.toggle('active', mirror[key]);
    persist();
  }

  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.getAttribute('data-tool')));
  });
  document.querySelectorAll('[data-mirror]').forEach((b) => {
    b.addEventListener('click', () => setMirror(b.getAttribute('data-mirror')));
  });
  document.getElementById('clear-btn').addEventListener('click', () => {
    if (grid.every((v) => v === 0)) return;
    pushUndo();
    grid = new Uint8Array(SIZE * SIZE);
    draw();
    persist();
  });
  document.getElementById('undo-btn').addEventListener('click', undo);

  // ---- export / import -----------------------------------------------------

  // Encode the grid as base64 of packed bits.
  function encodeGrid() {
    const bytes = new Uint8Array(Math.ceil(grid.length / 8));
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]) bytes[i >> 3] |= 1 << (i & 7);
    }
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function decodeGrid(b64) {
    let bin;
    try { bin = atob(b64); } catch (_) { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const out = new Uint8Array(SIZE * SIZE);
    for (let i = 0; i < out.length; i++) {
      out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
    }
    return out;
  }

  function shareLink() {
    const mh = mirror.h ? '1' : '0';
    const mv = mirror.v ? '1' : '0';
    const md = mirror.d ? '1' : '0';
    const url = window.location.origin + window.location.pathname + '#' + mh + mv + md + encodeGrid();
    return url;
  }

  function loadFromHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash || hash.length < 3) return false;
    const mh = hash[0] === '1';
    const mv = hash[1] === '1';
    const md = hash[2] === '1';
    const decoded = decodeGrid(hash.slice(3));
    if (!decoded) return false;
    grid = decoded;
    mirror = { h: mh, v: mv, d: md };
    document.querySelectorAll('[data-mirror]').forEach((b) => {
      b.classList.toggle('active', !!mirror[b.getAttribute('data-mirror')]);
    });
    return true;
  }

  document.getElementById('share-btn').addEventListener('click', () => {
    const link = shareLink();
    navigator.clipboard && navigator.clipboard.writeText(link).catch(() => {});
    // also update the URL bar so a manual copy works
    history.replaceState(null, '', link);
    const out = document.getElementById('share-out');
    if (out) {
      out.textContent = 'link copied · ' + link.slice(0, 64) + (link.length > 64 ? '…' : '');
      out.style.display = 'block';
    }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    // Render to an offscreen canvas at a larger size for export.
    const EXP = 16;
    const c = document.createElement('canvas');
    c.width = SIZE * EXP;
    c.height = SIZE * EXP;
    const cctx = c.getContext('2d');
    cctx.fillStyle = '#fff';
    cctx.fillRect(0, 0, c.width, c.height);
    cctx.fillStyle = '#1a1a1a';
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (grid[y * SIZE + x]) cctx.fillRect(x * EXP, y * EXP, EXP, EXP);
      }
    }
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pixel-' + Date.now() + '.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  });

  // ---- persistence ---------------------------------------------------------

  function persist() {
    try {
      localStorage.setItem('agent06-pixel', encodeGrid() + '|' +
        (mirror.h ? '1' : '0') + (mirror.v ? '1' : '0') + (mirror.d ? '1' : '0'));
    } catch (_) {}
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem('agent06-pixel');
      if (!raw) return false;
      const [b64, m] = raw.split('|');
      const decoded = decodeGrid(b64);
      if (!decoded) return false;
      grid = decoded;
      mirror = {
        h: m && m[0] === '1',
        v: m && m[1] === '1',
        d: m && m[2] === '1',
      };
      document.querySelectorAll('[data-mirror]').forEach((b) => {
        b.classList.toggle('active', !!mirror[b.getAttribute('data-mirror')]);
      });
      return true;
    } catch (_) { return false; }
  }

  // ---- keyboard ------------------------------------------------------------

  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
    else if (ev.key === 'b') setTool('paint');
    else if (ev.key === 'e') setTool('erase');
    else if (ev.key === 'g') setTool('fill');
    else if (ev.key === 'c') {
      ev.preventDefault();
      pushUndo();
      grid = new Uint8Array(SIZE * SIZE);
      draw();
      persist();
    }
  });

  // ---- boot ----------------------------------------------------------------

  // Priority: URL hash > localStorage > empty.
  if (!loadFromHash()) loadLocal();
  setTool('paint');
  draw();

  window.addEventListener('hashchange', () => {
    if (loadFromHash()) draw();
  });
})();
