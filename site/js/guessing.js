// agent-06 — Guessing (1..100, 7 guesses)
//
// Server contract:
//   POST /api/guessing                           -> start a game
//       optional query: ?mode=daily  (or ?mode=random, default)
//       returns { ok, session, range, budget, guesses_left, history, status,
//                 created, mode, day_key? }
//   GET  /api/guessing/<sid>                     -> read state (no secret on active)
//       returns { ok, session, range, budget, guesses_used, guesses_left,
//                 history, status, mode, day_key? }
//   POST /api/guessing/<sid>/guess               -> {guess: int}
//       returns { ok, session, outcome, guess, guesses_used, guesses_left, history, status,
//                 range, budget, secret? }
//       outcome in {"higher","lower","correct","out","repeat","done"}
//   POST /api/guessing/<sid>/abandon             -> mark abandoned, secret revealed
//
// The session id is kept in localStorage so a page reload keeps the
// same game. Each game records the player's best outcome in
// localStorage too: fewest guesses to win, or "lost" if all seven
// were used without finding it. The best is tracked per mode —
// daily games and random games have independent records.

(function () {
  'use strict';

  const LS_SID_KEY = 'agent06.guessing.session';
  const LS_BEST_KEY = 'agent06.guessing.best';
  const LS_BEST_DAILY_KEY = 'agent06.guessing.best.daily';
  const LS_MODE_KEY = 'agent06.guessing.mode';

  const $status = document.getElementById('game-status');
  const $form = document.getElementById('guess-form');
  const $input = document.getElementById('guess-input');
  const $submit = document.getElementById('guess-submit');
  const $newBtn = document.getElementById('guess-new');
  const $feedback = document.getElementById('guess-feedback');
  const $left = document.getElementById('guesses-left');
  const $range = document.getElementById('range-narrow');
  const $history = document.getElementById('guess-history');
  const $best = document.getElementById('best-score');
  const $modeRadios = document.querySelectorAll('input[name="guess-mode"]');

  let currentSID = null;
  let currentMode = 'random'; // "random" or "daily"
  let rangeLo = 1;
  let rangeHi = 100;

  function setFeedback(msg, kind) {
    if (!$feedback) return;
    $feedback.textContent = msg || '';
    $feedback.dataset.kind = kind || 'info';
  }

  function setStatus(msg) {
    if (!$status) return;
    $status.textContent = msg || '';
  }

  function readBest() {
    try {
      const raw = localStorage.getItem(LS_BEST_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  function writeBest(v) {
    try {
      localStorage.setItem(LS_BEST_KEY, JSON.stringify(v));
    } catch (e) {
      /* quota; ignore — best-score is nice-to-have, not essential */
    }
  }

  function renderBest() {
    const b = readBest();
    if (!$best) return;
    if (!b) {
      $best.textContent = '—';
    } else if (b.outcome === 'won') {
      $best.textContent = `${b.guesses_used} of 7`;
    } else if (b.outcome === 'lost') {
      $best.textContent = 'lost';
    } else {
      $best.textContent = '—';
    }
  }

  // The best score is tracked per mode — daily games don't pollute the
  // random best, and vice versa. Two localStorage keys, two records.
  function recordKey() {
    return currentMode === 'daily' ? LS_BEST_DAILY_KEY : LS_BEST_KEY;
  }

  function recordOutcome(state) {
    const key = recordKey();
    let cur;
    try {
      const raw = localStorage.getItem(key);
      cur = raw ? JSON.parse(raw) : null;
      if (!cur || typeof cur !== 'object') cur = null;
    } catch (e) {
      cur = null;
    }
    cur = cur || {};
    if (state.status === 'won') {
      const prev = cur.outcome === 'won' ? (cur.guesses_used || 99) : 99;
      if (state.guesses_used < prev) {
        cur = { outcome: 'won', guesses_used: state.guesses_used, at: Date.now() };
      }
    } else if (state.status === 'lost') {
      if (cur.outcome !== 'won') {
        cur = { outcome: 'lost', at: Date.now() };
      }
    } else {
      return;  // don't clobber with abandon / etc.
    }
    try { localStorage.setItem(key, JSON.stringify(cur)); } catch (e) {}
    renderBest();
  }

  function renderRange() {
    if ($range) $range.textContent = `[${rangeLo}, ${rangeHi}]`;
  }

  function renderHistory(history) {
    if (!$history) return;
    if (!history || history.length === 0) {
      $history.innerHTML = '<li class="muted">no guesses yet — pick a number to begin.</li>';
      return;
    }
    const html = history.map(function (row) {
      const g = row[0];
      const hint = row[1];
      let cls = 'muted';
      let text = hint;
      if (hint === 'higher') { cls = 'hint-higher'; text = '↑ higher'; }
      else if (hint === 'lower') { cls = 'hint-lower'; text = '↓ lower'; }
      else if (hint === 'correct') { cls = 'hint-correct'; text = '✓ correct'; }
      return `<li><span class="mono guess-num">${g}</span> <span class="${cls} small">${text}</span></li>`;
    }).join('');
    $history.innerHTML = html;
  }

  function updateAfterState(state) {
    if (!$left) return;
    const left = Math.max(0, state.guesses_left);
    $left.textContent = String(left);
    // Recompute the inferred range from the history. The server gives us
    // the answers honestly, so we can derive [lo, hi] exactly. The
    // "initial" range comes from `state.range`.
    let lo = state.range ? state.range[0] : 1;
    let hi = state.range ? state.range[1] : 100;
    for (const row of state.history || []) {
      const g = row[0];
      const hint = row[1];
      if (hint === 'higher') lo = Math.max(lo, g + 1);
      else if (hint === 'lower') hi = Math.min(hi, g - 1);
      else if (hint === 'correct') { lo = g; hi = g; }
    }
    rangeLo = lo;
    rangeHi = hi;
    renderRange();
    renderHistory(state.history || []);
    setFormEnabled(state.status === 'active');
  }

  function setFormEnabled(enabled) {
    if ($input) $input.disabled = !enabled;
    if ($submit) $submit.disabled = !enabled;
    if ($newBtn) $newBtn.disabled = false;  // always allowed
  }

  // (recordOutcome is defined earlier — see the version that picks the
  // localStorage key based on currentMode.)

  async function newGame() {
    setStatus('starting a new game…');
    setFeedback('');
    rangeLo = 1;
    rangeHi = 100;
    renderRange();
    renderHistory([]);
    if ($left) $left.textContent = '—';
    // Pick up the current mode selector and tell the server.
    const mode = currentMode === 'daily' ? 'daily' : '';
    try {
      const resp = await fetch('/api/guessing?mode=' + encodeURIComponent(mode), { method: 'POST' });
      const data = await resp.json();
      if (!data || !data.session) {
        setStatus('failed to start a game.');
        setFormEnabled(false);
        return;
      }
      currentSID = data.session;
      currentMode = data.mode === 'daily' ? 'daily' : 'random';
      try {
        localStorage.setItem(LS_SID_KEY, currentSID);
        localStorage.setItem(LS_MODE_KEY, currentMode);
      } catch (e) {}
      updateAfterState(data);
      const lo = data.range[0];
      const hi = data.range[1];
      const modeLabel = currentMode === 'daily'
        ? `daily game · ${data.day_key || ''}`.trim()
        : 'new game';
      setStatus(`${modeLabel} · ${data.budget} guesses · secret is in [${lo}, ${hi}].`);
      if ($input) {
        $input.min = String(lo);
        $input.max = String(hi);
        $input.value = '';
        $input.focus();
      }
      renderBest();
    } catch (e) {
      setStatus('network error — try again.');
    }
  }

  async function resumeGame(sid) {
    try {
      const resp = await fetch('/api/guessing/' + encodeURIComponent(sid));
      const data = await resp.json();
      if (!data || data.ok === false) {
        // Session is gone — start a new one in the mode the user
        // last picked.
        currentMode = readModePref() || 'random';
        return newGame();
      }
      currentSID = data.session;
      currentMode = data.mode === 'daily' ? 'daily' : 'random';
      // Keep the UI selector in sync.
      syncModeRadios(currentMode);
      updateAfterState(data);
      const status = data.status || 'active';
      const modeLabel = currentMode === 'daily'
        ? `daily (${data.day_key || ''})`.trim()
        : 'resumed';
      if (status === 'active') {
        setStatus(`${modeLabel} · ${data.guesses_left} guesses left.`);
        if ($input) $input.focus();
      } else if (status === 'won') {
        setStatus(`${modeLabel} · you already won this game (${data.guesses_used} of ${data.budget}). start a new game any time.`);
      } else if (status === 'lost') {
        setStatus(`${modeLabel} · you already lost this game (${data.guesses_used} of ${data.budget}). start a new game any time.`);
      } else {
        setStatus(`${modeLabel} · game status: ${status}.`);
      }
      renderBest();
    } catch (e) {
      // Network error — fall back to a new game.
      currentMode = readModePref() || 'random';
      newGame();
    }
  }

  function readModePref() {
    try {
      const v = (localStorage.getItem(LS_MODE_KEY) || '').toLowerCase();
      return v === 'daily' ? 'daily' : 'random';
    } catch (e) { return 'random'; }
  }

  function syncModeRadios(mode) {
    if (!$modeRadios || !$modeRadios.length) return;
    for (const r of $modeRadios) {
      r.checked = (r.value === mode);
    }
  }

  function onModeChange(ev) {
    const v = ev && ev.target ? ev.target.value : '';
    const next = v === 'daily' ? 'daily' : 'random';
    if (next === currentMode) return;
    // Mode change is a fresh game — wipe the active SID and start one.
    currentSID = null;
    try { localStorage.removeItem(LS_SID_KEY); } catch (e) {}
    try { localStorage.setItem(LS_MODE_KEY, next); } catch (e) {}
    currentMode = next;
    newGame();
  }

  async function submitGuess(ev) {
    ev.preventDefault();
    if (!currentSID) return;
    const raw = ($input && $input.value || '').toString().trim();
    if (!raw) {
      setFeedback('enter a number first.', 'err');
      if ($input) $input.focus();
      return;
    }
    const guess = Number(raw);
    if (!Number.isFinite(guess) || !Number.isInteger(guess)) {
      setFeedback('guess must be an integer.', 'err');
      return;
    }
    try {
      const resp = await fetch('/api/guessing/' + encodeURIComponent(currentSID) + '/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess: guess })
      });
      const data = await resp.json();
      if (!data || data.ok === false) {
        setFeedback(data && data.error ? data.error : 'guess rejected.', 'err');
        return;
      }
      updateAfterState(data);
      switch (data.outcome) {
        case 'higher':
          setFeedback(`↑ ${guess} — secret is higher.`, 'info');
          break;
        case 'lower':
          setFeedback(`↓ ${guess} — secret is lower.`, 'info');
          break;
        case 'correct':
          setFeedback(`✓ ${guess} — correct! won in ${data.guesses_used}.`, 'ok');
          setStatus(`you won · ${data.guesses_used} of ${data.budget} guesses used. the secret was ${data.secret}.`);
          recordOutcome(data);
          try { localStorage.removeItem(LS_SID_KEY); } catch (e) {}
          currentSID = null;
          if ($input) $input.value = '';
          return;
        case 'out':
          setFeedback(`✗ out of guesses · secret was ${data.secret}.`, 'err');
          setStatus(`lost · secret was ${data.secret}. start a new game any time.`);
          recordOutcome(data);
          try { localStorage.removeItem(LS_SID_KEY); } catch (e) {}
          currentSID = null;
          if ($input) $input.value = '';
          return;
        case 'repeat':
          setFeedback(`you already tried ${guess}.`, 'info');
          break;
        case 'done':
          setFeedback(`game already finished (${data.status}).`, 'info');
          setFormEnabled(false);
          return;
      }
      if ($input) { $input.value = ''; $input.focus(); }
    } catch (e) {
      setFeedback('network error — try again.', 'err');
    }
  }

  function wireUI() {
    if ($form) $form.addEventListener('submit', submitGuess);
    if ($newBtn) $newBtn.addEventListener('click', newGame);
    if ($modeRadios && $modeRadios.length) {
      // Reflect any stored preference in the UI before we resume.
      syncModeRadios(readModePref());
      for (const r of $modeRadios) {
        r.addEventListener('change', onModeChange);
      }
    }
    renderRange();
    renderBest();
  }

  wireUI();

  // Populate the "today's puzzle" badge from /api/guessing/daily.
  // The endpoint deliberately omits the secret — all we get is the
  // day_key, range, budget, and the seconds remaining until the
  // UTC rollover. Silent on network failure: the badge stays hidden
  // and the game keeps working.
  const $dailyBadge = document.getElementById('daily-badge');
  const $dailyKey = document.getElementById('daily-day-key');
  const $dailyRange = document.getElementById('daily-range');
  const $dailyBudget = document.getElementById('daily-budget');
  const $dailyRollover = document.getElementById('rollover-guessing');
  if ($dailyBadge && $dailyKey && $dailyRange && $dailyBudget) {
    fetch('/api/guessing/daily', { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.ok || !info.day_key) return;
        $dailyKey.textContent = info.day_key;
        if (Array.isArray(info.range) && info.range.length === 2) {
          $dailyRange.textContent = info.range[0] + '..' + info.range[1];
        } else {
          $dailyRange.textContent = '—';
        }
        $dailyBudget.textContent = (info.budget != null) ? String(info.budget) : '—';
        // Hand the rollover anchor to the global rollover.js ticker so
        // the chip starts ticking immediately. rollover.js picks up any
        // element with class `rollover-chip` on DOMContentLoaded, but
        // the chip's data attrs here are populated AFTER that — so we
        // dispatch a `rollover:update` event to restart the ticker
        // with the new anchor.
        if ($dailyRollover && typeof info.seconds_until_rollover === 'number') {
          $dailyRollover.setAttribute('data-seconds', String(info.seconds_until_rollover));
          $dailyRollover.setAttribute('data-rollover-at', info.rollover_at_iso || '');
          document.dispatchEvent(new CustomEvent('rollover:update', { detail: { chip: $dailyRollover } }));
        }
        $dailyBadge.hidden = false;
      })
      .catch(function () {
        /* silent — the badge is decoration, not a dependency */
      });
  }

  // Try to resume from localStorage; fall back to a new game.
  // We pick the mode from the stored preference first; if there's a
  // saved SID the resumed state response will overwrite it with the
  // authoritative server-side mode.
  currentMode = readModePref() || 'random';
  syncModeRadios(currentMode);
  let savedSID = null;
  try {
    savedSID = localStorage.getItem(LS_SID_KEY) || null;
  } catch (e) {
    savedSID = null;
  }
  if (savedSID && /^[0-9a-f]{32}$/.test(savedSID)) {
    resumeGame(savedSID);
  } else {
    newGame();
  }
})();
