'use strict';
/* nut-vectors.js — the Cashu spec's own test vectors, through the libraries
 * Foxy ships.
 *
 *     node tests/nut-vectors.js
 *
 * The vectors are copied unchanged from cashubtc/nuts into tests/vectors (see
 * its README) and parsed out of the markdown here, so a refreshed copy is
 * tested as it stands. Everything runs through Web/cashu-ts.js exactly as
 * foxy-wallet.js loads it — the bundle, not cashu-ts's source — and the
 * payment requests also through Foxy's own reader.
 *
 * NUT-11's vectors are about a *mint* deciding whether a witness satisfies a
 * spending condition. Foxy is never that, but now it holds P2PK
 * keys for its own payment requests, and `onlyLockedTo` asks cashu-ts the same
 * question the vectors ask — so the vectors run here against the code Foxy
 * leans on, and then Foxy's own receiver decision is checked separately. The
 * two answers differ on purpose and the section says where.
 *
 * NUT-13 has its own file (nut13-vectors.js). Not here, and why:
 *   NUT-20 key derivation — Foxy uses a random key per quote, as Nutshell and
 *   cashu.me do, so there is no derivation to check. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://foxy.test/' });
const w = dom.window;
if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
for (const f of ['bip39.js', 'cashu-ts.js', 'foxy-wallet.js']) {
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
  w.document.body.appendChild(s);
}
const C = w.CashuTS;
const W = w.FoxyWallet;

/* A phone that knows no lock key, so the seed walk finishes and says so.
 *
 * A P2PK lock key comes from the seed, and a token whose lock
 * no stored row names sends `receiveToken` walking the path on the phone
 * (`walkForLock`). With no bridge at all that walk cannot run, and every
 * refusal below came back as "this phone could not check whether that token is
 * yours" — still a refusal, but for the wrong reason, which is not what these
 * checks are for. So the bridge is stubbed with a wallet whose every derived
 * key is something else: the walk completes, matches nothing, and the refusal
 * is the real one. Keys are distinct and well formed so nothing short-circuits
 * on their shape. Only the three lock-key actions are answered; anything else
 * is an error, because nothing here should be asking. */
w.webkit = { messageHandlers: { foxy: { postMessage(msg) {
  const done = (text, err) => setTimeout(() => W._scanResult(msg.id, text, err), 0);
  if (msg.action === 'p2pkPubkeys') {
    const keys = [];
    for (let i = 0; i < msg.count; i += 1) {
      // 02 + a counted, distinct 32-byte x — never one of the vectors' keys
      keys.push('02' + (msg.start + i + 1).toString(16).padStart(8, '0') + 'ff'.repeat(28));
    }
    return done(JSON.stringify({ pubkeys: keys }));
  }
  if (msg.action === 'p2pkReserve') return done(JSON.stringify({ index: 0 }));
  if (msg.action === 'p2pkKey') return done(null, 'this test holds no lock key');
  return done(null, 'not in this test: ' + msg.action);
} } } };
/* And a route, because the stub above makes the page believe it is on a phone
 * (`bridged()`), and a phone whose Tor is not up refuses everything before it
 * looks at a token. Without this every refusal below reads "Foxy is still
 * connecting to Tor", which says nothing about the lock. */
W._privacy({ tor: 'up', everUp: true });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
};
const attempt = (name, fn) => { try { fn(); } catch (e) { check(name, false, 'threw: ' + (e && e.message)); } };
/* Checks that have to wait on a promise. Foxy's own receive is one — the lock
 * gate it runs before it asks any mint anything is reached only through
 * `receiveToken`. They are collected here and awaited after the synchronous
 * vectors, so the output stays in spec order. */
const tail = [];

const md = n => fs.readFileSync(path.join(__dirname, 'vectors', 'nut' + n + '-tests.md'), 'utf8');
const blocks = text => { const out = []; const re = /```(\w*)\n([\s\S]*?)```/g; let m; while ((m = re.exec(text))) out.push({ lang: m[1], body: m[2].trim() }); return out; };
const hexBytes = h => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = b => Buffer.from(b).toString('hex');
const P = C.blindMessage(new Uint8Array([1]), 1n).B_.constructor;   // the curve's point type
const orderNotes = [];
/* Keysets NUT-01 says to reject that cashu-ts's own ingestion takes. Foxy
 * refuses them (mintKeysProblem); this records what the library alone does,
 * so the gap is visible rather than assumed closed. */
const libNotes = [];
const pseudoJson = t => JSON.parse(t.replace(/h'([0-9a-f]+)'/g, '"$1"').replace(/,(\s*[}\]])/g, '$1'));

/* ---- NUT-00 ------------------------------------------------------------ */
{
  const b = blocks(md('00'));

  // hash_to_curve is not exported on its own: blinding with r = 1 gives Y + G
  for (const m of b[0].body.matchAll(/Message:\s*([0-9a-f]+)\s*\n\s*Point:\s*([0-9a-f]+)/g)) {
    attempt('NUT-00 hash_to_curve ' + m[1].slice(-4), () => {
      const Y = C.blindMessage(hexBytes(m[1]), 1n).B_.subtract(P.BASE);
      check('NUT-00 hash_to_curve ' + m[1].slice(-4), Y.toHex(true) === m[2], Y.toHex(true));
    });
  }
  for (const m of b[1].body.matchAll(/x:\s*([0-9a-f]+).*\n\s*r:\s*([0-9a-f]+).*\n\s*B_:\s*([0-9a-f]+)/g)) {
    attempt('NUT-00 blinded message', () => {
      const B_ = C.blindMessage(hexBytes(m[1]), BigInt('0x' + m[2])).B_.toHex(true);
      check('NUT-00 blinded message ' + m[3].slice(0, 8), B_ === m[3], B_);
    });
  }
  for (const m of b[2].body.matchAll(/mint private key:\s*([0-9a-f]+)\s*\n\s*B_:\s*([0-9a-f]+)\s*\n\s*C_:\s*([0-9a-f]+)/g)) {
    attempt('NUT-00 blind signature', () => {
      const C_ = C.createBlindSignature(P.fromHex(m[2]), hexBytes(m[1]), '00').C_.toHex(true);
      check('NUT-00 blind signature ' + m[3].slice(0, 8), C_ === m[3], C_);
    });
  }

  const sameToken = (got, want) => got && got.mint === want.mint && (got.unit || 'sat') === (want.unit || 'sat')
    && (got.memo || '') === (want.memo || '') && got.proofs.length === want.proofs.length
    && got.proofs.every((p, i) => Number(p.amount) === Number(want.proofs[i].amount) && p.id === want.proofs[i].id
      && p.secret === want.proofs[i].secret && p.C === want.proofs[i].C);

  // v3
  const v3 = JSON.parse(b[3].body);
  const v3want = { mint: v3.token[0].mint, proofs: v3.token[0].proofs, unit: v3.unit, memo: v3.memo };
  attempt('NUT-00 token v3 decodes', () => check('NUT-00 token v3 decodes', sameToken(C.getDecodedToken(b[4].body, []), v3want)));
  b[5].body.split('\n').filter(l => l && !l.startsWith('#')).forEach((bad, i) => {
    let threw = false;
    try { C.getDecodedToken(bad.trim(), []); } catch (e) { threw = true; }
    check('NUT-00 token v3 malformed #' + (i + 1) + ' is refused', threw);
  });
  attempt('NUT-00 token v3 correct', () => check('NUT-00 token v3 correct', sameToken(C.getDecodedToken(b[6].body.trim(), []), v3want)));
  b[7].body.split('\n').filter(l => l && !l.startsWith('#')).forEach((t, i) => {
    attempt('NUT-00 token v3 padding #' + (i + 1), () => {
      const d = C.getDecodedToken(t.trim(), []);
      check('NUT-00 token v3 padding #' + (i + 1) + ' decodes', d && d.memo === 'Thank you very much.' && d.proofs.length === 2);
    });
  });

  // v4
  const v4 = j => ({
    mint: j.m, unit: j.u, memo: j.d,
    proofs: j.t.flatMap(g => g.p.map(p => ({ id: g.i, amount: p.a, secret: p.s, C: p.c }))),
  });
  for (const [label, jb, eb] of [['single keyset', 8, 9], ['multiple keysets', 10, 11]]) {
    const want = v4(pseudoJson(b[jb].body));
    const enc = b[eb].body.trim();
    attempt('NUT-00 token v4 ' + label + ' decodes', () => check('NUT-00 token v4 ' + label + ' decodes', sameToken(C.getDecodedToken(enc, []), want)));
    /* Encoding: the bytes differ from the spec's example — cashu-ts writes the
     * map keys m, u, t, d where the example has t, d, m, u. CBOR does not fix a
     * key order and NUT-00 does not ask for one; both decode to the same
     * token. So what is checked is that Foxy's encoding decodes back to the
     * token, and the difference is printed rather than passed off as a match. */
    attempt('NUT-00 token v4 ' + label + ' encodes', () => {
      const got = C.getEncodedToken(want);
      check('NUT-00 token v4 ' + label + ' encodes to a token that decodes back to it', sameToken(C.getDecodedToken(got, []), want));
      if (got.replace(/=+$/, '') !== enc.replace(/=+$/, '')) orderNotes.push('v4 ' + label);
    });
  }
  const raw = /`h'([0-9a-f]+)'`/.exec(md('00'));
  attempt('NUT-00 token v4 raw binary', () => {
    const want = v4(pseudoJson(b[12].body));
    check('NUT-00 token v4 raw binary: the spec\'s bytes decode', sameToken(C.getDecodedTokenBinary(hexBytes(raw[1])), want));
    const got = C.getEncodedTokenBinary(want);
    check('NUT-00 token v4 raw binary: Foxy\'s bytes decode back', sameToken(C.getDecodedTokenBinary(got), want));
    if (hex(got) !== raw[1]) orderNotes.push('v4 raw binary');
  });
}

/* ---- NUT-01 ------------------------------------------------------------ */
{
  /* Four keysets: two the spec says a wallet should refuse, two it should take.
   *
   * "Should be rejected by wallets" is a claim about the path that ingests a
   * mint's `/v1/keys`, so each keyset is offered under the id it actually
   * derives to — what is measured is whether the *keys* are checked, not
   * whether the mint lied about the id.
   *
   * Two answers, and they differ. cashu-ts is asked its own way (`Keyset`,
   * built by `fromMintApi` and checked by `verify()`) and takes both bad
   * keysets: `verify()` counts the keys and hashes the key strings to check
   * the id, and never asks whether the bytes are a point on the curve. That is
   * printed rather than hidden, and it is why Foxy has a check of its own —
   * `mintKeysProblem`, which every mint answer passes through inside
   * `nativeRequest`. Foxy's answer is the one the vectors are held to. */
  const b = blocks(md('01'));
  const keysets = b.map(x => JSON.parse(x.body));
  check('NUT-01 the vendored file holds four keysets', keysets.length === 4, keysets.length + ' blocks');

  const asMintSays = keys => {
    const id = C.deriveKeysetId(keys, { versionByte: 0 });
    return { id, keysets: [{ id, unit: 'sat', active: true, input_fee_ppk: 0, keys }] };
  };
  const libTakes = keys => {
    const { id } = asMintSays(keys);
    try {
      return C.Keyset.fromMintApi({ id, unit: 'sat', active: true, input_fee_ppk: 0 },
        { id, unit: 'sat', keys }).verify() === true;
    } catch (e) { return false; }
  };
  const takes = keys => !W._mintKeysProblem(asMintSays(keys));

  for (const [i, why] of [[0, 'a key one byte short'], [1, 'a key that is not compressed']]) {
    attempt('NUT-01 ' + why, () => {
      check('NUT-01 a keyset with ' + why + ' is refused', takes(keysets[i]) === false,
        W._mintKeysProblem(asMintSays(keysets[i])) || 'Foxy took it');
      if (libTakes(keysets[i])) libNotes.push(why);
    });
  }
  for (const [i, what] of [[2, 'the small keyset'], [3, 'the big keyset']]) {
    attempt('NUT-01 ' + what + ' is taken', () => {
      check('NUT-01 ' + what + ' is taken', takes(keysets[i]) === true,
        W._mintKeysProblem(asMintSays(keysets[i])));
    });
  }

  /* The big keyset runs to 2^63, one past a signed 64-bit integer, which is the
   * whole point of the vector: an amount read as a double loses the low bits and
   * the id comes out wrong. */
  attempt('NUT-01 amounts past 2^63', () => {
    const big = keysets[3];
    const top = Object.keys(big).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)).pop();
    check('NUT-01 the big keyset carries 9223372036854775808 and derives an id from it',
      top === '9223372036854775808' && /^00[0-9a-f]{14}$/.test(C.deriveKeysetId(big, { versionByte: 0 })), top);
  });
}

/* ---- NUT-02 ------------------------------------------------------------ */
{
  const text = md('02');
  const [v1text, v2text] = text.split('## Version 2');
  for (const m of v1text.matchAll(/Keyset id: `([0-9a-f]+)`\s*```json\n([\s\S]*?)```/g)) {
    attempt('NUT-02 keyset id v1 ' + m[1], () => {
      const got = C.deriveKeysetId(JSON.parse(m[2]), { versionByte: 0 });
      check('NUT-02 keyset id v1 ' + m[1], got === m[1], got);
    });
  }
  for (const m of v2text.matchAll(/### Vector \d+([\s\S]*?)```json\n([\s\S]*?)```/g)) {
    const meta = m[1];
    const id = (/Keyset id: `([^`]+)`/.exec(meta) || [])[1];
    const unit = (/Unit: `([^`]+)`/.exec(meta) || [])[1];
    const fee = (/Input fee ppk: `(\d+)`/.exec(meta) || [])[1];
    const expiry = (/Final expiry: `(\d+)`/.exec(meta) || [])[1];
    attempt('NUT-02 keyset id v2 ' + String(id).slice(0, 10), () => {
      const got = C.deriveKeysetId(JSON.parse(m[2]), {
        versionByte: 1, unit, input_fee_ppk: fee === undefined ? undefined : Number(fee),
        expiry: expiry === undefined ? undefined : Number(expiry),
      });
      check('NUT-02 keyset id v2 ' + String(id).slice(0, 10) + '…', got === id, got);
    });
  }
}

/* ---- NUT-11 ------------------------------------------------------------ */
{
  const b = blocks(md('11'));
  /* The blocks are taken by position, as NUT-00's and NUT-12's are, because the
   * file labels its vectors in prose rather than in headings. A refreshed copy
   * that has grown or lost a block must fail here rather than quietly check the
   * wrong thing against the wrong expectation. */
  check('NUT-11 the vendored file holds the 22 blocks these checks are written against',
    b.length === 22, b.length + ' blocks');

  /* ---- single proofs: SIG_INPUTS -------------------------------------- */
  /* `isP2PKSpendAuthorised` is what Foxy's `onlyLockedTo` reaches, through
   * `verifyP2PKSpendingConditions`. The spec's cases are the mint's decision;
   * this checks the library gives that decision, which is the part Foxy trusts. */
  const singles = [
    [0, 'a locktime in the past and no witness at all', false],
    [1, 'two of two signatures, before the locktime', true],
    [2, 'one refund signature, after the locktime', true],
    [3, 'one valid signature', true],
    [4, 'a signature made over a different secret', false],
    [5, 'two signatures where two are required', true],
    [6, 'one signature where two are required', false],
    [7, 'a refund signature and a locktime in the past', true],
    [8, 'a refund signature and a locktime in the future', false],
  ];
  for (const [i, label, want] of singles) {
    attempt('NUT-11 ' + label, () => {
      const proof = JSON.parse(b[i].body);
      const got = C.isP2PKSpendAuthorised(proof);
      let path = '';
      try { path = C.verifyP2PKSpendingConditions(proof).path; } catch (e) { path = 'threw'; }
      check('NUT-11 ' + label + ' is ' + (want ? 'spendable' : 'not spendable'), got === want, 'got ' + got + ', path ' + path);
    });
  }

  /* The same two locktime vectors read through `getP2PKExpectedWitnessPubkeys`,
   * which is `spendableBy` itself — the call that decides whether a proof is
   * Foxy's alone. An expired locktime hands the refund key in beside the main
   * one; an active one does not. Foxy refuses both, and this is why it has to. */
  attempt('NUT-11 who can open a proof, by its locktime', () => {
    const past = JSON.parse(b[7].body), future = JSON.parse(b[8].body);
    const kPast = C.getP2PKExpectedWitnessPubkeys(past.secret);
    const kFuture = C.getP2PKExpectedWitnessPubkeys(future.secret);
    check('NUT-11 an expired locktime adds the refund key to those who can open the proof',
      kPast.length === 2, JSON.stringify(kPast));
    check('NUT-11 an active locktime leaves only the main key',
      kFuture.length === 1, JSON.stringify(kFuture));
  });

  /* ---- SIG_ALL: the message the whole request is signed over ----------- */
  const sigAllMsg = req =>
    C.buildP2PKSigAllMessageV0(req.inputs, req.outputs.map(o => ({ blindedMessage: o })), req.quote);

  for (const [reqAt, msgAt, what] of [[9, 10, 'swap'], [18, 19, 'melt']]) {
    attempt('NUT-11 SIG_ALL ' + what + ' message', () => {
      const req = JSON.parse(b[reqAt].body);
      const wantMsg = b[msgAt].body.trim();
      // the hash follows the message block in prose, not in a block of its own
      const after = md('11').slice(md('11').indexOf(wantMsg) + wantMsg.length);
      const wantHash = /`([0-9a-f]{64})`/.exec(after)[1];
      const got = sigAllMsg(req);
      check('NUT-11 SIG_ALL ' + what + ' msg_to_sign matches the spec', got === wantMsg, got.slice(0, 120));
      check('NUT-11 SIG_ALL ' + what + ' msg_to_sign hashes to the spec\'s digest',
        crypto.createHash('sha256').update(got, 'utf8').digest('hex') === wantHash);
      check('NUT-11 SIG_ALL ' + what + ' computeMessageDigest agrees',
        hex(C.computeMessageDigest(got)) === wantHash);
    });
  }

  /* ---- SIG_ALL: whole requests ---------------------------------------- */
  /* A SIG_ALL request is valid when its inputs really do share one condition
   * (`assertSigAllInputs`) and every one of them is satisfied by the witness
   * over that message. Both halves matter: vector 12 is refused only by the
   * first, and its own inputs verify happily one at a time. */
  const requests = [
    [11, 'a swap with one SIG_ALL input', true],
    [12, 'a swap whose inputs do not share their tags', false],
    [13, 'a swap needing two signatures, with both', true],
    [14, 'a swap past its locktime signed by two refund keys', true],
    [15, 'a swap of an HTLC also locked to a key', true],
    [16, 'a swap of an HTLC signed by its refund key before the locktime', false],
    [17, 'a swap of a multisig HTLC past its locktime', true],
    [20, 'a melt with one SIG_ALL input', true],
    [21, 'a melt needing two signatures, with both', true],
  ];
  for (const [i, label, want] of requests) {
    attempt('NUT-11 ' + label, () => {
      const req = JSON.parse(b[i].body);
      let why = '';
      const got = (() => {
        try { C.assertSigAllInputs(req.inputs); } catch (e) { why = 'inputs differ: ' + e.message; return false; }
        const msg = sigAllMsg(req);
        return req.inputs.every((inp, n) => {
          const htlc = C.getSecretKind(inp.secret) === 'HTLC';
          const ok = (htlc ? C.isHTLCSpendAuthorised : C.isP2PKSpendAuthorised)(inp, undefined, msg);
          if (!ok) why = 'input #' + (n + 1) + ' (' + (htlc ? 'HTLC' : 'P2PK') + ') not satisfied';
          return ok;
        });
      })();
      check('NUT-11 ' + label + ' is ' + (want ? 'valid' : 'invalid'), got === want, why);
    });
  }

  /* ---- and now Foxy, which is asking a different question -------------- */
  /* Every vector above is a mint deciding whether a witness lets a proof be
   * spent. Foxy is a receiver deciding whether money it has been handed is
   * really its own, and that is a stricter test: a proof the mint would let
   * *somebody* spend is worthless to Foxy unless the only somebody is Foxy.
   *
   * So the spec's own proofs are all refused here, and correctly — none is
   * locked to a key this phone holds. Vector 7 is the one worth naming: the
   * mint would let the refund key spend it, and it is exactly the shape Foxy
   * must turn away. */
  tail.push((async () => {
    const asToken = p => C.getEncodedToken({
      mint: 'https://vectors.test', unit: 'sat',
      proofs: [{ amount: p.amount, id: p.id, secret: p.secret, C: p.C }],
    });
    const refusal = async (token, opts) => {
      try { await W.receiveToken(token, opts); return ''; } catch (e) { return String((e && e.message) || e); }
    };
    const quiet = w.console.warn;
    w.console.warn = () => {};
    try {
      for (const [i, label] of singles) {
        const why = await refusal(asToken(JSON.parse(b[i].body)));
        check('NUT-11 Foxy refuses the vector proof with ' + label,
          /locked to/.test(why), why ? 'refused for another reason: ' + why.slice(0, 80) : 'it was taken');
      }

      /* The other direction, which the vectors cannot give because they carry
       * no private keys: the same tag shapes rebuilt around a key this test
       * holds, so the lock names Foxy and the question becomes what Foxy does
       * about the tags. These are the shapes the vectors describe, not the
       * vectors' own expectations — several are things a mint would honour and
       * Foxy still will not take (CASHU-CONFORMANCE.md, NUT-10/11). */
      const priv = 'ab'.repeat(32);
      const pub = hex(C.getPubKeyFromPrivKey(hexBytes(priv)));
      const other = '02' + 'c'.repeat(64);
      const locked = (kind, data, tags) => C.getEncodedToken({
        mint: 'https://vectors.test', unit: 'sat',
        proofs: [{
          amount: 1, id: '009a1f293253e41e',
          secret: JSON.stringify([kind, { nonce: '0'.repeat(64), data, tags }]),
          C: '02698c4e2b5f9534cd0687d87513c759790cf829aa5739184a3e3735471fbda904',
        }],
      });
      const hash = 'ec4916dd28fc4c10d78e287ca5d9cc51ee1ae73cbfde08c6b37324cbfaac8bc5';
      const shapes = [
        ['locked to this phone and carrying no tags', locked('P2PK', pub, []), true],
        ['locked to this phone with SIG_INPUTS written out', locked('P2PK', pub, [['sigflag', 'SIG_INPUTS']]), true],
        ['carrying a pubkeys tag that names the payer as well', locked('P2PK', pub, [['pubkeys', other]]), false],
        ['carrying a locktime in the past and a refund key', locked('P2PK', pub, [['locktime', '21'], ['refund', other]]), false],
        /* Far enough out to swap in now: ours. It gets past
         * the lock gate and fails at the mint this vector page has none of. */
        ['carrying a locktime far in the future', locked('P2PK', pub, [['locktime', '99999999999']]), true],
        ['carrying a locktime an hour away', locked('P2PK', pub, [['locktime', String(Math.floor(Date.now() / 1000) + 3600)]]), false],
        ['carrying n_sigs 2 beside a single key', locked('P2PK', pub, [['n_sigs', '2']]), false],
        ['carrying n_sigs 2 and a second key', locked('P2PK', pub, [['pubkeys', other], ['n_sigs', '2']]), false],
        ['carrying SIG_ALL', locked('P2PK', pub, [['sigflag', 'SIG_ALL']]), false],
        ['that is an HTLC naming this phone in pubkeys', locked('HTLC', hash, [['pubkeys', pub]]), false],
      ];
      for (const [label, token, keep] of shapes) {
        const why = await refusal(token, { unlockWith: priv });
        // a lock of ours with a time on it is refused in its own words
        const refused = /locked to|taken back by the sender|time lock on this ecash has passed/.test(why);
        check('NUT-11 a proof ' + label + ' is ' + (keep ? 'Foxy\'s to claim' : 'not Foxy\'s to claim'),
          refused === !keep, refused ? 'refused as a stranger\'s lock' : 'got past the lock gate: ' + why.slice(0, 70));
      }
    } finally { w.console.warn = quiet; }
  })());
}

/* ---- NUT-12 ------------------------------------------------------------ */
{
  const b = blocks(md('12'));
  const q = (body, k) => (new RegExp(k + ':\\s*"?([0-9a-f]+)"?').exec(body) || [])[1];
  attempt('NUT-12 hash_e', () => {
    const got = hex(C.hash_e([q(b[0].body, 'R1'), q(b[0].body, 'R2'), q(b[0].body, 'K'), q(b[0].body, 'C_')].map(h => P.fromHex(h))));
    check('NUT-12 hash_e', got === /"([0-9a-f]{64})"/.exec(b[1].body)[1], got);
  });
  attempt('NUT-12 deterministic nonce', () => {
    const a = q(b[2].body, 'a'), A = q(b[2].body, 'A'), B_ = q(b[2].body, 'B_'), C_ = q(b[2].body, 'C_');
    const proofE = q(b[3].body, 'e'), proofS = q(b[3].body, 's');
    const d = C.createDLEQProof(P.fromHex(B_), hexBytes(a));
    check('NUT-12 deterministic nonce reproduces e and s', hex(d.e) === proofE && hex(d.s) === proofS, 'e ' + hex(d.e).slice(0, 16) + ' s ' + hex(d.s).slice(0, 16));
    check('NUT-12 deterministic nonce proof verifies', C.verifyDLEQProof(d, P.fromHex(B_), P.fromHex(C_), P.fromHex(A)) === true);
  });
  attempt('NUT-12 DLEQ on BlindSignature', () => {
    const A = q(b[4].body, 'A'), B_ = q(b[4].body, 'B_');
    const sig = JSON.parse(b[5].body);
    const dleq = { e: hexBytes(sig.dleq.e), s: hexBytes(sig.dleq.s) };
    check('NUT-12 DLEQ on BlindSignature verifies', C.verifyDLEQProof(dleq, P.fromHex(B_), P.fromHex(sig.C_), P.fromHex(A)) === true);
    const bad = { e: dleq.e, s: hexBytes(sig.dleq.s.slice(0, -1) + (sig.dleq.s.endsWith('a') ? 'b' : 'a')) };
    let rejected = false;
    try { rejected = C.verifyDLEQProof(bad, P.fromHex(B_), P.fromHex(sig.C_), P.fromHex(A)) === false; } catch (e) { rejected = true; }
    check('NUT-12 DLEQ on BlindSignature with a changed s is rejected', rejected);
  });
  attempt('NUT-12 DLEQ on Proof', () => {
    const A = q(b[6].body, 'A');
    const proof = JSON.parse(b[7].body);
    const keyset = { id: proof.id, keys: { 1: A } };
    check('NUT-12 DLEQ on Proof verifies (hasValidDleq)', C.hasValidDleq(proof, keyset) === true);
    const tampered = { ...proof, dleq: { ...proof.dleq, r: '00'.repeat(31) + '01' } };
    check('NUT-12 DLEQ on Proof with a different r is rejected', C.hasValidDleq(tampered, keyset) === false);
    check('NUT-12 a proof without DLEQ is not "valid" when one is required', C.hasValidDleq({ ...proof, dleq: undefined }, keyset) === false);
  });
}

/* ---- NUT-18 ------------------------------------------------------------ */
{
  const text = md('18');
  for (const sec of text.split('\n### ').slice(1)) {
    const title = sec.split('\n')[0].trim();
    const b = blocks(sec);
    const js = b.find(x => x.lang === 'json');
    const enc = b.find(x => x.lang === '' && /^creq/.test(x.body));
    if (!js || !enc) continue;
    const want = JSON.parse(js.body);
    const e = enc.body.trim();
    attempt('NUT-18 ' + title + ' (cashu-ts)', () => {
      const d = C.decodePaymentRequest(e);
      const tr = (d.transport || []).map(t => t.type + ' ' + t.target).join('|');
      const wantTr = (want.t || []).map(t => t.t + ' ' + t.a).join('|');
      const ok = d.id === want.i && String(d.amount === undefined ? '' : d.amount) === String(want.a === undefined ? '' : want.a)
        && d.unit === want.u && JSON.stringify(d.mints) === JSON.stringify(want.m)
        && (d.description || undefined) === want.d && !!d.singleUse === !!want.s && tr === wantTr
        && (!want.nut10 || (d.nut10 && d.nut10.kind === want.nut10.k && d.nut10.data === want.nut10.d));
      check('NUT-18 ' + title + ' (cashu-ts)', ok, JSON.stringify({ id: d.id, amount: String(d.amount), unit: d.unit, mints: d.mints, tr }));
    });
    attempt('NUT-18 ' + title + ' (Foxy\'s reader)', () => {
      const f = W.decodeRequest(e);
      const ok = f && f.id === want.i && f.sats === Number(want.a || 0) && f.unit === want.u
        && JSON.stringify(f.mints) === JSON.stringify(want.m) && f.description === (want.d || '')
        && JSON.stringify(f.transports) === JSON.stringify((want.t || []).map(t => t.t));
      check('NUT-18 ' + title + ' (Foxy\'s reader)', ok, JSON.stringify(f));
    });
  }
}

{
  // A request claiming a four-gigabyte string: refused, and quickly. Foxy's own
  // reader once froze the app for seconds on exactly this, from a QR code.
  const bytes = Buffer.from([0xa1, 0x61, 0x69, 0x7a, 0xff, 0xff, 0xff, 0xff].concat(new Array(24).fill(0x61)));
  const crafted = 'creqA' + bytes.toString('base64url');
  const t0 = Date.now();
  let out;
  try { out = W.decodeRequest(crafted); } catch (e) { out = 'threw ' + e.message; }
  const ms = Date.now() - t0;
  check('NUT-18 a request claiming a 4 GB string is refused quickly (' + ms + ' ms)', out === null && ms < 500, JSON.stringify(out));
}

/* ---- NUT-20 ------------------------------------------------------------ */
{
  const b = blocks(md('20'));
  const req = JSON.parse(b.find(x => x.lang === 'json' && x.body.includes('"signature"')).body);
  const msgBlock = b.find(x => x.body.includes('msg_to_sign'));
  const wantMsg = /msg_to_sign = ([0-9a-f]+)/.exec(msgBlock.body)[1];
  const wantHash = /sha256\(msg_to_sign\) = ([0-9a-f]+)/.exec(msgBlock.body)[1];
  const pubkey = /`(0[23][0-9a-f]{64})`/.exec(md('20'))[1];

  const len32 = n => { const x = Buffer.alloc(4); x.writeUInt32BE(n); return x; };
  const amountBytes = a => { let h = BigInt(a).toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
  const parts = [Buffer.from('Cashu_MintQuoteSig_v1'), len32(Buffer.byteLength(req.quote)), Buffer.from(req.quote)];
  for (const o of req.outputs) {
    const a = amountBytes(o.amount), B = Buffer.from(o.B_, 'hex');
    parts.push(len32(a.length), a, len32(B.length), B);
  }
  const msg = Buffer.concat(parts);
  check('NUT-20 message to sign matches the spec', msg.toString('hex') === wantMsg);
  const digest = crypto.createHash('sha256').update(msg).digest('hex');
  check('NUT-20 its SHA-256 matches', digest === wantHash);
  attempt('NUT-20 signature', () => {
    check('NUT-20 the spec\'s signature verifies with the bundled Schnorr', C.schnorrVerifyDigest(req.signature, digest, pubkey) === true);
    check('NUT-20 a changed quote does not verify', C.schnorrVerifyDigest(req.signature, crypto.createHash('sha256').update(Buffer.concat([msg, Buffer.from([0])])).digest('hex'), pubkey) === false);
  });
  attempt('NUT-20 Foxy\'s key pair', () => {
    // how quoteLock() makes one: the bundle's random key and its compressed public key, as hex
    const sk = C.createRandomSecretKey();
    const pk = hex(C.getPubKeyFromPrivKey(sk));
    const sig = C.schnorrSignDigest(digest, hex(sk));
    check('NUT-20 a key pair made as Foxy makes it signs and verifies', /^0[23][0-9a-f]{64}$/.test(pk) && C.schnorrVerifyDigest(sig, digest, pk) === true, pk);
    check('NUT-20 signMintQuote and verifyMintQuoteSignature agree', C.verifyMintQuoteSignature(pk, req.quote, req.outputs, C.signMintQuote(hex(sk), req.quote, req.outputs)) === true);
  });
}

/* ---- NUT-26 ------------------------------------------------------------ */
{
  /* The same payment requests as NUT-18, encoded bech32m over TLV rather than
   * base64 CBOR. Foxy makes no `creqB` of its own; it has to read one, because
   * a wallet that does make them will hand one over. Checked exactly as NUT-18
   * is, through cashu-ts's decoder and then Foxy's reader on top of it. */
  const text = md('26');
  let seen = 0;
  for (const sec of text.split('\n### ').slice(1)) {
    const title = sec.split('\n')[0].trim();
    const b = blocks(sec);
    const js = b.find(x => x.lang === 'json');
    const enc = b.find(x => x.lang === '' && /^creq/i.test(x.body));
    if (!js || !enc) continue;
    seen += 1;
    const want = JSON.parse(js.body);
    const e = enc.body.trim();
    attempt('NUT-26 ' + title + ' (cashu-ts)', () => {
      const d = C.decodePaymentRequest(e);
      const tr = (d.transport || []).map(t => t.type + ' ' + t.target).join('|');
      const wantTr = (want.t || []).map(t => t.t + ' ' + t.a).join('|');
      const ok = d.id === want.i && String(d.amount === undefined ? '' : d.amount) === String(want.a === undefined ? '' : want.a)
        && d.unit === want.u && JSON.stringify(d.mints) === JSON.stringify(want.m)
        && (d.description || undefined) === want.d && !!d.singleUse === !!want.s && tr === wantTr
        && (!want.nut10 || (d.nut10 && d.nut10.kind === want.nut10.k && d.nut10.data === want.nut10.d));
      check('NUT-26 ' + title + ' (cashu-ts)', ok, JSON.stringify({ id: d.id, amount: String(d.amount), unit: d.unit, mints: d.mints, tr }));
    });
    attempt('NUT-26 ' + title + ' (Foxy\'s reader)', () => {
      const f = W.decodeRequest(e);
      const ok = f && f.id === want.i && f.sats === Number(want.a || 0) && f.unit === want.u
        && JSON.stringify(f.mints) === JSON.stringify(want.m) && f.description === (want.d || '')
        && JSON.stringify(f.transports) === JSON.stringify((want.t || []).map(t => t.t));
      check('NUT-26 ' + title + ' (Foxy\'s reader)', ok, JSON.stringify(f));
    });
  }
  check('NUT-26 the vendored file holds the 17 request pairs these checks expect', seen === 17, seen + ' pairs');
}

Promise.all(tail).then(() => {
  console.log('');
  if (orderNotes.length) {
    console.log('note  byte order differs from the spec example (map keys m,u,t,d vs t,d,m,u; same token): ' + orderNotes.join(', '));
  }
  if (libNotes.length) {
    console.log('note  refused by Foxy, taken by cashu-ts on its own (Keyset.verify() never asks '
      + 'whether a key is a point on the curve): ' + libNotes.join(', '));
  }
  console.log(fail ? fail + ' spec vector check(s) failed, ' + pass + ' passed' : 'all ' + pass + ' spec vector checks pass with the bundled libraries');
  process.exit(fail ? 1 : 0);
}, (e) => {
  console.log('FAIL  a check that had to wait on a promise threw: ' + ((e && e.message) || e));
  process.exit(1);
});
