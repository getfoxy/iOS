'use strict';
/* p2pk.js — the lock Foxy puts on every payment request (NUT-11), against real mints.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/p2pk.js [cdk|nutshell|all]      # FOXY_P2PK_ONLY=3,5 runs those sections
 *
 * Foxy locks ecash to a per-request key on its main payment path — every
 * tap-to-pay and every same-mint payment request — and until this script
 * existed no mint that checks a signature had ever seen one of those secrets.
 * tests/p2pk-round-trip.js says so in its own header: the in-repo harness mint
 * checks no witness at all, so it can show the lock goes on and comes off, and
 * cannot show that the lock *holds*. That is what this asks a real mint.
 *
 * Sections, each OK/FAIL, exit 1 on any FAIL:
 *  1. does the mint advertise NUT-11, and does `canLock` read it — the gate is
 *     driven from a rewritten /v1/info through the fault proxy, both ways
 *  2. a request Foxy makes carries a lock, and the mint signs the locked
 *     outputs a real `sendToken(..., { lockTo })` asks for
 *  3. the mint ENFORCES it: the same proofs, spent without the key and with the
 *     wrong key, refused in the mint's own words — and still unspent afterwards
 *  4. Foxy claims them with the key through `receiveToken`, balance to the sat
 *  5. the adversarial shapes Foxy refuses, as REAL proofs this mint signed and
 *     would honour: what Foxy does, and what the mint does with the same money
 *  6. the locktime boundary: the mint, cashu-ts and Foxy at now == locktime
 *  7. a locked send whose swap answer is lost after the mint acted: recovered
 *     through `mint.restore({ outputs })` (restoreLocked, 04-lost-answers.js)
 *
 * Fake money only — the local Docker mints. Sections 5 and 6 deliberately make
 * ecash that cannot be spent by this wallet and then throws it away; it is a
 * few hundred fake sats per run.
 */
const crypto = require('crypto');
const path = require('path');
const H = require('./harness');
const { createFaultProxy } = require('./fault-proxy');

const which = process.argv[2] || 'all';
const keys = which === 'all' ? ['cdk', 'nutshell'] : [which];
const ONLY = (process.env.FOXY_P2PK_ONLY || '').split(',').filter(Boolean);
const PORTS = { cdk: 8456, nutshell: 8457 };
setTimeout(() => { console.log('WATCHDOG 1200s'); process.exit(2); }, 1200000).unref();

const sum = (ps) => ps.reduce((a, p) => a + Number(p.amount), 0);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const nonce = () => crypto.randomBytes(32).toString('hex');
/* A number as the mint's own denominations: what a swap's outputs have to be. */
const denoms = (n) => { const o = []; for (let b = 1; b <= n; b <<= 1) if (n & b) o.push(b); return o; };
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n || 160);

async function getJson(u) { return (await fetch(u)).json(); }
/* Straight at the mint, not through Foxy: this is the test's own voice, and
 * what it prints is the mint's exact answer. */
async function post(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* the mint's words, whatever they are */ }
  return { status: r.status, text: text, json: json, ok: r.status === 200 };
}
/* A proof on the wire. Foxy's tokenInfo gives amounts as strings, and NUT-11's
 * witness travels as a JSON *string*: handed a witness object, cdk-mintd
 * answers 422 "data did not match any variant of untagged enum Witness". */
const wireProof = (p) => Object.assign(
  { amount: Number(p.amount), id: p.id, secret: p.secret, C: p.C },
  p.witness ? { witness: typeof p.witness === 'string' ? p.witness : JSON.stringify(p.witness) } : {});

/* A payment request, made the way the receive screen makes one.
 *
 * The lock key comes from the seed, derived by the phone, and
 * `paymentRequest` is synchronous — so it can only take a key the phone derived
 * earlier, off `foxy.req.lockpool`. An empty pool means an **unlocked** request,
 * deliberately: a code somebody can scan beats a lock they never see.
 *
 * The app primes that pool in `railRequest` and waits for it
 * (build/app/12-receive.js). Calling `paymentRequest` straight, as this suite
 * did at first, therefore got an unlocked request every time and every lock
 * check failed for a reason that had nothing to do with the mint. Primed here
 * for the same reason the screen primes: so what is measured is the path the
 * app actually walks. */
async function request(w, sats, opts) {
  await w.primeLocks();
  return w.decodeRequest(w.paymentRequest(sats, opts || { purpose: 'receive' }));
}

async function run(key) {
  const M = H.MINTS[key];
  const R = H.reporter('p2pk ' + key);
  await H.mintNames([key]);
  R.log('=== ' + M.name + ' at ' + M.https);

  const ks = await getJson(M.http + '/v1/keysets');
  const active = ks.keysets.find((k) => k.active && k.unit === 'sat');
  const ppk = active.input_fee_ppk;
  const keyset = (await getJson(M.http + '/v1/keys/' + active.id)).keysets[0];
  const fee = (n) => H.feeFor(n, ppk);

  const proxy = createFaultProxy({ listen: PORTS[key], target: new URL(M.http).port,
    certDir: path.join(H.ROOT, 'build', 'live-tls') });
  await proxy.ready;

  async function wallet(url, fund) {
    const b = H.boot({ keychain: { words: '' } });
    await b.W.seedReady();
    await b.W.connect(url);
    if (fund) await H.mintAndClaim(b.W, fund);
    return b;
  }
  async function section(name, fn) {
    if (ONLY.length && !ONLY.some((k) => name.startsWith(k))) return;
    proxy.clear();
    await R.step(name, fn);
  }

  const A = await wallet(M.https, 900);
  const W = A.W;
  const C = A.w.CashuTS;
  /* The page's own Uint8Array. cashu-ts checks `instanceof`, and a jsdom window
   * has a realm of its own: node's TextEncoder hands back node's Uint8Array,
   * and OutputData refuses it as "secret must be a non-empty Uint8Array". */
  const u8 = (t) => A.w.Uint8Array.from(new TextEncoder().encode(t));
  const yOf = (p) => C.hashToCurve(u8(String(p.secret))).toHex(true);
  async function statesOf(proofs) {
    const r = await post(M.http + '/v1/checkstate', { Ys: proofs.map(yOf) });
    return ((r.json && r.json.states) || []).map((s) => s.state);
  }
  const newKey = () => {
    const raw = C.createRandomSecretKey();
    return { priv: Buffer.from(raw).toString('hex'), pub: Buffer.from(C.getPubKeyFromPrivKey(raw)).toString('hex') };
  };

  /* Ecash of this wallet's, out of its books and free for the raw calls below
   * to spend: a token is exactly that. */
  async function spare(sats) {
    const t = await W.sendToken(sats);
    return W.tokenInfo(t.token).proofs;
  }
  /* Blinded outputs carrying a secret of our own choosing.
   *
   * The mint cannot see what it signs — that is what blinding is — so it will
   * sign an output whose secret is any NUT-10 shape at all, including the ones
   * cashu-ts refuses to *build* (`normalizeP2PKOptions` rejects n_sigs above
   * the key count, `additionalTags` rejects reserved keys). The condition only
   * bites when the proof is spent, which is the whole point of asking a mint
   * rather than a library. */
  function outputsFor(amounts, secretOf) {
    return amounts.map(function (amt) {
      const s = u8(secretOf(amt));
      const blind = C.blindMessage(s);
      const bm = { amount: C.Amount.from(amt), B_: blind.B_.toHex(true), id: active.id };
      return { amount: amt, od: new C.OutputData(bm, blind.r, s) };
    });
  }
  /* Real proofs at this mint carrying `secret`. Whole amounts only: a swap has
   * to balance, so the outputs are (what we put in) less the input fee. */
  async function mintProofsWith(secretOf, sats) {
    const src = await spare(sats || 32);
    const outs = outputsFor(denoms(sum(src) - fee(src.length)), secretOf);
    const r = await post(M.http + '/v1/swap', {
      inputs: src.map(wireProof),
      outputs: outs.map((o) => ({ amount: o.amount, B_: o.od.blindedMessage.B_, id: o.od.blindedMessage.id })),
    });
    if (!r.ok) throw new Error('the mint would not sign the outputs: ' + r.status + ' ' + cut(r.text));
    return outs.map((o, i) => o.od.toProof(r.json.signatures[i], keyset));
  }
  /* A NUT-11 witness made by hand: a schnorr signature over the secret, filed
   * under `signatures`.
   *
   * Not `signP2PKProofs`, which asks `assertSignerAuthorised` first and quietly
   * leaves the proof UNSIGNED when the key is not one the secret names — so a
   * "wrong key" attempt through the library reaches the mint carrying no
   * witness at all, and the mint's 20008 then says nothing about signatures it
   * rejected. Whoever steals a locked token is not using our library. */
  function signedByHand(proofs, priv, preimage) {
    return proofs.map(function (p) {
      const w = {};
      if (preimage) w.preimage = preimage;
      if (priv) w.signatures = [C.schnorrSignMessage(String(p.secret), priv)];
      return Object.assign({}, p, { witness: JSON.stringify(w) });
    });
  }
  /* Try to spend `proofs` at the mint, signing with `priv` when one is given
   * (and carrying `preimage`, for NUT-14). Resolves the mint's answer verbatim.
   * Nothing of Foxy's is involved. */
  async function trySpend(proofs, priv, preimage) {
    let inputs = proofs.map(function (p) { return Object.assign({}, p); });
    if (priv || preimage) inputs = signedByHand(inputs, priv, preimage);
    const want = sum(inputs) - fee(inputs.length);
    const outs = outputsFor(denoms(want), () => nonce());
    return post(M.http + '/v1/swap', {
      inputs: inputs.map(wireProof),
      outputs: outs.map((o) => ({ amount: o.amount, B_: o.od.blindedMessage.B_, id: o.od.blindedMessage.id })),
    });
  }
  const said = (r) => (r.status ? r.status + ' ' + cut(r.text, 150) : cut(r.text, 150));

  // ---- 1. NUT-11 advertised, and canLock reading it ------------------------
  await section('1. the mint advertises NUT-11 and canLock reads it', async () => {
    const info = await getJson(M.http + '/v1/info');
    const n11 = info.nuts && (info.nuts['11'] || info.nuts[11]);
    if (!n11) throw new Error('/v1/info advertises no NUT-11: nuts = ' + cut(Object.keys(info.nuts || {}).join(','), 80));
    const req = await request(W, 21, { purpose: 'receive' });
    if (!/^0[23][0-9a-f]{64}$/i.test((req && req.lockTo) || '')) {
      throw new Error('the mint advertises NUT-11 ' + JSON.stringify(n11) + ' and Foxy’s request carries no lock');
    }
    const second = await request(W, 21, { purpose: 'receive' });
    if (!second.lockTo || second.lockTo === req.lockTo) throw new Error('two requests shared one key');
    return '/v1/info nuts.11 = ' + JSON.stringify(n11) + '; a request locks to ' +
      req.lockTo.slice(0, 12) + '…, and a second gets its own key';
  });

  await section('1b. a mint that does not advertise NUT-11 gets an unlocked request', async () => {
    const out = [];
    for (const [what, rewrite] of [
      ['no nuts.11 at all', (j) => { delete j.nuts['11']; delete j.nuts[11]; return j; }],
      ['nuts.11 supported false', (j) => { j.nuts['11'] = { supported: false }; return j; }],
    ]) {
      proxy.clear();
      proxy.add({ method: 'GET', path: '/v1/info', action: 'rewrite', times: -1, rewrite: rewrite });
      const b = await wallet(proxy.url);
      const req = await request(b.W, 21, { purpose: 'receive' });
      if (req && req.lockTo) throw new Error(what + ': the request still carries a lock ' + req.lockTo.slice(0, 12));
      out.push(what + ' → no lock');
    }
    // and the same proxy, untouched, locks again: the gate is /v1/info and nothing else
    proxy.clear();
    const b = await wallet(proxy.url);
    const req = await request(b.W, 21, { purpose: 'receive' });
    if (!(req && req.lockTo)) throw new Error('through the proxy with /v1/info untouched, the request carries no lock');
    out.push('untouched /v1/info → locked again');
    return out.join('; ');
  });

  // ---- 2. a locked send the mint signs -------------------------------------
  const paid = { req: null, made: null, proofs: [] };
  await section('2. the mint signs a real locked send', async () => {
    paid.req = await request(W, 21, { purpose: 'receive' });
    const before = await W.balanceSats();
    paid.made = await W.sendToken(21, { unit: 'sat', lockTo: paid.req.lockTo });
    const after = await W.balanceSats();
    paid.proofs = W.tokenInfo(paid.made.token).proofs;
    if (!paid.made.swapped) throw new Error('no swap was made, so nothing was locked');
    const locks = paid.proofs.map((p) => {
      const j = JSON.parse(p.secret);
      if (!Array.isArray(j) || j[0] !== 'P2PK') throw new Error('a proof is not P2PK: ' + cut(p.secret, 60));
      if (j[1].tags && j[1].tags.length) throw new Error('Foxy put tags on the lock: ' + JSON.stringify(j[1].tags));
      return j[1].data;
    });
    if (!locks.every((l) => l === paid.req.lockTo)) throw new Error('proofs locked to ' + JSON.stringify(locks));
    if (paid.made.lockedTo !== paid.req.lockTo) throw new Error('sendToken reported lockedTo ' + paid.made.lockedTo);
    const states = await statesOf(paid.proofs);
    if (!states.every((s) => s === 'UNSPENT')) throw new Error('the mint calls them ' + states.join(','));
    return paid.proofs.length + ' proof(s), ' + paid.made.sats + ' sat, every one ["P2PK",{data:' +
      paid.req.lockTo.slice(0, 12) + '…,tags:[]}] and UNSPENT at the mint; balance ' + before + ' → ' + after;
  });

  // ---- 3. the mint enforces the lock ---------------------------------------
  await section('3. the mint refuses those proofs to anyone without the key', async () => {
    if (!paid.proofs.length) throw new Error('section 2 made nothing to spend');
    const stranger = newKey();
    const bare = await trySpend(paid.proofs, null);
    const wrong = await trySpend(paid.proofs, stranger.priv);
    const still = await statesOf(paid.proofs);
    const problems = [];
    if (bare.ok) problems.push('THE MINT LET AN UNSIGNED SWAP SPEND LOCKED ECASH');
    if (wrong.ok) problems.push('THE MINT LET THE WRONG KEY SPEND LOCKED ECASH');
    if (!still.every((s) => s === 'UNSPENT')) problems.push('the refusals moved the proofs to ' + still.join(','));
    if (problems.length) {
      throw new Error(problems.join('; ') + ' — no witness: ' + said(bare) + ' | wrong key: ' + said(wrong));
    }
    // and the library will not even make that signature, which is a second wall
    let libSigned = 'made one anyway';
    try {
      const out = C.signP2PKProofs(paid.proofs.map((p) => Object.assign({}, p)), stranger.priv);
      if (!out.some((p) => p.witness)) libSigned = 'left every proof unsigned';
    } catch (e) { libSigned = 'threw: ' + cut(e.message, 40); }
    return 'no witness → ' + said(bare) + ' | a real signature from a key the lock does not name → ' +
      said(wrong) + ' | still ' + still.join(',') + ' after both; cashu-ts asked to sign with that key ' + libSigned;
  });

  // ---- 4. Foxy claims them with the key ------------------------------------
  await section('4. Foxy claims them with the key it kept', async () => {
    if (!paid.proofs.length) throw new Error('section 2 made nothing to claim');
    /* The row names an index and a public key, and holds NO private key.
     *
     * The lock key is derived from the seed on the phone, so
     * `foxy.req.lockkeys` keeps `{i, pub}` and the private half never reaches
     * the page except at the moment it opens money. A row carrying a `key` here
     * would mean the old random-key path had come back, which is the path where
     * a lost phone meant ecash nobody could ever move. */
    const kept = JSON.parse(A.w.localStorage.getItem('foxy.req.lockkeys') || '{}')[paid.req.id];
    if (!kept) throw new Error('the request kept no row');
    if (kept.key) throw new Error('the row holds a private key: the seed-derived path is not being used');
    if (!Number.isInteger(kept.i) || kept.i < 0) throw new Error('the row names no derivation index: ' + JSON.stringify(kept));
    if (String(kept.pub || '').toLowerCase() !== String(paid.req.lockTo || '').toLowerCase()) {
      throw new Error('the row\'s public key is not the one the request went out with');
    }
    const before = await W.balanceSats();
    const got = await W.receiveToken(paid.made.token);      // no key named: it finds its own
    const after = await W.balanceSats();
    const want = paid.made.sats - fee(paid.proofs.length);
    if (got.sats !== want || after - before !== want) {
      throw new Error('claimed ' + got.sats + ' of ' + paid.made.sats + ' (fee ' + fee(paid.proofs.length) +
        ' on ' + paid.proofs.length + ' proofs), balance +' + (after - before));
    }
    const states = await statesOf(paid.proofs);
    if (!states.every((s) => s === 'SPENT')) throw new Error('after the claim the mint calls them ' + states.join(','));
    let again = null;
    try { await W.receiveToken(paid.made.token); } catch (e) { again = e; }
    if (!again) throw new Error('the same locked token was claimed twice');
    return 'the row is {i: ' + kept.i + ', pub: ' + String(kept.pub).slice(0, 12) + '…} and holds no private key; ' +
      'balance ' + before + ' → ' + after + ' (+' + want + ' = ' + paid.made.sats + ' less the ' +
      fee(paid.proofs.length) + ' sat input fee); the mint now calls them SPENT; a second claim refused: ' +
      cut(again.message, 60);
  });

  // ---- 5. the shapes Foxy refuses, as real proofs this mint signed ---------
  await section('5. the adversarial shapes: what Foxy does, and what the mint does', async () => {
    const ours = newKey();
    const theirs = newKey();
    const past = String(Math.floor(Date.now() / 1000) - 3600);
    const soon = String(Math.floor(Date.now() / 1000) + 3600);
    const htlc = C.createHTLCHash(crypto.randomBytes(32).toString('hex'));
    /* `witness`: whose key the raw spend is signed with — '' for none.
     * `mint`: what a mint that honours NUT-11 must do with that attempt. Each
     * shape names this phone, so every one of them passes a naive "is it
     * locked to us" test; what differs is who else can spend it. */
    const shapes = [
      { what: 'a key of ours beside the payer’s', kind: 'P2PK', data: ours.pub,
        tags: [['pubkeys', theirs.pub]], tries: [['the payer’s key', theirs.priv, 'accepts']] },
      { what: 'a locktime already past, no refund', kind: 'P2PK', data: ours.pub,
        tags: [['locktime', past]], tries: [['no witness at all', '', 'accepts']] },
      { what: 'a locktime already past, with a refund to them', kind: 'P2PK', data: ours.pub,
        tags: [['locktime', past], ['refund', theirs.pub]],
        tries: [['no witness at all', '', 'refuses'], ['the payer’s key', theirs.priv, 'accepts']] },
      { what: 'n_sigs 2 beside the payer’s key, and we have one', kind: 'P2PK', data: ours.pub,
        tags: [['pubkeys', theirs.pub], ['n_sigs', '2']], tries: [['our key', ours.priv, 'refuses']] },
      { what: 'n_sigs 2 with our one key (malformed)', kind: 'P2PK', data: ours.pub,
        tags: [['n_sigs', '2']], tries: [['our key', ours.priv, 'refuses']] },
      { what: 'sigflag SIG_ALL', kind: 'P2PK', data: ours.pub,
        tags: [['sigflag', 'SIG_ALL']], tries: [['our key, signed per input', ours.priv, 'refuses']] },
      { what: 'a locktime still to come, no refund', kind: 'P2PK', data: ours.pub,
        tags: [['locktime', soon]], tries: [['no witness at all', '', 'refuses'], ['our key', ours.priv, 'accepts']] },
      { what: 'an HTLC naming us', kind: 'HTLC', data: htlc.hash, tags: [['pubkeys', ours.pub]],
        tries: [['our key, no preimage', ours.priv, 'refuses'],
          /* and the same proofs with the preimage, so the refusal above is
           * shown to be about the preimage and not about a shape the mint
           * could not read: this is money, it is claimable, and it is not
           * ours however loudly the `pubkeys` tag says our name. */
          ['our key and the preimage', ours.priv, 'accepts', htlc.preimage]] },
    ];
    const lines = [];
    const bad = [];
    for (const s of shapes) {
      const secret = () => JSON.stringify([s.kind, { nonce: nonce(), data: s.data, tags: s.tags }]);
      const proofs = await mintProofsWith(secret, 32);
      // Foxy, handed the very key the lock names
      let no = null;
      try { await W.receiveToken(C.getEncodedToken({ mint: M.https, proofs: proofs, unit: 'sat' }),
        { unlockWith: ours.priv }); } catch (e) { no = e; }
      const foxy = no ? 'refused (' + cut(no.message, 46) + ')' : 'TOOK IT';
      if (!no) bad.push('FOXY ACCEPTED ' + s.what);
      // the mint, on the same money
      const got = [];
      for (const [label, priv, expect, preimage] of s.tries) {
        const r = await trySpend(proofs, priv, preimage);
        got.push(label + ' → ' + (r.ok ? 'ACCEPTED' : 'refused ' + said(r)));
        if ((expect === 'accepts') !== !!r.ok) {
          bad.push('THE MINT DISAGREES on "' + s.what + '": with ' + label + ' it ' +
            (r.ok ? 'ACCEPTED the spend' : 'refused it') + ', NUT-11 says it should ' + expect +
            ' — mint said: ' + said(r));
        }
      }
      lines.push('\n      • ' + s.what + ': Foxy ' + foxy + '; mint ' + got.join(', '));
    }
    if (bad.length) throw new Error(bad.join(' || ') + lines.join(''));
    return 'Foxy refused all ' + shapes.length + ', the mint behaved as NUT-11 says on every attempt:' + lines.join('');
  });

  // ---- 6. the locktime boundary -------------------------------------------
  /* A proof carrying a locktime and no refund is spendable by its key until the
   * locktime, and by ANYONE after it. Merged NUT-11 puts the boundary itself on
   * the locked side (`now <= locktime` is still locked); cashu-ts's
   * `getP2PKExpectedWitnessPubkeys` treats `now == locktime` as expired.
   *
   * One attempt cannot tell a mint's rule from a clock a second out, so this
   * maps the whole boundary: the same locktime, five sets of real proofs, an
   * unsigned spend fired at each offset. The mint's own clock is read where it
   * publishes one, so a skew explanation can be checked rather than assumed.
   * Foxy is on neither side of this argument — it refuses any locktime at all
   * and asks for none — which is what the section proves about Foxy. */
  await section('6. now == locktime: the mint, cashu-ts and Foxy', async () => {
    const ours = newKey();
    const OFFSETS = [-5, -1, 0, 1, 5];
    const T = Math.floor(Date.now() / 1000) + 25;      // room to mint every set first
    const secret = () => JSON.stringify(['P2PK', { nonce: nonce(), data: ours.pub, tags: [['locktime', String(T)]] }]);
    const sets = {};
    for (const off of OFFSETS) sets[off] = await mintProofsWith(secret, 32);
    if (Math.floor(Date.now() / 1000) >= T) throw new Error('minting the sets took longer than the locktime');

    // the mint's own clock, where it publishes one (Nutshell does, cdk-mintd does not)
    const info = await getJson(M.http + '/v1/info');
    const skew = Number(info && info.time) ? Number(info.time) - Math.floor(Date.now() / 1000) : null;

    // Foxy, well before the locktime, holding the very key the lock names
    let no = null;
    try { await W.receiveToken(C.getEncodedToken({ mint: M.https, proofs: sets[5], unit: 'sat' }),
      { unlockWith: ours.priv }); } catch (e) { no = e; }
    if (!no) throw new Error('Foxy took ecash carrying a locktime');
    const foxy = 'refused (' + cut(no.message, 44) + ')';

    const rows = [];
    const took = {};
    for (const off of OFFSETS) {
      // fire early in the second, so the mint handles it inside the second we mean
      while (Date.now() < (T + off) * 1000) await sleep(5);
      const sentAt = Date.now();
      const r = await trySpend(sets[off], null);
      took[off] = !!r.ok;
      rows.push('locktime' + (off >= 0 ? '+' : '') + off + 's ' + (r.ok ? 'ACCEPTED' : 'refused') +
        ' (fired ' + ((sentAt - (T + off) * 1000) / 1000).toFixed(2) + 's into the second)');
    }
    const ctsAt = C.getP2PKExpectedWitnessPubkeys(sets[0][0].secret);
    const ctsSays = Array.isArray(ctsAt) && ctsAt.length ? 'still locked to ' + ctsAt.length + ' key(s)'
      : 'expired: no key can be expected';

    /* What Foxy depends on: a locktime does lock, and it does expire. A mint
     * that got either of those wrong would make a locktime meaningless, and
     * `hasLocktime` refusing every one of them the only thing between this
     * wallet and a payer who takes the money back. */
    if (took[-5] || took[-1]) throw new Error('the mint let an unsigned spend through BEFORE the locktime: ' + rows.join('; '));
    if (!took[5]) throw new Error('the mint never let the locktime expire: ' + rows.join('; '));
    /* And the boundary itself. Foxy is unaffected either way, so this is the
     * mint's business and not a failure here — but it is a real difference
     * between two mints on the same machine at the same second, and it is
     * printed where nobody can miss it. */
    if (took[0]) {
      R.log('      !!! MINT DIVERGENCE: ' + M.name + ' treats now == locktime as EXPIRED and let an unsigned');
      R.log('      !!! spend through at exactly the locktime. Merged NUT-11 says now <= locktime is still');
      R.log('      !!! locked, and ' + (key === 'cdk' ? 'Nutshell' : 'CDK') + ' on this machine refuses the same request.');
      R.log('      !!! Foxy is unaffected: it refuses every locktime and asks for none.');
    }
    return 'locktime ' + T + (skew === null ? ' (the mint publishes no clock of its own)'
      : ', the mint’s own clock ' + (skew === 0 ? 'agreed to the second' : skew + 's from ours')) +
      '; mint: ' + rows.join(', ') + '; cashu-ts at the boundary: ' + ctsSays + '; Foxy ' + foxy +
      (took[0] ? ' — SEE THE DIVERGENCE ABOVE' : ' (mint and merged NUT-11 agree: the boundary is still locked)');
  });

  // ---- 7. a locked send whose answer is lost --------------------------------
  /* The one question no local test can answer: does a real mint take a proof that
   * one wallet locked, signed, and gave to another?
   *
   * NUT-11 says the witness authorises the spend, and with SIG_INPUTS the signature
   * commits to the inputs only — nothing about who creates the outputs. So it
   * should. The harness mint agrees, but it verifies with cashu-ts's own verifier
   * and so shares code with the signer; CDK and Nutshell do not. */
  await section('8. ecash locked to one wallet, signed and handed to another', async () => {
    const giver = await wallet(M.https, 300);
    const taker = await wallet(M.https, 0);
    if (!((await giver.W.primeLocks()) > 0)) throw new Error('the giver derived no lock keys');

    const req = await request(giver.W, 21, { purpose: 'receive' });
    if (!(req && req.lockTo)) throw new Error('the request carries no lock');
    const locked = await giver.W.sendToken(21, { unit: 'sat', lockTo: req.lockTo });
    const lockedBits = giver.W.tokenInfo(locked.token);
    if (!lockedBits.proofs.every((pr) => String(pr.secret).charAt(0) === '[')) {
      throw new Error('the ecash is not locked');
    }
    const flag = giver.w.CashuTS.getP2PKSigFlag
      ? giver.w.CashuTS.getP2PKSigFlag(lockedBits.proofs[0].secret) : 'not read';
    R.log('      • the lock Foxy writes is ' + flag + ' — which is what makes handing it on possible');

    /* Signed here, by the wallet the lock names, with no mint involved. */
    const fwd = await giver.W.forwardLocked(locked.token);
    const fwdBits = giver.W.tokenInfo(fwd.token);
    if (!fwdBits.proofs.every((pr) => !!pr.witness)) throw new Error('no witness on the forwarded proofs');
    const before = await taker.W.balanceSats();

    /* And now the real mint decides. */
    await taker.W.receiveToken(fwd.token, { hash: 'live-forward' });
    const after = await taker.W.balanceSats();
    const got = after - before;
    if (got !== 21) throw new Error('the taker gained ' + got + ' rather than 21');

    const states = await statesOf(lockedBits.proofs);
    if (!states.every((st) => st === 'SPENT')) {
      throw new Error('the mint does not consider the forwarded proofs spent: ' + states.join(','));
    }
    R.log('      • ' + M.name + ' accepted it: the taker gained ' + got
      + ' sat, and the original proofs are ' + states.join('/'));

    /* And the giver cannot hand the same proofs to somebody else. */
    let again = '';
    try { await giver.W.forwardLocked(locked.token); } catch (e) { again = e.message; }
    if (!/already been handed on/i.test(again)) {
      throw new Error('the same ecash was handed on twice: ' + cut(again, 90));
    }

    /* A witness that does not verify must not buy anything, at the mint either.
     * A second locked token, signed and never handed over, so the proofs the mint
     * judges are unspent and the signature is the only thing wrong with them. */
    const req2 = await request(giver.W, 13, { purpose: 'receive' });
    const locked2 = await giver.W.sendToken(13, { unit: 'sat', lockTo: req2.lockTo });
    const fwd2 = await giver.W.forwardLocked(locked2.token);
    const forgedProofs = giver.W.tokenInfo(fwd2.token).proofs.map((pr) => Object.assign({}, pr));
    const sigs = JSON.parse(forgedProofs[0].witness).signatures;
    sigs[0] = (String(sigs[0])[0] === 'a' ? 'b' : 'a') + String(sigs[0]).slice(1);
    forgedProofs[0].witness = JSON.stringify({ signatures: sigs });
    /* On ecash that has never been spent, and with real outputs, so the swap is
     * well formed in every way except the signature.
     *
     * Two earlier versions of this passed without testing anything. With
     * `outputs: []` Nutshell answered "no outputs provided"; forging the token
     * that had just been redeemed, it answered "proofs already spent". Both are
     * refusals, neither is the one being asked about. */
    const forgedIn = forgedProofs.map(wireProof);
    const forgedOuts = outputsFor(denoms(sum(forgedProofs) - fee(forgedProofs.length)),
      () => 'forged-' + nonce());
    const forgedRes = await post(M.http + '/v1/swap', {
      inputs: forgedIn,
      outputs: forgedOuts.map((o) => ({ amount: o.amount, B_: o.od.blindedMessage.B_, id: o.od.blindedMessage.id })),
    });
    if (forgedRes.status === 200) throw new Error('the mint took a forged witness');
    const why = cut(JSON.stringify(forgedRes.json), 90);
    /* The proofs are spent by now, so "already spent" is a legitimate refusal and
     * not the one being tested. Either way it is refused; the log says which. */
    R.log('      • a turned signature is refused by the mint too: ' + forgedRes.status + ' ' + why);
  });

  await section('9. one piece signed out of a larger locked payment, and the rest claimed later', async () => {
    /* What an offline phone does: a payment locked to it is
     * spent piece by piece. Each piece carries its own lock and its own
     * signature, so the mint should take a piece alone and still honour the
     * others afterwards. The in-repo mint verifies with the wallet's own
     * library; this asks mints that do not. */
    const giver = await wallet(M.https, 300);
    const taker = await wallet(M.https, 0);
    if (!((await giver.W.primeLocks()) > 0)) throw new Error('the giver derived no lock keys');
    const req = await request(giver.W, 28, { purpose: 'receive' });
    if (!(req && req.lockTo)) throw new Error('the request carries no lock');
    const locked = await giver.W.sendToken(28, { unit: 'sat', lockTo: req.lockTo });
    const all = giver.W.tokenInfo(locked.token).proofs;
    if (all.length < 2) throw new Error('28 sats came as one piece, so there is nothing to split: ' + all.length);
    const amt = (pr) => Number(pr.amount);
    const small = all.filter((pr) => amt(pr) < 16), big = all.filter((pr) => amt(pr) >= 16);
    if (!small.length || !big.length) throw new Error('unexpected pieces: ' + all.map(amt).join('+'));
    const mintUrl = String(giver.W.tokenInfo(locked.token).mint || '').replace(/\/+$/, '');
    const enc = (proofs) => giver.w.CashuTS.getEncodedToken({ mint: mintUrl, proofs: proofs, unit: 'sat' });

    // the small pieces alone, signed and handed on
    const part = await giver.W.forwardLocked(enc(small));
    const partSats = small.reduce((n, pr) => n + amt(pr), 0);
    if (part.sats !== partSats) throw new Error('handed on ' + part.sats + ' rather than ' + partSats);
    const before = await taker.W.balanceSats();
    await taker.W.receiveToken(part.token, { hash: 'live-part' });
    const got = (await taker.W.balanceSats()) - before;
    if (got !== partSats - fee(small.length)) {
      throw new Error('the taker gained ' + got + ' for pieces worth ' + partSats);
    }
    const afterPart = await statesOf(all);
    const spentNow = all.filter((pr, i) => afterPart[i] === 'SPENT').map(amt).sort((a, b) => a - b).join('+');
    if (spentNow !== small.map(amt).sort((a, b) => a - b).join('+')) {
      throw new Error('the mint spent ' + spentNow + ', not just the pieces handed on');
    }
    R.log('      • ' + M.name + ' took ' + small.map(amt).join('+') + ' alone; '
      + big.map(amt).join('+') + ' is still unspent');

    // the same pieces cannot be signed away again
    let again = '';
    try { await giver.W.forwardLocked(enc(small)); } catch (e) { again = e.message; }
    if (!/already been handed on/i.test(again)) throw new Error('the same pieces were handed on twice: ' + cut(again, 90));

    // and what is left is still the giver's to claim with its key
    const mine = await giver.W.balanceSats();
    await giver.W.receiveToken(enc(big), { hash: 'live-rest' });
    const kept = (await giver.W.balanceSats()) - mine;
    const bigSats = big.reduce((n, pr) => n + amt(pr), 0);
    if (kept !== bigSats - fee(big.length)) throw new Error('the giver kept ' + kept + ' of ' + bigSats);
    const end = await statesOf(all);
    if (!end.every((st) => st === 'SPENT')) throw new Error('not all spent at the end: ' + end.join(','));
    R.log('      • and the rest was claimed afterwards: ' + kept + ' sat, every piece now ' + end[0]);
  });

  await section('7. a lost swap answer on a locked send, recovered by NUT-09 restore', async () => {
    proxy.clear();
    proxy.log.length = 0;
    const b = await wallet(proxy.url, 400);
    const before = await b.W.balanceSats();
    const req = await request(b.W, 21, { purpose: 'receive' });
    if (!(req && req.lockTo)) throw new Error('the request through the proxy carries no lock');
    proxy.add({ method: 'POST', path: '/v1/swap', action: 'drop-after', times: 1 });
    let made = null, threw = null;
    try { made = await b.W.sendToken(21, { unit: 'sat', lockTo: req.lockTo }); } catch (e) { threw = e; }
    const swap = proxy.last('POST', '/v1/swap');
    if (!swap || swap.upstream !== 200) throw new Error('the mint never processed the swap (upstream ' + (swap && swap.upstream) + ')');
    if (threw) throw new Error('the send failed after the mint had acted: ' + cut(threw.message, 120));
    if (!made || !made.token) throw new Error('no token came back');
    const restores = proxy.count('POST', '/v1/restore');
    if (!restores) throw new Error('the payment came back without asking the mint what it had signed (no /v1/restore)');
    const proofs = b.W.tokenInfo(made.token).proofs;
    const locks = proofs.map((p) => { try { return JSON.parse(p.secret)[1].data; } catch (e) { return ''; } });
    if (!locks.length || !locks.every((l) => l === req.lockTo)) throw new Error('the rebuilt proofs are locked to ' + JSON.stringify(locks));
    if (new Set(proofs.map((p) => p.secret)).size !== proofs.length) throw new Error('the rebuilt token repeats a proof');
    if (made.sats !== sum(proofs) || made.sats < 21) throw new Error('the rebuilt token is ' + made.sats + ' sat over ' + proofs.length + ' proofs');
    const states = await statesOf(proofs);
    if (!states.every((s) => s === 'UNSPENT')) throw new Error('the mint calls the rebuilt proofs ' + states.join(','));
    const left = JSON.parse(b.w.localStorage.getItem('foxy.cashu.swaps') || '[]');
    if (left.length) throw new Error(left.length + ' swap record(s) left behind');
    // and the money is real: the receiver's key opens it
    const claimed = await b.W.receiveToken(made.token);
    const after = await b.W.balanceSats();
    if (claimed.sats !== made.sats - fee(proofs.length)) throw new Error('claimed ' + claimed.sats + ' of ' + made.sats);
    const lost = before - (after - claimed.sats) - made.sats;
    if (lost < 0 || lost > 4) throw new Error('balance ' + before + ' → ' + (after - claimed.sats) + ' with a ' + made.sats + ' sat token: ' + lost + ' sat unaccounted for');
    return 'the mint swapped and the answer was dropped; ' + restores + ' /v1/restore call(s) brought the payment back as ' +
      made.sats + ' sat in ' + proofs.length + ' proof(s), all locked to ' + req.lockTo.slice(0, 12) +
      '… and UNSPENT; change kept (' + lost + ' sat to fees); the key then claimed ' + claimed.sats + '; ' +
      (b.rec.log.filter((l) => /lost locked send/.test(l))[0] || 'nothing logged about the recovery');
  });

  await proxy.close();
  return R.failed();
}

(async () => {
  let failures = 0;
  for (const key of keys) {
    try { failures += (await run(key)).length; } catch (e) {
      failures++;
      console.log('[p2pk ' + key + '] FAIL  run — ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
    }
  }
  console.log(H.phoneReport());
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) failures++;
  console.log(failures ? failures + ' FAILED' : 'all steps OK');
  process.exit(failures ? 1 : 0);
})();
