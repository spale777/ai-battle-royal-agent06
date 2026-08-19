// agent-06 — Guessing (1..100, 7 guesses)
//
// Server contract:
//   POST /api/guessing                           -> start a game
//       returns { ok, session, range, budget, guesses_left, history, status, created }
//   GET  /api/guessing/<sid>                     -> read state (no secret on active)
//       returns { ok, session, range, budget, guesses_used, guesses_left, history, status }
//   POST /api/guessing/<sid>/guess               -> {guess: int}
//       returns { ok, session, outcome, guess, guesses_used, guesses_left, history, status,
//                 range, budget, secret? }
//       outcome in {"higher","lower","correct","out","repeat","done"}
//   POST /api/guessing/<sid>/abandon             -> mark abandoned, secret revealed
//
// The session id is kept in localStorage so a page reload keeps the
// same game. Each game records the player's best outcome in
// localStorage too: fewest guesses to win, or "lost" if all seven
// were used without finding it.

(function () {
  'use strict';

  const LS_SID_KEY = 'agent06.guessing.session';
  const LS_BEST_KEY = 'agent06.guessing.best';

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

  let currentSID = null;
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

  function recordOutcome(state) {
    const cur = readBest() || {};
    // Only update best when we beat our previous record.
    if (state.status === 'won') {
      const prev = cur.outcome === 'won' ? (cur.guesses_used || 99) : 99;
      if (state.guesses_used < prev) {
        writeBest({ outcome: 'won', guesses_used: state.guesses_used, at: Date.now() });
      }
    } else if (state.status === 'lost') {
      if (cur.outcome !== 'won') {
        // Only record a loss as "best" if we never won — otherwise the
        // win record stands.
        writeBest({ outcome: 'lost', at: Date.now() });
      }
    }
    renderBest();
  }

  async function newGame() {
    setStatus('starting a new game…');
    setFeedback('');
    rangeLo = 1;
    rangeHi = 100;
    renderRange();
    renderHistory([]);
    if ($left) $left.textContent = '—';
    try {
      const resp = await fetch('/api/guessing', { method: 'POST' });
      const data = await resp.json();
      if (!data || !data.session) {
        setStatus('failed to start a game.');
        setFormEnabled(false);
        return;
      }
      currentSID = data.session;
      try { localStorage.setItem(LS_SID_KEY, currentSID); } catch (e) {}
      updateAfterState(data);
      const lo = data.range[0];
      const hi = data.range[1];
      setStatus(`new game · ${data.budget} guesses · secret is in [${lo}, ${hi}].`);
      if ($input) {
        $input.min = String(lo);
        $input.max = String(hi);
        $input.value = '';
        $input.focus();
      }
    } catch (e) {
      setStatus('network error — try again.');
    }
  }

  async function resumeGame(sid) {
    try {
      const resp = await fetch('/api/guessing/' + encodeURIComponent(sid));
      const data = await resp.json();
      if (!data || data.ok === false) {
        // Session is gone — start a new one.
        return newGame();
      }
      currentSID = data.session;
      updateAfterState(data);
      const status = data.status || 'active';
      if (status === 'active') {
        setStatus(`resumed · ${data.guesses_left} guesses left.`);
        if ($input) $input.focus();
      } else if (status === 'won') {
        setStatus(`you already won this game (${data.guesses_used} of ${data.budget}). start a new game any time.`);
      } else if (status === 'lost') {
        setStatus(`you already lost this game (${data.guesses_used} of ${data.budget}). start a new game any time.`);
      } else {
        setStatus(`resumed · game status: ${status}.`);
      }
    } catch (e) {
      // Network error — fall back to a new game.
      newGame();
    }
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
    renderRange();
    renderBest();
  }

  wireUI();

  // Try to resume from localStorage; fall back to a new game.
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
