'use strict';
/* gate-kit.js — the connection screen and the wallet in one jsdom page, with a
 * fake native side whose Tor state a scenario sets. Shared by
 * tests/gate-scenarios.js (the screens) and tests/home-first.js (Foxy opening
 * on the home screen, with the connection as a banner). */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    // `intro: 'fresh'` is a phone that has never played it: the first launch after install
    if (opts.intro !== 'fresh') {
      w.localStorage.setItem(opts.intro === 'seen' ? 'foxy.intro.seen' : 'foxy.intro.day',
        d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate());
    }
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
  /* Home first is its own suite (tests/home-first.js). Everything else here is
   * about the screens a launch waits behind, which a first launch still does
   * and which the banner's tap still brings; so it is off unless asked for. */
  w.FoxyGate.homeFirst = !!opts.homeFirst;
  // and a route that is on its way is not waited for unless a scenario is about the wait
  w.FoxyWallet._routeWaitMs = opts.routeWaitMs || 0;
  const set = async patch => { Object.assign(native, patch); push(); await sleep(25); };
  const title = () => { const r = w.document.getElementById('ftg-root'); return r && r.style.display !== 'none' ? r.textContent : ''; };
  const threw = fn => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); return ''; } catch (e) { return e.message; } };
  return { w, W: w.FoxyWallet, G: w.FoxyGate, native, set, sent, title, threw };
}

module.exports = { boot, sleep, ROOT };
