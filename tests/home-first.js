'use strict';
/* home-first.js — Foxy opens on the home screen, and the connection is a banner.
 *
 *     node tests/home-first.js
 *
 * Every launch and every return used to wait behind SECURING YOUR CONNECTION:
 * three to fifteen seconds before a balance could be read, and a second and a
 * half of the screen's ending after Tor was already up. A wallet that has
 * connected once can work before the connection, from what is on file. So the
 * connection screen stays down, the wallet works offline until Tor is really
 * up, and the banner at the foot of the home screen says which it is. Only a
 * first launch, with nothing on file, still waits behind the screen.
 *
 * Web/foxy-tor-gate.js and Web/foxy-wallet.js in jsdom with a fake native side
 * (tests/gate-kit.js), the app's own return set-up and banner from
 * build/foxy-app.js, and then the wallet's wait for a route that is on its way
 * against a fake mint (tests/harness.js). */
const fs = require('fs');
const path = require('path');
const { boot, sleep, ROOT } = require('./gate-kit');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
let failures = 0;
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 60000).unref();
const ok = (c, msg, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + msg + (detail && !c ? ' — ' + detail : ''));
  if (!c) failures++;
};

/* A phone that has connected before: its mint's keysets and a price on file. */
const home = (o) => {
  const t = boot(Object.assign({ offlineReady: true, homeFirst: true }, o || {}));
  // not a first launch: the notice a new install is shown is not what this is about
  t.w.localStorage.setItem('foxy.warned', String(Date.now()));
  return t;
};
const appSrc = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const method = (sig) => {
  const start = appSrc.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', start), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(start + 3, i + 1);
};
/* The app's own set-up for a return, on the real gate. */
const returning = (t) => {
  const did = [];
  Object.defineProperty(t.W, 'connected', { get: () => true, configurable: true });
  const app = Object.assign(t.w.eval('(function () { return {' + method('setUpAfterReturn() {') + '}; })()'), {
    pinUnlocked: () => Promise.resolve(),
    listenWallet() { did.push('listen'); }, loadHistory() { did.push('history'); },
    resumeLoad() { did.push('load'); return Promise.resolve(); }, refreshBalance() { did.push('balance'); },
  });
  // whether this file's screen showed at any moment while `ms` went by
  const watch = async (ms) => {
    const seen = new Set();
    for (let at = 0; at < ms; at += 15) { seen.add(t.title() ? 'up' : 'down'); await sleep(15); }
    return seen;
  };
  return { app, did, watch };
};
const banner = (t) => t.w.eval('(function () { return {' + method('torBannerVals() {') + '}; })()').torBannerVals();

(async () => {
  /* ---- a launch -------------------------------------------------------- */
  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 5, network: 'wifi' });
    t.G.holdVerify(true); t.G.showLaunch();
    const went = await t.G.check(() => {});
    await sleep(60);
    ok(went === true && t.title() === '' && !t.G.visible(),
       'launch, Tor still connecting: the app is let through at once and no screen goes up', t.title().slice(0, 40));
    ok(t.W.privacy().offline === true, 'the wallet works offline meanwhile');
    ok(banner(t).torBannerText === 'SECURING YOUR CONNECTION' && banner(t).torBannerShown === true,
       'and the banner says SECURING YOUR CONNECTION', banner(t).torBannerText);
    let refused = '';
    try { await t.W.rate(); } catch (e) { refused = e.message; }
    ok(/securing its connection/i.test(refused), 'a request that needs the connection says it is being secured', refused);
    t.G.launchStage('mint', 60, 92); t.G.launchStage('balance', 92, 100);
    t.G.holdVerify(false);
    await sleep(1700);
    ok(t.title() === '', 'the launch\'s own steps and its ending raise nothing', t.title().slice(0, 40));
    ok(!t.sent.some(m => m.action === 'torRetry'),
       'and Tor, which is already setting itself up, is not restarted');
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(60);
    ok(t.W.privacy().offline === false && t.title() === '',
       'Tor comes up: working offline is given up by itself, still with nothing shown');
    ok(banner(t).torBannerText === 'Secure Tor Connection', 'and the banner turns to Secure', banner(t).torBannerText); }

  /* Before the phone has said what network it has, which is how every launch
   * begins: the first word from it must not be read as "a network appeared"
   * and restart a Tor that is seconds into setting itself up. */
  { const t = home();
    t.G.holdVerify(true); t.G.showLaunch();
    await t.G.check(() => {});
    ok(t.W.privacy().offline === true && t.title() === '', 'launch before the phone has said anything: home, offline');
    await t.set({ tor: 'connecting', everUp: false, progress: 10, network: 'wifi' });
    await t.set({ tor: 'stuck', everUp: false, progress: 10, network: 'wifi' });
    await sleep(60);
    ok(!t.sent.some(m => m.action === 'torRetry') && t.title() === '',
       'the phone then saying it is on wifi, and Tor being slow, restart nothing and raise nothing',
       t.sent.filter(m => m.action === 'torRetry').length + ' restart(s)'); }

  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'none' });
    t.G.holdVerify(true); t.G.showLaunch();
    const went = await t.G.check(() => {});
    await sleep(60);
    ok(went === true && t.title() === '' && t.W.privacy().offline === true,
       'launch with no network: home at once, offline', t.title().slice(0, 40));
    ok(banner(t).torBannerText === 'OFFLINE - NO CONNECTION', 'the banner says OFFLINE - NO CONNECTION', banner(t).torBannerText);
    let refused = '';
    try { await t.W.rate(); } catch (e) { refused = e.message; }
    ok(/working offline/i.test(refused), 'and a request says offline, not that a connection is coming', refused);
    await sleep(1700);
    ok(t.title() === '', 'the screen for a lost network does not come up either', t.title().slice(0, 40));
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'wifi' });
    await sleep(60);
    ok(t.sent.some(m => m.action === 'torRetry') && t.title() === '',
       'a network appearing after that is tried at once, still with no screen'); }

  // a first launch, with nothing on file: the screen, as it always was
  { const t = boot({ homeFirst: true });
    t.w.localStorage.setItem('foxy.warned', String(Date.now()));
    await t.set({ tor: 'connecting', everUp: false, progress: 5, network: 'wifi' });
    t.G.holdVerify(true); t.G.showLaunch();
    await sleep(80);
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && t.W.privacy().offline !== true,
       'a first launch, with no wallet on file to show, still waits behind the connection screen', t.title().slice(0, 40));
    t.G.holdVerify(false); }

  /* Tor up before the launch's check (the person was at the Face ID prompt):
   * working offline was given up by itself, and the launch's hold put the
   * screen up over a connected wallet and played its ending. */
  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 5, network: 'wifi' });
    t.G.holdVerify(true); t.G.showLaunch();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    const went = await t.G.check(() => {});
    await sleep(80);
    ok(went === true && t.title() === '' && t.W.privacy().offline === false,
       'Tor up by the time the launch checks: let through, nothing shown', t.title().slice(0, 40));
    t.G.launchStage('balance', 92, 100); t.G.holdVerify(false);
    await sleep(1700);
    ok(t.title() === '' && !t.G.visible(), 'and no ending plays over the home screen', t.title().slice(0, 40)); }

  /* ---- the connection goes, mid-session -------------------------------- */
  { const t = home();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await t.G.check(() => {});
    ok(t.W.privacy().offline !== true && t.title() === '', 'mid-session: connected, nothing on screen');
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    await sleep(1700);
    ok(t.title() === '' && t.W.privacy().offline === true,
       'the network goes: offline, and no NO CONNECTION screen over what the person was doing', t.title().slice(0, 40));
    ok(banner(t).torBannerText === 'OFFLINE - NO CONNECTION', 'the banner says so', banner(t).torBannerText);
    await t.set({ tor: 'connecting', everUp: true, progress: 20, network: 'wifi' });
    await sleep(80);
    ok(t.title() === '' && banner(t).torBannerText === 'SECURING YOUR CONNECTION',
       'the network returns: no screen for the try, and the banner says a connection is being secured',
       t.title().slice(0, 30) + ' / ' + banner(t).torBannerText);
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(60);
    ok(t.W.privacy().offline === false, 'and it is given up when Tor is up'); }

  { const t = home();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await t.G.check(() => {});
    await t.set({ tor: 'connecting', everUp: true, progress: 30, network: 'wifi' });
    await sleep(60);
    ok(t.title() === '' && t.W.privacy().offline === true && banner(t).torBannerText === 'SECURING YOUR CONNECTION',
       'Tor loses its circuit with the network still there: offline with the banner, not a limbo with neither',
       banner(t).torBannerText); }

  /* ---- what Tor cannot do by itself: the banner, and a tap ------------- */
  { const t = home();
    await t.set({ tor: 'stopped', everUp: true, progress: 0, network: 'wifi' });
    t.G.showLaunch(); await t.G.check(() => {});
    await sleep(80);
    ok(t.title() === '' && t.W.privacy().offline === true,
       'Tor stopped: no screen by itself over the home screen', t.title().slice(0, 40));
    ok(banner(t).torBannerText === 'CANNOT CONNECT — TAP TO RETRY', 'the banner says CANNOT CONNECT', banner(t).torBannerText);
    t.G.leaveOffline(); await sleep(150);
    // (this fake phone lets a stopped Tor be retried, so either face of that screen may show)
    ok(/TOR STOPPED|CANNOT CONNECT TO TOR/.test(t.title()), 'the tap brings the screen that says what to do', t.title().slice(0, 40)); }

  { const t = home();
    await t.set({ tor: 'connecting', everUp: true, progress: 10, network: 'wifi', orbot: 'needs-access', vpn: true });
    t.G.showLaunch(); await t.G.check(() => {});
    await sleep(80);
    ok(t.title() === '', 'Orbot in the way: nothing raised by itself', t.title().slice(0, 40));
    t.G.leaveOffline(); await sleep(150);
    ok(/ORBOT DETECTED/.test(t.title()), 'and the tap brings the Orbot screen', t.title().slice(0, 40)); }

  // the banner's tap while Tor is at work: the screen, which then closes itself
  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 12, network: 'wifi' });
    t.G.showLaunch(); await t.G.check(() => {});
    t.G.leaveOffline(); await sleep(150);
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'a tap on the banner shows the connection screen', t.title().slice(0, 40));
    // the app asking again waits behind it, as a launch used to, and does not put it away
    const asking = t.G.check(() => {});
    await sleep(60);
    ok(/SECURING YOUR CONNECTION/.test(t.title()) && t.W.privacy().offline !== true,
       'which the app asking again does not put away: the person asked for it', t.title().slice(0, 40));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    ok((await asking) === true, 'and that asking is answered when Tor is through');
    await sleep(120);
    ok(t.title() === '', 'and the screen comes down by itself', t.title().slice(0, 40)); }
  // with nobody asking, it still comes down: it used to stay at whatever the count had reached
  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 12, network: 'wifi' });
    t.G.showLaunch(); await t.G.check(() => {});
    t.G.leaveOffline(); await sleep(150);
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(120);
    ok(t.title() === '' && !t.G.visible(), 'a tapped screen with nothing waiting behind it comes down when Tor is through', t.title().slice(0, 40)); }

  /* ---- a request that wants the connection waits for one on its way ---- */
  { const t = home({ routeWaitMs: 400 });
    await t.set({ tor: 'connecting', everUp: false, progress: 40, network: 'wifi' });
    t.G.showLaunch(); await t.G.check(() => {});
    const began = Date.now();
    const asked = t.G.quiet();
    setTimeout(() => t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' }), 120);
    const went = await asked;
    const took = Date.now() - began;
    ok(went === true && took >= 100 && took < 380 && t.W.privacy().offline === false && t.title() === '',
       'a request made while Tor is 120 ms from up waits for it, with no screen, and goes with a connection', took + ' ms'); }
  { const t = home({ routeWaitMs: 300 });
    await t.set({ tor: 'connecting', everUp: false, progress: 40, network: 'wifi' });
    t.G.showLaunch(); await t.G.check(() => {});
    const began = Date.now();
    const went = await t.G.quiet();
    const took = Date.now() - began;
    ok(went === true && took >= 280 && took < 900 && t.W.privacy().offline === true,
       'one that never comes is waited for only so long, and the request goes on offline', took + ' ms'); }
  { const t = home({ routeWaitMs: 5000 });
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'none' });
    t.G.showLaunch(); await t.G.check(() => {});
    const began = Date.now();
    const went = await t.G.quiet();
    ok(went === true && Date.now() - began < 200, 'and with no network nothing is waited for at all', (Date.now() - began) + ' ms'); }

  /* ---- a return to the app ---------------------------------------------- */
  { const t = home();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await t.G.check(() => {});
    ok(t.title() === '' && t.G.connected() === true && !t.G.visible(), 'return: home, with Tor up over wifi');
    const r = returning(t);
    const before = t.sent.length;
    const run = r.app.setUpAfterReturn();
    const seen = await r.watch(400);
    await run;
    ok(!seen.has('up'), 'back with the circuit still up: no connection screen, not for a moment', Array.from(seen).join(','));
    /* And the phone is told the page has the screen. Its cover over a return
     * waits for that word, which only a connection screen going up used to
     * say: with none raised, the splash sat over a connected wallet for the
     * four seconds of the phone's own backstop. */
    ok(t.sent.slice(before).some(m => m.action === 'covered'),
       'and the phone is told its cover can come off, with no connection screen to say so');
    ok(['listen', 'history', 'load'].every(k => r.did.includes(k)),
       'what a return looks for is still looked for: history, the sweeps, the balance', r.did.join(','));

    // Tor was taken off the network while away, and is being set up again
    await t.set({ tor: 'connecting', everUp: true, progress: 10, network: 'wifi' });
    ok(t.G.connected() === false, 'a Tor that is setting up again is not connected');
    const r2 = returning(t);
    const before2 = t.sent.length;
    const run2 = r2.app.setUpAfterReturn();
    const seen2 = await r2.watch(400);
    await run2;
    ok(!seen2.has('up') && t.W.privacy().offline === true,
       'back after Tor was taken down: the home screen at once, offline, and no connection screen', Array.from(seen2).join(','));
    ok(t.sent.slice(before2).some(m => m.action === 'covered'), 'with the phone\'s cover told to come off');
    ok(['listen', 'history', 'load'].every(k => r2.did.includes(k)), 'and the return\'s own loading done', r2.did.join(','));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await sleep(60);
    ok(t.W.privacy().offline === false && t.title() === '', 'then connected, with nothing ever shown'); }

  // with the switch off, a return waits behind the screen as it used to
  { const t = boot({ offlineReady: true });
    t.w.localStorage.setItem('foxy.warned', String(Date.now()));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await t.G.check(() => {});
    t.G.holdVerify(false); await sleep(1800);
    await t.set({ tor: 'connecting', everUp: true, progress: 10, network: 'wifi' });
    const r = returning(t);
    const run = r.app.setUpAfterReturn();
    await sleep(80);
    ok(/SECURING YOUR CONNECTION/.test(t.title()), 'home first switched off: that return gets the connection screen', t.title().slice(0, 40));
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'wifi' });
    await run; await sleep(1800);
    ok(t.title() === '', 'which comes down once Tor is through', t.title().slice(0, 40)); }

  // what counts as connected, for a return
  { const t = home();
    await t.set({ tor: 'up', everUp: true, progress: 100, network: 'none' });
    ok(t.G.connected() === false, 'connected: a circuit over no network is not a connection');
    ok(t.W.privacy().offline === true, 'and such a phone is working offline'); }
  { const t = home();
    await t.set({ tor: 'connecting', everUp: false, progress: 0, network: 'wifi', unprotected: true });
    t.G.showLaunch(); await t.G.check(() => {});
    ok(t.G.connected() === true && t.W.privacy().offline !== true && t.W.privacy().unprotected === true,
       'the choice to go without Tor is a connection over a network, and home first leaves that choice alone'); }

  /* ---- the fox: the first launch after install, and no other ------------ */
  { const film = (t) => Array.from(t.w.document.querySelectorAll('div'))
      .some(d => /foxy-splash-still\.png/.test(d.getAttribute('style') || ''));
    const first = boot({ intro: 'fresh' });
    ok(film(first) && !!first.w.localStorage.getItem('foxy.intro.seen'),
       'the fox plays on the first launch after install, and that is written down');
    const again = boot({ intro: 'seen' });
    ok(!film(again), 'and not on a launch after it');
    const daily = boot({});
    ok(!film(daily), 'nor on a phone that carries the old once-a-day mark: it has seen it'); }

  /* ---- the wallet: a route that is on its way is waited for ------------- */
  const MINT = 'https://m.test';
  const page = (o) => {
    const opts = o || {};
    const phone = nativePhone({ words: opts.words || PHONE_WORDS });
    let mint = null;
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      routeWaitMs: opts.routeWaitMs,
      bridge: (w, m) => {
        if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
        if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
        const got = phone.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true }); },
    });
    ctx.mint = mint;
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  };
  const coming = (W) => W._privacy({ tor: 'connecting', progress: 40, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
  const up = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
  const dark = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'none' });
  {
    const payer = page({});
    await payer.W.connect(MINT, null, null, { remember: true });
    const inv = await payer.W.invoice(2000, '');
    await payer.W.claim(inv.hash);
    const rx = page({ sharedMint: payer.mint, routeWaitMs: 500,
      words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
    await rx.W.connect(MINT, null, null, { remember: true });
    let asked = 0;
    rx.W.onOfflineOffer(() => { asked += 1; return Promise.resolve(false); });

    // plain ecash scanned in the first seconds of a session, with Tor 120 ms from up
    const one = await payer.W.sendToken(30, { unit: 'sat' });
    coming(rx.W);
    ok(rx.W.routeComing() === true, 'wallet: Tor at work over a network is a route on its way');
    const before = await rx.W.balanceSats();
    const began = Date.now();
    const taking = rx.W.receiveToken(one.token).then((r) => r, (e) => ({ why: e && e.message }));
    setTimeout(() => up(rx.W), 120);
    const took = await taking;
    ok(asked === 0 && !took.why && took.kept !== true && (await rx.W.balanceSats()) === before + 30,
       'a token scanned while the connection is 120 ms off waits for it and is swapped in: no HIGH RISK card',
       JSON.stringify(took).slice(0, 120) + ', asked ' + asked);
    ok(Date.now() - began >= 100, 'having waited for the connection, and no longer than it took', (Date.now() - began) + ' ms');

    // with no network there is nothing to wait for, and the person is asked at once, as before
    const two = await payer.W.sendToken(31, { unit: 'sat' });
    dark(rx.W);
    ok(rx.W.routeComing() === false, 'no network is not a route on its way');
    const began2 = Date.now();
    const refused = await rx.W.receiveToken(two.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(asked === 1 && !!refused.why && Date.now() - began2 < 200,
       'the same scan with no network asks the person at once', asked + ' asked, ' + (Date.now() - began2) + ' ms');

    // and a connection that never arrives is waited for only so long
    coming(rx.W);
    const began3 = Date.now();
    const late = await rx.W.receiveToken(two.token).then((r) => r, (e) => ({ why: e && e.message }));
    ok(asked === 2 && !!late.why && Date.now() - began3 >= 450 && Date.now() - began3 < 1500,
       'one that does not come is waited for half a second here, and then the offline way is taken',
       asked + ' asked, ' + (Date.now() - began3) + ' ms');
    up(rx.W);

    // the payer's side: the lock a request asks for is kept when the route arrives in time
    await rx.W.primeLocks();
    const ask = rx.W.decodeRequest(rx.W.paymentRequest(28, { purpose: 'receive' })) || {};
    payer.W._routeWaitMs = 500;
    const said = [];
    const con = payer.window.console, log = con.log;
    con.log = (...a) => { said.push(a.join(' ')); };
    coming(payer.W);
    const paying = payer.W.payRequest(Object.assign({}, ask, { sats: 28, unit: 'sat', viaTap: true }), () => {})
      .then((r) => r, (e) => ({ why: e && e.message }));
    setTimeout(() => up(payer.W), 120);
    await paying;
    con.log = log;
    ok(said.some((l) => /a connection is on its way; waiting for it/.test(l))
       && !said.some((l) => /the lock the request asked for is dropped/.test(l)),
       'a payer whose connection is 120 ms off waits for it and keeps the lock the request asked for',
       said.filter((l) => /lock|connection is on its way/.test(l)).join(' | ').slice(0, 160));
  }

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall home-first checks pass');
  process.exit(failures ? 1 : 0);
})();
