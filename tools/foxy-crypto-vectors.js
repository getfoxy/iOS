/* foxy-crypto-vectors.js — check the wallet's own SHA-256 against the
 * published NIST vectors.
 *
 *     node tools/foxy-crypto-vectors.js
 *
 * foxy-wallet.js implements SHA-256 by hand, for the PIN hash. Its hand-rolled
 * secp256k1 maths went with the custom P2PK scheme it served; key work is
 * cashu-ts's alone now.
 *
 * This lifts sha256 out of the file and runs it against the NIST vectors,
 * including the one-million-'a' case.
 *
 * It reads foxy-wallet.js as text and evaluates only the maths, so nothing in
 * the wallet has to be exported or changed to be testable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WALLET = path.join(__dirname, '..', 'Web', 'foxy-wallet.js');

const src = fs.readFileSync(WALLET, 'utf8');

/* Take the block from the SHA-256 constants through the end of sha256. Anchored
 * on the source's own text, so a rename here fails loudly rather than testing
 * something stale. */
function lift() {
  const from = src.indexOf('  var SHA_K = [');
  const to = src.indexOf('  var FoxyWallet = {');
  if (from < 0 || to < 0 || to < from) {
    throw new Error('could not find the crypto block in foxy-wallet.js');
  }
  const block = src.slice(from, to);
  const factory = new Function(block +
    '\n return { sha256 };');
  return factory();
}

const M = lift();

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('FAIL ' + name);
  console.log('  expected ' + want);
  console.log('  got      ' + got);
}

const hex = (bytes) => bytes.map(b => ('0' + b.toString(16)).slice(-2)).join('');
const ascii = (s) => Array.from(s, c => c.charCodeAt(0));

/* ---- SHA-256, NIST FIPS 180-4 ---------------------------------------- */

check('sha256 empty', hex(M.sha256([])),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

check('sha256 abc', hex(M.sha256(ascii('abc'))),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

check('sha256 448-bit', hex(M.sha256(ascii(
  'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

check('sha256 896-bit', hex(M.sha256(ascii(
  'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn' +
  'hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))),
  'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');

// the block-boundary case that catches a wrong length encoding
check('sha256 one million a', hex(M.sha256(new Array(1000000).fill(97))),
  'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

/* ---- result ----------------------------------------------------------- */

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
