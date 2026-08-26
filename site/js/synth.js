// Euclidean step sequencer in the browser.
//
// Four voices — kick (sine), hat (filtered noise), bass (square + low-pass),
// lead (triangle) — share a 16-step grid. Each voice has its own
// (hits, steps) pair, and Bjorklund's algorithm distributes the hits
// across the steps as evenly as possible. Click play, hear the pattern,
// click any cell to toggle it on or off.
//
// State encoded in URL hash as
//   #kickHits:kickSteps,hatHits:hatSteps,bassHits:bassSteps,leadHits:leadSteps,bpm,scale,root,vol
// so any combination reproduces itself as a shareable link. All 8 parts
// are comma-separated; the first 4 contain colon-separated hits:steps pairs.
//
// All scheduling happens in the page; no server endpoint, no JSON log,
// no lock. Web Audio scheduling uses the standard "lookahead" pattern:
// setInterval wakes up every 25ms, schedules any notes that fall in
// the next 100ms window. setInterval timing is jittery but scheduling
// ahead is precise, so the audio is sample-accurate.

(function () {
  'use strict';

  // ----- Config ----------------------------------------------------------

  const STEPS = 16;
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD_S = 0.1;

  // Each track: name, default hits, default steps, default MIDI note
  // (relative to scale root for melodic voices).
  const TRACKS = [
    { id: 'kick', label: 'Kick', kind: 'kick',  defaultHits: 4, defaultSteps: 16, sound: 'kick'  },
    { id: 'hat',  label: 'Hat',  kind: 'hat',   defaultHits: 8, defaultSteps: 16, sound: 'hat'   },
    { id: 'bass', label: 'Bass', kind: 'bass',  defaultHits: 4, defaultSteps: 16, sound: 'bass', noteOffset: 0 },
    { id: 'lead', label: 'Lead', kind: 'lead',  defaultHits: 5, defaultSteps: 16, sound: 'lead', noteOffset: 12 },
  ];

  // Scales in semitones from root.
  const SCALES = {
    major:      [0, 2, 4, 5, 7, 9, 11, 12],
    minor:      [0, 2, 3, 5, 7, 8, 10, 12],
    pentatonic: [0, 3, 5, 7, 10, 12],
    dorian:     [0, 2, 3, 5, 7, 9, 10, 12],
    phrygian:   [0, 1, 3, 5, 7, 8, 10, 12],
  };

  // ----- DOM -------------------------------------------------------------

  const tracksEl = document.getElementById('sy-tracks');
  const playBtn = document.getElementById('sy-play');
  const stopBtn = document.getElementById('sy-stop');
  const bpmInput = document.getElementById('sy-bpm');
  const scaleSelect = document.getElementById('sy-scale');
  const rootSelect = document.getElementById('sy-root');
  const volInput = document.getElementById('sy-vol');
  const copyBtn = document.getElementById('sy-copy');
  const status = document.getElementById('sy-status');
  const presetButtons = document.querySelectorAll('.synth-preset-btn');

  // ----- State -----------------------------------------------------------

  // pattern[trackIndex] = Uint8Array(STEPS), 0 or 1.
  // hits[trackIndex]    = number of hits, 0..STEPS
  // steps[trackIndex]   = number of steps, 1..STEPS (default 16)
  const pattern = TRACKS.map(t => new Uint8Array(STEPS));
  const hits = TRACKS.map(t => t.defaultHits);
  const steps = TRACKS.map(t => t.defaultSteps);
  let bpm = 112;
  let scaleName = 'major';
  let rootMidi = 48;
  let vol = 0.6;
  let playing = false;
  let currentStep = 0;
  let nextStepTime = 0;
  let timerHandle = null;
  let audioCtx = null;
  let masterGain = null;

  // ----- Bjorklund's algorithm -------------------------------------------
  //
  // Given (n, k) where n = number of hits, k = number of steps, return
  // an array of n 1s and (k-n) 0s where the 1s are distributed as
  // evenly as possible. The recursive structure (Toussaint 2005,
  // "The Euclidean Algorithm Generates Traditional Musical Rhythms"):
  //
  //   1. Pair up n [1, 0] pairs (so each hit is followed by at least one
  //      zero). If 2n == k, that's the whole pattern.
  //   2. Otherwise we have (k - 2n) "extra zeros" left over. Distribute
  //      them by treating each [1, 0] pair and each extra zero as a slot
  //      in a smaller recursive instance.
  //   3. If the hits outnumber k/2, invert the result of distributing
  //      (k - n) zeros among k slots.
  //
  // The output is one valid Euclidean rotation. The canonical
  // Bjorklund rotation starts with the longest gap; ours starts at the
  // first hit. Both sound identical after the first bar.
  function bjorklund(n, k) {
    if (n <= 0) return new Array(k).fill(0);
    if (n >= k) return new Array(k).fill(1);
    // Pair up n [1, 0] pairs and (k - 2n) extra zeros. The recursion
    // distributes the extras among the pairs.
    const extras = k - 2 * n;
    if (extras === 0) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(1, 0);
      return out;
    }
    if (extras < 0) {
      // n > k/2: invert.
      const complement = bjorklund(k - n, k);
      return complement.map(x => 1 - x);
    }
    // extras > 0. We have n pairs and `extras` extras, total (n + extras)
    // groups. The recursion distributes `extras` "1"s (representing extra
    // zeros) among the (n + extras) groups.
    const recurse = bjorklund(extras, n + extras);
    const out = [];
    for (const x of recurse) {
      if (x === 1) {
        out.push(0);
      } else {
        out.push(1, 0);
      }
    }
    return out;
  }

  // Fill pattern[i] from hits[i] and steps[i] using Bjorklund.
  function rebuildPattern(i) {
    const n = hits[i];
    const k = steps[i];
    const seq = bjorklund(n, k);
    // seq has length k. We have STEPS total positions. Map k positions
    // across STEPS positions: if k == STEPS, exact; if k < STEPS, scale
    // by repeating each Bjorklund hit across STEPS/k positions. We use
    // floor((STEPS - 1) / k) as the chunk size for full hits and put
    // the leftover into the last "step".
    pattern[i].fill(0);
    if (k === STEPS) {
      for (let j = 0; j < STEPS; j++) pattern[i][j] = seq[j];
    } else {
      // Pattern is shorter than the loop. Stretch it to fit.
      // step j of the pattern maps to position floor(j * STEPS / k).
      for (let j = 0; j < k; j++) {
        if (seq[j]) {
          const pos = Math.floor(j * STEPS / k);
          pattern[i][pos] = 1;
        }
      }
    }
  }

  // ----- UI --------------------------------------------------------------

  function buildTracks() {
    tracksEl.innerHTML = '';
    TRACKS.forEach((track, i) => {
      const row = document.createElement('div');
      row.className = 'synth-track';

      const label = document.createElement('div');
      label.className = 'synth-track-label';
      label.textContent = track.label;
      row.appendChild(label);

      // hits:steps selector
      const hs = document.createElement('div');
      hs.className = 'synth-track-hits';
      const hitsIn = document.createElement('input');
      hitsIn.type = 'number';
      hitsIn.min = '0';
      hitsIn.max = String(STEPS);
      hitsIn.value = String(track.defaultHits);
      hitsIn.style.cssText = 'width:3rem;text-align:right;margin-right:0.2rem;';
      const slash = document.createElement('span');
      slash.textContent = '/';
      const stepsIn = document.createElement('input');
      stepsIn.type = 'number';
      stepsIn.min = '1';
      stepsIn.max = String(STEPS);
      stepsIn.value = String(track.defaultSteps);
      stepsIn.style.cssText = 'width:3rem;text-align:left;margin-left:0.2rem;';
      hs.appendChild(hitsIn);
      hs.appendChild(slash);
      hs.appendChild(stepsIn);
      row.appendChild(hs);

      // 16-step grid
      const grid = document.createElement('div');
      grid.className = 'synth-track-pattern';
      grid.dataset.trackIdx = String(i);
      for (let s = 0; s < STEPS; s++) {
        const cell = document.createElement('button');
        cell.className = 'synth-step';
        cell.dataset.step = String(s);
        cell.setAttribute('aria-label', `${track.label} step ${s + 1}`);
        cell.addEventListener('click', () => {
          // Manual toggle — and we update hits count too.
          const wasOn = pattern[i][s] === 1;
          pattern[i][s] = wasOn ? 0 : 1;
          // Recompute hits count.
          let h = 0;
          for (let j = 0; j < STEPS; j++) if (pattern[i][j]) h++;
          hits[i] = h;
          hitsIn.value = String(h);
          renderTrack(i);
          writeHash();
        });
        grid.appendChild(cell);
      }
      row.appendChild(grid);

      // Meta (Euclidean pattern text)
      const meta = document.createElement('div');
      meta.className = 'synth-track-meta';
      meta.textContent = '';
      row.appendChild(meta);

      tracksEl.appendChild(row);

      // Wire up hits/steps inputs.
      hitsIn.addEventListener('change', () => {
        const v = parseInt(hitsIn.value, 10);
        if (Number.isNaN(v)) { hitsIn.value = String(hits[i]); return; }
        hits[i] = Math.max(0, Math.min(steps[i], v | 0));
        if (hits[i] !== v) hitsIn.value = String(hits[i]);
        rebuildPattern(i);
        renderTrack(i);
        writeHash();
      });
      stepsIn.addEventListener('change', () => {
        const v = parseInt(stepsIn.value, 10);
        if (Number.isNaN(v)) { stepsIn.value = String(steps[i]); return; }
        steps[i] = Math.max(1, Math.min(STEPS, v | 0));
        if (steps[i] !== v) stepsIn.value = String(steps[i]);
        if (hits[i] > steps[i]) {
          hits[i] = steps[i];
          hitsIn.value = String(hits[i]);
        }
        rebuildPattern(i);
        renderTrack(i);
        writeHash();
      });
    });
  }

  function renderTrack(i) {
    const cells = tracksEl.querySelectorAll(
      `.synth-track-pattern[data-track-idx="${i}"] .synth-step`
    );
    cells.forEach((cell, j) => {
      if (pattern[i][j]) cell.classList.add('is-on');
      else cell.classList.remove('is-on');
    });
    const meta = tracksEl.children[i].querySelector('.synth-track-meta');
    meta.textContent = `${hits[i]}/${steps[i]}`;
  }

  function renderAll() {
    TRACKS.forEach((_, i) => renderTrack(i));
  }

  function highlightStep(s) {
    // Clear previous highlights
    tracksEl.querySelectorAll('.synth-step.is-playing').forEach(el =>
      el.classList.remove('is-playing')
    );
    if (s === -1) return;
    TRACKS.forEach((_, i) => {
      const cell = tracksEl.querySelector(
        `.synth-track-pattern[data-track-idx="${i}"] .synth-step[data-step="${s}"]`
      );
      if (cell) cell.classList.add('is-playing');
    });
  }

  // ----- Audio -----------------------------------------------------------

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = vol;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  }

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  // Kick: pitched sine sweep down, short envelope.
  function playKick(time) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(1.0, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    osc.connect(gain).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  // Hat: white noise, high-passed, very short envelope.
  function playHat(time) {
    const noiseBuf = audioCtx.createBuffer(1, 0.05 * audioCtx.sampleRate, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.35, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    src.connect(hp).connect(gain).connect(masterGain);
    src.start(time);
  }

  // Bass: square wave, low-pass filter, ~250ms envelope.
  function playBass(time, midi) {
    const f = midiToFreq(midi);
    const osc = audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = f;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.5, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    osc.connect(lp).connect(gain).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.2);
  }

  // Lead: triangle wave, mid-pass filter, longer envelope.
  function playLead(time, midi) {
    const f = midiToFreq(midi);
    const osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.32, time + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
    osc.connect(lp).connect(gain).connect(masterGain);
    osc.start(time);
    osc.stop(time + 0.25);
  }

  // Pick a melodic note for this step from the scale. We use a fixed
  // melody pattern based on the step index — pentatonic friendly, walks
  // up by 1-3 scale degrees.
  function pickMelodicNote(step) {
    const scale = SCALES[scaleName] || SCALES.major;
    // Map step 0..15 to a scale degree. Even steps take low notes,
    // odd steps take a higher octave.
    const deg = [0, 2, 4, 2, 0, 4, 5, 4, 2, 0, 3, 4, 5, 4, 2, 0][step] || 0;
    const octShift = (step % 8) >= 4 ? 12 : 0;
    return rootMidi + scale[deg % scale.length] + octShift;
  }

  // Pick a bass note — root or fifth based on the bar position.
  function pickBassNote(step) {
    const scale = SCALES[scaleName] || SCALES.major;
    const deg = step % 8 < 4 ? 0 : 4;
    return rootMidi - 12 + scale[deg % scale.length];
  }

  // ----- Scheduler -------------------------------------------------------

  function schedulerTick() {
    if (!playing || !audioCtx) return;
    while (nextStepTime < audioCtx.currentTime + SCHEDULE_AHEAD_S) {
      scheduleNote(currentStep, nextStepTime);
      advance();
    }
  }

  function scheduleNote(step, time) {
    // kick
    if (pattern[0][step]) playKick(time);
    // hat
    if (pattern[1][step]) playHat(time);
    // bass
    if (pattern[2][step]) playBass(time, pickBassNote(step));
    // lead
    if (pattern[3][step]) playLead(time, pickMelodicNote(step));
    // Visual highlight scheduled slightly early so the UI feels in sync.
    const s = step;
    const delayMs = Math.max(0, (time - audioCtx.currentTime) * 1000);
    setTimeout(() => {
      // Only update if this is still the current step by the time the
      // timer fires (don't update if the user paused or seeked).
      if (playing) highlightStep(s);
    }, delayMs);
  }

  function advance() {
    // sixteenth note duration = 60 / bpm / 4 seconds
    const secPerStep = 60.0 / bpm / 4.0;
    nextStepTime += secPerStep;
    currentStep = (currentStep + 1) % STEPS;
    if (currentStep === 0) {
      // Bar marker.
      status.textContent =
        `playing · bpm ${bpm} · ${scaleName} · bar ${Math.floor(audioCtx.currentTime / (60.0 / bpm * 4)) + 1}`;
    }
  }

  function startPlaying() {
    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (playing) return;
    playing = true;
    currentStep = 0;
    nextStepTime = audioCtx.currentTime + 0.06;
    playBtn.textContent = 'Pause';
    playBtn.classList.remove('is-primary');
    timerHandle = setInterval(schedulerTick, LOOKAHEAD_MS);
    status.textContent =
      `playing · bpm ${bpm} · ${scaleName} · start`;
    // Run the scheduler once immediately so the first step is scheduled.
    schedulerTick();
  }

  function stopPlaying() {
    if (!playing) return;
    playing = false;
    if (timerHandle !== null) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    highlightStep(-1);
    playBtn.textContent = 'Play';
    playBtn.classList.add('is-primary');
    status.textContent = 'stopped';
  }

  // ----- URL hash --------------------------------------------------------

  function encodeState() {
    const parts = [];
    for (let i = 0; i < TRACKS.length; i++) {
      parts.push(`${hits[i]}:${steps[i]}`);
    }
    parts.push(String(bpm));
    parts.push(scaleName);
    parts.push(String(rootMidi));
    parts.push(String(Math.round(vol * 100)));
    return '#' + parts.join(',');
  }

  function decodeState(hash) {
    if (!hash || hash.length < 2) return false;
    const body = hash[0] === '#' ? hash.slice(1) : hash;
    const parts = body.split(',');
    if (parts.length < TRACKS.length + 4) return false;
    for (let i = 0; i < TRACKS.length; i++) {
      const [h, s] = parts[i].split(':').map(n => parseInt(n, 10));
      if (Number.isNaN(h) || Number.isNaN(s)) return false;
      hits[i] = Math.max(0, Math.min(STEPS, h));
      steps[i] = Math.max(1, Math.min(STEPS, s));
      rebuildPattern(i);
    }
    const bpmV = parseInt(parts[TRACKS.length], 10);
    const scaleV = parts[TRACKS.length + 1];
    const rootV = parseInt(parts[TRACKS.length + 2], 10);
    const volV = parseInt(parts[TRACKS.length + 3], 10);
    if (!Number.isNaN(bpmV)) bpm = Math.max(40, Math.min(240, bpmV));
    if (SCALES[scaleV]) scaleName = scaleV;
    if (!Number.isNaN(rootV)) rootMidi = Math.max(36, Math.min(84, rootV));
    if (!Number.isNaN(volV)) vol = Math.max(0, Math.min(1, volV / 100));
    return true;
  }

  let hashWriteTimer = null;
  function writeHash() {
    // Throttle so dragging a slider doesn't spam history.replaceState.
    if (hashWriteTimer !== null) return;
    hashWriteTimer = setTimeout(() => {
      hashWriteTimer = null;
      const h = encodeState();
      if (window.location.hash !== h) {
        window.history.replaceState(null, '', window.location.pathname + h);
      }
    }, 80);
  }

  // ----- Wiring ----------------------------------------------------------

  function syncControls() {
    bpmInput.value = String(bpm);
    scaleSelect.value = scaleName;
    rootSelect.value = String(rootMidi);
    volInput.value = String(Math.round(vol * 100));
    TRACKS.forEach((t, i) => {
      const inputs = tracksEl.children[i].querySelectorAll('input');
      inputs[0].value = String(hits[i]);
      inputs[1].value = String(steps[i]);
    });
  }

  // Presets — each preset sets hits/steps for all four tracks.
  const PRESETS = {
    rock:        [[4, 16], [8, 16], [3, 16], [4, 16]],
    tresillo:    [[3, 8],  [3, 8],  [3, 8],  [3, 8]],
    cinquillo:   [[5, 8],  [5, 8],  [5, 8],  [5, 8]],
    samba:       [[4, 16], [6, 16], [3, 16], [5, 16]],
    bossanova:   [[3, 16], [5, 16], [2, 16], [4, 16]],
    rumba:       [[4, 16], [5, 16], [3, 16], [5, 16]],
    aksak:       [[3, 8],  [4, 8],  [3, 8],  [5, 16]],
    random:      null, // computed at click time
  };

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    for (let i = 0; i < TRACKS.length; i++) {
      let [h, s] = p[i];
      if (name === 'random') {
        h = 2 + Math.floor(Math.random() * (s - 1));
      }
      hits[i] = Math.max(0, Math.min(s, h));
      steps[i] = Math.max(1, Math.min(STEPS, s));
      rebuildPattern(i);
    }
    renderAll();
    syncControls();
    writeHash();
  }

  // ----- Init ------------------------------------------------------------

  function init() {
    buildTracks();
    if (!decodeState(window.location.hash)) {
      // Use defaults from TRACKS
      for (let i = 0; i < TRACKS.length; i++) {
        hits[i] = TRACKS[i].defaultHits;
        steps[i] = TRACKS[i].defaultSteps;
        rebuildPattern(i);
      }
    }
    syncControls();
    renderAll();

    playBtn.addEventListener('click', () => {
      if (playing) stopPlaying(); else startPlaying();
    });
    stopBtn.addEventListener('click', stopPlaying);

    bpmInput.addEventListener('input', () => {
      const v = parseInt(bpmInput.value, 10);
      if (!Number.isNaN(v) && v >= 40 && v <= 240) {
        bpm = v;
        writeHash();
      }
    });
    scaleSelect.addEventListener('change', () => {
      scaleName = scaleSelect.value;
      writeHash();
    });
    rootSelect.addEventListener('change', () => {
      rootMidi = parseInt(rootSelect.value, 10);
      writeHash();
    });
    volInput.addEventListener('input', () => {
      const v = parseInt(volInput.value, 10);
      vol = Math.max(0, Math.min(1, v / 100));
      if (masterGain) masterGain.gain.value = vol;
      writeHash();
    });

    copyBtn.addEventListener('click', () => {
      const url = window.location.href.split('#')[0] + encodeState();
      navigator.clipboard.writeText(url).then(() => {
        const old = copyBtn.textContent;
        copyBtn.textContent = 'copied!';
        setTimeout(() => { copyBtn.textContent = old; }, 1200);
      }).catch(() => {
        // Fallback: select-and-copy via a temp textarea
        const ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
        const old = copyBtn.textContent;
        copyBtn.textContent = 'copied!';
        setTimeout(() => { copyBtn.textContent = old; }, 1200);
      });
    });

    presetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        applyPreset(btn.dataset.preset);
        if (!playing) startPlaying();
      });
    });

    // Re-decode on hash change so external links work (e.g. back button).
    window.addEventListener('hashchange', () => {
      if (decodeState(window.location.hash)) {
        syncControls();
        renderAll();
      }
    });

    status.textContent =
      `ready · ${STEPS} steps · 4 voices · click play`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
