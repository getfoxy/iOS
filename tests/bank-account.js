'use strict';
/* bank-account.js — SEND > BANK ACCOUNT: the Foxy balance to the person's own account at Strike, River or Cash App.
 *
 *     node tests/bank-account.js
 *
 *   1. the wallet (build/wallet/08f-bank.js), against a stand-in for the exchanges' address servers behind the phone's
 *      bridge: a username cleaned, looked up at strike.me over the Tor road (found, not found, no answer,
 *      asked again on a fresh circuit), what is kept, and the LNURL-pay a payment to that address goes through
 *      (`lookupLnurl`: min and max, the amount the callback is asked, the invoice's amount, a failure);
 *   2. the screens, lifted out of build/foxy-app.js: SEND's tile, the list, ALREADY HAVE AN ACCOUNT?, the username
 *      screen and its lookup, River's paste with and without an amount, SET AMOUNT, the remembered shortcut and CHANGE
 *      EXCHANGE, the sent screen's words and button, and the history row. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('./harness');

const ROOT = path.join(__dirname, '..');
let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const CASH_Q = 'Open Cash App, tap Money, then Bitcoin, then Receive, turn on Lightning, copy the invoice, then come back and paste it here.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e || new Error('rejected with nothing'); } };

/* An exchange's address server behind the phone's bridge. `answer(url, n)` is what the n-th asking of that url gets, as
 * the text the bridge hands back ('200\n<json>'), or 'hang' for one never answered. Every asking is kept, with the
 * circuit it asked to leave on. */
const reply200 = (j) => '200\n' + JSON.stringify(j);
function exchangeCtx(answer, route) {
  const asked = [];
  const ctx = load({ bridge: (w, m) => {
    if (m.action !== 'mintRequest') return;
    asked.push({ url: m.url, circuit: m.circuit });
    const n = asked.filter((a) => a.url === m.url).length;
    const got = answer(m.url, n);
    if (got === 'hang') return;
    setTimeout(() => w.FoxyWallet._scanResult(m.id, got, null), 0);
  } });
  if (route) ctx.W._privacy(route);
  ctx.W._askAgainMs = 30;
  return { W: ctx.W, ctx, asked };
}
// an invoice-shaped string with a description hash (tests/run.js `invoiceFor`): its amount in the prefix, its h the metadata's
function invoiceFor(prefix, text) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest();
  const words = [];
  let acc = 0, bits = 0;
  for (const b of hash) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const data = [0, 0, 0, 0, 0, 0, 0, 23, 1, 20].concat(words, new Array(104).fill(0));
  return prefix + data.map((v) => CHARSET[v]).join('') + 'qqqqqq';
}
const META = '[["text/plain","Pay alice on Strike"]]';
const RECORD = (over) => reply200(Object.assign({ tag: 'payRequest', callback: 'https://strike.me/cb/alice', minSendable: 1000, maxSendable: 100000000000, metadata: META }, over || {}));
const isWell = (u) => /\/\.well-known\/lnurlp\//.test(u);

const src = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(at + 3, i + 1);
}

async function run() {
  // ---- 1. the wallet -----------------------------------------------------------------------------------------------
  console.log('1. the wallet: usernames, the lookup, what is kept, and the LNURL-pay');
  {
    const { W } = exchangeCtx(() => 'hang');
    const names = W.bankExchanges().map((x) => x.key + ':' + x.domain + ':' + x.by);
    ok(names.join(' ') === 'strike:strike.me:address river:river.com:invoice cashapp:cash.app:invoice', 'three exchanges, in the list’s order', names.join(' '));
    ok(W.bankUser('strike', ' Alice ') === 'alice' && W.bankUser('strike', 'alice@strike.me') === 'alice' && W.bankUser('strike', 'ALICE@STRIKE.ME') === 'alice',
       'a Strike username: as typed, lower case, its domain taken off', [W.bankUser('strike', ' Alice '), W.bankUser('strike', 'alice@strike.me')].join(','));
    ok(W.bankUser('strike', 'alice@cash.app') === '' && W.bankUser('strike', 'al ice') === '' && W.bankUser('strike', '') === '' && W.bankUser('river', 'alice') === '' && W.bankUser('cashapp', '$alice') === '',
       'a name at another domain, with a space, empty, or for River, is no username');
  }
  {
    const t = exchangeCtx((u) => (u === 'https://strike.me/.well-known/lnurlp/alice' ? RECORD() : '404\n{}'));
    const r = await t.W.bankLookup('strike', 'Alice');
    ok(r.state === 'found' && r.addr === 'alice@strike.me' && r.user === 'alice' && r.min === 1 && r.max === 100000000,
       'Strike: a payment record at strike.me/.well-known/lnurlp/alice is the account found, with its min and max in sats', JSON.stringify(r));
    ok(t.asked.length === 1 && t.asked[0].url === 'https://strike.me/.well-known/lnurlp/alice', 'asked once, at that address, through the phone', JSON.stringify(t.asked));
    const miss = await t.W.bankLookup('strike', 'bob');
    ok(miss.state === 'missing' && miss.addr === 'bob@strike.me', 'Strike: a 404 is no account by that name', JSON.stringify(miss));
  }
  {
    const t = exchangeCtx(() => reply200({ status: 'ERROR', reason: 'Not found' }));
    const r = await t.W.bankLookup('strike', 'carol');
    ok(r.state === 'missing', 'Strike: an answer that is not a payment record is no account either', JSON.stringify(r));
  }
  {
    // two circuits that never carry it, then an answer: asked again on circuits of their own, as an address's lookup is
    const t = exchangeCtx((u, n) => (n <= 2 ? 'hang' : RECORD()));
    const r = await t.W.bankLookup('strike', 'alice');
    const circuits = t.asked.map((a) => a.circuit);
    ok(r.state === 'found' && t.asked.length === 3 && circuits[0] === '' && !!circuits[1] && !!circuits[2] && circuits[1] !== circuits[2],
       'a lookup that goes unanswered is asked again, each time on a fresh circuit', JSON.stringify(circuits));
  }
  {
    const t = exchangeCtx(() => 'hang');
    t.W._reachMs = 300;
    const e = await threw(() => t.W.bankLookup('strike', 'alice'));
    ok(!!e && /did not answer/.test(e.message), 'Strike: no answer at all is not an answer: the lookup fails, to be tried again', e && e.message);
  }
  {
    const t = exchangeCtx(() => RECORD());
    const e = await threw(() => t.W.bankLookup('strike', 'not a name'));
    ok(!!e && /not a Strike username/.test(e.message) && t.asked.length === 0, 'a name that is not one is refused before anything is asked', e && e.message);
    const r = await threw(() => t.W.bankLookup('river', 'alice'));
    ok(!!r && t.asked.length === 0, 'River has no username to look up');
    const c = await threw(() => t.W.bankLookup('cashapp', 'alice'));
    ok(!!c && t.asked.length === 0, 'Cash App has no username to look up either: nothing is asked at cash.app');
  }
  {
    const dark = exchangeCtx(() => RECORD(), { tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'none' });
    dark.W.setOffline(true);
    const e = await threw(() => dark.W.bankLookup('strike', 'alice'));
    ok(!!e && dark.asked.length === 0, 'working offline, the lookup asks nothing', e && e.message);
  }
  {
    const { W, ctx } = exchangeCtx(() => 'hang');
    ok(W.bankSaved() === null, 'nothing is kept to start with');
    ok(W.bankSave('strike', 'Alice@strike.me') === true, 'a Strike username is kept');
    const s = W.bankSaved();
    ok(s && s.ex === 'strike' && s.user === 'alice' && s.addr === 'alice@strike.me', 'and read back as its address', JSON.stringify(s));
    const raw = JSON.parse(ctx.storage.getItem('foxy.bank'));
    ok(raw.ex === 'strike' && raw.user === 'alice' && !raw.pr && Object.keys(raw).sort().join() === 'at,ex,user', 'foxy.bank holds the exchange and the name, and nothing else', JSON.stringify(raw));
    W.bankSave('river');
    const r = W.bankSaved();
    ok(r && r.ex === 'river' && !r.addr, 'River: only the choice is kept', JSON.stringify(r));
    W.bankSave('cashapp');
    const c = W.bankSaved();
    ok(c && c.ex === 'cashapp' && !c.addr && Object.keys(JSON.parse(ctx.storage.getItem('foxy.bank'))).sort().join() === 'at,ex', 'Cash App: only the choice is kept', JSON.stringify(c));
    ctx.storage.setItem('foxy.bank', JSON.stringify({ ex: 'cashapp', user: 'alice' }));
    const old = W.bankSaved();
    ok(old && old.ex === 'cashapp' && !old.addr, 'a cashtag kept by an earlier version reads as Cash App kept, with no address', JSON.stringify(old));
    ctx.storage.setItem('foxy.bank', JSON.stringify({ ex: 'strike', user: 'bad name' }));
    ok(W.bankSaved() === null, 'what no longer reads as a username is nothing kept');
    W.bankForget();
    ok(ctx.storage.getItem('foxy.bank') === null, 'and FORGET takes it away');
  }
  {
    // the payment: the address's LNURL-pay, as any Lightning address is paid (`lookupLnurl`)
    const t = exchangeCtx((u) => (isWell(u) ? RECORD({ minSendable: 5000, maxSendable: 50000 })
      : /cb\/alice\?amount=10000$/.test(u) ? reply200({ pr: invoiceFor('lnbc100n1', META) })
      : /cb\/alice\?amount=20000$/.test(u) ? reply200({ pr: invoiceFor('lnbc300n1', META) })
      : /cb\/alice\?amount=30000$/.test(u) ? reply200({ status: 'ERROR', reason: 'Strike is not taking payments right now' })
      : '404\n{}'));
    const found = await t.W.lookupLnurl('alice@strike.me', 10);
    const cb = t.asked.find((a) => /\/cb\//.test(a.url));
    ok(found && found.pr === invoiceFor('lnbc100n1', META) && found.addr === 'alice@strike.me' && found.sats === 10,
       'LNURL-pay: the record fetched, the callback asked, the invoice it gave', JSON.stringify(found));
    ok(cb && /amount=10000$/.test(cb.url) && t.asked[0].url === 'https://strike.me/.well-known/lnurlp/alice', 'the callback is asked in millisats', cb && cb.url);
    const low = await threw(() => t.W.lookupLnurl('alice@strike.me', 4));
    ok(!!low && /at least 5 sats/.test(low.message), 'less than the address takes is refused before its callback is asked', low && low.message);
    const high = await threw(() => t.W.lookupLnurl('alice@strike.me', 51));
    ok(!!high && /at most 50 sats/.test(high.message), 'and more than it takes', high && high.message);
    const wrong = await threw(() => t.W.lookupLnurl('alice@strike.me', 20));
    ok(!!wrong && /asked for 30 sats instead of 20\. Not paying it/.test(wrong.message), 'an invoice for another amount than asked is not paid', wrong && wrong.message);
    const refused = await threw(() => t.W.lookupLnurl('alice@strike.me', 30));
    ok(!!refused && /not taking payments/.test(refused.message), 'a callback that answers with no invoice says the exchange’s own reason', refused && refused.message);
  }

  // ---- 2. the screens ----------------------------------------------------------------------------------------------
  console.log('\n2. the screens');
  global.CTA_INK = () => '#050505';
  const SIGS = ['bankName(ex) {', 'bankByInvoice(ex) {', 'bankOwn() {', 'bankNow() {', 'bankStart() {', 'bankList() {', 'bankRows() {', 'bankPick(ex) {', 'bankHaveAsk(ex) {',
    'bankNoAccount(ex) {', 'bankAskOpen(ex, short) {', 'bankType(e) {', 'bankGo() {', 'bankCheck(pasted) {', 'bankPasted(text) {',
    'bankAmount(ex, addr, short) {', 'bankChange() {', 'bankAmountQuestion() {', 'bankDoneSays(ex) {', 'renderBank(c) {', 'bankShortHere() {',
    'goSwitchMint(extra) {'];
  const make = (o) => {
    const opt = o || {};
    const store = { kept: opt.kept || null };
    const said = { opened: [], looked: [], accepted: [], cards: [], toasts: [] };
    global.window = { FoxyWallet: {
      bankExchanges: () => [{ key: 'strike', name: 'Strike', domain: 'strike.me', by: 'address' }, { key: 'river', name: 'River', domain: 'river.com', by: 'invoice' },
        { key: 'cashapp', name: 'Cash App', domain: 'cash.app', by: 'invoice' }],
      bankUser: (ex, raw) => {
        const d = { strike: 'strike.me' }[ex];
        if (!d) return '';
        let t = String(raw || '').trim().replace(/^[$@]+/, '');
        if (t.indexOf('@') >= 0) { if (t.split('@')[1].toLowerCase() !== d) return ''; t = t.split('@')[0]; }
        return /^[a-z0-9._-]+$/i.test(t) ? t.toLowerCase() : '';
      },
      bankLookup: (ex, raw) => { said.looked.push([ex, raw]); return opt.lookup ? opt.lookup(ex, raw) : new Promise(() => {}); },
      bankSaved: () => store.kept,
      bankSave: (ex, user) => { store.kept = ex !== 'strike' ? { ex } : { ex, user, addr: user + '@' + (ex === 'strike' ? 'strike.me' : 'cash.app') }; return true; },
      bankOpen: (ex) => { said.opened.push(ex); return Promise.resolve(); },
      classify: (t) => (/^lnbc/i.test(t) ? 'invoice' : /@/.test(t) ? 'lnurl' : 'unknown'),
      reason: (e) => String((e && e.message) || e),
    } };
    const a = new Function('return {' + SIGS.map(method).join(',\n') + '}')();
    Object.assign(a, {
      said, store,
      BANK_NAMES: { strike: 'Strike', river: 'River', cashapp: 'Cash App' },
      state: Object.assign({ screen: 'sendHow', stack: ['home'] }, opt.state || {}),
      setState(x) { Object.assign(this.state, typeof x === 'function' ? x(this.state) : x); },
      toast(m) { said.toasts.push(m); },
      blockedCard(kind, spec) { said.cards.push(Object.assign({ kind }, spec)); },
      offlineNow: () => !!opt.offline,
      offlineNo(what) { said.toasts.push(what + ' needs a connection.'); },
      acceptTarget(t) {
        said.accepted.push(t);
        // as the real one does with an invoice: its own amount to the confirmation, none to SET AMOUNT
        const amt = /^lnbc\d/.test(t) && !/^lnbc1p/.test(t);
        this.setState((p) => ({ screen: amt ? 'sendConfirm' : 'amount', stack: p.stack.concat([p.screen]), flow: 'send', recipientKind: 'invoice', recipient: t }));
        return true;
      },
      shortId: (v) => (v.length > 14 ? v.slice(0, 5) + '…' + v.slice(-5) : v),
    });
    return a;
  };
  const vals = (a) => a.renderBank({ s: a.state, sc: a.state.screen });

  {
    // SEND's tile
    const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
    const tile = markup.indexOf('sc-camel-on-click="{{ goBank }}"');
    ok(tile > 0 && markup.indexOf('>BANK ACCOUNT</div>', tile) > tile && markup.indexOf('{{ clBankOn }}') > 0, 'SEND has a BANK ACCOUNT tile, after FOXY CARD');
    const send = method('renderSend(c) {');
    ok(/clBankOn: !cardOut/.test(send) && /goBank: \(\) => this\.bankStart\(\)/.test(send) && /clBankDim: off \? '0\.38' : '1'/.test(send),
       'not when paying from a card, dimmed offline, and it opens BANK ACCOUNT');
  }
  {
    // nothing kept: the list
    const a = make();
    a.bankStart();
    ok(a.state.screen === 'switchMint' && a.state.bankPick === true && a.state.stack.join() === 'home,sendHow', 'BANK ACCOUNT with nothing kept opens the list', JSON.stringify(a.state));
    const rows = a.bankRows();
    ok(rows.map((r) => r.name).join(',') === 'STRIKE,RIVER,CASH APP' && rows.map((r) => r.host).join(',') === 'strike.me,river.com,cash.app',
       'its rows: STRIKE, RIVER, CASH APP, each with its site under it', rows.map((r) => r.name + ' ' + r.host).join(' | '));
    ok(rows.every((r) => r.logo === undefined && !/gd-|\.jpg/.test(JSON.stringify(rows))), 'no company’s picture or mark on any row');
    ok(rows.every((r) => r.big === r.name && r.nameSize === '38px' && r.radius === '28px' && r.notHere && !r.here && r.edge === '1px'),
       'drawn as the mint list’s tiles: the name large, no tick on any when none is kept');
    ok(!fs.existsSync(path.join(ROOT, 'Web/gd-river.jpg')) && !fs.existsSync(path.join(ROOT, 'Web/gd-strike.jpg'))
       && !fs.existsSync(path.join(ROOT, 'Web/gd-cashapp.jpg')) && !fs.existsSync(path.join(ROOT, 'Web/gd-flash.jpg')), 'the company pictures are not in the bundle');
    const mints = method('renderMints(c) {');
    ok(/const tiles = !L;/.test(mints), 'the exchanges are drawn as tiles, not the plain rows');
    ok(/s\.bankPick \? 'BANK ACCOUNT'/.test(mints) && /'Trade your Foxy balance for dollars with one of these exchanges\.'/.test(mints)
       && /if \(s\.bankPick\) return this\.bankRows/.test(mints) && /mintPickers: [^\n]*&& !s\.bankPick,/.test(mints),
       'the list is titled BANK ACCOUNT, says what it is for, and offers no mint to add');
    ok(/bankPick: false/.test(method('goSwitchMint(extra) {')), 'every other way into the list clears it');
  }
  {
    // Strike: ALREADY HAVE AN ACCOUNT?
    const a = make({ state: { screen: 'switchMint', stack: ['home', 'sendHow'], bankPick: true } });
    a.bankRows()[0].tap();
    const card = a.said.cards[0];
    ok(card && card.kind === 'bankHave' && card.title === 'ALREADY HAVE AN ACCOUNT WITH STRIKE?' && card.retry === 'YES' && card.shut.label === 'NO' && card.tone === 'ask',
       'STRIKE asks ALREADY HAVE AN ACCOUNT WITH STRIKE? YES / NO', JSON.stringify(card));
    card.shut.tap();
    await wait(0);
    ok(a.said.opened.join() === 'strike' && /Make an account with Strike/.test(a.said.toasts[0]), 'NO opens Strike’s site', JSON.stringify(a.said));
    card.go();
    ok(a.state.screen === 'bankAsk' && a.state.bankEx === 'strike' && !a.state.bankShort, 'YES asks the username', JSON.stringify(a.state));
    const v = vals(a);
    ok(v.isBankAsk && v.bkTitle === 'STRIKE' && v.bkQuestion === 'What is your Strike username?' && v.bkLabel === 'STRIKE USERNAME' && v.bkDomain === '@strike.me',
       'the screen: STRIKE, What is your Strike username?, the field with @strike.me after it', JSON.stringify([v.bkTitle, v.bkQuestion, v.bkLabel, v.bkDomain]));
    ok(v.bkCta === 'CHECK' && v.bkBg !== 'var(--acc)' && v.bkByName && !v.bkChangeShown, 'CHECK, grey until a name is typed');
    a.bankType({ target: { value: 'Alice' } });
    ok(vals(a).bkBg === 'var(--acc)', 'typed, it lights');
    const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
    const block = markup.slice(markup.indexOf('{{ isBankAsk }}'), markup.indexOf('</sc-if>\n\n<!-- NAME CARD'));
    ok(/data-foxy-paste="1"[^>]*>PASTE<\/div>/.test(block) && /\{\{ bkDomain \}\}/.test(block) && /autocapitalize="off"/.test(block),
       'and PASTE is the app’s paste button (Apple’s laid over it), the domain after the field, no capitals forced');
  }
  {
    // the lookup: found
    let answer;
    const a = make({ state: { screen: 'bankAsk', stack: ['home', 'sendHow', 'switchMint'], bankEx: 'strike', bankDraft: 'Alice' },
      lookup: () => new Promise((r) => { answer = r; }) });
    a.bankGo();
    ok(a.said.looked.length === 1 && a.said.looked[0][1] === 'Alice' && a.state.bankLook.state === 'checking', 'CHECK looks the name up', JSON.stringify(a.said.looked));
    let v = vals(a);
    ok(v.bkCta === 'CHECKING…' && v.bkStatus === 'Checking with Strike…', 'CHECKING… while it is asked', v.bkCta + ' / ' + v.bkStatus);
    a.bankGo();
    ok(a.said.looked.length === 1, 'and pressed again meanwhile, nothing more is asked');
    answer({ state: 'found', ex: 'strike', user: 'alice', addr: 'alice@strike.me', min: 1, max: 1000000 });
    await wait(0);
    v = vals(a);
    ok(v.bkStatus === 'alice@strike.me — found' && v.bkCta === 'NEXT' && v.bkStatusInk === 'var(--acc-ink)', 'found: "alice@strike.me — found", and NEXT', v.bkStatus);
    ok(a.store.kept && a.store.kept.ex === 'strike' && a.store.kept.user === 'alice', 'a name found is kept', JSON.stringify(a.store.kept));
    a.bankGo();
    ok(a.state.screen === 'amount' && a.state.flow === 'send' && a.state.recipientKind === 'email' && a.state.recipient === 'alice@strike.me' && a.state.unit === 'USD',
       'NEXT: SET AMOUNT for alice@strike.me, in dollars first', JSON.stringify(a.state));
    ok(a.bankNow() === 'strike' && a.bankAmountQuestion() === 'How much to send to your Strike account?' && !a.bankShortHere(),
       'it asks "How much to send to your Strike account?", with no CHANGE EXCHANGE (the list was just used)');
    a.bankType({ target: { value: 'alicex' } });
    ok(vals(a).bkCta === 'CHECK', 'a name changed after it was found is checked again');
  }
  {
    // not found, and no answer
    const a = make({ state: { screen: 'bankAsk', stack: [], bankEx: 'strike', bankDraft: 'bob' },
      lookup: () => Promise.resolve({ state: 'missing', ex: 'strike', user: 'bob', addr: 'bob@strike.me' }) });
    a.bankGo();
    await wait(0);
    const v = vals(a);
    ok(v.bkStatus === 'bob@strike.me — not found, check the spelling' && v.bkCta === 'CHECK' && v.bkStatusInk === '#FF5C5C' && !a.store.kept,
       'not found: "bob@strike.me — not found, check the spelling", nothing kept, CHECK again', v.bkStatus);
    const b = make({ state: { screen: 'bankAsk', stack: [], bankEx: 'strike', bankDraft: 'bob' }, lookup: () => Promise.reject(new Error('that address did not answer within 45s.')) });
    b.bankGo();
    await wait(0);
    ok(vals(b).bkStatus === 'Could not reach Strike to check it. Try again.' && vals(b).bkCta === 'CHECK' && !b.store.kept, 'no answer: said, and CHECK again', vals(b).bkStatus);
    const c = make({ state: { screen: 'bankAsk', stack: [], bankEx: 'strike', bankDraft: 'al ice' } });
    c.bankGo();
    ok(vals(c).bkStatus === 'That is not a Strike username.' && c.said.looked.length === 0, 'a name that is not one is said so, and nothing asked', vals(c).bkStatus);
    const d = make({ offline: true, state: { screen: 'bankAsk', stack: [], bankEx: 'strike', bankDraft: 'alice' } });
    d.bankGo();
    ok(d.said.looked.length === 0 && /needs a connection/.test(d.said.toasts[0]), 'offline: nothing asked, and said why', JSON.stringify(d.said.toasts));
  }
  {
    // Cash App: as River, no username and no question first, an invoice pasted
    const a = make({ state: { screen: 'switchMint', stack: ['home', 'sendHow'], bankPick: true } });
    a.bankRows()[2].tap();
    ok(a.state.screen === 'bankAsk' && a.state.bankEx === 'cashapp' && !a.said.cards.length, 'CASH APP asks no question first: its paste screen', JSON.stringify([a.state.screen, a.state.bankEx, a.said.cards.length]));
    let v = vals(a);
    ok(v.bkTitle === 'CASH APP' && v.bkQuestion === CASH_Q && !v.bkByName && v.bkCta === 'OPEN CASH APP' && v.bkDomain === '',
       'CASH APP: what to do in Cash App, OPEN CASH APP, PASTE, no field and no domain', JSON.stringify([v.bkQuestion, v.bkCta, v.bkDomain]));
    a.bankGo();
    await wait(0);
    ok(a.said.opened.join() === 'cashapp' && a.said.looked.length === 0, 'OPEN CASH APP opens Cash App and looks nothing up');
    a.bankPasted('$alice');
    v = vals(a);
    ok(v.bkStatus === 'That is not a Lightning invoice. In Cash App, copy the Lightning invoice, then paste it here.' && !a.said.accepted.length && !a.store.kept && a.said.looked.length === 0,
       'a cashtag or anything that is no invoice is refused with Cash App’s words, nothing looked up or kept', v.bkStatus);
    a.bankPasted('lightning:lnbc2500n1pinvoicecash');
    ok(a.said.accepted[0] === 'lnbc2500n1pinvoicecash' && a.state.screen === 'sendConfirm' && a.bankNow() === 'cashapp',
       'an invoice goes to the confirmation, as any pasted invoice, marked as Cash App’s', JSON.stringify(a.state));
    ok(a.store.kept && a.store.kept.ex === 'cashapp' && !a.store.kept.addr, 'and Cash App is kept as the choice, not the invoice', JSON.stringify(a.store.kept));
    const b = make({ state: { screen: 'bankAsk', stack: ['home', 'sendHow'], bankEx: 'cashapp' } });
    b.bankPasted('lnbc1pnoamountcash');
    ok(b.state.screen === 'amount' && b.bankAmountQuestion() === 'How much to send to your Cash App account?', 'an invoice with no amount: SET AMOUNT, asking how much to send to Cash App');
    const k = make({ kept: { ex: 'cashapp' } });
    k.bankStart();
    ok(k.state.screen === 'bankAsk' && k.state.bankEx === 'cashapp' && vals(k).bkChangeShown, 'Cash App kept: BANK ACCOUNT goes to its paste screen, with CHANGE EXCHANGE');
    k.bankChange();
    ok(k.state.screen === 'switchMint' && k.state.bankPick === true && !k.state.bankShort, 'CHANGE EXCHANGE: the list again');
    ok(k.bankRows().map((r) => r.name).join() === 'STRIKE,RIVER,CASH APP', 'which lists the three');
  }
  {
    // River: paste an invoice with an amount, and one with none
    const a = make({ state: { screen: 'switchMint', stack: ['home', 'sendHow'], bankPick: true } });
    a.bankRows()[1].tap();
    ok(a.state.screen === 'bankAsk' && a.state.bankEx === 'river' && !a.said.cards.length, 'RIVER asks no question first: its own screen');
    let v = vals(a);
    ok(v.bkTitle === 'RIVER' && v.bkQuestion === 'Open River, choose Receive bitcoin, Use Lightning, copy the invoice, then come back and paste it here.'
       && !v.bkByName && v.bkCta === 'OPEN RIVER', 'RIVER: what to do in River, OPEN RIVER, PASTE, and no field', JSON.stringify([v.bkQuestion, v.bkCta]));
    a.bankGo();
    await wait(0);
    ok(a.said.opened.join() === 'river', 'OPEN RIVER opens River');
    a.bankPasted('alice@strike.me');
    v = vals(a);
    ok(v.bkStatus === 'That is not a Lightning invoice. In River, copy the Lightning invoice, then paste it here.' && !a.said.accepted.length && !a.store.kept,
       'what is not an invoice is said so, and nothing goes', v.bkStatus);
    a.bankPasted('lightning:lnbc2500n1pinvoiceriver');
    ok(a.said.accepted[0] === 'lnbc2500n1pinvoiceriver' && a.state.screen === 'sendConfirm' && a.bankNow() === 'river',
       'an invoice with its amount: to the confirmation, as any pasted invoice', JSON.stringify(a.state));
    ok(a.store.kept && a.store.kept.ex === 'river' && !a.store.kept.addr, 'and River is kept as the choice, not the invoice', JSON.stringify(a.store.kept));
    const b = make({ state: { screen: 'bankAsk', stack: ['home', 'sendHow'], bankEx: 'river' } });
    b.bankPasted('lnbc1pnoamountriver');
    ok(b.state.screen === 'amount' && b.state.recipient === 'lnbc1pnoamountriver' && b.bankNow() === 'river' && b.bankAmountQuestion() === 'How much to send to your River account?',
       'an invoice with no amount: SET AMOUNT, which asks how much to send to River', JSON.stringify(b.state));
  }
  {
    // remembered
    const a = make({ kept: { ex: 'strike', user: 'alice', addr: 'alice@strike.me' } });
    a.bankStart();
    ok(a.state.screen === 'amount' && a.state.recipient === 'alice@strike.me' && a.state.bankShort === true && a.bankShortHere(),
       'with Strike kept, BANK ACCOUNT goes straight to SET AMOUNT', JSON.stringify(a.state));
    const amt = method('renderAmount(c) {');
    ok(/this\.bankShortHere\(\)\) \? 'CHANGE EXCHANGE'/.test(amt) && /this\.bankShortHere\(\)\)\) this\.bankChange\(\);/.test(amt), 'with CHANGE EXCHANGE under NEXT');
    a.bankChange();
    ok(a.state.screen === 'switchMint' && a.state.bankPick === true && a.state.stack.slice(-1)[0] === 'amount', 'CHANGE EXCHANGE: the list again', JSON.stringify(a.state));
    const r = make({ kept: { ex: 'river' } });
    r.bankStart();
    ok(r.state.screen === 'bankAsk' && r.state.bankEx === 'river' && vals(r).bkChangeShown, 'River kept: its paste screen, with CHANGE EXCHANGE');
    const off = make({ offline: true, kept: { ex: 'strike', user: 'alice', addr: 'alice@strike.me' } });
    off.bankStart();
    ok(off.state.screen === 'sendHow' && /Sending to a bank account needs a connection/.test(off.said.toasts[0]), 'offline, BANK ACCOUNT says it needs a connection');
  }
  {
    // the sent screen
    const a = make({ state: { screen: 'sendDone', sendPhase: 'settled', recipient: 'alice@strike.me', recipientKind: 'email', bank: { ex: 'strike', to: 'alice@strike.me' } } });
    let v = vals(a);
    ok(v.sentBankShown && v.sentBankSays === 'Sent to your Strike account. In Strike, set Receive currency to Cash so it arrives as dollars.' && v.sentBankCta === 'OPEN STRIKE',
       'Strike, sent: what to set in Strike, and OPEN STRIKE', v.sentBankSays);
    v.sentBankGo();
    await wait(0);
    ok(a.said.opened.join() === 'strike', 'which opens Strike');
    a.state.recipient = 'lnbc1pcash'; a.state.bank = { ex: 'cashapp', to: 'lnbc1pcash' };
    v = vals(a);
    ok(v.sentBankSays === 'Sent to your Cash App. Turn on Receive Lightning as dollars in Cash App so it arrives as dollars. Cash App allows $999 over Lightning every 7 days and is not available in New York.'
       && v.sentBankCta === 'OPEN CASH APP', 'Cash App: the switch, the weekly limit and New York, and OPEN CASH APP', v.sentBankSays);
    a.state.recipient = 'lnbc1priver'; a.state.bank = { ex: 'river', to: 'lnbc1priver' };
    v = vals(a);
    ok(v.sentBankSays === 'Sent to your River account. Open River to withdraw it to your bank.' && v.sentBankCta === 'OPEN RIVER', 'River: withdraw it in River, and OPEN RIVER', v.sentBankSays);
    a.state.sendPhase = 'in';
    ok(!vals(a).sentBankShown, 'nothing of it while it is still sending');
    a.state.sendPhase = 'settled'; a.state.recipient = 'bob@example.com';
    ok(!vals(a).sentBankShown && a.bankNow() === '', 'nor for a payment to anyone else afterwards');
    const sent = method('renderSentBase(c) {');
    ok(/bank: null, bankShort: false/.test(sent) && /this\.bankOwn\(\)/.test(sent), 'DONE ends it, and an invoice made in River or Cash App is said as theirs');
    a.state.recipient = 'lnbc1priver'; a.state.bank = { ex: 'river', to: 'lnbc1priver' };
    ok(a.bankOwn() === 'YOUR RIVER ACCOUNT', 'River’s invoice: YOUR RIVER ACCOUNT', a.bankOwn());
    a.state.recipient = 'lnbc1pcash'; a.state.bank = { ex: 'cashapp', to: 'lnbc1pcash' };
    ok(a.bankOwn() === 'YOUR CASH APP ACCOUNT', 'Cash App’s invoice: YOUR CASH APP ACCOUNT', a.bankOwn());
  }
  {
    // the payment is marked, and history says whose it was
    const send = method('startSendNow(to, o) {');
    ok(/const bankEx = \(!card && this\.bankNow\) \? this\.bankNow\(\) : '';/.test(send) && /bankEx \? \{ bank: bankEx \} : \{\}/.test(send) && (send.match(/W\.tag\(r\.hash, tagFor\(\)\)/g) || []).length === 2,
       'a payment BANK ACCOUNT chose is tagged with its exchange, settled or pending');
    const hist = new Function('return {' + ['loadHistory() {', 'bankName(ex) {'].map(method).join(',\n') + '}')();
    const day = Math.floor(Date.now() / 1000);
    const tags = { h1: { to: 'alice@strike.me', bank: 'strike' }, h2: { to: 'lnbc1priver', bank: 'river' }, h3: { to: 'lnbc1pcash', bank: 'cashapp' }, h4: { to: 'bob@example.com' } };
    const remembered = [];
    global.window = { FoxyWallet: {
      connected: true, mintUrl: 'https://m.test',
      transactions: () => Promise.resolve(['h1', 'h2', 'h3', 'h4'].map((h) => ({ hash: h, dir: 'out', sats: 1000, feeSats: 2, at: day, settled: true, mint: 'https://m.test' }))),
      tagsFor: (h) => tags[h] || {}, remember: (who) => remembered.push(who), book: () => [],
    } };
    global.document = { hidden: false };
    Object.assign(hist, {
      BANK_NAMES: { strike: 'Strike', river: 'River', cashapp: 'Cash App' },
      state: { history: [] }, setState(x) { Object.assign(this.state, typeof x === 'function' ? x(this.state) : x); },
      txWhen: (t) => new Date(t.at * 1000), txLabel: () => '10:00', txStamp: () => 'Today, 10:00', txCardName: () => '', txWho: () => 'Sent',
      spSyncPaid() {}, refreshBalance() {}, hideStage() {}, txIsNew: () => false, splitCardEntries: () => [],
    });
    // anything else the list asks of the app answers nothing (a list where one is read)
    const histApp = new Proxy(hist, { get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && /^[a-z]/.test(k) ? (() => []) : undefined)) });
    try { histApp.loadHistory.call(histApp); } catch (e) { console.log('loadHistory threw: ' + (e && e.stack)); }
    await wait(10);
    const items = ((hist.state.history || [])[0] || { items: [] }).items;
    const by = (h) => items.find((i) => i.hash === h) || {};
    ok(by('h1').name === 'To Strike' && by('h2').name === 'To River' && by('h3').name === 'To Cash App' && by('h4').name === 'bob@example.com',
       'history: "To Strike", "To River", "To Cash App"; any other payment as before', items.map((i) => i.name).join(', '));
    ok(by('h1').party === 'To Strike' && by('h2').party === 'To River', 'and its detail says the same', by('h1').party + ' / ' + by('h2').party);
    ok(remembered.join() === 'bob@example.com', 'and an exchange’s address is not put in the contacts', remembered.join());
  }
  {
    // the paste button over the page, and the screen kinds
    const sp = method('syncPreview() {');
    ok(/sc === 'bankAsk' && !this\._blockedEl && !overlaid/.test(sp) && /this\.state\.screen === 'bankAsk' \? this\.bankPasted\(text\) : this\.acceptTarget\(text\)/.test(sp),
       'Apple’s paste button sits over BANK ACCOUNT’s PASTE too, and hands what it read to that screen');
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'STORAGE.md'), 'utf8');
    ok(/\| `foxy\.bank` \|/.test(md), 'foxy.bank is in STORAGE.md');
  }

  console.log('\n' + (failed ? failed + ' of ' + (passed + failed) + ' FAILED' : 'all ' + passed + ' bank-account checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
