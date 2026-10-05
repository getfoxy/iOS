
  /* ---- is the mint answering? --------------------------------------------
   *
   * Ecash can only ever be redeemed at the mint that issued it, so a mint that
   * stops answering is the one risk a balance cannot route around. This keeps,
   * per mint, when it last answered and how long it has been silent, so the app
   * can say so plainly (build/app/11-mint-risk.js).
   *
   *   foxy.mint.health  { [mint]: { lastOk, failures, firstFailAt, lastFailAt } }
   *
   * nativeRequest reports every mint request here:
   * - an answer, whatever its status — a 400 refusal is a mint that is there
   *   and deciding — is OK, and clears the record;
   * - no answer (a transport error, a timeout), or 502, 503 or 504, which a
   *   proxy sends for a mint behind it that is gone, is a failure;
   * - a request this side refused before sending (Tor not connected, an
   *   address Foxy will not use) is neither: nothing reached the mint.
   *
   * A failure is counted ONLY while Tor is shown to be carrying traffic: the
   * route says Tor is up, and something else answered over it in the last
   * three minutes — the price source, or a different mint. A Tor outage fails
   * every host at once, so it can never be put on the mint.
   *
   * Failures less than a minute after the last counted one are the same
   * attempt: cashu-ts sends several requests together, and a burst of them is
   * not three separate tries. */

  var MINT_HEALTH_KEY = 'foxy.mint.health';
  var MINT_DOWN_FAILURES = 3;             // counted failures in a row…
  var MINT_DOWN_SPAN_MS = 10 * 60000;     // …from the first to the latest at least this long
  var TOR_EVIDENCE_MS = 3 * 60000;        // "something else got through" means this recently
  var FAIL_BURST_MS = 60000;              // failures closer together than this count once

  var answeredAt = {};   // mint -> when it last answered; this session only

  /* The mint an endpoint belongs to: cashu-ts asks for <mint>/v1/... */
  function mintOfEndpoint(endpoint) {
    var s = String(endpoint || '');
    var i = s.indexOf('/v1/');
    return canonicalMint(i > 0 ? s.slice(0, i) : s);
  }

  /* Is Tor getting requests to somewhere other than this mint through? */
  function torCarrying(mint, now) {
    if (privacy.tor !== 'up') return false;
    var recent = function (t) { return t > 0 && now - t >= 0 && now - t < TOR_EVIDENCE_MS; };
    if (recent(Number(FoxyWallet._rateAt) || 0)) return true;
    for (var other in answeredAt) {
      if (other !== mint && recent(answeredAt[other])) return true;
    }
    return false;
  }

  /* 'ok', 'fail', or 'skip' for a refusal on this side. */
  function classifyAnswer(code, error) {
    if (error) {
      var m = String((error && error.message) || error);
      if (/not connected to Tor|not a mint address Foxy will use|needs the app/i.test(m)) return 'skip';
      return 'fail';
    }
    return (code === 0 || code === 502 || code === 503 || code === 504) ? 'fail' : 'ok';
  }

  function mintDownRecord(rec) {
    return !!rec && (Number(rec.failures) || 0) >= MINT_DOWN_FAILURES
      && (Number(rec.lastFailAt) || 0) - (Number(rec.firstFailAt) || 0) >= MINT_DOWN_SPAN_MS;
  }

  /* Record one outcome. Never throws: it rides on every mint request. */
  function noteMintAnswer(endpoint, outcome, now) {
    try {
      var t = typeof now === 'number' ? now : Date.now();
      var mint = mintOfEndpoint(endpoint);
      if (!mint || (outcome !== 'ok' && outcome !== 'fail')) return null;
      var all = load(MINT_HEALTH_KEY, {});
      if (!all || typeof all !== 'object') all = {};
      var prev = all[mint] || null;

      if (outcome === 'ok') {
        answeredAt[mint] = t;
        // one write a minute is enough to keep lastOk honest; a cleared failure writes at once
        if (!prev || prev.failures || t - (Number(prev.lastOk) || 0) >= FAIL_BURST_MS) {
          all[mint] = { lastOk: t, failures: 0, firstFailAt: 0, lastFailAt: 0 };
          save(MINT_HEALTH_KEY, all);
        }
        return all[mint];
      }

      if (!torCarrying(mint, t)) {
        console.log('[foxy] no answer from', hostOf(mint), '\u2014 not counted: nothing shows Tor is carrying traffic');
        return prev;
      }
      if (prev && prev.failures && t - (Number(prev.lastFailAt) || 0) < FAIL_BURST_MS) return prev;
      var next = {
        lastOk: (prev && prev.lastOk) || 0,
        failures: ((prev && prev.failures) || 0) + 1,
        firstFailAt: (prev && prev.failures) ? prev.firstFailAt : t,
        lastFailAt: t,
      };
      all[mint] = next;
      save(MINT_HEALTH_KEY, all);
      // told on every counted failure while down; the app shows it once a session
      if (mintDownRecord(next) && typeof FoxyWallet._onMintDown === 'function') {
        try { FoxyWallet._onMintDown(mint, next); }
        catch (e) { console.error('[foxy] mint down:', e && e.message); }
      }
      return next;
    } catch (e) {
      return null;
    }
  }

  FoxyWallet._noteMintAnswer = noteMintAnswer;   // the transport's entry point, open for the tests
  FoxyWallet._onMintDown = null;
  /* fn(mint, record), when a counted failure leaves a mint not answering. */
  FoxyWallet.onMintDown = function (fn) { FoxyWallet._onMintDown = fn; };

  /* The stored record for a mint (the connected one by default), or null. */
  FoxyWallet.mintHealth = function (mint) {
    var all = load(MINT_HEALTH_KEY, {});
    var key = canonicalMint(mint || mintUrl);
    return (all && typeof all === 'object' && key && all[key]) || null;
  };

  /* The record, if this mint counts as not answering; otherwise null. */
  FoxyWallet.mintDown = function (mint) {
    var rec = FoxyWallet.mintHealth(mint);
    return mintDownRecord(rec) ? rec : null;
  };
