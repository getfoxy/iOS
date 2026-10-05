'use strict';
/* cdk-cli-reverse.js — do the words of a wallet CDK's own CLI made restore in Foxy?
 *
 *     NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *       node tools/live/cdk-cli-reverse.js [cdk|nutshell|all] [out.json]
 *
 * The other direction from cross-wallet-restore.js's cdk-cli step. Fake money
 * only, against the local mints (tools/live/local-mint.sh), with the cdk-cli
 * image built from CDK's v0.18.0 tag (see cdk-cli-restore.sh).
 *
 *  1. cdk-cli, in a fresh work dir, makes its own words and mints twice at the
 *     mint (the fake wallet pays its invoices), so its counters move on.
 *  2. A fresh Foxy restores those words (scanSeed, adoptScan) and must hold
 *     exactly what cdk-cli's balance says.
 *  3. Foxy spends from the restored ecash with no used-output trouble.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./harness');

const which = process.argv[2] || 'all';
const OUT = process.argv[3] || '';
const keys = which === 'all' ? ['cdk', 'nutshell'] : [which];
const IMAGE = process.env.CDK_CLI_IMAGE || 'foxy-cdk-cli:0.18.0';
setTimeout(() => { console.log('WATCHDOG 600s'); process.exit(2); }, 600000).unref();

function cdkCli(dir, args) {
  return execFileSync('docker', ['run', '--rm', '-v', dir + ':/w', IMAGE, '--work-dir', '/w', ...args],
    { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
}

(async () => {
  const report = {};
  let failed = false;
  for (const key of keys) {
    const M = H.MINTS[key];
    const R = H.reporter('cdk-cli reverse ' + key);
    const res = report[key] = {};
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-cdkcli-rev-' + key + '-'));
      const minted = [];
      await R.step('cdk-cli mints under its own words (twice)', async () => {
        for (const amount of ['128', '64']) {
          const out = cdkCli(dir, ['mint', M.docker, amount]);
          minted.push(out.trim().split('\n').slice(-2).join(' / '));
        }
        return minted.join(' ; ');
      });
      const balOut = cdkCli(dir, ['balance']);
      const nums = [...balOut.matchAll(/(\d+)\s*sat/gi)].map((m) => Number(m[1]));
      const cliBal = nums.length ? nums[nums.length - 1] : null;
      const words = fs.readFileSync(path.join(dir, 'seed'), 'utf8').trim();
      R.log('  $ docker run --rm -v ' + dir + ':/w ' + IMAGE + ' --work-dir /w mint ' + M.docker + ' 128 / mint 64 / balance  ->  ' + cliBal + ' sat');
      res.cliBalance = cliBal;
      // cdk-cli makes 24 words (32 bytes of entropy); Foxy makes 12, and its restore
      // screen takes 12. The wallet underneath restores either.
      const count = words.split(/\s+/).length;
      res.words = count;
      if (!/^[a-z]+( [a-z]+)*$/.test(words) || (count !== 12 && count !== 24)) throw new Error('cdk-cli left no 12- or 24-word seed in its work dir');
      R.log('  cdk-cli made a ' + count + '-word seed');

      const B = H.boot({ keychain: { words: '' } });
      await B.W.seedReady();
      // typed on the mocked phone, which takes a 24-word phrase; the real phone's screen takes twelve
      const { rows, adopt } = await H.restoreWords(B, words, [M.https]);
      const adopted = await adopt();
      await B.W.connect(M.https);
      res.foxyScan = rows[0] && rows[0].sats;
      res.foxyBalance = await B.W.balanceSats();
      R.check('Foxy restores the cdk-cli wallet\'s words', cliBal > 0 && res.foxyScan === cliBal && res.foxyBalance === cliBal,
        'Foxy scan ' + res.foxyScan + ', adopted balance ' + res.foxyBalance + ' vs cdk-cli ' + cliBal +
        ' (' + JSON.stringify(adopted.kept) + ')');
      await R.step('Foxy spends the restored ecash (no used-output trouble)', async () => {
        const t = await B.W.sendToken(10);
        const r = await B.W.receiveToken(t.token);
        const skips = B.rec.warn.filter((l) => /moving the counters on/.test(l)).length;
        return 'sent ' + t.sats + ', received ' + r.sats + ', counter skips ' + skips;
      });
    } catch (e) {
      R.fail('run', String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
    }
    res.steps = R.rows;
    if (R.failed().length) failed = true;
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(H.phoneReport());
  if (H.nativeStats.wordsAsked || H.nativeStats.pageSeedDerivations || H.nativeStats.tooFarAhead) failed = true;
  console.log(failed ? 'SOME CHECKS FAILED' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})();
