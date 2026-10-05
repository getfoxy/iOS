'use strict';
/* address-vectors.js — the Bitcoin address reader, against the BIPs' own vectors.
 *
 *     node tests/address-vectors.js
 *
 * On chain a mistyped address is money sent nowhere, and the shape of an
 * address says nothing about whether it is real: only the checksum does. So
 * readAddress (build/wallet/08-bitcoin-address.js) is held to the test vectors
 * in BIP-173 and BIP-350 for segwit, and to the base58 checksum for the older
 * kinds — including the cases those BIPs list as invalid, which a reader that
 * only looked at the prefix would happily pass.
 *
 * Mainnet only: Foxy's mints settle in mainnet bitcoin, so a testnet or regtest
 * address is refused here rather than at the mint.
 */
const { load } = require('./harness');
const { W } = load({});

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

// ---- valid, from BIP-173 and BIP-350 ---------------------------------------
const VALID = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'P2WPKH, upper case (BIP-173)'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'P2WPKH, lower case'],
  ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'P2WSH (BIP-173)'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
    'witness v1, bech32m (BIP-350)'],
  ['BC1SW50QGDZ25J', 'witness v16, bech32m (BIP-350)'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'witness v2, bech32m (BIP-350)'],
  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'P2PKH, base58 (the first coinbase)'],
  ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'P2SH, base58 (BIP-16)'],
];
for (const [address, what] of VALID) {
  const read = W.readAddress(address);
  // segwit is read back in lower case, which is the form the mint is given
  const want = address.slice(0, 3).toLowerCase() === 'bc1' ? address.toLowerCase() : address;
  check('takes ' + what, !!read && read.address === want && read.sats === 0, JSON.stringify(read));
}

// ---- invalid, from BIP-350's own list, and the ways money goes missing ------
const INVALID = [
  ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', 'a character not in the charset'],
  ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', 'witness version 17'],
  ['bc1pw5dgrnzv', 'a one-byte program'],
  // these three carry the right bech32m checksum: only the rule they break refuses them
  ['bc1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q02am2l',
    'a 41-byte program'],
  ['bc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzsf6edgu',
    'a v0 program that is neither 20 nor 32 bytes'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7k8e76x7', 'witness v1 with a bech32 checksum'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', 'witness v0 with a bech32m checksum'],
  ['bc1gmk9yu', 'an empty data part'],
  ['bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mixed case'],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'one character changed'],
  ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'a testnet address'],
  ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'a regtest address'],
  ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'a base58 address with a bad checksum'],
  ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'a testnet base58 address'],
  ['', 'nothing at all'],
  ['lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq', 'an invoice'],
];
for (const [address, what] of INVALID) {
  check('refuses ' + what, W.readAddress(address) === null, JSON.stringify(W.readAddress(address)));
}

// ---- BIP-21: the amount that comes with a scanned code ---------------------
const ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const AMOUNTS = [
  ['bitcoin:' + ADDRESS, 0, 'no amount'],
  ['bitcoin:' + ADDRESS + '?amount=0.00021', 21000, '0.00021 BTC is 21,000 sats'],
  ['bitcoin:' + ADDRESS + '?label=Foxy&amount=1', 1e8, 'an amount after another field'],
  ['bitcoin:' + ADDRESS + '?amount=0.00000001', 1, 'one satoshi'],
  ['bitcoin:' + ADDRESS + '?amount=-1', 0, 'a negative amount is no amount'],
  ['bitcoin:' + ADDRESS + '?amount=21000001', 0, 'more bitcoin than exists is no amount'],
  ['bitcoin:' + ADDRESS + '?amount=abc', 0, 'an amount that is not a number'],
  ['BITCOIN:' + ADDRESS + '?amount=0.5', 5e7, 'the scheme in upper case'],
];
for (const [uri, sats, what] of AMOUNTS) {
  const read = W.readAddress(uri);
  check('reads ' + what, !!read && read.address === ADDRESS && read.sats === sats,
    JSON.stringify(read));
}
check('a bitcoin: URI for an address that is not real is still refused',
  W.readAddress('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb?amount=1') === null,
  JSON.stringify(W.readAddress('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb?amount=1')));

// ---- what the QR carries back out ------------------------------------------
check('bip21 writes the amount in bitcoin', W.bip21(ADDRESS, 21000) === 'bitcoin:' + ADDRESS + '?amount=0.00021',
  W.bip21(ADDRESS, 21000));
check('bip21 leaves the amount out when there is none', W.bip21(ADDRESS, 0) === 'bitcoin:' + ADDRESS,
  W.bip21(ADDRESS, 0));
check('what bip21 writes, readAddress reads back',
  (() => { const r = W.readAddress(W.bip21(ADDRESS, 1234567)); return !!r && r.address === ADDRESS && r.sats === 1234567; })(),
  W.bip21(ADDRESS, 1234567));

// ---- classify, the one place a scan is decided -----------------------------
check('classify calls a bitcoin address an address', W.classify(ADDRESS) === 'address', W.classify(ADDRESS));
check('classify calls a bitcoin: URI an address', W.classify('bitcoin:' + ADDRESS + '?amount=1') === 'address',
  W.classify('bitcoin:' + ADDRESS + '?amount=1'));

results.forEach(r => console.log(r));
const failed = results.filter(r => r.startsWith('FAIL')).length;
if (failed) { console.log('\n' + failed + ' address check(s) failed'); process.exit(1); }
console.log('\nall ' + results.length + ' address checks pass');
