'use strict';
/* harness.js — Foxy's wallet in jsdom, shared by the live scripts in this folder.
 *
 * Web/cashu-ts.js and Web/foxy-wallet.js loaded into a jsdom page with a mocked
 * native bridge: the phone (tests/harness.js's nativePhone), which keeps the seed
 * in a keychain object and answers the whole "seed on the phone" contract
 * (build/wallet/03-seed-counters-logs.js) as the app does — seed status and
 * creation, the counters, restore secrets and candidates, and the screens
 * (restoreWords below types a candidate's words; adopting and wiping say yes) —
 * and every `mintRequest` carried out with fetch from this machine. The page has
 * no other seed path. Web/bip39.js is loaded for the phone's own use: its NUT-13
 * secrets come from the bundled bip39 and cashu-ts. Fake-money mints only:
 * 127.0.0.1/localhost with FOXY_LIVE_LOCAL=1, or testnut.
 *
 *   const H = require('./harness');
 *   const { w, W, keychain, phone, rec } = H.boot({ keychain: { words: '' } });
 *
 * `rec` records what each wallet did: mint refusals, Foxy's warnings and
 * errors, every onMintTrouble / onClaimTrouble call, and a count of requests
 * per path. nativeStats counts, over every page, the requests to the phone, the
 * secrets it sent, its refusals, every request for the words themselves (none
 * should come) and how often a page turned words into a seed itself (never). */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WALLET = process.env.FOXY_WALLET_FILE || path.join(ROOT, 'Web', 'foxy-wallet.js');

function fakeMoneyOnly(url) {
  const host = new URL(url).hostname;
  const local = process.env.FOXY_LIVE_LOCAL === '1' && (host === '127.0.0.1' || host === 'localhost');
  if (!local && !/testnut\.cashu\.space$/.test(host)) {
    throw new Error('fake-money mints only: testnut, or a mint on this Mac with FOXY_LIVE_LOCAL=1 (' + url + ')');
  }
}

const nativeStats = { requests: 0, secrets: 0, refused: 0, tooFarAhead: 0, wordsAsked: 0, pageSeedDerivations: 0 };
/* The same mock the wallet tests run on, with native's rules in one table
 * (NATIVE_RULES, NATIVE_SAYS): index-shared 00 counters, counter moves capped at
 * 100 past next or a served restore range, one import, candidates kept after
 * an adopt and dropped on a reload, and the migration window's rules. */
const { nativePhone, NATIVE_SAYS } = require('../../tests/harness');

let booted = 0;
/* A wallet page on its own phone. o.keychain is the phone's keychain ({ words },
 * '' for none: the page asks the phone to make a seed as it connects).
 * o.onMint, if given, sees every mint request this page makes before it goes
 * out: { method, path, url, body (parsed JSON or null), raw }.
 *
 * For a page that is killed and opened again (tap-scenarios.js):
 *   o.phone    the phone a page before this one ran on — its keychain and its
 *              counter file, which is what survives an app being killed
 *   o.storage  { key: value } put in localStorage before the wallet loads,
 *              which is the other thing that survives
 *   o.bridge   (m, reply) => true when it answered: the bridge actions that
 *              are neither the phone's nor a mint request — a tap link's
 *              messages, which need the other page
 *   o.net      (m, path) => 'ok' | 'before' | 'after' | 'refuse': what becomes
 *              of one mint request. 'before' never reaches the mint; 'after'
 *              reaches it and the answer is lost on the way back; 'refuse' is
 *              answered 400 without the mint being asked.
 * The page it returns has kill(): nothing it asks is answered from then on,
 * its timers stop, and snapshot() is what it had written down. */
function boot(opts) {
  const o = opts || {};
  const keychain = o.keychain || { words: '' };
  const rec = { mintSaid: [], log: [], warn: [], error: [], trouble: [], claimTrouble: [], hits: {}, lost: [] };
  // an origin of its own per wallet, so no two share localStorage
  const dom = new JSDOM('<body></body>', { runScripts: 'dangerously', url: 'https://foxy-' + (++booted) + '.test/' });
  const w = dom.window;
  w.fetch = fetch; w.Headers = Headers; w.Request = Request; w.Response = Response;
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  if (!w.crypto || !w.crypto.getRandomValues) Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
  if (!w.TextEncoder) { w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; }
  const quiet = o.quiet !== false;
  const origWarn = w.console.warn.bind(w.console);
  const origErr = w.console.error.bind(w.console);
  w.console.warn = (...a) => { rec.warn.push(a.map(String).join(' ')); if (!quiet) origWarn(...a); };
  w.console.error = (...a) => { rec.error.push(a.map(String).join(' ')); if (!quiet) origErr(...a); };
  const origLog = w.console.log.bind(w.console);
  w.console.log = (...a) => { rec.log.push(a.map(String).join(' ')); if (!quiet) origLog(...a); };
  /* The phone the last page ran on, as it is after the app was killed: the
   * keychain, the counter files and the lock file are on disk and survive;
   * what the app session held — served ranges, a seed in memory — does not.
   * (The seed is also derived by the page's own copy of the libraries, so one
   * from a page that is gone is no use to this one.) */
  let phone;
  if (o.phone) {
    phone = nativePhone({ keychain: o.phone.keychain, migration: false });
    phone.counters = o.phone.counters;
    phone.locks = o.phone.locks;
    phone.imported = o.phone.imported;
  } else {
    phone = nativePhone({ keychain });
  }
  if (o.storage) for (const k of Object.keys(o.storage)) w.localStorage.setItem(k, o.storage[k]);
  const life = { dead: false };
  const reply = (id, text, err) => setTimeout(() => {
    if (life.dead) return;
    try { w.FoxyWallet._scanResult(id, text, err); } catch (e) {}
  }, 0);
  w.webkit = { messageHandlers: { foxy: { postMessage: async (m) => {
    if (life.dead) return;
    const asked = phone.answer(w, m);
    if (asked) {
      // a seed screen still open answers when it closes
      const got = await asked;
      nativeStats.requests++;
      if (/^seed(Read|Write|Delete|Secrets)$/.test(m.action)) nativeStats.wordsAsked++;
      if (got[1]) {
        nativeStats.refused++;
        // native's cap on counter moves: no normal flow should ever meet it
        if (got[1] === NATIVE_SAYS.ahead) nativeStats.tooFarAhead++;
      } else if (/^(counterReserve|counterReserveAt|restoreSecrets)$/.test(m.action)) nativeStats.secrets += m.count;
      return reply(m.id, got[0], got[1]);
    }
    if (m.action === 'mintRequest') {
      /* A real mint, with real money, is reached only when all three are
       * true: the run was started with FOXY_LIVE_REAL=1, the test named the
       * host, and it brought its own way there (`o.real.send`, which goes
       * through Tor as the app does — production.md). Everything else is
       * still fake money only. */
      const real = (o.real && process.env.FOXY_LIVE_REAL === '1' && typeof o.real.send === 'function'
        && (o.real.hosts || []).indexOf(new URL(m.url).hostname) >= 0) ? o.real : null;
      if (!real) { try { fakeMoneyOnly(m.url); } catch (e) { return reply(m.id, null, 'blocked host'); } }
      const p = new URL(m.url).pathname.replace(/\/[0-9a-f-]{20,}$/i, '/:id');
      const key = m.method + ' ' + p;
      rec.hits[key] = (rec.hits[key] || 0) + 1;
      /* Every request this wallet makes, body and all, before it goes out.
       * `rec.hits` counts paths; a test that has to see what Foxy PUT IN a
       * request — how many Ys one /v1/checkstate carried, say — needs the body
       * itself. o.onMint({ method, path, url, body }) gets it, parsed when it
       * is JSON. Only watching: what it returns is ignored, and a hook that
       * throws must not take the request down with it. */
      if (o.onMint) {
        let parsed = null;
        try { parsed = m.body ? JSON.parse(m.body) : null; } catch (e) { parsed = null; }
        try { o.onMint({ method: m.method, path: p, url: m.url, body: parsed, raw: m.body }); }
        catch (e) { rec.warn.push('onMint hook threw: ' + ((e && e.message) || e)); }
      }
      const fate = o.net ? (o.net(m, p) || 'ok') : 'ok';
      if (fate === 'before') return reply(m.id, null, 'The Internet connection appears to be offline.');
      // 'refuse': the mint is never asked and the page hears a refusal, as a mint that will not do this would give
      if (fate === 'refuse') return reply(m.id, '400\n' + JSON.stringify({ detail: 'This mint is not taking swaps.', code: 11000 }));
      try {
        const r = real ? await real.send(m)
          : await fetch(m.url, { method: m.method, headers: { 'content-type': 'application/json' },
              body: m.method === 'GET' ? undefined : m.body });
        const text = real ? String(r.text) : await r.text();
        // what a lost answer was: the test's to read, never the page's
        if (fate !== 'ok') rec.lost.push({ path: p, status: r.status, text: text.slice(0, 160) });
        if (fate === 'after') return reply(m.id, null, 'The network connection was lost.');
        if (r.status >= 400) rec.mintSaid.push(r.status + ' ' + new URL(m.url).pathname + ' ' + text.slice(0, 200));
        return reply(m.id, r.status + '\n' + text);
      } catch (e) { return reply(m.id, null, (e.cause && e.cause.code) || e.message); }
    }
    if (o.bridge) { try { if (o.bridge(m, reply)) return; } catch (e) { rec.warn.push('bridge hook threw: ' + ((e && e.message) || e)); } }
  } } } };
  for (const f of ['bip39.js', 'cashu-ts.js']) {
    const s = w.document.createElement('script');
    s.textContent = fs.readFileSync(path.join(ROOT, 'Web', f), 'utf8');
    w.document.body.appendChild(s);
  }
  phone.attach(w);     // the phone's own bip39 and cashu-ts, before the page's copy is counted
  // the bundle's exports are getters, so the page gets a copy with one counted
  const B = w.FoxyBip39;
  const real = B.mnemonicToSeedSync;
  w.FoxyBip39 = { generateMnemonic: B.generateMnemonic, mnemonicToSeed: B.mnemonicToSeed,
    validateMnemonic: B.validateMnemonic, wordlist: B.wordlist,
    mnemonicToSeedSync: function () { nativeStats.pageSeedDerivations++; return real.apply(null, arguments); } };
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(WALLET, 'utf8');
  w.document.body.appendChild(s);
  const W = w.FoxyWallet;
  W._privacy({ tor: 'up', progress: 100, everUp: true });
  W.onMintTrouble((t) => rec.trouble.push(t));
  W.onClaimTrouble((t) => rec.claimTrouble.push(t));
  const snapshot = () => {
    const all = {};
    for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); all[k] = w.localStorage.getItem(k); }
    return all;
  };
  /* Killed, as iOS kills it: mid-sentence. What it wrote is kept; what it was
   * waiting for never arrives, and it asks nothing more. */
  const kill = () => {
    const kept = snapshot();
    life.dead = true;
    try { w.close(); } catch (e) {}
    return kept;
  };
  return { w, W, keychain, rec, phone, snapshot, kill, life };
}

/* Scan a wallet's words at `urls` from Foxy, and adopt what was found: the
 * words typed on the mocked phone (seedEnter) and scanned and adopted by their
 * candidate, never reaching the page. `b` is a booted wallet. The real phone's
 * screen takes twelve words; the mock takes any valid phrase, which lets a
 * 24-word seed from another wallet be restored here.
 * Resolves { rows, adopt(opts) }. */
async function restoreWords(b, words, urls) {
  b.phone.hooks.enter = () => words;
  const candidate = await b.W.enterSeedNative();
  if (!candidate) throw new Error('the phone did not take the words');
  const rows = await b.W.scanSeed({ candidate }, urls);
  return { rows, adopt: (o) => b.W.adoptScan(rows, Object.assign({ candidate }, o || {})) };
}

/* A restore of `words` at `urls` in a wallet that never saw them: a fresh page
 * on a fresh phone, scanning only. Resolves the rows. */
async function scanFresh(words, urls) {
  return (await restoreWords(boot({ keychain: { words: '' } }), words, urls)).rows;
}

/* Proofs held, over every mint's pile. */
function pile(w) {
  let all = [];
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    if (/^foxy\.cashu\.proofs\./.test(k)) all = all.concat(JSON.parse(w.localStorage.getItem(k) || '[]'));
  }
  return all;
}
const feeFor = (n, ppk) => Math.ceil((n * (ppk == null ? 100 : ppk)) / 1000);

/* A booted wallet's counters, { keysetId: next }: the phone's, for the seed it
 * holds. The page keeps none. */
const counters = (b) => b.phone.countersNow();
/* Put the phone's counters back to `c`, as a phone whose counter file fell
 * behind would have them. The app never lowers one; this is the test's doing.
 * `c` is a snapshot, keyed as the phone keys its file. */
const setCounters = (b, c) => b.phone.counters.set(b.keychain.words, new Map(Object.entries(c)));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* Ask for an invoice, let the fake wallet pay it, and resolve with what the watch claimed. */
async function mintAndClaim(W, sats, ms) {
  const inv = await W.invoice(sats, '');
  const claimed = await new Promise((ok, no) => {
    const t = setTimeout(() => { stop(); no(new Error('not claimed within ' + ((ms || 90000) / 1000) + 's')); }, ms || 90000);
    const stop = W.watch(inv.hash, (r) => { clearTimeout(t); ok(r.sats); }, {
      pollMs: 1000, onError: (e) => { clearTimeout(t); stop(); no(e); },
    });
  });
  return { inv, claimed };
}

async function waitFor(fn, ms, every) {
  const end = Date.now() + (ms || 30000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(every || 1000);
  }
}

/* A mint quote straight from a mint's http port, not through Foxy: a real,
 * signed bolt11 invoice from that mint's fake Lightning node, with a chosen
 * description. Paid from the other mint it is an external payment (fee reserve,
 * change); CDK's fake wallet reads a JSON description to decide the outcome. */
async function rawInvoice(httpBase, sats, description) {
  const r = await fetch(httpBase + '/v1/mint/quote/bolt11', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: sats, unit: 'sat', description: description || undefined }),
  });
  const j = await r.json();
  if (!j.request) throw new Error('no invoice from ' + httpBase + ': ' + JSON.stringify(j));
  return j.request;
}

const CDK_PENDING = JSON.stringify({ pay_invoice_state: 'PENDING', check_payment_state: 'PENDING', pay_err: false, check_err: false });

/* The two local mints (tools/live/local-mint.sh), each with an http port for
 * the CLI and the other mint's invoices.
 *
 * A mint's name says which version answered, not which image was asked for.
 * These names go straight into the reports, and the image tag is only what
 * `docker run` was handed: a run against Nutshell 0.21.0 printed "Nutshell
 * 0.20.3", because the tag was a hardcoded default and nothing
 * ever asked the mint. `name` now reads the `version` /v1/info gave, once
 * `mintNames()` has fetched it, and falls back to the image tag — and to the
 * pin in local-mint.sh — for a mint that has not been reached. */
function imageTag(image, fallback) { return image && image.includes(':') ? image.split(':').pop() : fallback; }
function mintEntry(label, envTag, pinned, ports) {
  const e = { label: label, version: null, imageTag: imageTag(envTag, pinned) };
  Object.defineProperty(e, 'name', {
    enumerable: true,
    get: function () { return e.version ? label + ' ' + e.version : label + ' ' + e.imageTag + ' (image tag; the mint was not asked)'; },
  });
  return Object.assign(e, ports);
}
const MINTS = {
  cdk: mintEntry('CDK', process.env.CDK_IMAGE, '0.18.1',
    { https: 'https://127.0.0.1:8443', http: 'http://127.0.0.1:3338', docker: 'http://host.docker.internal:3338' }),
  nutshell: mintEntry('Nutshell', process.env.NUT_IMAGE, '0.21.0',
    { https: 'https://127.0.0.1:8444', http: 'http://127.0.0.1:3339', docker: 'http://host.docker.internal:3339' }),
};
/* Ask each named mint (all of them by default) what it is, so `name` reports the
 * version that actually ran. Straight off the http port, not through Foxy: this
 * is the report's own bookkeeping. A mint that does not answer keeps the image
 * tag, marked as such. Resolves { cdk: 'CDK 0.18.1', ... }. */
async function mintNames(keys) {
  const out = {};
  for (const k of keys || Object.keys(MINTS)) {
    const m = MINTS[k];
    if (!m) continue;
    if (!m.version) {
      try {
        const r = await fetch(m.http + '/v1/info', { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        /* Mints spell it differently: cdk-mintd sends "cdk-mintd/0.18.1",
         * Nutshell "Nutshell/0.21.0". Keep the whole string — it names the
         * implementation as well as the number — but drop a leading name that
         * only repeats the label we already print. */
        const v = String((j && j.version) || '').trim();
        if (v) m.version = v.replace(new RegExp('^(cdk-mintd|cdk|nutshell)/', 'i'), '');
        m.maxArrayLength = j && j.max_array_length;
      } catch (e) { /* left on the image tag, and said so */ }
    }
    out[k] = m.name;
  }
  return out;
}
const other = (k) => (k === 'cdk' ? 'nutshell' : 'cdk');

/* The Nutshell wallet CLI, in the nutshell image, with its data in `dir`. */
function nutshellCli(dir, mintUrl, args, input) {
  fs.mkdirSync(dir, { recursive: true });
  const out = execFileSync('sh', [path.join(__dirname, 'nutshell-cli.sh'), dir, mintUrl, ...args], {
    input: input || '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 150000,
  });
  return out;
}
function cliBalance(text) {
  const m = /Balance:\s*(\d+)\s*sat/i.exec(text);
  return m ? Number(m[1]) : null;
}

function reporter(title) {
  const rows = [];
  const log = (...a) => console.log('[' + title + ']', ...a);
  return {
    rows, log,
    ok(label, detail) { rows.push({ label, ok: true, detail }); log('OK    ' + label + (detail ? ' — ' + detail : '')); },
    fail(label, detail) { rows.push({ label, ok: false, detail }); log('FAIL  ' + label + (detail ? ' — ' + detail : '')); },
    skip(label, why) { rows.push({ label, ok: true, skipped: true, detail: why }); log('SKIP  ' + label + ' — ' + why); },
    check(label, cond, detail) { return cond ? this.ok(label, detail) : this.fail(label, detail); },
    async step(label, fn) {
      try { const d = await fn(); if (d === false) this.fail(label); else this.ok(label, typeof d === 'string' ? d : ''); }
      catch (e) { this.fail(label, String((e && e.message) || e).split('\n')[0]); }
    },
    failed() { return rows.filter((r) => !r.ok); },
  };
}

/* The phone's counts, and a check that no page asked for the words or made a
 * seed from them: every live script prints this at the end. */
function phoneReport() {
  const clean = nativeStats.wordsAsked === 0 && nativeStats.pageSeedDerivations === 0;
  return 'phone: ' + JSON.stringify(nativeStats) + (clean ? '' : ' — A PAGE ASKED FOR OR USED THE WORDS')
    + (nativeStats.tooFarAhead ? ' — A COUNTER MOVE WAS REFUSED AS TOO FAR AHEAD' : '');
}

module.exports = { ROOT, boot, counters, setCounters, pile, feeFor, sleep, mintAndClaim, waitFor, rawInvoice, CDK_PENDING, MINTS, mintNames, other,
  nutshellCli, cliBalance, reporter, fakeMoneyOnly, nativeStats, restoreWords, scanFresh, phoneReport };
