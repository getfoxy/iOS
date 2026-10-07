

  componentDidMount() {
    this.bootWallet();
    this._onDeepLink = () => this.applyDeepLink();
    window.addEventListener('hashchange', this._onDeepLink);
    // the bundled page unpacks itself before the shell finishes booting, so one check on
    // mount can run before the hash has been written — retry briefly, then stop.
    this.pushToNative();
    this.syncHaptics();
    /* Anything put over the page, or taken off it, is a reason to ask again
     * whether Apple's paste control may sit where it sits (syncPreview). The
     * screens drawn straight onto the body do not go through a render. */
    try {
      const Watch = /** @type {any} */ (window).MutationObserver;
      if (Watch && document.body) {
        this._bodyWatch = new Watch(() => {
          clearTimeout(this._bodyWatchT);
          this._bodyWatchT = setTimeout(() => { if (this.syncPreview) this.syncPreview(); }, 30);
        });
        this._bodyWatch.observe(document.body, { childList: true });
      }
    } catch (e) {}
    this._unlockAudio = () => this.audioCtx();
    window.addEventListener('pointerdown', this._unlockAudio, { passive: true });
    this._dlT = [0, 60, 200, 500, 900, 1500].map(ms => setTimeout(() => {
      if (this._onDeepLink && this._onDeepLink()) {
        (this._dlT || []).forEach(clearTimeout);
      }
    }, ms));
    this.syncAccent();
    // before anything else is usable, including the gate
    this.pinLock();
    // static frames (flow diagrams) skip the live feed, candle fetch and every loop
    if (!this.props.startStatic) { this.openFeed(); this.loadSeries(this.state.range); }
    this.applyShell();
    this._onResize = () => this.applyShell();
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) {
      // iOS ignores interactive-widget; compress the app above the keyboard by hand
      this._onVv = () => {
        const vv = window.visualViewport;
        const kb = Math.max(0, Math.round(window.innerHeight - vv.height));
        if (kb !== (this.state.kbInset || 0)) this.setState({ kbInset: kb });
        // iOS scrolls the document to reveal the input; undo it — the inset handles visibility
        if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
        const sh = document.scrollingElement;
        if (sh && sh.scrollTop) sh.scrollTop = 0;
      };
      this._onWinScroll = () => { if ((this.state.kbInset || 0) > 0 && window.scrollY) window.scrollTo(0, 0); };
      window.addEventListener('scroll', this._onWinScroll, { passive: true });
      window.visualViewport.addEventListener('resize', this._onVv);
      window.visualViewport.addEventListener('scroll', this._onVv);
    }
  }
  componentWillUnmount() {
    if (this._tokQr) { clearInterval(this._tokQr.timer); this._tokQr = null; }
    window.removeEventListener('resize', this._onResize);
    if (this._onDeepLink) window.removeEventListener('hashchange', this._onDeepLink);
    if (this._unlockAudio) window.removeEventListener('pointerdown', this._unlockAudio);
    if (this._ac) { try { this._ac.close(); } catch (e) {} this._ac = undefined; }
    (this._dlT || []).forEach(clearTimeout);
    if (this._onVv && window.visualViewport) { window.visualViewport.removeEventListener('resize', this._onVv); window.visualViewport.removeEventListener('scroll', this._onVv); }
    if (this._onWinScroll) window.removeEventListener('scroll', this._onWinScroll);
    // every timer this component can start, or an orphan keeps running after unmount
    ['_cardBalT','_otpTick','_eta','_balT','_bkT'].forEach(k => { clearInterval(this[k]); this[k] = null; });
    ['_toastT','_nfcT','_scanT','_sendA','_sendB','_retryT','_moreT','_spResumeT','_queueT','_claimT'].forEach(k => { clearTimeout(this[k]); this[k] = null; });
    Object.keys(this).filter(k => k.indexOf('_afT_') === 0).forEach(k => { (this[k] || []).forEach(clearTimeout); this[k] = null; });
    (this._fullT || []).forEach(clearTimeout); this._fullT = null;
    this.closeFeed();
    if (this._bigMap) { this._bigMap.remove(); this._bigMap = null; }
    if (this._homeMap) { this._homeMap.remove(); this._homeMap = null; }
    if (this._cardMap) { this._cardMap.remove(); this._cardMap = null; }
    if (this._bizMap) { this._bizMap.remove(); this._bizMap = null; }
    /* What the second componentWillUnmount did. A class keeps only the last
     * definition of a method, so the first one — every listener and most
     * timers above — never ran; the two are one method now. */
    clearInterval(this._refreshT);
    this.stopReceive();
    this.spStopWatch();
    cancelAnimationFrame(this._mraf);
  }

  // candle configs, one per timeline the chip offers; the data comes from
  // Kraken through the wallet
  rangeCfg(r) {
    const D = 86400;
    return ({
      '1H': { g: 60, span: 3600, label: 'last hour' },
      '1D': { g: 300, span: D, label: 'last 24 hours' },
      '1W': { g: 3600, span: 7 * D, label: 'last week' },
      '1M': { g: 21600, span: 30 * D, label: 'last month' },
      '1Y': { g: D, span: 365 * D, label: 'last year' },
      '4Y': { g: D, span: 1461 * D, label: 'last 4 years' },
    })[r];
  }

  loadSeries(r) {
    if (this.props.startStatic) return;
    const cfg = this.rangeCfg(r);
    if (!cfg) return;
    this._loading = this._loading || {};
    if ((this.state.series || {})[r] || this._loading[r]) return;
    this._loading[r] = true;
    // Through the wallet, so it asserts the gate like every other request.
    // It used to fetch Coinbase straight from here, which meant the one screen
    // that talks to the network on launch was the one screen not behind Tor.
    const W = window.FoxyWallet;
    if (!W || !W.candles) { this._loading[r] = false; return; }
    W.candles(cfg.g, cfg.span)
      .then(series => {
        const rows = (series || [])
          .filter(x => isFinite(x.t) && isFinite(x.c) && x.c > 0)
          .sort((p, q) => p.t - q.t);
        if (rows.length < 4) throw new Error('thin series');
        const built = this.buildChart(rows, cfg.label);
        this.setState(p => {
          const next = Object.assign({}, p.series);
          next[r] = built;
          return { series: next };
        });
      })
      .catch(e => {
        this._loading[r] = false;
        console.warn('[foxy] price line for', r, 'not loaded \u2014', (e && e.message) || e);
        /* And asked again. One refusal at launch left the home screen with no
         * line under the price for the rest of the visit, online or not
         * ("bad URL", never retried).
         * Slower each time, and not while there is no route to ask over. */
        this._seriesTries = (this._seriesTries || 0) + 1;
        clearTimeout(this._seriesT);
        this._seriesT = setTimeout(() => {
          if ((this.state.series || {})[this.state.range]) return;
          if (this.offlineNow && this.offlineNow()) return;
          this.loadSeries(this.state.range);
        }, Math.min(60000, 4000 * this._seriesTries));
      });
  }

  buildChart(rows, label) {
    // average into coarse buckets, then run a weighted smoothing pass so a 9px
    // stroke reads as one clean curve rather than a jitter of trade noise
    const N = Math.min(28, rows.length);
    let vals = [];
    for (let i = 0; i < N; i++) {
      const a = Math.floor(i * rows.length / N);
      const b = Math.max(a + 1, Math.floor((i + 1) * rows.length / N));
      let sum = 0;
      for (let j = a; j < b; j++) sum += rows[j].c;
      vals.push(sum / (b - a));
    }
    for (let pass = 0; pass < 2; pass++) {
      const out = vals.slice();
      for (let i = 1; i < vals.length - 1; i++) out[i] = (vals[i - 1] + vals[i] * 2 + vals[i + 1]) / 4;
      vals = out;
    }
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = (hi - lo) || 1;
    const X0 = 8, X1 = 372, YLO = 78, YHI = 14;
    let pts = vals.map((v, i) => ({
      x: X0 + (X1 - X0) * (N === 1 ? 1 : i / (N - 1)),
      y: YLO + (YHI - YLO) * ((v - lo) / span),
    }));
    /* The line is drawn past both edges of the screen, so neither end shows as
     * a stub with a rounded cap on it: a point is carried
     * on beyond each end, along the slope it already had, and the view box
     * clips what falls outside. These are drawing only — the price's own first
     * and last points do not move, and the ride still starts and stops on them
     * (riderTrack trims to them). */
    const BLEED = 60, LIFT = 18;
    const lean = (a, b) => Math.max(-LIFT, Math.min(LIFT,
      (b.y - a.y) / ((b.x - a.x) || 1) * BLEED));
    const first = pts[0], second = pts[1] || pts[0];
    const far = pts[pts.length - 1], near = pts[pts.length - 2] || far;
    pts = [{ x: first.x - BLEED, y: first.y - lean(first, second) }]
      .concat(pts, [{ x: far.x + BLEED, y: far.y + lean(near, far) }]);
    const ENDS = 1;                      // how many drawn points at each end are bleed

    const f = n => n.toFixed(1);
    let d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ' C' + f(p1.x + (p2.x - p0.x) / 6) + ' ' + f(p1.y + (p2.y - p0.y) / 6)
         + ',' + f(p2.x - (p3.x - p1.x) / 6) + ' ' + f(p2.y - (p3.y - p1.y) / 6)
         + ',' + f(p2.x) + ' ' + f(p2.y);
    }
    const diff = rows[rows.length - 1].c - rows[0].c;
    const mag = Math.abs(diff);
    const money = Math.round(mag).toLocaleString('en-US');
    const real = pts.slice(ENDS, pts.length - ENDS);
    return { d: d, y: real[real.length - 1].y, t: (diff >= 0 ? '+' : '-') + '$ ' + money + ' ' + label,
      pts: real.map(p => ({ x: p.x / 402 * 100, y: p.y / 92 * 100 })) };
  }

  // the price line, drawn from whatever the gated feed last reported
  /* The live price.
   *
   * This was a WebSocket straight to Coinbase, opened before the gate had
   * decided anything and reconnected every three seconds for the life of the
   * app. A socket is not a fetch, so it survived every sweep that moved the
   * other requests behind the tunnel.
   *
   * Now it polls through the wallet, which asserts the tunnel and walks the
   * same six sources as everything else. Twenty seconds instead of every
   * trade — a ticker that updates on the second is not worth a company
   * watching the app run.
   */
  openFeed() {
    if (this.props.startStatic || this._feedT) return;
    const tick = () => {
      const W = window.FoxyWallet;
      if (!W || !W.rate) return;
      W.rate().then(p => {
        if (isFinite(p) && p > 0) this.setState({ livePrice: p, feedLive: true });
      }).catch(() => this.setState({ feedLive: false }));
    };
    tick();
    this._feedT = setInterval(tick, 20000);
  }

  closeFeed() {
    if (this._feedT) { clearInterval(this._feedT); this._feedT = null; }
    this.setState({ feedLive: false });
  }

  // walks the bolt marker along the chart curve, spinning as it travels

  /* He does not stop on the line: the ride carries him off the right edge and
   * that is where he waits for the next one. Hidden rather
   * than merely placed outside, since a marker parked past the panel's edge is
   * a page that can be scrolled sideways; the ride shows him again.
   *
   * Also the answer when there is nothing to ride yet — no line drawn, no
   * geometry — so a chart with no rider on it is the resting state either way. */
  /* Snow on the home screen, the same weather as the launch. Each flake is three nested divs — one falls, one sways, one
   * fades — so a handful of CSS animations carry the lot and nothing is driven
   * from JavaScript once they are made.
   *
   * Depth is what makes it read: a flake near the front is bigger, faster and
   * brighter than one behind it. The count is taken from the screen's width,
   * not fixed, because these frames are spent on a phone that is also drawing
   * a price line and, at launch, talking to Tor.
   */
  SNOW_KEYFRAMES = '@keyframes foxySnowFall{0%{transform:translate3d(0,-40px,0)}'
    + '100%{transform:translate3d(var(--drift),var(--fallTo,900px),0)}}'
    + '@keyframes foxySnowSway{0%,100%{transform:translateX(calc(var(--sway) * -1))}'
    + '50%{transform:translateX(var(--sway))}}'
    + '@keyframes foxySnowFade{0%{opacity:0}8%{opacity:var(--op)}88%{opacity:var(--op)}100%{opacity:0}}'
    + '[data-snow] i{position:absolute;top:0;display:block;will-change:transform;'
    + 'animation:foxySnowFall linear infinite}'
    + '[data-snow] i>i{width:100%;height:100%;animation:foxySnowSway ease-in-out infinite}'
    + '[data-snow] i>i>i{width:100%;height:100%;border-radius:50%;opacity:0;'
    + 'background:radial-gradient(circle at 34% 30%,#FFF 0%,#E4EEF6 45%,rgba(190,212,230,.55) 100%);'
    + 'animation:foxySnowFade linear infinite}'
    /* And where it lands on something, it settles. The panel on the home
     * screen has a top edge, round at both corners, for the snow to gather on
     * (`data-snow-cap`, in the markup at the top of the panel): a drift that
     * rises along the edge and clumps that swell on it, each on its own
     * clock, and a band across the whole width that creeps down round both
     * corners to where they end. From nothing to settled in about half a
     * minute, once, and it stays until the screen is left. */
    + '@keyframes foxySnowPile{0%{transform:scale(.9,0)}100%{transform:scale(1,1)}}'
    + '@keyframes foxySnowClump{0%{transform:scale(0)}100%{transform:scale(1)}}'
    + '@keyframes foxySnowDrape{0%{clip-path:inset(-3cqw -3cqw 100% -3cqw)}100%{clip-path:inset(-3cqw -3cqw -1cqw -3cqw)}}'
    + '@media (prefers-reduced-motion: reduce){[data-snow],[data-snow-cap]{display:none}}';

  /* Snow that settles (`data-snow-cap`) is held at nothing while the launch
   * screen is in front and started when it lifts: gathered where nobody
   * could see it, it has already fallen by the time they can. Nothing is
   * written to the page; the clocks themselves are held and let go. */
  syncSnowCap() {
    const G = window.FoxyGate;
    const covered = !!(G && G.visible && G.visible());
    if (!covered && !this._snowCapHeld) return;          // falling or settled: left alone
    /** @type {Animation[]} */
    const clocks = [];
    document.querySelectorAll('[data-snow-cap], [data-snow-cap] i').forEach((el) => {
      if (el.getAnimations) el.getAnimations().forEach((a) => clocks.push(a));
    });
    this._snowCapHeld = covered;
    clocks.forEach((a) => {
      try { a.currentTime = 0; if (covered) a.pause(); else a.play(); } catch (e) {}
    });
  }

  syncSnow() {
    this.syncSnowCap();
    const layer = document.querySelector('[data-snow="home"]');
    if (!layer || layer.firstChild) return;            // made once, then left alone
    if (!this._snowCss) {
      const sheet = document.createElement('style');
      sheet.textContent = this.SNOW_KEYFRAMES;
      document.head.appendChild(sheet);
      this._snowCss = true;
    }
    const wide = Math.max(320, window.innerWidth || 390);
    const count = Math.min(60, Math.round(wide / 9));
    const fallTo = Math.max(900, (window.innerHeight || 800) + 80);
    /* Scattered from a fixed seed rather than Math.random: the same weather
     * every time, which is how the render snapshots can hold it at all — with
     * real randomness every recording differed from the last. Nobody can tell
     * a seeded snowfall from a random one. */
    let seed = 20260919;
    const roll = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const frag = document.createDocumentFragment();
    for (let n = 0; n < count; n++) {
      const deep = Math.pow(roll(), 1.7);               // 0 far … 1 near
      const size = 1.6 + deep * 5.4;
      const fall = (22 - deep * 12 + roll() * 6).toFixed(2) + 's';
      const late = (-roll() * 26).toFixed(2) + 's';
      const outer = document.createElement('i');
      outer.style.cssText = 'left:' + (roll() * 102 - 1).toFixed(2) + '%;'
        + 'width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1) + 'px;'
        + '--drift:' + ((roll() * 2 - 1) * (20 + deep * 70)).toFixed(0) + 'px;'
        + '--fallTo:' + fallTo + 'px;animation-duration:' + fall + ';animation-delay:' + late + ';';
      const mid = document.createElement('i');
      mid.style.cssText = '--sway:' + (4 + deep * 14).toFixed(0) + 'px;'
        + 'animation-duration:' + (3.4 + roll() * 4.6).toFixed(2) + 's;animation-delay:' + late + ';';
      const dot = document.createElement('i');
      dot.style.cssText = '--op:' + (0.3 + deep * 0.65).toFixed(2) + ';'
        + 'box-shadow:0 0 ' + (2 + deep * 6).toFixed(0) + 'px rgba(207,224,236,.5);'
        + 'animation-duration:' + fall + ';animation-delay:' + late + ';';
      mid.appendChild(dot); outer.appendChild(mid); frag.appendChild(outer);
    }
    layer.appendChild(frag);
  }

  /* Keeping him away.
   *
   * markerGone sets the marker's own style, and the renderer writes the
   * template's style over it on the next draw — which put him back at the end
   * of the line, mid-screen, a beat after he had left. So
   * the update pass asks for it again whenever he is not riding. It sets two
   * properties and reads nothing; doing it every draw costs nothing. */
  markerStayGone() {
    const el = this._marker;
    if (!el || this._riding) return;
    if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
  }

  markerGone() {
    const el = this._marker;
    if (!el) return false;
    cancelAnimationFrame(this._mraf);
    this._riding = false;
    this.riderLinesOff();
    el.style.visibility = 'hidden';
    el.style.left = '100%';
    el.style.top = '50%';
    el.style.transform = 'rotate(0deg)';
    const body = el.querySelector('[data-rider="body"]');
    const armsWrap = el.querySelector('[data-rider="armswrap"]');
    const arms = el.querySelector('[data-rider="arms"]');
    if (body) body.style.transform = 'translate(-50%,-100%)';
    if (armsWrap) armsWrap.style.transform = 'translate(-50%,-100%)';
    if (arms) arms.style.transform = 'rotate(0deg)';
    return true;
  }

  /* The rider coming in along the price line.
   *
   * The motion is the coaster from an earlier sketch, kept as it was
   * there and made to happen once: gravity, so it gathers speed into a dip and
   * eases up the far side; squash and stretch on a spring, so it lands heavy
   * and overshoots; a lean into a drop before the track falls away; and arms
   * that lag the turns and whip on a landing before settling. What is not kept
   * is the loop — it rides in from behind the left edge and stops at the end
   * of the line, where the coin used to park.
   *
   * It runs faster than the sketch did (three times, then
   * slower again twice over — it has to cross the line at a pace that reads as
   * riding rather than as a jump cut), and the
   * sketch's emphasis lines come with it: air streaks off the rider's face
   * wherever the line is fast, and a small burst kicked off the rail when a
   * dip bottoms out. Both are drawn from the same gravity speed the motion
   * uses, so they appear where the ride is actually quick and nowhere else.
   */
  RIDE_MS = 7000;
  RIDE_IN_PX = 48;        // starts this far behind the line's left end
  /* 90 left about 30px of him still on screen at the moment he vanished,
   * so the ride ended with a blink rather than an exit. He now rolls clear of the edge before he is reset. */
  RIDE_OUT_PX = 120;      // and carries this far past its right end, off the screen

  /* The rider: a drawing of twelve frames in one sheet, six across and two
   * down (Web/foxy-rider.webp).
   *
   * He bobs on his sled in the drawing; everything else about the ride — the
   * lean into a slope, the squash through a dip, the stretch over a crest —
   * is done here, to the same gravity the character before him had.
   *
   * The frames are cut out of a longer drawing (151 frames, six
   * seconds, which does not loop). The first cut was chosen for how cleanly it
   * came back to its start, and it barely moved: a twelfth of the drawing
   * changed from one frame to the next, which at this size is a still picture. These frames move three times as much.
   *
   * They are played there and back rather than round and round. A stretch with
   * real movement in it does not happen to end where it began, and looping it
   * put a jump three times the size of a normal step into every cycle; a bob
   * reverses perfectly well, so going back through the frames costs nothing
   * and leaves no seam at all.
   *
   * His runners sit on the same line in every frame, which is why the bottom
   * of the drawing is what is held to the price line.
   *
   * RIDE_W_PX is the only number to change to make him bigger or smaller; his
   * height follows the sheet's own proportions. */
  /* The whole drawing now: every one of its 151 frames, played forward at
   * its own 25 fps and looped ("the gif should be 6s
   * long, 25fps"). Thirteen across, twelve down. */
  SLED_COLS = 13;
  SLED_ROWS = 12;
  SLED_FRAMES = 151;
  SLED_CYCLE_MS = 6040;     // the drawing's own length, forward, round and round
  SLED_FRAME_W = 228;       // one frame in the sheet
  SLED_FRAME_H = 116;       // the car: wide and low
  RIDE_W_PX = 160;          // how wide it rides (25% up from 128)
  RIDE_G = 2.2;           // gravity: how much faster a dip is than a crest
  /* No squash and no stretch for the car: the drawing bumps enough on its
   * own, and a car pressed flat through a dip is a car the wrong shape. The spring is still there, at zero. */
  RIDE_SQUASH_GAIN = 0;
  RIDE_SQUASH_MAX = 0;
  RIDE_SQUASH_K = 0.22;   // spring stiffness
  RIDE_SQUASH_DAMP = 0.72;
  RIDE_STRETCH = 0;       // stretch along travel as it speeds up: none, for the car
  RIDE_LEAN_GAIN = 0.5;
  RIDE_LEAN_MAX = 15;     // degrees
  RIDE_ARM_K = 0.12;
  RIDE_ARM_DAMP = 0.84;
  RIDE_ARM_DRIVE = 1.3;
  RIDE_ARM_IMPACT = 42;
  RIDE_ARM_MAX = 42;      // degrees
  /* The emphasis lines, in the sketch's numbers scaled to this rider: its cart
   * is 62px wide and this one is 75, so the offsets and
   * lengths go up by a fifth. Speeds are the gravity speed (1 at a crest,
   * 1 + RIDE_G in a dip) and never needed scaling. */
  RIDE_LINE_MIN = 1.7;    // no air lines slower than this
  RIDE_LINE_LEN = 16;     // streak length per unit of speed
  RIDE_LINE_RATE = 30;    // streaks a second at speed
  RIDE_LINE_FACE = 27;    // they leave the rider's face, not the rail
  RIDE_LINE_LIFE = 0.26;  // seconds before one has faded
  RIDE_IMPACT_MIN = 1.45; // a landing slower than this kicks up nothing

  /* The line in the marker's own pixel space, with an arc-length walk and the
   * gravity warp: travel time integrates 1/speed, so equal steps of phase are
   * short where the line is high and long where it dips. */
  riderTrack(el) {
    const path = el.parentElement && el.parentElement.querySelector('path');
    if (!path || !path.getTotalLength) return null;
    let len = 0;
    try { len = path.getTotalLength(); } catch (e) { return null; }
    const box = el.parentElement.getBoundingClientRect();
    if (!len || !box.width || !box.height) return null;

    /* Sampled across the drawn path, then cut back to the price's own ends: the
     * line is drawn past both edges of the screen so neither end shows, and he
     * would otherwise ride in from off-screen only to park off it. */
    const walk = [];
    for (let i = 0; i <= 240; i++) {
      const p = path.getPointAtLength((i / 240) * len);
      walk.push({ x: p.x / 402 * box.width, y: p.y / 92 * box.height });
    }
    const pts = [];
    let s = 0, px = 0, py = 0, yTop = Infinity, yBot = -Infinity;
    walk.forEach((p, i) => {
      if (i > 0) s += Math.hypot(p.x - px, p.y - py);
      pts.push({ s: s, x: p.x, y: p.y });
      px = p.x; py = p.y;
      if (p.y < yTop) yTop = p.y;
      if (p.y > yBot) yBot = p.y;
    });
    const total = s, range = (yBot - yTop) || 1;
    // in behind the left edge, along the whole drawing, and out past the right
    const whole = this.RIDE_IN_PX + total + this.RIDE_OUT_PX;
    const yOf = q => {
      if (q <= this.RIDE_IN_PX) return pts[0].y;
      const d = Math.min(q - this.RIDE_IN_PX, total);
      let j = 1;
      while (j < pts.length - 1 && pts[j].s < d) j++;
      const a = pts[j - 1], b = pts[j];
      return a.y + (b.y - a.y) * ((d - a.s) / ((b.s - a.s) || 1));
    };
    const speedAt = y => 1 + this.RIDE_G * ((y - yTop) / range);
    const warp = [];
    let time = 0, prev = 0;
    for (let i = 0; i <= 256; i++) {
      const q = (i / 256) * whole;
      if (i > 0) time += (q - prev) / speedAt(yOf((q + prev) / 2));
      warp.push({ s: q, t: time });
      prev = q;
    }
    const last = warp[warp.length - 1].t || 1;
    warp.forEach(o => { o.t /= last; });
    return { pts, total, yTop, range, whole, warp, box, yOf, speedAt };
  }

  /* The pool the emphasis lines are drawn from: eighteen thin divs in a layer
   * of their own, behind the rider and in the same pixel space, made once and
   * reused. The template leaves the layer empty, so nothing the renderer draws
   * is disturbed; a redraw that replaces the layer is noticed by identity and
   * the pool is made again. */
  riderLines(el) {
    const layer = el.parentElement
      && el.parentElement.querySelector('[data-rider="streaks"]');
    if (!layer) return null;
    if (this._streaks && this._streaks.layer === layer) return this._streaks;
    layer.textContent = '';
    const pool = [];
    for (let i = 0; i < 18; i++) {
      const line = document.createElement('div');
      /* The colour comes from the theme's own ink token rather than being
       * composed with rgba(var(...)), which is a substitution some engines
       * drop on the floor — and a line that is there but paints nothing looks
       * exactly like a line that was never made. */
      line.style.cssText = 'position:absolute;left:0;top:0;height:1.5px;border-radius:1px;'
        + 'background:linear-gradient(to right,transparent,var(--ink) 30%,'
        + 'var(--ink) 70%,transparent);opacity:0;pointer-events:none;'
        + 'transform-origin:center;will-change:left,top,opacity,transform';
      layer.appendChild(line);
      pool.push({ el: line, life: 0, max: this.RIDE_LINE_LIFE, op0: 0.5 });
    }
    this._streaks = { layer: layer, pool: pool };
    return this._streaks;
  }

  // one line, placed and lit; the ride fades it over the life it is given
  riderLine(stk, x, y, len, angle, op, life) {
    stk.el.style.width = len.toFixed(1) + 'px';
    stk.el.style.left = x.toFixed(1) + 'px';
    stk.el.style.top = y.toFixed(1) + 'px';
    stk.el.style.transform = 'translate(-50%,-50%) rotate(' + angle.toFixed(1) + 'deg)';
    stk.el.style.opacity = String(op);
    stk.life = life;
    stk.max = life;
    stk.op0 = op;
  }

  // the lines already out there, a frame older
  riderFade(lines, dt) {
    if (!lines) return;
    lines.pool.forEach(stk => {
      if (stk.life <= 0) return;
      stk.life -= dt;
      stk.el.style.opacity = (Math.max(0, stk.life) / stk.max * stk.op0).toFixed(3);
    });
  }

  /* Air off the face, at a rate set by how far over the floor the speed is:
   * nothing above a crest, a stream through a dip. `bag` carries the fraction
   * of a line left over between frames, so a slow frame is not a gap. */
  riderAir(lines, bag, cx, cy, ang, speed, dt) {
    if (!lines || speed <= this.RIDE_LINE_MIN) return;
    const rad = ang * Math.PI / 180;
    const tx = Math.cos(rad), ty = Math.sin(rad);    // along the travel
    const ux = Math.sin(rad), uy = -Math.cos(rad);   // the rider's own up
    const faceX = cx + ux * this.RIDE_LINE_FACE;
    const faceY = cy + uy * this.RIDE_LINE_FACE;
    bag.spawn += dt * (speed - this.RIDE_LINE_MIN) * this.RIDE_LINE_RATE;
    while (bag.spawn >= 1) {
      bag.spawn -= 1;
      const stk = lines.pool.find(one => one.life <= 0);
      if (!stk) break;
      const back = 6 + Math.random() * 10;           // a little behind the face
      const off = (Math.random() * 2 - 1) * 11;      // spread around face level
      const long = Math.max(13, Math.min(45, speed * this.RIDE_LINE_LEN));
      this.riderLine(stk, faceX - tx * back + ux * off,
        faceY - ty * back + uy * off, long, ang, 0.5, this.RIDE_LINE_LIFE);
    }
  }

  // three kicked off the rail: straight down, and splayed either side
  riderImpact(lines, cx, cy) {
    if (!lines) return;
    [[0, 90], [-7, 116], [7, 64]].forEach(hit => {
      const stk = lines.pool.find(one => one.life <= 0);
      if (!stk) return;
      this.riderLine(stk, cx + hit[0] + (Math.random() * 2 - 1) * 2, cy + 4,
        12 + Math.random() * 5, hit[1], 0.65, 0.2);
    });
  }

  // every line out: the ride is over, or there is no ride to draw
  riderLinesOff() {
    if (!this._streaks) return;
    this._streaks.pool.forEach(stk => { stk.life = 0; stk.el.style.opacity = '0'; });
  }

  /* The launch screen is the native-side cover over the whole page, and the
   * home screen is drawn behind it while it is still up. A ride started there
   * plays out unseen and the first thing the person gets is an empty line — so
   * the ride waits for the cover to come down, and the wait is a poll because
   * the gate announces nothing. */
  riderCovered() {
    const G = window.FoxyGate;
    return !!(G && G.visible && G.visible());
  }

  riderWhenSeen() {
    clearTimeout(this._rideWait);
    const tick = () => {
      this._rideWait = null;
      if (!this._marker || this.state.screen !== 'home') return;
      if (this.riderCovered()) { this._rideWait = setTimeout(tick, 250); return; }
      this._rolled = this.riderShow();
    };
    this._rideWait = setTimeout(tick, 250);
  }

  /* One attempt at a ride, and the answer is whether one actually started.
   *
   * This exists because of what it replaced: `markerRoll() || markerGone()`,
   * where the fallback always answers true. A cold launch has no price line
   * for a second or two, so the first attempt could not ride — and the true
   * from putting him away was recorded as "he has ridden", which is why the
   * he was never seen on a first launch. The series landing
   * afterwards found the ride already marked done.
   *
   * So: he is put out of sight when there is nothing to ride, and the caller
   * is told no, which leaves the next update free to try again. */
  riderShow() {
    const rode = this.markerRoll();
    if (!rode) this.markerGone();
    return rode;
  }

  /* Size the rider and scale the sheet behind him, once per ride.
   *
   * The sheet holds twelve frames; sizing the background to the whole grid is
   * what lets a percentage background-position land on exact frame edges in
   * sledFrame below. */
  sledLayout(body) {
    if (!body) return;
    const W = this.RIDE_W_PX;
    body.style.width = W.toFixed(2) + 'px';
    body.style.height = (W * this.SLED_FRAME_H / this.SLED_FRAME_W).toFixed(2) + 'px';
    body.style.backgroundSize = (100 * this.SLED_COLS).toFixed(0) + '% '
      + (100 * this.SLED_ROWS).toFixed(0) + '%';
  }

  /* Frame `fr` of the sheet.
   *
   * A percentage background-position places p% of the image against p% of the
   * element, so with the sizing above each frame lands on an exact boundary:
   * the columns divide 100% into COLS-1 steps, the rows into ROWS-1. */
  sledFrame(body, fr) {
    if (!body) return;
    const col = fr % this.SLED_COLS, row = Math.floor(fr / this.SLED_COLS);
    body.style.backgroundPosition =
      (col * (100 / (this.SLED_COLS - 1))).toFixed(4) + '% '
      + (row * (100 / (this.SLED_ROWS - 1))).toFixed(4) + '%';
  }

  markerRoll() {
    const el = this._marker;
    if (!el) return false;
    if (this.riderCovered()) { this.riderWhenSeen(); return false; }
    const body = el.querySelector('[data-rider="body"]');
    const armsWrap = el.querySelector('[data-rider="armswrap"]');
    const arms = el.querySelector('[data-rider="arms"]');
    const track = this.riderTrack(el);
    /* The sled team has no separate arms — they are drawn into its sheet.
     * This used to refuse to ride at all without them. */
    if (!track || !body) return false;
    this.sledLayout(body);

    cancelAnimationFrame(this._mraf);
    this._riding = true;
    el.style.visibility = 'visible';
    const lines = this.riderLines(el);
    this.riderLinesOff();
    const pts = track.pts, N = pts.length - 1;
    const first = pts[0], lastPt = pts[N];
    const dx0 = pts[1].x - first.x, dy0 = pts[1].y - first.y;
    const inLen = Math.hypot(dx0, dy0) || 1;
    const inDir = { x: dx0 / inLen, y: dy0 / inLen };
    const startAng = Math.atan2(dy0, dx0) * 180 / Math.PI;
    const dxN = lastPt.x - pts[N - 1].x, dyN = lastPt.y - pts[N - 1].y;
    const outLen = Math.hypot(dxN, dyN) || 1;
    const outDir = { x: dxN / outLen, y: dyN / outLen };
    const endAng = Math.atan2(dyN, dxN) * 180 / Math.PI;

    let squash = 0, squashV = 0, lean = 0, armA = 0, armV = 0;
    let lastAng = null, lastSquash = 0, lastFrame = -1;
    let prevCy = null, prevVy = 0;
    const bag = { spawn: 0 };
    const t0 = performance.now();
    let lastNow = t0;

    /* The line at a distance along the ride: before it, on it, or past its
     * end. Both halves ask this, each for its own point, which is what lets
     * them sit at different heights and angles at the same moment. */
    const at = along => {
      if (along < this.RIDE_IN_PX) {
        const back = this.RIDE_IN_PX - along;
        return { x: first.x - inDir.x * back, y: first.y - inDir.y * back, ang: startAng };
      }
      if (along > this.RIDE_IN_PX + track.total) {
        const out = along - this.RIDE_IN_PX - track.total;
        return { x: lastPt.x + outDir.x * out, y: lastPt.y + outDir.y * out, ang: endAng };
      }
      const d = Math.min(along - this.RIDE_IN_PX, track.total);
      let j = 1;
      while (j < N && pts[j].s < d) j++;
      const p0 = pts[j - 1], p1 = pts[j];
      const f = (d - p0.s) / ((p1.s - p0.s) || 1);
      return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f,
               ang: Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI };
    };

    const step = now => {
      const raw = Math.min(1, (now - t0) / this.RIDE_MS);
      // phase through the gravity warp: distance, not time, is what eases
      let i = 1;
      while (i < track.warp.length && track.warp[i].t < raw) i++;
      const a = track.warp[i - 1], b = track.warp[i] || a;
      const along = a.s + (b.s - a.s) * ((raw - a.t) / ((b.t - a.t) || 1));

      let cx, cy, ang = startAng, target = 0, leanTo = 0, onLine = false;
      if (along < this.RIDE_IN_PX) {
        const back = this.RIDE_IN_PX - along;
        cx = first.x - inDir.x * back;
        cy = first.y - inDir.y * back;
      } else if (along > this.RIDE_IN_PX + track.total) {
        // off the end of the drawing, still going, on the heading he had
        const out = along - this.RIDE_IN_PX - track.total;
        cx = lastPt.x + outDir.x * out;
        cy = lastPt.y + outDir.y * out;
        ang = endAng;
      } else {
        onLine = true;
        const d = Math.min(along - this.RIDE_IN_PX, track.total);
        let j = 1;
        while (j < N && pts[j].s < d) j++;
        const p0 = pts[j - 1], p1 = pts[j];
        const f = (d - p0.s) / ((p1.s - p0.s) || 1);
        cx = p0.x + (p1.x - p0.x) * f;
        cy = p0.y + (p1.y - p0.y) * f;
        ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
        // a dip squashes, a crest stretches: the curve either side of here
        const look = Math.min(Math.max(track.total * 0.04, 6), 40);
        const curve = track.yOf(this.RIDE_IN_PX + d - look)
          + track.yOf(this.RIDE_IN_PX + d + look) - 2 * cy;
        target = Math.max(-this.RIDE_SQUASH_MAX,
          Math.min(this.RIDE_SQUASH_MAX, -curve * this.RIDE_SQUASH_GAIN));
        // and it leans back at a crest, just before the track drops away
        const ahead = Math.max(Math.min(track.total * 0.10, 60), 12);
        const drop = track.yOf(this.RIDE_IN_PX + d + ahead) - cy;
        const fallen = cy - track.yOf(this.RIDE_IN_PX + d - ahead);
        leanTo = Math.max(-this.RIDE_LEAN_MAX,
          Math.min(this.RIDE_LEAN_MAX, (drop - fallen) * this.RIDE_LEAN_GAIN));
      }

      const speed = track.speedAt(cy);
      const stretch = (speed - 1) * this.RIDE_STRETCH;
      squashV = squashV * this.RIDE_SQUASH_DAMP + (target - squash) * this.RIDE_SQUASH_K;
      squash = Math.max(-0.85, Math.min(0.85, squash + squashV));
      const sx = (1 + squash * 0.7) * (1 + stretch);
      const sy = Math.max(0.12, Math.min(2, (1 - squash) / (1 + stretch)));
      lean += (leanTo - lean) * 0.18;
      const bodyAng = ang - lean;

      let turn = bodyAng - (lastAng === null ? bodyAng : lastAng);
      if (turn > 180) turn -= 360; else if (turn < -180) turn += 360;
      lastAng = bodyAng;
      const landed = squash - lastSquash;
      lastSquash = squash;
      armV = armV * this.RIDE_ARM_DAMP + (0 - armA) * this.RIDE_ARM_K
        + (-turn * this.RIDE_ARM_DRIVE - landed * this.RIDE_ARM_IMPACT);
      armA = Math.max(-this.RIDE_ARM_MAX, Math.min(this.RIDE_ARM_MAX, armA + armV));

      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.transform = 'rotate(' + bodyAng.toFixed(2) + 'deg)';
      const shape = 'translate(-50%,-100%) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
      body.style.transform = shape;

      // the drawing on its own clock: forward through every frame, and round again
      const fr = Math.floor(((now - t0) % this.SLED_CYCLE_MS) / this.SLED_CYCLE_MS * this.SLED_FRAMES) % this.SLED_FRAMES;
      if (fr !== lastFrame) {
        lastFrame = fr;
        this.sledFrame(body, fr);
      }
      if (armsWrap) armsWrap.style.transform = shape;
      if (arms) arms.style.transform = 'rotate(' + armA.toFixed(2) + 'deg)';

      /* The emphasis lines. Both read the same gravity speed the motion does,
       * so they mark where the ride is quick rather than being sprinkled. */
      const dt = Math.max(0, Math.min(0.05, (now - lastNow) / 1000));
      lastNow = now;
      this.riderFade(lines, dt);
      if (onLine) {
        this.riderAir(lines, bag, cx, cy, ang, speed, dt);
        // the bottom of a dip: where the falling turns into climbing
        const vy = cy - (prevCy === null ? cy : prevCy);
        if (prevVy > 0.15 && vy <= 0.15 && speed > this.RIDE_IMPACT_MIN) {
          this.riderImpact(lines, cx, cy);
        }
        prevVy = vy;
        prevCy = cy;
      }

      if (raw < 1) { this._mraf = requestAnimationFrame(step); return; }
      // through, and away: the last of the ride is off the right of the screen
      this.markerGone();
    };
    this._mraf = requestAnimationFrame(step);
    return true;
  }
