  /* The two full-screen loaders, drawn exactly as the design exports draw
   * them.
   *
   * The markup is lifted from those files rather than rewritten from a
   * description, because the loaders are to match the design exactly and a
   * reinterpretation is not that. The only changes are the
   * four the app forces: the screen fills the overlay instead of a phone frame,
   * a texture image that is not in the bundle is dropped (the ground reads the
   * same without it), the heading and the bill's two figures become
   * substitutions, and the CANCEL button is put in by the builder so a wait
   * with nothing safe to cancel can leave it out.
   *
   * Their keyframes live in the page's own stylesheet (build/markup.html), so
   * both loaders animate without a style element of their own.
   *
   * CONNECTING is the two phones and the dashes between them, for the moment
   * between the first buzz and the link being made. VERIFYING is the bill going
   * round, for every wait where money is the thing being waited on.
   */
  loaderConnecting() { return "<div style=\"position:relative;height:100%;overflow:hidden;display:flex;flex-direction:column;background:linear-gradient(170deg,#D3EDF4 0%,#C5E6EF 45%,#B5DDE9 80%,#A9D6E4 100%);color:#13333C\">\n\n      <div style=\"position:absolute;left:50%;top:44%;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,.75) 0%, rgba(255,255,255,0) 65%);animation:glowDrift 5s ease-in-out infinite;pointer-events:none\"></div>\n      \n\n      \n\n      <div style=\"position:relative;z-index:1;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px;padding:0 28px\">\n\n        <div style=\"position:relative;width:260px;height:150px;display:flex;align-items:center;justify-content:space-between\">\n\n          <div style=\"position:relative;width:72px;height:128px;animation:phoneBob 2.8s ease-in-out infinite\">\n            <div style=\"position:absolute;left:50%;top:50%;width:130px;height:130px;margin:-65px 0 0 -65px;border-radius:50%;border:2px solid rgba(19,51,60,.45);animation:wave 2.4s ease-out infinite\"></div>\n            <div style=\"position:absolute;left:50%;top:50%;width:130px;height:130px;margin:-65px 0 0 -65px;border-radius:50%;border:2px solid rgba(19,51,60,.45);animation:wave 2.4s ease-out .8s infinite\"></div>\n            <div style=\"position:absolute;left:50%;top:50%;width:130px;height:130px;margin:-65px 0 0 -65px;border-radius:50%;border:2px solid rgba(19,51,60,.45);animation:wave 2.4s ease-out 1.6s infinite\"></div>\n            <div style=\"position:relative;width:100%;height:100%;border-radius:16px;border:3px solid #13333C;background:rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center\">\n              <div style=\"position:absolute;top:7px;width:20px;height:4px;border-radius:2px;background:#13333C;opacity:.8\"></div>\n              <svg viewBox=\"0 0 24 24\" fill=\"none\" style=\"width:30px;height:30px\"><path d=\"M13.5 2.5 5.5 13.5h5.5l-1 8 8-11h-5.5z\" fill=\"#13333C\"></path></svg>\n            </div>\n          </div>\n\n          <div style=\"position:absolute;left:86px;right:86px;top:50%;height:12px;margin-top:-6px\">\n            <div style=\"position:absolute;left:0;right:0;top:5px;border-top:2px dashed rgba(19,51,60,.3)\"></div>\n            <div style=\"position:absolute;inset:0;animation:travel 1.6s cubic-bezier(.45,0,.55,1) infinite\"><div style=\"width:12px;height:12px;border-radius:50%;background:#13333C;box-shadow:0 0 12px rgba(255,255,255,.9)\"></div></div>\n            <div style=\"position:absolute;inset:0;animation:travel 1.6s cubic-bezier(.45,0,.55,1) .53s infinite\"><div style=\"width:12px;height:12px;border-radius:50%;background:#13333C;box-shadow:0 0 12px rgba(255,255,255,.9)\"></div></div>\n            <div style=\"position:absolute;inset:0;animation:travel 1.6s cubic-bezier(.45,0,.55,1) 1.06s infinite\"><div style=\"width:12px;height:12px;border-radius:50%;background:#13333C;box-shadow:0 0 12px rgba(255,255,255,.9)\"></div></div>\n          </div>\n\n          <div style=\"position:relative;width:72px;height:128px;border-radius:16px;border:3px solid #13333C;background:rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center;animation:receivePulse 1.6s ease-out infinite\">\n            <div style=\"position:absolute;top:7px;width:20px;height:4px;border-radius:2px;background:#13333C;opacity:.8\"></div>\n            <svg viewBox=\"0 0 24 24\" fill=\"none\" style=\"width:32px;height:32px\"><rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\" stroke=\"#13333C\" stroke-width=\"2\"></rect><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.5\" stroke=\"#13333C\" stroke-width=\"2\"></rect><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.5\" stroke=\"#13333C\" stroke-width=\"2\"></rect><path d=\"M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 18v2.5\" stroke=\"#13333C\" stroke-width=\"2\" stroke-linecap=\"round\"></path></svg>\n          </div>\n        </div>\n\n        <div style=\"display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center\">\n          <h1 style=\"margin:0;font-weight:800;font-size:30px;line-height:1.1;letter-spacing:-.01em;text-transform:uppercase;color:#13333C\">{{TITLE}}</h1>\n          <div style=\"display:flex;gap:8px\">\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out infinite\"></span>\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out .2s infinite\"></span>\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out .4s infinite\"></span>\n          </div>\n        </div>\n      </div>\n\n      {{CANCEL}}\n    </div>"; }

  loaderVerifying() { return "<div style=\"position:relative;height:100%;overflow:hidden;display:flex;flex-direction:column;background:linear-gradient(170deg,#D3EDF4 0%,#C5E6EF 45%,#B5DDE9 80%,#A9D6E4 100%);color:#13333C\">\n      <div style=\"position:absolute;left:50%;top:44%;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,.75) 0%, rgba(255,255,255,0) 65%);animation:glowDrift 5s ease-in-out infinite;pointer-events:none\"></div>\n      \n\n      \n\n      <div style=\"position:relative;z-index:1;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px;padding:0 28px\">\n        <div style=\"position:relative;width:240px;height:150px;display:flex;align-items:center;justify-content:center\">\n          <div style=\"position:absolute;left:50%;top:50%;width:230px;height:230px;margin:-115px 0 0 -115px;border-radius:50%;border:2px dashed rgba(19,51,60,.2);animation:orbit 18s linear infinite\"></div>\n          <div style=\"position:absolute;left:50%;top:50%;width:230px;height:230px;margin:-115px 0 0 -115px;animation:orbit 2.4s linear infinite\"><div style=\"position:absolute;left:50%;top:-6px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#13333C;box-shadow:0 0 12px rgba(255,255,255,.9)\"></div></div>\n\n          <div style=\"position:relative;width:200px;height:86px;animation:billFloat 3.2s ease-in-out infinite\">\n            <div style=\"position:absolute;inset:0;border-radius:8px;background:#FFFFFF;box-shadow:0 14px 30px rgba(19,51,60,.22);overflow:hidden\">\n              <div style=\"position:absolute;inset:5px;border-radius:5px;border:1.5px solid #2D6273;background:repeating-linear-gradient(135deg, rgba(45,98,115,.08) 0 2px, transparent 2px 6px)\"></div>\n              <div style=\"position:absolute;inset:10px;border-radius:3px;border:1px dashed rgba(45,98,115,.5)\"></div>\n              <div style=\"position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:1.5px solid #2D6273;background:#FFFFFF;display:flex;align-items:center;justify-content:center\">\n                <svg viewBox=\"0 0 24 24\" fill=\"none\" style=\"width:24px;height:24px\"><path d=\"M12 3v18M7 8h10M7 12h10M7 16h10\" stroke=\"#13333C\" stroke-width=\"2.4\" stroke-linecap=\"round\"></path></svg>\n              </div>\n              <div style=\"position:absolute;left:16px;top:14px;font-family:'Sora',sans-serif;font-weight:800;font-size:10px;letter-spacing:.08em;color:#13333C;;display:flex;align-items:center;gap:1px\"><svg viewBox=\"0 0 24 24\" fill=\"none\" style=\"width:11px;height:11px\"><path d=\"M12 3v18M7 8h10M7 12h10M7 16h10\" stroke=\"#13333C\" stroke-width=\"3\" stroke-linecap=\"round\"></path></svg>{{SATS}}</div>\n              <div style=\"position:absolute;right:16px;bottom:14px;font-family:'Sora',sans-serif;font-weight:800;font-size:10px;letter-spacing:.08em;color:#13333C;\">{{MINT}}</div>\n              <div style=\"position:absolute;left:0;right:0;height:18px;background:linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(191,227,236,.95) 50%, rgba(255,255,255,0) 100%);animation:scan 1.6s cubic-bezier(.45,0,.55,1) infinite alternate\"></div>\n            </div>\n          </div>\n        </div>\n\n        <div style=\"display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center\">\n          <h1 style=\"margin:0;font-weight:800;font-size:30px;line-height:1.1;letter-spacing:-.01em;text-transform:uppercase;color:#13333C\">{{TITLE}}</h1>\n          <div style=\"display:flex;gap:8px\">\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out infinite\"></span>\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out .2s infinite\"></span>\n            <span style=\"width:8px;height:8px;border-radius:50%;background:#13333C;animation:dot 1.4s ease-in-out .4s infinite\"></span>\n          </div>\n        </div>\n      </div>\n\n      {{CANCEL}}\n    </div>"; }

  /* ---- the waiting and the asking screens (from the design exports) ----
   *
   * One ground, one heading, one paragraph and
   * one button, with a piece of art or a code above them. They replace the
   * cards that used to say these things, because a card is a note over a
   * screen and each of these IS the screen for as long as it lasts — two
   * people are standing together and one of them is waiting on the other.
   *
   * Drawn from the exports' own markup. What the app changes: the texture is
   * the fur already in the bundle (snow-fur.jpg, the same picture), the code is
   * a real one, and the amount and the words are filled in.
   *
   * One at a time. `kind` names it, so whatever put one up can take down its
   * own and nothing else's.
   */
  STAGE_ART = {
    phone: '<div style="position:relative;width:72px;height:128px;border-radius:16px;border:3px dashed #13333C;background:rgba(255,255,255,.45);display:flex;align-items:center;justify-content:center;animation:offlineFade 2.4s ease-in-out infinite">'
      + '<div style="position:absolute;top:7px;width:20px;height:4px;border-radius:2px;background:#13333C;opacity:.8"></div>'
      + '<div style="position:relative;width:34px;height:34px;border-radius:50%;border:3px solid #13333C">'
      + '<div style="position:absolute;left:50%;top:50%;width:3px;height:10px;margin:-10px 0 0 -1.5px;border-radius:2px;background:#13333C;transform-origin:50% 100%;animation:hand 3s linear infinite"></div>'
      + '<div style="position:absolute;left:50%;top:50%;width:3px;height:7px;margin:-7px 0 0 -1.5px;border-radius:2px;background:#13333C;transform-origin:50% 100%;transform:rotate(90deg)"></div>'
      + '</div></div>',
    /* A card held to the phone: its outline, its chip, and the contactless
     * mark breathing beside it (the FLASHCARD screens, 26f-flashcard.js). */
    card: '<div style="position:relative;width:150px;height:96px;border-radius:14px;border:3px dashed #13333C;background:rgba(255,255,255,.45);animation:offlineFade 2.4s ease-in-out infinite">'
      + '<div style="position:absolute;left:16px;top:30px;width:30px;height:24px;border-radius:5px;border:3px solid #13333C;box-sizing:border-box"></div>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="#13333C" stroke-width="2.2" stroke-linecap="round" style="position:absolute;right:14px;top:24px;width:44px;height:44px">'
      + '<path d="M7.75 9A3.5 3.5 0 0 1 7.75 15M9.25 6.4A6.5 6.5 0 0 1 9.25 17.6M10.75 3.8A9.5 9.5 0 0 1 10.75 20.2"></path></svg>'
      + '</div>',
    mints: (function () {
      var bank = '<svg viewBox="0 0 64 64" fill="none" style="width:64px;height:64px"><path d="M6 22 32 8l26 14z" fill="#13333C"></path><rect x="8" y="24" width="48" height="4" rx="1" fill="#13333C"></rect><rect x="12" y="31" width="6" height="19" rx="1.5" fill="#13333C"></rect><rect x="23" y="31" width="6" height="19" rx="1.5" fill="#13333C"></rect><rect x="35" y="31" width="6" height="19" rx="1.5" fill="#13333C"></rect><rect x="46" y="31" width="6" height="19" rx="1.5" fill="#13333C"></rect><rect x="6" y="52" width="52" height="5" rx="1.5" fill="#13333C"></rect></svg>';
      var side = function (name) {
        return '<div style="display:flex;flex-direction:column;align-items:center;gap:8px">' + bank
          + '<span style="font-weight:800;font-size:11px;letter-spacing:.14em;color:#13333C">' + name + '</span></div>';
      };
      return '<div style="position:relative;width:260px;display:flex;flex-direction:column;align-items:center">'
        + '<div style="position:relative;width:100%;display:flex;align-items:flex-end;justify-content:space-between">'
        + side('YOUR MINT')
        + '<div style="position:absolute;left:78px;right:78px;top:24px;height:22px">'
        + '<div style="position:absolute;left:0;right:0;top:20px;border-top:2px dashed rgba(19,51,60,.3)"></div>'
        + '<div style="position:absolute;inset:0;width:calc(100% - 22px);animation:coinHop 1.8s ease-in-out infinite">'
        + '<div style="width:22px;height:22px;border-radius:50%;background:#13333C;display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(255,255,255,.9)"><svg viewBox="0 0 24 24" fill="none" style="width:13px;height:13px"><path d="M12 3v18M7 8h10M7 12h10M7 16h10" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"></path></svg></div>'
        + '</div></div>'
        + side('THEIR MINT')
        + '</div></div>';
    })(),
  };

  /* `o`: art ('phone' | 'mints' | ''), title (may hold <br>), amount, body (may
   * hold <br> and <strong>), code (the four digits), qr (text to draw), dots,
   * button, go, and `keep` to leave the screen up after the button. */
  stageScreen(kind, o) {
    this.hideStage();
    const W = window.FoxyWallet;
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const root = document.createElement('div');
    root.id = 'foxy-stage';
    root.setAttribute('data-stage', kind);
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;display:flex;flex-direction:column;'
      + 'overflow:hidden;background:linear-gradient(170deg,#D3EDF4 0%,#C5E6EF 45%,#B5DDE9 80%,#A9D6E4 100%);'
      + "color:#13333C;font-family:Sora,system-ui,sans-serif;animation:foxyIn .18s ease";
    const hasQr = !!(o.qr && W && W.qr);
    const head = '<h1 style="margin:0;font-weight:800;font-size:30px;line-height:1.1;letter-spacing:-.01em;'
      + 'text-transform:uppercase;color:#13333C">' + o.title + '</h1>';
    const amount = o.amount
      ? '<div style="font-weight:800;font-size:44px;line-height:1;letter-spacing:-.03em;color:#13333C">'
        + esc(o.amount) + '</div>' : '';
    const body = o.body
      ? '<p style="margin:0;max-width:300px;text-align:center;font-family:Figtree,Sora,system-ui,sans-serif;'
        + 'font-weight:500;font-size:17px;line-height:1.45;color:#13333C;text-wrap:pretty">' + o.body + '</p>' : '';
    /* The four digits, where this screen covers the one that was showing
     * them. They are what the two people compare, and a waiting screen that
     * hid them would hide the one check the tap has. */
    const code = o.code
      ? '<div style="display:flex;flex-direction:column;align-items:center;gap:4px">'
        + '<span style="font-weight:800;font-size:11px;letter-spacing:.14em;opacity:.7">THEIR SCREEN SHOWS</span>'
        + '<span style="font-weight:800;font-size:40px;letter-spacing:.12em;line-height:1">' + esc(o.code) + '</span></div>' : '';
    const dots = o.dots
      ? '<div style="display:flex;gap:8px;margin-top:4px">'
        + [0, .2, .4].map((d) => '<span style="width:8px;height:8px;border-radius:50%;background:#13333C;'
          + 'animation:dot 1.4s ease-in-out ' + d + 's infinite"></span>').join('') + '</div>' : '';
    // full width on its own; smaller when rows share the screen with it
    const qrSize = (o.rows && o.rows.length) ? 'min(58vw,236px)' : 'min(100vw - 84px,420px)';
    const qr = hasQr
      ? '<div style="position:relative;padding:14px;border-radius:24px;background:#FFFFFF;'
        + 'box-shadow:0 18px 40px rgba(19,51,60,.22)"><img data-stage-qr alt="" '
        + 'style="width:' + qrSize + ';height:' + qrSize + ';display:block;image-rendering:pixelated"></div>' : '';
    /* Label-and-value rows under the code, for a screen with more than one
     * number on it (the change card's three). */
    const rows = (o.rows && o.rows.length)
      ? '<div style="width:100%;max-width:320px;display:flex;flex-direction:column">'
        + o.rows.map((r) => '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;'
          + 'padding:9px 0;border-top:1px solid rgba(19,51,60,.14)">'
          + '<span style="font-weight:700;font-size:12px;letter-spacing:.1em;opacity:.7">' + esc(r.label) + '</span>'
          + '<span style="font-weight:800;font-size:19px;letter-spacing:-.01em;white-space:nowrap">' + esc(r.value) + '</span></div>').join('')
        + '</div>' : '';
    const art = this.STAGE_ART[o.art] || '';
    root.innerHTML =
      '<div style="position:absolute;left:50%;top:44%;width:420px;height:420px;border-radius:50%;'
      + 'background:radial-gradient(circle, rgba(255,255,255,.75) 0%, rgba(255,255,255,0) 65%);'
      + 'animation:glowDrift 5s ease-in-out infinite;pointer-events:none"></div>'
      + '<div style="position:absolute;inset:-10%;background-image:url(snow-fur.jpg);background-size:cover;'
      + 'background-position:center;mix-blend-mode:soft-light;opacity:.18;animation:grain 14s ease-in-out infinite;'
      + 'pointer-events:none"></div>'
      + '<div style="position:relative;z-index:1;flex:1 1 auto;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:' + (hasQr ? '18px' : art ? '56px' : '40px')
      + ';padding:calc(20px + env(safe-area-inset-top)) 28px 0">'
      + (hasQr
          ? '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center">' + head + amount + '</div>'
            + qr + rows + body
          : art + '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center">'
            + head + amount + body + code + dots + '</div>')
      + '</div>';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;z-index:1;padding:20px 24px calc(44px + env(safe-area-inset-bottom))';
    const b = document.createElement('div');
    b.style.cssText = 'width:100%;height:60px;border-radius:18px;border:2px solid rgba(19,51,60,.85);'
      + "background:rgba(255,255,255,.35);font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;"
      + 'letter-spacing:.04em;text-transform:uppercase;color:#13333C;display:flex;align-items:center;'
      + 'justify-content:center;cursor:pointer';
    /* A button above the main one, for something to do that does not end the
     * screen: sharing the code with somebody who is not in the room. */
    if (o.above) {
      const u = document.createElement('div');
      u.style.cssText = b.style.cssText + ';margin-bottom:12px;background:#13333C;color:#fff';
      u.textContent = o.above;
      u.addEventListener('click', () => { if (typeof o.aboveGo === 'function') o.aboveGo(); });
      wrap.appendChild(u);
    }
    b.textContent = o.button || 'CANCEL';
    // found by a screen that takes its button away part-way through (26f-flashcard.js)
    b.setAttribute('data-stage-button', '1');
    b.addEventListener('click', () => {
      if (!o.keep) this.hideStage(kind);
      if (typeof o.go === 'function') o.go();
    });
    wrap.appendChild(b);
    /* A second way out, in plain words under the button, for a screen whose
     * one button is not always the right answer. */
    if (o.alt) {
      const a = document.createElement('div');
      a.style.cssText = "margin-top:14px;text-align:center;font-family:Sora,system-ui,sans-serif;font-weight:800;"
        + 'font-size:14px;letter-spacing:.1em;color:#13333C;opacity:.75;cursor:pointer;padding:6px';
      a.textContent = o.alt;
      a.addEventListener('click', () => { this.hideStage(kind); if (typeof o.altGo === 'function') o.altGo(); });
      wrap.appendChild(a);
    }
    root.appendChild(wrap);
    document.body.appendChild(root);
    if (this.syncPreview) this.syncPreview();
    console.log('[foxy] screen: ' + kind + (hasQr ? ', with a code of ' + String(o.qr).length + ' chars' : ''));

    if (hasQr) {
      const img = root.querySelector('[data-stage-qr]');
      const text = String(o.qr);
      const moving = !!(W.tokenQrAnimates && W.tokenQrAnimates(text) && W.animatedQr);
      if (moving) {
        // the token screen's own frames, read by the same scanners (syncTokenQr)
        const frames = W.animatedQr(text, this.TOKEN_QR.fragment);
        const tick = () => {
          const src = W.qr(frames.next(), { ecc: this.TOKEN_QR.ecc });
          if (src && img) img.setAttribute('src', src);
        };
        tick();
        this._stageQrT = setInterval(tick, this.TOKEN_QR.everyMs);
      } else {
        const src = W.qr(text);
        if (src && img) img.setAttribute('src', src);
      }
    }
    /* A screen that outlives what it was waiting for hides a working app, the
     * rule the loaders follow. Only the waits: a code somebody has been asked
     * to scan stays until they say they are done. */
    if (o.dots) {
      this._stageT = setTimeout(() => this.hideStage(kind), Number(o.forMs) || 100000);
    }
  }

  /* Down, if it is this one — or whichever is up, when nothing is named. */
  hideStage(kind) {
    const old = document.getElementById('foxy-stage');
    if (!old) return false;
    if (kind && old.getAttribute('data-stage') !== kind) return false;
    clearTimeout(this._stageT);
    clearInterval(this._stageQrT);
    // the card screen's count of seconds (26h-tap-screen.js)
    clearInterval(this._fcCountT);
    this._stageT = null; this._stageQrT = null; this._fcCountT = null;
    if (old.parentNode) old.parentNode.removeChild(old);
    if (this.syncPreview) this.syncPreview();
    return true;
  }

  stageUp(kind) {
    const el = document.getElementById('foxy-stage');
    return !!el && (!kind || el.getAttribute('data-stage') === kind);
  }

  /* An amount for a heading: dollars where this phone has a price to say them
   * at, the sats where it has not. */
  stageMoney(sats) {
    const n = Math.round(Number(sats) || 0);
    const px = this.px ? this.px() : 0;
    // under half a cent, the sats: "$ 0.00" of change owed is a wrong number (one sat)
    if (px && n > 0 && (n / 1e8) * px < 0.005) return '₿ ' + this.group(n);
    return px ? '$ ' + this.usd((n / 1e8) * px) : '₿ ' + this.group(n);
  }

  /* CONNECTING TO INVOICE, on both phones, from the payer's first buzz until
   * the link is made.
   *
   * The two are looking at each other across a table and what they need to know
   * is the same thing — that something is happening and roughly how far along
   * it is. The payer was told by a vibration and nothing else, and the receiver
   * by its own screen not changing.
   *
   * CANCEL is real here and only here: nothing has been swapped, nothing has
   * left, and letting go costs the person nothing but the tap.
   */
  showConnecting(onCancel) {
    if (document.getElementById('foxy-connecting')) return;
    const root = document.createElement('div');
    root.id = 'foxy-connecting';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;'
      + 'display:flex;flex-direction:column;animation:foxyIn .18s ease';
    root.innerHTML = this.loaderConnecting()
      .replace('{{TITLE}}', 'Connecting<br>to invoice')
      .replace('{{CANCEL}}', '');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:2;'
      + 'padding:0 24px calc(44px + env(safe-area-inset-bottom))';
    const b = document.createElement('div');
    b.style.cssText = 'width:100%;height:60px;border-radius:18px;'
      + 'border:2px solid rgba(19,51,60,.85);background:rgba(255,255,255,.35);'
      + "font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;"
      + 'letter-spacing:.08em;color:#13333C;display:flex;align-items:center;'
      + 'justify-content:center;cursor:pointer';
    b.textContent = 'CANCEL';
    b.addEventListener('click', () => {
      this.hideConnecting();
      if (typeof onCancel === 'function') onCancel();
    });
    wrap.appendChild(b);
    root.appendChild(wrap);
    document.body.appendChild(root);
    if (this.syncPreview) this.syncPreview();
    /* A loader that outlives its task hides a working screen, the same rule the
     * melt overlay follows. The link's own patience is well under this. */
    clearTimeout(this._connT);
    this._connT = setTimeout(() => this.hideConnecting(), 40000);
  }

  hideConnecting() {
    clearTimeout(this._connT);
    const old = document.getElementById('foxy-connecting');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (old && this.syncPreview) this.syncPreview();
  }

  /* TAP TO PAY: a receiver is close by and the payer is on home or SEND. A
   * tall toast from the top edge of the screen down to the bottom of the
   * balance pill ("+1,362 last 24 hours"), with the tap icon ringing out. It measures the pill each time it is shown; with no
   * pill on the screen it takes a fixed height. The native side says `nearby`
   * about once a second while the receiver is heard, so the toast is renewed
   * on each and takes itself down 1.6 s after the last. */
  /* What both CONNECT TO PAY cards are drawn from: the mark at the edge the
   * phones should touch, an arrow in it pointing at that edge, and the words. `edge` is which side of this screen the mark
   * sits on — the payer's left meets the receiver's right, which is where the
   * antennas are closest. The accent, black ink,
   * and the light that sweeps across every two seconds. */
  /* Which edge the mark sits on is told with the `nearby` event: it depends
   * on the pair of phones and who is paying (TapEdges, TapProtocol.swift —
   * a 17 Pro uses its left against an XS and its right against a 15 Pro Max),
   * and the native side works it out. `left` is the layout for anything it
   * could not. */
  ctpParts(edge, withX) {
    const left = edge === 'left';
    const INK = '#050505';
    /* One arrow in the half of the mark that shows, pointing at the edge of
     * the screen, thin with a small open head, and giving the little hop the
     * reference design has: it darts at the edge, squashes against it,
     * springs back past where it started and settles.
     * The mark itself beats like a heart: boom boom, a rest, boom boom. */
    const arrow = '<svg viewBox="0 0 34 16" width="34" height="16" fill="none" stroke="var(--acc)" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" style="position:absolute;top:48px;' + (left ? 'left:82px' : 'left:24px')
      + ';transform-origin:' + (left ? '0% 50%' : '100% 50%') + ';animation:' + (left ? 'foxyCtpHopL' : 'foxyCtpHopR')
      + ' .93s ease-in-out infinite"><path d="' + (left ? 'M32 8 L2 8 M8 2 L2 8 L8 14' : 'M2 8 L32 8 M26 2 L32 8 L26 14') + '"></path></svg>';
    return '<div style="position:absolute;top:0;bottom:0;left:0;width:40%;background:linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.45) 50%,rgba(255,255,255,0) 100%);animation:foxyNearbySweep 2s ease-out infinite;pointer-events:none"></div>'
      + '<div style="position:absolute;' + (left ? 'left:-70px' : 'right:-70px') + ';top:50%;margin-top:-65px;width:140px;height:130px;animation:foxyCtpBeat 1.9s ease-in-out infinite;pointer-events:none">'
      + '<div style="position:absolute;inset:0;animation:foxyCtpGlow 1.9s ease-in-out infinite">'
      + '<svg viewBox="0 0 100 92" width="140" height="130" fill="none"><path d="M50 90 C20 68 2 50 2 28 C2 13 14 2 28 2 C38 2 46 8 50 16 C54 8 62 2 72 2 C86 2 98 13 98 28 C98 50 80 68 50 90 Z" fill="' + INK + '"></path></svg></div>'
      + arrow + '</div>'
      // the words, centred in what the mark leaves of the card
      + '<div style="position:absolute;left:' + (left ? 'calc(70px + (100% - 70px) / 2)' : 'calc((100% - 70px) / 2)') + ';top:50%;transform:translate(-50%,-50%);font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:min(42px,10.4vw);line-height:1.02;color:' + INK + ';text-align:left;white-space:nowrap;pointer-events:none">CONNECT<br>TO PAY</div>'
      // the payer's sheet has no X: pressing it connects, and it goes when the receiver does.
      // The receiver's sits in the corner away from the mark.
      + (!withX ? '' : '<div data-ctp-x="1" style="position:absolute;' + (left ? 'right:16px' : 'left:16px') + ';top:16px;width:44px;height:44px;border-radius:50%;background:' + INK + ';display:flex;align-items:center;justify-content:center;cursor:pointer">'
      + '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="var(--acc)" stroke-width="2.6" stroke-linecap="round" style="pointer-events:none"><path d="M4 4 L16 16 M16 4 L4 16"></path></svg></div>');
  }

  /* CONNECT TO PAY on the payer: a receiver is close by and this phone is on
   * home or SEND. A sheet from the top edge of the screen down to the bottom
   * of the balance pill, with the mark on the edge to hold against the other
   * phone (it was TAP TO PAY with the
   * tap icon in the middle). The native side says `nearby` about once a
   * second while the receiver is heard, so the sheet is renewed on each and
   * takes itself down 1.6 s after the last. */
  showTapNearby(edge) {
    const side = edge === 'right' ? 'right' : 'left';
    clearTimeout(this._nearT);
    this._nearT = setTimeout(() => this.hideTapNearby(), 1600);
    const pill = document.querySelector('[data-foxy-delta-pill]');
    const bottom = pill ? Math.round(pill.getBoundingClientRect().bottom) : 0;
    const height = bottom > 80 ? bottom : 220;
    let root = document.getElementById('foxy-tap-nearby');
    if (root && root.getAttribute && root.getAttribute('data-edge') === side) { root.style.height = height + 'px'; return; }
    // the other phone's model has just been read, and the edge with it: drawn again
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = document.createElement('div');
    root.id = 'foxy-tap-nearby';
    root.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483200;'
      + 'background:var(--acc);border-radius:0 0 30px 30px;box-shadow:0 12px 30px rgba(var(--acc-rgb),.35);'
      + 'overflow:hidden;pointer-events:none;animation:foxyNearbyIn .55s cubic-bezier(.22,1,.36,1) both';
    root.style.height = height + 'px';
    if (root.setAttribute) root.setAttribute('data-edge', side);
    root.innerHTML = this.ctpParts(side, false);
    /* Not a button, for now. Pressing it took the receiver from a couple of
     * metres without the phones touching; the touch is meant to be the only
     * way in while the rest is tried (the handshake waits for the phones to
     * be touching: `nearDbm`, TapProtocol.swift). The card says where to hold
     * the phone and nothing else. `tapPayNow` and the native side of it are left in place. */
    document.body.appendChild(root);
  }

  hideTapNearby() {
    clearTimeout(this._nearT);
    const old = document.getElementById('foxy-tap-nearby');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  /* And on the receiver: a payer has said it is near (the third door,
   * TapLink.swift), so the QR's place is taken by the same card, the mark on
   * the edge the payer's door named. Full width, over where the code is; the code is
   * still underneath, and the X — or the payer going away, or the handshake
   * starting — gives it back. It changes a picture: nothing about the tap
   * depends on it. */
  showConnectRecv(edge) {
    /* With the phone lying top-down the whole page is turned through 180
     * degrees (syncFlip), and this card turns with it. Two things follow.
     * The edge the payer named is an edge of the PHONE, and on a page turned
     * round the phone's right is the page's left — so the mark swaps sides.
     * And the code's place is measured on the screen, while the card is
     * placed on the turned page — so its top is measured from the other end.
     * Unturned, the card covered the amount and pointed at the wrong edge. */
    const turned = !!this._flipOn;
    const named = edge === 'left' ? 'left' : 'right';
    const side = turned ? (named === 'left' ? 'right' : 'left') : named;
    const key = side + (turned ? ':turned' : '');
    if (Date.now() < (this._ctpRecvOffUntil || 0)) return;
    const was = document.getElementById('foxy-connect-recv');
    if (was && was.getAttribute && was.getAttribute('data-edge') === key) return;
    if (was && was.parentNode) was.parentNode.removeChild(was);
    const img = document.querySelector('[data-req-qr]');
    const box = img && img.parentElement ? img.parentElement.getBoundingClientRect() : null;
    const tall = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const seen = box && box.height > 80;
    const top = !seen ? Math.round(tall * 0.42) : Math.round(turned ? tall - box.bottom : box.top);
    const height = seen ? Math.round(box.height) : 300;
    const root = document.createElement('div');
    root.id = 'foxy-connect-recv';
    root.style.cssText = 'position:fixed;left:0;right:0;z-index:2147483100;background:var(--acc);'
      + 'border-radius:30px;overflow:hidden;animation:foxyIn .2s ease';
    root.style.top = top + 'px';
    root.style.height = height + 'px';
    if (root.setAttribute) root.setAttribute('data-edge', key);
    root.innerHTML = this.ctpParts(side, true);
    root.addEventListener('click', (e) => {
      const t = /** @type {any} */ (e && e.target);
      const x = t && t.closest && t.closest('[data-ctp-x]');
      if (!x) return;
      console.log('[foxy] tap: CONNECT TO PAY put away on the invoice');
      this._ctpRecvOffUntil = Date.now() + 20000;
      this.hideConnectRecv();
    });
    document.body.appendChild(root);
  }

  /* GET DOLLARS: informational, and deliberately nothing else.
   *
   * Four companies that take bitcoin and pay dollars to a bank. Foxy saves no
   * username, looks nothing up and pays nobody from here — an earlier design
   * did all three and every hole in it was one of those (a typo paying a
   * stranger, an identity kept on the phone, a lookup over Tor that may be
   * refused). The person makes an account there and comes back to SEND.
   *
   * A tile opens that company's site in the phone's browser, by name: the
   * addresses themselves are on the native side (openCompany). The icons are
   * each company's own, as the App Store shows them (Web/gd-*.jpg). */
  showGetDollars() {
    this.hideGetDollars();
    const W = window.FoxyWallet;
    const apps = [
      { key: 'cashapp', icon: 'gd-cashapp.jpg', name: 'CASH APP', url: 'cash.app' },
      { key: 'strike', icon: 'gd-strike.jpg', name: 'STRIKE', url: 'strike.me' },
      { key: 'river', icon: 'gd-river.jpg', name: 'RIVER', url: 'river.com' },
      { key: 'flash', icon: 'gd-flash.jpg', name: 'FLASH', url: 'getflash.io' },
    ];
    const root = document.createElement('div');
    root.id = 'foxy-get-dollars';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483200;display:flex;flex-direction:column;'
      + 'box-sizing:border-box;padding:calc(34px + env(safe-area-inset-top)) 24px calc(28px + env(safe-area-inset-bottom));'
      + 'background:var(--bg,#050505);color:rgb(var(--ink-rgb,255,255,255));'
      + "font-family:Sora,system-ui,sans-serif;overflow-y:auto;animation:foxyIn .18s ease";
    const para = 'margin:0;font-weight:500;font-size:18px;line-height:1.42;text-align:center;'
      + 'color:rgba(var(--ink-rgb,255,255,255),.84)';
    root.innerHTML = ''
      + '<div style="text-align:center;font-weight:800;font-size:24px;letter-spacing:.01em">GET DOLLARS</div>'
      + '<div style="flex:0 0 1px;height:1px;margin:20px 4px 0;background:rgba(var(--ink-rgb,255,255,255),.14)"></div>'
      + '<p style="' + para + ';margin-top:24px">These apps let you sell your bitcoin and deposit dollars into your bank account.</p>'
      + '<div style="margin:28px auto 0;display:grid;grid-template-columns:1fr 1fr;gap:22px 34px;width:fit-content">'
      + apps.map(a => ''
        + '<div data-gd="' + a.key + '" style="display:flex;flex-direction:column;align-items:center;gap:9px;cursor:pointer">'
        + '<img alt="" src="' + a.icon + '" style="display:block;box-sizing:border-box;width:96px;height:96px;'
        + 'border-radius:22px;border:1px solid rgba(var(--ink-rgb,255,255,255),.16);box-shadow:0 6px 16px rgba(0,0,0,.45)">'
        + '<div style="font-weight:700;font-size:14px;letter-spacing:.04em;white-space:nowrap">' + a.name + '</div>'
        + '<div style="margin-top:-4px;font-weight:500;font-size:13px;white-space:nowrap;color:rgba(var(--ink-rgb,255,255,255),.55)">' + a.url + '</div>'
        + '</div>').join('')
      + '</div>'
      + '<p style="' + para + ';margin-top:28px">Create an account with one of them and ask your AI how to receive bitcoin and sell it for dollars on that app.</p>'
      + '<div style="flex:1 1 auto;min-height:24px"></div>'
      + '<div data-gd-close="1" style="flex:0 0 auto;height:58px;border-radius:30px;background:var(--acc);color:#050505;'
      + 'display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;letter-spacing:.04em;cursor:pointer">CLOSE</div>';
    root.addEventListener('click', (e) => {
      const t = /** @type {any} */ (e && e.target);
      if (!t || !t.closest) return;
      if (t.closest('[data-gd-close]')) { this.hideGetDollars(); return; }
      const hit = t.closest('[data-gd]');
      if (hit && W && W.openCompany) {
        this.haptic && this.haptic('tap');
        W.openCompany(hit.getAttribute('data-gd'));
      }
    });
    document.body.appendChild(root);
  }

  hideGetDollars() {
    const old = document.getElementById('foxy-get-dollars');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  hideConnectRecv() {
    const old = document.getElementById('foxy-connect-recv');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
