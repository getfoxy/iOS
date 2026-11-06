  /* ---- the fox: the wait while a fee is checked or money moves (the design's 1j) ----------------------------------
   *
   * The keeper, 2026-11-06: shown at any time a fee is being checked or pieces are being moved, the percentage
   * intelligent and the fox's motion timed to it; the video played frame by frame along with the progress, so when the
   * progress slows the fox slows.
   *
   *   the screen ...... black, the title (on one line, made smaller where the phone is narrow), the percentage in the
   *                     accent, the fox across the middle blended onto the black, CANCEL at the foot only where the
   *                     wait can be cancelled. A stage screen (`stageScreen` with `o.fox`), so `hideStage(kind)`,
   *                     `stageUp(kind)` and the wait's own time limit work as they do for every other stage. It is not
   *                     a layer of its own: a later stage screen replaces it, which no caller does while money moves
   *                     (the money-is-safe card waits its turn, 11-cards.js), and `foxEnd` then finds nothing to end.
   *   the figure ...... each flow says its real steps (`foxStep`), and FOX_FLOWS turns a step into the figure it heads
   *                     for. The figure eases toward it (`foxEase`), then creeps on toward halfway to the next step's,
   *                     paced by how long that step is expected to take (`foxCreep`): so a slow step slows the figure,
   *                     and the fox with it, without stopping it, and never reaches the next step's figure before that
   *                     step has happened. Never back, never a jump. Only the real end (`foxDone`) takes it to 100,
   *                     where the title says ALL SET for FOX_HOLD_MS before the screen comes down.
   *   the fox ......... foxy-wait.mp4 (tools/make-intro.swift --wait), never played: each frame the video is put on the
   *                     frame of the figure shown (`foxScrub`). Every frame of the file is a key frame, so each of
   *                     those seeks decodes one frame (3 ms in the simulator). Until the video has a frame of its own
   *                     its first frame shows, the fox asleep.
   *   Reduce Motion ... the figure still moves; the fox is put on the figure's frame only every tenth point, and at 100.
   *   in the background the video is paused, and it is let go of (`foxRelease`) when the screen comes down.
   */
  FOX_FLOWS = {
    // a quote being asked: the question, then its answer. `ms`: how long a step is expected to take.
    fee: { title: 'CHECKING THE FEE', start: 'asked', steps: { asked: 60 }, ms: { asked: 3000 } },
    /* pieces moved between mints or to a card: the quote asked, the mint answered, the pieces made, landed. The
     * wallet's own stage names (`moveRun`, `pay`) are read as these steps. */
    move: { title: 'MOVING YOUR MONEY', start: 'asked', steps: { asked: 25, answered: 45, made: 75, landed: 95 },
      ms: { asked: 3000, answered: 6000, made: 3000, landed: 3000 },
      wallet: { quote: 'asked', melting: 'answered', inflight: 'made', switching: 'made', claiming: 'landed' } },
    // a swap between the two balances at one mint (`swapRun`): the same steps, from its stage names
    swap: { title: 'MOVING YOUR MONEY', start: 'asked', steps: { asked: 25, answered: 45, made: 75, landed: 95 },
      ms: { asked: 2000, answered: 6000, made: 2000, landed: 3000 },
      wallet: { paying: 'answered', paid: 'made', claiming: 'landed', done: 'landed' } },
  };

  FOX_VIDEO = 'img/foxy-wait.mp4';
  FOX_POSTER = 'img/foxy-wait-first.png';
  // the video's length, for the moment before the page has read it
  FOX_VIDEO_S = 9.625;
  // the design's: 100 is this far through the video, the fox standing
  FOX_SHARE = 0.92;
  FOX_HOLD_MS = 400;

  /* The step `step` names in `flow` (a wallet stage name read as the step it is), or '' for one the flow does not have. */
  foxStepName(flow, step) {
    const f = this.FOX_FLOWS[flow] || this.FOX_FLOWS.fee;
    const named = (f.wallet && f.wallet[step]) || step;
    return typeof f.steps[named] === 'number' ? named : '';
  }

  /* The figure a step heads for in `flow`: a number, or null for a step the flow does not have. 'end' is 100. */
  foxTarget(flow, step) {
    if (step === 'end') return 100;
    const f = this.FOX_FLOWS[flow] || this.FOX_FLOWS.fee;
    const named = this.foxStepName(flow, step);
    return named ? f.steps[named] : null;
  }

  /* Where the figure aims `ms` into the step `step` of `flow`: the step's own figure, and from there on toward halfway
   * to the next step's (100 after the last), closing a share of what is left that grows with the time spent over
   * twice the step's expected length. Never past just under the next step's figure. */
  foxCreep(flow, step, ms) {
    const f = this.FOX_FLOWS[flow] || this.FOX_FLOWS.fee;
    const named = this.foxStepName(flow, step);
    if (!named) return 0;
    const at = f.steps[named];
    const above = Object.keys(f.steps).map((k) => f.steps[k]).filter((v) => v > at);
    const next = above.length ? Math.min.apply(null, above) : 100;
    const len = Math.max(500, Number(f.ms && f.ms[named]) || 3000);
    const t = Math.max(0, Number(ms) || 0);
    const room = Math.min((next - at) / 2, next - 1 - at);
    return at + room * (1 - Math.exp(-t / (2 * len)));
  }

  /* One frame of the figure: from `shown` toward `target`, `dtMs` after the last. Each frame covers a part of what is
   * left, at most 75 a second; the end (`ending`) goes faster, at most 180 a second, and arrives. A frame longer than
   * 50 ms counts as 50, so a page that was not drawn for a while does not leap when it is. */
  foxEase(shown, target, dtMs, ending) {
    const dt = Math.min(Math.max(Number(dtMs) || 0, 0), 50) / 1000;
    const gap = Number(target) - Number(shown);
    if (!(gap > 0)) return Number(shown);
    const k = ending ? 7 : 1.6;
    const cap = (ending ? 180 : 75) * dt;
    let next = Number(shown) + Math.min(gap * (1 - Math.exp(-k * dt)), cap);
    if (ending && Number(target) - next < 0.5) next = Number(target);
    return Math.min(next, Number(target));
  }

  /* The figure as it is written: whole numbers, and 100 only once it is there. */
  foxFigure(shown) {
    const n = Number(shown) || 0;
    return n >= 100 ? 100 : Math.max(0, Math.min(99, Math.floor(n)));
  }

  /* Where in the video the fox is at figure `pct`: pct / 100 × duration × 0.92, as the design has it. */
  foxScrub(pct, duration) {
    const d = Number(duration) > 0 && isFinite(Number(duration)) ? Number(duration) : this.FOX_VIDEO_S;
    return Math.max(0, Math.min(100, Number(pct) || 0)) / 100 * d * this.FOX_SHARE;
  }

  /* Up as the stage `kind` for `flow` (FOX_FLOWS), where stage screens can be drawn. `o.go` puts CANCEL at the foot,
   * `o.foxTitle` says something other than the flow's title, and `o.forMs` is how long it may stay up with nobody
   * taking it down. False where there is no stage to draw, or where another stage screen that is not a fox is up (a
   * card's own screen, say), which the fox does not take the place of: there the caller shows what it showed before. */
  foxUp(kind, flow, o) {
    if (!this.stageScreen || typeof document === 'undefined') return false;
    const el = document.getElementById('foxy-stage');
    if (el && el.getAttribute('data-stage') !== kind && !el.getAttribute('data-fox')) return false;
    this.stageScreen(kind, Object.assign({}, o || {}, { fox: flow }));
    return this.stageUp ? this.stageUp(kind) : true;
  }

  /* The title on one line: smaller, down to 20 px, while it does not fit. */
  foxFit(el) {
    if (!el) return;
    let size = 34;
    el.style.fontSize = size + 'px';
    while (size > 20 && el.scrollWidth > el.clientWidth + 1) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  /* The stage itself (`stageScreen` with `o.fox`). */
  foxStage(kind, o) {
    const flow = this.FOX_FLOWS[o.fox] ? o.fox : 'fee';
    const f = this.FOX_FLOWS[flow];
    const root = document.createElement('div');
    root.id = 'foxy-stage';
    root.setAttribute('data-stage', kind);
    root.setAttribute('data-fox', flow);
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;overflow:hidden;background:#050505;color:#FFFFFF;'
      + 'font-family:Sora,system-ui,sans-serif;animation:foxyIn .18s ease';
    const top = 'calc(env(safe-area-inset-top) + 125px)';
    root.innerHTML =
      '<div style="position:absolute;left:0;right:0;top:' + top + ';display:flex;flex-direction:column;align-items:center;'
      + 'gap:14px;text-align:center;padding:0 28px;box-sizing:border-box;z-index:1">'
      + '<div data-fox-title style="width:100%;white-space:nowrap;overflow:hidden;font-weight:800;font-size:34px;'
      + 'letter-spacing:.1em">' + (o.foxTitle || f.title) + '</div>'
      + '<div style="font-weight:800;font-size:76px;line-height:1;letter-spacing:-.04em;color:#EB6A2E;'
      + 'font-variant-numeric:tabular-nums"><span data-fox-pct>0</span>%</div></div>';
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const place = 'position:absolute;left:-20px;right:-20px;top:calc(env(safe-area-inset-top) + min(331px, 39vh));'
      + 'width:calc(100% + 40px);height:285px;object-fit:contain;mix-blend-mode:screen;pointer-events:none';
    let vid = document.createElement('video');
    vid.muted = true;
    vid.defaultMuted = true;
    vid.setAttribute('muted', '');
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    vid.setAttribute('disablepictureinpicture', '');
    vid.setAttribute('preload', 'auto');
    vid.setAttribute('poster', this.FOX_POSTER);
    vid.setAttribute('aria-hidden', 'true');
    vid.style.cssText = place;
    vid.src = this.FOX_VIDEO;
    /* Asked for at once: WebKit on a phone loads no more than a video's length for `preload` alone, and a seek on a
     * video with no frames waits for ever (seen in the simulator: the fox sat on its poster throughout). */
    try { vid.load(); } catch (e) {}
    // a file that will not load: the fox asleep, still, and the figure carries on
    vid.addEventListener('error', () => {
      if (!vid || !vid.parentNode) return;
      const img = document.createElement('img');
      img.setAttribute('alt', '');
      img.setAttribute('src', this.FOX_POSTER);
      img.style.cssText = place;
      vid.parentNode.replaceChild(img, vid);
      vid = null;
      if (this._fox && this._fox.root === root) this._fox.vid = null;
    });
    root.appendChild(vid);
    if (typeof o.go === 'function') {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 24px calc(40px + env(safe-area-inset-bottom))';
      const b = document.createElement('div');
      b.setAttribute('data-stage-button', '1');
      b.style.cssText = 'height:58px;border-radius:999px;border:2px solid #2E2E2E;background:#121212;display:flex;'
        + 'align-items:center;justify-content:center;font-weight:800;font-size:17px;letter-spacing:.08em;color:#FFFFFF;cursor:pointer';
      b.textContent = o.button || 'CANCEL';
      b.addEventListener('click', () => {
        this.hideStage(kind);
        o.go();
      });
      wrap.appendChild(b);
      root.appendChild(wrap);
    }
    document.body.appendChild(root);
    this.foxFit(root.querySelector('[data-fox-title]'));
    if (this.syncPreview) this.syncPreview();
    const fox = { kind, flow, root, vid, reduce, shown: 0, target: this.foxTarget(flow, f.start) || 0, step: f.start,
      stepAt: 0, ending: false, at: 0, figure: -1, held: false, still: -1 };
    // the video waits in the background, where nothing draws it
    fox.away = () => { if (document.hidden && fox.vid && !fox.vid.paused) fox.vid.pause(); };
    document.addEventListener('visibilitychange', fox.away);
    this._fox = fox;
    console.log('[foxy] screen: ' + kind + ', the fox (' + flow + ')');
    const tick = (now) => {
      if (!root.isConnected || this._fox !== fox) { this.foxRelease(root); return; }
      const dt = fox.at ? now - fox.at : 16;
      fox.at = now;
      if (!fox.stepAt) fox.stepAt = now;
      const aim = fox.ending ? 100 : Math.max(fox.target, this.foxCreep(flow, fox.step, now - fox.stepAt));
      fox.shown = this.foxEase(fox.shown, aim, dt, fox.ending);
      const fig = this.foxFigure(fox.shown);
      if (fig !== fox.figure) {
        fox.figure = fig;
        const p = root.querySelector('[data-fox-pct]');
        if (p) p.textContent = String(fig);
      }
      this.foxFollow(fox);
      if (fig >= 100 && !fox.held) {
        fox.held = true;
        const t = root.querySelector('[data-fox-title]');
        if (t) { t.textContent = 'ALL SET'; this.foxFit(t); }
        setTimeout(() => { if (root.isConnected) this.hideStage(kind); }, this.FOX_HOLD_MS);
        return;
      }
      fox.raf = requestAnimationFrame(tick);
    };
    fox.raf = requestAnimationFrame(tick);
    this._stageT = setTimeout(() => this.hideStage(kind), Number(o.forMs) || 100000);
  }

  /* The video on the frame of the figure shown. Not while a seek is still being made (the next frame asks again), and
   * not for less than half a frame. Under Reduce Motion only every tenth point, and 100. At 100 always, so ALL SET
   * shows the fox standing. */
  foxFollow(fox) {
    const v = fox.vid;
    if (!v || v.readyState < 1) return;
    if (fox.reduce) {
      const at = fox.figure >= 100 ? 100 : Math.floor(Math.max(0, fox.figure) / 10) * 10;
      if (at === fox.still) return;
      fox.still = at;
      try { v.currentTime = this.foxScrub(at, v.duration); } catch (e) {}
      return;
    }
    const want = this.foxScrub(fox.figure >= 100 ? 100 : fox.shown, v.duration);
    if (v.seeking && fox.figure < 100) return;
    if (Math.abs(v.currentTime - want) < 1 / 48) return;
    try { v.currentTime = want; } catch (e) {}
  }

  /* Let go of the fox's video when its screen comes down (`hideStage`): paused, its file dropped, no listener left. */
  foxRelease(root) {
    const fox = this._fox;
    if (!fox || (root && fox.root !== root)) return;
    if (fox.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fox.raf);
    if (fox.away) document.removeEventListener('visibilitychange', fox.away);
    const v = fox.vid;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    }
    fox.vid = null;
    this._fox = null;
  }

  /* The fox stage `kind`, if it is the one up. */
  foxOn(kind) {
    const fox = this._fox;
    return fox && fox.root && fox.root.isConnected && (!kind || fox.kind === kind) ? fox : null;
  }

  /* A step of the wait under `kind` has happened: the figure heads for that step's (never back). The wallet's stage
   * names are understood for the flows that have them. */
  foxStep(kind, step) {
    const fox = this.foxOn(kind);
    if (!fox || fox.ending) return false;
    const t = this.foxTarget(fox.flow, step);
    if (t == null || t <= fox.target) return false;
    fox.target = Math.min(t, 99);
    fox.step = this.foxStepName(fox.flow, step);
    fox.stepAt = 0;
    return true;
  }

  /* A listener for a wallet call's stages (`moveRun`, `swapRun`, `carryHome`), for the stage `kind`. */
  foxHears(kind, also) {
    return (st) => {
      this.foxStep(kind, st);
      if (typeof also === 'function') also(st);
    };
  }

  /* The real end: to 100, ALL SET, and down after FOX_HOLD_MS. False when that stage is not up. */
  foxDone(kind) {
    const fox = this.foxOn(kind);
    if (!fox) return false;
    fox.ending = true;
    fox.target = 100;
    return true;
  }

  /* The end of a wait that showed the fox: ALL SET where it `landed`, down at once where it did not. */
  foxEnd(kind, landed) {
    if (landed && this.foxDone(kind)) return;
    if (this.hideStage) this.hideStage(kind);
  }
