// Word clock — a 5-minute-resolution English word clock in the
// Qlocktwo tradition. Renders the current time as words inside an
// 11x10 grid of letters; each cell is either part of a word (lit
// when the word is "active" for the current minute), part of an
// inactive word (always dim), or a dead-letter filler (always dim).
//
//   col:  0 1 2 3 4 5 6 7 8 9 10
//   row0: I T . I S . A M . P M
//   row1: A Q U A R T E R . . .
//   row2: T W E N T Y . F I V E
//   row3: H A L F . T E N . T O
//   row4: P A S T . N I N E . .
//   row5: O N E S I X T H R E E
//   row6: F O U R F I V E T W O
//   row7: E I G H T E L E V E N
//   row8: S E V E N T W E L V E
//   row9: T E N . O C L O C K .
//
// Resolution: 5 minutes for words, 1 minute for the four "minute dots"
// at the bottom-right. Qlocktwo's convention: 4 dots lit when exactly
// on a 5-minute mark (e.g. :00, :05, :10), and one fewer dot for each
// minute past. So :00→4, :01→3, :02→2, :03→1, :04→0, :05→4, :06→3.
// This is the inverse of `minutes % 5` — we want dotsLit = (4 - (m % 5)).
//
// State is encoded in the URL hash as #mode:offsetMin:is24h, so any
// combination reproduces itself as a shareable link. mode ∈
// {auto,utc,local,offset}; offsetMin ∈ [-720, 840] in 15-minute steps;
// is24h ∈ {0,1}.

(function () {
  'use strict';

  // ----- Grid definition -------------------------------------------------

  // Letters in row order; '.' means a dead cell that is never part of any
  // active word. Some non-'.' letters are also "dead" because they belong
  // to a word that just happens not to be the current one — see WORDS.
  const GRID = [
    'IT.IS.AM.PM',
    'AQUARTER...',
    'TWENTY.FIVE',
    'HALF.TEN.TO',
    'PAST.NINE..',
    'ONESIXTHREE',
    'FOURFIVETWO',
    'EIGHTELEVEN',
    'SEVENTWELVE',
    'TEN.OCLOCK.'
  ];
  // Cells are listed left-to-right so the activation simply lights the
  // union of cells for all currently-active words.
  const WORDS = {
    IT:      { cells: [[0,0],[0,1]],         label: 'IT' },
    IS:      { cells: [[0,3],[0,4]],         label: 'IS' },
    AM:      { cells: [[0,6],[0,7]],         label: 'AM' },
    PM:      { cells: [[0,9],[0,10]],        label: 'PM' },
    QUARTER: { cells: [[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7]], label: 'QUARTER' },
    TWENTY:  { cells: [[2,0],[2,1],[2,2],[2,3],[2,4],[2,5]], label: 'TWENTY' },
    FIVE_M:  { cells: [[2,7],[2,8],[2,9],[2,10]], label: 'FIVE' }, // minutes
    HALF:    { cells: [[3,0],[3,1],[3,2],[3,3]], label: 'HALF' },
    TEN_M:   { cells: [[3,5],[3,6],[3,7]],   label: 'TEN' },     // minutes
    TO:      { cells: [[3,9],[3,10]],        label: 'TO' },
    PAST:    { cells: [[4,0],[4,1],[4,2],[4,3]], label: 'PAST' },
    NINE:    { cells: [[4,5],[4,6],[4,7],[4,8]], label: 'NINE' },
    ONE:     { cells: [[5,0],[5,1],[5,2]],   label: 'ONE' },
    SIX:     { cells: [[5,3],[5,4],[5,5]],   label: 'SIX' },
    THREE:   { cells: [[5,6],[5,7],[5,8],[5,9],[5,10]], label: 'THREE' },
    FOUR:    { cells: [[6,0],[6,1],[6,2],[6,3]], label: 'FOUR' },
    FIVE_H:  { cells: [[6,4],[6,5],[6,6],[6,7]], label: 'FIVE' }, // hour (5 o'clock)
    TWO:     { cells: [[6,8],[6,9],[6,10]],  label: 'TWO' },
    EIGHT:   { cells: [[7,0],[7,1],[7,2],[7,3],[7,4]], label: 'EIGHT' },
    ELEVEN:  { cells: [[7,5],[7,6],[7,7],[7,8],[7,9],[7,10]], label: 'ELEVEN' },
    SEVEN:   { cells: [[8,0],[8,1],[8,2],[8,3],[8,4]], label: 'SEVEN' },
    TWELVE:  { cells: [[8,5],[8,6],[8,7],[8,8],[8,9],[8,10]], label: 'TWELVE' },
    TEN_H:   { cells: [[9,0],[9,1],[9,2]],   label: 'TEN' },     // hour (10 o'clock)
    OCLOCK:  { cells: [[9,4],[9,5],[9,6],[9,7],[9,8],[9,9]], label: 'OCLOCK' }
  };

  // "A" — single letter at [1, 0]. Lit whenever minutes != 0.
  const A_CELL = [1, 0];

  // ----- Time-to-words mapping ------------------------------------------

  // Returns { activeWords: Set<string>, showA: bool, isAm: bool,
  // hourLabel: string, minuteLabel: string, dotsLit: int }.
  //
  // dotsLit = 4 - (minutes % 5). At a 5-minute mark (:00, :05, :10,...)
  // all 4 dots are lit. Between marks the count decreases by one per
  // minute. So :04 → 0 dots, :05 → 4, :06 → 3, etc.
  function wordsFor(hour24, minutes) {
    const isAm = hour24 < 12;
    const hour12 = hour24 % 12; // 0..11
    // "A" is only used with QUARTER: "a quarter past" / "a quarter to".
    // FIVE / TEN / TWENTY / HALF all read without "A".
    const fiveMin = Math.floor(minutes / 5) * 5; // 0,5,10,...,55
    const showA = fiveMin === 15 || fiveMin === 45;

    const active = new Set(['IT', 'IS']);
    if (isAm) active.add('AM'); else active.add('PM');

    // Minute word(s)
    let minuteWord;
    let useTo = false; // true => "to next hour"
    let hourForLabel;
    if (fiveMin === 0) {
      // "OCLOCK" — no minute word.
      minuteWord = null;
      hourForLabel = hour12;
      active.add('OCLOCK');
    } else if (fiveMin <= 30) {
      // "past current hour"
      useTo = false;
      hourForLabel = hour12;
      active.add('PAST');
      switch (fiveMin) {
        case 5:  active.add('FIVE_M'); minuteWord = 'FIVE'; break;
        case 10: active.add('TEN_M');  minuteWord = 'TEN'; break;
        case 15: active.add('QUARTER'); minuteWord = 'QUARTER'; break;
        case 20: active.add('TWENTY'); minuteWord = 'TWENTY'; break;
        case 25: active.add('TWENTY'); active.add('FIVE_M'); minuteWord = 'TWENTY FIVE'; break;
        case 30: active.add('HALF'); minuteWord = 'HALF'; break;
      }
    } else {
      // 35, 40, 45, 50, 55 → "to next hour"
      useTo = true;
      hourForLabel = (hour12 + 1) % 12;
      active.add('TO');
      switch (fiveMin) {
        case 35: active.add('TWENTY'); active.add('FIVE_M'); minuteWord = 'TWENTY FIVE'; break;
        case 40: active.add('TWENTY'); minuteWord = 'TWENTY'; break;
        case 45: active.add('QUARTER'); minuteWord = 'QUARTER'; break;
        case 50: active.add('TEN_M');  minuteWord = 'TEN'; break;
        case 55: active.add('FIVE_M'); minuteWord = 'FIVE'; break;
      }
    }

    // Hour word
    switch (hourForLabel) {
      case 0:  active.add('TWELVE'); break;
      case 1:  active.add('ONE'); break;
      case 2:  active.add('TWO'); break;
      case 3:  active.add('THREE'); break;
      case 4:  active.add('FOUR'); break;
      case 5:  active.add('FIVE_H'); break;
      case 6:  active.add('SIX'); break;
      case 7:  active.add('SEVEN'); break;
      case 8:  active.add('EIGHT'); break;
      case 9:  active.add('NINE'); break;
      case 10: active.add('TEN_H'); break;
      case 11: active.add('ELEVEN'); break;
    }

    return {
      activeWords: active,
      showA,
      isAm,
      hourLabel: hourWord(hourForLabel),
      minuteLabel: minuteWord,
      useTo,
      dotsLit: (4 - minutes % 5) // Qlocktwo convention: 4 on the 5-minute mark, 0..3 otherwise
    };
  }

  function hourWord(h12) {
    return ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX',
            'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE'][h12] || 'TWELVE';
  }

  // Build a human-readable sentence from the same data, for the
  // .wordclock-readout line under the grid.
  function readout(state, is24h) {
    const parts = ['IT', 'IS'];
    if (state.showA) parts.push('A');
    if (state.minuteLabel) parts.push(state.minuteLabel);
    if (state.minuteLabel) parts.push(state.useTo ? 'TO' : 'PAST');
    if (is24h) {
      // 24-hour mode: write the 0..23 hour as a number, no AM/PM.
      parts.push(String(state.h));
    } else {
      parts.push(state.hourLabel);
      if (!state.minuteLabel) parts.push('OCLOCK');
      parts.push(state.isAm ? 'AM' : 'PM');
    }
    return parts.join(' ');
  }

  // ----- DOM build -------------------------------------------------------

  const gridEl = document.getElementById('wordclock-grid');
  const dotsEl = document.getElementById('wordclock-dots');
  const readoutEl = document.getElementById('wordclock-readout');
  const modeSel = document.getElementById('wc-mode');
  const offsetWrap = document.getElementById('wc-offset-wrap');
  const offsetIn = document.getElementById('wc-offset');
  const c24 = document.getElementById('wc-24h');

  // Build cells once
  const cellEls = [];
  for (let r = 0; r < GRID.length; r++) {
    for (let c = 0; c < GRID[r].length; c++) {
      const letter = GRID[r][c];
      const div = document.createElement('div');
      div.className = 'wc-cell';
      if (letter === '.') {
        div.classList.add('wc-dead');
        // Use a thin non-breaking space so the cell still takes its
        // grid slot visually. (Some browsers collapse empty grid
        // cells.)
        div.innerHTML = '&nbsp;';
      } else {
        div.textContent = letter;
      }
      gridEl.appendChild(div);
      cellEls.push({ el: div, r, c, letter });
    }
  }

  function applyState(state) {
    // Build a quick (r,c) -> word-name lookup
    const litCell = new Map(); // "r,c" -> wordName
    for (const [name, def] of Object.entries(WORDS)) {
      if (!state.activeWords.has(name)) continue;
      for (const [r, c] of def.cells) {
        litCell.set(r + ',' + c, name);
      }
    }
    if (state.showA) litCell.set(A_CELL[0] + ',' + A_CELL[1], 'A');

    for (const cell of cellEls) {
      const key = cell.r + ',' + cell.c;
      const isLit = litCell.has(key);
      cell.el.classList.toggle('is-lit', isLit);
      cell.el.dataset.word = isLit ? (litCell.get(key) || '') : '';
    }

    // Dots
    const dotEls = dotsEl.querySelectorAll('.wc-dot');
    dotEls.forEach((d, i) => {
      d.classList.toggle('is-on', i < state.dotsLit);
    });

    // Readout
    readoutEl.textContent = readout(state, c24.checked);
  }

  // ----- URL hash sync ---------------------------------------------------

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return null;
    const [mode, offStr, is24] = h.split(':');
    const modeOk = ['auto','utc','local','offset'].includes(mode) ? mode : 'auto';
    let off = parseInt(offStr, 10);
    if (!Number.isFinite(off)) off = 0;
    off = Math.max(-720, Math.min(840, off));
    return { mode: modeOk, offsetMin: off, is24h: is24 === '1' };
  }

  function writeHash() {
    const mode = modeSel.value;
    const off = offsetIn.value;
    const is24 = c24.checked ? '1' : '0';
    // Don't preserve arbitrary other fragments.
    const next = `${mode}:${off}:${is24}`;
    if (location.hash.replace(/^#/, '') !== next) {
      history.replaceState(null, '', '#' + next);
    }
  }

  function syncFromHash() {
    const s = parseHash();
    if (!s) return;
    modeSel.value = s.mode;
    offsetIn.value = s.offsetMin;
    offsetWrap.hidden = s.mode !== 'offset';
    c24.checked = s.is24h;
  }

  // ----- Time computation ------------------------------------------------

  // Returns the wall-clock minutes-since-epoch adjusted by the current
  // mode + offsetMin. The grid then takes (minutes % 1440) / 60 for hour,
  // (minutes % 1440) % 60 for minutes.
  function nowInMode(mode, offsetMin) {
    const now = new Date();
    let base;
    if (mode === 'utc') {
      base = now.getTime() + now.getTimezoneOffset() * 60000;
    } else if (mode === 'local') {
      base = now.getTime();
    } else if (mode === 'offset') {
      base = now.getTime() + offsetMin * 60000;
    } else {
      // auto: local
      base = now.getTime();
    }
    return new Date(base);
  }

  function tick() {
    const mode = modeSel.value;
    const off = parseInt(offsetIn.value, 10) || 0;
    const d = nowInMode(mode, off);
    const h = d.getHours();
    const m = d.getMinutes();
    const s = d.getSeconds();

    const state = wordsFor(h, m);
    state.h = h;
    state.m = m;
    state.s = s;
    state.is24h = c24.checked;
    applyState(state);

    // schedule next tick
    const msToNext = 1000 - (Date.now() % 1000);
    setTimeout(tick, msToNext);
  }

  // ----- Wire up controls ------------------------------------------------

  modeSel.addEventListener('change', () => {
    offsetWrap.hidden = modeSel.value !== 'offset';
    writeHash();
    tick();
  });
  offsetIn.addEventListener('change', () => { writeHash(); tick(); });
  c24.addEventListener('change', () => { writeHash(); tick(); });

  // ----- Boot ------------------------------------------------------------

  syncFromHash();
  writeHash(); // normalize the URL on first load
  tick();
})();