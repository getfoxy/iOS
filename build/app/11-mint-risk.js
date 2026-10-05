
  /* ---- mint risk, told plainly --------------------------------------------
   *
   * Cards about the mint itself rather than about a payment.
   *
   * MINT NOT ANSWERING. The wallet decides (build/wallet/98-mint-health.js):
   * 3 counted failures spanning 10 minutes, counted only while Tor is carrying
   * other traffic. Shown once a session per mint, and only if some of the
   * balance is at that mint. The switch list says "not answering since 10:42".
   *
   * A LOT AT ONE MINT. A nudge to spread a large balance. Its numbers: */

  // at least this many sats at the connected mint…
  SPREAD_MIN_SATS = 100000;
  // …shown at most once in this long…
  SPREAD_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
  // …remembered here as { shownAt, off }; off is "don't show this again"
  SPREAD_KEY = 'foxy.mint.spread';

  /* When a mint went quiet, for a person: "10:42", or "12 Sep 10:42" on
   * another day. Spelled out rather than locale-formatted, so it is the same
   * everywhere. */
  mintQuietSince(t, now) {
    const d = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    const time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === new Date(now || Date.now()).toDateString()) return time;
    return d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
      'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + time;
  }

  /* The line under a mint in the switch list, or '' while it is answering.
   *
   * Working offline, a mint this phone has never loaded keysets from cannot be
   * connected to at all — there is nothing to connect from — so it says so
   * instead. Said rather than left to the refusal a tap would produce: the row
   * is greyed out beside it, and a dead-looking row with no reason reads as a
   * bug. */
  mintDownText(url) {
    const W = window.FoxyWallet;
    if (this.offlineNow() && W && W.mintCached && !W.mintCached(url)) return 'needs a connection';
    const rec = W && W.mintDown ? W.mintDown(url) : null;
    return rec ? 'not answering since ' + this.mintQuietSince(rec.firstFailAt) : '';
  }

  /* Is this mint usable right now? Offline that means: its keysets are on this
   * phone. With a route, every mint is. */
  mintReachable(url) {
    const W = window.FoxyWallet;
    if (!this.offlineNow()) return true;
    return !!(W && W.mintCached && W.mintCached(url));
  }

  mintDownNotice(mint) {
    const W = window.FoxyWallet;
    const rec = W && W.mintDown ? W.mintDown(mint) : null;
    if (!rec) return;
    const sats = this.mintPile(mint).sats;
    if (!(sats > 0)) return;
    this._mintDownShown = this._mintDownShown || {};
    if (this._mintDownShown[mint]) return;
    this._mintDownShown[mint] = true;
    const host = String(mint).replace(/^https?:\/\//, '');
    this.blockedCard('mintDown:' + host, {
      tone: 'warn',
      title: 'MINT NOT ANSWERING',
      reason: host + ' has not answered since ' + this.mintQuietSince(rec.firstFailAt) + '. '
        + this.group(sats) + ' sats of your balance are there, and ecash can only ever be '
        + 'redeemed at the mint that issued it. It may come back, and if it does, the ecash '
        + 'is still good. If it never does, nothing else can recover it.',
      chip: 'Once it answers again, move some of your balance to another mint.',
    });
  }

  /* Is the concentration nudge due? Pure, so the test holds it to its numbers. */
  spreadNudgeDue(sats, host, rec, now, busy) {
    if (busy) return false;
    if (!(Number(sats) >= this.SPREAD_MIN_SATS)) return false;
    // a test mint's ecash is worth nothing; there is nothing to spread
    if (String(host || '').toLowerCase().indexOf('testnut.cashu.space') >= 0) return false;
    const r = rec || {};
    if (r.off) return false;
    return !r.shownAt || now - r.shownAt >= this.SPREAD_EVERY_MS;
  }

  spreadNudge() {
    const W = window.FoxyWallet;
    if (!W || !W.connected) return;
    // the cards walletReady queues go first; the next refresh asks again
    if (Date.now() - (this._readyAt || 0) < 5000) return;
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(this.SPREAD_KEY) || 'null'); } catch (e) {}
    const host = this.mintHost();
    const sats = this.mintPile(W.mintUrl).sats;
    // never over or ahead of something more pressing: another card, the PIN, the price card
    const busy = !!(this._blockedEl || (this._cardQueue || []).length || this._pinEl
      || (this._priceBar && this._priceBar.style.display !== 'none'));
    if (!this.spreadNudgeDue(sats, host, rec, Date.now(), busy)) return;
    const keep = (r) => { try { localStorage.setItem(this.SPREAD_KEY, JSON.stringify(r)); } catch (e) {} };
    keep({ shownAt: Date.now(), off: false });
    this.blockedCard('spread', {
      tone: 'warn',
      title: 'A LOT AT ONE MINT',
      reason: this.group(sats) + ' sats of your balance are at ' + host + '. A mint holds the '
        + 'real bitcoin behind the ecash it issues, and a mint can fail or stop paying out.',
      chip: 'Spreading your balance across a few mints means no single mint holds all of it.',
      retry: 'MOVE SOME',
      go: () => this.goSwitchMint(),
      also: { label: 'DON\u2019T SHOW THIS AGAIN', tap: () => keep({ shownAt: Date.now(), off: true }) },
    });
  }
