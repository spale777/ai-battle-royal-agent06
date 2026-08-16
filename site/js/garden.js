// Garden: a deterministic procedural flower field.
// Seeded LCG -> a fixed sequence of plants, placed by a simple rule.
// Re-seedable from the URL hash (e.g. #spring-morning).

(function () {
  'use strict';

  const PALETTES = [
    // Each entry: [stem, leaf, petal, center, sky]
    ['#3d5a3a', '#5a7a4a', '#e8b8c8', '#f5d56a', '#d8e4d4'], // soft pink
    ['#2a4d3a', '#4a6a4a', '#f0c060', '#a04030', '#cbd8c4'], // marigold
    ['#3a4d2a', '#5a6a3a', '#b8c8e8', '#f5d0a0', '#d0d8d8'], // bluebell
    ['#4a3a2a', '#6a5a3a', '#e8a8a8', '#f5e08a', '#e0d8c8'], // dusty rose
    ['#1f3a2a', '#3a5a3a', '#c8e8b8', '#f5b878', '#c8d8c0'], // cream
  ];

  function lcg(seed) {
    // Numerical Recipes LCG
    let state = (seed | 0) || 1;
    return function () {
      state = (Math.imul(state, 1664525) + 1013904223) | 0;
      return ((state >>> 0) % 100000) / 100000;
    };
  }

  function hashString(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function draw(ctx, w, h, seed) {
    const rng = lcg(seed);
    const palette = PALETTES[Math.floor(rng() * PALETTES.length)];
    const [stem, leaf, petal, center, sky] = palette;

    // sky/background
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // grass texture (cheap: random short strokes)
    ctx.strokeStyle = '#0001';
    ctx.lineWidth = 1;
    for (let i = 0; i < 600; i++) {
      const x = rng() * w;
      const y = h * 0.55 + rng() * h * 0.45;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 6, y - 4 - rng() * 8);
      ctx.stroke();
    }

    // plants
    const plantCount = 60 + Math.floor(rng() * 30);
    for (let i = 0; i < plantCount; i++) {
      const x = rng() * w;
      const baseY = h * 0.55 + rng() * h * 0.42;
      const height = 20 + rng() * 60;
      const sway = (rng() - 0.5) * 8;
      drawFlower(ctx, x, baseY, height, sway, stem, leaf, petal, center, rng);
    }

    // sun
    const sunX = w * (0.15 + rng() * 0.7);
    const sunY = h * (0.1 + rng() * 0.25);
    const sunR = 18 + rng() * 16;
    const grad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2);
    grad.addColorStop(0, '#fffbe8');
    grad.addColorStop(0.5, '#ffe9a8aa');
    grad.addColorStop(1, '#ffe9a800');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFlower(ctx, x, baseY, height, sway, stem, leaf, petal, center, rng) {
    const topX = x + sway;
    const topY = baseY - height;

    // stem
    ctx.strokeStyle = stem;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.quadraticCurveTo(x + sway * 0.5, baseY - height * 0.5, topX, topY);
    ctx.stroke();

    // leaves
    const leafCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < leafCount; i++) {
      const t = 0.3 + rng() * 0.5;
      const lx = x + (topX - x) * t;
      const ly = baseY + (topY - baseY) * t;
      const dir = rng() < 0.5 ? -1 : 1;
      ctx.fillStyle = leaf;
      ctx.beginPath();
      ctx.ellipse(lx, ly, 6 + rng() * 4, 3 + rng() * 2, dir * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // flower head
    const petalCount = 5 + Math.floor(rng() * 4);
    const petalR = 4 + rng() * 3;
    const centerR = 2 + rng() * 2;
    ctx.fillStyle = petal;
    for (let p = 0; p < petalCount; p++) {
      const a = (p / petalCount) * Math.PI * 2;
      const px = topX + Math.cos(a) * (petalR + 1);
      const py = topY + Math.sin(a) * (petalR + 1);
      ctx.beginPath();
      ctx.arc(px, py, petalR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = center;
    ctx.beginPath();
    ctx.arc(topX, topY, centerR + 1, 0, Math.PI * 2);
    ctx.fill();
  }

  function regrow(seedOverride) {
    const canvas = document.getElementById('garden');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let seed;
    if (seedOverride != null) seed = seedOverride;
    else {
      const hash = window.location.hash.replace(/^#/, '').trim();
      seed = hash ? hashString(hash) : hashString(new Date().toISOString().slice(0, 10));
    }
    draw(ctx, canvas.width, canvas.height, seed);
    const display = document.getElementById('seed-display');
    if (display) display.textContent = 'seed: ' + (seed.toString(16));
  }

  function setupUI() {
    document.getElementById('regrow').addEventListener('click', () => {
      // new random seed each click
      window.location.hash = '';
      regrow(hashString(String(Date.now()) + Math.random()));
    });
    document.getElementById('copy-seed').addEventListener('click', () => {
      const hash = window.location.hash.replace(/^#/, '');
      navigator.clipboard && navigator.clipboard.writeText(window.location.href).catch(() => {});
    });
    document.getElementById('share-seed').addEventListener('click', () => {
      // convert current numeric seed to a phrase
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      const phrase = seedToWords(hashString(hash));
      navigator.clipboard && navigator.clipboard.writeText(phrase).catch(() => {});
      alert('Garden seed: ' + phrase + '\n(copied to clipboard if your browser allows)');
    });
  }

  // tiny word encoder so seeds are human-shareable
  const WORDS = ('quiet moss fern amber pine brook clover dusk fern tide aspen '
    + 'reed sage thistle broom heather lichen orchid poppy thyme mist violet '
    + 'willow juniper rose bay basil aster daisy flax hazel').split(' ');
  function seedToWords(n) {
    const a = WORDS[(n >>> 0) % WORDS.length];
    const b = WORDS[Math.floor(n / WORDS.length) % WORDS.length];
    const c = WORDS[Math.floor(n / (WORDS.length * WORDS.length)) % WORDS.length];
    return `${a}-${b}-${c}`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { regrow(); setupUI(); });
  } else {
    regrow();
    setupUI();
  }
})();
