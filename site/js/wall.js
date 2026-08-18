// agent-06 — Wall (guestbook)
//
// A small public guestbook. Anyone visiting can leave a short message
// with a name (or stay anonymous). Entries are appended on the server,
// capped at 200, and rendered newest-first.
//
// Server contract:
//   GET  /api/wall          -> { entries: [ { name, message, t }, ... ] }
//   POST /api/wall          -> { name, message }
//       validates name (≤24), message (≤140), per-IP 30-second cooldown
//       returns 200 {ok:true, t, name, message} or 4xx {ok:false, error}

(function () {
  'use strict';

  const MIN_INTERVAL_MS = 30000;
  const MAX_NAME = 24;
  const MAX_MESSAGE = 140;

  const $list = document.getElementById('wall-list');
  const $form = document.getElementById('wall-form');
  const $name = document.getElementById('wall-name');
  const $msg = document.getElementById('wall-message');
  const $status = document.getElementById('wall-status');
  const $count = document.getElementById('wall-count');
  const $submit = document.getElementById('wall-submit');

  const cooldownTimer = { id: null, left: 0 };

  function setStatus(msg, kind) {
    if (!$status) return;
    $status.textContent = msg || '';
    $status.dataset.kind = kind || 'info';
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(unix) {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    // Compact, locale-aware: "2026-08-18 14:09 UTC"
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getUTCFullYear() + '-' +
      pad(d.getUTCMonth() + 1) + '-' +
      pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' +
      pad(d.getUTCMinutes()) + ' UTC'
    );
  }

  function relativeTime(unix) {
    if (!unix) return '';
    const diff = Math.floor(Date.now() / 1000 - unix);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
    return formatTime(unix);
  }

  function render(entries) {
    if (!$list) return;
    if (!entries.length) {
      $list.innerHTML =
        '<li class="muted">no messages yet — be the first.</li>';
      return;
    }
    const html = entries.map((e) => {
      const name = escapeHTML(e.name || 'unknown');
      const msg = escapeHTML(e.message || '');
      return (
        '<li class="wall-entry">' +
        '<div class="wall-head">' +
        '<span class="wall-name">' + name + '</span>' +
        '<span class="wall-time" title="' + formatTime(e.t) + '">' +
        relativeTime(e.t) + '</span>' +
        '</div>' +
        '<div class="wall-msg">' + msg + '</div>' +
        '</li>'
      );
    }).join('');
    $list.innerHTML = html;
    if ($count) {
      $count.textContent = entries.length + (entries.length === 1 ? ' message' : ' messages');
    }
  }

  async function load() {
    if (!$list) return;
    try {
      const r = await fetch('/api/wall', { cache: 'no-cache' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      render(data.entries || []);
    } catch (e) {
      $list.innerHTML = '<li class="muted">load failed: ' + escapeHTML(e.message) + '</li>';
    }
  }

  function startCooldown(seconds) {
    if (cooldownTimer.id) clearInterval(cooldownTimer.id);
    cooldownTimer.left = seconds;
    if ($submit) $submit.disabled = true;
    const tick = () => {
      if (cooldownTimer.left <= 0) {
        clearInterval(cooldownTimer.id);
        cooldownTimer.id = null;
        cooldownTimer.left = 0;
        if ($submit) $submit.disabled = false;
        setStatus('');
        return;
      }
      setStatus('cooldown · ' + cooldownTimer.left + 's', 'wait');
      cooldownTimer.left--;
    };
    tick();
    cooldownTimer.id = setInterval(tick, 1000);
  }

  async function submit(ev) {
    ev.preventDefault();
    if (!$form || !$msg) return;
    const name = ($name && $name.value || '').trim().slice(0, MAX_NAME);
    const message = ($msg.value || '').trim().slice(0, MAX_MESSAGE);
    if (!message) {
      setStatus('message required', 'err');
      return;
    }
    if (message.length > MAX_MESSAGE) {
      setStatus('message too long (max ' + MAX_MESSAGE + ')', 'err');
      return;
    }
    setStatus('posting…');
    if ($submit) $submit.disabled = true;
    try {
      const r = await fetch('/api/wall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'anonymous', message }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        if (r.status === 429) {
          startCooldown(Math.ceil(body.retry_after_seconds || 30));
        } else {
          setStatus('post failed: ' + (body.error || ('http ' + r.status)), 'err');
          if ($submit) $submit.disabled = false;
        }
        return;
      }
      // Optimistic prepend.
      const entry = {
        name: body.name || name,
        message: body.message || message,
        t: body.t || Math.floor(Date.now() / 1000),
      };
      const items = [];
      const li = document.createElement('li');
      li.className = 'wall-entry';
      li.innerHTML =
        '<div class="wall-head">' +
        '<span class="wall-name">' + escapeHTML(entry.name) + '</span>' +
        '<span class="wall-time">' + relativeTime(entry.t) + '</span>' +
        '</div>' +
        '<div class="wall-msg">' + escapeHTML(entry.message) + '</div>';
      items.push(li);
      if ($list && $list.firstChild) {
        $list.insertBefore(li, $list.firstChild);
        // Remove the empty-state hint if present.
        if ($list.firstChild.classList && $list.firstChild.classList.contains('muted') && $list.children.length > 1) {
          // already replaced; nothing to do
        }
      } else if ($list) {
        $list.innerHTML = '';
        $list.appendChild(li);
      }
      if ($count) {
        const n = $list.querySelectorAll('.wall-entry').length;
        $count.textContent = n + (n === 1 ? ' message' : ' messages');
      }
      $msg.value = '';
      // Keep cooldown running so the same visitor can't flood.
      startCooldown(MIN_INTERVAL_MS / 1000);
      setStatus('posted', 'ok');
    } catch (e) {
      setStatus('post failed: ' + e.message, 'err');
      if ($submit) $submit.disabled = false;
    }
  }

  if ($form) $form.addEventListener('submit', submit);
  if ($msg) {
    $msg.addEventListener('input', () => {
      const left = MAX_MESSAGE - $msg.value.length;
      if ($count) {
        // Only show the char count when the form starts to matter.
      }
      setStatus(left <= 20 ? (left + ' chars left') : '');
    });
  }

  // Refresh every 30s so visitors see new messages.
  setInterval(load, 30000);
  load();
})();
