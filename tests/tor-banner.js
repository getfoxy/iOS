'use strict';
/* tor-banner.js — the home banner says only what is true of the route.
 *
 *     node tests/tor-banner.js
 *
 * torBannerVals from build/foxy-app.js. The banner used to be fixed markup:
 * "Secure Tor Connection" sat on the home screen whenever the home screen did,
 * so someone who tapped past the gate to continue unprotected was told their
 * connection was secure while their IP address was in the clear.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const app = new Function('return {' + method('torBannerVals() {') + '}')();

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function at(privacy) {
  global.window = { FoxyWallet: privacy === null ? null : { privacy: () => privacy } };
  return app.torBannerVals();
}
const SECURE = 'Secure Tor Connection';
const EXPOSED = 'IP Address Exposed';
const OFFLINE = 'OFFLINE \u2014 TAP TO RETRY';

// ---- working offline, which the person chose --------------------------
{
  /* While Tor is merely connecting the banner is absent, and rightly: nothing
   * has been claimed and nothing has leaked. Offline is not that state. It is
   * one the person chose and stays in, in which most of the app refuses them,
   * so a home screen making no claim at all would be the same screen as a
   * healthy one. */
  const v = at({ tor: 'connecting', unprotected: false, offline: true, progress: 0, everUp: true });
  check('offline: the banner shows rather than going quiet', v.torBannerShown === true);
  check('and says so, with the way back in the words', v.torBannerText === OFFLINE, v.torBannerText);
  check('never called secure', v.torBannerText !== SECURE);
  /* Not red. Red is for somebody exposed who might not know it; offline sends
   * nothing at all, so nothing is exposed. */
  check('amber, not the red of exposure', v.torBannerBg !== '#FF5C5C' && v.torBannerBg === '#E6D8A8',
    v.torBannerBg);
  check('and the tap knows it is the way back', v.torBannerOffline === true);
}
{
  // the same route, without the choice: still no banner, exactly as before
  const v = at({ tor: 'connecting', unprotected: false, offline: false, progress: 0, everUp: true });
  check('merely connecting still shows nothing', v.torBannerShown === false);
  check('and its tap is not the offline one', !v.torBannerOffline);
}
{
  /* Tor saying up while offline is still set is not a stale flag — it is the
   * ordinary state of a phone that has lost its network.
   *
   * Tor reports bootstrap 100% from a state it cannot use: the wifi goes, every
   * request times out, the path monitor says none, and the control port still
   * says done. `_privacy` surrenders the choice only when there is a network
   * under that claim, so this pair occurs — and the banner told somebody who had
   * deliberately gone offline, on a phone that could not reach a mint, that they
   * had a Secure Tor Connection.
   *
   * The choice wins. It is a state the person picked and stays in, in which the
   * wallet refuses them, and a banner that contradicts every other screen is
   * worse than no banner. */
  const v = at({ tor: 'up', unprotected: false, offline: true, progress: 100, everUp: true });
  check('Tor claiming up does not overrule the choice to work offline',
    v.torBannerText !== SECURE && v.torBannerOffline === true, v.torBannerText);
  /* And once the choice really has been surrendered — which takes a network,
   * not just Tor's word — the banner says secure, as it always did. */
  const w = at({ tor: 'up', unprotected: false, offline: false, network: 'wifi',
                 progress: 100, everUp: true });
  check('and with the choice let go it reads secure again', w.torBannerText === SECURE,
    w.torBannerText);
  /* A claim about the connection needs a connection under it. The banner is
   * absent here rather than amber — nothing was chosen and nothing has leaked —
   * and what matters is that it is not up there saying secure. `torBannerText`
   * falls through to that string whenever nothing else applies, so the claim is
   * `shown` and the text together, never the text alone. */
  const x = at({ tor: 'up', unprotected: false, offline: false, network: 'none',
                 progress: 100, everUp: true });
  check('Tor up with no network at all never claims a secure connection',
    !(x.torBannerShown && x.torBannerText === SECURE),
    'shown ' + x.torBannerShown + ', ' + x.torBannerText);
}
{
  // unprotected is the louder claim and must not be softened by offline
  const v = at({ tor: 'connecting', unprotected: true, offline: true, progress: 0, everUp: false });
  check('unprotected still reads as exposure, not as offline', v.torBannerText === EXPOSED,
    v.torBannerText);
}

// ---- Tor carrying everything ------------------------------------------
{
  const v = at({ tor: 'up', unprotected: false, progress: 100, everUp: true });
  check('Tor up: the banner shows', v.torBannerShown === true);
  check('and says the connection is secure', v.torBannerText === SECURE, v.torBannerText);
  check('in iceberg blue', v.torBannerBg === '#BFE3EC', v.torBannerBg);
}

// ---- continuing unprotected -------------------------------------------
{
  const v = at({ tor: 'connecting', unprotected: true, progress: 40, everUp: false });
  check('unprotected: the banner shows', v.torBannerShown === true);
  check('and never claims a secure connection', v.torBannerText !== SECURE, v.torBannerText);
  check('it names what is exposed', v.torBannerText === EXPOSED, v.torBannerText);
  check('in red, not iceberg blue', v.torBannerBg === '#FF5C5C' && v.torBannerBg !== '#BFE3EC', v.torBannerBg);
}

// ---- still connecting, nothing claimed --------------------------------
{
  const v = at({ tor: 'connecting', unprotected: false, progress: 40, everUp: false });
  check('still connecting: no banner at all', v.torBannerShown === false);
}

// ---- Tor dropped after being up ---------------------------------------
{
  const v = at({ tor: 'connecting', unprotected: false, progress: 0, everUp: true });
  check('Tor up earlier and gone now: the secure claim goes with it',
    v.torBannerShown === false);
}

// ---- both flags set at once, as the route changes over --------------------
{
  const v = at({ tor: 'up', unprotected: true, progress: 100, everUp: true });
  check('up AND unprotected at once is not secure', v.torBannerText !== SECURE, v.torBannerText);
}

// ---- no wallet yet ----------------------------------------------------
{
  const v = at(null);
  check('before the wallet is up, nothing is claimed', v.torBannerShown === false);
  check('and reading it does not throw', typeof v.torBannerText === 'string');
}

// ---- the one that matters ---------------------------------------------
{
  const secureIn = [
    { tor: 'connecting', unprotected: true }, { tor: 'connecting', unprotected: false },
    { tor: 'down', unprotected: true }, { tor: '', unprotected: true },
  ].filter((p) => at(Object.assign({ progress: 0, everUp: false }, p)).torBannerText === SECURE
                  && at(Object.assign({ progress: 0, everUp: false }, p)).torBannerShown);
  check('no route short of Tor being up is ever shown as secure',
    secureIn.length === 0, secureIn.length + ' would have been');
}

/* Working offline with the radios back on. "OFFLINE — TAP TO RETRY" is right
 * for a phone with nothing to try and wrong for one sitting next to the wifi it
 * just rejoined: the tap is likely to work and the person cannot tell that from
 * Foxy. "May be" is the whole of what it can honestly claim — a network is not
 * a circuit. */
{
  const off = (net) => at({ tor: 'connecting', progress: 0, everUp: false,
                            unprotected: false, offline: true, network: net });
  check('offline with no network still says there is none',
    /OFFLINE/.test(off('none').torBannerText), off('none').torBannerText);
  check('offline with wifi back says a connection may be available',
    off('wifi').torBannerText === 'CONNECTION MAY BE AVAILABLE', off('wifi').torBannerText);
  check('and with cellular back',
    off('cellular').torBannerText === 'CONNECTION MAY BE AVAILABLE', off('cellular').torBannerText);
  check('but not before the phone has answered at all',
    /OFFLINE/.test(off('unknown').torBannerText), off('unknown').torBannerText);
  check('and it is still the tap that leaves offline',
    off('wifi').torBannerOffline === true, String(off('wifi').torBannerOffline));
}

console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' tor banner checks pass'));
process.exit(R.fail ? 1 : 0);
