  /* ---- HOW TAP LIMIT WORKS ------------------------------------------------
   *
   * What PER TAP LIMIT opens before the amount is asked (26f-flashcard.js,
   * `fcLimitAsk`): the rule of a limit on one tap, played. Each statement
   * comes up large in the middle of the screen and drops into its place in a
   * list, so that the whole rule is on the screen when the buttons come: a
   * payment within the limit is as quick as any tap, and every limit's worth
   * over it holds the card a few seconds longer. The example is a ten-dollar
   * limit, and the seconds beside each tier are what a card that makes its
   * own change takes (the card's wait schedule: ten signatures for the first
   * limit's worth over the limit, three for every limit's worth beyond that,
   * on top of a tap of two to five; a card before software 1.17 asks for seven
   * for the first), and they are said as "about", for that is what they are;
   * they are the design's, not computed. A tap anywhere skips
   * the statement on the screen; once the list is whole, a tap on it plays
   * it again. A phone that asks for less motion is shown the whole list at
   * once, and so is a phone that has seen it play through once.
   *
   * Plain DOM over the page, as the stage (26e-loaders.js) and the cards
   * (11-cards.js) are, with the app's two buttons under it: CANCEL in the
   * shape of the confirmation's second button, CONTINUE as the fur button
   * the card's screen has. `o.go` is CONTINUE, `o.cancel` CANCEL; neither
   * does anything until the list is whole. `this._fcExplainer` is the screen
   * for the suites: `finish()`, `play()`, `close()`, `done()`. */
  FC_EXPLAINER = { limit: 10, secs: ['2–5', '10', '12', '14'], secsBefore: ['2–5', '8', '10', '12'], speed: 1.4 };
  // set once the screen has played through on this phone; a tap on the list plays it again
  FC_EXPLAINED = 'foxy.flashcard.explained';

  fcTapLimitExplainer(o) {
    this.fcExplainerClose();
    const opts = o || {};
    const E = this.FC_EXPLAINER;
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // every statement in one shape, whatever its kind, so that a reader of the list needs no cases
    const item = (kind, o) => Object.assign({ kind, text: '', limit: '', range: '', secs: '', long: '', bar: '' }, o || {});
    const items = [
      item('text', { text: 'Any payment request over your limit requires you to tap and hold your card longer.' }),
      item('limit', { limit: '$' + E.limit }),
    // a card of software 1.17 asks for ten signatures for the first limit's worth over its limit, one before it for seven
    ].concat(((opts.over || 10) >= 10 ? E.secs : E.secsBefore).map((s, k, all) => item('tier', {
      range: money(k * E.limit + 0.01) + ' – ' + money((k + 1) * E.limit),
      secs: 'ABOUT ' + s + ' SEC', long: 'Tap for about ' + s + ' seconds',
      bar: Math.round(parseInt(s.split('–').pop(), 10) / parseInt(String(all[all.length - 1]).split('–').pop(), 10) * 100) + '%',
    }))).concat([item('more')]);

    const SORA = 'font-family:Sora,system-ui,sans-serif;';
    const FIG = 'font-family:Figtree,Sora,system-ui,sans-serif;';
    const bar = (w, h) => '<div style="height:' + h + 'px;border-radius:' + Math.ceil(h / 2) + 'px;background:#222;overflow:hidden">'
      + '<div style="width:' + w + ';height:100%;border-radius:' + Math.ceil(h / 2) + 'px;background:#EB6A2E"></div></div>';
    const rowHTML = (it) => it.kind === 'text'
      ? '<div style="margin:0 0 10px;text-align:center;' + SORA + 'font-weight:700;font-size:21px;line-height:1.35;letter-spacing:-.01em;text-wrap:balance">' + esc(it.text) + '</div>'
      : it.kind === 'limit'
        ? '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-radius:18px;background:#BFE3EC;color:#0F2A33">'
          + '<div style="' + SORA + 'font-weight:800;font-size:14px;letter-spacing:.14em">EXAMPLE LIMIT</div>'
          + '<div style="' + SORA + 'font-weight:800;font-size:28px;letter-spacing:-.02em">' + esc(it.limit) + '</div></div>'
        : it.kind === 'tier'
          ? '<div style="display:flex;flex-direction:column;gap:7px;padding:10px 16px 11px;border-radius:16px;background:#111;border:1px solid #232323">'
            + '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">'
            + '<div style="' + SORA + 'font-weight:700;font-size:16px;letter-spacing:-.01em">' + esc(it.range) + '</div>'
            + '<div style="' + SORA + 'font-weight:800;font-size:16px;color:#EB6A2E;white-space:nowrap">' + esc(it.secs) + '</div></div>'
            + bar(it.bar, 5) + '</div>'
          : '<div style="text-align:center;' + SORA + 'font-weight:700;font-size:16px;letter-spacing:.06em;color:#9A9A9A">And so on…</div>';
    const sTier = (it) => '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px 22px;border-radius:30px;background:#111;'
      + 'border:1.5px solid #2E2E2E;box-shadow:0 0 60px rgba(235,106,46,.18)">'
      + '<div style="' + FIG + 'font-weight:600;font-size:17px;letter-spacing:.06em;color:#9A9A9A">PAYMENT OF</div>'
      + '<div style="' + SORA + 'font-weight:800;font-size:32px;letter-spacing:-.02em">' + esc(it.range) + '</div>'
      + '<div style="' + SORA + 'font-weight:800;font-size:26px;color:#EB6A2E">' + esc(it.long) + '</div>'
      + '<div style="align-self:stretch">' + bar(it.bar, 8) + '</div></div>';
    const spotHTML = (it, i) => it.kind === 'text'
      ? '<div style="' + SORA + 'font-weight:800;font-size:27px;line-height:1.3;letter-spacing:-.01em;text-wrap:balance">' + esc(it.text) + '</div>'
      : it.kind === 'limit'
        ? '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 20px;border-radius:30px;background:#BFE3EC;color:#0F2A33;box-shadow:0 0 60px rgba(191,227,236,.25)">'
          + '<div style="' + SORA + 'font-weight:800;font-size:16px;letter-spacing:.16em">EXAMPLE LIMIT</div>'
          + '<div style="' + SORA + 'font-weight:800;font-size:72px;line-height:1;letter-spacing:-.03em">' + esc(it.limit) + '</div></div>'
          + '<div style="margin-top:14px">' + sTier(items[i + 1]) + '</div>'
        : it.kind === 'tier' ? sTier(it)
          : '<div style="' + SORA + 'font-weight:800;font-size:34px;letter-spacing:.02em;color:#BDBDBD">And so on…</div>';

    const el = (style, html) => { const d = document.createElement('div'); d.style.cssText = style; if (html) d.innerHTML = html; return d; };
    const root = el('position:fixed;inset:0;z-index:2147483350;display:flex;flex-direction:column;overflow:hidden;background:#050505;color:#fff;'
      + SORA + '-webkit-font-smoothing:antialiased;animation:foxyIn .18s ease');
    root.id = 'foxy-explainer';
    // the dots the design has behind it
    root.appendChild(el('position:absolute;inset:0;pointer-events:none;opacity:.35;'
      + 'background-image:radial-gradient(rgba(255,255,255,.55) 1px,transparent 1.6px),radial-gradient(rgba(191,227,236,.3) 1px,transparent 1.5px);'
      + 'background-size:53px 61px,31px 37px;background-position:9px 14px,21px 5px'));
    const title = el('position:relative;margin:0;padding:calc(28px + env(safe-area-inset-top)) 28px 0;text-align:center;'
      + 'font-weight:800;font-size:21px;letter-spacing:.02em;text-transform:uppercase');
    title.textContent = 'How tap limit works';
    root.appendChild(title);
    const list = el('position:relative;flex:1 1 auto;display:flex;flex-direction:column;gap:12px;padding:26px 28px 0');
    list.innerHTML = items.map((it) => '<div style="opacity:0;transition:opacity .45s ease">' + rowHTML(it) + '</div>').join('');
    root.appendChild(list);
    const tap = el('position:absolute;inset:0;cursor:pointer');
    root.appendChild(tap);
    const spot = el('position:absolute;left:50%;top:47%;width:330px;max-width:calc(100% - 40px);pointer-events:none;text-align:center;'
      + 'opacity:0;transform:translate(-50%,-50%) scale(.8)');
    root.appendChild(spot);
    const btns = el('position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 32px calc(24px + env(safe-area-inset-bottom));'
      + 'opacity:0;pointer-events:none;transition:opacity .5s ease');
    const cancel = el('height:60px;border-radius:30px;border:2px solid #2A2A2A;background:#101010;box-shadow:0 8px 18px rgba(0,0,0,.6);'
      + 'display:flex;align-items:center;justify-content:center;' + SORA + 'font-weight:800;font-size:20px;letter-spacing:.02em;color:#fff;cursor:pointer');
    cancel.textContent = 'CANCEL';
    // the card screen's fur button (build/markup.html, SET UP THIS CARD), shine and all
    const go = el('height:60px;border-radius:30px;background-color:var(--acc);'
      + 'background-image:radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),'
      + 'linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url(\'foxy-fur.webp\');'
      + 'background-repeat:no-repeat,no-repeat,no-repeat;background-size:auto,auto,150% auto;background-position:center,center,50% 34%;'
      + 'position:relative;overflow:hidden;isolation:isolate;display:flex;align-items:center;justify-content:center;'
      + SORA + 'font-size:20px;font-weight:800;letter-spacing:0.02em;color:#fff;cursor:pointer;box-shadow:inset 0 2px 0 rgba(255,255,255,.4)');
    go.className = 'fxShine fxShine1';
    go.textContent = 'CONTINUE';
    btns.appendChild(cancel);
    btns.appendChild(go);
    root.appendChild(btns);
    const rows = Array.prototype.slice.call(list.children);

    let step = 0, phase = 'enter', done = false, timers = [];
    const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const setSpot = (t, op, tr) => { spot.style.transition = tr; spot.style.transform = t; spot.style.opacity = String(op); };
    const finish = () => {
      clear(); done = true; phase = 'end';
      // played once on this phone: from then on the screen opens on the list, with its buttons ready
      try { localStorage.setItem(this.FC_EXPLAINED, '1'); } catch (e) {}
      rows.forEach((r) => { r.style.opacity = '1'; });
      spot.innerHTML = ''; spot.style.opacity = '0';
      btns.style.opacity = '1'; btns.style.pointerEvents = 'auto'; tap.style.pointerEvents = 'none';
    };
    const enter = () => {
      phase = 'enter';
      spot.innerHTML = spotHTML(items[step], step);
      setSpot('translate(-50%,-50%) scale(.8)', 0, 'none');
      void spot.offsetWidth;
      later(show, 60);
    };
    const show = () => {
      phase = 'show';
      setSpot('translate(-50%,-50%) scale(1)', 1, 'transform .55s cubic-bezier(.2,.9,.25,1.12), opacity .35s ease');
      const k = items[step].kind;
      later(drop, (k === 'text' ? 3600 : k === 'more' ? 1300 : k === 'limit' ? 3800 : 1900) * E.speed);
    };
    const drop = () => {
      phase = 'drop';
      const pair = items[step].kind === 'limit';
      const a = rows[step].getBoundingClientRect(), b = pair ? rows[step + 1].getBoundingClientRect() : a;
      const r = { cx: Math.min(a.left, b.left) + Math.max(a.width, b.width) / 2, cy: (a.top + b.bottom) / 2, w: Math.max(a.width, b.width), h: b.bottom - a.top };
      const s = spot.getBoundingClientRect();
      const fit = Math.min(1, r.h / s.height, r.w / s.width);
      const sc = isFinite(fit) ? Math.max(.25, fit) : 1;
      const dx = r.cx - (s.left + s.width / 2), dy = r.cy - (s.top + s.height / 2);
      setSpot('translate(-50%,-50%) translate(' + (isFinite(dx) ? dx : 0) + 'px,' + (isFinite(dy) ? dy : 0) + 'px) scale(' + sc + ')', 0,
              'transform .65s cubic-bezier(.65,0,.3,1), opacity .45s ease .2s');
      rows.forEach((row, i) => { row.style.opacity = i < step ? '.4' : (i === step || (pair && i === step + 1)) ? '1' : '0'; });
      later(() => {
        const nx = step + (pair ? 2 : 1);
        if (nx < items.length) { step = nx; rows.forEach((row, i) => { if (i < step) row.style.opacity = '.4'; }); enter(); }
        else finish();
      }, 700);
    };
    const play = () => {
      clear(); step = 0; done = false; phase = 'enter';
      btns.style.opacity = '0'; btns.style.pointerEvents = 'none'; tap.style.pointerEvents = 'auto';
      rows.forEach((r) => { r.style.opacity = '0'; });
      enter();
    };
    tap.addEventListener('click', () => { if (phase === 'show') { clear(); drop(); } });
    list.addEventListener('click', () => { if (done) play(); });
    const close = () => {
      clear();
      root.remove();
      if (this._fcExplainer && this._fcExplainer.root === root) this._fcExplainer = null;
    };
    cancel.addEventListener('click', () => { if (!done) return; close(); if (opts.cancel) opts.cancel(); });
    go.addEventListener('click', () => { if (!done) return; close(); if (opts.go) opts.go(); });
    document.body.appendChild(root);
    this._fcExplainer = { root, finish, play, close, done: () => done, step: () => step };
    let still = false;
    try { still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { still = false; }
    let seen = false;
    try { seen = localStorage.getItem(this.FC_EXPLAINED) === '1'; } catch (e) { seen = false; }
    if (still || seen) finish(); else later(play, 400);
    console.log('[foxy] card: how tap limit works' + (seen ? ', seen before: shown whole' : still ? ', shown whole' : ''));
  }

  /* The screen taken down, timers and all: before another, and by whoever
   * leaves the card's flow another way. */
  fcExplainerClose() {
    if (this._fcExplainer) this._fcExplainer.close();
  }
