/* foxy-walk.js v2 — paste into the Safari console, then:
 *
 *     foxyWalk.start()      // begin recording
 *     ... walk the app, open sheets, let keyboards come up ...
 *     foxyWalk.problems()   // just what looks wrong
 *     foxyWalk.report()     // everything
 *     foxyWalk.snap('name') // capture right now, under a name you choose
 *     foxyWalk.stop()
 *
 * What v1 got wrong, and this fixes:
 *   - it named each screen by its data-template, which is the component, not
 *     the screen. entry is both amount keypads; list is history, switch mint
 *     and the mint roster. Three screens overwrote each other. This names by
 *     the heading on screen and keeps the template as a field.
 *   - it only captured when that name changed, so revisiting a name as a
 *     different screen recorded nothing. This fingerprints the content.
 *   - it only looked inside the template, so every overlay on document.body
 *     was invisible: the note sheet, seed screen, melt loader, verify flow,
 *     delete cards. This walks those too and marks them OVERLAY.
 *   - it kept one snapshot per name. This keeps each distinct one.
 */
(function () {
  var caps = [], byKey = {}, timer = null, lastSig = '';

  function tpl() { return document.querySelector('[data-template]'); }

  /* Overlays are positioned children of body that are not the app host. */
  function overlayRoots() {
    var out = [], host = tpl();
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el.nodeType !== 1) return;
      if (host && (el === host || el.contains(host))) return;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      if (el.getBoundingClientRect().height < 40) return;
      out.push(el);
    });
    return out;
  }

  /* The biggest short line near the top — the screen's name as a person reads
   * it. Falls back to the template attribute. */
  function heading(root, anywhere) {
    var best = null, bestSize = 0;
    root.querySelectorAll('div,span,h1,h2').forEach(function (e) {
      if (e.childElementCount) return;
      /* Never a secret. A seed word is short and near the top of the phrase
       * screen, so it passes every test below; only its font size, smaller
       * than the title's today, kept it from naming the screen. */
      if (secret(e)) return;
      var r = e.getBoundingClientRect();
      if (r.height < 12) return;
      // a screen's title is near the top; a sheet's can be anywhere
      if (!anywhere && (r.top < -1 || r.top > 260)) return;
      var txt = (e.textContent || '').trim();
      if (!txt || txt.length > 34) return;
      var size = parseFloat(getComputedStyle(e).fontSize) || 0;
      if (size > bestSize) { bestSize = size; best = txt; }
    });
    return best;
  }

  /* How much of the page the keyboard covers, when the viewport admits it. */
  function covered() {
    var vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
  }
  function keyboardTop() {
    var c = covered();
    return c > 80 ? innerHeight - c : 0;
  }

  /* Seed words, restore inputs and anything marked secret are recorded as
   * [hidden]. A walk report is pasted into bug reports and chats; the layout
   * matters there, the twelve words never do. */
  var SECRET = '[data-foxy-secret], [data-foxy-seed-screen]';
  // the markup marks them (restore cells, the phrase, the verify quiz); template
  // names are generic (list, entry…) and cannot tell a seed screen from another
  function secret(e) {
    return !!(e && e.closest && e.closest(SECRET));
  }

  function rowsFor(root, isOverlay) {
    var rows = [], clipped = 0, kb = keyboardTop();
    root.querySelectorAll('*').forEach(function (e) {
      var r = e.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      // cursor:pointer catches anything wired with addEventListener, which
      // neither of the other two tests can see — that is how the VPN screen's
      // back button went missing from a whole report.
      var cs = getComputedStyle(e);
      var tap = (e.getAttribute && e.getAttribute('sc-camel-on-click')) ||
                e.onclick || cs.cursor === 'pointer';
      if (e.childElementCount && !tap) return;
      var txt = (e.childElementCount ? '' : (e.textContent || '').trim()).slice(0, 26);
      if (!txt && e.tagName === 'INPUT') txt = '[input] ' + (e.value || e.placeholder || '');
      if (txt && secret(e)) txt = e.tagName === 'INPUT' ? '[input] [hidden]' : '[hidden]';
      var off = r.bottom > innerHeight + 1 || r.top < -1;
      var offX = r.right > innerWidth + 1 || r.left < -1;
      var under = kb && r.top > kb;
      if (off || offX || under) clipped++;
      rows.push(
        String(Math.round(r.top)).padStart(4) + ' ' +
        String(Math.round(r.left)).padStart(4) + '  ' +
        (Math.round(r.width) + 'x' + Math.round(r.height)).padEnd(9) +
        (tap ? 'TAP ' : '    ') +
        (isOverlay ? 'OVERLAY ' : '') +
        (off ? 'OFFSCREEN ' : '') +
        (offX ? 'OFF-RIGHT ' : '') +
        (under ? 'UNDER-KEYBOARD ' : '') +
        txt);
    });
    return { rows: rows, clipped: clipped };
  }

  function snapshot(forced) {
    var host = tpl();
    var ovs = overlayRoots();
    if (!host && !ovs.length) return null;

    var parts = [], rows = [], clipped = 0;
    if (host) {
      var h = rowsFor(host, false);
      rows = rows.concat(h.rows); clipped += h.clipped;
      parts.push(heading(host) || host.getAttribute('data-template') || 'screen');
    }
    ovs.forEach(function (el) {
      var o = rowsFor(el, true);
      rows = rows.concat(o.rows); clipped += o.clipped;
      parts.push('+' + (heading(el, true) || 'overlay'));
    });

    var focus = document.activeElement;
    return {
      name: forced || parts.join(' '),
      tpl: host ? host.getAttribute('data-template') : '(none)',
      at: new Date().toLocaleTimeString(),
      size: innerWidth + 'x' + innerHeight,
      mounted: document.querySelectorAll('[data-template]').length,
      overlays: ovs.length,
      covered: covered(),
      focus: focus && focus !== document.body
        ? focus.tagName.toLowerCase() + (focus.value !== undefined ? ' [' + (secret(focus) ? 'hidden' : focus.value) + ']' : '')
        : 'none',
      font: host ? getComputedStyle(host).fontFamily.split(',')[0] : '',
      clipped: clipped,
      rows: rows
    };
  }

  /* Content, not just the name — so two screens sharing a template both land. */
  function fingerprint(s) {
    return s.name + '|' + s.rows.length + '|' + s.overlays + '|' +
           s.rows.slice(0, 8).join('').replace(/\s+/g, '').slice(0, 120);
  }

  function record(force, name) {
    var s = snapshot(name);
    if (!s) return null;
    var fp = fingerprint(s);
    if (!force && fp === lastSig) return null;
    lastSig = fp;
    var key = s.name + ' #' + s.rows.length + (s.overlays ? ' +ov' : '');
    if (!byKey[key]) caps.push(key);
    byKey[key] = s;
    console.log('[walk]', key, '|', s.rows.length, 'elements',
                s.overlays ? '| ' + s.overlays + ' overlay' : '',
                s.covered ? '| keyboard ' + s.covered : '',
                s.clipped ? '| ' + s.clipped + ' FLAGGED' : '',
                s.mounted > 1 ? '| ' + s.mounted + ' screens mounted' : '');
    return key;
  }

  function block(key) {
    var s = byKey[key], out = [];
    out.push('===== ' + key + ' =====');
    out.push('template ' + s.tpl + ' | ' + s.at + ' | viewport ' + s.size +
             ' | font ' + s.font +
             (s.overlays ? ' | ' + s.overlays + ' overlay' : '') +
             (s.covered ? ' | keyboard covers ' + s.covered : ' | keyboard down') +
             ' | focus ' + s.focus +
             (s.mounted > 1 ? ' | ' + s.mounted + ' screens mounted' : ''));
    out.push(' top left  size      what');
    return out.concat(s.rows, '');
  }

  window.foxyWalk = {
    start: function (ms) {
      clearInterval(timer);
      timer = setInterval(function () { record(false); }, ms || 400);
      console.log('recording \u2014 walk the app, then foxyWalk.problems()');
      return 'on';
    },
    stop: function () { clearInterval(timer); timer = null; return 'off'; },

    /* Capture this instant under a name you pick. For anything the poller
     * would miss or mislabel — a sheet with the keyboard up, say. */
    snap: function (name) {
      var key = record(true, name || null);
      return key ? 'captured: ' + key : 'nothing to capture';
    },

    /* An index, so a long walk can be pasted back in pieces. */
    list: function () {
      caps.forEach(function (k, i) {
        var s = byKey[k];
        console.log(i + '  ' + k + '  (' + s.rows.length + ' elements' +
                    (s.clipped ? ', ' + s.clipped + ' flagged' : '') + ')');
      });
      return caps.length + ' captures \u2014 foxyWalk.report() for all, ' +
             'foxyWalk.report(0, 4) for a slice';
    },

    report: function (from, to) {
      var pick = (from === undefined) ? caps : caps.slice(from, to === undefined ? from + 1 : to);
      var out = [];
      pick.forEach(function (k) { out = out.concat(block(k)); });
      console.log(out.join('\n'));
      return 'captures: ' + pick.length + ' of ' + caps.length + ' \u2014 above';
    },

    problems: function () {
      var out = [];
      caps.forEach(function (k) {
        var s = byKey[k];
        var bad = s.rows.filter(function (r) {
          return r.indexOf('OFFSCREEN') >= 0 || r.indexOf('OFF-RIGHT') >= 0 ||
                 r.indexOf('UNDER-KEYBOARD') >= 0;
        });
        if (bad.length || s.mounted > 1) {
          out.push('===== ' + k + ' =====');
          if (s.mounted > 1) out.push('  ' + s.mounted + ' screens mounted at once');
          out = out.concat(bad.map(function (b) { return '  ' + b; }));
        }
      });
      console.log(out.length ? out.join('\n') : 'nothing flagged');
      return out.length ? 'problems above' : 'clean';
    },

    screens: function () { return caps.slice(); }
  };

  console.log('ready \u2014 foxyWalk.start(), walk, foxyWalk.problems()');
})();
