'use strict';
/* history-notes.js — when a payment was, and what it was for.
 *
 *     node tests/history-notes.js
 *
 * The history screen:
 *   1. the time of day by the phone's own clock, not "3h ago"; and once a
 *      payment is more than twenty-four hours old, the date in front of it,
 *      two digits for the month and two for the day;
 *   2. a note, where there is one, is what the card says, in place of
 *      "ecash" or the start of an invoice, on the same one line;
 *   3. the detail screen adds a note where there is none and changes one
 *      where there is;
 *   7. a card's restore asked before its date is a pending row in home's
 *      history, "Restoring <the card>", the amount coming back in its column, UNLOCKS IN 28D on
 *      would be, and in no balance.
 * The methods are lifted out of build/foxy-app.js, as tap-held.js does.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const native = fs.readFileSync(path.join(ROOT, 'Foxy', 'FoxyWebView.swift'), 'utf8');

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
function method(sig) {
  const at = app.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = app.indexOf('{', at), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at + 3, i + 1);
}
const lift = (sigs) => new Function('return {' + sigs.map(method).join(',\n') + '}')();

console.log('1. the time, by the phone’s clock');
{
  const a = lift(['txLabel(d, now) {', 'txStamp(d, now) {', 'txDay(d, now) {', 'txClock(d) {']);
  const now = new Date(2026, 9, 4, 14, 0, 0);          // 4 October 2026, 2:00 in the afternoon, local
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);
  global.window = { __foxyClock24: false };
  ok('fifteen minutes ago is a time, not "15m ago"', a.txLabel(at(2026, 10, 4, 13, 45), now) === '1:45 PM', a.txLabel(at(2026, 10, 4, 13, 45), now));
  ok('this morning is a time', a.txLabel(at(2026, 10, 4, 9, 7), now) === '9:07 AM', a.txLabel(at(2026, 10, 4, 9, 7), now));
  ok('yesterday evening, inside twenty-four hours, is still only a time', a.txLabel(at(2026, 10, 3, 14, 1), now) === '2:01 PM', a.txLabel(at(2026, 10, 3, 14, 1), now));
  ok('more than twenty-four hours old: the date first, month and day in two digits each', a.txLabel(at(2026, 10, 3, 13, 0), now) === '10/03 1:00 PM', a.txLabel(at(2026, 10, 3, 13, 0), now));
  ok('a single-digit month and day are padded', a.txLabel(at(2026, 1, 5, 9, 7), now) === '01/05 9:07 AM', a.txLabel(at(2026, 1, 5, 9, 7), now));
  ok('midnight and noon read as twelve', a.txLabel(at(2026, 10, 4, 0, 5), now) === '12:05 AM' && a.txLabel(at(2026, 10, 4, 12, 0), now) === '12:00 PM',
     a.txLabel(at(2026, 10, 4, 0, 5), now) + ', ' + a.txLabel(at(2026, 10, 4, 12, 0), now));
  ok('another year says which', a.txLabel(at(2025, 12, 31, 23, 59), now) === '12/31/25 11:59 PM', a.txLabel(at(2025, 12, 31, 23, 59), now));
  ok('the detail screen always has the date', a.txStamp(at(2026, 10, 4, 13, 45), now) === '10/04 1:45 PM', a.txStamp(at(2026, 10, 4, 13, 45), now));
  global.window = { __foxyClock24: true };
  ok('a phone set to twenty-four hours gets twenty-four hours', a.txLabel(at(2026, 10, 4, 13, 45), now) === '13:45' && a.txLabel(at(2026, 10, 3, 9, 7), now) === '10/03 09:07',
     a.txLabel(at(2026, 10, 4, 13, 45), now) + ', ' + a.txLabel(at(2026, 10, 3, 9, 7), now));
  global.window = {};
  ok('with no word from the phone, the page’s own locale decides, and it is still a time', /^\d{1,2}[:.]\d{2}/.test(a.txLabel(at(2026, 10, 4, 13, 45), now)), a.txLabel(at(2026, 10, 4, 13, 45), now));
  ok('nothing says "ago" any more', !/ago'|just now/.test(method('txLabel(d, now) {')));
  ok('the phone says which clock it keeps, before the page runs', /__foxyClock24 = /.test(native) && /fromTemplate: "j"/.test(native) && /atDocumentStart/.test(native));
  ok('rows and the detail screen both take their time from here', /time: this\.txLabel\(d, now\)/.test(app) && /stamp: this\.txStamp\(d, now\)/.test(app) && /txTime: tx\.stamp \|\| tx\.time/.test(app));
}

console.log('\n2. the note is what the card says');
{
  // (a card's own list names its rows for what they were to the card: section 5)
  ok('a row with a note shows the note; one without shows what it showed', /name: ofCard \? cardName\(t\) : \(\(t\.note && String\(t\.note\)\.trim\(\)\) \|\| t\.name\),/.test(app));
  // the history list's own row, not the home screen's
  const row = /<div style="([^"]*)">\{\{ t\.name \}\}<\/div>/.exec(markup.slice(markup.indexOf('list="{{ g.items }}"')));
  ok('on one line, cut with an ellipsis, so the card is no taller', !!row && /white-space:nowrap/.test(row[1]) && /text-overflow:ellipsis/.test(row[1]) && /overflow:hidden/.test(row[1]), row ? row[1] : 'row not found');
  ok('and the title shares its line with the amount only, so a note runs as far as the amount', /\{\{ t\.name \}\}<\/div><div style="flex:none;[^"]*">\{\{ t\.amtText \}\}<\/div><\/div>/.test(markup));
  ok('the balance line, the widest thing on the card, is beside the time and not beside the title', /\{\{ t\.line3 \}\}<\/div><div style="flex:none;[^"]*">\{\{ t\.balText \}\}/.test(markup));
  ok('the detail screen still names who it was to', /txParty: tx\.party \|\| tx\.name/.test(app));
}

console.log('\n3. a note added or changed from the detail screen');
{
  const tags = [], loads = [];
  let sheet = null;
  global.window = { FoxyWallet: { tag: (h, o) => tags.push([h, o]) } };
  const mk = (tx) => Object.assign(lift(['editTxNote() {']), {
    state: { tx: tx },
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    loadHistory() { loads.push(1); },
    noteSheet(existing, onSave, o) { sheet = { existing, onSave, o }; },
  });
  const a = mk({ hash: 'token-1', note: '' });
  a.editTxNote();
  ok('with no note, the sheet opens empty', sheet && sheet.existing === '', JSON.stringify(sheet && sheet.existing));
  sheet.onSave('  Lunch with Sam  ');
  ok('saved: written on the payment, trimmed, and the list is drawn again', tags.length === 1 && tags[0][0] === 'token-1' && tags[0][1].note === 'Lunch with Sam' && loads.length === 1, JSON.stringify(tags));
  ok('and the detail screen shows it at once', a.state.tx.note === 'Lunch with Sam');
  a.editTxNote();
  ok('with a note, the sheet opens on it, to be changed', sheet.existing === 'Lunch with Sam' && sheet.o && sheet.o.edit === true);
  sheet.onSave('');
  ok('saved empty, the note is taken off', tags.length === 2 && tags[1][1].note === '' && a.state.tx.note === '');
  const b = mk({});
  sheet = null;
  b.editTxNote();
  ok('an entry with nothing to hang a note on opens nothing', sheet === null);

  const cta = /txNoteCta: tx\.note \? 'EDIT NOTE' : 'ADD A NOTE'/.test(app);
  const btn = /sc-camel-on-click="\{\{ txNoteEdit \}\}"[^>]*>\{\{ txNoteCta \}\}/.test(markup);
  ok('the button says ADD A NOTE or EDIT NOTE, and is always there', cta && btn);
  ok('the note itself is drawn only when there is one', /<sc-if value="\{\{ txHasNote \}\}">[\s\S]{0,400}\{\{ txNote \}\}<\/div><\/sc-if><div sc-camel-on-click="\{\{ txNoteEdit \}\}"/.test(markup));
}
{
  // the sheet itself: ADD needs words; SAVE on an existing note may be empty
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  global.window = dom.window; global.document = dom.window.document;
  const a = Object.assign(lift(['noteSheet(existing, onSave, o) {']), {});
  const run = (existing, o, typed) => {
    let saved;
    a.noteSheet(existing, (t) => { saved = t; }, o);
    const input = dom.window.document.querySelector('input');
    const buttons = Array.from(dom.window.document.querySelectorAll('div')).filter((d) => /^(ADD|SAVE)$/.test(d.textContent));
    const save = buttons[buttons.length - 1];
    if (typed !== undefined) { input.value = typed; input.dispatchEvent(new dom.window.Event('input')); }
    const label = save.textContent;
    save.dispatchEvent(new dom.window.Event('click'));
    const still = !!dom.window.document.querySelector('input');
    if (still) Array.from(dom.window.document.querySelectorAll('div')).filter((d) => d.textContent === 'CANCEL').pop().dispatchEvent(new dom.window.Event('click'));
    return { saved, label, maxLength: input.maxLength, still };
  };
  const add = run('', undefined, '');
  ok('adding: an empty note cannot be saved', add.label === 'ADD' && add.saved === undefined && add.still === true, JSON.stringify(add));
  const add2 = run('', undefined, 'Rent');
  ok('adding: words can', add2.saved === 'Rent' && add2.still === false, JSON.stringify(add2));
  const edit = run('Lunch', { edit: true }, '');
  ok('changing: the button says SAVE and an empty note is allowed', edit.label === 'SAVE' && edit.saved === '', JSON.stringify(edit));
  ok('a note is 120 characters at most', add.maxLength === 120, String(add.maxLength));
}

console.log('\n4. a note outlives the tidying of old entries');
{
  /* The wallet keeps what it knows about three hundred payments and drops
   * the oldest beyond that. A note is the card's title now, so the oldest
   * entry WITHOUT one goes first. */
  const { load } = require('./harness');
  const ctx = load();
  const W = ctx.window.FoxyWallet;
  W.tag('old-with-note', { note: 'Rent, March' });
  W.tag('old-plain', { to: 'ecash' });
  for (let i = 0; i < 300; i++) W.tag('later-' + i, { to: 'ecash' });
  ok('three hundred payments later, the note is still on its payment', (W.tagsFor('old-with-note') || {}).note === 'Rent, March', JSON.stringify(W.tagsFor('old-with-note')));
  ok('and what went to make room was an older entry with nothing written on it', !(W.tagsFor('old-plain') || {}).to, JSON.stringify(W.tagsFor('old-plain')));
}

console.log('\n5. a card’s own list is the card’s account');
{
  /* CARD HISTORY is this phone's entries that name the card, and it read them
   * as this phone's: a payment the card made here showed as a credit, and
   * money put on the card as a withdrawal. Turned round, each is named for
   * what it was to the card. renderHistory is lifted out, with what it calls
   * stood in for. */
  const a = lift(['renderHistory(c) {']);
  global.CTA_INK = () => '#fff';
  global.window = { FoxyWallet: {} };
  Object.assign(a, {
    histAudit: () => ({ balOf: new Map(), balNow: 0, run: 0, dueChange: 0, dueCount: 0, off: 0, flagged: new Map(), toShowCount: 0, toShowSats: 0 }),
    stageMoney: (n) => '₿ ' + n, money: (n) => ({ main: '₿ ' + n, sub: '' }), txFiat: () => 0,
    txTotalOut: (t) => (t.sats || 0) + (t.fee || 0), px: () => 0, group: (n) => String(n),
    topUpFeeSats: () => 0, recoveringSats: () => 0, unitMoney: (n) => String(n), unitLabel: (u) => u,
    openTx: () => {}, openPendingSplit: () => {}, goSwitchMint: () => {}, go: () => {}, setState: () => {}, histRef: () => {},
  });
  const KEY = '02card';
  const item = (o) => Object.assign({ hash: 'h' + Math.random(), time: '9:22 AM', fee: 0, card: KEY, name: 'card', memo: '', changeSats: 0, changeState: '' }, o);
  const history = [{ label: 'TODAY', items: [
    item({ dir: 'in', sats: 6156, memo: 'card', name: 'ecash' }),                             // a till paid by the card, on trust
    item({ dir: 'in', sats: 12312, memo: 'card', name: 'card payment', changeSats: 4072, changeState: 'given back' }),
    item({ dir: 'in', sats: 34448, memo: 'card', name: 'card payment', changeSats: 368, changeState: 'not handed' }),
    item({ dir: 'out', sats: 61514, fee: 31, memo: 'to card', name: 'card' }),               // put on the card, and its fee
    item({ dir: 'in', sats: 900, memo: 'from card', name: 'card' }),                          // taken off it
    item({ dir: 'in', sats: 0, memo: 'card, not completed', name: 'card', changeSats: 6144, changeState: 'not handed' }),
    item({ dir: 'in', sats: 5000, memo: 'lunch', name: 'alice@example.com', card: '' }),     // nothing to do with the card
  ] }];
  const view = (hf, card) => {
    const s = { screen: 'history', stack: card ? ['home', 'flashcard'] : ['home'], histCard: card ? KEY : '', histFilter: hf, history, historyComplete: true };
    const v = a.renderHistory({ s, sc: 'history' });
    return { title: v.histTitle, rows: [].concat(...v.historyGroups.map((g) => g.items)) };
  };
  const all = view('all', true);
  const said = all.rows.map((r) => r.name + ' ' + r.amtText + (r.line2 && !/AM|PM/.test(r.line2) ? ' (' + r.line2 + ')' : '')).join(', ');
  ok('the card’s list is titled CARD HISTORY and holds only the card’s entries', all.title === 'CARD HISTORY' && all.rows.length === 6, said);
  ok('a payment the card made is Paid, and minus: money that left the card',
     all.rows.slice(0, 3).every((r) => r.name === 'Paid' && /^−₿/.test(r.amtText)) && all.rows[0].amtText === '−₿ 6156', said);
  ok('money put on the card is Added, and plus, at what reached the card and not with this phone’s fee', all.rows[3].name === 'Added' && all.rows[3].amtText === '+₿ 61514', said);
  ok('money taken off it is Withdrawn, and minus', all.rows[4].name === 'Withdrawn' && all.rows[4].amtText === '−₿ 900', said);
  ok('a payment that was not made is Not completed, with no sign, and says its money is to go back on the card',
     all.rows[5].name === 'Not completed' && all.rows[5].amtText === '₿ 0' && all.rows[5].line2 === 'To go back on the card', said);
  ok('a payment whose change is still to go back says so', all.rows[2].line2 === 'Change to go back on the card', all.rows[2].line2);
  ok('RECEIVED is what came onto the card, SENT what left it',
     view('in', true).rows.map((r) => r.name).join() === 'Added' && view('out', true).rows.map((r) => r.name).join() === 'Paid,Paid,Paid,Withdrawn,Not completed',
     view('in', true).rows.map((r) => r.name).join() + ' / ' + view('out', true).rows.map((r) => r.name).join());
  const mine = view('all', false);
  ok('the wallet’s own history is the phone’s account, as it was: the card payment is a plus here, the money put on the card a minus',
     mine.title === 'HISTORY' && mine.rows.length === 7 && /^\+/.test(mine.rows[1].amtText) && /^−/.test(mine.rows[3].amtText) && mine.rows[1].name === 'card payment',
     mine.rows.map((r) => r.name + ' ' + r.amtText).join(', '));
}

console.log('\n6. a card’s business is in the card’s list, and not in home’s');
{
  /* Home's HISTORY leaves out what is a card's: rows naming a card on file here (`cardKnownHere`: set up here or claimed), and what a
   * card paid from its own screen (`fromCard`). A till's receipt of someone else's card stays: it is the till's own income. A
   * swap begun from the card is, to the card, its two taps (the take-off 'from card' and the put-on 'to card'), and those are
   * in the card's list; the swap's own legs name no card and are in home's, as any swap is. The take-back of a lost card
   * (`lost`) is in home's list too: that card's own list cannot be opened. The books (`histAudit`, lifted for real here) still
   * walk every row, so home still ADDS UP with the card's rows not shown. */
  const a = lift(['renderHistory(c) {', 'histAudit() {']);
  global.CTA_INK = () => '#fff';
  const KEY = '02mine', OTHER = '02someone';
  global.window = { FoxyWallet: { cardKnownHere: (k) => k === KEY, heldSats: () => 0 } };
  Object.assign(a, {
    histAuditIn: function (u) { return this.histAudit(); }, histAuditUsd: function () { return this.histAudit(); },
    stageMoney: (n) => '₿ ' + n, money: (n) => ({ main: '₿ ' + n, sub: '' }), txFiat: () => 0,
    txTotalOut: (t) => (t.sats || 0) + (t.fee || 0), px: () => 0, group: (n) => String(n),
    topUpFeeSats: () => 0, recoveringSats: () => 0, unitMoney: (n) => String(n), unitLabel: (u) => u,
    unitFigure: (n, u) => (u === 'usd' ? '$' + (n / 100).toFixed(2) : '₿ ' + n), unitWord: (u) => (u === 'usd' ? 'DOLLARS' : 'BITCOIN'),
    homePills: () => ['usd', 'sat'], segLook: () => ({}), twoUnitsOn: () => false, fcTwoUnits: () => true,
    openTx: () => {}, openPendingSplit: () => {}, goSwitchMint: () => {}, go: () => {}, setState: () => {}, histRef: () => {},
  });
  a.histRowTwo = function (t) { return { amtText: (t.dir === 'in' ? '+ ' : '- ') + (t.unit === 'usd' ? '$' + (t.amount / 100).toFixed(2) : '₿ ' + t.sats), amtSub: '', balText: 'BAL' }; };
  const item = (o) => Object.assign({ hash: 'h' + Math.random(), time: '9:22 AM', fee: 0, card: '', fromCard: '', name: 'x', memo: '', changeSats: 0, changeState: '' }, o);
  // a $5 swap into bitcoin begun from my card: its first tap, the swap's two legs on this phone, its second tap
  const rows = [
    item({ dir: 'in', sats: 0, unit: 'usd', amount: 510, memo: 'from card', card: KEY, name: 'card' }),             // the first tap: $5.10 off the card
    item({ dir: 'out', sats: 0, unit: 'usd', amount: 510, memo: 'swap', kind: 'swap', swap: 'uswap-1', name: 'swap' }),   // the swap's melt, in dollars
    item({ dir: 'in', sats: 4900, memo: 'swap', kind: 'swap', swap: 'uswap-1', name: 'swap' }),                      // its claim, in bitcoin
    item({ dir: 'out', sats: 4900, memo: 'to card', card: KEY, name: 'card' }),                                       // the second tap: ₿4900 onto the card
    item({ dir: 'out', sats: 300, memo: 'paid from card', fromCard: KEY, name: 'shop' }),                           // paid from the card's screen
    item({ dir: 'in', sats: 2000, memo: 'card', card: OTHER, name: 'card payment' }),                              // a stranger's card paid this till
    item({ dir: 'out', sats: 10000, fee: 20, memo: 'to card', card: KEY, name: 'card' }),                           // put on my card
    item({ dir: 'in', sats: 50000, memo: 'lunch', name: 'alice@example.com' }),
    item({ dir: 'in', sats: 700, memo: 'from card', card: KEY, lost: true, name: 'Taken back from a lost card' }),  // RESTORE LOST CARD
  ];
  const history = [{ label: 'TODAY', items: rows }];
  // the books as this list leaves them: 50,000 in, 10,020 put on the card, 2,000 from the till, 300 paid from the card, the swap's
  // sats in and put on the card, and 700 taken back from a lost card
  const balSats = 50000 - 10020 + 2000 - 300 + 4900 - 4900 + 700;
  const view = (card, unit, list) => {
    const s = { screen: 'history', stack: card ? ['home', 'flashcard'] : ['home'], histCard: card ? KEY : '', histFilter: 'all', history: list || history, historyComplete: true,
                balSats, histUnit: unit || 'sat', fc: card ? { key: KEY, v123: true, bal: { usd: 100, sat: 4900 } } : null };
    a.state = s;
    const v = a.renderHistory({ s, sc: 'history' });
    return { v, rows: [].concat(...v.historyGroups.map((g) => g.items)) };
  };
  const home = view(false);
  const names = (rs) => rs.map((r) => r.name + ' ' + r.amtText).join(', ');
  ok('home leaves out the load onto my card, the swap’s two taps, and what the card paid from its own screen',
     home.rows.length === 5 && !home.rows.some((r) => r.name === 'card' || r.name === 'shop'), names(home.rows));
  ok('home has the swap’s two legs, as any swap: this phone made it between the taps',
     home.rows.filter((r) => r.name === 'swap').map((r) => r.amtText).join() === '−510,+₿ 4900',
     names(home.rows));
  ok('home keeps a till’s receipt of someone else’s card: the till’s own income', home.rows.some((r) => r.name === 'card payment' && r.amtText === '+₿ 2000'), names(home.rows));
  ok('home keeps the take-back of a lost card, named for what it was: that card’s own list cannot be opened',
     home.rows.some((r) => r.name === 'Taken back from a lost card' && r.amtText === '+₿ 700'), names(home.rows));
  ok('the history read from the wallet carries `lost`, and names such a row for what it was (by the card’s name, where this phone gave it one)',
     /lost: !!t\.lost,/.test(method('loadHistory() {')) && /const who = t\.lost \? \(this\.txCardName\(t\) \? 'Taken back from ' \+ this\.txCardName\(t\) : 'Taken back from a lost card'\) :/.test(method('loadHistory() {')));
  ok('home still ADDS UP: the books walk the card’s rows too, shown or not', home.v.histAuditTitle === 'ADDS UP', home.v.histAuditTitle + ' / ' + home.v.histAuditBody);
  const sats = view(true, 'sat'), usd = view(true, 'usd');
  ok('the card’s BITCOIN tab: the swap’s second tap, the payment from its screen, the load, and the take-back; no swap leg',
     names(sats.rows) === 'Added + ₿ 4900, Paid - ₿ 300, Added + ₿ 10000, Withdrawn - ₿ 700', names(sats.rows));
  ok('the card’s DOLLARS tab: the swap’s first tap, what came off the card, and not the swap’s dollars again', names(usd.rows) === 'Withdrawn - $5.10', names(usd.rows));
  ok('one $5 swap reads once in the card’s list: no "Swapped" row beside its taps', !sats.rows.concat(usd.rows).some((r) => /Swapped/.test(r.name)), names(sats.rows.concat(usd.rows)));
  ok('a card’s list has no wallet balance on it', sats.rows.every((r) => r.balText === '') && usd.rows.every((r) => r.balText === ''),
     JSON.stringify(sats.rows.map((r) => r.balText)));
  ok('a till’s receipt of a stranger’s card is not in my card’s list', !sats.rows.some((r) => r.amtText.indexOf('2000') >= 0), names(sats.rows));
  // the legs an earlier build wrote, naming the card: home's still, and never the card's
  const old = [{ label: 'TODAY', items: rows.map((t) => (t.kind === 'swap' ? Object.assign({}, t, { card: KEY }) : t)) }];
  ok('a swap leg that names the card (an earlier build’s) is in home’s list and not in the card’s',
     view(false, 'sat', old).rows.filter((r) => r.name === 'swap').length === 2 && !view(true, 'sat', old).rows.concat(view(true, 'usd', old).rows).some((r) => /Swapped|swap/.test(r.name)),
     names(view(false, 'sat', old).rows) + ' / ' + names(view(true, 'sat', old).rows));
  global.window = { FoxyWallet: { heldSats: () => 0 } };
  ok('with no word from the wallet about cards, home hides only what a card paid from its own screen', view(false).rows.length === 8, names(view(false).rows));
}

console.log('\n7. a card restored before its date: pending in home’s history, and in no balance');
{
  /* RESTORE before the card's date (26f-flashcard.js `fcRestoreAsk`, kept; RESTORE CARD does not offer it now) puts a row in home's history
   * (`fcRestoreRows`, read in by `loadHistory`): "Restoring <the card's name, or card>", what it held in the amount column,
   * dollars first, with UNLOCKS IN 28D on the standing line (`fcUnlockWords`: days rounded up, then hours, then minutes, then UNLOCKING), no
   * running balance, and the books stepping over it. It opens the restore's own card (`fcRestorePending`: CANCEL RESTORE). */
  const a = lift(['renderHistory(c) {', 'histAudit() {', 'fcRestoreRows(here) {', 'fcUnlockWords(date) {', 'fcPrice(n, unit) {', 'fcSats(n, unit) {',
                  'fcAmt(x) {', 'fcUnitOf(x) {', 'txLabel(d, now) {', 'txStamp(d, now) {', 'txDay(d, now) {', 'txClock(d) {']);
  global.CTA_INK = () => '#fff';
  const KEY = '02lost', DOLLAR = '02dollar';
  const now = Math.floor(Date.now() / 1000);
  let restores = [
    { key: KEY, name: 'Lunch money', mint: 'https://m.test', unit: 'sat', amount: 20000, sats: 20000, date: now + 28 * 86400 - 600, asked: now - 2 * 86400 },
    { key: DOLLAR, name: '', mint: 'https://m.test/', unit: 'usd', amount: 1250, sats: 0, date: now + 3 * 3600 - 60, asked: now - 60 },
    { key: '02elsewhere', name: '', mint: 'https://n.test', unit: 'sat', amount: 5, sats: 5, date: now + 600, asked: now },
  ];
  global.window = { __foxyClock24: false, FoxyWallet: { cardSession: () => {}, cardKnownHere: (k) => k === KEY || k === DOLLAR, heldSats: () => 0,
    cardRestores: () => restores, cardName: (k) => (restores.filter((r) => r.key === k)[0] || {}).name || '' } };
  const opened = [];
  Object.assign(a, {
    fcW: () => global.window.FoxyWallet, px: () => 60000, usd: (v) => v.toFixed(2), group: (n) => String(n),
    histAuditIn: function () { return this.histAudit(); }, histAuditUsd: function () { return this.histAudit(); },
    stageMoney: (n) => '₿ ' + n, money: (n) => ({ main: '₿ ' + n, sub: '' }), txFiat: () => 0,
    txTotalOut: (t) => (t.sats || 0) + (t.fee || 0), topUpFeeSats: () => 0, recoveringSats: () => 0,
    unitMoney: (n, u) => (u === 'usd' ? '$' + (n / 100).toFixed(2) : String(n)), unitLabel: (u) => u,
    unitFigure: (n, u) => (u === 'usd' ? '$' + (n / 100).toFixed(2) : '₿ ' + n), unitWord: (u) => (u === 'usd' ? 'DOLLARS' : 'BITCOIN'),
    homePills: () => ['usd', 'sat'], segLook: () => ({}), twoUnitsOn: () => false,
    openTx: () => {}, openPendingSplit: () => {}, fcRestorePending: (k) => opened.push(k), goSwitchMint: () => {}, go: () => {}, setState: () => {}, histRef: () => {},
  });
  const pend = a.fcRestoreRows('https://m.test');
  ok('one row for each restore waiting at this mint, and none for another mint’s', pend.length === 2 && pend.every((r) => r.pending && r.dir === 'in' && !r.card),
     JSON.stringify(pend.map((r) => r.name)));
  const paid = { hash: 'h1', time: '9:22 AM', fee: 0, card: '', fromCard: '', name: 'alice@example.com', memo: 'lunch', dir: 'in', sats: 50000, changeSats: 0, changeState: '' };
  const s = { screen: 'history', stack: ['home'], histFilter: 'all', history: [{ label: 'TODAY', items: pend.concat([paid]) }], historyComplete: true, balSats: 50000 };
  a.state = s;
  const v = a.renderHistory({ s, sc: 'history' });
  const rows = [].concat(...v.historyGroups.map((g) => g.items));
  const lunch = rows.filter((r) => /^Restoring Lunch money/.test(r.name))[0] || {};
  const dollars = rows.filter((r) => /^Restoring card/.test(r.name))[0] || {};
  ok('the row names the card only: "Restoring Lunch money"', lunch.name === 'Restoring Lunch money', lunch.name);
  ok('what comes back stands in the amount column, dollars first, as every row’s figure does', /^\+\s?\$\s?12\.00$/.test(lunch.amtText || ''), lunch.amtText);
  ok('the standing line says when it unlocks instead of "Pending": UNLOCKS IN 28D (days rounded up)', lunch.line2 === 'UNLOCKS IN 28D', lunch.line2);
  ok('in the pending amber, with no running balance', lunch.amtColor === 'var(--btc-ink)' && lunch.line2Color === 'var(--btc-ink)'
     && lunch.tileBg === 'var(--btc-ink)' && lunch.balText === '', JSON.stringify([lunch.amtColor, lunch.line2Color, lunch.balText]));
  ok('a card with no name is "card"; a dollar card’s figure in its dollars with nothing under it, under a day in hours',
     dollars.name === 'Restoring card' && /^\+\s?\$\s?12\.50$/.test(dollars.amtText || '') && dollars.amtSub === '' && dollars.line2 === 'UNLOCKS IN 3H',
     dollars.name + ' / ' + dollars.amtText + ' / ' + dollars.amtSub + ' / ' + dollars.line2);
  ok('home keeps the rows: they name no card on file, so they are not left to a card’s list', rows.length === 3, rows.map((r) => r.name).join(', '));
  ok('and the books step over them: in no balance, the history still ADDS UP', v.histAuditTitle === 'ADDS UP', v.histAuditTitle + ' / ' + v.histAuditBody);
  lunch.open();
  ok('the row opens the restore’s own card, with CANCEL RESTORE', opened.join() === KEY, opened.join());
  ok('under an hour in minutes, and UNLOCKING once its date has come',
     a.fcUnlockWords(now + 9 * 60 - 5) === 'UNLOCKS IN 9M' && a.fcUnlockWords(now + 86400 + 1) === 'UNLOCKS IN 2D' && a.fcUnlockWords(now - 1) === 'UNLOCKING',
     [a.fcUnlockWords(now + 9 * 60 - 5), a.fcUnlockWords(now + 86400 + 1), a.fcUnlockWords(now - 1)].join(', '));
  ok('the history read from the wallet puts them at the top, as a bill being collected', /this\.fcRestoreRows\(here\)\.forEach\(r => buckets\.TODAY\.unshift\(r\)\)/.test(method('loadHistory() {')));
  restores = [];
  ok('cancelled or taken back, the row is gone', a.fcRestoreRows('https://m.test').length === 0);
}

console.log(R.fail ? '\n' + R.fail + ' history-notes check(s) failed, ' + R.pass + ' passed' : '\nall ' + R.pass + ' history-notes checks pass');
process.exit(R.fail ? 1 : 0);
