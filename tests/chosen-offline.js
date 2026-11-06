'use strict';
/* chosen-offline.js — working offline, by the holder's choice, stays chosen.
 *
 *     node tests/chosen-offline.js
 *
 * A phone had WORK OFFLINE chosen while Tor was up over a bridge and a tunnel, and a payment
 * went to the mint over a connection that carried nothing: the choice was refused, or given
 * up on the next push, because Tor said `up`. What this pins, on the real wallet:
 *   - the holder's choice (second argument) is accepted with Tor really up, survives the next
 *     push, and shuts the route (`routeOpen` through `assertRoute`)
 *   - the automatic offline of home-first still yields to a route
 *   - undoing the choice reopens the route; going unprotected outranks it
 *   - the wallet's privacy record carries `offlineChosen` for the banner
 */
const { loadReal } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || !detail ? '' : ' - ' + detail));
  if (!good) failed += 1;
};

const ctx = loadReal({ bridge: (w, m) => { setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'not in this test'), 0); return null; } });
const W = ctx.W;
const up = { tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' };
/* Is the route shut? Asked the way the app asks: a lookup with no route is refused in the words for working offline. */
const routeShut = async () => {
  try { await W.lookupLnurl('alice@addr.test', 10); return false; } catch (e) { return /working offline/i.test(String(e && e.message)); }
};

(async () => {
W._privacy(up);
W.setOffline(true);
ok(W.privacy().offline === false, 'the automatic offline is refused while Tor is really up');

W.setOffline(true, true);
ok(W.privacy().offline === true && W.privacy().offlineChosen === true, "the holder's choice is accepted with Tor really up", JSON.stringify(W.privacy()));
W._privacy(up);
ok(W.privacy().offline === true, 'and survives the next push from the native side');
ok(await routeShut(), 'and no request is made: the route is shut', 'assertRoute');

W.setOffline(false);
ok(W.privacy().offline === false && W.privacy().offlineChosen === false, 'undone, it is gone');
W._privacy(up);
ok(!(await routeShut()), 'and the route is open again');

W.setOffline(true, true);
W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: true, transport: 'direct', network: 'wifi' });
ok(!(await routeShut()), 'going unprotected is the louder act and opens the route');

// chosen while Tor is still coming is the old choice: given up when Tor is really up
W.setOffline(false);
W._privacy({ tor: 'connecting', progress: 10, everUp: true, unprotected: false, transport: 'direct', network: 'wifi' });
W.setOffline(true, true);
ok(W.privacy().offline === true && W.privacy().offlineChosen === false, 'chosen while Tor is coming is not the sticky kind');
W._privacy(up);
ok(W.privacy().offline === false, 'and Tor coming up gives it back');

})().then(() => {
console.log('\n' + (failed ? failed + ' chosen-offline check(s) failed' : 'all chosen-offline checks pass'));
process.exit(failed ? 1 : 0);
});
