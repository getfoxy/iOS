'use strict';
/* flashcard-clock.js — the clock of a card of software 1.15: Bitcoin block headers.
 *
 *     node tests/flashcard-clock.js
 *
 * Until 1.15 a card was told the time under a signature by a key built into the app, which anyone could copy out of it.
 * Now its clock is the time written in the newest block header it has been shown (SET_HEADER): it hashes the 80 bytes
 * twice and believes the header for the work in it, and the phone's own time is a note it keeps (TELL_TIME) and trusts
 * for nothing. This pins both halves.
 *
 *   0  the headers named here are what they are, and the reader of a header (untrusted text from an explorer) finds no work
 *      in a header that has none
 *   1  the card (the model: tests/flashcard-model.js holds it to a recording of the applet, and tests/flashcard-applet.js
 *      sends the applet itself the same header commands): three real headers at the real floor, and mined ones at a cheap
 *      floor for the rules a real header cannot reach (the quarter of the hardest work, forward-only time)
 *   2  the phone fetching the newest header from two explorers over a fake Tor, and what it will and will not believe
 *   3  a tap: TELL_TIME once per time in the field, SET_HEADER only when the card is behind, neither one waiting for the fetch;
 *      3b a daily limit through the wallet, turning when a block of a day later reaches the card and not when a till says;
 *      3c a new record (an empty card told its mint) that keeps the clock
 *   4  the record, the log and the receipts a card of 1.15 gives (77 bytes and 20), and one before it (73 and 16)
 *   5  the FLASHCARD screen: the CLOCK line, and a log that shows the phone's time beside the block's
 *
 * The headers named TIP, OLD and GENESIS are real, and public: this checks their hashes with a sha256 of its own. */
const crypto = require('crypto');
const { page, funded, newCard, why, settle, tipIs, mineHeader, hashOfHeader, sha256d, CHEAP, EXPLORERS, MINT2, history } = require('./flashcard-kit');
const { makeCard } = require('./flashcard-card');
const { appOn, until, card: uiCard, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const SEL = '00a4040009f0464f58594341524400';
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const headerCmd = (hex) => 'b0360000' + '50' + hex + '04';
const tellCmd = (secs) => 'b0370000' + '04' + u32(secs);
const INFO = 'b001010000';
const RECORD = 'b016000000';
const insOf = (card) => card.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
const count = (card, ins) => insOf(card).filter((i) => i === ins).length;

/* Real headers, as the network carries them (version, previous hash, merkle root, time, bits, nonce; little-endian). */
const TIP = {
  hex: '00c02133b973a14eab498ae41fd2054685e7250b36c4bd758ca801000000000000000000ba4fd6d57bfebf73fcf0552a92d5430b78b735cf59c6c58243b2fc48d4669b5a75dcc96af01e021736a8ee8c',
  time: 1791614069, bits: 0x17021ef0, hash: '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a',
};
const OLD = {
  hex: '00e0ff3f5c9163e913a6431d7ef2fce013c71bc6a96a9fdaad1a020000000000000000000db1148f11b5c527caef5a8f54ed8bab7a2096b40d2a204b5c8e7f38d3501c5f7273c86af01e02177f6bf671',
  time: 1791521650, bits: 0x17021ef0, hash: '000000000000000000016d1284d0c5c14f42cdb4f6ee7c596c70d1d70cc5f177',
};
// the first block there was: its work is real, and is far under the floor
const GENESIS = {
  hex: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
  time: 1231006505, bits: 0x1d00ffff, hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
};
/* A header's nonce changed, so that its hash is no longer under its own target (the work is gone, the rest is the same). */
function spoiled(hex) {
  const b = Buffer.from(hex, 'hex');
  const bits = b.readUInt32LE(72);
  for (let nonce = 0; ; nonce++) {
    b.writeUInt32LE(nonce, 76);
    const exp = bits >>> 24, man = bits & 0xffffff;
    const target = exp >= 3 ? BigInt(man) << BigInt(8 * (exp - 3)) : BigInt(man >> (8 * (3 - exp)));
    if (BigInt('0x' + Buffer.from(sha256d(b)).reverse().toString('hex')) > target) return b.toString('hex');
  }
}
const withBits = (hex, bits) => { const b = Buffer.from(hex, 'hex'); b.writeUInt32LE(bits >>> 0, 72); return b.toString('hex'); };

(async () => {
  const P = page({});
  const W = P.W;
  const mk = (o) => makeCard(Object.assign({ window: P.window, format: 4 }, o || {}));
  const read = async (card, cmd) => { const a = await card.send(cmd); return { sw: a.slice(-4), data: a.slice(0, -4) }; };
  const infoOf = async (card) => W.cardParse.info((await read(card, INFO)).data);
  const recordOf = async (card) => W.cardParse.record((await read(card, RECORD)).data, await infoOf(card));

  /* ---- 0: the headers named here are what they are ----------------------------------------------------------------- */
  for (const [name, h] of [['TIP', TIP], ['OLD', OLD], ['GENESIS', GENESIS]]) {
    const b = Buffer.from(h.hex, 'hex');
    ok(b.length === 80 && hashOfHeader(h.hex) === h.hash && b.readUInt32LE(68) === h.time && b.readUInt32LE(72) === h.bits,
       name + ' is 80 bytes whose hash, time and bits are as named, by a sha256 of this test’s own', hashOfHeader(h.hex).slice(0, 24));
    const parsed = W.cardParse.header(h.hex);
    ok(parsed.hash === h.hash && parsed.time === h.time && parsed.bits === h.bits && parsed.worked === true && parsed.bitsHex === h.hex.substr(144, 8),
       'and the wallet reads the same of it, and finds the work in it', parsed.hash.slice(0, 24));
  }
  ok(W.headerShort(TIP.hash) === '1fa7ca83' && W.headerShort(OLD.hash) === '16d1284d' && W.headerShort('0'.repeat(64)) === '' && W.headerShort('xx') === '',
     'a block hash in a line is the eight digits after its zeros: the first eight of every hash are the same', W.headerShort(TIP.hash));
  ok(W.cardParse.header(spoiled(TIP.hex)).worked === false, 'a header with its nonce changed has no work in it');
  for (const bad of ['', 'zz', TIP.hex.slice(2), TIP.hex + '00', TIP.hex.slice(0, 158) + 'zz']) {
    let threw = false;
    try { W.cardParse.header(bad); } catch (e) { threw = true; }
    if (!threw) ok(false, 'a header that is not 80 bytes of hex is not read: ' + bad.slice(0, 12));
  }

  /* what the explorers hand over is untrusted text: the reader of a header never reads work into a header that has none, and says an Error or nothing else */
  {
    let flips = 0, worked = 0;
    for (const real of [TIP, OLD]) {
      const bytes = Buffer.from(real.hex, 'hex');
      for (let bit = 0; bit < 640; bit++) {
        const b = Buffer.from(bytes);
        b[bit >> 3] ^= 1 << (bit & 7);
        flips += 1;
        if (W.cardParse.header(b.toString('hex')).worked) worked += 1;
      }
    }
    ok(flips === 1280 && worked === 0, 'no single bit of a real header can be changed and leave work in it: 1,280 changes, none worked', worked + ' of ' + flips);
    // seeded, so a failure can be run again
    let seed = 0x5eed1234;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const alphabet = '0123456789abcdefABCDEF xyz\n';
    let strange = 0, read = 0;
    for (let i = 0; i < 3000; i++) {
      const n = Math.floor(rnd() * 330);
      let text = '';
      for (let k = 0; k < n; k++) text += alphabet[Math.floor(rnd() * alphabet.length)];
      if (i % 3 === 0) text = Buffer.from(Array.from({ length: 80 }, () => Math.floor(rnd() * 256))).toString('hex');
      try {
        const h = W.cardParse.header(text);
        read += 1;
        if (!/^[0-9a-f]{160}$/.test(h.hex) || typeof h.worked !== 'boolean' || !/^[0-9a-f]{64}$/.test(h.hash)) strange += 1;
        if (h.worked) strange += 1;
      } catch (e) {
        if (!(e instanceof P.window.Error) && !(e instanceof Error)) strange += 1;
      }
      for (const fn of [() => W.headerShort(text), () => W.cardParse.log(text, true, true), () => W.cardParse.receipts(text, true), () => W.cardParse.record(text, { headers: true })]) {
        try { fn(); } catch (e) { if (!(e instanceof P.window.Error) && !(e instanceof Error)) strange += 1; }
      }
    }
    ok(strange === 0 && read > 900, 'three thousand pieces of random text: the readers of a header, a log, a receipt and a record answer or throw an Error, and none finds work in noise', strange + ' strange, ' + read + ' read as 80 bytes');
  }

  /* ---- 1: the card: three real headers at the real floor -------------------------------------------------------------- */
  {
    const c = mk();
    ok((await read(c, SEL)).data === '010f', 'a card of the latest software says 1.15 when chosen');
    const fresh = await infoOf(c);
    ok(fresh.version === '1.15' && fresh.headers === true && fresh.now === 0 && fresh.headerTime === 0 && fresh.windowStart === 0 && fresh.format === 4,
       'and reads as a card whose clock is block headers, at no time yet', JSON.stringify({ v: fresh.version, now: fresh.now }));
    const blank = await recordOf(c);
    ok(blank.headerBits === '' && blank.headerHash === '' && blank.timeKey === '', 'its record names no header yet', JSON.stringify([blank.headerBits, blank.headerHash]));
    // no PIN, no owner, no record: a header is taken by a card in any state
    ok((await read(c, headerCmd(GENESIS.hex))).sw === '6a93', 'the first block there was has real work and far too little: refused 6A93, under the floor');
    ok((await infoOf(c)).now === 0, 'and the clock stays where it was');
    const took = await read(c, headerCmd(TIP.hex));
    ok(took.sw === '9000' && took.data === u32(TIP.time), 'the tip is taken, and the card answers its clock: the time in it', took.data);
    const info = await infoOf(c);
    const rec = await recordOf(c);
    ok(info.now === TIP.time && info.headerTime === TIP.time, 'GET_INFO says it', String(info.now));
    ok(rec.headerBits === TIP.hex.substr(144, 8) && rec.headerBits === 'f01e0217' && rec.headerHash === TIP.hash,
       'GET_CARD says the hardest difficulty it has taken, as the header carries it, and the hash of the last header, as Bitcoin shows one', rec.headerBits + ' ' + rec.headerHash.slice(0, 24));
    const older = await read(c, headerCmd(OLD.hex));
    const info2 = await infoOf(c), rec2 = await recordOf(c);
    ok(older.sw === '9000' && older.data === u32(TIP.time) && info2.now === TIP.time && rec2.headerHash === TIP.hash,
       'an older header is no fault and changes nothing: the answer is the clock, and the hash is the tip’s still', older.data);
    ok((await read(c, headerCmd(spoiled(TIP.hex)))).sw === '6a93', 'a header whose hash is over its own target has no work: 6A93');
    ok((await read(c, headerCmd(spoiled(OLD.hex)))).sw === '6a93', 'and so is an older one: the work is looked at before the time');
    for (const bits of [0x00123456, 0x21123456, 0x1d800000]) {
      ok((await read(c, headerCmd(withBits(TIP.hex, bits)))).sw === '6a80', 'bits no header could carry (' + bits.toString(16) + ') are 6A80, before the work is looked at');
    }
    ok((await read(c, 'b0360000' + '4f' + TIP.hex.slice(0, -2))).sw === '6700' && (await read(c, 'b0360000' + '51' + TIP.hex + '00')).sw === '6700',
       'a header of 79 or of 81 bytes is 6700');
    ok((await read(c, tellCmd(1791614000))).sw === '9000' && (await read(c, 'b0370000' + '03' + '6ac9dc')).sw === '6700' && (await read(c, 'b0370000' + '05' + '6ac9dc7500')).sw === '6700',
       'the phone’s time is four bytes, and is a note: it moves nothing', String((await infoOf(c)).now));
    ok((await read(c, 'b0350000' + '00')).sw === '6d00', 'and SET_TIME, a time under a signature, is gone');
    ok((await infoOf(c)).now === TIP.time, 'the clock is the block’s, whatever the phone said');
    // told twice in one tap, hours apart, which a card before 1.15 marked as a false time: a note is a note, and nothing is written down
    await read(c, tellCmd(1791614000));
    await read(c, tellCmd(1791614000 + 3 * 3600));
    const quiet = W.cardParse.log((await read(c, 'b018000000')).data, true, true);
    ok(quiet.tampers === 0 && quiet.taps === 0 && (await infoOf(c)).now === TIP.time, 'told the time twice in one tap, three hours apart, it marks nothing and moves nothing', JSON.stringify([quiet.tampers, quiet.taps]));
  }

  /* a card that is blocked, or has an owner, takes a header just the same; and the day's window is anchored by the first */
  {
    const c = mk();
    await c.send(SEL);
    await c.send('b0410000' + '04' + '31323334');
    ok((await read(c, 'b0400000' + '04' + '31323334')).sw === '9000', 'a card with a PIN');
    // a limit set before the card has seen any block: its day has no start yet, and the first block gives it one
    ok((await read(c, 'b0330000' + '08' + u32(1000) + u32(0))).sw === '9000', 'a daily limit set on a card that has seen no block is taken (6A92 is gone: it spends its first day on trust)');
    const before = await infoOf(c);
    ok(before.limit === 1000 && before.now === 0 && before.windowStart === 0, 'its day has no start', JSON.stringify([before.now, before.windowStart]));
    const dayBefore = W.cardParse.day(before);
    ok(dayBefore.limited && dayBefore.onTrust === true && dayBefore.noTime === false && dayBefore.turns === 0 && dayBefore.left === 1000,
       'the wallet reads it as a day on trust: not a card that cannot sign, and no hour for the day to turn', JSON.stringify(dayBefore));
    await read(c, headerCmd(TIP.hex));
    const anchored = await infoOf(c);
    ok(anchored.now === TIP.time && anchored.windowStart === TIP.time, 'the first block anchors it: the day begins at the block’s time', JSON.stringify([anchored.now, anchored.windowStart]));
    const day = W.cardParse.day(anchored);
    ok(day.limited && !day.onTrust && day.turns === TIP.time + 86400 && day.left === 1000, 'and it turns a day on, by the block’s clock', JSON.stringify(day));
    const later = mineHeader(TIP.time + 600, 0x207fffff);
    // a header much easier than the real one's is refused by a real-floor card; the tip itself, again, changes nothing
    ok((await read(c, headerCmd(later))).sw === '6a93', 'a header under the floor is refused whatever its time (a card at the real floor, a header mined cheap)');
    ok((await infoOf(c)).windowStart === TIP.time, 'and the window stays');
    // a limit written again begins its window at the clock it has
    await read(c, 'b0330000' + '04' + u32(2000));
    ok((await infoOf(c)).windowStart === TIP.time, 'a limit written again begins its day at the clock the card has');
    // blocked by three wrong PINs, it still takes a header
    const blocked = mk();
    await blocked.send(SEL);
    await blocked.send('b0410000' + '04' + '31323334');
    for (let i = 0; i < 3; i++) await blocked.send('b0400000' + '04' + '39393939');
    ok((await infoOf(blocked)).pin === 'blocked' && (await read(blocked, headerCmd(TIP.hex))).sw === '9000' && (await infoOf(blocked)).now === TIP.time,
       'a card that is blocked takes a header all the same: nothing about it needs a key');
  }

  /* the rules a real header cannot reach, with headers mined at a cheap floor (the model takes `floorBits`) */
  {
    const c = mk({ floorBits: CHEAP });
    await c.send(SEL);
    const T = 1700000000;
    const rec = async () => (await recordOf(c));
    ok((await read(c, headerCmd(mineHeader(T, CHEAP)))).data === u32(T), 'at a cheap floor, a header mined for it is taken');
    ok((await rec()).headerBits === 'ffff7f20', 'and its difficulty is the hardest so far');
    ok((await read(c, headerCmd(mineHeader(T + 100, 0x2000ffff)))).sw === '9000' && (await rec()).headerBits === 'ffff0020',
       'a harder header, later, moves the hardest difficulty');
    ok((await read(c, headerCmd(mineHeader(T + 200, CHEAP)))).sw === '6a93', 'a header with under a quarter of the hardest work is refused 6A93');
    ok((await read(c, headerCmd(mineHeader(T + 300, 0x2003fffc)))).sw === '9000', 'one with exactly a quarter of it is taken');
    ok((await read(c, headerCmd(mineHeader(T + 400, 0x2003fffd)))).sw === '6a93', 'and one a hair under is not');
    ok((await rec()).headerBits === 'ffff0020', 'an easier header taken leaves the hardest difficulty as it was');
    const hash = (await rec()).headerHash;
    ok((await read(c, headerCmd(mineHeader(T - 5000, 0x1f00ffff)))).sw === '9000' && (await rec()).headerBits === 'ffff0020' && (await rec()).headerHash === hash,
       'a harder header that is older than the clock changes nothing, its difficulty and its hash included: only a later one moves them');
    ok((await read(c, headerCmd(mineHeader(T + 500, 0x1f00ffff)))).sw === '9000' && (await rec()).headerBits === 'ffff001f',
       'a later one does');
    ok((await read(c, headerCmd(mineHeader(T + 600, 0x2000ffff)))).sw === '6a93', 'and now the cheaper one is over the quarter it can be: refused');
    ok((await read(c, headerCmd(mineHeader(T + 700, 0x1f00ffff, { fail: true })))).sw === '6a93', 'a header mined to fail its target is 6A93');
    const last = mineHeader(4294967295, 0x1f00ffff);
    ok((await read(c, headerCmd(last))).data === 'ffffffff', 'the last second there is is taken like another');
    ok((await read(c, headerCmd(mineHeader(T + 800, 0x1f00ffff)))).data === 'ffffffff', 'and nothing before it moves the clock back');
  }
  {
    // the ratchet, and the one way out of it: a new record. A card whose network has fallen under a quarter of its best would otherwise take no real header again.
    const c = mk({ floorBits: CHEAP });
    await c.send(SEL);
    await c.send('b0410000' + '04' + '31323334');
    await c.send('b0400000' + '04' + '31323334');
    const T = 1700000000;
    const record = 'b0320000' + '72' + '00' + '00'.repeat(33) + '00'.repeat(65) + '0e' + Buffer.from('https://m.test', 'latin1').toString('hex');
    ok((await read(c, record)).sw === '9000', 'a card with a PIN is given a record');
    await read(c, headerCmd(mineHeader(T, 0x1f00ffff)));
    const hash = (await recordOf(c)).headerHash;
    ok((await read(c, headerCmd(mineHeader(T + 100, CHEAP)))).sw === '6a93', 'a header a million times easier than the hardest it has taken is refused');
    ok((await read(c, record)).sw === '9000', 'a new record is written');
    const rec = await recordOf(c);
    ok(rec.headerBits === '' && rec.headerHash === hash && (await infoOf(c)).now === T, 'it lets the ratchet go: the difficulty is nothing, the last block’s hash and the clock stay');
    ok((await read(c, headerCmd(mineHeader(T + 100, CHEAP)))).sw === '9000' && (await recordOf(c)).headerBits === 'ffff7f20',
       'and the header that was refused is taken, and sets the ratchet afresh');
  }

  {
    // refusals before any block are each a run of their own (with no clock, three visits a week apart would read as one run of three, and a false mark
    // is worse than none); after a block, three before the card's clock next moves are one run, and mark the tap
    for (const withBlock of [false, true]) {
      const c = mk({ floorBits: CHEAP });
      await c.send(SEL);
      await c.send('b0410000' + '04' + '31323334');
      await c.send('b0400000' + '04' + '31323334');
      await c.send('b0320000' + '72' + '00' + '00'.repeat(33) + '00'.repeat(65) + '0e' + Buffer.from('https://m.test', 'latin1').toString('hex'));
      await c.send('b0330000' + '04' + u32(10));
      await c.send('b0430000' + '41' + '04' + '33'.repeat(64));
      ok((await read(c, 'b0300000' + '51' + '0102030405060708' + u32(64) + '9d'.repeat(32) + '02' + 'aa'.repeat(32) + u32(0) + '01')).sw === '9000', 'a card with a limit of 10 and a piece of 64' + (withBlock ? ' that has been shown a block' : ' that has been shown none'));
      if (withBlock) await c.send(headerCmd(mineHeader(1700000000, CHEAP)));
      const said = [];
      for (let i = 0; i < 4; i++) {
        await c.send('b0220000' + '01' + '00');
        said.push((await read(c, 'b0240000' + '00')).sw);
      }
      const log = W.cardParse.log((await read(c, 'b018000000')).data, true, true);
      ok(said.join(' ') === '6a8f 6a8f 6a8f 6a8f' && log.refused === 4 && log.tampers === (withBlock ? 1 : 0) && log.last[0].tamper === withBlock,
         withBlock ? 'four spends over the limit before its clock moves are a run, and the tap is marked' : 'four spends over the limit on a card with no block are four runs of one, and nothing is marked',
         said.join(' ') + ', ' + log.tampers + ' marked');
    }
  }

  /* ---- 2: the phone fetches the newest header from two explorers, and believes what it checks ----------------------------------- */
  {
    const F = page({});
    const FW = F.W;
    const lines = [];
    const log = F.window.console.log;
    F.window.console.log = (...a) => { lines.push(a.join(' ')); };
    const real = F.window.Date.now.bind(F.window.Date);
    let skew = 0;
    F.window.Date.now = () => real() + skew;
    const now = () => Math.floor(F.window.Date.now() / 1000);
    const fresh = () => { F.explored.length = 0; lines.length = 0; };
    const last = () => lines.filter((l) => /card clock/.test(l)).join(' | ');

    ok(FW.headerKept() === null, 'a phone that has fetched nothing has no header kept');
    // both explorers agree
    const t1 = now() - 300;
    const h1 = mineHeader(t1, CHEAP);
    tipIs(F, h1);
    fresh();
    let r = await FW.headerRefresh();
    const kept = FW.headerKept();
    ok(r.fetched && r.why === 'agree' && kept && kept.hex === h1 && kept.hash === hashOfHeader(h1) && kept.time === t1,
       'the explorers agree on the tip: it is kept, with its time and its hash', r.why + ' ' + (kept && kept.hash.slice(0, 12)));
    const asked = F.explored.map((x) => x.host.split('.')[0].slice(0, 8) + ' ' + x.path.replace(/[0-9a-f]{64}/, '<tip>'));
    ok(F.explored.length === 4 && F.explored.every((x) => x.method === 'GET' && /^http:\/\/[a-z2-7]{56}\.onion\/api\//.test(x.url)),
       'four requests, all GET, all to onion addresses over plain http (an onion is authenticated by its name)', asked.join(', '));
    ok(F.explored.filter((x) => x.path === '/api/blocks/tip/hash').length === 2 && F.explored.filter((x) => /^\/api\/block\/[0-9a-f]{64}\/header$/.test(x.path)).length === 2,
       'each asks for the tip’s hash and then for that block’s header');
    const byHost = {};
    F.explored.forEach((x) => { (byHost[x.host] = byHost[x.host] || new Set()).add(x.circuit); });
    const circuits = Object.values(byHost);
    ok(circuits.length === 2 && circuits.every((s) => s.size === 1 && [...s][0].length === 32) && [...circuits[0]][0] !== [...circuits[1]][0],
       'each source on a circuit of its own, and both of its requests on that one', JSON.stringify(circuits.map((s) => [...s].map((x) => x.slice(0, 6)))));
    ok(/block \w{8} \(time \d+\) is the tip of both sources/.test(last()), 'and the log says the two agreed', last());
    ok(JSON.parse(F.storage.getItem('foxy.flashcard.header')).hex === h1, 'it is kept in storage, where a restart finds it');
    // the second fetch within ten minutes is not made
    fresh();
    r = await FW.headerRefresh();
    ok(!r.fetched && r.why === 'fresh' && F.explored.length === 0, 'one kept less than ten minutes ago is not fetched again: no request is made');
    // ten minutes on it is
    skew = 11 * 60 * 1000;
    const h2 = mineHeader(now() - 100, CHEAP);
    tipIs(F, h2);
    fresh();
    r = await FW.headerRefresh();
    ok(r.fetched && FW.headerKept().hex === h2 && F.explored.length === 4, 'ten minutes on it is asked for again, and a newer block replaces the one kept', r.why);
    // not an older block over a newer one
    skew = 22 * 60 * 1000;
    tipIs(F, h1);
    fresh();
    r = await FW.headerRefresh();
    ok(!r.fetched && r.why === 'older' && FW.headerKept().hex === h2, 'an older block than the one kept does not replace it', last());

    /* --- what is not believed --------------------------------------------------------------------------------------------- */
    const reset = () => { skew += 11 * 60 * 1000; fresh(); };
    // a header with no work in it, from both
    reset();
    const bad = mineHeader(now() - 60, CHEAP, { fail: true });
    tipIs(F, bad);
    r = await FW.headerRefresh();
    ok(!r.fetched && FW.headerKept().hex === h2 && /over the target/.test(last()), 'a header whose hash is over its own target is dropped, and the log says why', last());
    // a source that names one block and gives another's header
    reset();
    const good = mineHeader(now() - 50, CHEAP);
    tipIs(F, good, { lie: { mempool: mineHeader(now() - 40, CHEAP), blockstream: mineHeader(now() - 40, CHEAP) } });
    r = await FW.headerRefresh();
    ok(!r.fetched && FW.headerKept().hex === h2 && /not the block it named/.test(last()), 'a header that is not the block the source named is dropped');
    // the two name different tips
    reset();
    const a = mineHeader(now() - 90, CHEAP), b = mineHeader(now() - 80, CHEAP);
    tipIs(F, a, { per: { mempool: a, blockstream: b } });
    r = await FW.headerRefresh();
    ok(!r.fetched && r.why === 'disagree' && FW.headerKept().hex === h2 && /different tips/.test(last()), 'the two name different tips: nothing is kept, and the log says so', last());
    // a stale header: too far behind this phone's clock, and too far ahead, from both
    for (const [off, name] of [[-(3 * 3600 + 120), 'behind'], [3 * 3600 + 120, 'ahead of']]) {
      reset();
      tipIs(F, mineHeader(now() + off, CHEAP));
      r = await FW.headerRefresh();
      ok(!r.fetched && FW.headerKept().hex === h2 && new RegExp('three hours ' + name).test(last()),
         'a header more than three hours ' + name + ' this phone’s clock is dropped, so a stale source is not taken for the time', last());
    }
    {
      // on a page that has nothing kept, so that it is not an older block than one that is
      const G = page({});
      const g = G.window.Date.now;
      const edge = Math.floor(g() / 1000) - (3 * 3600 - 60);
      tipIs(G, mineHeader(edge, CHEAP));
      const inside = await G.W.headerRefresh();
      ok(inside.fetched && G.W.headerKept() && G.W.headerKept().time === edge, 'and one just inside three hours is kept', inside.why);
    }
    // a phone whose own clock is wrong keeps nothing: every header looks stale
    reset();
    const keptBefore = FW.headerKept().hex;
    skew += 10 * 3600 * 1000;
    // (the network’s time is the real one: a block two minutes old by it, on a phone whose clock is ten hours ahead)
    const wrongClock = mineHeader(Math.floor(real() / 1000) - 120, CHEAP);
    tipIs(F, wrongClock);
    r = await FW.headerRefresh();
    ok(!r.fetched && FW.headerKept().hex === keptBefore, 'a phone whose clock is ten hours out keeps no header: what the network says is not what its clock says');
    skew -= 10 * 3600 * 1000;

    // one source down
    for (const down of ['mempool', 'blockstream']) {
      reset();
      const lone = mineHeader(now() - 30, CHEAP);
      tipIs(F, lone, { only: down === 'mempool' ? 'blockstream' : 'mempool' });
      r = await FW.headerRefresh();
      ok(r.fetched && r.why === 'one' && FW.headerKept().hex === lone && /only (mempool|blockstream)\.\w+ gave a header/.test(last()) && /taken on its word alone/.test(last()),
         'with ' + down + ' not answering, the other is taken if it passes the other checks, and the log says it was alone', last());
    }
    // one source answers with an error, the other is good
    reset();
    {
      const lone = mineHeader(now() - 20, CHEAP);
      tipIs(F, lone);
      const answer = F.explorer;
      F.explorer = (host, path) => (host === EXPLORERS.blockstream ? '500\nboom' : answer(host, path));
      r = await FW.headerRefresh();
      ok(r.fetched && r.why === 'one' && FW.headerKept().hex === lone && /blockstream\.info: The server answered 500/.test(last()), 'a source that answers 500 is a source that is down, and the log names it', last());
      // (a newer block, so that what the one good source says is not the block already kept)
      reset();
      const newer = mineHeader(now() - 10, CHEAP);
      tipIs(F, newer);
      const answerNewer = F.explorer;
      F.explorer = (host, path) => (host === EXPLORERS.blockstream ? '200\nnot hex at all' : answerNewer(host, path));
      r = await FW.headerRefresh();
      ok(r.fetched && r.why === 'one' && FW.headerKept().hex === newer && /blockstream\.info: what it called the tip is not a block hash/.test(last()),
         'and one that answers with something that is no hash is no source, with its reason in the log', last());
    }
    // one hangs, as an onion over Tor can: it is given up on after its time, and the other is taken
    reset();
    {
      const lone = mineHeader(now() - 12, CHEAP);
      tipIs(F, lone);
      const answer = F.explorer;
      F.explorer = (host, path) => (host === EXPLORERS.blockstream ? new Promise(() => {}) : answer(host, path));
      FW._headerAskMs = 150;
      const began = Date.now();
      r = await FW.headerRefresh();
      const took = Date.now() - began;
      FW._headerAskMs = 25000;
      ok(r.fetched && r.why === 'one' && FW.headerKept().hex === lone && took >= 140 && took < 2000 && /blockstream\.info did not answer within/.test(last()),
         'a source that never answers is given up on after its time, and the other is taken', took + ' ms: ' + last());
      F.explorer = answer;
    }
    // one is stale and the other is fresh
    reset();
    {
      const freshOne = mineHeader(now() - 10, CHEAP), stale = mineHeader(now() - 5 * 3600, CHEAP);
      tipIs(F, freshOne, { per: { mempool: freshOne, blockstream: stale } });
      r = await FW.headerRefresh();
      ok(r.fetched && r.why === 'one' && FW.headerKept().hex === freshOne && /blockstream\.info: its time is more than three hours behind/.test(last()),
         'a stale source and a good one: the good one is taken, and the log says the other was stale', last());
    }
    // both down
    reset();
    {
      const was = FW.headerKept().hex;
      F.explorer = () => null;
      r = await FW.headerRefresh();
      ok(!r.fetched && r.why === 'none' && FW.headerKept().hex === was && /no block header could be used/.test(last()), 'both down: nothing changes, and the log says so', last());
      // a minute’s rest after a try that kept nothing
      fresh();
      r = await FW.headerRefresh();
      ok(r.why === 'tried lately' && F.explored.length === 0, 'and the phone does not try again for a minute: no request');
      skew += 61 * 1000 + 11 * 60 * 1000;
      tipIs(F, mineHeader(now() - 5, CHEAP));
      fresh();
      r = await FW.headerRefresh();
      ok(r.fetched, 'a minute on it does (the one kept is old by then)');
    }
    // a request made while one is in flight shares it
    reset();
    {
      const before = F.explored.length;
      let release;
      const gate = new Promise((go) => { release = go; });
      const answer = (tipIs(F, mineHeader(now() - 3, CHEAP)), F.explorer);
      F.explorer = (host, path) => gate.then(() => answer(host, path));
      const one = FW.headerRefresh(), two = FW.headerRefresh();
      await new Promise((go) => setTimeout(go, 20));
      release();
      const [x, y] = await Promise.all([one, two]);
      ok(x.fetched && y.fetched && F.explored.length - before === 4, 'asked twice while a fetch is in flight, it is made once: four requests, not eight', String(F.explored.length - before));
    }
    // a source that quotes its answer, or ends it with a line break, is read all the same
    reset();
    {
      const quoted = mineHeader(now() - 2, CHEAP);
      tipIs(F, quoted);
      const answer = F.explorer;
      F.explorer = (host, path) => { const a = answer(host, path); return (typeof a === 'string' && a.startsWith('200\n')) ? '200\n"' + a.slice(4) + '"\n' : a; };
      r = await FW.headerRefresh();
      ok(r.fetched && FW.headerKept().hex === quoted, 'an answer in quotes and with a line break after it is read all the same', last());
      F.explorer = answer;
    }
    // no route: nothing is asked
    reset();
    {
      FW._privacy({ tor: 'connecting', progress: 20, everUp: true, network: 'wifi' });
      r = await FW.headerRefresh({ force: true });
      ok(!r.fetched && r.why === 'offline' && F.explored.length === 0, 'with no route (Tor not up) nothing is asked, even when forced');
      FW._privacy({ tor: 'up', progress: 100, everUp: true, network: 'none' });
      r = await FW.headerRefresh({ force: true });
      ok(r.why === 'offline' && F.explored.length === 0, 'nor with no network under it');
      FW._privacy({ tor: 'up', progress: 100, everUp: true, network: 'wifi' });
    }
    // storage that has been tampered with is not believed: the header is read again from its 80 bytes
    {
      const stored = JSON.parse(F.storage.getItem('foxy.flashcard.header'));
      F.storage.setItem('foxy.flashcard.header', JSON.stringify(Object.assign({}, stored, { time: 9999999999, hash: '00'.repeat(32) })));
      const again = FW.headerKept();
      ok(again.time === stored.time && again.hash === stored.hash, 'what is stored beside the 80 bytes is not believed: time and hash are read from the bytes', String(again.time));
      F.storage.setItem('foxy.flashcard.header', JSON.stringify({ hex: spoiled(stored.hex), at: Date.now() }));
      ok(FW.headerKept() === null, 'and bytes without work in them are no header at all');
      F.storage.setItem('foxy.flashcard.header', 'not json {');
      ok(FW.headerKept() === null, 'nor is storage that is not readable');
      F.storage.setItem('foxy.flashcard.header', JSON.stringify(stored));
    }
    // asked a dozen times, ok and failed, the explorers have left no record in the mint health store: it keeps one for every address asked of the road, and a block’s has its hash in it
    ok(Object.keys(JSON.parse(F.storage.getItem('foxy.mint.health') || '{}')).filter((k) => /onion/.test(k)).length === 0,
       'the explorers are not mints: nothing of them is in the store of which mints answer', Object.keys(JSON.parse(F.storage.getItem('foxy.mint.health') || '{}')).join(' ').slice(0, 120));
    // the text of an answer comes through as it came: not read as JSON
    ok(await FW.nativeRequest({ endpoint: 'http://' + EXPLORERS.mempool + '/api/blocks/tip/hash', method: 'GET', foxyText: true }).then((t) => /^[0-9a-f]{64}$/.test(t), () => false),
       'the road the explorers are asked on gives back an answer’s text, as it came, when it is asked to');
    F.window.console.log = log;
  }

  /* ---- 3: a tap ------------------------------------------------------------------------------------------------------------------ */
  {
    const H = await funded({}, 6000);
    const HW = H.W;
    const real = H.window.Date.now.bind(H.window.Date);
    const now = () => Math.floor(H.window.Date.now() / 1000);
    const lines = [];
    const log = H.window.console.log, warn = H.window.console.warn;
    H.window.console.log = (...a) => { lines.push(a.join(' ')); };
    H.window.console.warn = (...a) => { lines.push('WARN ' + a.join(' ')); };
    const c = newCard(H, undefined, { format: 4, floorBits: CHEAP });
    await HW.cardSetUp(c, { pin: '1234', recoverable: true });
    const setup = c.sent.map((a) => a.slice(0, 6));
    ok(!H.phone.asks.some((a) => a.action === 'cardTime'), 'a card of 1.15 is not told a signed time: the page never asks the phone to sign one');
    ok(c.state.now === 0 && c.state.record.timeKey === '00'.repeat(65) && !!c.state.owner,
       'set up with no header kept: it has no clock, and its record has no time key (zeros where one was), and an owner', setup.join(' '));
    // the SET_CARD the phone sent carried zeros where the time key was (a 1.14 phone sent the key)
    const setCard = c.sent.filter((a) => a.slice(0, 6) === 'b03200')[0] || '';
    ok(setCard.length > 0 && /^b0320000[0-9a-f]{2}[0-9a-f]{2}[0-9a-f]{66}0{130}[0-9a-f]{2}/.test(setCard) && setCard.substr(10 + 2 + 66, 130) === '0'.repeat(130),
       'the record the phone wrote to it holds 65 zeros where a time key would be', setCard.slice(0, 40) + '…');

    // a tap with no header kept: the time is told, no header is sent
    c.tap(); c.sent.length = 0;
    H.window.Date.now = () => 1790000000 * 1000 + 123;
    let seen = await HW.cardLook(c);
    ok(insOf(c).join(' ') === '01 37 10 15 16' || insOf(c).join(' ') === '01 37 10 16' || /^01 37 /.test(insOf(c).join(' ')),
       'a tap with no header kept: GET_INFO, then TELL_TIME, and no SET_HEADER', insOf(c).join(' '));
    ok(count(c, '36') === 0 && count(c, '35') === 0 && c.state.told === 1790000000 && c.state.now === 0,
       'the phone’s own clock is the time told (whole seconds), and the card’s clock has not moved', String(c.state.told));
    ok(seen.clock && seen.clock.told === true && seen.clock.sent === false && seen.info.headers && seen.day.noTime === false, 'card.clock says what was done');

    // now a header is kept, newer than the card's clock
    H.window.Date.now = real;
    const t1 = now() - 400;
    const h1 = mineHeader(t1, CHEAP);
    tipIs(H, h1);
    await HW.headerRefresh({ force: true });
    lines.length = 0;
    c.tap(); c.sent.length = 0;
    seen = await HW.cardLook(c);
    ok(insOf(c).slice(0, 5).join(' ') === '01 37 36 01 10', 'a tap with a newer header: GET_INFO, TELL_TIME, SET_HEADER, GET_INFO again, and then the rest', insOf(c).join(' '));
    ok(c.state.now === t1 && seen.info.now === c.state.now && seen.info.headerTime === c.state.now && seen.clock.sent && seen.clock.now === c.state.now && seen.clock.was === 0,
       'the card’s clock is the header’s time, and what the tap read of the card is what the card has now', JSON.stringify(seen.clock));
    ok(seen.info.headerHash === hashOfHeader(h1) && seen.record.headerHash === hashOfHeader(h1) && seen.info.headerBits === 'ffff7f20',
       'with the hash and the difficulty it took the clock from', seen.info.headerHash.slice(0, 12));
    ok(lines.some((l) => /its clock was 0, block \w{8} \(time \d+\) moved it to \d+/.test(l)), 'and the log has the clock before and after', lines.filter((l) => /clock/.test(l)).join(' | '));
    // the same header on the next tap: the card is current, so only the note
    c.tap(); c.sent.length = 0; lines.length = 0;
    seen = await HW.cardLook(c);
    ok(insOf(c).slice(0, 3).join(' ') === '01 37 10' && count(c, '36') === 0 && seen.clock.sent === false, 'the card is current: only the time is told, and no header is sent', insOf(c).join(' '));
    // a card ahead of the kept header: nothing is sent; more than three hours ahead is a line in the log, and nothing else
    c.tap(); c.state.now += 4 * 3600; c.sent.length = 0; lines.length = 0;
    seen = await HW.cardLook(c);
    ok(count(c, '36') === 0 && seen.clockAhead >= 4 * 3600 - 5 && seen.clockAhead < 4 * 3600 + 60 && lines.some((l) => /WARN .*ahead of the newest block header this phone has/.test(l)),
       'a card more than three hours ahead of the newest header this phone has is sent nothing, and the log has a warning line', String(seen.clockAhead));
    c.state.now -= 4 * 3600;
    c.tap(); c.state.now += 2 * 3600; c.sent.length = 0; lines.length = 0;
    seen = await HW.cardLook(c);
    ok(seen.clockAhead === 0 && !lines.some((l) => /WARN/.test(l)), 'and two hours ahead is not worth a line');
    c.state.now -= 2 * 3600;

    // within one tap the time is told once, however many reads
    {
      c.tap(); c.sent.length = 0;
      const link = { send: (a) => c.send(a), one: {} };
      await HW.cardLook(link);
      await HW.cardLook(link);
      ok(count(c, '37') === 1, 'within one time in the field the time is told once, however many times the card is read', insOf(c).join(' '));
      // the card leaves the field and comes back (a re-tap): it has forgotten, and is told again
      c.tap(); link.one.told = false; link.one.key = ''; link.one.paid = 0;
      c.sent.length = 0;
      await HW.cardLook(link);
      ok(count(c, '37') === 1, 'and again when it has left the field and come back');
    }
    // a card that refuses the header (below its floor: the phone has a header the card thinks too easy)
    {
      const strict = newCard(H, undefined, { format: 4 });   // the real floor
      await strict.send(SEL);
      lines.length = 0;
      const seenStrict = await HW.cardLook(strict);
      ok(seenStrict.clock.sent === true && seenStrict.clock.refused === '6a93' && strict.state.now === 0 && seenStrict.info.now === 0,
         'a card that refuses the header (6A93: too little work for its floor) keeps the clock it had, and the tap goes on', JSON.stringify(seenStrict.clock));
      ok(lines.some((l) => /WARN .*would not take block \w{8} \(6a93\)/.test(l)), 'with a line in the log', lines.join(' | ').slice(0, 200));
      ok(count(strict, '36') === 1 && count(strict, '01') === 1, 'and GET_INFO is not read again for a clock that did not move');
    }
    // gone while the header is being sent: a card that left is an error, as for any other command
    {
      const brief = newCard(H, undefined, { format: 4, floorBits: CHEAP });
      brief.leaveBefore('36', 1);
      ok((await why(HW.cardLook(brief))) === 'gone', 'a card that leaves as the header is sent has gone: the tap fails as it does for any command');
    }
    // 1.14 is as it was: told the time under a signature, before GET_INFO, and no header
    {
      const old = newCard(H, undefined, { format: 4, floorBits: CHEAP, software: 14 });
      await HW.cardSetUp(old, { pin: '1234', recoverable: true });
      ok(old.state.record.timeKey === HW.cardTimeKey, 'a card of 1.14 is set up with the interim time key in its record, as ever');
      old.tap(); old.sent.length = 0;
      const readOld = await HW.cardLook(old);
      ok(insOf(old).slice(0, 3).join(' ') === '35 01 10' && count(old, '36') === 0 && count(old, '37') === 0 && readOld.info.version === '1.14' && !readOld.info.headers
         && readOld.info.now > 1700000000,
         'a card of 1.14 is told the time as it was: signed, before it says what it is; no header, no note', insOf(old).join(' '));
      ok(H.phone.asks.some((a) => a.action === 'cardTime'), 'and the page asked the phone to sign it');
    }

    // a tap does not wait for the fetch
    {
      H.window.console.log = log; H.window.console.warn = warn;
      const K = page({ headers: true });
      const KW = K.W;
      let release;
      const gate = new Promise((go) => { release = go; });
      const hTime = Math.floor(Date.now() / 1000) - 60;
      const h = mineHeader(hTime, CHEAP);
      tipIs(K, h);
      const answer = K.explorer;
      K.explorer = (host, path) => gate.then(() => answer(host, path));
      await KW.connect('https://m.test', null, null, { remember: true });
      await KW.primeLocks();
      const slow = newCard(K, undefined, { format: 4, floorBits: CHEAP });
      K.nfc = slow;
      const done = await KW.cardSession('Hold the card', (link) => KW.cardLook(link));
      ok(done && done.info && KW.headerKept() === null && K.explored.length >= 1,
         'a tap with a fetch of the header in flight is not held up by it: the card was read while the sources had not answered', K.explored.length + ' request(s) out');
      ok(count(slow, '36') === 0, 'and uses what is kept, which is nothing yet: no header sent');
      release();
      await settle();
      ok(KW.headerKept() && KW.headerKept().hex === h, 'the header lands when the sources answer');
      K.nfc = slow;
      slow.tap();
      slow.sent.length = 0;
      const next = await KW.cardSession('Hold the card', (link) => KW.cardLook(link));
      ok(next.info.now === hTime && count(slow, '36') === 1, 'and the next tap uses it', insOf(slow).join(' '));
      // the fetches that happen on their own: Tor comes up, a card is tapped
      const J = page({ headers: true });
      const before = J.explored.length;
      tipIs(J, mineHeader(Math.floor(Date.now() / 1000) - 10, CHEAP));
      J.W._privacy({ tor: 'connecting', progress: 20, everUp: true, network: 'wifi' });
      J.W._privacy({ tor: 'up', progress: 100, everUp: true, network: 'wifi' });
      await until('the header to be asked for when Tor comes up', () => J.explored.length >= 4);
      await settle();
      ok(J.W.headerKept() !== null && J.explored.length === 4, 'Tor coming up fetches the header, once', String(J.explored.length - before));
      const quiet = page({});
      tipIs(quiet, mineHeader(Math.floor(Date.now() / 1000) - 10, CHEAP));
      quiet.W._privacy({ tor: 'connecting', progress: 20, everUp: true, network: 'wifi' });
      quiet.W._privacy({ tor: 'up', progress: 100, everUp: true, network: 'wifi' });
      await settle();
      ok(quiet.explored.length === 0, 'and a page made to stay quiet (the suites) fetches nothing on its own');
    }
    H.window.console.log = log; H.window.console.warn = warn;
    await settle();
  }

  /* ---- 3b: a day, by the blocks ------------------------------------------------------------------------------------------------------------- */
  {
    // the holder sets a daily limit; a till pays up to it; the day turns when the blocks say so, a second short of a day and at a day, and not before
    const H = await funded({}, 6000);
    const R = await funded({ sharedMint: H.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 0);
    const clock = { sec: Math.floor(Date.now() / 1000) };
    for (const c of [H, R]) c.window.Date.now = () => clock.sec * 1000;
    const T0 = clock.sec - 60;
    const show = async (page, at) => { tipIs(page, mineHeader(at, CHEAP)); await page.W.headerRefresh({ force: true }); };
    const card = newCard(H, undefined, { format: 4, floorBits: CHEAP });
    await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await H.W.cardAdd(card, { sats: 2000, owner: true });
    await show(H, T0);
    card.tap();
    await H.W.cardSetLimit(card, { sats: 600 });
    ok(card.state.now === T0 && card.state.windowStart === T0 && card.state.record.limit === 600, 'a limit of 600 a day, set when the card has been shown a block: its day begins at the block’s time', JSON.stringify([card.state.now - T0, card.state.windowStart - T0]));
    await show(R, T0);
    card.tap();
    const a = await R.W.cardPay(card, { sats: 300, pin: '1234' });
    if (R.W.cardOwed().length) { card.tap(); await R.W.cardWrite(card, { pin: '1234' }); }
    card.tap();
    const b = await R.W.cardPay(card, { sats: 300, pin: '1234' });
    if (R.W.cardOwed().length) { card.tap(); await R.W.cardWrite(card, { pin: '1234' }); }
    ok(a.sats === 300 && b.sats === 300 && card.state.spent >= 600 && card.state.spent <= 600 + 8, 'a till takes 600 in two payments: the day is used up', String(card.state.spent));
    card.tap();
    const third = await R.W.cardPay(card, { sats: 100, pin: '1234' }).then(() => null, (e) => e);
    ok(third && third.card === 'limit' && third.turns === T0 + 86400, 'and a third is refused before the PIN, saying when the day turns: a day after the block, not a day after the phone’s clock', third && (third.card + ' ' + (third.turns - T0)));
    // a second short of a day later, by the block’s time: the same day
    clock.sec = T0 + 86399 + 60;
    await show(R, T0 + 86399);
    card.tap();
    const same = await R.W.cardPay(card, { sats: 100, pin: '1234' }).then(() => null, (e) => e);
    ok(card.state.now === T0 + 86399 && same && same.card === 'limit', 'a block a second short of a day on: the card’s clock moves, and it is the same day', same && same.message);
    // a till whose own clock is a day ahead cannot turn it: the card’s day is the blocks’
    R.window.Date.now = () => (clock.sec + 86400) * 1000;
    card.tap();
    const lying = await R.W.cardPay(card, { sats: 100, pin: '1234' }).then(() => null, (e) => e);
    R.window.Date.now = () => clock.sec * 1000;
    ok(lying && lying.card === 'limit' && card.state.now === T0 + 86399, 'a till whose clock is a day ahead cannot turn the card’s day: what it tells is a note, and no block of that time exists');
    // the block at a day: a new day, and only this payment is in it
    clock.sec = T0 + 86400 + 60;
    await show(R, T0 + 86400);
    card.tap();
    const next = await R.W.cardPay(card, { sats: 100, pin: '1234' });
    ok(next.sats === 100 && card.state.windowStart === T0 + 86400 && card.state.spent >= 100 && card.state.spent <= 108,
       'a block at 86,400 seconds: a new day begins at its time, and the same payment goes', JSON.stringify([card.state.windowStart - T0, card.state.spent]));
    if (R.W.cardOwed().length) { card.tap(); await R.W.cardWrite(card, { pin: '1234' }); }
    await settle();
  }

  /* ---- 3c: a new record keeps the clock -------------------------------------------------------------------------------------------------- */
  {
    // an empty card told its new mint, with the owner's proof: the record it is sent has zeros where a time key was (the phone's rules for what it will
    // sign allow that), and the card keeps the clock and the hash of the last block it had, and lets the ratchet go (the hardest difficulty it has taken is
    // forgotten, the next block sets it afresh); a card before 1.15 that was sent a different time key lost its clock instead
    const M = await funded({ second: true }, 0);
    const c = newCard(M, undefined, { format: 4, floorBits: CHEAP });
    await M.W.cardSetUp(c, { pin: '1234', recoverable: true });
    tipIs(M, mineHeader(Math.floor(M.window.Date.now() / 1000) - 30, CHEAP));
    await M.W.headerRefresh({ force: true });
    c.tap();
    await M.W.cardLook(c);
    const was = { now: c.state.now, hardest: c.state.hardest, hash: c.state.headerHash };
    ok(was.hardest !== 0 && was.now > 0, 'the card has a clock and a difficulty to keep or lose before it is told its new mint');
    await M.W.connect(MINT2, null, null, { remember: false });
    c.tap();
    c.sent.length = 0;
    const moved = await M.W.cardRepoint(c);
    // the command’s data is the owner’s proof (its length, then it) and then the record: unit (1), refund key (33), the time key's 65 bytes, the mint
    const setCard = c.sent.filter((a) => a.slice(0, 4) === 'b032')[0] || '';
    const data = setCard.slice(10), proofLen = parseInt(data.substr(0, 2), 16), record = data.slice(2 + proofLen * 2);
    ok(moved.record.mint === MINT2 && c.state.record.mint === MINT2 && record.substr(34 * 2, 130) === '0'.repeat(130) && parseInt(record.substr(99 * 2, 2), 16) === MINT2.length,
       'an empty card is told its new mint, in a record with zeros where a time key was, and the phone signed it', moved.record.mint + ' ' + record.substr(34 * 2, 12) + '…');
    ok(c.state.now > 0 && c.state.now === was.now && c.state.headerHash === was.hash && moved.info.now === was.now && moved.record.headerHash === was.hash && moved.info.headerTime === was.now,
       'and keeps its clock through the new record: the time, and the hash of the last block', JSON.stringify([c.state.now === was.now, c.state.headerHash === was.hash]));
    ok(c.state.hardest === 0 && moved.record.headerBits === '' && moved.info.headerBits === '',
       'but the new record lets the ratchet go: the hardest difficulty it had taken is nothing, as the record says', String(c.state.hardest));
  }

  /* ---- 4: what a card of 1.15 gives of its record, its log and its receipts -------------------------------------------------------- */
  {
    // the layouts, by hand: the record, with the clock's proof where the time key was
    const rec = '04' + '01' + '00' + '00000000' + '02' + '11'.repeat(32) + 'f01e0217' + TIP.hash + '00'.repeat(29) + '0e' + Buffer.from('https://m.test', 'latin1').toString('hex') + '000000';
    const info15 = { headers: true };
    const parsed = W.cardParse.record(rec, info15);
    ok(parsed.headerBits === 'f01e0217' && parsed.headerHash === TIP.hash && parsed.timeKey === '' && parsed.mint === 'https://m.test',
       'the record of a card of 1.15 is read with its difficulty and its last hash where the time key was', JSON.stringify([parsed.headerBits, parsed.headerHash.slice(0, 12)]));
    const old = W.cardParse.record(rec, { headers: false });
    ok(old.timeKey.length === 130 && old.headerBits === '' && old.headerHash === '', 'and the same bytes are a time key to a card before it, which knows no better');
    ok(W.cardParse.record(rec).timeKey.length === 130, 'and with no word of the card’s software the old layout is read, as it always was');
    const zeros = W.cardParse.record(rec.replace('f01e0217' + TIP.hash + '00'.repeat(29), '00'.repeat(65)), info15);
    ok(zeros.headerBits === '' && zeros.headerHash === '', 'a card that has taken no header says zeros, which read as none');
    // the log: twenty bytes an entry
    const head = '00000003' + '00000064' + '00000001' + '00000000';
    const entry = (time, sats, pieces, refused, flags, loads, loaded, told) => u32(time) + u32(sats) + ('0' + pieces.toString(16)).slice(-2) + ('0' + refused.toString(16)).slice(-2)
      + ('0' + flags.toString(16)).slice(-2) + ('0' + loads.toString(16)).slice(-2) + u32(loaded) + u32(told);
    const logHex = head + entry(1791614069, 100, 3, 0, 2, 2, 50, 1791614100) + entry(1791614069, 0, 0, 1, 1, 0, 0, 0) + entry(0, 0, 0, 0, 4, 0, 0, 0);
    const log = W.cardParse.log(logHex, true, true);
    ok(log.taps === 3 && log.sats === 100 && log.refused === 1 && log.last.length === 3, 'a log of three entries of twenty bytes is read', JSON.stringify([log.taps, log.last.length]));
    ok(log.last[0].time === 1791614069 && log.last[0].told === 1791614100 && log.last[0].sats === 100 && log.last[0].pieces === 3 && log.last[0].waited === true && log.last[0].loads === 2 && log.last[0].loaded === 50,
       'each with the card’s clock, the time its terminal told it, what was signed for and what was put on', JSON.stringify(log.last[0]));
    ok(log.last[1].tamper === true && log.last[1].told === 0 && log.last[1].refused === 1, 'a refusal run is marked, and no time was told');
    ok(log.last[2].clock === false, 'the flag that once meant a clock moved twice is not read: a card of 1.15 never sets it');
    let rejected = false;
    try { W.cardParse.log(logHex, true, false); } catch (e) { rejected = true; }
    ok(rejected, 'twenty-byte entries are not read as sixteen (a log of the wrong shape is no log)');
    const sixteen = W.cardParse.log(head + '6b49d26e' + '00000064' + '01' + '00' + '05' + '00' + '00000000', true, false);
    ok(sixteen.last[0].told === 0 && sixteen.last[0].time === 0x6b49d26e && sixteen.last[0].clock === true, 'and sixteen-byte entries (1.14 and before) are read as ever, with the flag, and told nothing');
    // the receipts: seventy-seven bytes
    const receipt = (time, told, sats, hash, out) => u32(time) + u32(told) + u32(sats) + hash + out;
    const rHex = '00000002' + receipt(1791614069, 1791614100, 700, 'ab'.repeat(32), '02' + 'cd'.repeat(32)) + receipt(1791600000, 0, 20, 'ef'.repeat(32), '03' + '12'.repeat(32));
    const receipts = W.cardParse.receipts(rHex, true);
    ok(receipts.count === 2 && receipts.list.length === 2 && receipts.list[0].time === 1791614069 && receipts.list[0].told === 1791614100 && receipts.list[0].sats === 700
       && receipts.list[0].hash === 'ab'.repeat(32) && receipts.list[0].out === '02' + 'cd'.repeat(32) && receipts.list[1].told === 0 && receipts.list[1].sats === 20,
       'receipts of seventy-seven bytes are read: the card’s clock, the time told, the sats, the hash and the output', JSON.stringify(receipts.list[0]).slice(0, 120));
    const rOld = W.cardParse.receipts('00000001' + u32(1791614069) + u32(700) + 'ab'.repeat(32) + '02' + 'cd'.repeat(32), false);
    ok(rOld.list[0].time === 1791614069 && rOld.list[0].sats === 700 && rOld.list[0].told === undefined && rOld.list[0].hash === 'ab'.repeat(32), 'and receipts of seventy-three (1.14 and before) as ever, with no time told');
    let bad = false;
    try { W.cardParse.receipts(rHex, false); } catch (e) { bad = true; }
    ok(bad, 'seventy-seven-byte receipts are not read as seventy-three');
    // and from the card itself: a payment, then what its owner reads
    const Hh = await funded({}, 6000);
    const Rr = await funded({ sharedMint: Hh.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 0);
    const real = Hh.window.Date.now.bind(Hh.window.Date);
    const card = newCard(Hh, undefined, { format: 4, floorBits: CHEAP });
    await Hh.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await Hh.W.cardAdd(card, { sats: 1000, owner: true });
    const blockAt = Math.floor(real() / 1000) - 120;
    tipIs(Rr, mineHeader(blockAt, CHEAP));
    await Rr.W.headerRefresh({ force: true });
    card.tap();
    Rr.window.Date.now = () => 1790000000 * 1000;       // the till’s clock, a few days earlier than the block: a note, trusted for nothing
    const paid = await Rr.W.cardPay(card, { sats: 300, pin: '1234' });
    Rr.window.Date.now = real;
    ok(paid.sats === 300, 'a till pays from the card');
    ok(card.state.receipts.count === 1 && card.state.receipts.ring[0].told === 1790000000 && card.state.receipts.ring[0].time === card.state.now,
       'the card wrote the receipt with its own clock and the time the till told it', JSON.stringify([card.state.receipts.ring[0].time, card.state.receipts.ring[0].told]));
    card.tap();
    const own = await Hh.W.cardLook(card, { mine: true });
    ok(own.mine === true && own.log && own.log.last.some((x) => x.told === 1790000000 && x.sats >= 300 && x.time === card.state.now),
       'its owner’s phone reads a log whose entry for the payment has both times', JSON.stringify(own.log.last.map((x) => [x.time, x.told, x.sats])));
    ok(own.receipts && own.receipts.list.length === 1 && own.receipts.list[0].told === 1790000000 && own.receipts.list[0].time === card.state.now && own.receipts.list[0].sats >= 300,
       'and the receipt with both', JSON.stringify(own.receipts && own.receipts.list[0]).slice(0, 140));
    const saved = Hh.W.cardReceipts(card.key);
    ok(saved.length === 1 && saved[0].told === 1790000000, 'and keeps it, the told time too');
    ok(own.log.last.every((x) => x.clock === false) && own.log.last.every((x) => !x.tamper), 'a card of 1.15 marks nothing as a false time, and the till’s clock being days out moved nothing');
    // the day the card counts is by its block clock, and the till cannot move it
    ok(card.state.now === blockAt, 'the till’s false clock did not move the card’s: its day is where the block put it', String(card.state.now));
    await settle();
  }

  /* ---- 5: the screen ------------------------------------------------------------------------------------------------------------------------- */
  {
    const H = await funded({}, 6000);
    const holder = appOn(H);
    holder.price = 100000;
    await holder.refreshBalance();
    const real = H.window.Date.now.bind(H.window.Date);
    const t0 = Math.floor(real() / 1000);
    const c = newCard(H, undefined, { format: 4, floorBits: CHEAP });
    await H.W.cardSetUp(c, { pin: '1234', recoverable: true });
    c.tap();
    H.nfc = c;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc && holder.state.fc.hasRecord);
    let v = vals(holder);
    ok(holder.state.fc.headers === true && v.fcClockShown === true && v.fcClockLine === 'CLOCK · NO BLOCK YET',
       'a card of 1.15 that has been shown no block says so, under its limits', v.fcClockLine);
    // a block, shown
    const h = mineHeader(t0 - 90, CHEAP);
    tipIs(H, h);
    await H.W.headerRefresh({ force: true });
    c.tap();
    holder.fcRead();
    await until('the card to be read again', () => holder.state.fc && holder.state.fc.clock && holder.state.fc.clock.time > 0);
    v = vals(holder);
    const want = 'CLOCK · block ' + H.W.headerShort(hashOfHeader(h)) + '… · ' + holder.fcWhen(t0 - 90).toUpperCase();
    ok(v.fcClockShown && v.fcClockLine === want, 'a card that has a block shows its hash (the eight digits after the zeros) and the time in it', v.fcClockLine);
    // the real tip, at the real floor: the eight digits after its nineteen zeros
    const strict = newCard(H, undefined, { format: 4 });
    await strict.send(SEL);
    await strict.send(headerCmd(TIP.hex));
    strict.tap();
    H.nfc = strict;
    holder.state.fc = null;
    holder.fcRead(true);
    await until('the strict card to be read', () => holder.state.fc && holder.state.fc.clock && holder.state.fc.clock.short);
    v = vals(holder);
    ok(holder.state.fc.hasRecord === false && v.fcClockShown === false, 'a card that is new (no PIN, no record) has no limits and no line under them', v.fcClockLine);
    ok(holder.state.fc.clock.short === '1fa7ca83' && holder.state.fc.clock.time === TIP.time, 'the real tip reads as 1fa7ca83 and its time', holder.state.fc.clock.short);
    // a card of 1.14 has no such line
    const old = newCard(H, undefined, { format: 4, software: 14, floorBits: CHEAP });
    await H.W.cardSetUp(old, { pin: '1234', recoverable: true });
    old.tap();
    H.nfc = old;
    holder.state.fc = null;
    holder.fcRead(true);
    await until('the 1.14 card to be read', () => holder.state.fc && holder.state.fc.hasRecord);
    v = vals(holder);
    ok(holder.state.fc.headers === false && v.fcClockShown === false && v.fcClockLine === '', 'a card of 1.14 has no CLOCK line: its clock is a signed time');
    // a limit set on a card with no block yet: the day begins with the first block (a phone that has none kept: H has one by now)
    const Z = await funded({ sharedMint: H.mint }, 6000);
    const zed = appOn(Z);
    zed.price = 100000;
    const pending = newCard(Z, undefined, { format: 4, floorBits: CHEAP });
    await Z.W.cardSetUp(pending, { pin: '1234', recoverable: true });
    pending.tap();
    await Z.W.cardSetLimit(pending, { sats: 5000 });
    pending.tap();
    Z.nfc = pending;
    zed.state.fc = null;
    zed.fcRead(true);
    await until('the pending card to be read', () => zed.state.fc && zed.state.fc.hasRecord);
    v = vals(zed);
    ok(v.fcDayShown && /LEFT TODAY/.test(v.fcDayLeft) && v.fcDayTurns === 'THE DAY BEGINS WITH THE CARD’S FIRST BLOCK',
       'a card with a limit and no block yet says its day begins with its first block, and does not call it a card that cannot sign', v.fcDayLeft + ' / ' + v.fcDayTurns);
    ok(pending.state.record.limit === 5000 && pending.state.windowStart === 0, 'the limit stands, with a day that has no start');
    // and spends on trust, and the first block begins the day
    const till = await funded({ sharedMint: H.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 0);
    pending.tap();
    await Z.W.cardAdd(pending, { sats: 800, owner: true });
    pending.tap();
    const paidOnTrust = await till.W.cardPay(pending, { sats: 200, pin: '1234' }).then((r) => r, (e) => e);
    ok(paidOnTrust && paidOnTrust.sats === 200, 'a card with a limit and no block spends its first day on trust: the till is paid', String(paidOnTrust && (paidOnTrust.sats || paidOnTrust.message)));
    ok(pending.state.spent >= 200 && pending.state.now === 0, 'and counted it against a day with no start');
    tipIs(till, mineHeader(Math.floor(real() / 1000) - 30, CHEAP));
    await till.W.headerRefresh({ force: true });
    pending.tap();
    await till.W.cardLook(pending);
    ok(pending.state.windowStart === pending.state.now && pending.state.now > 0 && pending.state.spent >= 200,
       'the first block a phone shows it begins the day at the block’s time, and what was spent on trust is in it', JSON.stringify([pending.state.windowStart, pending.state.spent]));

    // the log: the phone’s time with the block’s beside it, and no talk of a false clock
    await settle();
    const X = await funded({}, 6000);
    const Y = await funded({ sharedMint: X.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, 0);
    const owner = appOn(X);
    owner.price = 100000;
    const card = newCard(X, undefined, { format: 4, floorBits: CHEAP });
    await X.W.cardSetUp(card, { pin: '1234', recoverable: true });
    card.tap();
    await X.W.cardAdd(card, { sats: 2000, owner: true });
    const blockTime = Math.floor(real() / 1000) - 200;
    tipIs(Y, mineHeader(blockTime, CHEAP));
    await Y.W.headerRefresh({ force: true });
    card.tap();
    Y.window.Date.now = () => (blockTime + 150) * 1000;
    await Y.W.cardPay(card, { sats: 400, pin: '1234' });
    Y.window.Date.now = real;
    if (Y.W.cardOwed().length) { card.tap(); await Y.W.cardWrite(card, { pin: '1234' }); }
    X.nfc = card;
    card.tap();
    owner.goFlashcard();
    await until('the owner to read the card', () => !!owner.state.fc && !!owner.state.fc.log && !!owner.state.fc.receipts);
    const notes = vals(owner).fcNotes.map((x) => x.text).join(' | ');
    ok(!/false time|TAMPER/.test(notes), 'the card’s screen has no talk of a false time for a card of 1.15', notes);
    owner.fcLogCard();
    const lc = uiCard(owner);
    const paidLine = lc && lc.reason.split('\n').filter((l) => /signed|\$|sats|piece/.test(l) && /\(block /.test(l))[0];
    ok(lc && lc.title === 'THIS CARD’S OWN LOG' && !/false time|told this card the time twice|ahead of this phone/.test(lc.reason),
       'the log opens as the log, not as tamper, and says nothing of a clock moved twice', lc && lc.title);
    ok(!!paidLine && paidLine.indexOf(owner.fcWhen(blockTime + 150)) === 0 && paidLine.indexOf('(block ' + owner.fcWhen(blockTime) + ')') > 0,
       'each tap shows the time the phone told the card, with the block’s beside it', paidLine);
    ok(/This card keeps its time by Bitcoin blocks/.test(lc.reason), 'and says why the two differ');
    lc.press('COPY RECEIPTS');
    let copied = '';
    owner.copySecret = (t) => { copied = t; return true; };
    owner.fcCopyReceipts();
    const rows = copied.split('\n');
    ok(/^Foxy card receipts$/.test(rows[0]) && /^card 0[23][0-9a-f]{64}$/.test(rows[1]) && /time \(UTC, as the phone that tapped it told the card\), block time \(UTC, the card.s clock\)/.test(rows[2]),
       'COPY RECEIPTS names both times in its heading', rows[2]);
    const row = rows.filter((l) => /^#1, /.test(l))[0] || '';
    ok(new RegExp('^#1, ' + new Date((blockTime + 150) * 1000).toISOString().replace('.000Z', 'Z') + ', block ' + new Date(blockTime * 1000).toISOString().replace('.000Z', 'Z') + ', \\d+, [0-9a-f]{64}, 0[23][0-9a-f]{64}$').test(row),
       'and a payment has the time told first and the block’s beside it', row);
    // a card the owner's phone finds more than three hours ahead of the newest block it has kept: a line in the log (section 3), and nothing on the screens
    tipIs(X, mineHeader(blockTime, CHEAP));
    await X.W.headerRefresh({ force: true });
    card.state.now = blockTime + 5 * 3600;
    card.tap();
    owner.fcRead();
    await until('the card to be read ahead of the block', () => owner.state.fc && owner.state.fc.clock && owner.state.fc.clock.time === blockTime + 5 * 3600);
    const aheadNotes = vals(owner).fcNotes.map((x) => x.text).join(' | ');
    owner.fcLogCard();
    const ahead = uiCard(owner);
    ok(owner.state.fc.clockAhead === 0 && !/false time|TAMPER/.test(aheadNotes) && ahead && !/ahead of this phone|told this card the time twice/.test(ahead.reason),
       'a card of 1.15 five hours ahead of the newest block this phone has is no accusation on any screen', aheadNotes.slice(0, 80));
    if (ahead) ahead.press('CLOSE');
    await settle();
  }

  console.log('\n' + (failed ? failed + ' flashcard-clock check(s) failed' : 'all flashcard-clock checks pass'));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
