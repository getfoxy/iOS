'use strict';
/* RECEIVED, where every receive comes to rest (the keeper's 2026-11-06 design, 1h; 24-render-receive-and-send.js `renderPaidRest`,
 * build/markup.html `isPaidIn`).
 *
 *   1. a receive is the green screen (`isPaidIn`), not the old one: RECEIVED, the amount, DONE pressing `dismissPaid`
 *   2. what the old screen said beside the amount is kept as lines under it: the line under the headline, and ADDED TO a
 *      balance, NOW AT a mint, SENT TO THE KEEPER
 *   3. the screen's own words are its title: CARD MOVED, RESTORED
 *   4. a payment out (WITHDRAWAL SENT, ON THE CARD) keeps the old screen (`isPaidOut`)
 *   5. any other screen has none of these values
 *   6. the markup: the green ground, the black circle with the green tick, the lines in Figtree 19px, DONE on `dismissPaid`,
 *      the flash drawn over it as before, and the old screen only for a payment out */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (cond, what, detail) => {
  if (cond) { passed += 1; console.log('ok    ' + what); } else { failed += 1; process.exitCode = 1; console.log('FAIL  ' + what + (detail ? ' — ' + detail : '')); }
};

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');
function method(sig) {
  const at = appSrc.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = appSrc.indexOf('{', at + sig.length - 1), depth = 0;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  return appSrc.slice(at + 3, i + 1);
}
const group = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const app = () => {
  const a = new Function('CTA_INK', 'return {' + ['renderPaid(c) {', 'renderPaidBase(c) {', 'renderPaidRest(c, v) {'].map(method).join(',\n') + '}')(() => '#fff');
  return Object.assign(a, {
    money: (sats) => ({ main: '$' + (sats / 1000).toFixed(2), sub: '₿ ' + group(sats) }),
    unitFigure: (n, u) => (u === 'usd' ? '$ ' + (n / 100).toFixed(2) : '₿ ' + group(n)),
    fitStack: () => '', satsStack: () => '', boltField: () => '', paidTargetLabel: () => 'alice@example.com',
    twoUnitsOn: () => false, priceAgeWords: () => '2 MINUTES AGO', group, _lastFee: 0,
    state: {},
  });
};
const paid = (s, sats) => {
  const a = app();
  const st = Object.assign({ recv: { live: 'in' }, recvResolved: true, paidUnit: 'sat', paidAmount: sats, payOut: false, paidPlace: null, paidSays: '' }, s);
  a.state = st;
  return a.renderPaid({ s: st, sc: 'paid', sats });
};

// 1
let v = paid({}, 2100);
ok(v.isPaid && v.isPaidIn && !v.isPaidOut && v.paidRestTitle === 'RECEIVED' && v.paidHeadline === '$2.10' && v.paidRestDone === 'DONE'
   && typeof v.dismissPaid === 'function' && v.paidRestSize === '76px',
   '1: a receive rests on RECEIVED, the amount at 76px, and DONE', JSON.stringify({ i: v.isPaidIn, t: v.paidRestTitle, h: v.paidHeadline, d: v.paidRestDone }));
ok(/#5FD58C/.test(v.paidRestBg) && /#138A44/.test(v.paidRestBg), '1: on the green, #5FD58C to #138A44', v.paidRestBg);
ok(paid({ recv: { live: 'out' } }, 2100).paidRestBg === '#050505', '1: dark as it goes, as the old screen did');
ok(paid({}, 123456789).paidRestSize !== '76px', '1: a figure too long for 76px is made smaller', paid({}, 123456789).paidRestSize);

// 2
const lines = (x) => x.paidRestLines.map((l) => l.text).join(' / ');
ok(lines(v) === '₿ 2,100 / ADDED TO Cash Balance', '2: the other currency and ADDED TO are kept under the amount', lines(v));
v = paid({ paidPlace: { label: 'NOW AT', to: 'Minibits' } }, 500);
ok(lines(v) === '₿ 500 / NOW AT Minibits' && v.paidRestDone === 'DONE', '2: NOW AT a mint', lines(v));
v = paid({ paidPlace: { label: 'SENT TO', to: 'THE KEEPER' } }, 500);
ok(/SENT TO THE KEEPER$/.test(lines(v)), '2: SENT TO THE KEEPER', lines(v));
v = paid({ paidUnit: 'usd', paidAmount: 592, paidAskedSats: 7000 }, 0);
ok(v.paidHeadline === '$ 5.92' && lines(v) === 'Paid in dollars: $ 5.92 for ₿ 7,000 / ADDED TO DOLLARS', '2: dollars paid for sats asked: the line that says so', lines(v));

// 3
v = paid({ paidSays: 'CARD MOVED', paidUnit: 'usd', paidAmount: 1994, paidPlace: { label: 'NOW AT', to: 'Minibits', dismiss: 'DONE' } }, 0);
ok(v.isPaidIn && v.paidRestTitle === 'CARD MOVED' && /NOW AT Minibits/.test(lines(v)), '3: CARD MOVED is its own title, NOW AT the new mint under it', v.paidRestTitle + ' | ' + lines(v));
ok(paid({ paidSays: 'RESTORED' }, 800).paidRestTitle === 'RESTORED', '3: RESTORED');

// 4
v = paid({ payOut: true }, 2100);
ok(v.isPaid && v.isPaidOut && !v.isPaidIn && v.paidTitle === 'WITHDRAWAL SENT' && v.paidDismissLabel === 'DISMISS', '4: a payment out keeps the old screen: WITHDRAWAL SENT', JSON.stringify({ o: v.isPaidOut, t: v.paidTitle }));
v = paid({ payOut: true, paidSays: 'ON THE CARD' }, 2100);
ok(v.isPaidOut && !v.isPaidIn && v.paidTitle === 'ON THE CARD', '4: ON THE CARD too');

// 5
const a5 = app();
const other = a5.renderPaid({ s: { recv: {}, paidUnit: 'sat', paidAmount: 5 }, sc: 'home', sats: 5 });
ok(!other.isPaid && !('isPaidIn' in other) && !('paidRestTitle' in other) && !('paidRestLines' in other), '5: another screen has none of these values', Object.keys(other).filter((k) => /Rest|isPaidIn|isPaidOut/.test(k)).join());

// 6
const inBlock = (markup.split('<sc-if value="{{ isPaidIn }}">')[1] || '').split('<sc-if value="{{ isPaidOut }}">')[0];
ok(!!inBlock && /data-paid-rest="1"/.test(inBlock) && /background:\{\{ paidRestBg \}\}/.test(inBlock) && /color:#04210F/.test(inBlock),
   '6: the green screen is its own block, on its own ground and ink');
ok(/font-size:34px;line-height:1\.05;letter-spacing:\.1em[^>]*>\{\{ paidRestTitle \}\}/.test(inBlock) && /font-size:\{\{ paidRestSize \}\}[^>]*>\{\{ paidHeadline \}\}/.test(inBlock),
   '6: the 34px title spaced out, and the amount');
ok(/<sc-for list="\{\{ paidRestLines \}\}" as="l"[^>]*><div style="font-family:Figtree[^"]*font-size:19px[^"]*">\{\{ l\.text \}\}<\/div><\/sc-for>/.test(inBlock),
   '6: the kept lines in Figtree 19px');
ok(/width:132px;height:132px;border-radius:50%;background:#0A0A0A/.test(inBlock) && /stroke="#5FD58C"/.test(inBlock), '6: the black circle with the green tick');
ok(/sc-camel-on-click="\{\{ dismissPaid \}\}"[^>]*>\{\{ paidRestDone \}\}/.test(inBlock) && /background:#0A0A0A;color:#FFFFFF/.test(inBlock), '6: DONE, black, on dismissPaid');
ok(/animation:\{\{ paidBoltFlash \}\}/.test(inBlock) && /\{\{ paidBolts \}\}/.test(inBlock), '6: the flash plays over it as before');
ok(markup.indexOf('<sc-if value="{{ isPaid }}">') < 0 && /<sc-if value="\{\{ isPaidOut \}\}">\n<div style="position:relative;overflow:hidden;height:100%;display:flex;flex-direction:column;background:\{\{ paidBg \}\}/.test(markup),
   '6: the old screen only for a payment out');

console.log(passed + ' passed, ' + failed + ' failed');
