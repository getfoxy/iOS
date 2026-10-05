'use strict';
/* cross-wallet-restore.js — do Foxy's twelve words restore the same balance in
 * other wallets, and theirs in Foxy? Fake money only: the local mints.
 *
 *   sh tools/live/local-mint.sh up
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/cross-wallet-restore.js [cdk|nutshell|all] [out.json]
 *
 * At each mint:
 *  1. Foxy (jsdom, harness.js): new seed, mint 300, send a 40-sat token (left
 *     outstanding), pay an invoice from the other mint (fee reserve, change)
 *     and one from the same mint.
 *  2. Nutshell's wallet CLI (nutshell-cli.sh, in the nutshell image) restores
 *     the words into an empty wallet: `echo "$WORDS" | cashu -y restore --to 3
 *     --batch 100`. Its balance must be Foxy's plus the outstanding token,
 *     which is still unspent at the mint.
 *  3. Foxy takes the token back; a second CLI restore must match Foxy exactly.
 *  4. cdk-cli: only if CDK_CLI_RESTORE_CMD is set — a shell command that gets
 *     WORDS, MINT (http, as seen from this Mac), DIR in its environment and
 *     prints "<n> sat". tools/live/cdk-cli-restore.sh is one, over a cdk-cli
 *     image built from CDK's v0.18.0 tag.
 *  5. Reverse: a Nutshell CLI wallet with its own words mints 256, sends itself
 *     a token and receives it; Foxy restores those words (scanSeed, adoptScan)
 *     and must show the CLI's balance, then spend from it. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const H = require('./harness');

const which = process.argv[2] || 'all';
const OUT = process.argv[3] || '';
const keys = which === 'all' ? ['cdk', 'nutshell'] : [which];
setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

async function foxyWallet(url) {
  const b = H.boot({ keychain: { words: '' } });
  await b.W.seedReady();
  await b.W.connect(url);
  return b;
}

function cliDir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), 'foxy-cli-' + label + '-')); }

function cliRestore(M, words, label, R) {
  const dir = cliDir(label);
  const args = ['restore', '--to', '3', '--batch', '100'];
  const out = H.nutshellCli(dir, M.docker, args, words + '\n');
  const bal = H.cliBalance(out);
  R.log('  $ echo "$WORDS" | sh tools/live/nutshell-cli.sh ' + dir + ' ' + M.docker + ' ' + args.join(' ') + '  ->  ' + bal + ' sat');
  return { dir, bal, out };
}

(async () => {
  const report = {};
  let failed = false;
  for (const key of keys) {
    const M = H.MINTS[key];
    const O = H.MINTS[H.other(key)];
    const R = H.reporter('cross ' + key);
    await H.mintNames([key]);      // the version that answers, not the image tag
    const res = report[key] = { mint: M.name };
    R.log('=== ' + M.name + ' at ' + M.https);
    try {
      // 1. Foxy
      const A = await foxyWallet(M.https);
      const W = A.W;
      await H.mintAndClaim(W, 300);
      const token = await W.sendToken(40);
      const ext = await H.rawInvoice(O.http, 50);
      const paidExt = await W.pay(ext);
      const same = await H.rawInvoice(M.http, 20);
      const paidSame = await W.pay(same);
      res.words = A.keychain.words;
      res.foxy = { balance: await W.balanceSats(), outstandingToken: token.sats,
        feeExternal: paidExt.feeSats, feeSameMint: paidSame.feeSats, heldMelts: W.pendingMelts().length };
      R.log('Foxy: minted 300, token ' + token.sats + ' outstanding, paid 50 external (fee ' + paidExt.feeSats +
        ') and 20 same-mint (fee ' + paidSame.feeSats + '); balance ' + res.foxy.balance);
      const expectWithToken = res.foxy.balance + token.sats;

      // the words typed on another mocked phone and scanned by candidate
      const rows = await H.scanFresh(res.words, [M.https]);
      res.foxyRestore = rows[0] && rows[0].sats;
      R.check('Foxy restores its own words', res.foxyRestore === expectWithToken,
        res.foxyRestore + ' sat, expected ' + expectWithToken + ' (balance + outstanding token)');

      // 2. Nutshell CLI, token still outstanding
      const c1 = cliRestore(M, res.words, key + '-1', R);
      res.nutshellCliWithToken = c1.bal;
      R.check('Nutshell CLI restores Foxy\'s words (token outstanding)', c1.bal === expectWithToken,
        'CLI ' + c1.bal + ' sat vs Foxy ' + res.foxy.balance + ' + token ' + token.sats + ' = ' + expectWithToken);

      // 3. token back, then an exact comparison
      const back = await W.receiveToken(token.token);
      res.foxy.balanceAfterReceive = await W.balanceSats();
      const c2 = cliRestore(M, res.words, key + '-2', R);
      res.nutshellCliAfterReceive = c2.bal;
      R.check('Nutshell CLI restores Foxy\'s words (no outstanding tokens)', c2.bal === res.foxy.balanceAfterReceive,
        'CLI ' + c2.bal + ' sat vs Foxy ' + res.foxy.balanceAfterReceive + ' (token received back for ' + back.sats + ')');

      // 4. cdk-cli
      if (process.env.CDK_CLI_RESTORE_CMD) {
        const dir = cliDir(key + '-cdk');
        const out = execSync(process.env.CDK_CLI_RESTORE_CMD, { encoding: 'utf8', timeout: 300000,
          env: { ...process.env, WORDS: res.words, MINT: M.http, DIR: dir } });
        const m = /(\d+)\s*sat/i.exec(out.split('\n').reverse().join('\n'));
        res.cdkCli = m ? Number(m[1]) : null;
        R.check('cdk-cli restores Foxy\'s words', res.cdkCli === res.foxy.balanceAfterReceive,
          'cdk-cli ' + res.cdkCli + ' vs Foxy ' + res.foxy.balanceAfterReceive);
      } else {
        res.cdkCli = 'not run';
        R.skip('cdk-cli restore', 'CDK_CLI_RESTORE_CMD not set; see tools/live/cdk-cli-restore.sh');
      }

      // 5. reverse: Nutshell CLI words into Foxy
      const rdir = cliDir(key + '-rev');
      const cli = (...args) => H.nutshellCli(rdir, M.docker, args);
      // funded from its own seed: an invoice at Nutshell; at CDK the CLI's invoice check never
      // returns (see README), so a token from Foxy is received (a swap into the CLI's outputs)
      if (key === 'nutshell') cli('invoice', '256');
      else {
        // the token names the mint as the container reaches it, or the CLI cannot redeem it
        const ft = await W.sendToken(150);
        cli('receive', A.w.CashuTS.getEncodedToken({ mint: M.docker, proofs: W.tokenInfo(ft.token).proofs, unit: 'sat' }));
      }
      const sent = cli('send', '40');
      const tok = (/cashu[AB][A-Za-z0-9_\-=+/]+/.exec(sent) || [])[0];
      if (tok) cli('receive', tok);
      const cliBal = H.cliBalance(cli('balance'));
      const words = (/Mnemonic:\s*\n\s*-\s*([a-z ]+)/.exec(cli('info', '--mnemonic')) || [])[1];
      R.log('  $ sh tools/live/nutshell-cli.sh ' + rdir + ' ' + M.docker + ' ' + (key === 'nutshell' ? 'invoice 256' : 'receive <150-sat token from Foxy>') + ' / send 40 / receive <token> / balance / info --mnemonic');
      res.reverse = { cliBalance: cliBal, tokenSentAndReceived: !!tok };
      if (!words) throw new Error('could not read the CLI wallet\'s mnemonic');
      const B = await (async () => { const b = H.boot({ keychain: { words: '' } }); await b.W.seedReady(); return b; })();
      const { rows: rrows, adopt: adoptRows } = await H.restoreWords(B, words.trim(), [M.https]);
      const adopted = await adoptRows();
      await B.W.connect(M.https);
      res.reverse.foxyScan = rrows[0] && rrows[0].sats;
      res.reverse.foxyBalance = await B.W.balanceSats();
      R.check('Foxy restores the Nutshell CLI wallet\'s words', cliBal > 0 && res.reverse.foxyBalance === cliBal && res.reverse.foxyScan === cliBal,
        'Foxy scan ' + res.reverse.foxyScan + ', adopted balance ' + res.reverse.foxyBalance + ' vs CLI ' + cliBal +
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
