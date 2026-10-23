'use strict';
/* home-shield.js — the shield on the money card, the one card for every mint, and the card's own screen.
 *
 *     node tests/home-shield.js
 *
 * The Tor banner left the bottom of the home screen and became a round shield in the money card's top right
 * corner (23-render-home-and-amount.js, `shieldVals`). The shield draws the banner's states and decides none of
 * its own: each is `torBannerVals`' state by name, and its tap is the banner's tap. These check that each state
 * is drawn with its colour, its mark and its words; that the tap is the banner's; that a turn to IP EXPOSED says
 * so once and pulses for a few seconds and no longer; that a mint with one balance has the same card as a mint
 * with two, with the bitcoin pill and the backup's ! on it; and that the card's own screen is headed by the
 * card's mint, with SWAP only for a card that holds two balances, which no card does yet. And that the pill and
 * the shield the card's screen copies are home's, letter for letter, and that a long mint name stops short of the
 * shield.
 *
 * The real page, rendered in jsdom by build/foxy-render.js as tests/render-snapshots.js renders it, against a
 * stand-in wallet whose route each check sets. tests/tor-banner.js pins the states themselves. */
process.env.TZ = 'UTC';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failed = 0;
let passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || !detail ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name,
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

// ---- the page, as render-snapshots.js builds it -------------------------------------------------
const shell = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'page.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'shell', 'manifest.json'), 'utf8'));
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'build', 'foxy-render.js'), 'utf8');
const unpack = (uuid) => fs.readFileSync(path.join(ROOT, assets.find((a) => a.uuid === uuid).file), 'utf8');
const REACT = unpack('8d4aa6b2-16cb-4c42-a6f2-d85feb8c0047');
const REACT_DOM = unpack('93c76fbd-259d-463c-a60d-5ed97ad7e690');
const open = shell.open.replace(/data-props="([^"]*)"/, (m, v) => {
  const props = JSON.parse(v.replace(/&quot;/g, '"'));
  props.startStatic = { default: true };
  return 'data-props="' + JSON.stringify(props).replace(/"/g, '&quot;') + '"';
});
const page = markup
  .replace(/<script src="64b433ba-[^"]*"><\/script>/, '')
  .replace(shell.marker, () => open + app + '</script>');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mount() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => errors.push(a.map(String).join(' ').slice(0, 300)));
  vc.on('jsdomError', (e) => errors.push('jsdom: ' + String(e && e.message).slice(0, 300)));
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://foxy.test/index.html', virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.scrollTo = () => {};
  const run = (text) => { const s = w.document.createElement('script'); s.textContent = text; w.document.head.appendChild(s); };
  run('(function(){var n=Number.prototype.toLocaleString;Number.prototype.toLocaleString=function(l,o){return n.call(this,l===undefined?"en-US":l,o);};})();');
  run(REACT);
  run(REACT_DOM);
  const dc = w.document.querySelector('script[type="text/x-dc"]');
  run('window.__foxyComponentFactory = function (DCLogic, StreamableLogic, React) {\n' + dc.textContent
    + '\n;return (typeof Component!=="undefined"&&Component)||undefined;\n};');
  run('(function(){var f=window.__foxyComponentFactory;window.__foxyComponentFactory=function(a,b,R){'
    + 'var C=f(a,b,R);return class extends C{constructor(p){super(p);window.__logic=this;}};};})();');
  run(RENDERER);
  return { dom, w, errors };
}

// ---- the stand-in wallet: a route each check sets, and one balance or two -------------------------
const MINT = 'https://mint.minibits.cash/Bitcoin';
let route = {};
const ROUTE = (over) => Object.assign({ tor: 'up', progress: 100, everUp: true, unprotected: false, offline: false,
  network: 'wifi', orbot: 'none', vpn: false, orbotKey: false }, over || {});
function wallet(two) {
  return {
    connected: true,
    mintUrl: MINT,
    mintHost: () => 'mint.minibits.cash/Bitcoin',
    mints: () => [MINT],
    qr: (t) => 'data:image/svg+xml;stub,' + encodeURIComponent(String(t).slice(0, 24)),
    backedUp: () => true,
    pinIsSet: () => false,
    reason: (e) => String((e && e.message) || e),
    formatAmount: (a, u) => (u === 'usd' ? '$' + (a / 100).toFixed(2) : a + ' ' + u),
    unitName: (u) => String(u).toUpperCase(),
    balances: () => [{ unit: 'sat', amount: 250000, mint: MINT }],
    privacy: () => route,
    lastToken: () => null, clearLastToken() {}, tagsFor: () => ({}), tag() {},
    mintDown: () => null, quarantinedSats: () => 0, quarantinedUnknown: () => 0,
    tokensNotClaimed: () => Promise.resolve([]), amountOf: () => null, classify: () => 'unknown',
    cardSession: () => Promise.resolve(), cardOwed: () => [], cardsList: () => [],
    ...(two ? {
      mintUnits: () => ['sat', 'usd'], twoUnits: () => true,
      walletChoice: () => ({ hold: 'both', recv: '', send: '' }), setWalletChoice() {},
      balanceOf: (u) => (u === 'usd' ? 4205 : 250000), heldIn: () => 0, recoveringIn: () => 0,
    } : {}),
  };
}

// each state as the route makes it, and what the shield draws for it
const STATES = [
  { name: 'TOR', route: ROUTE(), state: 'secure', bg: '#BFE3EC', ink: '#123642', mark: 'M8.6 12.3l2.3 2.3 4.5-4.9', label: 'Connected Over Tor' },
  { name: 'SECURING, Tor connecting at launch', route: ROUTE({ tor: 'connecting', progress: 40, everUp: false }), state: 'securing',
    bg: 'var(--frost-chip)', ink: '#BFE3EC', mark: '', label: 'SECURING YOUR CONNECTION' },
  { name: 'SECURING, working offline while Tor is at it', route: ROUTE({ tor: 'connecting', progress: 0, offline: true }), state: 'securing',
    bg: 'var(--frost-chip)', ink: '#BFE3EC', mark: '', label: 'SECURING YOUR CONNECTION' },
  { name: 'OFFLINE, no network', route: ROUTE({ tor: 'connecting', progress: 0, offline: true, network: 'none' }), state: 'offline',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: 'M6 18.5 18 5.5', label: 'OFFLINE - NO CONNECTION' },
  { name: 'CANNOT CONNECT', route: ROUTE({ tor: 'failed', progress: 0, offline: true }), state: 'cannot',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: 'M12 8v4.6M12 15.8h.01', label: 'CANNOT CONNECT — TAP TO RETRY' },
  // the banner was blank in these and said nothing; the shield does not turn its ring where nothing is under way
  { name: 'OFFLINE, Tor up over no network, not chosen', route: ROUTE({ network: 'none' }), state: 'offline',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: 'M6 18.5 18 5.5', label: 'OFFLINE - NO CONNECTION' },
  { name: 'CANNOT CONNECT, Tor failed, not chosen', route: ROUTE({ tor: 'failed', progress: 0, everUp: false }), state: 'cannot',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: 'M12 8v4.6M12 15.8h.01', label: 'CANNOT CONNECT' },
  { name: 'CANNOT CONNECT, Tor stopped, not chosen', route: ROUTE({ tor: 'stopped', progress: 0 }), state: 'cannot',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: 'M12 8v4.6M12 15.8h.01', label: 'CANNOT CONNECT' },
  { name: 'VIA VPN', route: ROUTE({ tor: 'connecting', progress: 0, unprotected: true, vpn: true }), state: 'tunnel',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: /^M10\.2 11\.2h3\.6/, label: 'Connected To Your VPN' },
  { name: 'VIA ORBOT', route: ROUTE({ tor: 'connecting', progress: 0, unprotected: true, orbot: 'running' }), state: 'tunnel',
    bg: '#E6D8A8', ink: '#3A2F0B', mark: /^M10\.2 11\.2h3\.6/, label: 'Connected Via Orbot' },
  { name: 'IP EXPOSED', route: ROUTE({ tor: 'connecting', progress: 0, unprotected: true }), state: 'exposed',
    bg: '#FF5C5C', ink: '#3A0B0B', mark: 'M12 8v4.6M12 15.8h.01', label: 'IP Address Exposed' },
];

(async () => {
  const { w, errors } = mount();
  for (let t = 0; t < 100 && !w.__logic; t++) await wait(100);
  await wait(400);
  const A = w.__logic;
  if (!A) { console.log('FAIL  the app did not mount\n      ' + errors.join(' | ')); process.exit(1); }
  const settle = () => wait(60);
  const V = () => A.renderVals();
  const shieldEl = () => w.document.querySelector('[data-shield]');
  const text = () => (w.document.getElementById('dc-root') || w.document.body).textContent;
  const toasts = [];
  const toast = A.toast.bind(A);
  A.toast = (m, amber) => { toasts.push(m); return toast(m, amber); };
  const home = async (two, state) => {
    w.FoxyWallet = wallet(two);
    A.setState(Object.assign({ screen: 'home', stack: [], walletLive: true, balSats: 250000, balUsd: 0, livePrice: 64000,
      balUsdCents: two ? 4205 : null, shieldPulse: false }, state || {}));
    await settle();
  };

  // ---- 1. each state: its class, its mark, its words, on home at one balance and two ----------------
  for (const two of [false, true]) {
    for (const s of STATES) {
      route = s.route;
      await home(two);
      const v = V();
      const at = s.name + (two ? ', two balances' : ', one balance');
      const markOk = s.mark instanceof RegExp ? s.mark.test(v.shieldMark) : v.shieldMark === s.mark;
      ok(v.shieldState === s.state && v.shieldBg === s.bg && v.shieldInk === s.ink && markOk,
        at + ': drawn as ' + s.state, JSON.stringify([v.shieldState, v.shieldBg, v.shieldInk, v.shieldMark]));
      const el = shieldEl();
      ok(!!el && el.getAttribute('data-shield') === s.state && el.getAttribute('aria-label') === s.label,
        at + ': the shield is on the card, labelled "' + s.label + '"', el ? el.getAttribute('aria-label') : 'no shield');
      const ring = el && el.firstElementChild && el.firstElementChild.firstElementChild;
      const turning = !!ring && /foxyRing/.test(ring.style.animation);
      ok(turning === (s.state === 'securing'), at + ': the ring turns only while securing', ring ? ring.style.animation : 'no ring');
      ok(!/SECURING YOUR CONNECTION|OFFLINE - NO CONNECTION|IP Address Exposed|Connected To Your VPN|Connected Via Orbot/.test(text()),
        at + ': no banner at the bottom of the screen saying it in words');
    }
  }
  // the banner made no claim while Tor connected; the shield is there all the same, so the corner never jumps
  route = ROUTE({ tor: 'connecting', progress: 40, everUp: false });
  await home(false);
  ok(V().torBannerShown === false && !!shieldEl(), 'Tor connecting: the banner would have been absent, and the shield is drawn');
  delete w.FoxyWallet;
  A.setState({ routeAt: Date.now() });
  await settle();
  ok(V().shieldState === 'securing', 'before the wallet is up: SECURING, never a claim', V().shieldState);

  // ---- 2. the tap is the banner's ----------------------------------------------------------------
  ok(/sc-camel-on-click="\{\{ torBanner \}\}" role="button" aria-label="\{\{ shieldLabel \}\}" data-shield=/.test(markup),
    'the shield’s tap is bound to the banner’s own handler, `torBanner`');
  ok(markup.indexOf('{{ torBannerText }}') < 0 && markup.indexOf('{{ torBannerShown }}') < 0,
    'and the banner itself is gone from the markup, from home and from the card’s screen');
  {
    route = ROUTE({ tor: 'connecting', progress: 0, unprotected: true });
    await home(false);
    shieldEl().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    const t = w.document.body.textContent;
    ok(A._blockedKind === 'torConnection' && /TOR CONNECTION/.test(t) && /IP Address Exposed/.test(t),
      'a tap opens the connection card, and the card says the state in words', A._blockedKind);
    if (A._blockedEl) { A._blockedEl.remove(); A._blockedEl = null; A._blockedKind = null; }
  }
  {
    let left = 0;
    w.FoxyGate = { leaveOffline: () => { left += 1; } };
    route = ROUTE({ tor: 'failed', progress: 0, offline: true });
    await home(false);
    const before = toasts.length;
    shieldEl().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    ok(left === 1 && toasts.slice(before).indexOf('Looking for Tor again…') >= 0 && !A._blockedEl,
      'CANNOT CONNECT: the tap is the way back, as the banner’s was: it asks for Tor again and says so', left + ' / ' + toasts.slice(before));
    delete w.FoxyGate;
  }
  {
    // Tor given up, but not by a choice to work offline: there is no way back to offer, so the tap explains
    let left = 0;
    w.FoxyGate = { leaveOffline: () => { left += 1; } };
    route = ROUTE({ tor: 'failed', progress: 0, everUp: false });
    await home(false);
    ok(V().torBannerShown === false && V().shieldState === 'cannot', 'Tor failed, not chosen offline: the banner was blank, the shield says CANNOT CONNECT');
    shieldEl().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    const t = A._blockedEl ? A._blockedEl.textContent : '';
    ok(left === 0 && A._blockedKind === 'torConnection' && /CANNOT CONNECT/.test(t) && !/TAP TO RETRY/.test(t),
      'and its tap opens the connection card, which says CANNOT CONNECT and promises no retry', left + ' / ' + A._blockedKind + ' / ' + t);
    if (A._blockedEl) { A._blockedEl.remove(); A._blockedEl = null; A._blockedKind = null; }
    delete w.FoxyGate;
  }

  // ---- 3. IP EXPOSED: said once per change, and the pulse stops by itself ----------------------------
  {
    ok(/onPrivacy\(\(\) => \{[\s\S]{0,200}?this\.shieldWatch\(\)/.test(app), 'every push of the route goes past the shield’s watch');
    ok(/\['_toastT',[^\]]*'_shieldT'[^\]]*\]\.forEach\(k => \{ clearTimeout/.test(app.slice(app.indexOf('componentWillUnmount() {'))), 'and the pulse’s timer is cleared with the app’s others when it goes away');
    A.SHIELD_PULSE_MS = 120;
    route = ROUTE();
    await home(false);
    A.shieldWatch();
    const said = () => toasts.filter((m) => m === 'IP address exposed').length;
    const was = said();
    route = ROUTE({ tor: 'connecting', progress: 0, unprotected: true });
    A.shieldWatch();
    A.shieldWatch();
    A.setState({ routeAt: Date.now() });
    A.shieldWatch();
    await settle();
    eq(said() - was, 1, 'the turn to exposed is said once, however many times the route is pushed while it stays exposed');
    const box = shieldEl().firstElementChild;
    ok(A.state.shieldPulse === true && /shieldPulse 1s ease-out 3/.test(box.style.animation),
      'and the circle pulses, in an animation of three beats that ends by itself', box.style.animation);
    ok(!!A._shieldT, 'with one timer to end the pulse');
    await wait(260);
    ok(A.state.shieldPulse === false && A._shieldT === null && /none/.test(shieldEl().firstElementChild.style.animation),
      'the timer ran once and stopped: no pulse, and no timer left', String(A.state.shieldPulse) + ' / ' + A._shieldT);
    route = ROUTE();
    A.shieldWatch();
    route = ROUTE({ tor: 'connecting', progress: 0, unprotected: true });
    A.shieldWatch();
    eq(said() - was, 2, 'a second turn to exposed, after the route was secure again, is said again');
    // a third turn inside the pulse replaces its timer rather than starting a second beside it
    const first = A._shieldT;
    route = ROUTE();
    A.shieldWatch();
    route = ROUTE({ tor: 'connecting', progress: 0, unprotected: true });
    A.shieldWatch();
    ok(A._shieldT && A._shieldT !== first, 'a turn inside the pulse starts the pulse again with one timer, not two');
    let ends = 0;
    const set = A.setState.bind(A);
    A.setState = (p, cb) => { if (p && p.shieldPulse === false) ends += 1; return set(p, cb); };
    await wait(300);
    A.setState = set;
    ok(ends === 1 && A._shieldT === null, 'and the pulse is ended once, by the one timer', String(ends));
    // the amber states are not loud
    const before = said();
    for (const r of [ROUTE({ tor: 'connecting', progress: 0, offline: true, network: 'none' }), ROUTE({ tor: 'failed', progress: 0, offline: true }),
      ROUTE({ tor: 'connecting', progress: 0, unprotected: true, vpn: true })]) { route = r; A.shieldWatch(); }
    ok(said() === before && A._shieldT === null && A.state.shieldPulse === false, 'offline, cannot connect and a VPN neither pulse nor say anything');
    route = ROUTE({ tor: 'connecting', progress: 0, unprotected: true });
    await home(false, { shieldPulse: true });
    route = ROUTE();
    A.setState({ routeAt: Date.now() });
    await settle();
    ok(/none/.test(shieldEl().firstElementChild.style.animation), 'a pulse still running when the route turns secure stops showing at once');
    A.SHIELD_PULSE_MS = 3000;
  }

  // ---- 4. one balance: the two-balance card, with one bitcoin pill -----------------------------------
  {
    route = ROUTE();
    await home(false);
    const v = V();
    eq(v.homePillRows.length, 1, 'one balance: one pill');
    const p = v.homePillRows[0];
    ok(p.sym === '₿' && p.big === '250,000' && p.small === '$160.00 USD',
      'it is the bitcoin pill: the sats big, their worth in dollars small under them', JSON.stringify([p.sym, p.big, p.small]));
    ok(/foxy-fur\.webp/.test(p.bg) && p.ink === '#FFFFFF', 'in the fox fur, with white ink, exactly as at a mint with two');
    const t = text();
    const head = w.document.querySelector('[aria-label="Switch mint"]');
    ok(!/YOUR MONEY/.test(t) && !!head && head.children.length === 1 && head.textContent === 'MINIBITS',
      'YOUR MONEY is gone: the card is headed MINIBITS, the name alone', head ? head.textContent : 'no heading');
    ok(!!head && !/\bMINT\b/.test(head.textContent) && !head.querySelector('svg') && !/M3 3l8 8-8 8/.test(markup),
      'with no MINT under the name and no chevron after it', head ? head.innerHTML : 'no heading');
    ok(!!head && head.getAttribute('role') === 'button' && head.getAttribute('aria-label') === 'Switch mint'
      && /goSwitchMint/.test(String(V().goMintHeading)),
      'the name is still a labeled button that switches mints');
    {
      /* jsdom lays nothing out, so the height is read from the styles: the heading is one 26px line (it was that
       * line, 5px, and a 13px MINT line under it), and with the price line open the money card is as tall as
       * what it holds while the price line, its sibling in the same column, takes the rest, so every pixel the
       * heading gave up goes to the price line and nothing under the card moves. */
      const line = head.firstElementChild;
      const card = [...w.document.querySelectorAll('div')].find((d) => d.contains(head) && /^34px 34px 0/.test(d.style.borderRadius));
      const price = card && [...card.parentElement.children].find((d) => d !== card && d.style.flex === V().priceFlex && /isolation/.test(d.getAttribute('style')));
      ok(!!line && line.style.fontSize === '26px' && line.style.lineHeight === '1' && line.children.length === 1
        && !head.querySelector('[style*="margin-top"]') && head.style.marginBottom === '4px',
        'the heading is one 26px line, 4px above the rule: 26px tall where it was 26 + 5 + a MINT line', head.innerHTML);
      ok(!!card && !!price && V().moneyFlex === '0 0 auto' && card.style.flex === '0 0 auto' && price.style.flex === '1 1 0%'
        && card.parentElement === price.parentElement,
        'and with the price line open the card takes only its height, so the price line gets what the heading gave up',
        card ? card.style.flex + ' / ' + (price ? price.style.flex : 'no price line') : 'no card');
    }
    ok(v.homeMintName === String(A.mintName()).toUpperCase(), 'by the mint’s short name', v.homeMintName);
    ok(markup.indexOf('{{ pillLetter }}') < 0 && markup.indexOf('YOUR MONEY') < 0, 'and the mint-letter pill is no longer in the markup');
    eq(v.homeButtonsTwo, [], 'the row under it is still the one-balance row: no SWAP');
    ok(p.badge === false && !w.document.querySelector('[data-shield] ~ * [aria-label="Bitcoin"] div[style*="rgba(11, 11, 11"]'),
      'with no backup to ask about, no ! on the pill');
    A.BK_BADGE = true;
    A.setState({ routeAt: Date.now() });
    await settle();
    const pillEl = w.document.querySelector('[aria-label="Bitcoin"]');
    const bang = pillEl && [...pillEl.querySelectorAll('div')].find((d) => d.textContent === '!');
    ok(V().homePillRows[0].badge === true && !!bang && bang.style.right === '22px' && bang.style.top === '50%',
      'the backup’s ! is drawn on the bitcoin pill, where it sat on the old one', bang ? bang.getAttribute('style') : 'no !');
    A.BK_BADGE = false;
    await home(true);
    ok(V().homePillRows.every((r) => r.badge === false), 'and at a mint with two balances it is not drawn, as before');
    await home(false);
    w.document.querySelector('[aria-label="Switch mint"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    eq(A.state.screen, 'switchMint', 'a tap on the mint’s name switches mints, as at a mint with two');
    await home(false);
    w.document.querySelector('[aria-label="Bitcoin"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle();
    eq(A.state.screen, 'history', 'and a tap on the pill opens history, as the right half of the old pill did');
  }

  // ---- 5. the card's screen: the card's mint, the bitcoin pill, the shield, SWAP only for two balances ----
  {
    const FC = (over) => Object.assign({ key: '02' + 'a1'.repeat(32), balance: 2048, count: 12, room: 52, pin: 'set', locked: false,
      hasRecord: true, setUp: true, pinSet: true, limit: 0, day: null, owner: true, ownedHere: true, resetKnown: true,
      mint: 'https://forge.example/Bitcoin', recoverable: true, mine: true, first: 4102444800, last: 4102444800, check: 'ok',
      checkedAt: 4102358400000 }, over || {});
    route = ROUTE();
    w.FoxyWallet = wallet(false);
    A.setState({ screen: 'flashcard', stack: ['home'], fc: FC(), livePrice: 64000 });
    await settle();
    let v = V();
    ok(v.fcMintShown && v.fcMintName === 'FORGE' && /FORGE/.test(text()) && !/CARD BALANCE/.test(text()),
      'the card’s screen is headed by the card’s own mint, FORGE, not the phone’s MINIBITS', v.fcMintName);
    const q = v.fcPillRows[0];
    ok(v.fcPillRows.length === 1 && q.sym === '₿' && q.big === '2,048' && /^\$\d+\.\d\d USD$/.test(q.small),
      'its pill is home’s bitcoin pill, the card’s sats big and their dollar worth under', JSON.stringify([q.big, q.small]));
    ok(!!shieldEl() && shieldEl().getAttribute('data-shield') === 'secure', 'the shield sits on the card’s money card too');
    eq(v.fcMenuItems.map((b) => b.label), ['HISTORY', 'LIMITS', 'CHANGE PIN', 'RESET'], 'a card of today: HISTORY, LIMITS, CHANGE PIN, RESET in its menu');
    eq(v.fcButtons.map((b) => b.label + ' ' + b.dim), ['SCAN 1', 'PASTE 1', 'SWAP 0.38'], 'and SWAP greyed in its bottom row');
    ok([undefined, null, [], ['sat']].every((u) => A.fcTwoUnits({ units: u }) === false) && A.fcTwoUnits(null) === false,
      'no card that reports one unit, or none, holds two balances');
    ok(A.fcTwoUnits({ units: ['sat', 'usd'] }) === true, 'one that reports two does');
    A.setState({ fc: FC({ units: ['sat', 'usd'] }) });
    await settle();
    v = V();
    eq(v.fcButtons.map((b) => b.label), ['SCAN', 'PASTE', 'SWAP'], 'a (pretend) card reporting two units: SWAP in the bottom row');
    ok(v.fcButtons[2].dim === (A.offlineNow() ? '0.38' : '1'), 'and not greyed for its currency', v.fcButtons[2].dim);
    const swapEl = w.document.querySelector('[aria-label="SWAP"]');
    ok(!!swapEl, 'and it is drawn');
    A.setState({ fc: FC({ hasRecord: false, mint: '' }) });
    await settle();
    ok(/CARD BALANCE/.test(text()) && !V().fcMintShown, 'a card with no mint yet keeps CARD BALANCE');
    A.setState({ fc: null });
    await settle();
    ok(/CARD BALANCE/.test(text()), 'and so does the screen before a card is tapped');
    // a card before software 1.23 reports no units, and fcShow keeps none; one of 1.23 the units the wallet sorted its pieces into (`cardUnits`)
    const src = app.slice(app.indexOf('  fcShow(card, open) {'));
    ok(/units: \(W && W\.cardUnits && W\.cardUnits\(card\)\) \? W\.cardUnits\(card\)\.map\(\(x\) => x\.unit\) : null/.test(src),
      'a card is read with the units its software reports, and none where it reports none');
  }

  // ---- 6. one markup, drawn twice: the pill and the shield on home and on the card's screen ----------------
  {
    /* The template has no shared part, so the card's screen carries its own copy of home's pill (as `q`) and of
     * the shield. A change to one that is not made to the other is caught here. */
    const forBlock = (list) => {
      const at = markup.indexOf('<sc-for list="{{ ' + list + ' }}"');
      return at < 0 ? '' : markup.slice(at, markup.indexOf('</sc-for>', at) + 9);
    };
    const homePill = forBlock('homePillRows');
    const card = forBlock('fcPillRows').replace(/fcPillRows/, 'homePillRows').replace(/as="q"/, 'as="p"')
      .replace(/\{\{ q\./g, '{{ p.').replace(/hint-placeholder-count="\d+"/, '');
    ok(!!homePill && card === homePill.replace(/hint-placeholder-count="\d+"/, ''),
      'the card screen’s pill is home’s pill, letter for letter, but for its name');
    const shields = markup.split('data-shield="{{ shieldState }}"').length - 1;
    const one = (from) => { const a = markup.lastIndexOf('<div', markup.indexOf('data-shield=', from)); return markup.slice(a, markup.indexOf('</svg></div></div>', a)); };
    const first = markup.indexOf('data-shield=');
    ok(shields === 2 && one(0) === one(first + 1), 'and the shield on both screens is the same markup');
  }

  // ---- 7. a long mint name stops short of the shield ------------------------------------------------
  {
    route = ROUTE();
    w.FoxyWallet = Object.assign(wallet(false), { mintHost: () => 'cashu-mint-of-the-northern-valley.example/Bitcoin' });
    A.setState({ screen: 'home', stack: [], walletLive: true, routeAt: Date.now() });
    await settle();
    const head = w.document.querySelector('[aria-label="Switch mint"]');
    const name = head && head.querySelector('[data-mint-name]');
    ok(!!name && name.textContent === 'CASHU-MINT-OF-THE-NORTHERN-VALLEY' && name.style.textOverflow === 'ellipsis'
      && name.style.whiteSpace === 'nowrap' && name.style.overflow === 'hidden' && head.style.padding === '0px 40px'
      && head.firstElementChild.style.maxWidth === '100%',
      'home: the name runs to an ellipsis inside a heading kept 40px clear of the shield on both sides', head ? head.getAttribute('style') : 'no heading');
    ok(!head.querySelector('svg') && head.children.length === 1 && head.firstElementChild.children.length === 1,
      'and nothing but the name shares its line');
    const fcHead = markup.slice(markup.indexOf('<sc-if value="{{ fcMintShown }}">'), markup.indexOf('{{ fcMintName }}'));
    ok(/padding:0 40px/.test(fcHead) && /data-mint-name style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/.test(fcHead),
      'the card’s screen: its mint’s name does the same');
    const fcBlock = markup.slice(markup.indexOf('<sc-if value="{{ fcMintShown }}">'), markup.indexOf('</sc-if>', markup.indexOf('{{ fcMintName }}')));
    ok(!/>MINT</.test(fcBlock) && !/<svg/.test(fcBlock) && (fcBlock.match(/<div/g) || []).length === 2,
      'and is headed by the name alone, with no MINT under it and no chevron', fcBlock);
  }

  // ---- 8. CARD at the top left of home, HOME at the top left of the card's screen, HISTORY first in each MENU; no pill, no snow ----
  {
    route = ROUTE();
    w.FoxyWallet = wallet(false);
    A.setState({ screen: 'home', stack: [], fc: null, open0: false, walletLive: true, routeAt: Date.now() });
    await settle();
    const q = (sel) => w.document.querySelector(sel);
    const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const CARD_ICON = 'M4.6 5.5h14.8a2.1 2.1 0 0 1 2.1 2.1v8.8a2.1 2.1 0 0 1-2.1 2.1H4.6a2.1 2.1 0 0 1-2.1-2.1V7.6a2.1 2.1 0 0 1 2.1-2.1ZM2.5 10h19M6 15h4';
    const CLOCK = 'M12 7v5l3.5 2M12 3.5a8.5 8.5 0 1 0 8.5 8.5A8.5 8.5 0 0 0 12 3.5Z';
    const cardBtn = q('[aria-label="Card"]');
    ok(!!cardBtn && cardBtn.style.left === '22px' && cardBtn.style.top === '56px' && !!cardBtn.querySelector('path[d="' + CARD_ICON + '"]') && !q('[aria-label="History"]'),
      'home: the round button at the top left is CARD, with the card drawing the menu had, and there is no HISTORY button there', cardBtn ? cardBtn.innerHTML : 'none');
    const went = [];
    const realGo = A.goFlashcard;
    A.goFlashcard = function () { went.push([...arguments]); };
    click(cardBtn);
    A.goFlashcard = realGo;
    ok(went.length === 1 && went[0].length === 0, 'CARD opens the card’s screen as a card’s address does (`goFlashcard`, which asks for the tap)', JSON.stringify(went));
    const v = V();
    ok(v.menuItems[0].label === 'HISTORY' && v.menuItems[0].path === CLOCK && !v.menuItems.some((m) => m.label === 'FLASHCARD'),
      'home’s MENU starts with HISTORY, with the clock, and has no FLASHCARD row', v.menuItems.map((m) => m.label).join());
    ok(v.menuItems[0].ringInk === v.histRingInk && v.menuItems[0].ring === v.histRing && (v.menuRing === v.histRing || v.menuRing === 'foxyRing 1.15s linear infinite'),
      'and HISTORY carries the ring the history button had, as does the menu button where the backup’s ring is not on it');
    A.setState({ open0: true });
    await settle();
    const firstRow = [...w.document.querySelectorAll('div')].find((d) => d.style.height === '60px' && d.style.borderRadius === '18px');
    ok(!!firstRow && /HISTORY/.test(firstRow.textContent), 'drawn as the first row of the drawer', firstRow ? firstRow.textContent : 'none');
    click(firstRow);
    await settle();
    ok(A.state.screen === 'history' && !A.state.open0, 'and it opens history, and closes the menu', A.state.screen);
    // the card's screen: HOME at the top left goes home
    A.setState({ screen: 'flashcard', stack: ['home'], fc: null, open0: false });
    await settle();
    const homeBtn = q('[aria-label="Home"]');
    ok(!!homeBtn && homeBtn.style.left === '22px' && homeBtn.style.top === '56px' && homeBtn.style.visibility !== 'hidden' && !q('[aria-label="This card’s history"]'),
      'the card’s screen: the round button at the top left is HOME, shown before any card is read', homeBtn ? homeBtn.getAttribute('style') : 'none');
    click(homeBtn);
    await settle();
    ok(A.state.screen === 'home' && !A.state.fc && A.state.stack.length === 0, 'and HOME is home', A.state.screen);
    ok(markup.indexOf('pageTabs') < 0 && markup.indexOf('data-page-tab') < 0 && markup.indexOf('fcMemo') < 0 && markup.indexOf('fcCardTap') < 0,
      'the HOME | CARD pill, the “As read” line and the pressable card picture are gone from the markup');
    ok(markup.indexOf('swipeDot') < 0 && markup.indexOf('Swipe left for your card') < 0, 'the dots and the swipe hint are gone from both screens');
    ok(markup.indexOf('data-snow-cap') < 0 && !/foxySnow(Drape|Pile|Clump)/.test(markup + app),
      'no snow settles on the money card or on the card’s picture any more');
  }

  const real = errors.filter((e) => !/Not implemented|navigation/i.test(e));
  ok(real.length === 0, 'no errors in the page', real.slice(0, 3).join(' | '));
  console.log('\n' + (failed ? passed + ' passed, ' + failed + ' failed' : 'all ' + passed + ' home shield checks pass'));
  process.exit(failed ? 1 : 0);
})();
