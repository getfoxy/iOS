'use strict';
/* gate-scenarios.js — the Tor gate and the confirming check, scenario by scenario.
 *
 *     node tests/gate-scenarios.js
 *
 * Web/foxy-tor-gate.js and Web/foxy-wallet.js in jsdom, with a fake native side
 * whose Tor state the scenarios set: launch, cannot connect, continue
 * unprotected, Orbot, and coming back from the background. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 60000).unref();
const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) failures++; };

function boot(opts = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://foxy.test/', pretendToBeVisual: true });
  const w = dom.window;
  const native = { tor: 'connecting', progress: 0, everUp: false, unprotected: false };
  /* What a phone that has connected once already holds: its mint's keysets and
   * the last price it was told. `offlineReady` reads both, and PROCEED OFFLINE
   * is offered only when it answers yes. */
  if (opts.offlineReady) {
    // JSON, because that is what `save` writes and `load` expects
    w.localStorage.setItem('foxy.cashu.mint', JSON.stringify('https://m.test'));
    w.localStorage.setItem('foxy.cashu.mint.cache', JSON.stringify({
      'https://m.test': { info: { name: 'm' }, at: Math.floor(Date.now() / 1000),
        keys: { mintUrl: 'https://m.test', savedAt: 0,
                keysets: [{ id: '00abcdef00000001', unit: 'sat', active: true, keys: { 1: 'ff' } }] } },
    }));
    /* Two hours old: a price from the last minute is served straight back by
     * `rate()` without asking anyone, which would hide whether the route is
     * really shut. Old enough to need a fetch, which is what offline means. */
    if (opts.offlineReady !== 'mintOnly') {
      w.localStorage.setItem('foxy.price.last',
        JSON.stringify({ rate: 84746, at: Date.now() - 2 * 3600 * 1000 }));
    }
  }
  const sent = [];
  w.CashuTS = opts.cashu || {};
  const reply = (m, text, err) => setTimeout(() => w.FoxyWallet._scanResult(m.id, typeof text === 'function' ? text() : text, err), 5);
  const push = () => setTimeout(() => w.FoxyWallet._privacy(JSON.parse(JSON.stringify(native))), 1);
  w.webkit = { messageHandlers: { foxy: { postMessage: m => {
    sent.push(m);
    switch (m.action) {
      case 'privacy': return reply(m, () => JSON.stringify(native), null);
      case 'torRetry': if (native.tor !== 'up') native.tor = 'connecting'; push(); return reply(m, () => JSON.stringify(native), null);
      case 'unprotected': native.unprotected = !!m.on && native.tor !== 'up'; push(); return reply(m, () => JSON.stringify(native), null);
      case 'mintRequest': return (native.tor === 'up' || native.unprotected)
        ? reply(m, '200\n{"ok":true}', null) : reply(m, null, 'Foxy is not connected to Tor.');
      case 'orbotAccess': return reply(m, 'opened', null);
      case 'orbotRefresh': return reply(m, 'none', null);
      // the phone has a seed; the counters and secrets are not these scenarios' business
      case 'seedStatus': return reply(m, '{"exists":true}', null);
      case 'price': return setTimeout(() => ((native.tor === 'up' || native.unprotected) && native.priceOk !== false)
        ? w.FoxyWallet._scanResult(m.id, '77000', null)
        : w.FoxyWallet._scanResult(m.id, null, 'no price source answered'), native.priceDelay || 5);
      default: return reply(m, null, 'Unknown action: ' + m.action);
    }
  } } } };
  /* The intro is not what these scenarios are about, and it covers the screen
   * (and holds the count) until the launch says its Face ID step is done. The
   * stamp marks it as already seen today; tests/rider-lines.js and the app's
   * own launch cover the intro itself. */
  try {
    const d = new Date();
    w.localStorage.setItem('foxy.intro.day', d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate());
  } catch (e) {}
  for (const f of ['foxy-tor-gate.js', 'foxy-wallet.js']) {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
    w.document.body.appendChild(s);
  }
  /* The arrival sweep is a reveal, not logic: it climbs the number from nothing
   * over its first second so a screen reached at 89% can be read rather than
   * glimpsed. Every scenario below is about what the number
   * IS, so it is off by default here and has one test of its own. */
  w.FoxyGate.sweepMs = 0;
  const set = async patch => { Object.assign(native, patch); push(); await sleep(25); };
  const title = () => { const r = w.document.getElementById('ftg-root'); return r && r.style.display !== 'none' ? r.textContent : ''; };
  const threw = fn => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); return ''; } catch (e) { return e.message; } };
  return { w, W: w.FoxyWallet, G: w.FoxyGate, native, set, sent, title, threw };
}

(async () => {
  const pctOf = t => { const m = /(\d+)%/.exec(t.title()); return m ? Number(m[1]) : 0; };

  /* The network goes while another screen is in the way.
   *
   * It is reported once, on the change. The launch screen was playing its
   * ending when a phone went into airplane mode, so the gate did not
   * arm its check, was never told again, and the home screen looked online
   * for twenty-five seconds. */
  { const t = boot();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await t.G.check(() => {});
    t.G.showLaunch();
    await sleep(40);
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    await sleep(100);
    t.G.hide();                       // the ending finishes and the screen goes
    await sleep(60);
    ok(t.title() === '', 'the launch screen has gone, with the network already off', t.title().slice(0, 40));
    await sleep(1200);
    ok(/NO CONNECTION/.test(t.title()),
       'a network lost under another screen is still noticed once that screen goes',
       t.title().slice(0, 60)); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await p === true, 'warm launch: check resolves true');
    ok(t.title() === '', 'warm launch: no screen');
    ok(t.G.warning() === null, 'warm launch: no warning row');
    ok(t.G.stamp() === 'via tor', 'warm launch: stamp says via tor'); }

  { const t = boot(); const p = t.G.check(() => {});
    await sleep(650);
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'slow launch: the launch screen after 500ms');
    await t.set({ progress: 50 });
    // the number is the pace, not Tor's own count, so it says nothing about 50
    ok(pctOf(t) > 0, 'slow launch: the number is running (' + pctOf(t) + '%)');
    await t.set({ tor: 'up', everUp: true });
    ok(await p === true && t.title() === '', 'slow launch: clears when Tor connects'); }

  { const t = boot(); let boots = 0;
    const retry = () => { boots++; return t.G.check(retry); };
    const p = t.G.check(retry);
    await t.set({ tor: 'failed' });
    ok(await p === false, 'cannot connect: check resolves false');
    ok(/CANNOT CONNECT TO TOR/.test(t.title()) && /RETRY/.test(t.title()) && /CONTINUE UNPROTECTED/.test(t.title()),
       'cannot connect: screen has RETRY and CONTINUE UNPROTECTED');
    const e = t.threw(() => t.W.candles(3600));
    ok(/still connecting to Tor/.test(e), 'cannot connect: wallet refuses before asking native (' + e + ')');
    t.G.retry(); await sleep(40);
    ok(t.sent.some(m => m.action === 'torRetry'), 'retry: asks native to retry');
    ok(/CONNECTING…/.test(t.title()), 'retry: button reads CONNECTING…');
    await t.set({ tor: 'failed' });
    ok(/RETRY/.test(t.title()) && !/CONNECTING…/.test(t.title()), 'retry fails: back to RETRY');
    await t.set({ tor: 'up', everUp: true }); await sleep(30);
    ok(boots === 1, 'Tor connects later on its own: boot runs once (ran ' + boots + ')');
    ok(t.title() === '', 'Tor connects later: screen gone'); }

  { const t = boot(); let boots = 0;
    const retry = () => { boots++; return t.G.check(retry); };
    await t.set({ tor: 'failed' });
    ok(await t.G.check(retry) === false, 'unprotected: starts on the failure screen');
    const btn = [...t.w.document.querySelectorAll('#ftg-root div')].find(d => d.textContent === 'CONTINUE UNPROTECTED');
    btn.click(); await sleep(60);
    ok(t.sent.filter(m => m.action === 'unprotected' && m.on === true).length === 1, 'unprotected: one tap asks the native side (which shows the iOS alert)');
    ok(boots === 1 && t.title() === '', 'unprotected: app boots, screen gone (boots ' + boots + ')');
    ok(t.G.warning() && /IP ADDRESS EXPOSED/.test(t.G.warning().text), 'unprotected: warning row shown');
    ok(t.threw(() => t.W.candles(3600)) === '', 'unprotected: wallet lets requests through');
    await t.set({ tor: 'up', everUp: true, unprotected: false });
    ok(t.G.warning() === null, 'unprotected, then Tor connects: warning row gone');
    ok(boots === 1, 'unprotected, then Tor connects: no second boot'); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'up', everUp: true }); await p;
    await t.set({ tor: 'connecting' });
    ok(t.title() === '' && t.G.warning() === null, 'drop after up: no screen, no row');
    const e = t.threw(() => t.W.candles(3600));
    ok(/reconnecting/.test(e), 'drop after up: requests refused as reconnecting (' + e + ')');
    const q = t.G.quiet(); await sleep(50); await t.set({ tor: 'up' });
    ok(await q === true, 'drop after up: quiet() resolves true when Tor returns');
    await t.set({ tor: 'failed' });
    ok(t.title() === '', 'drop past the deadline: still no screen'); }

  { const made = [];
    class Mint { constructor(url, o) { this.mintUrl = url; made.push(['Mint', !!(o && o.customRequest)]); } }
    class Wallet { constructor(m) { made.push(['Wallet', typeof m === 'string' ? 'url' : 'mint']); this.on = { countersReserved() {} }; }
                   loadMint() { return Promise.resolve(); } }
    const t = boot({ cashu: { Mint, Wallet } });
    await t.set({ tor: 'up', everUp: true });
    try { await t.W.connect('https://m.test', null, null, { remember: false }); }
    catch (e) { console.log('     (connect after construction: ' + e.message + ')'); }
    ok(made.some(x => x[0] === 'Mint' && x[1]) && made.some(x => x[0] === 'Wallet' && x[1] === 'mint'),
       'connect: Wallet built on a Mint with customRequest ' + JSON.stringify(made));
    const r = await t.W.nativeRequest({ endpoint: 'https://m.test/v1/info', method: 'GET' });
    ok(r && r.ok === true, 'nativeRequest: answered over the bridge'); }

  { const t = boot(); let boots = 0;
    const retry = () => { boots++; return t.G.check(retry); };
    await t.set({ orbot: 'needs-access' });
    ok(await t.G.check(retry) === false, 'orbot: check resolves false at once when Orbot must allow Foxy');
    ok(/ORBOT DETECTED/.test(t.title()) && /ALLOW FOXY IN ORBOT/.test(t.title()),
      'orbot: screen offers ALLOW FOXY IN ORBOT');
    ok(!/PROCEED WITH/.test(t.title()),
      'orbot: and does not offer to proceed on Orbot\u2019s own Tor, which would fail open');
    const allow = [...t.w.document.querySelectorAll('#ftg-root div')].find(d => d.textContent === 'ALLOW FOXY IN ORBOT');
    allow.click(); await sleep(40);
    ok(t.sent.some(m => m.action === 'orbotAccess'), 'orbot: tapping asks native to open Orbot');
    ok(!t.sent.some(m => m.action === 'torRetry'), 'orbot: the button does not just retry Tor');
    await t.set({ orbot: 'bypass' });
    ok(/ORBOT DETECTED/.test(t.title()) && /Connecting past Orbot/.test(t.title()),
      'orbot: after allowing, waits for Tor');
    await t.set({ tor: 'up', everUp: true }); await sleep(30);
    ok(t.title() === '' && boots === 1, 'orbot: Tor up past Orbot, screen gone, boot ran once (' + boots + ')'); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'up', everUp: true }); await p;
    await t.set({ tor: 'connecting', orbot: 'needs-access' });
    ok(/ORBOT DETECTED/.test(t.title()), 'orbot on mid-session: its screen appears, not a silent reconnect'); }

  /* Tor inside Orbot does not fail — it sits at 10%, tries the next
   * transport, sits again, and stays 'connecting' for ever. A screen that
   * waits for 'failed' never comes, and the count creeps to 99 and stops
   * there with no way on. */
  { const t = boot();
    t.G.vpnPatienceMs = 120;                      // the clock, shortened for the test
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });
    const p = t.G.check(() => {});
    await sleep(60);
    ok(!/VPN DETECTED/.test(t.title()), 'a tunnel is given time before anything is said');
    ok(await p === false, 'but a Tor that only ever sits does reach the screen');
    ok(/VPN DETECTED/.test(t.title()),
      'without ever being told Tor failed :: ' + JSON.stringify(t.title().slice(0, 40))); }

  /* And the clock must not fire on a tunnel Tor got through in the meantime. */
  { const t = boot();
    t.G.vpnPatienceMs = 120;
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });
    const p = t.G.check(() => {});
    await t.set({ tor: 'up', everUp: true, vpn: true });
    ok(await p === true, 'a tunnel Tor got through resolves true');
    await sleep(200);
    ok(!/VPN DETECTED/.test(t.title()),
      'and the waiting clock says nothing afterwards'); }

  /* A cold start that stalls for ten seconds and then recovers is an ordinary
   * cold start, not a tunnel to complain about. On a phone Tor went
   * 'stuck' at 10s, was withdrawn three seconds later and reached 100%, but
   * the screen had already jumped up telling somebody whose connection was
   * about to work that they should turn their VPN off. */
  { const t = boot();
    t.G.vpnPatienceMs = 6000;            // longer than this scenario takes
    t.G.check(() => {});
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });
    await t.set({ tor: 'stuck', vpn: true, orbot: 'none' });
    ok(!/VPN DETECTED/.test(t.title()),
      'a ten-second stall on a tunnel is not yet a VPN to complain about :: '
        + JSON.stringify(t.title().slice(0, 40)));
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });
    await t.set({ tor: 'up', everUp: true, vpn: true });
    ok(!/VPN DETECTED/.test(t.title()),
      'and a stall Tor came back from leaves nothing behind'); }

  /* Orbot issued a key and then went quiet — which is what happened on the
   * phone: the key was stored and the poll fell to 'none' in the same
   * second, so this screen became the generic VPN one and the only way on it
   * offered was exposing an IP. A key Foxy holds is enough to
   * keep calling this Orbot. */
  { const t = boot();
    await t.set({ tor: 'failed', vpn: true, orbot: 'none', orbotKey: true });
    await t.G.check(() => {});
    ok(/ORBOT DETECTED/.test(t.title()),
      'a stored Orbot key keeps the Orbot screen even when its API has gone quiet');
    ok(!/PROCEED WITH VPN/.test(t.title()),
      'and never offers to expose the IP instead');
    ok(/not answering Foxy/.test(t.title()),
      'it says Orbot went quiet rather than asking again for an approval already given');
    ok(/Turn Orbot off/.test(t.title()),
      'and names the one thing that works, rather than telling them to check a connection that is fine');
    ok(/TRY AGAIN/.test(t.title()) && !/ALLOW FOXY IN ORBOT/.test(t.title()),
      'and the button is a retry, not a second trip to Orbot'); }

  /* A key Orbot issued outlives Orbot: it sits in the keychain for good. With
   * Orbot closed there is no tunnel, nothing of Orbot's is carrying anything,
   * and a screen that still says ORBOT DETECTED is talking about an app that
   * is not running — with one button that retries a Tor which is fine. The
   * only way off it was the app switcher. */
  { const t = boot();
    await t.set({ tor: 'failed', vpn: false, orbot: 'none', orbotKey: true });
    await t.G.check(() => {});
    ok(!/ORBOT DETECTED/.test(t.title()),
      'a key held with no tunnel is last time\u2019s Orbot, not this one :: '
        + JSON.stringify(t.title().slice(0, 40))); }

  /* TRY AGAIN on a quiet Orbot must ask Orbot, not just Tor. Orbot's state is
   * polled every fifteen seconds, so somebody who has just fixed Orbot and
   * come back would otherwise be answered from a stale reading. */
  { const t = boot();
    await t.set({ tor: 'failed', vpn: true, orbot: 'none', orbotKey: true });
    await t.G.check(() => {});
    ok(/TRY AGAIN/.test(t.title()), 'the quiet Orbot screen offers a retry');
    [...t.w.document.querySelectorAll('#ftg-root div')]
      .find(d => d.textContent === 'TRY AGAIN').click();
    await sleep(60);
    ok(t.sent.some(m => m.action === 'orbotRefresh'),
      'and tapping it asks Orbot again rather than only restarting Tor'); }

  /* A screen that blocks the app must not depend on being told. Every
   * take-down hangs off the native side pushing a change; if that push is
   * missed the screen stays, its buttons look dead, and the app switcher is the
   * only way out — twice, on two builds, while Tor was fine.
   * Here the state changes with no push at all. */
  { const t = boot();
    t.G.watchMs = 40;
    await t.set({ tor: 'failed', vpn: true, orbot: 'none' });
    await t.G.check(() => {});
    ok(/VPN DETECTED/.test(t.title()), 'the screen is up');
    Object.assign(t.native, { tor: 'up', everUp: true });   // no push: the change is missed
    await sleep(140);
    ok(!/VPN DETECTED/.test(t.title()),
      'a screen nobody told about Tor coming back still comes down :: '
        + JSON.stringify(t.title().slice(0, 40))); }

  /* A retry that has been tapped once must come back. `retrying` is cleared
   * when Tor stops saying 'connecting', and under Orbot it never does — so the
   * latch stayed shut and every later tap was swallowed. Eight taps against one
   * retry, on a phone. */
  { const t = boot();
    t.G.retryLatchMs = 60;
    await t.set({ tor: 'failed', vpn: true, orbot: 'none' });
    await t.G.check(() => {});
    const tap = () => [...t.w.document.querySelectorAll('#ftg-root div')]
      .find(d => d.textContent === 'RETRY TOR' || d.textContent === 'CONNECTING\u2026').click();
    tap(); await sleep(30);
    const first = t.sent.filter(m => m.action === 'torRetry').length;
    ok(first === 1, 'the first tap retries');
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });   // Tor sits, as under Orbot
    tap(); await sleep(20);
    ok(t.sent.filter(m => m.action === 'torRetry').length === 1,
      'a second tap while it is still trying is ignored, as before');
    await sleep(120);                                               // the latch lets go
    tap(); await sleep(30);
    ok(t.sent.filter(m => m.action === 'torRetry').length === 2,
      'but the button comes back rather than staying dead for ever'); }

  /* Turning the tunnel off is the way off this screen, so it must actually be
   * a way off it. Orbot switched off mid-connect left the screen up and simply
   * redrew it as the generic VPN one, telling the person to turn off a VPN they
   * had just turned off. */
  { const t = boot();
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none', orbotKey: true });
    t.G.check(() => {});
    await t.set({ tor: 'failed', vpn: true, orbot: 'none', orbotKey: true });
    ok(/ORBOT DETECTED/.test(t.title()), 'the Orbot screen is up');
    await t.set({ tor: 'connecting', vpn: false, orbot: 'none', orbotKey: true });
    ok(!/VPN DETECTED/.test(t.title()),
      'turning the tunnel off does not leave a VPN warning behind :: '
        + JSON.stringify(t.title().slice(0, 40)));
    ok(!/ORBOT DETECTED/.test(t.title()), 'nor the Orbot one'); }

  /* On a tunnel the quick part stops at 80, not 90, so there is more bar left
   * for the slow crawl. Orbot takes minutes where a direct connect takes
   * seconds, and a number that reaches 90 and sits reads as stuck. */
  { const t = boot(); t.G.paceMs = 400; t.G.waitMs = 10000; t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0, vpn: true, orbot: 'none' });
    t.G.check(() => {});
    await sleep(1000);
    const on = pctOf(t);
    ok(on >= 80 && on < 90, 'a tunnel stops the quick part at 80 (' + on + '%)'); }

  { const t = boot(); t.G.paceMs = 400; t.G.waitMs = 10000; t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0, vpn: false, orbot: 'none' });
    t.G.check(() => {});
    /* Until it is there, and then a while longer to see it stay. A flat
     * second was a race with the bar on a busy Mac: 88% and 89%,
     * three runs in six, with the bar a tick short and nothing
     * wrong. What is being asked is where it stops, not how soon. */
    for (let i = 0; i < 30 && pctOf(t) < 90; i++) await sleep(100);
    await sleep(400);
    const off = pctOf(t);
    ok(off >= 90 && off < 99, 'and with no tunnel it still stops at 90 (' + off + '%)'); }

  /* An ordinary VPN is not Orbot, and must not be treated like it. Tor rides
   * most tunnels without complaint, so a person whose Foxy works is never
   * stopped to be warned about a problem they do not have. The screen waits for Tor to actually fail. */
  { const t = boot(); t.G.check(() => {});
    await t.set({ tor: 'connecting', vpn: true, orbot: 'none' });
    ok(!/VPN DETECTED/.test(t.title()),
      'a VPN while Tor is still connecting says nothing: ' + JSON.stringify(t.title().slice(0, 40)));
    await t.set({ tor: 'up', vpn: true, orbot: 'none' });
    ok(!/VPN DETECTED/.test(t.title()), 'and a VPN that Tor connected through says nothing at all'); }

  /* State first, then check — a launch that finds Tor already given up, which
   * is how this screen is actually reached. */
  { const t = boot();
    await t.set({ tor: 'failed', vpn: true, orbot: 'none' });
    ok(await t.G.check(() => {}) === false, 'a VPN Tor could not get through: check resolves false');
    ok(/VPN DETECTED/.test(t.title()), 'a VPN Tor could not get through does show the screen');
    ok(/PROCEED WITH VPN/.test(t.title()) && /RETRY TOR/.test(t.title()),
      'and offers both: proceed on the tunnel, or try Tor again');
    ok(!/ALLOW FOXY IN ORBOT/.test(t.title()),
      'but not Orbot\u2019s allow, which only Orbot can answer'); }

  { const t = boot();
    await t.set({ tor: 'failed', vpn: false, orbot: 'none' });
    await t.G.check(() => {});
    ok(!/VPN DETECTED/.test(t.title()) && /CANNOT CONNECT/.test(t.title()),
      'and Tor failing with no tunnel at all is still the old CANNOT CONNECT'); }

  // ---- back from the background: a private connection set up, as at launch ------
  // The native side sets Tor up again on every return and reports a Tor that
  // has not been up since, so the page shows the launch screens.
  { const t = boot(); await t.set({ tor: 'up', everUp: true, progress: 100 });
    await t.set({ tor: 'connecting', everUp: false, progress: 0 });     // the return's set-up
    t.G.holdVerify(true); t.G.showLaunch();
    const p = t.G.check(() => {});
    await t.set({ progress: 30 });
    /* The screen says one thing and shows the number: no subtitle under the
     * title, whatever Tor is doing. */
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && !/private connection/.test(t.title()),
       'return: the launch screen, with nothing under its title (' + t.title().replace(/\s+/g, ' ') + ')');
    ok(!t.sent.some(m => m.action === 'price' || m.action === 'mintRequest'), 'return: nothing asked of the connection from before');
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await p === true && /SECURING YOUR CONNECTION/.test(t.title()), 'return: through once Tor is up, the screen still held');
    t.G.launchStage('Loading your balance.', 60, 100); await sleep(300);
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'return: the balance on the same screen');
    /* It finishes what it was saying before it goes: 100%, held for a beat.
     * Leaving at whatever the creep had reached — usually about 85% — read as
     * the screen giving up rather than finishing. */
    t.G.holdVerify(false);
    ok(/100%/.test(t.title()), 'return: it reaches 100% before it leaves (' + t.title() + ')');
    await sleep(2600);                 // 100% held, the circuit closes, then the fade
    ok(t.title() === '', 'return: the home screen after that'); }

  { const t = boot(); await t.set({ tor: 'up', everUp: true });
    await t.set({ tor: 'connecting', everUp: false, progress: 0 });
    t.G.holdVerify(true); const p = t.G.check(() => {});
    await t.set({ tor: 'failed' });
    ok(await p === false && /CANNOT CONNECT TO TOR/.test(t.title()) && /RETRY/.test(t.title()) && /CONTINUE UNPROTECTED/.test(t.title()),
       'return, Tor cannot connect: the launch failure screen, with RETRY and CONTINUE UNPROTECTED');
    t.G.holdVerify(false); }

  { const t = boot(); await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await t.W.agreedRate() === 77000, 'agreed price: answered');
    ok(t.sent.some(m => m.action === 'price' && m.agree === true), 'agreed price: the native side is asked for two sources that agree');
    t.native.priceOk = false;
    let refused = '';
    try { await t.W.agreedRate(); } catch (e) { refused = e.message; }
    ok(!!refused, 'agreed price: refused when the sources do not agree (' + refused + ')'); }

  // A caller that only wants a price does not wait on one already on its way.
  { const t = boot(); await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await t.W.rate({ fresh: true }) === 77000, 'price in flight: a first price');
    t.native.priceDelay = 600;
    const fresh = t.W.rate({ fresh: true });
    ok(t.W.rateInFlight() === fresh, 'price in flight: the wallet says which request is on its way');
    const began = Date.now();
    const last = await t.W.rate();
    ok(last === 77000 && Date.now() - began < 100, 'price in flight: a caller that only wants a price gets the last one at once (' + (Date.now() - began) + ' ms)');
    const shared = t.W.rate({ fresh: true });
    ok(shared === fresh, 'price in flight: a fresh ask still shares it');
    await fresh;
    ok(t.W.rateInFlight() === null && t.sent.filter(m => m.action === 'price').length === 2,
       'price in flight: two native requests in all (' + t.sent.filter(m => m.action === 'price').length + ')'); }

  // ---- launch: one screen from Tor to a loaded balance --------------------------
  { const t = boot(); await t.set({ tor: 'up', everUp: true, progress: 100 });
    t.G.holdVerify(true); t.G.showLaunch();
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'launch: the screen is up before Tor is asked, even with Tor already up');
    ok(await t.G.check(() => {}) === true, 'launch: check passes');
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'launch: the screen stays up past Tor');
    t.G.launchStage('Connecting to mint.test.', 60, 85); await sleep(300);
    /* The step changes the screen but is never spelled out: naming the mint
     * told anyone holding the phone where this wallet keeps its money. */
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && !/mint\.test/.test(t.title()),
       'launch: the mint step moves the screen on without naming the mint');
    t.G.launchStage('Loading your balance.', 85, 100); await sleep(300);
    /* The steps move the screen on; they do not finish the number. Nothing
     * but everything being through does that. */
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && pctOf(t) < 100,
       'launch: the balance step does not finish the number (' + pctOf(t) + '%)');
    t.G.holdVerify(false);
    ok(/100%/.test(t.title()), 'launch: it reaches 100% before it leaves (' + t.title() + ')');
    await sleep(2600);                 // 100% held, the circuit closes, then the fade
    ok(t.title() === '', 'launch: gone once the ending has played'); }

  { const t = boot(); t.G.holdVerify(true); const p = t.G.check(() => {});
    await t.set({ progress: 50 });
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && pctOf(t) < 100,
       "launch: Tor's own progress does not finish the number (" + pctOf(t) + '%)');
    await t.set({ tor: 'failed' });
    ok(await p === false && /CANNOT CONNECT TO TOR/.test(t.title()), 'launch: cannot connect still shows its screen');
    t.G.launchStage('Connecting to mint.test.', 60, 85);
    ok(/CANNOT CONNECT TO TOR/.test(t.title()), 'launch: a mint step never covers the failure screen');
    t.G.holdVerify(false); }

  // ---- RESTART TOR: nobody should ever have to kill Foxy to get Tor moving -----
  // A button is on screen only if it and every box around it is displayed; the
  // screen's text includes hidden buttons, so text alone cannot say.
  const shown = (t, label) => [...t.w.document.querySelectorAll('#ftg-root div')].some(d => {
    if (d.textContent !== label) return false;
    for (let n = d; n && n.id !== 'ftg-root'; n = n.parentElement) if (n.style.display === 'none') return false;
    return true;
  });

  { const t = boot(); const p = t.G.check(() => {});
    await sleep(650);
    await t.set({ progress: 50 }); await sleep(1500);
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && !shown(t, 'RESTART TOR'),
       'restart: a slow network still downloading is not stuck');
    await t.set({ tor: 'stuck' });
    ok(shown(t, 'RESTART TOR') && /taking longer than it should/.test(t.title()),
       'restart: offered when the native side says stuck');
    ok(!shown(t, 'CONTINUE UNPROTECTED'), 'restart: the connecting screen never offers going without Tor');
    [...t.w.document.querySelectorAll('#ftg-root div')].find(d => d.textContent === 'RESTART TOR').click();
    await sleep(60);
    ok(t.sent.filter(m => m.action === 'torRetry').length === 1, 'restart: one tap asks the native side once');
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && !shown(t, 'RESTART TOR'), 'restart: connecting again takes the button away, the screen stays');
    await t.set({ tor: 'stuck' });
    ok(shown(t, 'RESTART TOR'), 'restart: offered again if it is stuck again');
    await t.set({ tor: 'connecting', progress: 60 });
    ok(!shown(t, 'RESTART TOR'), 'restart: withdrawn when Tor moves again by itself');
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await p === true && t.title() === '', 'restart: Tor up clears the screen'); }

  /* ---- and NOT offered to a phone that has nothing to work offline with ----
   *
   * The choice needs two things, both of which happen on a connection that
   * worked: the mint's keysets on file, and a bitcoin price fetched once.
   * Without them it is a door into an empty room — no wallet, no balance, no
   * mint to select, every dollar figure blank. */
  { const t = boot(); const p = t.G.check(() => {});
    await sleep(650);
    await t.set({ progress: 50, network: 'none' }); await sleep(1500);
    ok(!shown(t, 'PROCEED OFFLINE'),
       'offline: a phone that has never connected is not offered it', t.title().slice(0, 90));
    ok(/NO CONNECTION/.test(t.title()),
       'offline: it is still told plainly that there is no network', t.title().slice(0, 60));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' }); await p; }

  { const t = boot({ offlineReady: 'mintOnly' }); const p = t.G.check(() => {});
    await sleep(650);
    await t.set({ progress: 50, network: 'none' }); await sleep(1500);
    ok(!shown(t, 'PROCEED OFFLINE'),
       'offline: nor one with keysets but no price it could ever show',
       t.title().slice(0, 90));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' }); await p; }

  // ---- PROCEED OFFLINE: carrying on with no network at all ---------------------
  /* `offlineReady` seeds it: the choice is offered only to a phone that has
   * something to work offline WITH — its mint's keysets on file and a bitcoin
   * price fetched at least once. A phone that has never connected is offered
   * nothing, which is checked on its own below. */
  { const t = boot({ offlineReady: true }); const p = t.G.check(() => {});
    await sleep(650);
    await t.set({ progress: 50 }); await sleep(1500);
    /* Offered from the first frame now, not after thirty seconds of Tor deciding
     * it is stuck. Somebody who knows they have no signal should not have to prove
     * it to the app — and the button that used to appear first was RESTART TOR,
     * which is the one thing that cannot help. */
    ok(shown(t, 'PROCEED OFFLINE'), 'offline: offered from the first frame, not after a wait');
    await t.set({ tor: 'stuck' });
    ok(shown(t, 'PROCEED OFFLINE'), 'offline: and still offered once Tor says it is stuck');
    ok(!shown(t, 'CONTINUE UNPROTECTED'),
       'offline: and it did not drag unprotected onto the connecting screen with it');
    /* `stuck` is withdrawn the instant a byte moves. That is right for RESTART
     * TOR — there is nothing left to restart — and wrong for this one: a button
     * that vanishes under the thumb of somebody reaching for it is the failure
     * the gate file itself complains about. */
    await t.set({ tor: 'connecting', progress: 60 });
    ok(!shown(t, 'RESTART TOR'), 'offline: Tor moving again takes RESTART TOR away, as before');
    ok(shown(t, 'PROCEED OFFLINE'), 'offline: but the offline choice stays, once offered');
    [...t.w.document.querySelectorAll('#ftg-root div')].find(d => d.textContent === 'PROCEED OFFLINE').click();
    await sleep(80);
    /* Nothing is asked of the native side: there is nothing to turn on. This is
     * the difference from CONTINUE UNPROTECTED, which sends a message and has
     * iOS draw a destructive alert. */
    ok(t.sent.filter(m => m.action === 'unprotected').length === 0,
       'offline: it never asks to go unprotected');
    ok(await p === true, 'offline: the app is let through');
    ok(t.title() === '', 'offline: and the gate comes down');
    const pv = t.w.FoxyWallet.privacy();
    ok(pv.offline === true, 'offline: the wallet records the choice');
    ok(pv.tor !== 'up', 'offline: without pretending Tor is up');

    /* The route stays shut. This is the whole point: the gate is down so the app
     * can hand over ecash it already holds, and nothing may be sent. */
    let refused = '';
    try { await t.w.FoxyWallet.rate(); } catch (e) { refused = e.message; }
    ok(/offline/i.test(refused), 'offline: a request is still refused, in its own words', refused);

    /* And Tor coming up surrenders the choice by itself, with no tap. */
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(t.w.FoxyWallet.privacy().offline === false,
       'offline: Tor up gives the choice back on its own'); }

  { const t = boot({ offlineReady: true }); t.G.holdVerify(true); await t.set({ tor: 'up', everUp: true, progress: 100 });
    t.G.showLaunch(); await t.G.check(() => {});
    t.G.launchStage('Connecting to mint.test.', 60, 85); await sleep(50);
    await t.set({ tor: 'stuck' });
    /* Over the launch screen too. That screen is exactly where somebody in
     * airplane mode is stuck, watching a fox and a number that cannot finish. */
    ok(shown(t, 'PROCEED OFFLINE'), 'offline: offered over OPENING YOUR WALLET as well');
    ok(!shown(t, 'RESTART TOR'), 'offline: but RESTART TOR still is not, there');
    t.G.holdVerify(false); }

  /* ---- every control on the gate paints its own text ------------------------
   *
   * `#ftg-root` paints a black background and sets no colour, so a child that does
   * not set one inherits the page body's — dark ink, for a dark theme — and renders
   * black on black. The title, the body and the hint each set `color` for that
   * reason; PROCEED OFFLINE did not, and on a phone it was in the DOM, was
   * asserted as shown by the scenario above, and could not be seen.
   *
   * `shown()` cannot catch this and neither can any display check. What can is
   * asking whether each control names a colour at all. */
  { const t = boot();
    t.G.check(() => {});
    await sleep(650);
    const root = t.w.document.getElementById('ftg-root');
    const rootColour = root && root.style.color;
    ok(!rootColour, 'colour: the gate root sets none, which is why every child must');
    const controls = [...t.w.document.querySelectorAll('#ftg-root div')]
      .filter(d => d.style.cursor === 'pointer' && (d.textContent || '').trim());
    ok(controls.length >= 2, 'colour: found the gate’s buttons', String(controls.length));
    const bare = controls.filter(d => !d.style.color).map(d => (d.textContent || '').trim());
    ok(bare.length === 0, 'colour: every button on the gate paints its own text',
       bare.length ? 'black on black: ' + bare.join(', ') : 'all of them'); }

  /* ---- the interface goes while the wallet is open -------------------------
   *
   * Tor still believes in its circuit and takes forty-five seconds of a
   * deadline to find out otherwise — forty-five seconds of a home screen that
   * looks like a working wallet on a phone that cannot reach its mint. The path
   * monitor said so at once. */
  { const t = boot({ offlineReady: true });
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    const p = t.G.check(() => {}); await p;
    await sleep(60);
    ok(t.title() === '', 'the wallet is open with a working connection', t.title().slice(0, 40));

    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    await sleep(200);
    ok(t.title() === '', 'a blink of no network does not flash the screen',
       t.title().slice(0, 40));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(1600);
    ok(t.title() === '', 'and a handoff that comes back leaves nothing behind',
       t.title().slice(0, 40));

    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    await sleep(1700);
    ok(/NO CONNECTION/.test(t.title()),
       'but a network that stays gone says so, without waiting for Tor to notice',
       t.title().slice(0, 60));

    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(80);
    ok(t.title() === '', 'and it comes back down when the network does',
       t.title().slice(0, 60));

    /* And PROCEED OFFLINE from that screen has to stick.
     *
     * Tor's `up` outlives the interface by up to its whole deadline, and
     * `setOffline` refused the choice while it stood — so the gate said NO
     * CONNECTION, the tap took it down, the launch put it back, and round again
     * about once a second with no way in. */
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    await sleep(1700);
    ok(/NO CONNECTION/.test(t.title()), 'no network again', t.title().slice(0, 40));
    t.G.proceedOffline();
    await sleep(80);
    ok(t.w.FoxyWallet.privacy().offline === true,
       'the choice sticks even while Tor still believes in its circuit',
       JSON.stringify(t.w.FoxyWallet.privacy().offline));
    ok(t.title() === '', 'and the screen stays down', t.title().slice(0, 60));
    await sleep(1800);
    ok(t.title() === '', 'it does not come back a second later', t.title().slice(0, 60));

    /* And working offline, a network appearing is tried without being asked.
     * "CONNECTION MAY BE AVAILABLE" put the work on the person; the phone knows
     * the moment an interface is back, and trying costs nothing. Once per return of the network, not once per push. */
    const before = t.sent.filter(m => m.action === 'torRetry').length;
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'wifi' });
    await sleep(120);
    const after = t.sent.filter(m => m.action === 'torRetry').length;
    ok(after === before + 1, 'offline: a network appearing is tried at once',
       String(after - before) + ' tries');
    await t.set({ tor: 'connecting', everUp: false, progress: 10, network: 'wifi' });
    await sleep(120);
    ok(t.sent.filter(m => m.action === 'torRetry').length === after,
       'and not again on every push while it is still there',
       String(t.sent.filter(m => m.action === 'torRetry').length - after) + ' more');
    await t.set({ network: 'none' });
    await sleep(60);
    await t.set({ network: 'wifi' });
    await sleep(120);
    ok(t.sent.filter(m => m.action === 'torRetry').length === after + 1,
       'but again when it goes and comes back',
       String(t.sent.filter(m => m.action === 'torRetry').length - after));

    /* And the person sees that it is being tried.
     *
     * It was tried in silence: Foxy came back from the background with the
     * wifi just turned on, put the home screen up, and rebuilt Tor behind it,
     * so a redeem tapped in that gap was refused with nothing on screen to say
     * how long to wait, and the app was killed to get past it.
     * The screen still offers PROCEED OFFLINE, and it is on a
     * clock, because raising one over somebody working offline with no way off
     * it is what locked them out before. */
    ok(/SECURING YOUR CONNECTION/.test(t.title()),
       'offline: and the screen says the connection is being secured', t.title());
    ok(shown(t, 'PROCEED OFFLINE'),
       'offline: with the way back out of it still offered');
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(80);
    ok(t.title() === '', 'offline: and it goes by itself once Tor is up',
       t.title().slice(0, 60)); }

  // ---- NO CONNECTION: no interface at all is not a slow Tor -------------------
  { const t = boot({ offlineReady: true }); const p = t.G.check(() => {});
    await sleep(650);
    await t.set({ tor: 'connecting', progress: 20, network: 'none' });
    ok(/NO CONNECTION/.test(t.title()), 'no network: says so instead of climbing to 99',
       t.title());
    ok(shown(t, 'PROCEED OFFLINE'), 'no network: offers to work offline');
    ok(shown(t, 'TRY AGAIN'), 'no network: and to try again once there is one');
    ok(!shown(t, 'RESTART TOR'),
       'no network: never RESTART TOR, which cannot help with nothing to restart through');

    /* And it goes away by itself when an interface arrives — somebody turning
     * airplane mode off should not have to tap anything. */
    await t.set({ tor: 'connecting', progress: 20, network: 'wifi' });
    ok(/SECURING YOUR CONNECTION/.test(t.title()),
       'no network: a network arriving puts the connecting screen back', t.title());
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    ok(await p === true, 'no network: and Tor coming up clears it'); }

  { const t = boot(); const p = t.G.check(() => {});
    await sleep(650);
    /* Before the system has answered. 'unknown' must not be read as 'none': a
     * launch that says NO CONNECTION for a moment and then changes its mind is
     * worse than one that waits. */
    await t.set({ tor: 'connecting', progress: 10, network: 'unknown' });
    ok(!/NO CONNECTION/.test(t.title()),
       'no network: unknown is not none, and accuses nothing', t.title());
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await p === true, 'no network: unknown still lets a normal launch through'); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'failed' });
    ok(await p === false && shown(t, 'RETRY') && !shown(t, 'RESTART TOR'), 'restart: the failure screen keeps RETRY, not RESTART TOR'); }

  { const t = boot(); t.G.holdVerify(true); await t.set({ tor: 'up', everUp: true, progress: 100 });
    t.G.showLaunch(); await t.G.check(() => {});
    t.G.launchStage('Connecting to mint.test.', 60, 85); await sleep(50);
    await t.set({ tor: 'stuck' });
    ok(!shown(t, 'RESTART TOR'), 'restart: never over OPENING YOUR WALLET');
    t.G.holdVerify(false); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'stopped' });
    ok(await p === false && /TOR STOPPED/.test(t.title()) && /open it again/.test(t.title()),
       'stopped: says to close and reopen Foxy');
    ok(!shown(t, 'RETRY') && !shown(t, 'RESTART TOR'), 'stopped: no button that cannot help');
    ok(shown(t, 'CONTINUE UNPROTECTED'), 'stopped: going without Tor is still offered');
    ok(/TOR STOPPED/.test(t.G.warning() ? t.G.warning().text : 'TOR STOPPED') , 'stopped: warning row, if any, says so'); }

  { const t = boot(); const p = t.G.check(() => {});
    await t.set({ tor: 'up', everUp: true }); await p;
    await t.set({ tor: 'stopped' });
    ok(/TOR STOPPED/.test(t.title()), 'stopped after Tor was up: the screen comes up over the app'); }

  // ---- the first setup, and a percentage that keeps moving ------------------------
  /* The screen carries no running commentary any more: no
   * first-setup warning, no "trying a bridge", no "setting up a private
   * connection" — a title, a number, and the circuit. The words that remain
   * are the ones a person can act on, and those live with the button. */
  { const t = boot(); await t.set({ firstSetup: true }); const p = t.G.check(() => {});
    await sleep(650);
    ok(!/initial setup/.test(t.title()), 'first setup: no warning about the slow first start');
    await t.set({ transport: 'snowflake' });
    ok(!/Snowflake/.test(t.title()), 'a blocked network: no commentary about the transport');
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'and the screen still says what it is doing');
    await t.set({ tor: 'up', everUp: true, firstSetup: false }); await p; }

  { const t = boot(); await t.set({ firstSetup: false }); const p = t.G.check(() => {});
    await sleep(650);
    ok(!/private connection/.test(t.title()) && !/initial setup/.test(t.title()),
       'not the first setup: still no line under the title');
    await t.set({ tor: 'up', everUp: true }); await p; }


  /* ---- it always says so, even when nothing was ever shown -------------------
   *
   * Tor is sometimes up before the person has looked at the phone: the launch
   * screen never appeared, and the whole thing went by without a word, which
   * left a new person with no idea any of it had happened. */
  { const t = boot(); await t.set({ tor: 'up', everUp: true, progress: 100 });
    t.G.holdVerify(true);
    ok(await t.G.check(() => {}) === true, 'silent launch: it is through at once');
    t.G.hide();
    ok(t.title() === '', 'silent launch: nothing on screen before the ending');
    /* Nothing was shown, so there is nothing to finish: it goes straight to
     * the home screen, where the banner carries the words permanently. */
    t.G.holdVerify(false);
    ok(t.title() === '', 'silent launch: nothing is shown at the end either');
    await sleep(600);
    ok(t.title() === '', 'silent launch: and it stays that way'); }

  /* ---- the number is a pace, not a measurement --------------------------------
   *
   * Every arrival counts from nothing to 99 over paceMs and waits there; 100
   * comes only when the launch is genuinely through. It
   * used to follow Tor's own bootstrap, which arrives in bursts — 5, 10, 14,
   * 15, 75, 90, 100 in about three seconds — and then left the screen parked
   * at whatever that reached while the mint took another ten. The pace is the
   * same every time; the ending is the part that is true.
   */
  { const t = boot(); t.G.paceMs = 400; t.G.waitMs = 120; t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0 });
    const p = t.G.check(() => {});
    await sleep(60);
    const early = pctOf(t);
    ok(early > 0 && early < 60, 'pace: it sets off from nothing (' + early + '%)');
    await sleep(1000);
    const quick = pctOf(t);
    ok(quick >= 90 && quick < 99, 'pace: the quick part stops at 90 (' + quick + '%)');
    await sleep(400);
    const crept = pctOf(t);
    ok(crept > quick && crept <= 99, 'pace: then a point at a time while it works (' + crept + '%)');
    await sleep(1400);
    ok(pctOf(t) === 99, 'pace: and no further than 99 (' + pctOf(t) + '%)');
    await t.set({ tor: 'up', everUp: true, progress: 100 });
    ok(await p === true, 'pace: the launch carries on underneath it');
    ok(pctOf(t) === 99, 'pace: Tor alone does not finish it (' + pctOf(t) + '%)');
    t.G.launchStage('mint', 60, 92); await sleep(60);
    ok(pctOf(t) === 99, 'pace: nor does the mint step (' + pctOf(t) + '%)');
    t.G.holdVerify(false);
    ok(pctOf(t) === 100, 'pace: 100 only once everything is through (' + pctOf(t) + '%)');
    await sleep(2600); }

  // and a second arrival starts from nothing again, not from where it left off
  { const t = boot(); t.G.paceMs = 400; t.G.waitMs = 60; t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0 });
    const p = t.G.check(() => {});
    await sleep(2200);                 // 90 quick steps, then nine slow ones
    ok(pctOf(t) === 99, 'pace: up to 99 on the first visit (' + pctOf(t) + '%)');
    await t.set({ tor: 'up', everUp: true, progress: 100 }); await p;
    t.G.holdVerify(false); await sleep(2600);
    t.G.holdVerify(true); t.G.showLaunch();
    await sleep(60);
    const again = pctOf(t);
    ok(again > 0 && again < 60, 'pace: the next visit sets off from nothing again (' + again + '%)');
    t.G.holdVerify(false); await sleep(2600); }

  /* ---- choosing to work offline ends this file's business ----------------
   *
   * `proceedOffline` took the gate down and the launch's next step put it
   * straight back up, then played SECURING YOUR CONNECTION over a phone with
   * its radios off — eleven milliseconds after the tap, for a second and a half.
   * There is no connection to secure. */
  { const t = boot(); t.G.paceMs = 400; t.G.waitMs = 60; t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0 });
    t.G.showLaunch();
    await sleep(80);
    ok(/SECURING YOUR CONNECTION/.test(t.title()),
      'offline: the connecting screen is up to begin with', t.title().slice(0, 40));

    t.G.proceedOffline();
    await sleep(40);
    ok(t.title() === '', 'and the tap takes it down', t.title().slice(0, 60));

    // the launch carries on behind it, exactly as it does on the phone
    t.G.launchStage('mint', 60, 90);
    t.G.launchStage('balance', 92, 100);
    await sleep(60);
    ok(t.title() === '', 'the launch steps do not put it back up', t.title().slice(0, 60));

    t.G.showLaunch();
    await sleep(40);
    ok(t.title() === '', 'nor does showLaunch', t.title().slice(0, 60));

    /* And `check` least of all, which is the one that mattered: it IS the app's
     * boot, and `proceedOffline` runs the app's boot — so it came straight back,
     * found the launch still held, and raised the screen again. Tap, down, up,
     * about twice a second, and no way into the app at all. */
    const again = await t.G.check(() => {});
    await sleep(80);
    ok(again === true, 'check answers true: the person said carry on', String(again));
    ok(t.title() === '', 'and does not raise the screen again', t.title().slice(0, 60));
    await t.G.check(() => {});
    await t.G.check(() => {});
    await sleep(80);
    ok(t.title() === '', 'however many times the boot comes round', t.title().slice(0, 60));

    t.G.holdVerify(false);
    await sleep(2600);
    ok(t.title() === '', 'and the ending never plays', t.title().slice(0, 60));

    /* And the way back in, from the banner's TAP TO RETRY: the same screen
     * either way, wearing the honest face of itself — NO CONNECTION with no
     * interface, SECURING YOUR CONNECTION with one. */
    t.G.holdVerify(true);
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'none' });
    t.G.leaveOffline();
    await sleep(120);
    ok(/NO CONNECTION/.test(t.title()),
      'retry with no data lands on NO CONNECTION', t.title().slice(0, 60));
    ok(/PROCEED OFFLINE/.test(t.title()),
      'and still offers the way back in', t.title().slice(0, 80));

    t.G.proceedOffline();
    await sleep(40);
    await t.set({ tor: 'connecting', everUp: false, progress: 10, network: 'wifi' });
    t.G.leaveOffline();
    await sleep(120);
    ok(/SECURING YOUR CONNECTION/.test(t.title()),
      'retry with data lands on the connecting screen', t.title().slice(0, 60));
    ok(!/NO CONNECTION/.test(t.title()),
      'and not on NO CONNECTION', t.title().slice(0, 60));
    t.G.holdVerify(false);
  }

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall scenarios pass');
  process.exit(failures ? 1 : 0);
})();
