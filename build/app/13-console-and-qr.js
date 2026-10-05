
  // Mirror console output to the native log. The web inspector is not always
  // available, and a payment that misbehaves is hard to catch after the fact.
  mirrorConsole() {
    if (this._mirrored) return;
    /* In every build now, and this is a deliberate change.
     *
     * It used to be Debug only. The reason was sound at the time: a Release
     * build silences console.log because the lines name mint hosts, balances,
     * Tor state and clipboard sizes, and this mirror posted every one of them
     * to the native log, which printed in all builds — the app walking around
     * its own guard.
     *
     * What changed is where a native line goes. `print` in a Release build no
     * longer reaches NSLog, the system log or a file; it reaches FieldLog,
     * which is memory on this phone, redacted on the way in, and gets out only
     * when the person taps COPY on the LOGS screen (Foxy/Debug/Print.swift).
     * So mirroring in Release now feeds the screen that exists for them, and
     * silences nothing that was silent before — which is what
     * tools/sim/release-silence.sh still checks. */
    const mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (!mh) return;
    this._mirrored = true;
    this._installMirror();
  }

  _installMirror() {
    const post = (kind, args) => {
      try {
        const t = Math.round(performance.now());
        const text = '+' + t + 'ms ' + kind + ' ' + Array.prototype.map.call(args, a => {
          if (a instanceof Error) return a.message;
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
          return String(a);
        }).join(' ');
        window.webkit.messageHandlers.foxy.postMessage({ id: 'log-' + Date.now(), action: 'log', text: text });
      } catch (e) {}
    };
    ['log', 'warn', 'error'].forEach(k => {
      const original = console[k].bind(console);
      console[k] = function () { original.apply(null, arguments); post('[' + k + ']', arguments); };
    });
  }

  // While the mint is being asked for an invoice, the QR slot holds this
  // instead of an empty box. Built as an SVG data URI so it animates inside
  // an <img> with no dependence on the page's own rendering — SMIL runs in
  // the image itself.
  qrLoadingSrc() {
    // A QR stacking itself: modules fall in from above and land row by row
    // from the bottom up, the way tetris pieces settle. The pattern comes from
    // a seeded generator rather than Math.random, so it looks like a real code
    // and is identical on every call.
    // Sized from the box rather than hardcoded: 13 cells at 14px plus gaps and
    // 26px padding came to 263px inside a 240px panel, so the right and bottom
    // columns fell outside it.
    const BOX = 240, GRID = 13, GAP = 2.2, PAD = 13;
    const CELL = (BOX - 2 * PAD - (GRID - 1) * GAP) / GRID;
    const CYCLE = 4.2;      // fall, hold, clear
    const FALL = 0.42;      // how long one module takes to drop
    const ROW_GAP = 0.16;   // delay between rows landing

    let seed = 0x5f3a;
    const rand = () => {
      seed ^= seed << 7; seed ^= seed >> 9; seed &= 0xffff;
      return seed / 0xffff;
    };

    // accelerating fall, then a small settle — gravity rather than a glide
    const EASE = '0.55 0 0.85 0.3';

    const drop = (x, y, w, h, fill, stroke, at) => {
      const k = (t) => (t / CYCLE).toFixed(4);
      const land = at + FALL;
      const inner = stroke
        ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3" ' +
          'fill="none" stroke="#5CD46C" stroke-width="4"/>' +
          '<rect x="' + (x + CELL) + '" y="' + (y + CELL) + '" width="' + CELL + '" height="' + CELL + '" ' +
          'rx="1.5" fill="#5CD46C"/>'
        : '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1.5" ' +
          'fill="' + fill + '"/>';

      return '<g opacity="0">' + inner +
        // the fall
        '<animateTransform attributeName="transform" type="translate" ' +
        'values="0 -' + (y + 90) + ';0 0;0 0;0 0" ' +
        'keyTimes="' + k(at) + ';' + k(land) + ';0.86;1" ' +
        'keySplines="' + EASE + ';0 0 1 1;0 0 1 1" calcMode="spline" ' +
        'dur="' + CYCLE + 's" repeatCount="indefinite" additive="sum"/>' +
        // visible only once it is on its way down, gone at the end of the loop
        '<animate attributeName="opacity" values="0;0;0.92;0.92;0" ' +
        'keyTimes="0;' + k(at) + ';' + k(land) + ';0.86;1" ' +
        'dur="' + CYCLE + 's" repeatCount="indefinite"/></g>';
    };

    const inFinder = (gx, gy) =>
      (gx < 3 && gy < 3) || (gx > GRID - 4 && gy < 3) || (gx < 3 && gy > GRID - 4);

    const parts = [];
    // bottom row lands first, like a stack filling up
    for (let gy = GRID - 1; gy >= 0; gy--) {
      const rowAt = (GRID - 1 - gy) * ROW_GAP;
      for (let gx = 0; gx < GRID; gx++) {
        if (inFinder(gx, gy)) continue;
        if (rand() > 0.52) continue;
        const x = PAD + gx * (CELL + GAP), y = PAD + gy * (CELL + GAP);
        parts.push(drop(x, y, CELL, CELL, '#5CD46C', false, rowAt + rand() * 0.1));
      }
    }

    // the corner finders drop last, snapping the code together
    const side = 3 * CELL + 2 * GAP;
    const lastRow = (GRID - 1) * ROW_GAP;
    [[0, 0], [GRID - 3, 0], [0, GRID - 3]].forEach(([gx, gy], i) => {
      const x = PAD + gx * (CELL + GAP), y = PAD + gy * (CELL + GAP);
      parts.push(drop(x, y, side, side, null, true, lastRow + 0.12 + i * 0.1));
    });

    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">',
      '<rect width="240" height="240" rx="18" fill="#0B140E"/>',
      // everything is clipped to the panel, so modules appear from its top edge
      '<defs><clipPath id="p"><rect width="240" height="240" rx="18"/></clipPath></defs>',
      '<g clip-path="url(#p)">', parts.join(''), '</g>',
      '</svg>'
    ].join('');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
