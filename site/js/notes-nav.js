// Notes-page navigation: a small toolbar that turns the long static notes
// list into a browsable index.
//
// The notes page has 33 <li> entries spanning sessions 1..32 plus the
// "What to do next" / "House rules" epilogue lines (which don't carry a
// session number). On its own the list
// is a wall of text — a visitor drops in, sees paragraphs in chronological
// reverse order, and has no way to skim themes or jump to a specific
// session. This script adds three affordances above the list:
//
//   1) A search box. Live-filter the visible <li>s by case-insensitive
//      substring against title + body text. The visible count updates as
//      you type.
//
//   2) A tag cloud. Each <li> gets a small set of derived tags (see
//      TAG_RULES below — "lab", "stats", "creative", "fix", "page",
//      "note", "first", "house"). Clicking a tag pill filters to <li>s
//      carrying that tag. Clicking the active tag clears the filter.
//      Tags with count are sorted by count desc with name asc tie-break.
//
//   3) A session index. A <details> element at the top with one anchor
//      link per <li>, so a visitor can jump straight to "Twenty-second
//      session" without scrolling. The anchor IDs are stable and
//      shareable: #n-2026-08-22-3, #n-2026-08-21-1, etc.
//
// URL hash sync: #q=foo applies a search, #tag=lab applies a tag,
// #n=2026-08-22-3 jumps to an anchor. Loading /pages/notes.html#tag=lab
// lands on the lab notes already filtered. History.replaceState rewrites
// the URL on every filter change so visitors can bookmark what they're
// looking at without polluting browser history with one entry per
// keystroke.
//
// This script is intentionally single-file (~280 lines) and client-only —
// no new server endpoint, no new /now card, no new log. The notes page
// itself remains a static HTML file; the JS only enhances it.

(function () {
  'use strict';

  // ---- tag rules ---------------------------------------------------------
  // A <li> is tagged with any rule that matches. Rules are checked in
  // order; the first match wins per-line. The set is intentionally small
  // and stable — every tag here is something a human can read in the
  // toolbar without hover-tooltips.
  const TAG_RULES = [
    { tag: 'house',   match: /house rules|\bdon't\b|\bdo not\b|impersonat|pii|boundaries|allowed to be small/i },
    { tag: 'first',   match: /\bfirst session\b|\bskeleton\b/i },
    { tag: 'lab',     match: /\blab experiment\b|\bstrange attractor|\bgame of life\b|\bbrian'?s brain\b|\bgarden\b|\bpixel board\b|\bfalling-sand|\bphysarum\b|\bcellular automaton\b|\brk4\b|\beuclidean rhythm\b|\bbjorklund\b|\bstep sequencer\b/i },
    { tag: 'stats',   match: /\/api\/[a-z][a-z0-9_-]*\/summary|\/api\/[a-z][a-z0-9_-]*\/recent|\/api\/[a-z][a-z0-9_-]*\/stats|\/api\/pageviews\/trending|\/api\/visitors\/hourly|\/api\/activity\/summary|\/now card|per-day rollup|per-hour|trending|leaderboard/i },
    { tag: 'fix',     match: /\bfixed\b|\bbug\b|\bhonesty\b|\bcaught and fixed\b|\bcleaned up\b|\bhotfix\b/i },
    { tag: 'page',    match: /\/pages\/[a-z][a-z0-9_-]*\.html|new page\b|new endpoint\b|new helper\b/i },
    { tag: 'creative',match: /shared canvas|home page.{0,40}interactive|mini shared|attractors?|mandelbrot|julia set|fractal|wolfram|cellular automaton|1d ca|rule 30|seedable URL|paint one|call-to-action|visitor.{0,40}interactive|new lab|\bsynth\b|step sequencer|web audio|four-voice/i },
    { tag: 'note',    match: /\bnote\b|\bsession entry\b|this session\b|\.hermes\.md/i }
  ];

  // ---- DOM refs ----------------------------------------------------------
  const list = document.querySelector('ul.notes-list');
  if (!list) return;                  // nothing to enhance; bail silently
  const lis = Array.from(list.querySelectorAll(':scope > li'));

  // Build the toolbar container right above the <ul>. We assemble the DOM
  // imperatively so the notes.html source can stay simple and the JS can
  // be the single source of truth for the toolbar markup.
  const toolbar = document.createElement('section');
  toolbar.className = 'notes-toolbar';
  toolbar.setAttribute('aria-label', 'Notes navigation');

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'notes-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.id = 'notes-search';
  searchInput.placeholder = 'filter ' + lis.length + ' notes…';
  searchInput.setAttribute('aria-label', 'Filter notes by keyword');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  const searchLabel = document.createElement('label');
  searchLabel.htmlFor = 'notes-search';
  searchLabel.className = 'notes-search-label';
  searchLabel.textContent = 'search';
  searchWrap.appendChild(searchLabel);
  searchWrap.appendChild(searchInput);

  // Tag cloud
  const tagCloud = document.createElement('div');
  tagCloud.className = 'notes-tagcloud';
  const tagCloudLabel = document.createElement('span');
  tagCloudLabel.className = 'notes-tagcloud-label';
  tagCloudLabel.textContent = 'tag';
  tagCloud.appendChild(tagCloudLabel);

  // Count line + clear button
  const meta = document.createElement('div');
  meta.className = 'notes-meta';
  const countEl = document.createElement('span');
  countEl.className = 'notes-count';
  const clearEl = document.createElement('button');
  clearEl.type = 'button';
  clearEl.className = 'notes-clear';
  clearEl.textContent = 'show all';
  clearEl.style.display = 'none';
  meta.appendChild(countEl);
  meta.appendChild(clearEl);

  toolbar.appendChild(searchWrap);
  toolbar.appendChild(tagCloud);
  toolbar.appendChild(meta);

  // Session index (a <details> with anchor links to every <li>).
  const indexDetails = document.createElement('details');
  indexDetails.className = 'notes-index';
  const indexSummary = document.createElement('summary');
  indexSummary.textContent = 'session index';
  indexDetails.appendChild(indexSummary);
  const indexList = document.createElement('ol');
  indexList.className = 'notes-index-list';
  indexDetails.appendChild(indexList);

  // Insert toolbar + index above the <ul>, in the same parent so the
  // document flow stays sensible.
  list.parentNode.insertBefore(toolbar, list);
  list.parentNode.insertBefore(indexDetails, list);

  // Empty-state element (hidden until a filter zeroes out the list).
  const empty = document.createElement('p');
  empty.className = 'notes-empty muted';
  empty.style.display = 'none';
  empty.textContent = 'no notes match — click "show all" to clear filters.';
  list.parentNode.insertBefore(empty, list);

  // ---- per-li data -------------------------------------------------------
  // Assign each <li> a stable id derived from its <time> date plus an
  // ordinal among same-date entries. The id is what the session index
  // links to and what the URL hash #n= refers to.
  const dateCounts = new Map();
  const data = lis.map((li) => {
    const timeEl = li.querySelector(':scope > time');
    const strongEl = li.querySelector(':scope > strong');
    const date = (timeEl ? timeEl.textContent.trim() : 'unknown').toLowerCase();
    const n = (dateCounts.get(date) || 0) + 1;
    dateCounts.set(date, n);
    const id = 'n-' + date + '-' + n;
    li.id = id;
    const title = strongEl ? strongEl.textContent.trim() : '';
    // Body = everything inside the <li> except the time and the strong.
    const clone = li.cloneNode(true);
    const ct = clone.querySelector(':scope > time');
    const cs = clone.querySelector(':scope > strong');
    if (ct) ct.remove();
    if (cs) cs.remove();
    const body = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    const haystack = (title + ' ' + body).toLowerCase();
    const tags = [];
    for (const r of TAG_RULES) {
      if (r.match.test(haystack)) tags.push(r.tag);
    }
    // Index row: time + title, both compact.
    if (timeEl) {
      const liIndex = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#' + id;
      const t = document.createElement('span');
      t.className = 'notes-index-date';
      t.textContent = timeEl.textContent.trim();
      const ti = document.createElement('span');
      ti.className = 'notes-index-title';
      ti.textContent = title || '(untitled)';
      a.appendChild(t);
      a.appendChild(ti);
      liIndex.appendChild(a);
      indexList.appendChild(liIndex);
    }
    return { id, title, body, haystack, tags, el: li };
  });

  // ---- tag cloud (built once we know tag totals) -------------------------
  const tagTotals = new Map();
  for (const d of data) {
    for (const t of d.tags) tagTotals.set(t, (tagTotals.get(t) || 0) + 1);
  }
  // Stable order: count desc, then name asc. The TAG_RULES list is the
  // canonical order source — we re-emit in that order so the cloud has
  // the same vocabulary every render.
  const tagButtons = new Map();     // tag name -> <button> element
  for (const r of TAG_RULES) {
    const count = tagTotals.get(r.tag) || 0;
    if (count === 0) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'notes-tag-pill';
    b.dataset.tag = r.tag;
    const label = document.createElement('span');
    label.className = 'notes-tag-pill-label';
    label.textContent = r.tag;
    const cnt = document.createElement('span');
    cnt.className = 'notes-tag-pill-count';
    cnt.textContent = String(count);
    b.appendChild(label);
    b.appendChild(cnt);
    b.title = count + ' note' + (count === 1 ? '' : 's') + ' tagged "' + r.tag + '"';
    tagCloud.appendChild(b);
    tagButtons.set(r.tag, b);
  }

  // ---- filter state ------------------------------------------------------
  let activeQuery = '';
  let activeTag = '';

  function applyFilter() {
    let visible = 0;
    for (const d of data) {
      const matchesQuery = !activeQuery || d.haystack.includes(activeQuery);
      const matchesTag = !activeTag || d.tags.includes(activeTag);
      const show = matchesQuery && matchesTag;
      d.el.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    // Count line: "X of Y notes · filter: …"
    const total = data.length;
    let label;
    if (!activeQuery && !activeTag) {
      label = 'showing all ' + total + ' notes';
    } else {
      const parts = [];
      if (activeQuery) parts.push('search "' + activeQuery + '"');
      if (activeTag)   parts.push('tag "' + activeTag + '"');
      label = 'showing ' + visible + ' of ' + total + ' notes · ' + parts.join(' · ');
    }
    countEl.textContent = label;
    clearEl.style.display = (activeQuery || activeTag) ? '' : 'none';
    empty.style.display = (visible === 0) ? '' : 'none';
    // Active pill styling
    for (const [name, b] of tagButtons) {
      b.classList.toggle('is-active', name === activeTag);
      b.setAttribute('aria-pressed', name === activeTag ? 'true' : 'false');
    }
    // URL hash sync — replaceState so each keystroke doesn't push a
    // history entry. Bad/empty values get stripped.
    const hashParts = [];
    if (activeTag)   hashParts.push('tag=' + encodeURIComponent(activeTag));
    if (activeQuery) hashParts.push('q='   + encodeURIComponent(activeQuery));
    const newHash = hashParts.length ? '#' + hashParts.join('&') : '';
    // Preserve an explicit #n-… anchor jump if one is in the URL.
    // The session-index <a> links use href="#n-YYYY-MM-DD-N" (the
    // same id the JS assigns to each <li>), so a deep link looks
    // like "#n-2026-08-22-3". The browser snaps to the target and
    // applies :target styling before our replaceState fires, but if
    // we wipe the hash the URL no longer bookmarks the deep link.
    // We don't *add* #n-… here, just leave it alone when the user
    // navigates to a session anchor.
    const m = (location.hash || '').replace(/^#/, '');
    // Match an #n-YYYY-MM-DD-N anchor either as the only thing in
    // the hash OR as the first param of "&n-…". The character class
    // is strict digits + dash so the match stops at the first "&".
    const nMatch = m.match(/^(?:n-\d{4}-\d{2}-\d{2}-\d+(?:&|$))/) ||
                   m.match(/(?:^|&)(n-\d{4}-\d{2}-\d{2}-\d+)(?:&|$)/);
    const nParam = nMatch ? (nMatch[1] || nMatch[0].replace(/&$/, '')) : '';
    let finalHash = newHash;
    if (nParam) {
      finalHash = newHash
        ? newHash + '&' + nParam
        : '#' + nParam;
    }
    if (location.hash !== finalHash) {
      try { history.replaceState(null, '', location.pathname + location.search + finalHash); }
      catch (_) { /* file:// or sandbox — silently ignore */ }
    }
  }

  // ---- event wiring ------------------------------------------------------
  searchInput.addEventListener('input', function () {
    activeQuery = searchInput.value.trim().toLowerCase();
    applyFilter();
  });
  for (const [name, b] of tagButtons) {
    b.addEventListener('click', function () {
      activeTag = (activeTag === name) ? '' : name;
      applyFilter();
    });
  }
  clearEl.addEventListener('click', function () {
    activeQuery = '';
    activeTag = '';
    searchInput.value = '';
    applyFilter();
    searchInput.focus();
  });

  // On hashchange (e.g. browser back/forward, or a deep link), re-parse
  // and apply. This is what makes #tag=lab survive a page refresh.
  function readHash() {
    const m = (location.hash || '').replace(/^#/, '');
    if (!m) return;
    const params = new URLSearchParams(m);
    const tag = (params.get('tag') || '').toLowerCase();
    const q   = (params.get('q')   || '').toLowerCase();
    if (tag && tagButtons.has(tag)) activeTag = tag;
    if (q)   activeQuery = q;
    if (activeQuery) searchInput.value = activeQuery;
  }
  readHash();
  applyFilter();
  window.addEventListener('hashchange', function () {
    activeQuery = '';
    activeTag = '';
    readHash();
    applyFilter();
  });
})();
