'use strict';
/* amount-entry.js — the amount keypads, and what a grey button says.
 *
 *     node tests/amount-entry.js
 *
 * Two pads take money in Foxy and they did not behave the same way. The
 * send/receive pad (renderAmount, build/app/23-render-home-and-amount.js)
 * typed whole dollars and a "." added cents. The split-a-bill pad
 * (splitVals, build/app/20-split-values.js) counts in cents — 5 then 0 is
 * $0.50 — and drew a "." whose handler was `if (l === '.') return;`: a key
 * that looks live, takes the tap, and does nothing. Both now count in cents
 * and both put "00" where the point was.
 *
 * The other half is the grey buttons. Split NEXT refuses a bill that cannot
 * divide
 * that the screen never mentioned, and NEXT at $0.00 on either pad refused
 * without a word. Neither screen has a spare line of markup to put a reason
 * in, so the refusal is what carries it.
 *
 * These read the parts directly (build/app/*.js), not the joined
 * build/foxy-app.js, so they run before a repack.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + msg + (detail && !c ? ' — ' + detail : ''));
  if (!c) failures++;
};

/* One method out of a part file. The parts are pieces of a class body, so a
 * method lifted out of one is valid object-literal shorthand. */
const part = (f) => fs.readFileSync(path.join(ROOT, 'build', 'app', f), 'utf8');
function method(src, sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}

const SPLIT = part('20-split-values.js');
const AMOUNT = part('23-render-home-and-amount.js');
const KEYPAD = part('19-update-keypad-balance.js');
const SEND = part('03-send.js');

const SIGS = [
  [SPLIT, 'spMoney(c) {'], [SPLIT, 'spCents() {'], [SPLIT, 'spWaysN() {'],
  [SPLIT, 'spOthers() {'], [SPLIT, 'spEven() {'], [SPLIT, 'spSharesArr() {'],
  [SPLIT, 'spSlots() {'], [SPLIT, 'spPaidArr() {'], [SPLIT, 'spNextUnpaid() {'],
  [SPLIT, 'spInitials(n) {'], [SPLIT, 'splitVals(s, sc) {'],
  [AMOUNT, 'renderAmount(c) {'],
  [KEYPAD, 'press(ch) {'], [KEYPAD, 'display() {'], [KEYPAD, 'group(n) {'],
  [SEND, 'usd(v) {'],
];
const methods = new Function('CTA_INK', 'window',
  'return {' + SIGS.map(([src, sig]) => method(src, sig)).join(',') + '}')(
  () => '#fff', { FoxyWallet: null });

let toasts = [], went = [], started = 0, lightning = 0;
const app = Object.assign({
  setState(u) {
    const patch = typeof u === 'function' ? u(this.state) : u;
    Object.assign(this.state, patch);
  },
  toast(m, amber) { toasts.push({ m: m, amber: !!amber }); },
  go(s) { went.push(s); this.state.screen = s; },
  back() { went.push('<back>'); },
  haptic() {}, copySecret() { return true; }, chooseRail() {},
  railRequest() { return ''; }, qrLoadingSrc() { return ''; }, boltField() { return null; },
  // offline + receive + a price: the keypad is dollars only (09-melt-paste-switch.js)
  dollarsOnly() { return false; },
  spStart() { started++; }, spDiscard() {}, spScanToken() {},
  satUsd() { return 0; }, wantedSats() { return 0; },
  // renderAmount asks it: offline, a dollar amount carries a stale-price warning
  offlineNow() { return false; }, priceAgo() { return ''; },
  trFromSats() { return 0; }, mintNameOf() { return ''; }, trNext() {}, ocNext() {},
  scanEcashToken() {}, makeEcashToken() {}, pasteEcashToken() {}, toggleUnit() {},
  renderVals() { return { pickLightning: () => { lightning++; } }; },
}, methods);

const reset = (extra) => {
  toasts = []; went = []; started = 0; lightning = 0;
  app.state = Object.assign({
    screen: 'spAmount', stack: [], spAmt: '0', spWays: 4, spIdx: 0,
    spAssigns: [], spPaid: [], spShares: null, spInvoices: [], spRail: 'LIGHTNING',
    spEditIdx: -1, spEditBuf: '', contacts: [],
    amount: '', unit: 'USD', flow: 'receive',
  }, extra || {});
};
const sp = (sc) => app.splitVals(app.state, sc || 'spAmount');
// one tap on the split amount pad, by the label drawn on the key
const tapSplit = (label) => {
  const k = sp('spAmount').spKeys.filter(x => x.label === label)[0];
  if (!k) throw new Error('no key labelled ' + JSON.stringify(label));
  k.tap();
};
const typeSplit = (s) => String(s).split('').forEach(tapSplit);
const amountVals = (o) => app.renderAmount(Object.assign(
  { s: app.state, sc: 'amount', sendOver: false, val: 0 }, o || {}));

// ---- the pads, side by side -----------------------------------------
{
  reset();
  const main = amountVals().keys.map(k => k.label);
  const split = sp('spAmount').spKeys.map(k => k.label);
  ok(main.length === split.length && split.length === 11,
     'both pads draw the same eleven cells, so 0 and delete sit under the same thumb',
     'main ' + main.length + ', split ' + split.length);
  ok(main.indexOf('0') === split.indexOf('0') && main.indexOf('0') === 10,
     'and 0 is the last cell on both, with delete after it');
  for (let i = 0; i < 9; i++) {
    if (main[i] !== split[i]) { ok(false, 'digits line up on both pads', i + ': ' + main[i] + ' vs ' + split[i]); break; }
  }
  ok(main[0] === '1' && split[8] === '9', 'digits line up on both pads');
}

// ---- no key is drawn that does nothing -------------------------------
{
  reset();
  const keys = sp('spAmount').spKeys;
  ok(keys.filter(k => k.label === '.').length === 0,
     'the split pad draws no decimal point');
  ok(keys[9].label === '00' && keys.filter(k => k.label === '00').length === 1,
     'the cell it stood in holds "00"', JSON.stringify(keys.map(k => k.label)));

  // from $0.01, so a leading 0 is a real digit rather than the one the pad
  // drops on both pads ("0" on an empty amount leaves it at zero)
  let dead = [];
  keys.forEach((k, i) => {
    reset({ spAmt: '1' });
    sp('spAmount').spKeys[i].tap();
    if (app.state.spAmt === '1') dead.push(JSON.stringify(k.label) + ' did nothing');
  });
  ok(dead.length === 0, 'every key on the split pad types from $0.01', dead.join('; '));
  reset({ spAmt: '1' });
  sp('spAmount').spKeys[9].tap();
  ok(app.state.spAmt === '100', '"00" on the split pad is two zeros: 1 then 00 is $1.00',
     JSON.stringify(app.state.spAmt));
  reset();
  sp('spAmount').spKeys[9].tap();
  ok((app.state.spAmt || '0') === '0', 'and on an empty amount it types nothing, like "0"',
     JSON.stringify(app.state.spAmt));

  // the share editor on the same flow is the same cents pad
  reset({ spEditIdx: 1, spEditBuf: '0' });
  const ed = sp('spShares').spEditKeys;
  ok(ed.map(k => k.label).join('|') === keys.map(k => k.label).join('|'),
     "the share editor's pad is the same eleven cells, with the same 00",
     JSON.stringify(ed.map(k => k.label)));
  ed[9].tap();
  ok(app.state.spEditBuf === '0', 'and its "00" types nothing on an empty amount either',
     JSON.stringify(app.state.spEditBuf));
  reset({ spEditIdx: 1, spEditBuf: '25' });
  sp('spShares').spEditKeys[9].tap();
  ok(app.state.spEditBuf === '2500', 'but 25 then 00 is $25.00 in the editor',
     JSON.stringify(app.state.spEditBuf));
}

// ---- the send/receive pad types dollars cents first --------------------
{
  const main = amountVals().keys;
  ok(main.filter(k => k.label === '.').length === 0 && main[9].label === '00',
     'the send/receive pad has "00" where the decimal point was',
     JSON.stringify(main.map(k => k.label)));
  reset();
  app.press('5');
  ok(app.state.amount === '0.05', '5 is $0.05', JSON.stringify(app.state.amount));
  app.press('0');
  ok(app.state.amount === '0.50', '5 then 0 is $0.50', JSON.stringify(app.state.amount));
  app.press('0');
  ok(app.state.amount === '5.00', 'and 500 is $5.00', JSON.stringify(app.state.amount));
  app.press('00');
  ok(app.state.amount === '500.00', '00 appends two zeros: $500.00', JSON.stringify(app.state.amount));
  app.press('del');
  ok(app.state.amount === '50.00', 'delete takes one digit back: $50.00', JSON.stringify(app.state.amount));
  ok(app.display() === '50.00', 'and the screen shows it with the point in place', app.display());
  reset();
  app.press('.');
  ok(app.state.amount === '', 'there is no decimal point to type', JSON.stringify(app.state.amount));
  app.press('0'); app.press('00');
  ok(app.state.amount === '', 'zeros on an empty amount type nothing', JSON.stringify(app.state.amount));
  reset();
  '123456789'.split('').forEach(c => app.press(c));
  app.press('1');
  ok(app.state.amount === '1234567.89', 'nine digits is the most: $1,234,567.89',
     JSON.stringify(app.state.amount));
  app.press('del'); app.press('00');
  ok(app.state.amount === '123456.78', 'and "00" cannot push past it either',
     JSON.stringify(app.state.amount));
  'xxxxxxxxx'.split('').forEach(() => app.press('del'));
  ok(app.state.amount === '', 'deleting everything leaves the pad empty', JSON.stringify(app.state.amount));

  // sats: whole numbers, 00 appends two zeros
  reset({ unit: 'SATS' });
  app.press('2'); app.press('1'); app.press('00');
  ok(app.state.amount === '2100', 'in sats 21 then 00 is 2,100', JSON.stringify(app.state.amount));
  reset({ unit: 'SATS' });
  app.press('00');
  ok(app.state.amount === '', 'and 00 on an empty sat amount types nothing', JSON.stringify(app.state.amount));
  reset({ unit: 'SATS' });
  app.press('.');
  ok(app.state.amount === '', 'a decimal point does nothing in sats', JSON.stringify(app.state.amount));
}

// ---- the split pad still counts in cents -----------------------------
{
  reset();
  typeSplit('50');
  ok(sp('spAmount').spAmtDisp === '$ 0.50',
     '5 then 0 on the split pad is still $0.50: what people can enter has not changed',
     sp('spAmount').spAmtDisp);
  reset();
  typeSplit('1234');
  ok(app.state.spAmt === '1234' && sp('spAmount').spAmtDisp === '$ 12.34',
     'and four digits are still four cents-digits',
     sp('spAmount').spAmtDisp);
}

// ---- any bill at all, and the floor that is real ----------------------
/* The flat $2.00 minimum is gone. It was a round number
 * standing in for the actual constraint, which is that nobody may end up
 * owing $0.00 — spEven() floors the division. That needs the number of ways,
 * so it is checked on the ways screen where both figures exist. */
{
  reset();
  typeSplit('199');
  sp('spAmount').spAmtNext();
  ok(went.length === 1 && went[0] === 'spWays' && toasts.length === 0,
     '$1.99 goes on — there is no flat minimum any more',
     JSON.stringify(went) + ' ' + JSON.stringify(toasts));

  reset();
  typeSplit('2');
  sp('spAmount').spAmtNext();
  ok(went.length === 1 && toasts.length === 0, 'and so does two cents');

  reset();
  sp('spAmount').spAmtNext();
  ok(went.length === 0 && toasts.length === 1 && toasts[0].m === 'Type an amount first.',
     'only $0.00 is refused, and it says so',
     JSON.stringify(toasts));
}

// ---- a bill that will not divide is refused where the ways are known ---
{
  // 3 cents four ways is [3,0,0,0]: three people would owe nothing
  reset({ spAmt: '3', spWays: 4 });
  sp('spWays').spWaysNext();
  ok(went.length === 0, 'a bill smaller than the number of ways does not go on');
  ok(toasts.length === 1 && /does not divide 4 ways/.test(toasts[0].m),
     'and the refusal names the bill and the ways',
     JSON.stringify(toasts));

  // 4 cents four ways is [1,1,1,1]: everybody owes a penny, which is allowed
  reset({ spAmt: '4', spWays: 4 });
  sp('spWays').spWaysNext();
  ok(went.length === 1 && went[0] === 'spShares' && toasts.length === 0,
     'a penny each is a real split and goes on',
     JSON.stringify(went) + ' ' + JSON.stringify(toasts));

  // the gate must match spEven exactly — block iff some share would be zero
  const spEven = (cents, n) => {
    const base = Math.floor(cents / n), a = [];
    for (let i = 0; i < n; i++) a.push(base);
    a[0] += cents - base * n;
    return a;
  };
  let wrong = 0;
  for (let cents = 0; cents <= 40; cents++) {
    for (let n = 2; n <= 8; n++) {
      reset({ spAmt: String(cents), spWays: n });
      sp('spWays').spWaysNext();
      const blocked = went.length === 0;
      if (blocked !== spEven(cents, n).some(x => x === 0)) wrong++;
    }
  }
  ok(wrong === 0,
     'and across every bill to 40c and every way count, it blocks exactly the zero-share cases',
     wrong + ' disagreed with spEven');
}

// ---- the shares NEXT ---------------------------------------------------
{
  reset({ spAmt: '1000', spWays: 2, spShares: [400, 400] });
  sp('spShares').spSharesNext();
  ok(started === 0 && toasts.length === 1
     && toasts[0].m === 'The shares have to add up to the bill.',
     'shares short of the bill are named on the tap that is refused',
     JSON.stringify(toasts));

  reset({ spAmt: '1000', spWays: 2, spShares: [1000, 0] });
  sp('spShares').spSharesNext();
  ok(started === 0 && toasts.length === 1 && toasts[0].m === 'Every share needs an amount.',
     'a share left at $0.00 adds up but is still refused, and says why',
     JSON.stringify(toasts));

  reset({ spAmt: '1000', spWays: 2, spShares: [500, 500] });
  sp('spShares').spSharesNext();
  ok(started === 1 && toasts.length === 0 && app.state.screen === 'spPayer',
     'shares that add up go on, and say nothing');
}

// ---- the send/receive NEXT --------------------------------------------
{
  reset();
  amountVals({ val: 0 }).next();
  ok(lightning === 0 && toasts.length === 1 && toasts[0].m === 'Type an amount first.',
     'NEXT at zero says why instead of doing nothing at all',
     JSON.stringify(toasts));

  reset({ flow: 'send' });
  amountVals({ val: 0 }).next();
  ok(toasts.length === 1 && toasts[0].m === 'Type an amount first.',
     'and the same on the send side');

  reset({ flow: 'send', amount: '9' });
  amountVals({ val: 9, sendOver: true }).next();
  ok(toasts.length === 0,
     'over the balance stays silent: the screen already says MORE THAN YOUR BALANCE',
     JSON.stringify(toasts));
  ok(amountVals({ val: 9, sendOver: true }).sendOverLabel === 'MORE THAN YOUR BALANCE',
     'which is the line this leans on');

  reset({ flow: 'receive', amount: '5' });
  amountVals({ val: 5 }).next();
  ok(lightning === 1 && toasts.length === 0, 'a real amount goes on, and says nothing');
}

// ---- nothing refuses in silence ---------------------------------------
{
  const buttons = [
    ['split NEXT, $0.00', () => { reset(); sp('spAmount').spAmtNext(); }],
    ['split NEXT at nothing', () => { reset(); sp('spAmount').spAmtNext(); }],
    ['split ways NEXT that will not divide', () => { reset({ spAmt: '3', spWays: 4 }); sp('spWays').spWaysNext(); }],
    ['shares NEXT, not adding up', () => { reset({ spAmt: '900', spWays: 2, spShares: [100, 100] }); sp('spShares').spSharesNext(); }],
    ['amount NEXT, zero', () => { reset(); amountVals({ val: 0 }).next(); }],
  ];
  const mute = buttons.filter(([, run]) => { run(); return toasts.length === 0; }).map(([n]) => n);
  ok(mute.length === 0,
     'every disabled primary button on these two screens explains itself when tapped',
     mute.join(', '));
}

console.log('\n' + (failures ? failures + ' failed' : 'all amount entry checks pass'));
process.exit(failures ? 1 : 0);
