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
 *      where there is.
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
  ok('a row with a note shows the note; one without shows what it showed', /name: \(t\.note && String\(t\.note\)\.trim\(\)\) \|\| t\.name,/.test(app));
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

console.log(R.fail ? '\n' + R.fail + ' history-notes check(s) failed, ' + R.pass + ' passed' : '\nall ' + R.pass + ' history-notes checks pass');
process.exit(R.fail ? 1 : 0);
