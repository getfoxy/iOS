'use strict';
/* cards-logic.js — the app's cards: one at a time, and none lost.
 *
 *     node tests/cards-logic.js
 *
 * blockedCard from build/foxy-app.js, in jsdom. A card that arrives while
 * another is open waits and shows when that one closes; it used to replace it,
 * which hid "PAID, NOT COLLECTED YET" behind the test-mint card on a simulator
 * tour. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const dom = new JSDOM('<body></body>');
global.window = dom.window;
global.document = dom.window.document;
const methods = new Function('return {' + method('blockedCard(kind, over) {') + ',' +
  method('claimFailed(e, again) {') + ',' +
  method('offerQuarantine() {') + '}')();
const toasts = [];
const app = Object.assign({ state: {}, setState() {}, BLOCKED_INFO: () => null, group: n => String(n),
  toast: (m, bad) => toasts.push({ m, bad }), refreshBalance() {} }, methods);

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));
const titles = () => Array.from(document.body.children).map(el => {
  const t = Array.from(el.querySelectorAll('div')).find(d => d.childElementCount === 0 && /^[A-Z ,!']{6,}$/.test(d.textContent));
  return t ? t.textContent : '?';
});
const closeOpen = () => {
  // the button itself, not the stack around it that has the same text
  const btn = Array.from(document.querySelectorAll('div')).find(d => d.childElementCount === 0 && d.textContent === 'CLOSE');
  btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  app.blockedCard('stuckInvoice', { title: 'PAID, NOT COLLECTED YET', reason: 'r' });
  app.blockedCard('testmint', { title: 'THIS IS A TEST MINT', reason: 'r' });
  check('a second card does not replace the open one', JSON.stringify(titles()) === '["PAID, NOT COLLECTED YET"]', JSON.stringify(titles()));
  app.blockedCard('testmint', { title: 'THIS IS A TEST MINT', reason: 'again' });
  check('the same kind waiting twice is queued once', (app._cardQueue || []).length === 1, 'queue ' + (app._cardQueue || []).length);
  closeOpen();
  await wait(400);
  check('closing it shows the one that waited', JSON.stringify(titles()) === '["THIS IS A TEST MINT"]', JSON.stringify(titles()));
  app.blockedCard('testmint', { title: 'THIS IS A TEST MINT', reason: 'newer' });
  check('the same kind as the open card replaces it', document.body.children.length === 1 && document.body.textContent.includes('newer'), document.body.textContent.slice(0, 80));
  closeOpen();
  await wait(400);
  check('nothing left open or waiting', document.body.children.length === 0 && !(app._cardQueue || []).length, 'children ' + document.body.children.length);

  /* offerQuarantine: set-aside ecash with no record of its mint is said
   * plainly, with its amount, and nothing on the card deletes or guesses. It
   * was counted in the card's figure and PUT IT BACK left it where it was
   * without a word. */
  const calls = [];
  const fakeWallet = (sats, unknown, result) => ({
    quarantinedSats: () => sats,
    quarantinedUnknown: () => unknown,
    unquarantine: () => { calls.push('unquarantine'); return Promise.resolve(result); },
    clearQuarantine: () => { calls.push('clearQuarantine'); return true; },
    reason: e => String(e),
  });
  const buttons = () => Array.from(document.querySelectorAll('div')).filter(d => d.childElementCount === 0 && /^[A-Z ]{4,}$/.test(d.textContent)).map(d => d.textContent);
  const press = (label) => Array.from(document.querySelectorAll('div')).find(d => d.childElementCount === 0 && d.textContent === label)
    .dispatchEvent(new dom.window.Event('click', { bubbles: true }));

  dom.window.FoxyWallet = fakeWallet(21, 21, { back: 0, stillSpent: 0, elsewhere: 0, unknown: 21 });
  app.offerQuarantine();
  const allText = document.body.textContent;
  check('ecash with no record of its mint is said plainly, with its amount',
    /21 sats of set-aside ecash have no record of which mint issued them/.test(allText) && /rather than guess/.test(allText), allText.slice(0, 200));
  check('with only that set aside, the card offers nothing to press but CLOSE', JSON.stringify(buttons()) === '["ECASH SET ASIDE","CLOSE"]', JSON.stringify(buttons()));
  press('CLOSE');
  await wait(400);
  check('closing it touches nothing', !calls.length && document.body.children.length === 0, JSON.stringify(calls));
  app.offerQuarantine();
  check('the same set-aside ecash is not offered twice', document.body.children.length === 0, 'children ' + document.body.children.length);

  dom.window.FoxyWallet = fakeWallet(30, 21, { back: 0, stillSpent: 0, elsewhere: 0, unknown: 21 });
  app.offerQuarantine();
  const mixed = document.body.textContent;
  check('with other set-aside ecash, the card counts only what can go back and says the rest',
    /^ECASH SET ASIDE9 sats the mint called spent/.test(mixed.replace(/^[!×]/, '')) && /21 sats of set-aside ecash also have no record/.test(mixed), mixed.slice(0, 240));
  press('PUT IT BACK');
  await wait(50);
  check('putting it back asks the wallet, never clears, and says why the rest stays',
    JSON.stringify(calls) === '["unquarantine"]' && toasts.some(t => /21 sats have no record of their mint/.test(t.m)), JSON.stringify(calls) + ' ' + JSON.stringify(toasts));
  await wait(400);

  /* Text a mint chooses is text, never markup.
   *
   * A mint writes its own name and its errors, and the card draws both. Neither
   * is Foxy's, and the card puts every one of them on screen with textContent —
   * so a tag in a mint's name is shown as a tag, not parsed into one. Nothing
   * asserted that, which left it a property of how the card happens to be
   * written rather than a rule an edit has to keep. The page's policy would stop
   * an injected script running (script-src has no unsafe-inline and no eval), so
   * this is the layer in front of that, not the only one.
   *
   * Foxy drew a mint's NUT-06 message of the day on this card until
   * it was dropped — 400 characters, the longest mint-chosen text on any screen.
   * That card is gone and the field is no longer read, so a mint's name and its
   * errors are what is left. The rule is the same either way. */
  document.body.innerHTML = '';
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1<\/script>';
  app.blockedCard('mintText', {
    tone: 'warn',
    title: 'MINT ' + evil,
    reason: 'Your wallet needs re-verification. ' + evil,
    chip: evil,
    retry: evil,
    also: { label: evil, tap() {} },
  });
  const planted = document.body.querySelectorAll('img, script, iframe, object, embed, svg script');
  check('a mint\'s text makes no element, however it is written',
    planted.length === 0 && !dom.window.__xss, planted.length + ' element(s) from the mint\'s text');
  check('it is shown as the text it is',
    document.body.textContent.includes('<img src=x onerror='), document.body.textContent.slice(0, 160));
  press('CLOSE');
  await wait(400);

  /* NO BITCOIN PRICE: not for one failed refresh while a price from the last
   * three minutes stands, and not for the first failure at launch until a
   * retry has failed too (it showed for a second or two). */
  {
    const prices = new Function('const PRICE_STANDS_MS = 180000, PRICE_GRACE_MS = 30;\nreturn {'
      + method('refreshBalance() {') + '}')();
    const W = { connected: true, _rate: 60000, _rateAt: Date.now() - 60000, answer: null,
      balanceSats: () => Promise.resolve(1000), rate: () => Promise.reject(new Error('down')) };
    window.FoxyWallet = W;
    let shown = 0, st = {};
    // refreshBalance asks it: offline, the last price stands however old it is
    const px = Object.assign({ setState(s) { Object.assign(st, s); }, showPriceError() { shown++; },
      hidePriceError() {}, spreadNudge() {}, offlineNow: () => false }, prices);
    /* refreshBalance answers as soon as the sats are known — the launch is
     * never held for a price — so a check about the price waits
     * for the half that fetches it. */
    await px.refreshBalance(); await px._priced;
    check('a failed refresh keeps a price from a minute ago', shown === 0 && st.priceErr === false && Math.abs(st.balUsd - 0.6) < 1e-9,
      'shown ' + shown + ', ' + JSON.stringify(st));
    W._rateAt = Date.now() - 4 * 60 * 1000;
    await px.refreshBalance(); await px._priced;
    check('with no recent price, the first failure waits for a retry', shown === 0 && st.priceErr === true, 'shown ' + shown);
    await wait(80);
    check('the retry failing too shows the card', shown === 1, 'shown ' + shown);

    /* Offline there is no next fetch, so the three-minute window is the wrong
     * rule: it put NO BITCOIN PRICE on an offline phone for the rest of the
     * session, where a figure labelled with its age says more than a blank. Any age stands, and nothing converts a send at it. */
    {
      let offShown = 0; const offSt = {};
      const offPx = Object.assign({ setState(s2) { Object.assign(offSt, s2); },
        showPriceError() { offShown++; }, hidePriceError() {}, spreadNudge() {},
        offlineNow: () => true }, prices);
      window.FoxyWallet = { connected: true, _rate: 84746, _rateAt: Date.now() - 2 * 3600 * 1000,
        balanceSats: () => Promise.resolve(1000), rate: () => Promise.reject(new Error('offline')) };
      await offPx.refreshBalance(); await offPx._priced;
      check('offline, a price from hours ago still stands',
        offShown === 0 && offSt.priceErr === false && offSt.livePrice === 84746,
        'shown ' + offShown + ', ' + JSON.stringify(offSt));
      window.FoxyWallet = W;
    }
    W.rate = () => Promise.resolve(61000);
    px._priceMissAt = Date.now();
    await px.refreshBalance(); await px._priced;
    check('a price loading clears the wait', px._priceMissAt === 0 && st.priceErr === false, JSON.stringify(st));
    delete window.FoxyWallet;
  }

  /* A claim can fail three ways, and each is its own kind.
   *
   * The queue above deduplicates by kind: a card waiting behind another is
   * dropped when a new card of the same kind arrives. All three claim failures
   * were raised as `netLost`, so they counted as repeats of each other and the
   * person saw whichever happened to be last — and the diary said netLost for
   * a lock that has nothing to do with the network. */
  {
    document.body.innerHTML = '';
    app._blockedEl = null; app._blockedKind = null; app._cardQueue = [];
    const seen = [];
    const spy = Object.assign({}, app, {
      isBadSignatures: () => false,
      blockedCard(kind, over) { seen.push({ kind: kind, title: over && over.title }); },
    });
    window.FoxyWallet = { reason: e => String((e && e.message) || e) };
    spy.claimFailed(new Error('Token already spent'));
    spy.claimFailed(new Error('secret is a P2PK spend condition'));
    spy.claimFailed(new Error('The request timed out.'));
    const kinds = seen.map(s => s.kind);
    check('each way a claim fails is its own card kind',
      new Set(kinds).size === 3, JSON.stringify(seen));
    check('none of them is filed as a lost connection',
      !kinds.includes('netLost'), JSON.stringify(kinds));
    delete window.FoxyWallet;
  }

  /* Ecash this phone already took, offered to it again.
   *
   * A payment landed and its "paid" did not reach the payer, who showed the
   * same payment as a code. Scanned on the phone that had the money, the card
   * said the token was claimed "by someone else, or by this wallet". The
   * wallet marks the refusal when the ecash is its own (`mineIfTaken`), and
   * the card says so. */
  {
    document.body.innerHTML = '';
    app._blockedEl = null; app._blockedKind = null; app._cardQueue = [];
    const seen = [];
    const spy = Object.assign({}, app, {
      isBadSignatures: () => false,
      group: n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
      tapAgoWords: () => '20 seconds ago',
      blockedCard(kind, over) { seen.push(Object.assign({ kind: kind }, over)); },
    });
    window.FoxyWallet = { reason: e => String((e && e.message) || e) };
    const mine = Object.assign(new Error('That token is already spent, so there was nothing to take. Nothing was taken from you.'),
      { foxyMine: true, foxyTakenAt: Date.now() - 20000, foxyTakenSats: 1156 });
    spy.claimFailed(mine);
    const c = seen[0] || {};
    check('ecash this phone took, scanned again: YOU ALREADY HAVE THIS PAYMENT',
      c.kind === 'tokenMine' && c.title === 'YOU ALREADY HAVE THIS PAYMENT', JSON.stringify([c.kind, c.title]));
    check('it says when, how much, and that it is in the balance',
      c.reason === 'This phone took this ecash 20 seconds ago. 1,156 sats, in your balance.', String(c.reason));
    check('and that nothing was taken twice, as a calm card with nothing to retry',
      /not taken twice/.test(c.chip || '') && c.tone === 'ask' && !c.retry, JSON.stringify([c.chip, c.tone, c.retry]));
    spy.claimFailed(new Error('That token is already spent, so there was nothing to take. Nothing was taken from you.'));
    check('a token somebody else took is still TOKEN ALREADY REDEEMED',
      (seen[1] || {}).kind === 'tokenSpent' && (seen[1] || {}).title === 'TOKEN ALREADY REDEEMED', JSON.stringify(seen[1] || {}));
    spy.claimFailed(new Error('This phone already has that ecash.'));
    spy.claimFailed(new Error('You have already been paid this ecash.'));
    check('the two offline refusals of ecash already here say the same thing',
      (seen[2] || {}).kind === 'tokenMine' && (seen[3] || {}).kind === 'tokenMine'
        && (seen[2] || {}).reason === 'This phone took this ecash. It is in your balance.', JSON.stringify([seen[2], seen[3]].map(x => x && x.reason)));
    delete window.FoxyWallet;
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? failed + ' card check(s) failed' : 'all card checks pass');
  process.exit(failed ? 1 : 0);
})();
