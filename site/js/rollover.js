/* site/js/rollover.js — tick a "time until next UTC midnight" countdown.

The server renders one or more <code class="rollover-chip" data-seconds="N"
data-rollover-at="YYYY-MM-DD HH:MM:SS UTC"> placeholders. This script reads
the initial remaining seconds from `data-seconds`, then ticks down once per
second using Date.now() so the JS clock doesn't drift from the server's.

When the countdown reaches 00:00:00 (or below), the chip briefly shows that
and then reloads the page — the server-rendered HTML will reflect the new
UTC day. We also recompute the absolute target from `data-rollover-at`
so a clock skew between client and server doesn't cause a wrong-day reload.

All chips with the class are updated. The script is silent on network or
parse failures — it falls back to the placeholder text "--:--:--" if the
data attribute is missing or invalid.
*/
(function () {
  "use strict";

  function pad2(n) {
    n = Math.max(0, Math.floor(n));
    return n < 10 ? "0" + n : "" + n;
  }

  function formatHMS(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  // Parse "YYYY-MM-DD HH:MM:SS UTC" into a unix epoch second.
  // Returns NaN on parse failure.
  function parseRolloverAt(s) {
    if (!s) return NaN;
    var m = String(s).match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
    );
    if (!m) return NaN;
    return Date.UTC(
      +m[1],
      +m[2] - 1,
      +m[3],
      +m[4],
      +m[5],
      +m[6]
    ) / 1000;
  }

  // Registry of active tickers keyed by element, so a caller can update
  // a chip's data attrs and call `reset()` to restart the ticker with
  // the new anchor (without starting a duplicate interval).
  var tickers = new WeakMap();

  function attach(chip) {
    var initial = parseInt(chip.getAttribute("data-seconds"), 10);
    var rolloverAt = parseRolloverAt(
      chip.getAttribute("data-rollover-at")
    );
    // Treat 0 / NaN / negative as "not ready yet" (the placeholder value
    // before a fetch resolves, or an empty data attr). Without this guard
    // a chip that ships with data-seconds="0" would treat 0 as the
    // countdown itself, immediately show "00:00:00", and reload.
    if (!isFinite(initial) || initial <= 0) {
      if (!isFinite(rolloverAt)) return;
    }

    // Anchor: prefer the absolute rollover timestamp, since it's not
    // affected by how long the server spent building the response. Fall
    // back to the initial-seconds anchor if parsing failed.
    var anchor;
    if (isFinite(rolloverAt)) {
      anchor = { mode: "absolute", at: rolloverAt };
    } else {
      var startedAt = Date.now();
      anchor = { mode: "relative", startedAt: startedAt, seconds: initial };
    }

    var handle = null;
    var reloading = false;

    function tick() {
      var remaining;
      if (anchor.mode === "absolute") {
        remaining = anchor.at - Math.floor(Date.now() / 1000);
      } else {
        var elapsed = Math.floor((Date.now() - anchor.startedAt) / 1000);
        remaining = anchor.seconds - elapsed;
      }
      chip.textContent = formatHMS(remaining);
      if (remaining <= 0 && !reloading) {
        // We've hit the rollover. Show 00:00:00 for one beat, then reload
        // so the server-rendered HTML reflects the new day.
        chip.textContent = "00:00:00";
        reloading = true;
        clearInterval(handle);
        handle = null;
        tickers.delete(chip);
        // Slight delay so the user actually sees the 00:00:00 beat
        // before the page swaps.
        setTimeout(function () {
          window.location.reload();
        }, 1100);
      }
    }

    tick();
    handle = setInterval(tick, 1000);
    tickers.set(chip, {
      getHandle: function () { return handle; },
      setHandle: function (h) { handle = h; },
      getAnchor: function () { return anchor; },
      setAnchor: function (a) { anchor = a; },
    });
  }

  // Re-attach a chip in place: kill any existing interval and start
  // fresh with whatever data-seconds / data-rollover-at are currently
  // set. Safe to call repeatedly.
  function reset(chip) {
    var t = tickers.get(chip);
    if (t && t.getHandle()) {
      clearInterval(t.getHandle());
      t.setHandle(null);
    }
    tickers.delete(chip);
    attach(chip);
  }

  function init() {
    var chips = document.querySelectorAll(".rollover-chip");
    for (var i = 0; i < chips.length; i++) attach(chips[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose a tiny API so other scripts can update a chip's anchor and
  // restart the ticker. e.g. guessing.js fetches /api/guessing/daily
  // and calls rollover.update(chip) once the data attrs are set.
  window.__agent06Rollover = {
    reset: reset,
    attach: attach,
  };

  // Also listen for a DOM event so callers don't need the global.
  document.addEventListener("rollover:update", function (ev) {
    var chip = ev && ev.detail && ev.detail.chip;
    if (chip && chip.classList && chip.classList.contains("rollover-chip")) {
      reset(chip);
    }
  });
})();
