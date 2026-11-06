'use strict';
/* flashcard-gate.js — every flow that takes money off the keeper's own card, held to the keeper's yes as the phone holds it.
 *
 *     node tests/flashcard-gate.js            (--record writes tests/fixtures/card-gate-flows.json)
 *
 * The phone signs the card's limit lifted, and put back, only against a yes the keeper gave before the card was held up
 * (NativeSeedBridge.swift `cardOwnerAllows`). Here the screens (build/app/26f-flashcard.js) run against the real wallet and the
 * model of a card of 1.25, with the phone's rule modelled in tests/harness.js (`cardGate`) and fed the card's own answers as the
 * sheet carried them: WITHDRAW, RENEW, the backup's move to this phone, a per tap limit that recuts the money, the SWAP's first
 * tap, TRANSFER and RESET of a card with money. For each: one yes asked, naming the lift; no signature the rule refuses; the
 * money where it should be; and the card's limits as they were. With --record each flow's steps are written for FoxyTests to
 * replay through the Swift itself (CardGateReplayTests). */
const fs = require('fs');
const path = require('path');
const { funded, newCard, MINT2 } = require('./flashcard-kit');
const { cardGate } = require('./harness');
const { appOn, until, pad, settle, keyIn } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const PRICE = 100000;
const flows = [];

(async () => {
  const H = await funded({ second: true }, 40000);
  const a = appOn(H, { screen: 'home' });
  a.price = PRICE;
  a.offlineNow = () => false;
  const raised = [];
  const overs = [];
  a.blockedCard = (kind, over) => { raised.push(kind + ': ' + ((over && (over.title + ' ' + (over.reason || ''))) || '')); overs.push({ kind, over: over || {} }); };
  const lastOver = (kind) => { const x = overs.filter((o) => o.kind === kind).slice(-1)[0]; return x ? x.over : null; };

  const setUp = async (c, sats) => {
    c.tap();
    await H.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await H.W.cardAdd(c, { amount: sats, unit: 'sat', pin: '1234', price: PRICE });
    // a limit on one payment of 1,000 sats ($1.00 at this price)
    c.tap();
    await H.W.cardSetLimit(c, { sats: 1000, tap: true, price: PRICE });
  };
  const read = async (c) => {
    H.nfc = c;
    c.tap();
    a.setState({ fc: null, screen: 'flashcard', stack: ['home'] });
    a.fcRead();
    const good = await until('the card to be read', () => a.state.fc && a.state.fc.key === c.key && !(a._fcTaps > 0));
    if (!good) console.log('fc: ' + JSON.stringify(a.state.fc && { key: a.state.fc.key, check: a.state.fc.check }) + ' taps ' + a._fcTaps + ' screen ' + a.state.screen + ' ' + JSON.stringify(a.toasts));
    await settle();
  };
  /* One flow under a fresh model of the rule: `run` starts it, `done` says when it has ended. */
  const flow = async (name, c, run, done) => {
    const gate = cardGate();
    H.phone.gate = gate;
    H.phone.cardApprovals = [];
    const tapWas = c.state.tapLimit;
    H.nfc = c;
    c.tap();
    run();
    if (!(await until(name + ' to end', () => done() && !(a._fcTaps > 0)))) {
      console.log('  ' + name + ': screen ' + a.state.screen + ', toasts ' + JSON.stringify(a.toasts.slice(-3)) + ', cards ' + JSON.stringify(raised.slice(-2)));
    }
    await settle();
    const lifts = H.phone.cardApprovals.filter((m) => m.lift === true);
    ok(lifts.length === 1, name + ': one yes asked before the tap, naming the lift', JSON.stringify(H.phone.cardApprovals.map((m) => [m.label, m.lift])));
    ok(gate.declined.length === 0, name + ': nothing it asked the phone to sign was refused', gate.declined.join(' / '));
    ok(!gate.unwatched, name + ': every signature was asked inside a session the phone carried', String(gate.unwatched || 0));
    const lifted = gate.trace.some((x) => x.step === 'sign' && x.allowed && x.body.label === 'set-limit' && /^00000000/.test(x.body.value));
    ok(lifted, name + ': the card’s limit was lifted under that yes');
    flows.push({ flow: name, lifts: true, steps: gate.trace });
    return { gate, tapWas };
  };

  const c = newCard(H, undefined, { format: 4, software: 25 });
  await setUp(c, 6000);
  await read(c);
  ok(a.state.fc.tap && a.state.fc.tap.limited, 'a card of 1.25, this phone’s, with a limit on one payment', JSON.stringify(a.state.fc.tap));

  // WITHDRAW
  {
    const was = c.balance();
    const r = await flow('WITHDRAW', c, () => a.fcWithdrawRun(500, '1234'), () => c.balance() < was);
    ok(c.balance() <= was - 500 && c.state.tapLimit === r.tapWas, 'WITHDRAW: the money came off and the limit is back', c.balance() + ' / ' + c.state.tapLimit);
  }
  // RENEW
  {
    await read(c);
    const was = c.balance();
    let renewed = false;
    const r = await flow('RENEW', c, () => { a.fcRenew(); pad(a).type('1234'); }, () => (renewed = renewed || a.state.screen === 'paid'));
    ok(c.balance() === was && c.state.tapLimit === r.tapWas, 'RENEW: the same money on the card, and the limit back', c.balance() + ' / ' + c.state.tapLimit);
  }
  // the backup's move to this phone
  {
    await read(c);
    const was = c.balance();
    const r = await flow('BACKUP MOVE', c, () => { a.fcRekey(); until('the PIN pad', () => !!pad(a)).then(() => pad(a).type('1234')); },
      () => a.toasts.indexOf('Backup on this phone.') >= 0);
    ok(c.balance() === was && c.state.tapLimit === r.tapWas, 'BACKUP MOVE: the money back on, and the limit back', c.balance() + ' / ' + c.state.tapLimit);
  }
  // the SWAP's first tap: what the swap spends, taken off the card (the swap itself is not this suite's)
  {
    await read(c);
    const was = c.balance();
    a._swapCard = { key: c.key };
    a.swapUnits = () => ({ from: 'sat', to: 'usd' });
    a.fcPinOr = (o, then) => then('1234');
    H.W.swapRun = () => Promise.resolve({ state: 'pending' });
    H.W.swapQuote = () => Promise.resolve({ total: 300, expiresAt: Date.now() + 600000 });
    a.fcSwapPending = () => { a._swapHalf = true; };
    await flow('SWAP', c, () => a.fcSwapGo({ total: 300, expiresAt: Date.now() + 600000 }), () => c.balance() < was && (!!a._swapHalf || raised.some((x) => /^fc-swap-back/.test(x))));
  }
  // RESET of a card with money on it
  {
    await read(c);
    await flow('RESET', c, () => a.fcResetRun('1234'), () => !c.state.owner);
    ok(!c.state.owner && c.balance() === 0, 'RESET: the money came off and the card is reset');
  }
  // TRANSFER, on a card of its own
  {
    const d = newCard(H, undefined, { format: 4, software: 25 });
    await setUp(d, 3000);
    await read(d);
    const quote = await H.W.cardTransferQuote(a._fcCard, MINT2);
    a.state.fcMove = { to: MINT2, have: d.balance(), unit: 'sat', quote };
    const r = await flow('TRANSFER', d, () => a.fcMoveRun('1234'), () => !!(a.state.fcMove && a.state.fcMove.busy === false) || a.state.fcMove === null || /n\.test/.test(d.state.record.mint || ''));
    ok(/n\.test/.test(d.state.record.mint || '') && d.balance() > 0 && d.state.tapLimit === r.tapWas, 'TRANSFER: the card at the other mint, its money on it, its limit as it was',
       (d.state.record.mint || '') + ' / ' + d.balance() + ' / ' + d.state.tapLimit);
  }

  // a per tap limit that recuts the money under it
  {
    // (on a card of 1.20, which takes a load with its owner's grant: a card of 1.21 and on wants its PIN for the money to go back on)
    const e = newCard(H, undefined, { format: 4, software: 20 });
    await setUp(e, 4000);
    await read(e);
    const was = e.balance();
    await flow('WITHDRAW 1.20', e, () => a.fcWithdrawRun(300, '1234'), () => e.balance() < was);
    await read(e);
    ok(a.fcAbove(a._fcCard, 100, a.fcLimitUnit(), true) > 0, 'the card holds pieces larger than a limit of 100', JSON.stringify(a._fcCard.pieces.map((x) => x.amount)));
    let said = false;
    await flow('RECUT', e, () => a.fcLimitRun(100, true, 0.1, '1234'), () => (said = said || a.toasts.some((t) => /limit set/.test(t))));
    ok(a.toasts.some((t) => /recut under it/.test(t)), 'RECUT: the money was recut under the new limit', a.toasts.slice(-1)[0]);
    ok(e.state.tapLimit === 100, 'RECUT: the new limit on one payment is on the card', String(e.state.tapLimit));
  }
  /* A move's record is signed against the yes kept for its card until the card takes it (SET_CARD answered 9000): a TRANSFER whose
   * card left before it was told its new mint is finished by TAP CARD, whose record is signed then. */
  {
    const g = newCard(H, undefined, { format: 4, software: 25 });
    await setUp(g, 2000);
    await read(g);
    const quote = await H.W.cardTransferQuote(a._fcCard, MINT2);
    a.state.fcMove = { to: MINT2, have: g.balance(), unit: 'sat', quote };
    const gate = cardGate();
    H.phone.gate = gate;
    H.phone.cardApprovals = [];
    H.nfc = g;
    // the card leaves just before it is told its new mint: armed by the tap the sheet begins with
    const tap0 = g.tap.bind(g);
    g.tap = () => { tap0(); g.leaveBefore('32', 1); g.tap = tap0; };
    a.fcMoveRun('1234');
    await until('the card to be asked for again', () => !!lastOver('fc-move-tap') && !(a._fcTaps > 0));
    ok(g.balance() === 0 && /m\.test/.test(g.state.record.mint), 'TRANSFER cut short: the money crossed, and the card was not told its new mint', g.state.record.mint);
    lastOver('fc-move-tap').go();
    await until('TRANSFER to be finished', () => /n\.test/.test(g.state.record.mint || '') && g.balance() > 0 && !(a._fcTaps > 0));
    await settle();
    ok(gate.declined.length === 0, 'TRANSFER FINISHED: nothing it asked the phone to sign was refused', gate.declined.join(' / '));
    ok(/n\.test/.test(g.state.record.mint || '') && g.balance() > 0, 'TRANSFER FINISHED: TAP CARD wrote the record and the money, under the move kept for it', g.state.record.mint + ' / ' + g.balance());
    ok(gate.moves.length === 0, 'and the move is done with once the card took it');
    flows.push({ flow: 'TRANSFER FINISHED', lifts: true, steps: gate.trace });
  }

  /* SWITCH TO under ADD FUNDS: an empty card at another mint is told this phone's mint in the tap that writes the funds, under the
   * keeper's set-card yes asked before it is held up. */
  {
    const f = newCard(H, undefined, { format: 4, software: 20 });
    H.nfc = f;
    f.tap();
    await H.W.cardSetUp(f, { pin: '1234' });
    await H.W.connect(MINT2, null, null, { remember: false });
    await H.W.claim((await H.W.invoice(3000, '')).hash);
    await a.refreshBalance();
    await read(f);
    const gate = cardGate();
    H.phone.gate = gate;
    H.phone.cardApprovals = [];
    a.fcAdd();
    const sw = lastOver('fc-other-mint');
    ok(!!sw && /^SWITCH TO/.test(sw.retry || ''), 'ADD FUNDS on an empty card at another mint offers SWITCH TO', sw && sw.retry);
    sw.go();
    f.tap();
    keyIn(a, 500);
    await until('the funds to be on the card at the new mint', () => /n\.test/.test(f.state.record.mint || '') && f.balance() === 500 && !(a._fcTaps > 0));
    await settle();
    const asked = H.phone.cardApprovals.map((m) => [m.label, m.mint, (m.units || []).join(), m.keep, m.card]);
    ok(JSON.stringify(asked) === JSON.stringify([['set-card', MINT2, 'sat', true, f.key]]), 'SWITCH TO: one yes asked before the tap, for this card, at the new mint, in bitcoin', JSON.stringify(asked));
    ok(gate.declined.length === 0, 'SWITCH TO: nothing it asked the phone to sign was refused', gate.declined.join(' / '));
    ok(/n\.test/.test(f.state.record.mint || '') && f.balance() === 500, 'SWITCH TO: the card is at the new mint with the funds', f.state.record.mint + ' / ' + f.balance());
    flows.push({ flow: 'SWITCH TO', lifts: false, steps: gate.trace });
  }


  /* The ways round the rule, as refusals: the phone's rule refuses each (the model here, and the Swift through the replay). A page
   * asking for these is a page that has been got at; the honest flows above never do. */
  {
    const g = cardGate();
    const key = '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    const hx = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
    const info = (len, day, tap, noPin, o) => {
      const b = Buffer.alloc(len);
      b[0] = 1; b[1] = (o && o.version) || 23; b[6] = (o && o.quick) ? 31 : 15; b[16] = 1;
      b.writeUInt32BE(day, 12);
      if (len >= 42) { b.writeUInt32BE(tap, 30); b.writeUInt32BE(noPin, 34); }
      g.saw('b001' + (len === 30 ? '00' : len === 55 ? '04' : '03') + '0000', b.toString('hex') + '9000');
    };
    const sawKey = () => g.saw('b010000000', key + '9000');
    const grant = () => g.saw('b0450000033001009000'.slice(0, 16), '9000');
    const sign = (want, why, ...fig) => {
      const got = g.allows({ key, label: 'set-limit', nonce: '07'.repeat(16), value: fig.map(hx).join('') });
      ok(got === want, 'the rule ' + (want ? 'signs' : 'refuses') + ' ' + why, '[' + fig.join(', ') + ']');
    };
    const R = 97000;
    // D and E: a quick card read before the grant says 0 for its limit on one payment
    g.begin(); sawKey(); info(55, 1000, 0, 50, { quick: true, version: 25 });
    sign(false, 'D: the limit on one payment written to 0 with nobody asked', 1000, 0, 50, R);
    g.end();
    g.approve({ label: 'set-limit', lift: true });
    g.begin(); sawKey(); info(55, 1000, 0, 50, { quick: true, version: 25 });
    sign(false, 'E: a lift from a figure read before the grant', 0, 0, 50, R);
    grant(); info(55, 1000, 200, 50, { quick: true, version: 25 });
    sign(true, 'the lift after the grant', 0, 0, 50, R);
    sign(false, 'E: the put-back without the limit on one payment', 1000, 0, 50, R);
    sign(true, 'the put-back as the card said it', 1000, 200, 50, R);
    g.end();
    // A, B: a part lift, a lift over a kept one, the day put back alone
    g.approve({ label: 'set-limit', lift: true });
    g.begin(); sawKey(); info(51, 1000, 200, 50);
    sign(false, 'A: a part lift, the day alone', 0);
    sign(true, 'the lift', 0, 0);
    sign(false, 'A: a second lift over the kept one', 0, 0);
    sign(false, 'B: the day put back alone', 1000);
    sign(false, 'B: the limit on one payment put back alone', 0, 200);
    sign(true, 'the put-back', 1000, 200);
    g.end();
    // C: P1 = 0's thirty bytes from a card of 1.25
    g.approve({ label: 'set-limit', lift: true });
    g.begin(); sawKey(); info(30, 1000, 0, 0, { version: 25 });
    sign(false, 'C: a lift from an answer that says nothing of the limit on one payment', 0, 0);
    g.end();
    // F, G: a put-back signed and never sent is not taken as done by GET_KEY or a P1 = 0 answer
    g.approve({ label: 'set-limit', lift: true });
    g.begin(); sawKey(); info(51, 1000, 200, 50);
    sign(true, 'the lift', 0, 0, 50, R);
    sign(true, 'the put-back, never sent', 1000, 200, 50, R);
    sawKey(); info(30, 1000, 0, 0, { version: 25 });
    g.end();
    g.begin(); sawKey(); info(51, 0, 0, 50);
    sign(true, 'F/G: the next tap that finds it lifted puts it back', 1000, 200, 50, R);
    info(51, 1000, 200, 50);
    g.end();
    g.begin(); sawKey(); info(51, 0, 0, 50);
    sign(false, 'and once it is seen put back, nothing more', 1000, 200, 50, R);
    g.end();
    // N2: no key said in the tap; another card's
    g.approve({ label: 'set-limit', lift: true });
    g.begin(); info(51, 1000, 200, 50);
    sign(false, 'a lift with no key said in the tap', 0, 0, 50, R);
    g.saw('b010000000', '03' + '22'.repeat(32) + '9000');
    sign(false, 'a lift for another card than the one held', 0, 0, 50, R);
    g.end();
    flows.push({ flow: 'ATTACKS', lifts: false, steps: g.trace });
  }

  /* What a flow's bytes say, without what changes from run to run (card keys, nonces, signatures, refund keys): each yes, each
   * session, the limits each GET_INFO said, each signature's label, figures and answer. */
  const print = (f) => f.flow + ': ' + f.steps.map((x) => {
    if (x.step === 'approve') return 'yes ' + [x.body.label, x.body.mint || '', (x.body.units || []).join('+'), (x.body.figures || []).join('+'), x.body.keep ? 'keep' : '', x.body.lift ? 'lift' : '', x.body.value || ''].join('/');
    if (x.step === 'saw') {
      const ins = x.apdu.slice(2, 4), n = x.answer.length / 2 - 2;
      return 'saw ' + ins + ':' + n + (ins === '01' ? ':' + x.answer.slice(24, 32) + (n >= 42 ? x.answer.slice(60, 76) : '') : '');
    }
    if (x.step === 'sign') return 'sign ' + x.body.label + ':' + (x.body.label === 'set-limit' ? x.body.value : x.body.value.slice(0, 2) + x.body.value.slice(198)) + ':' + x.allowed;
    return x.step;
  }).join(' ');
  if (process.argv.includes('--record')) {
    const out = path.join(__dirname, 'fixtures', 'card-gate-flows.json');
    fs.writeFileSync(out, JSON.stringify(flows, null, 0).replace(/\},\{"step"/g, '},\n{"step"') + '\n');
    console.log('wrote ' + out);
  } else {
    // what is recorded is what the flows do now: FoxyTests replays it through the Swift
    const kept = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'card-gate-flows.json'), 'utf8'));
    const was = kept.map(print), now = flows.map(print);
    const off = now.map((x, i) => (x === was[i] ? '' : x.split(':')[0])).filter(Boolean);
    ok(kept.length === flows.length && off.length === 0, 'tests/fixtures/card-gate-flows.json holds these flows, byte for byte in what the rule reads (run with --record after a change)',
       off.join(', ') || kept.map((f) => f.flow).join());
  }
  console.log('\n' + (failed ? failed + ' failed' : 'all flashcard-gate checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
