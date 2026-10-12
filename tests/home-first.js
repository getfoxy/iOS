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
 * against a fake mint (tests/harness.js).
 *
 * And what is scanned in those seconds: a Lightning address, an invoice or a
 * payment request goes through its usual screens to a confirmation whose button
 * reads CHECKING, and does nothing, until the route is up and the address has
 * been looked up and the fee quoted; then SEND, by itself. With no network, or
 * a Tor that has given up, the card for no connection is what it always was, and
 * comes up over a confirmation that was waiting. The last part mounts the real
 * page, since only the page makes a route coming up an update. */
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
    ok(banner(t).torBannerText === 'Tor', 'and the banner turns to Tor', banner(t).torBannerText); }

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
    // every request that left the page, with the circuit it asked for; and an address's server, when a scenario has one
    const requests = [];
    const ctx = loadReal({
      routeWaitMs: opts.routeWaitMs,
      bridge: (w, m) => {
        if (m.action === 'mintRequest') {
          requests.push({ url: m.url, circuit: m.circuit });
          if (opts.address && !/^https:\/\/m\.test\//.test(String(m.url))) {
            const got = opts.address(m, requests.filter((r) => r.url === m.url).length);
            // 'hang' is never answered; a promise is answered when the scenario says
            if (got && typeof got.then === 'function') return got.then((text) => reply(w, m.id, text));
            return got === 'hang' ? undefined : reply(w, m.id, got);
          }
          return reply(w, m.id, mint.handle(m));
        }
        if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
        const got = phone.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, Object.assign({ p2pk: true }, opts.mint || {})); },
    });
    ctx.mint = mint;
    ctx.requests = requests;
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

  /* ---- a payment scanned while the connection is on its way ------------------
   *
   * Foxy comes back from the background working offline for the few seconds Tor
   * takes to connect. What was scanned in them was turned away with the card for
   * no connection (an invoice), or sent on to fail after SEND (an address), or
   * paid the worse way (a request). Now it goes through the screens it always
   * goes through, and the confirmation's button reads CHECKING, and does
   * nothing, until the route is up and what it needs the route for has answered:
   * an address is looked up and the fee on its invoice is quoted, an invoice is
   * quoted, and a request is paid over the route it names. Then it reads SEND.
   *
   * The app's own methods, lifted from the build onto the page of a real wallet
   * at a fake mint, a fake address server behind the wallet's bridge, and the
   * route set the way the native side sets it (`coming`, `up`, `dark`, Tor
   * giving up). The wallet's lookup, quote and payment are the real ones; the
   * screen's repaint after any change is a call to `syncSend`, which is what
   * its componentDidUpdate makes. */
  const LIFTED = ['connecting() {', 'offlineNow() {', 'acceptTarget(text) {', 'offlineInvoiceCard() {', 'openRequest(text, opts) {',
    'requestNeedsRoute(req) {', 'requestHere(req) {', 'tellPayerShort(req) {', 'shortForReceiver() {', 'saidToReceiver(why) {', 'wantedSats() {', 'typedSats() {', 'sendSatsNow() {', 'sendAsk() {', 'sendToAsk() {', 'quoteSendFee() {',
    'syncSend() {', 'notOnlineCard() {', 'toConfirm() {', 'toAmount() {', 'confirmSpec() {', 'requestSpec() {', 'cfRow(label, value, opt) {',
    'sendToText() {', 'shortId(v) {', 'sendAmountText() {', 'money(sats, fiatCents) {', 'usd(v) {', 'group(n) {', 'satUsd() {',
    'px() {', 'peerRate() {', 'peerRateLabel() {', 'peerRateRow() {', 'heldBlocks(shortBy) {', 'heldNote() {',
    'unitLabel(unit) {', 'startSend() {', 'startSendNow(to) {', 'torBannerVals() {'];
  const AMOUNTLESS = 'lnbc1p4ttszqpp5c6utwdk6cmla7kmz4nf89avnlyrzqrkhz0jx06hsltwmw9afwheqdqqcqzzs'
    + 'xqrrs0fppq9eka5xeg7p7sezkmmkc02cpffc2ekcdssp5hcpux550uxjsc3nj3qhvqa7rmz7hsp7yel3eveh3'
    + 'vg8awmve4fds9qxpqysgqtsd5g8er8mhnst3eres2455nxxm4kd44c4uwa3fvu8ueqsgf4vd5ft94jk8u54ahh'
    + 'vx9nmlz4r4z2w7yvcpd7nrk7d8yy489lfg5djspkrewuj';
  const PRICED = 'lnbc170n1pcheque' + 'q'.repeat(40);      // 17 sats, from nobody this mint knows
  const META = '[["text/plain","Pay alice"]]';
  // an invoice-shaped string with the description hash of `text` in its h field (tests/run.js `invoiceFor`)
  const invoiceFor = (prefix, text) => {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const hash = require('crypto').createHash('sha256').update(text, 'utf8').digest();
    const words = [];
    let acc = 0, bits = 0;
    for (const b of hash) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
      acc &= (1 << bits) - 1;
    }
    if (bits) words.push((acc << (5 - bits)) & 31);
    return prefix + [0, 0, 0, 0, 0, 0, 0, 23, 1, 20].concat(words, new Array(104).fill(0)).map((v) => CHARSET[v]).join('') + 'qqqqqq';
  };
  // asked for an amount, it writes an invoice for it (n is nano-bitcoin: a hundred millisats each)
  const addressServer = (m) => '200\n' + JSON.stringify(/\/\.well-known\//.test(m.url)
    ? { tag: 'payRequest', callback: 'https://addr.test/cb', minSendable: 1000, maxSendable: 100000000, metadata: META }
    : { pr: invoiceFor('lnbc' + Math.round(Number(/amount=(\d+)/.exec(m.url)[1]) / 100) + 'n1', META) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { for (let at = 0; at < (ms || 4000); at += 20) { if (fn()) return true; await wait(20); } return false; };
  const gaveUp = (W) => W._privacy({ tor: 'failed', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
  const feeOf = (spec) => (spec.rows.find((r) => r.label === 'FEE') || {}).value;
  // a phone holding 2000 sats at the fake mint, working offline while Tor is at work: where every session begins
  const phoneAt = async (route, o) => {
    const ctx = page(Object.assign({ address: addressServer }, o || {}));
    await ctx.W.connect(MINT, null, null, { remember: true });
    await ctx.W.claim((await ctx.W.invoice((o && o.sats) || 2000, '')).hash);
    route(ctx.W);
    ctx.W.setOffline(true);
    const app = ctx.window.eval('(function () { return {' + LIFTED.map(method).join(',') + '}; })()');
    const log = { cards: [], tokens: [], toasts: [] };
    Object.assign(app, {
      log, ctx,
      state: { screen: 'home', stack: [], flow: 'send', unit: 'SATS', amount: '', balSats: (o && o.sats) || 2000 },
      setState(u) {
        Object.assign(app.state, typeof u === 'function' ? u(app.state) : u);
        Promise.resolve().then(() => app.syncSend());     // componentDidUpdate
      },
      toast(m) { log.toasts.push(m); },
      blockedCard(kind, over) { log.cards.push(Object.assign({ kind }, over)); },
      payThisMintWithToken(sats) { log.tokens.push(sats); },
      makeTokenForRequest() { log.made = (log.made || 0) + 1; },
      showMelt() {}, hideMelt() {}, mintName: () => 'MINT', stageMoney: (n) => '₿ ' + n, balNow: () => 0, refreshBalance() {}, loadHistory() {},
      tidyChangeNow() {}, showPayPending() { log.pending = true; }, isBadSignatures: () => false, back() {}, editSendNote() {},
      payOnchain() {}, takeTokenFromPaste() {},
    });
    // the app's own listener for every route change (06-wallet-boot-and-restore.js): a repaint
    ctx.W.onPrivacy(() => app.setState({ routeAt: Date.now() }));
    app.addressAsks = () => ctx.requests.filter((r) => /addr\.test/.test(r.url)).length;
    app.meltQuotes = () => ctx.requests.filter((r) => /\/v1\/melt\/quote\/bolt11$/.test(r.url)).length;
    // the keypad's NEXT, as renderAmount makes it
    app.next = () => app.setState((p) => ({ payFrom: 'BITCOIN', screen: 'sendConfirm', stack: p.stack.concat([p.screen]) }));
    return app;
  };

  // an address: to the keypad, to the confirmation held at CHECKING, and SEND by itself when the route is up
  {
    const app = await phoneAt(coming);
    const W = app.ctx.W;
    ok(app.connecting() === true && app.offlineNow() === true, 'working offline while Tor is at work is a connection on its way, as the wallet and the banner say');
    const asked = app.ctx.requests.length;
    app.acceptTarget('alice@addr.test');
    ok(app.state.screen === 'amount' && app.state.recipientKind === 'email' && app.state.recipient === 'alice@addr.test' && !app.log.cards.length,
       'a lightning address scanned while the connection is on its way goes to the keypad, and no card', app.state.screen + ' / ' + app.log.cards.map((c) => c.kind));
    app.setState({ amount: '10', unit: 'SATS' });
    app.next();
    await wait(60);
    let spec = app.confirmSpec();
    ok(spec.cta === 'CHECKING…' && spec.ctaBusy === true && feeOf(spec) === 'CHECKING…',
       'and to the confirmation, whose button reads CHECKING, and so does its FEE row', spec.cta + ' / ' + feeOf(spec));
    ok(app.ctx.requests.length === asked, 'nothing has been asked of the address or the mint: nothing is, until the route is up', String(app.ctx.requests.length - asked));
    spec.go();
    ok(app.state.screen === 'sendConfirm', 'pressing it does nothing', app.state.screen);
    up(W);
    ok(await until(() => app.state.quotedFee != null), 'the route coming up looks the address up and quotes its invoice by itself, with nothing pressed');
    spec = app.confirmSpec();
    ok(/^SEND /.test(spec.cta) && !spec.ctaBusy && feeOf(spec) === 'UP TO ₿ 10',
       'and the button turns to SEND, with the fee in the FEE row', spec.cta + ' / ' + feeOf(spec));
    ok(app.addressAsks() === 2 && app.meltQuotes() === 1, 'one lookup of the address (its two requests) and one quote at the mint', app.addressAsks() + ' / ' + app.meltQuotes());
    ok(!app.log.cards.length, 'the connection that came says nothing: no card');
    spec.go();
    ok(await until(() => app.state.sendPhase === 'settled'), 'SEND pays', JSON.stringify(app.log.cards.map((c) => c.reason)));
    ok(app.addressAsks() === 2 && app.meltQuotes() === 1,
       'with the invoice the screen looked up and the quote it asked: neither the address nor the mint was asked again', app.addressAsks() + ' / ' + app.meltQuotes());
    ok((await W.balanceSats()) < 2000, 'and the sats left', String(await W.balanceSats()));
  }

  // the amount changed while the address was still being looked up: the answer to the older question lands nothing
  {
    let release = null;
    const slow = new Promise((yes) => { release = yes; });
    const app = await phoneAt(up, { address: (m, n) => ((/\/\.well-known\//.test(m.url) && n === 1) ? slow.then(() => addressServer(m)) : addressServer(m)) });
    app.acceptTarget('alice@addr.test');
    app.setState({ amount: '10', unit: 'SATS' });
    app.next();
    await wait(80);
    ok(app.state.quotingFee === true && app.confirmSpec().cta === 'CHECKING…', 'with the route up an address is looked up at once, and the button held');
    app.setState({ amount: '20' });
    ok(await until(() => app.state.quotedAmt === 20), 'a new amount is a new question, asked at once beside the old one', String(app.state.quotedAmt));
    release();
    await wait(300);
    ok(app.state.quotedAmt === 20 && app.state.quotingFee === false && app._found && app._found.sats === 20 && app.meltQuotes() === 1,
       'and the older answer, when it comes, changes nothing: the quote is the new amount\'s, and the mint was asked once',
       JSON.stringify({ amt: app.state.quotedAmt, found: app._found && app._found.sats, quotes: app.meltQuotes() }));
    ok(/^SEND /.test(app.confirmSpec().cta) && feeOf(app.confirmSpec()) === 'UP TO ₿ 10', 'SEND, with the fee', app.confirmSpec().cta + ' / ' + feeOf(app.confirmSpec()));
  }

  // an amount the balance covers and its fee does not: held at NOT ENOUGH, in the wallet's words, and the send says the same
  {
    const app = await phoneAt(coming);
    const W = app.ctx.W;
    app.acceptTarget('alice@addr.test');
    app.setState({ amount: '1995', unit: 'SATS' });
    app.next();
    up(W);
    ok(await until(() => app.state.quotedFee != null), 'an address for nearly all the balance is looked up and quoted as any other is');
    const spec = app.confirmSpec();
    const sentence = 'Your balance isn\'t enough to cover the payment and its fee: this needs 2005 sats and you hold 2000.';
    ok(spec.cta === 'NOT ENOUGH' && spec.ctaTone === 'warn' && spec.warn === sentence,
       'the button reads NOT ENOUGH, with the wallet\'s sentence under the rows', spec.cta + ' / ' + spec.warn);
    spec.go();
    ok(app.state.screen === 'sendConfirm' && JSON.stringify(app.state.stack) === '["home","amount"]' && !app.log.cards.length,
       'and does nothing when it is pressed', app.state.screen + ' ' + JSON.stringify(app.state.stack));
    // the screen is stale, or the reserve moved: the send is made all the same, and the wallet refuses in the same words
    app.ctx.window.console.error = () => {};
    app.startSend();
    ok(await until(() => app.log.cards.length === 1), 'a send that is made all the same is refused by the payment');
    const refused = app.log.cards[0] || {};
    ok(refused.kind === 'sendFail' && refused.reason === sentence && refused.retry === 'CHANGE AMOUNT',
       'in the same words, on a card with no TRY AGAIN', refused.kind + ' / ' + refused.reason + ' / ' + refused.retry);
    ok(app.state.screen === 'sendConfirm' && JSON.stringify(app.state.stack) === '["home","amount"]',
       'the confirmation under it, on the stack as it was before SEND', app.state.screen + ' ' + JSON.stringify(app.state.stack));
    refused.onClose();
    ok(app.state.screen === 'amount' && JSON.stringify(app.state.stack) === '["home"]',
       'closing it goes to the amount screen, not back to the confirmation, with no entry of the confirmation left behind', app.state.screen + ' ' + JSON.stringify(app.state.stack));
    ok((await W.balanceSats()) === 2000, 'and no sat moved', String(await W.balanceSats()));
  }

  /* A payment request for an amount the balance covers and the mint's fee for
   * making it does not, at a mint that charges for each piece it swaps.
   *
   * The wallet's sum (`sendShortfall`, which is `sendToken`'s own) holds the
   * offer's button at NOT ENOUGH with the wallet's sentence, at the figures it
   * will refuse on; the payment made all the same refuses in those words, and
   * before it asks the other phone anything; and a payer on the Bluetooth link
   * tells the receiver it cannot pay as the offer opens. A request that fits is
   * the button it was, and says nothing to anybody. */
  {
    const app = await phoneAt(coming, { sats: 3000, mint: { feePpk: 1000 } });
    const W = app.ctx.W;
    up(W);
    await W.primeLocks();
    const fee = W.sendShortfall(1, {}).fee;
    const want = 3000 - fee + 1;
    const sentence = 'Your balance isn\'t enough to cover the payment and its fee: this needs 3001 sats and you hold 3000.';
    const told = [];
    W.tapQuote = (t) => { told.push(JSON.parse(t)); return Promise.resolve('ok'); };
    let asked = 0;
    const askFirst = W.askFirst;
    W.askFirst = (...a) => { asked += 1; return askFirst.apply(W, a); };
    // a receiver that never answers is not waited on for six seconds
    W._askWaitMs = 30;
    const swaps = () => app.ctx.requests.filter((r) => /\/v1\/swap$/.test(r.url)).length;
    const swapped = swaps();
    const text = W.paymentRequest(want, { purpose: 'receive' });
    ok(fee > 0 && want < 3000, 'a mint that charges for what it swaps, and an amount under the balance', 'fee ' + fee + ', want ' + want);
    app.openRequest(text, { viaTap: true, theirRoute: true, asks: true });
    const spec = app.requestSpec();
    ok(app.state.screen === 'reqOffer' && spec.cta === 'NOT ENOUGH' && spec.ctaTone === 'warn' && spec.warn === sentence,
       'the offer holds its button at NOT ENOUGH, with the wallet\'s sentence at the figures it will refuse on', spec.cta + ' / ' + spec.warn);
    spec.go();
    ok(!app.log.made, 'and pressing it makes nothing');
    ok(told.length === 1 && told[0].gaveUp === 'The payer does not have enough to cover this payment.' && Object.keys(told[0]).join() === 'gaveUp',
       'a payer on the link has told the receiver it gave up as the offer opened, in a sentence with none of this phone\u2019s figures in it', JSON.stringify(told));
    app.openRequest(text, { viaTap: true, theirRoute: true, asks: true });
    ok(told.length === 1, 'once for the request, however often it is opened');
    let refused = '';
    try { await W.sendToken(want, { unit: 'sat' }); } catch (e) { refused = e.message; }
    ok(refused === sentence, 'the payment made all the same refuses in the same words', refused);
    const req = Object.assign(W.decodeRequest(text), { sats: want, unit: 'sat', viaTap: true, theirRoute: true, asks: true });
    let said = '';
    try { await W.payRequest(req, () => {}, {}); } catch (e) { said = e.message; }
    ok(said === sentence && asked === 0 && told.length === 1,
       'and over the link it refuses before the question asked first, so the receiver is never told it will be paid', said + ' | asked ' + asked + ' | told ' + told.length);
    ok(swaps() === swapped && (await W.balanceSats()) === 3000, 'nothing was swapped and no sat moved');

    // an amount that fits with room to spare: the button it always was, and nobody is told anything
    const fits = Object.assign({}, req, { sats: 500, id: 'fits-1' });
    told.length = 0;
    app.state.req = fits;
    const ok1 = app.requestSpec();
    ok(!/NOT ENOUGH|CLOSE/.test(ok1.cta) && !ok1.warn, 'a request that fits is not held', ok1.cta + ' / ' + ok1.warn);
    app.tellPayerShort(fits);
    ok(told.length === 0, 'and tells nobody anything');
    const paying = await W.payRequest(fits, () => {}, {}).then(() => 'paid', (e) => e.message);
    ok(asked === 1 && !/isn.t enough/.test(paying), 'the payment goes on to ask first, as it always did', asked + ' | ' + paying);

    // a request for another mint cannot be judged by this pile: it reads as it did
    app.state.req = Object.assign({}, req, { mints: ['https://other.example'], viaTap: false });
    const other = app.requestSpec();
    ok(other.cta === 'CLOSE' && /^More than your balance/.test(other.warn), 'a request for another mint is refused as it was, not held at NOT ENOUGH', other.cta + ' / ' + other.warn);
  }

  // an invoice that carries its amount: straight to the confirmation, held, and quoted when the route is up
  {
    const app = await phoneAt(coming);
    app.acceptTarget(PRICED);
    ok(app.state.screen === 'sendConfirm' && app.state.recipientKind === 'invoice' && !app.log.cards.length && !app.log.tokens.length,
       'an invoice with its amount, scanned while the connection is on its way, lands on the confirmation: no card', app.state.screen + ' / ' + app.log.cards.map((c) => c.kind));
    await wait(60);
    let spec = app.confirmSpec();
    ok(spec.cta === 'CHECKING…' && spec.ctaBusy && feeOf(spec) === 'CHECKING…', 'reading CHECKING, with the FEE row the same', spec.cta + ' / ' + feeOf(spec));
    ok(app.meltQuotes() === 0, 'and no quote has been asked of the mint');
    up(app.ctx.W);
    ok(await until(() => app.state.quotedFee != null), 'the route coming up asks the mint for the fee by itself');
    spec = app.confirmSpec();
    ok(/^SEND /.test(spec.cta) && !spec.ctaBusy && feeOf(spec) === 'UP TO ₿ 10', 'and then it reads SEND, with the fee', spec.cta + ' / ' + feeOf(spec));
    ok(app.meltQuotes() === 1, 'asked once', String(app.meltQuotes()));
  }
  {
    // the mint's own invoice needs no connection to be paid with a token, as it did not
    const app = await phoneAt(coming);
    app.ctx.W.invoiceFromThisMint = () => true;
    app.acceptTarget(PRICED);
    ok(app.log.tokens.length === 1 && app.state.screen === 'home', 'an invoice from the mint this phone is on is still paid with a token at once', JSON.stringify(app.log.tokens) + ' / ' + app.state.screen);
  }
  {
    // an invoice with no amount: the keypad, as ever; the confirmation is held for the route, and has no quote to wait for
    const app = await phoneAt(coming);
    app.acceptTarget(AMOUNTLESS);
    ok(app.state.screen === 'amount' && app.state.recipientKind === 'invoice' && !app.log.cards.length, 'an invoice with no amount goes to the keypad', app.state.screen);
    app.setState({ amount: '5', unit: 'SATS' });
    app.next();
    await wait(60);
    ok(app.confirmSpec().cta === 'CHECKING…', 'and its confirmation is held while the connection is on its way');
    up(app.ctx.W);
    ok(await until(() => /^SEND /.test(app.confirmSpec().cta)), 'and SEND once it is up', app.confirmSpec().cta);
    await wait(60);
    ok(feeOf(app.confirmSpec()) === 'UNKNOWN' && app.meltQuotes() === 0,
       'with the fee UNKNOWN: a mint cannot quote an invoice that names no amount, and is not asked to', feeOf(app.confirmSpec()) + ' / ' + app.meltQuotes() + ' quote(s)');
  }

  // a connection that does not come: told in the card there always was, the confirmation left under it
  {
    const app = await phoneAt(coming);
    app.acceptTarget(PRICED);
    await wait(60);
    ok(app.confirmSpec().cta === 'CHECKING…' && !app.log.cards.length, 'an invoice held for the connection');
    gaveUp(app.ctx.W);
    ok(await until(() => app.log.cards.length === 1), 'Tor giving up tells it in the card for no connection, then and there');
    const card = app.log.cards[0] || {};
    ok(card.kind === 'offlineInvoice' && card.title === 'YOU’RE OFFLINE' && /Lightning invoice can only be paid offline/.test(card.reason),
       'the very card an invoice gets scanned with no connection', card.kind + ' / ' + card.title);
    ok(app.state.screen === 'sendConfirm', 'with the confirmation under it, as after a send that is refused', app.state.screen);
    ok(JSON.stringify(app.state.stack) === '["home"]', 'on the stack as it was: the card pushed nothing, so there is nothing of it to drop', JSON.stringify(app.state.stack));
    const spec = app.confirmSpec();
    ok(/^SEND /.test(spec.cta) && !spec.ctaBusy && feeOf(spec) === 'UNKNOWN', 'its button no longer held: SEND, the fee UNKNOWN', spec.cta + ' / ' + feeOf(spec));
    gaveUp(app.ctx.W); app.ctx.W.setOffline(true); await wait(60);
    ok(app.log.cards.length === 1, 'and said once, not again with every word from Tor');
    ok(app.meltQuotes() === 0 && app.addressAsks() === 0, 'nothing was asked of anyone');
  }
  {
    const app = await phoneAt(coming);
    app.acceptTarget('alice@addr.test');
    app.setState({ amount: '10', unit: 'SATS' });
    app.next();
    await wait(60);
    dark(app.ctx.W);
    ok(await until(() => app.log.cards.length === 1), 'the network going while an address is held tells it too');
    const card = app.log.cards[0] || {};
    ok(card.kind === 'offlineAddress' && card.title === 'YOU’RE OFFLINE' && /Lightning address can only be paid with a connection/.test(card.reason),
       'in a card that fits it', card.kind + ' / ' + card.reason);
    ok(app.state.screen === 'sendConfirm' && /^SEND /.test(app.confirmSpec().cta), 'confirmation under it, its button SEND to be told the same by the payment', app.state.screen + ' / ' + app.confirmSpec().cta);
    ok(JSON.stringify(app.state.stack) === '["home","amount"]', 'on the stack as it was, so one press of the back arrow leaves it', JSON.stringify(app.state.stack));
  }

  // no connection at all: as it was
  {
    const app = await phoneAt(dark);
    ok(app.connecting() === false && app.offlineNow() === true, 'no network is not a connection on its way');
    app.acceptTarget(PRICED);
    ok(app.log.cards.length === 1 && app.log.cards[0].kind === 'offlineInvoice' && app.state.screen === 'home',
       'an invoice scanned with no network at all gets the card for no connection, and no confirmation', app.log.cards.map((c) => c.kind) + ' / ' + app.state.screen);
    app.acceptTarget('alice@addr.test');
    app.setState({ amount: '10', unit: 'SATS' });
    app.next();
    await wait(60);
    const spec = app.confirmSpec();
    ok(/^SEND /.test(spec.cta) && !spec.ctaBusy && feeOf(spec) === 'UNKNOWN', 'an address goes to a confirmation that is not held: nothing is coming to wait for', spec.cta + ' / ' + feeOf(spec));
    ok(app.ctx.requests.filter((r) => /addr\.test/.test(r.url)).length === 0 && app.log.cards.length === 1, 'nothing asked, and no card by itself');
    app.ctx.window.console.error = () => {};
    spec.go();
    ok(await until(() => app.log.cards.length === 2), 'SEND is refused by the payment, as it was');
    const refused = app.log.cards[1] || {};
    ok(refused.kind === 'netLost' && refused.retry === 'TRY AGAIN' && /working offline/.test(refused.reason), 'in the card it always was', refused.kind + ' / ' + refused.reason);
    ok(app.state.screen === 'sendConfirm' && JSON.stringify(app.state.stack) === '["home","amount"]',
       'with the confirmation back on the stack it had before SEND', app.state.screen + ' ' + JSON.stringify(app.state.stack));
  }
  {
    const app = await phoneAt(gaveUp);
    ok(app.connecting() === false, 'nor is Tor having given up');
    app.acceptTarget(PRICED);
    ok(app.log.cards.length === 1 && app.log.cards[0].kind === 'offlineInvoice', 'an invoice scanned then gets the card for no connection', app.log.cards.map((c) => c.kind));
  }

  // a payment request: held where a connection would change how it is paid
  {
    const NOSTR = { id: 'r1', sats: 21, unit: 'sat', mints: [MINT], transports: ['nostr'], delivery: { kind: 'nostr', target: 'npub1stub' }, lockTo: '', viaTap: false, usd: 0, theirRate: 0 };
    const app = await phoneAt(coming);
    app.ctx.W.decodeRequest = (t) => Object.assign({}, NOSTR, app.reqOverride || {});
    app.acceptTarget('creqA' + 'x'.repeat(30));
    ok(app.state.screen === 'reqOffer' && !app.log.cards.length, 'a payment request scanned while the connection is on its way opens its confirmation', app.state.screen);
    let spec = app.confirmSpec();
    ok(spec.cta === 'CHECKING…' && spec.ctaBusy && feeOf(spec) === 'CHECKING…', 'held at CHECKING, its FEE row the same', spec.cta + ' / ' + feeOf(spec));
    spec.go();
    ok(!app.log.made, 'and pressing it makes nothing');
    up(app.ctx.W);
    await wait(60);
    spec = app.confirmSpec();
    ok(/^PAY /.test(spec.cta) && !spec.ctaBusy, 'the route coming up turns it to what it reads, by itself', spec.cta);
    spec.go();
    ok(app.log.made === 1, 'and PAY pays');
    // the same request with the connection given up on: its button is what it is with none, and there is no card to tell
    const gone = await phoneAt(coming);
    gone.ctx.W.decodeRequest = () => NOSTR;
    gone.acceptTarget('creqA' + 'x'.repeat(30));
    gaveUp(gone.ctx.W);
    await wait(80);
    ok(/^PAY /.test(gone.confirmSpec().cta) && !gone.confirmSpec().ctaBusy && !gone.log.cards.length,
       'a request needs no card for a connection that does not come: its token to show is the way without one', gone.confirmSpec().cta + ' / ' + gone.log.cards.length);
    // one that names nothing the route is for is not waited on
    const plain = await phoneAt(coming);
    plain.ctx.W.decodeRequest = () => Object.assign({}, NOSTR, { transports: [], delivery: null });
    plain.acceptTarget('creqA' + 'x'.repeat(30));
    ok(plain.confirmSpec().cta === 'GENERATE ECASH TOKEN', 'a request for a token to show them is not held', plain.confirmSpec().cta);
  }

  // the signal is the banner's: the confirmation holds exactly when the banner says SECURING YOUR CONNECTION
  {
    const states = [
      ['connecting over wifi', { tor: 'connecting', network: 'wifi' }, true],
      ['stuck over wifi', { tor: 'stuck', network: 'wifi' }, true],
      ['connecting over cellular', { tor: 'connecting', network: 'cellular' }, true],
      ['failed over wifi', { tor: 'failed', network: 'wifi' }, false],
      ['stopped over wifi', { tor: 'stopped', network: 'wifi' }, false],
      ['connecting with no network', { tor: 'connecting', network: 'none' }, false],
      ['up with no network', { tor: 'up', network: 'none' }, false],
      ['up over wifi', { tor: 'up', network: 'wifi' }, false],
      ['continuing without Tor', { tor: 'connecting', network: 'wifi', unprotected: true }, false],
    ];
    const app = await phoneAt(up);
    const W = app.ctx.W;
    for (const [what, p, want] of states) {
      W._privacy(Object.assign({ progress: 10, everUp: true, unprotected: false, transport: 'direct' }, p));
      // working offline is where the gate puts the wallet whenever Tor is not up; going without Tor is the person's own answer to an iOS alert, and is not that
      if (!p.unprotected) W.setOffline(true);
      const text = app.torBannerVals().torBannerText;
      ok(app.connecting() === want && (text === 'SECURING YOUR CONNECTION') === want,
         'the confirmation and the banner agree on ' + what, 'connecting ' + app.connecting() + ', banner ' + text);
    }
  }

  /* ---- the same through the page: React, the template, componentDidUpdate ---------
   *
   * The scenarios above call the app's methods by hand, and a repaint is
   * stood in for by `syncSend`. What they cannot say is that the page does it:
   * that the route coming up is an update, that the update reaches the send
   * confirmation, and that what is read off the screen is what `confirmSpec`
   * said. So the real class is mounted (as tests/render-snapshots.js mounts it)
   * on a wallet whose route and answers this moves, and the confirmation's
   * button and FEE row are read from the DOM. */
  {
    const { JSDOM, VirtualConsole } = require('jsdom');
    const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
    const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
    const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
    const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
      const props = JSON.parse(v.replace(/&quot;/g, '"'));
      props.startStatic = { default: true };
      return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
    });
    const html = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8')
      .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
      .replace(shell.marker, () => open + appSrc + '</script>');
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(String(e && e.message).slice(0, 200)));
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
    const w = dom.window;
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
    w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.scrollTo = () => {};
    const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
    run(unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047'));
    run(unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690'));
    const dc = w.document.querySelector('script[type="text/x-dc"]');
    run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
      + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
    run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
      + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
    run(fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8'));
    await until(() => !!w.__logic, 8000);
    await wait(300);
    const logic = w.__logic;
    ok(!!logic, 'the page mounts');

    const route = { coming: true, offline: true };
    const asked = { lookup: 0, quote: 0 };
    let answerLookup = null, answerQuote = null;
    w.FoxyWallet = {
      connected: true, mintUrl: MINT, mintHost: () => 'm.test', mints: () => [MINT],
      classify: (t) => (/^lnbc/.test(t) ? 'invoice' : /@/.test(t) ? 'lnurl' : 'unknown'),
      amountOf: (inv) => (/^lnbc/.test(String(inv)) ? 2100 : null),
      privacy: () => ({ tor: route.coming ? 'connecting' : (route.gone ? 'failed' : 'up'), progress: 40, everUp: true, unprotected: false,
                        offline: route.offline, network: 'wifi', orbot: 'none', vpn: false, orbotKey: false }),
      routeComing: () => route.coming,
      lookupLnurl: (addr, sats) => { asked.lookup += 1; return new Promise((yes) => { answerLookup = () => yes({ pr: 'lnbc2100n1looked', addr, sats, at: Date.now() }); }); },
      quoteFee: (pr) => { asked.quote += 1; return new Promise((yes) => { answerQuote = () => yes({ amount: 2100, feeReserve: 12, quote: { q: 1 }, w: {}, bolt11: pr, at: Date.now() }); }); },
      payNeed: (sats, reserve) => ({ ok: true, need: sats + reserve, have: 250000, fee: reserve, why: '' }),
      reason: (e) => String((e && e.message) || e), heldSats: () => 0,
      balances: () => [], quarantinedSats: () => 0, quarantinedUnknown: () => 0, tokensNotClaimed: () => Promise.resolve([]),
      lastToken: () => ({ token: '', sats: 0, hash: '' }), clearLastToken() {}, tagsFor: () => ({}), tag() {}, backedUp: () => false,
      pinIsSet: () => false, pinClear() {}, auditTrail: () => [], qr: () => 'data:,', paymentRequest: () => 'creqAstub',
      unitName: (u) => String(u).toUpperCase(), formatAmount: (a, u) => a + ' ' + u, mintDown: () => null, share: () => true,
      clearHistory() {}, clearContacts() {}, splitClear() {}, showSeedNative: () => new Promise(() => {}), enterSeedNative: () => new Promise(() => {}),
      forgetSeedCandidate: () => Promise.resolve(true), agreedRate: () => new Promise(() => {}),
    };
    // a change of route is an update of the page, as 06-wallet-boot-and-restore.js makes it
    const moved = async () => { logic.setState({ routeAt: Date.now() }); await wait(250); };
    const onScreen = () => {
      const spans = Array.from(w.document.querySelectorAll('#dc-root .sc-interp')).map((e) => e.textContent);
      const at = spans.indexOf('FEE');
      return { cta: spans.filter((t) => /^(CHECKING…|SEND |NOT ENOUGH)/.test(t)).pop() || '', fee: at >= 0 ? spans[at + 1] : '' };
    };
    const cards = () => Array.from(w.document.body.children).filter((e) => e.localName === 'div' && e.id !== 'dc-root' && /YOU.RE OFFLINE/.test(e.textContent)).length;

    logic.setState({ screen: 'sendConfirm', stack: ['home', 'amount'], flow: 'send', amount: '2100', unit: 'SATS', recipient: 'alice@example.com',
      recipientKind: 'email', payFrom: 'BITCOIN', walletLive: true, balSats: 250000, livePrice: 64000 });
    await wait(300);
    let seen = onScreen();
    ok(seen.cta === 'CHECKING…' && seen.fee === 'CHECKING…' && asked.lookup === 0,
       'on the page: an address\'s confirmation reads CHECKING, its FEE row too, and nothing is asked while the connection is on its way', JSON.stringify(seen) + ' ' + asked.lookup);
    route.coming = false; route.offline = false;
    await moved();
    ok(asked.lookup === 1 && onScreen().cta === 'CHECKING…', 'the route coming up is an update of the page, and the address is looked up by itself', JSON.stringify(asked));
    answerLookup(); await wait(250);
    ok(asked.quote === 1 && onScreen().cta === 'CHECKING…', 'its invoice is quoted as soon as it is in, the button still held', JSON.stringify(asked));
    answerQuote(); await wait(250);
    seen = onScreen();
    ok(/^SEND /.test(seen.cta) && /^UP TO/.test(seen.fee), 'and the button turns to SEND, with the fee in the FEE row', JSON.stringify(seen));
    ok(!errors.length, 'with nothing thrown by the page', errors.join(' | '));

    // the connection going again with the quote in hand: held, and not asked for again when it returns
    route.coming = true; route.offline = true;
    await moved();
    seen = onScreen();
    ok(seen.cta === 'CHECKING…' && /^UP TO/.test(seen.fee), 'the connection going again holds the button, with the quote still in its row', JSON.stringify(seen));
    route.coming = false; route.offline = false;
    await moved();
    ok(/^SEND /.test(onScreen().cta) && asked.lookup === 1 && asked.quote === 1, 'and it is SEND when it returns, with nothing asked twice', JSON.stringify(asked));

    // an invoice, held, and Tor gives up
    asked.lookup = 0; asked.quote = 0;
    route.coming = true; route.offline = true;
    logic.setState({ screen: 'home', stack: [] });
    await wait(100);
    logic.setState({ screen: 'sendConfirm', stack: ['home'], recipient: 'lnbc2100n1stub', recipientKind: 'invoice',
      quotedFee: null, quotedAmt: null, quotingFee: false, amount: '2100' });
    await wait(300);
    ok(onScreen().cta === 'CHECKING…' && cards() === 0, 'an invoice is held at CHECKING too', JSON.stringify(onScreen()));
    route.coming = false; route.offline = true; route.gone = true;
    await moved();
    seen = onScreen();
    ok(cards() === 1 && /^SEND /.test(seen.cta) && seen.fee === 'UNKNOWN' && logic.state.screen === 'sendConfirm',
       'Tor giving up puts the card for no connection over it and lets the button go', JSON.stringify(seen) + ' cards ' + cards());
    ok(!errors.length, 'with nothing thrown by the page', errors.join(' | '));
  }

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall home-first checks pass');
  process.exit(failures ? 1 : 0);
})();
