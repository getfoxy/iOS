  /* ---- the seed -------------------------------------------------------
   *
   * Proof secrets are derived from a seed and a counter rather than being
   * random. That means the mint's own records plus these twelve words are
   * enough to rebuild every proof this wallet has ever held — so the backup
   * is written once and never again, instead of after every payment.
   *
   * The seed is the phone's. The native side keeps it and its twelve words in
   * the keychain, keeps the counters, and hands this page only the secrets and
   * blinding factors of the counters an operation has just reserved, or a
   * restore has asked for. The page never has the words: they are shown and
   * typed on the phone's own screens. See SEED-HANDLING.md.
   *
   * It is the only path. The page could once also read the words
   * (seedRead), make new ones itself, write them (seedWrite) and keep the
   * counters in localStorage; that code is gone, and an install it left behind
   * is moved onto the phone once, at boot (migrateWordsOnce, importCountersOnce).
   *
   * With no native bridge — a desktop browser, or this page opened outside the
   * app — there is no phone to keep the seed or hand out secrets, and the wallet
   * refuses to connect (connectSeed) rather than build a wallet on random
   * secrets that no seed could rebuild.
   */
  /* The words a restore put in place of another seed this session, while they
   * are still the seed: 'phone:' and the secretEpoch they were adopted under.
   * adoptScan keeps everything already in a pile for as long as this matches
   * (MONEY.md §6). */
  var seedReplaced = null;
  var seedError = null;       // why the phone could not say it has a seed, while nothing is known

  /* Actions that carried or removed the words themselves, and stage 1's
   * seedSecrets. Native no longer has them, and nothing here asks: the page
   * refuses them itself, so a path that was missed fails here rather than
   * waiting on an answer that never comes. */
  var WORD_ACTIONS = { seedRead: 1, seedWrite: 1, seedDelete: 1, seedSecrets: 1 };
  function bridgeSeed(action, extra, ms) {
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (!mh) return Promise.reject(new Error('no bridge'));
    if (WORD_ACTIONS[action] === 1) {
      return Promise.reject(new Error('the words stay on the phone (' + action + ' is never asked)'));
    }
    return new Promise(function (ok, no) {
      var id = 's' + Date.now() + Math.random().toString(36).slice(2, 7);
      var settled = false;
      FoxyWallet._scans[id] = {
        ok: function (t) { if (!settled) { settled = true; ok(String(t)); } },
        no: function (e) { if (!settled) { settled = true; no(new Error(String((e && e.message) || e))); } }
      };
      var msg = { action: action, id: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      mh.postMessage(msg);
      setTimeout(function () {
        if (!settled) { settled = true; delete FoxyWallet._scans[id]; no(new Error('timed out')); }
      }, ms || 120000);   // Face ID or the passcode may be asking; a person takes longer than 8 seconds
    });
  }

  /* The seed a wallet is built with: the placeholder, once the phone has a
   * seed. With no bridge there is no phone, and this refuses: a wallet built
   * without the phone's secrets could only make random ones, and proofs made
   * with them cannot be rebuilt from the twelve words. A phone that could not
   * say it has a seed makes this refuse too, and the next connect asks again. */
  function connectSeed() {
    if (!bridged()) {
      return Promise.reject(new Error('Foxy keeps this wallet’s seed and its secrets on the phone, '
        + 'and this page is not running in the app, so it will not connect to a mint.'));
    }
    return nativeReady().then(function () { return placeholderSeed(); }, function (e) {
      seedError = (e && e.message) || String(e);
      throw new Error('Foxy could not use this wallet’s seed on this phone (' + seedError
        + '). Nothing has been created or changed — unlock the phone and try again.');
    });
  }

  /* ---- the seed on the phone: the contract ----------------------------
   *
   * Wallets are built with a placeholder seed, and the OutputDataCreator below
   * makes deterministic outputs from what the phone sent, never from a seed.
   * cashu-ts derives nothing anywhere else: every deterministic output goes
   * through its createOutputData or restore, and both ask the creator. NUT-13
   * itself (the HMAC-SHA256 of 01 keysets, BIP-32 for 00) is Swift's.
   *
   * The contract, through bridgeSeed. Answers are JSON; a refusal rejects
   * with native's message. An action native does not know gets no answer (the
   * request times out) or an error.
   *   seedStatus {}                              { exists }
   *   seedCreate {}                              { created: true } | "a seed already exists"
   *   seedMigrate { words }                      { migrated: true } | { migrated: false, same: true }
   *                                              | { migrated: false, different: true } | "bad request"
   *                                              | "no migration here": no seed is saved and the
   *                                              one-time window for writing words is closed. With
   *                                              a seed saved it always compares (same, different),
   *                                              window or not. An error never closes the window
   *   countersImport { counters: { id: n } }     { counters }, the higher per keyset; once per install,
   *                                              then "counters were already imported". No seed needed
   *   counterReserve { keysetId, count 0..1000 } { keysetId, start, secrets, blindingFactors }; a count
   *                                              of 0 is a peek, with no seed read
   *   counterReserveAt { keysetId, start, count 1..1000 }   the same | "range already issued"
   *                                              | "too far ahead": start more than 100 past next
   *   counterAdvance { keysetId, next }          { keysetId, next }, never lower | "too far ahead": past
   *                                              both next + 100 and the highest range end restoreSecrets
   *                                              served this app session for the saved seed
   *   counterSnapshot {}                         { counters }
   *   restoreSecrets { keysetId, start, count 1..1000, candidate? }   the same shape, no counter moves;
   *     this wallet's seed only up to next + 300 ("outside the restore window"),
   *     a candidate from 0 upwards, at most 300 past what it has been asked
   *     for, and 20,000 counters a keyset
   *   seedShow { verify }                        { verified }: the phone shows the words and the quiz
   *                                              | "a seed screen is already open" | "try again in a moment"
   *   seedEnter {}                               { candidate } | "cancelled": the words are typed there
   *                                              | "a seed screen is already open"
   *   seedAdopt { candidate }                    { adopted: true } | { adopted: false, same: true }
   *                                              | "Nothing was changed." | "unknown candidate"; adopted or
   *                                              same, each counter is raised to what the candidate was
   *                                              served, and the candidate is kept until forgotten
   *   seedCandidateForget { candidate }          { forgotten: true }
   *   seedWipe {}                                { wiped: true, created: true } | "Nothing was erased."
   * Secrets and blinding factors are 64 hex characters each, `count` of them,
   * for counters start to start + count - 1, on a 00 (16 characters) or 01
   * (66) keyset, the last counter below 2^31 on a 00 keyset. A 00 keyset's
   * counters are its derivation index's (id mod 2^31 - 1), whatever id names
   * it. At most 256 keysets ("too many keysets"). Native drops every candidate
   * when Foxy goes to the background or the page loads again. seedRead,
   * seedWrite, seedDelete and stage 1's seedSecrets no longer exist, and the
   * page refuses them itself (bridgeSeed).
   *
   * Every refusal fails closed: no outputs for that range, nothing sent. Native
   * drops its copy of the seed when the page goes to the background or away; the
   * cache here is emptied on seed changes and on coming back
   * (clearNativeSecrets).
   *
   * WHAT STILL TOUCHES THE WORDS in the page: one thing, once. An install from
   * before the keychain, or one whose keychain refused a new seed in an
   * earlier version, may still hold words under foxy.seed.v1; migrateWordsOnce reads
   * them and sends them to the phone (seedMigrate), and removes them once the
   * phone has them. Nothing else reads, makes or sends words. Boot and connect
   * ask seedStatus (and seedCreate on a fresh install), the counters are the
   * phone's, BACKUP and its quiz are the phone's screens (seedShow), RESTORE's
   * words are typed on the phone (seedEnter) and scanned and adopted by
   * candidate, the new-mint sweep scans this wallet's own seed with no words,
   * and a wipe is seedWipe.
   */
  var SECRETS_MAX = 2000;       // held at once: an operation takes a handful, a restore batch 100
  var SECRETS_CHUNK = 1000;     // the most native answers in one request
  // how far past its next counter the phone restores this wallet's seed: NUT-13's own gap,
  // ten empty batches of 100 (RestoreWindow.beyond); it was three, until a swap could burn sixty counters at a go
  var NATIVE_RESTORE_WINDOW = 1000;
  var RESTORE_GAP = 1000;            // and how many empty counters in a row end a restore walk
  var PERSON_MS = 30 * 60 * 1000;    // a screen the phone shows waits on a person, who may write twelve words down
  var NATIVE_KEYSET = /^(00[0-9a-f]{14}|01[0-9a-f]{64})$/;
  var WORDS_STAY = 'Foxy keeps the twelve words on the phone and never in this page.';
  var secretCache = new Map();  // 'ns|keysetId:counter' -> { ns, id, counter, s, r } in hex, oldest first
  var secretEpoch = 0;          // moves when this wallet's seed changes, so an answer for the old one is not kept
  var nativeSeedKnown = false;  // the phone has said a seed exists (seedStatus, seedCreate, an adopt or wipe)
  var phonePasscode = true;     // false once seedStatus says the phone has no passcode
  var nativeReadying = null;    // one boot at a time: boot and connect both ask
  var movedToPhone = false;     // this page load has run the one-time moves below
  var nativeCreators = new Map();

  /* 64 bytes that read as what they are. Every wallet is built with these only
   * because cashu-ts refuses deterministic outputs and restore without a seed;
   * nothing may derive from them (newWallet, the creator). */
  var PLACEHOLDER_TEXT = 'FOXY PLACEHOLDER, NOT A SEED. Every secret comes from the phone.';

  function placeholderSeed() {
    var out = new Uint8Array(64);
    for (var i = 0; i < 64; i++) out[i] = PLACEHOLDER_TEXT.charCodeAt(i);
    return out;
  }

  function isPlaceholderSeed(seed) {
    if (!seed || seed.length !== 64) return false;
    for (var i = 0; i < 64; i++) if (seed[i] !== PLACEHOLDER_TEXT.charCodeAt(i)) return false;
    return true;
  }

  /* A contract action, its answer parsed. Anything but a JSON object is a
   * refusal, never a guess at what the phone meant. */
  function nativeJson(action, extra, ms) {
    return bridgeSeed(action, extra || {}, ms).then(function (text) {
      var j = null;
      try { j = JSON.parse(String(text)); } catch (e) {}
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        throw new Error('the phone’s answer to ' + action + ' was not understood');
      }
      return j;
    });
  }

  /* A keyset id as the phone takes it, lowercase, or a throw: it derives only
   * for 00 and 01 keysets. */
  function nativeKeyset(keysetId) {
    var id = String(keysetId || '').toLowerCase();
    if (!NATIVE_KEYSET.test(id)) throw new Error('the phone derives secrets only for 00 and 01 keysets, not ' + keysetId);
    return id;
  }

  /* The phone has a seed, and has everything an older install left in this
   * page: asked once per page load, before anything reserves, restores or
   * connects.
   *
   * In this order, because each step needs the one before:
   *   1. words this page still holds go to the phone (migrateWordsOnce). This
   *      is first so that a phone with no seed takes those words, rather than
   *      making a new seed and leaving the wallet's proofs on words it lacks;
   *   2. seedStatus, and seedCreate when there is no seed. None is a fresh
   *      install; "a seed already exists" from seedCreate means one was made
   *      meanwhile, which is all this wanted. Words that did not reach the
   *      phone, with no seed there, stop it here: nothing is made, connect
   *      refuses, and the next launch sends them again;
   *   3. the page's old counters go to the phone (importCountersOnce), when
   *      they are the phone's seed's: there were no words here, or the phone
   *      took them or holds the same seed.
   * Any refusal rejects, so connect refuses rather than building a wallet the
   * seed cannot recover, and the next call asks again. Nothing here ever makes
   * words. */
  function nativeReady() {
    if (nativeSeedKnown && movedToPhone) return Promise.resolve();
    if (nativeReadying) return nativeReadying;
    var createdHere = false, migration = null;
    var run = migrateWordsOnce().then(function (m) {
      migration = m;
      var wordsLeft = m.why;
      if (nativeSeedKnown) return;
      /* Quietly: does this phone hold a seed at all? Reading it is Face ID,
       * and the launch has no need of the secret — only of the answer. A fresh
       * install was made to unlock before it had anything to protect. openSeedForVisit still reads, once per visit. */
      return nativeJson('seedStatus', { quiet: true }).then(function (j) {
        phonePasscode = j.passcode !== false;
        if (j.exists === true) return;
        if (j.exists !== false) throw new Error('the phone’s seed status was not understood');
        if (wordsLeft) {
          throw new Error('this page still holds the seed of an older Foxy, and the phone has not taken it yet: ' + wordsLeft);
        }
        return nativeJson('seedCreate').then(function (c) {
          if (c.created !== true) throw new Error('the phone did not say it made a seed');
          createdHere = true;
          console.log('[foxy] the phone made this wallet’s seed');
        }, function (e) {
          if (String(e && e.message) === 'a seed already exists') return;
          throw e;
        });
      });
    }).then(function () {
      nativeSeedKnown = true;
      seedError = null;
      return importCountersOnce(createdHere, migration);
    }).then(function () {
      movedToPhone = true;
    });
    nativeReadying = run;
    function done() { if (nativeReadying === run) nativeReadying = null; }
    run.then(done, done);
    return run;
  }

  /* ---- an older install, moved onto the phone once ----------------------
   *
   * What the words path left in this page's storage, and what happens to it.
   * Each move is idempotent and leaves a stamp, so a launch that dies halfway
   * runs the rest next time and a finished one is not asked again.
   *
   * (a) Words: foxy.seed.v1 (flash.seed.v1 before the keys were renamed). A
   *     seed from before the keychain, or, in an earlier version, the copy kept here
   *     whenever the keychain refused a new seed. Sent to the phone with
   *     seedMigrate:
   *       migrated, or the same seed already saved: this copy is removed;
   *       a different seed saved: this copy is left exactly as it is, for a
   *         person to decide about, the phone's seed is the wallet's, and
   *         they are not sent again;
   *       "bad request": they are not a valid seed; kept, and not sent again;
   *       "no migration here": no seed is saved, and the phone's one-time
   *         window for writing words is closed; kept, and the phone makes a
   *         seed. Sent again at the next launch, when the phone compares them
   *         with that seed (and answers different);
   *       any other error (a cancelled Face ID, a keychain that did not
   *         answer): kept, not stamped, and sent again at the next launch.
   *     The phone compares with a saved seed whether its window is open or not
   *     (native seed review, M4). Before, a cancelled Face ID left the window
   *     to be closed by seedStatus, the next launch heard "no migration here",
   *     and that was stamped as final: the words stayed in this page for good.
   * (b) Counters: foxy.counter.v1 goes to the phone once (countersImport, the
   *     higher per keyset), and only when they are the phone's seed's
   *     counters: this boot's seedMigrate answered migrated or same, or there
   *     were no words here at all (review M5). Different words, words that are
   *     not a seed, or a phone that took none: the counters were those words',
   *     and are stamped as skipped, with why, and never sent. An error: not
   *     sent and not stamped, and asked again at the next launch. The phone
   *     takes an import once per install; "counters were already imported" is
   *     stamped as done. The copy here is kept and never written again, so an
   *     older build installed over this one finds counters that are behind what
   *     the phone has since handed out, but never zero: the mint refuses the
   *     outputs it has signed and the used-output skip moves past them.
   * (c) Nothing else needs moving. foxy.counter.v1.replaced.<time> holds the
   *     counters of a seed a restore replaced; nothing ever read them back, and
   *     they stay for manual recovery. The keychain's status (seedLoaded,
   *     seedError) and seedReplaced were kept in memory only. */
  var LEGACY_SEED_KEY = 'foxy.seed.v1';
  var SEED_MOVED_KEY = 'foxy.seed.v1.toPhone';          // { at, answer }: what seedMigrate said
  var COUNTER_KEY = 'foxy.counter.v1';
  var COUNTERS_SENT_KEY = 'foxy.counter.v1.sentToPhone'; // { at, sent }: the foxy.counter.v1 text the phone has

  function legacySeed() {
    try { return localStorage.getItem(LEGACY_SEED_KEY) || null; } catch (e) { return null; }
  }

  function readStamp(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function writeStamp(key, value) {
    try { localStorage.setItem(key, JSON.stringify(Object.assign({ at: Math.floor(Date.now() / 1000) }, value))); } catch (e) {}
  }

  /* (a). Resolves { answer, why }. `answer` is what this boot knows of the
   * words here: 'none' (there are none), 'migrated', 'same', 'different',
   * 'invalid', 'closed' ("no migration here"), or 'error', when `why` says why
   * they did not reach the phone. This is the one place the page still reads
   * words, and it only passes them on. */
  function migrateWordsOnce() {
    var words = legacySeed();
    if (!words) return Promise.resolve({ answer: 'none', why: null });
    var had = readStamp(SEED_MOVED_KEY);
    /* Final answers, already said: a different seed saved, or words that are
     * not a seed. "closed" is not final: it was said with no seed saved, and a
     * stamp of it from before the phone compared with its window closed may
     * stand for words the phone holds (M4). */
    if (had && (had.answer === 'different' || had.answer === 'invalid')) return Promise.resolve({ answer: had.answer, why: null });
    return nativeJson('seedMigrate', { words: words }).then(function (j) {
      if (j.migrated === true || (j.migrated === false && j.same === true)) {
        var answer = j.migrated === true ? 'migrated' : 'same';
        writeStamp(SEED_MOVED_KEY, { answer: answer });
        try { localStorage.removeItem(LEGACY_SEED_KEY); } catch (e) {}
        console.log('[foxy] the seed this page held is on the phone now (' + (j.migrated === true ? 'written' : 'already there') + '); its copy here is removed');
        return { answer: answer, why: null };
      }
      if (j.migrated === false && j.different === true) {
        writeStamp(SEED_MOVED_KEY, { answer: 'different' });
        console.warn('[foxy] this page holds the words of an older Foxy that are not the seed on the phone. '
          + 'They are left in ' + LEGACY_SEED_KEY + ' for a person to look at; the phone’s seed is this wallet’s.');
        return { answer: 'different', why: null };
      }
      throw new Error('the phone’s answer to seedMigrate was not understood');
    }).then(null, function (e) {
      var why = (e && e.message) || String(e);
      if (why === 'bad request') {
        writeStamp(SEED_MOVED_KEY, { answer: 'invalid' });
        console.warn('[foxy] the words this page holds are not a valid seed; they are left in ' + LEGACY_SEED_KEY + ' and not sent again');
        return { answer: 'invalid', why: null };
      }
      /* No seed is saved, and the phone takes words from the page only once, on
       * an install that had page storage before this launch, and never after it
       * has answered a seedMigrate or made a seed: otherwise a script in a fresh
       * page could plant words it knows before the wallet makes its own. The
       * words stay, the phone makes this wallet's seed now, and the next launch
       * sends them again, to be compared with it. */
      if (why === 'no migration here') {
        writeStamp(SEED_MOVED_KEY, { answer: 'closed' });
        console.warn('[foxy] the phone has no seed and no longer takes words from this page; the words of an older Foxy are left in '
          + LEGACY_SEED_KEY + ', and compared with the phone’s seed at the next launch');
        return { answer: 'closed', why: null };
      }
      console.warn('[foxy] the seed this page holds did not reach the phone; it is kept, and sent again at the next launch:', why);
      return { answer: 'error', why: why };
    });
  }

  /* The counters this page kept before the phone had them: { keysetId: next },
   * read only, for (b). */
  function counters() {
    try { return JSON.parse(localStorage.getItem(COUNTER_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  /* (b). The stamp records the text that was sent, or skipped, so a copy that
   * changed since (written by an older build installed in between) is asked
   * about again; a stage 2 stamp, which was only a time, is asked again once.
   * The phone takes the higher of its own and these, per keyset, and only once
   * per install. Keysets the phone cannot derive for (not 00 or 01) are left
   * out: no output is ever made on them.
   *
   * Whose counters these are decides whether they go (review M5). The words
   * this page held are the seed the page ran on, so its counters are theirs:
   * they go only when this boot's seedMigrate answered migrated or same, or
   * when there were no words here (the seed was the keychain's all along). A
   * seed the phone made during this boot is a new seed, whose outputs start at
   * 0, where other wallets look. Different words, invalid words, or a phone
   * that took none ("no migration here"): stamped as skipped, and never put on
   * the phone's seed, where a counter of 2,400 would put new ecash past a gap
   * no restore of the phone's words crosses. An error: nothing sent and
   * nothing stamped, and the next launch asks again. */
  var COUNTERS_SKIPPED = {
    different: 'the words this page held are not the phone’s seed, and these counters were theirs',
    invalid: 'the words this page held are not a valid seed, so these counters are no seed’s the phone has',
    closed: 'the phone took no words from this page and had no seed, so these counters are no seed’s it has',
  };

  function importCountersOnce(createdHere, migration) {
    var raw = null;
    try { raw = localStorage.getItem(COUNTER_KEY); } catch (e) {}
    if (raw === null) return Promise.resolve();
    var had = readStamp(COUNTERS_SENT_KEY);
    if (had && typeof had === 'object' && had.sent === raw) return Promise.resolve();
    if (createdHere) {
      writeStamp(COUNTERS_SENT_KEY, { sent: raw, skipped: 'the phone made a new seed' });
      console.warn('[foxy] counters found with no seed on the phone were not sent: they belonged to a seed that is gone');
      return Promise.resolve();
    }
    var answer = (migration && migration.answer) || 'none';
    if (answer === 'error') {
      console.warn('[foxy] the counters this page kept are not sent yet: they belong to the words it holds, which did not reach the phone; asked again at the next launch');
      return Promise.resolve();
    }
    if (answer !== 'none' && answer !== 'migrated' && answer !== 'same') {
      var why = COUNTERS_SKIPPED[answer] || ('the phone answered ' + answer + ' about the words this page held');
      writeStamp(COUNTERS_SENT_KEY, { sent: raw, skipped: why });
      console.warn('[foxy] the counters this page kept were not sent to the phone: ' + why);
      return Promise.resolve();
    }
    var c = counters(), out = {}, any = false;
    Object.keys(c).forEach(function (key) {
      var id = String(key).toLowerCase(), n = Number(c[key]);
      if (!NATIVE_KEYSET.test(id) || !(Number.isInteger(n) && n > 0)) return;
      out[id] = Math.max(out[id] || 0, n);
      any = true;
    });
    var ask = any ? nativeJson('countersImport', { counters: out }) : Promise.resolve(null);
    return ask.then(function (j) {
      if (j && (!j.counters || typeof j.counters !== 'object')) throw new Error('the phone’s answer to countersImport was not understood');
      writeStamp(COUNTERS_SENT_KEY, { sent: raw });
      if (any) console.log('[foxy] counters sent to the phone for', Object.keys(out).length, 'keysets');
    }, function (e) {
      // the phone's one import on this install has been made: nothing is left to send
      if (String(e && e.message) !== 'counters were already imported') throw e;
      writeStamp(COUNTERS_SENT_KEY, { sent: raw, already: true });
      console.log('[foxy] the phone had already taken this install’s counters; nothing sent');
    });
  }

  /* The phone's answer for a range, checked against the request before any of
   * it is used. `start` is null for a reservation, whose start the phone
   * chooses. Returns the entries for the cache. */
  function readSecrets(j, id, start, count, ns) {
    var hex = /^[0-9a-f]{64}$/i;
    function good(list) {
      return Array.isArray(list) && list.length === count
        && list.every(function (x) { return typeof x === 'string' && hex.test(x); });
    }
    // native echoes the keyset id as it was sent, so its case is not compared
    if (!j || typeof j.keysetId !== 'string' || j.keysetId.toLowerCase() !== id ||
        !(Number.isInteger(j.start) && j.start >= 0) || (start != null && j.start !== start) ||
        !good(j.secrets) || !good(j.blindingFactors)) {
      throw new Error('the phone’s secrets were not for what was asked');
    }
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push({ ns: ns, id: id, counter: j.start + i, s: j.secrets[i].toLowerCase(), r: j.blindingFactors[i].toLowerCase() });
    }
    return { start: j.start, list: out };
  }

  /* The secrets for counters start to start + count - 1 for a restore, in
   * requests of at most 1000, into the cache: this wallet's seed with no
   * candidate, or the words typed on the phone under `candidate`. A chunk the
   * cache already holds is not asked again. Rejects when native refuses, when
   * its answer is not for what was asked, or when this wallet's seed changed
   * meanwhile. No counter moves. */
  function fetchSecrets(keysetId, start, count, candidate) {
    var id;
    try { id = nativeKeyset(keysetId); } catch (e) { return Promise.reject(e); }
    var from = Number(start), n = Number(count);
    // the last counter, as native checks it: below 2^31 on a 00 keyset, at most 2^53 - 1 on an 01
    var last = id.slice(0, 2) === '00' ? 2147483647 : Number.MAX_SAFE_INTEGER;
    if (!(Number.isInteger(from) && from >= 0 && Number.isInteger(n) && n >= 0 && (n === 0 || from + n - 1 <= last))) {
      return Promise.reject(new Error('the phone derives no secrets for counters ' + start + ' + ' + count + ' on keyset ' + id));
    }
    var ns = candidate ? 'c:' + candidate : '';
    var epoch = secretEpoch;
    var chain = Promise.resolve();
    for (var at = from; at < from + n; at += SECRETS_CHUNK) {
      (function (s, k) {
        chain = chain.then(function () {
          if (haveSecrets(ns, id, s, k)) return;
          var ask = { keysetId: id, start: s, count: k };
          if (candidate) ask.candidate = candidate;
          return nativeJson('restoreSecrets', ask).then(function (j) {
            var got = readSecrets(j, id, s, k, ns);
            // a candidate's secrets do not depend on this wallet's seed
            if (!candidate && epoch !== secretEpoch) throw new Error('the seed changed while its secrets were on their way');
            if (candidate && !candidateKeysets[candidate]) candidateKeysets[candidate] = id;
            keepSecrets(got.list, ns, id, from, n);
          });
        });
      })(at, Math.min(SECRETS_CHUNK, from + n - at));
    }
    return chain;
  }

  function haveSecrets(ns, id, start, count) {
    for (var i = 0; i < count; i++) if (!secretCache.has(ns + '|' + id + ':' + (start + i))) return false;
    return true;
  }

  /* Into the cache, newest last; past SECRETS_MAX the oldest go, except those
   * of the range being fetched. Entries leave when an output is made from
   * them, so what stays is only what a failed operation reserved and never
   * used, until the next clear. */
  function keepSecrets(list, ns, id, from, n) {
    list.forEach(function (e) {
      var key = e.ns + '|' + e.id + ':' + e.counter;
      secretCache.delete(key);
      secretCache.set(key, e);
    });
    if (secretCache.size <= SECRETS_MAX) return;
    var drop = [];
    secretCache.forEach(function (e, key) {
      if (secretCache.size - drop.length <= SECRETS_MAX) return;
      if (e.ns === ns && e.id === id && e.counter >= from && e.counter < from + n) return;
      drop.push(key);
    });
    drop.forEach(function (key) { secretCache.delete(key); });
  }

  /* Taken for outputs, and gone from the cache. All or none: a counter that is
   * missing throws before any entry is used. */
  function takeSecrets(ns, id, counter, count) {
    var low = String(id).toLowerCase();
    var out = [];
    for (var i = 0; i < count; i++) {
      var e = secretCache.get(ns + '|' + low + ':' + (counter + i));
      if (!e) {
        throw new Error('Foxy has no secret from the phone for counter ' + (counter + i) + ' on keyset ' + id
          + ', and will not make one from the placeholder seed. Nothing was sent.');
      }
      out.push(e);
    }
    out.forEach(function (x) { secretCache.delete(x.ns + '|' + x.id + ':' + x.counter); });
    return out;
  }

  /* Emptied when the app comes back from the background and whenever the seed
   * changes or goes; `seedChanged` also drops any answer still on its way,
   * and `seedGone` forgets that native had one. */
  /* And the primed lock keys go with a seed change, which is not optional.
   *
   * They are public keys derived from the seed that has just been replaced. The
   * phone sets `foxy-p2pk.json` aside at the same moment, so its index restarts
   * at 0 under the new seed and no index will ever derive those keys again — but
   * the pool is in this page, and nothing here was clearing it. The next eight
   * payment requests would have gone out locked to keys the wallet could not
   * open, and the payer's wallet swaps into proofs locked to the key *before* it
   * delivers anything, so each of those payments is destroyed by being made.
   * Found in review of the derived keys.
   *
   * `foxy.req.lockkeys` is deliberately NOT cleared beside it. Rows from before
   * the derived keys hold a random private key and real money, and they open
   * what they open whatever the seed is; a derived row that no longer matches is
   * caught by `lockPrivkey`'s comparison of the public key the phone answers
   * with against the one the row kept. A pool entry has no such check in front
   * of it — it goes straight into a request — which is why it is the one that
   * has to go. */
  function clearNativeSecrets(seedChanged, seedGone) {
    secretCache.clear();
    if (seedChanged) {
      secretEpoch++;
      dropLockPool();
    }
    if (seedGone) nativeSeedKnown = false;
  }

  /* cashu-ts's createSingleDeterministicDataFromBytes (model/OutputData.ts),
   * from what cashu-ts exports: the secret is the 64 hex characters as bytes,
   * the blinding factor the 32 bytes as a number. */
  function outputFromSecret(amount, id, e) {
    var C = window.CashuTS;
    var secret = new Uint8Array(64);
    for (var i = 0; i < 64; i++) secret[i] = e.s.charCodeAt(i);
    var b = C.blindMessage(secret, BigInt('0x' + e.r));
    return new C.OutputData({ amount: C.Amount.from(amount), B_: b.B_.toHex(true), id: id }, b.r, secret);
  }

  /* The OutputDataCreator for wallets built on the placeholder: one for this
   * wallet's seed (ns ''), and one for each candidate a restore scans.
   *
   * Deterministic outputs come from the cache and nowhere else: the seed
   * cashu-ts passes is ignored, a missing counter throws, and there is no code
   * here that derives. It refuses any seed but the placeholder, so it is never
   * mixed into a wallet whose seed is real. Random and P2PK outputs are
   * cashu-ts's own, as its default creator makes them. A candidate's creator
   * takes only that candidate's secrets, so a restore never makes outputs from
   * this wallet's reserved ones, or the other way round. */
  /* Outputs no seed can rebuild, handed to whoever is watching for them.
   *
   * A P2PK output's secret is the spending condition, not a NUT-13 secret, so
   * cashu-ts reserves no counter for it (`countersNeeded` answers 0 for
   * anything that is not deterministic) and a restore walk can never find it.
   * That costs nothing while the mint answers. When a locked send's answer is
   * lost it costs everything: the inputs are spent, the outputs existed only
   * in memory, and the payment is destroyed with no copy anywhere — a seed
   * restore does not bring it back. Reproduced in testing: 21 sats gone, the
   * change stranded behind a record that could never be matched, and
   * `settling()` true for ever after.
   *
   * So a locked send watches what it is about to ask for and writes it down
   * before the request leaves (`swapGuard`). Four fields per output are enough
   * to finish afterwards: NUT-09's restore takes blinded messages, not only
   * counter ranges, so the mint can be asked for the signature it made and the
   * proof rebuilt from it. */
  var lockedWatcher = null;

  function watchLockedOutputs(fn) {
    lockedWatcher = typeof fn === 'function' ? fn : null;
    return function () { lockedWatcher = null; };
  }

  function sawLockedOutputs(made) {
    if (lockedWatcher) {
      try { lockedWatcher([].concat(made)); }
      catch (e) { console.warn('[foxy] a locked output could not be written down:', e && e.message); }
    }
    return made;
  }

  /* One output, as little of it as a restore needs. */
  function lockedRow(o) {
    try {
      var b = o && o.blindedMessage;
      if (!b || !o.secret || !o.secret.length || typeof o.blindingFactor !== 'bigint') return null;
      var amount = Number(String(b.amount));
      if (!(amount > 0) || !isFinite(amount)) return null;
      return { amount: amount, id: String(b.id || ''), B_: String(b.B_ || ''),
               secret: hexOf(o.secret), r: o.blindingFactor.toString(16) };
    } catch (e) { return null; }
  }

  /* And back. The secret has to be made with the page's own Uint8Array: the
   * constructor checks it with `instanceof`, and bytes from another realm are
   * refused — which is what a test running the bundle in jsdom will hit. */
  function lockedOutput(row) {
    var C = window.CashuTS;
    var hex = String((row && row.secret) || '');
    var bytes = new window.Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return new C.OutputData({ amount: C.Amount.from(row.amount), B_: row.B_, id: row.id },
                            BigInt('0x' + String(row.r)), bytes);
  }

  function nativeOutputCreator(ns) {
    var have = nativeCreators.get(ns);
    if (have) return have;
    var C = window.CashuTS;
    function placeholderOnly(seed) {
      if (!isPlaceholderSeed(seed)) {
        throw new Error('The phone’s secrets are only for wallets built on the placeholder seed.');
      }
    }
    var made = {
      createDeterministicData: function (amount, seed, counter, keyset, customSplit) {
        placeholderOnly(seed);
        var amounts = C.splitAmount(amount, keyset.keys, customSplit);
        var got = takeSecrets(ns, keyset.id, counter, amounts.length);
        return amounts.map(function (a, i) { return outputFromSecret(a, keyset.id, got[i]); });
      },
      createSingleDeterministicData: function (amount, seed, counter, keysetId) {
        placeholderOnly(seed);
        return outputFromSecret(amount, keysetId, takeSecrets(ns, keysetId, counter, 1)[0]);
      },
      createRandomData: function (amount, keyset, customSplit) {
        return C.OutputData.createRandomData(amount, keyset, customSplit);
      },
      createSingleRandomData: function (amount, keysetId) {
        return C.OutputData.createSingleRandomData(amount, keysetId);
      },
      createP2PKData: function (p2pk, amount, keyset, customSplit) {
        return sawLockedOutputs(C.OutputData.createP2PKData(p2pk, amount, keyset, customSplit));
      },
      createSingleP2PKData: function (p2pk, amount, keysetId) {
        return sawLockedOutputs(C.OutputData.createSingleP2PKData(p2pk, amount, keysetId));
      },
    };
    nativeCreators.set(ns, made);
    return made;
  }

  /* The same six, for a wallet whose secrets are not the phone's — a browser,
   * or a connect before the seed is ready. Only the P2PK pair does anything
   * of its own, and only so that a locked send is written down there too. */
  var plainCreator = null;

  function plainOutputCreator() {
    if (plainCreator) return plainCreator;
    var C = window.CashuTS;
    plainCreator = {
      createDeterministicData: function (amount, seed, counter, keyset, customSplit) {
        return C.OutputData.createDeterministicData(amount, seed, counter, keyset, customSplit);
      },
      createSingleDeterministicData: function (amount, seed, counter, keysetId) {
        return C.OutputData.createSingleDeterministicData(amount, seed, counter, keysetId);
      },
      createRandomData: function (amount, keyset, customSplit) {
        return C.OutputData.createRandomData(amount, keyset, customSplit);
      },
      createSingleRandomData: function (amount, keysetId) {
        return C.OutputData.createSingleRandomData(amount, keysetId);
      },
      createP2PKData: function (p2pk, amount, keyset, customSplit) {
        return sawLockedOutputs(C.OutputData.createP2PKData(p2pk, amount, keyset, customSplit));
      },
      createSingleP2PKData: function (p2pk, amount, keysetId) {
        return sawLockedOutputs(C.OutputData.createSingleP2PKData(p2pk, amount, keysetId));
      },
    };
    return plainCreator;
  }

  /* A refusal from the phone while reserving, as the error an operation
   * stops on. `unsent`: nothing went to the mint, as with a counter that could
   * not be stored (mustSave). */
  function unsentFromPhone(e) {
    var err = /** @type {any} */ (new Error('Foxy could not get the secrets for this from the phone ('
      + ((e && e.message) || e) + '), so nothing was sent to the mint.'));
    err.unsent = true;
    return err;
  }

  /* A reservation on the phone: counterReserve (start null, the phone picks
   * next) or counterReserveAt. The phone reserves the range and sends its
   * secrets in the same answer, so the secrets are in the cache before this
   * resolves and cashu-ts makes the outputs straight after. One round trip.
   *
   * A refusal rejects it, so cashu-ts makes no outputs and sends nothing. The
   * counters the phone reserved are kept, never given back: giving them back
   * means writing a counter lower, which nothing here does. Nothing was signed
   * on them, and a restore walks 1000 counters past the last one used. */
  function nativeReserve(keysetId, start, count) {
    var id;
    try { id = nativeKeyset(keysetId); } catch (e) { return Promise.reject(unsentFromPhone(e)); }
    var at = start != null;
    if (!(Number.isInteger(count) && count >= 0 && count <= SECRETS_CHUNK) ||
        (at && !(Number.isInteger(start) && start >= 0))) {
      return Promise.reject(unsentFromPhone(new Error('the phone reserves 0 to 1000 counters at a time, not ' + count)));
    }
    return nativeReady().then(function () {
      var epoch = secretEpoch;
      if (at && count === 0) {
        /* Nothing to derive, only a counter to move to `start`: a peek says
         * whether that is backwards, which is refused as it always was. */
        return nativeJson('counterReserve', { keysetId: id, count: 0 }).then(function (j) {
          var next = readSecrets(j, id, null, 0, '').start;
          if (start < next) throw alreadyIssued(keysetId, start, next);
          return nativeJson('counterAdvance', { keysetId: id, next: start }).then(function () {
            return { start: start, count: 0 };
          });
        });
      }
      var ask = at ? { keysetId: id, start: start, count: count } : { keysetId: id, count: count };
      return nativeJson(at ? 'counterReserveAt' : 'counterReserve', ask).then(function (j) {
        var got = readSecrets(j, id, at ? start : null, count, '');
        if (epoch !== secretEpoch) throw new Error('the seed changed while its secrets were on their way');
        keepSecrets(got.list, '', id, got.start, count);
        return { start: got.start, count: count };
      }, function (e) {
        if (at && String(e && e.message) === 'range already issued') throw alreadyIssued(keysetId, start, null);
        throw e;
      });
    }).then(null, function (e) {
      if (e && e.alreadyIssued) throw e;
      throw unsentFromPhone(e);
    });
  }

  function alreadyIssued(keysetId, start, next) {
    var e = /** @type {any} */ (new Error('Counter ' + start + ' for keyset ' + keysetId + ' was already issued ('
      + (next == null ? 'the phone says so' : 'next is ' + next) + ')'));
    e.alreadyIssued = true;
    return e;
  }

  /* The phone's counters, { keysetId: next }. */
  function nativeSnapshot() {
    return nativeReady().then(function () { return nativeJson('counterSnapshot'); }).then(function (j) {
      if (!j.counters || typeof j.counters !== 'object') throw new Error('the phone’s counters were not understood');
      var out = {};
      Object.keys(j.counters).forEach(function (k) {
        var n = Number(j.counters[k]);
        if (Number.isInteger(n) && n >= 0) out[String(k).toLowerCase()] = n;
      });
      return out;
    });
  }

  /* Move a counter on the phone to at least `next`; resolves the phone's
   * next, which is never lower than it was. */
  function nativeAdvance(keysetId, next) {
    var id;
    try { id = nativeKeyset(keysetId); } catch (e) { return Promise.reject(e); }
    var to = Number(next);
    if (!(Number.isInteger(to) && to >= 0)) return Promise.reject(new Error('a counter moves to a whole number, not ' + next));
    return nativeReady().then(function () {
      return nativeJson('counterAdvance', { keysetId: id, next: to });
    }).then(function (j) {
      if (!(Number.isInteger(j.next) && j.next >= to)) throw new Error('the phone’s counter was not understood');
      return j.next;
    });
  }

  /* Every counter in `c` moved on the phone to at least its value, one after
   * another. A keyset the phone does not derive for has no counter there and is
   * left out. Rejects on the first refusal: adoptScan writes no pile then.
   *
   * Each value is one past a counter a mint signed, which a scan found. The
   * phone moves a counter at most 100 past its next one, or as far as a
   * restore of this wallet's seed has been served this session ("too far
   * ahead" otherwise). A scan of this wallet's own seed was served that far,
   * and an adopted candidate's counters are raised as it is adopted. A mint
   * that answers after words were adopted, still walked with their candidate,
   * can be further on: its counter is then moved in steps, each to the end of a
   * restore range of this wallet's seed (which the candidate now is) that the
   * phone serves inside its window first. The keyset's next counter is peeked
   * first, so the page never asks for a move the phone refuses. */
  var NATIVE_ADVANCE_MAX = 100;      // how far past its next counter the phone moves one without a served restore range

  function nativeAdvanceAll(c) {
    return Object.keys(c || {}).sort().reduce(function (chain, key) {
      var n = Number(c[key]);
      if (!NATIVE_KEYSET.test(String(key).toLowerCase()) || !(Number.isInteger(n) && n > 0)) return chain;
      return chain.then(function () { return nativeAdvanceServed(key, n); });
    }, Promise.resolve());
  }

  function nativeAdvanceServed(keysetId, to) {
    var id;
    try { id = nativeKeyset(keysetId); } catch (e) { return Promise.reject(e); }
    function step(k) {
      // a peek: the keyset's next counter, by the id asked for (a 00 keyset's counters are its index's)
      return nativeJson('counterReserve', { keysetId: id, count: 0 }).then(function (j) {
        var next = readSecrets(j, id, null, 0, '').start;
        if (to <= next) return next;
        if (to <= next + NATIVE_ADVANCE_MAX) return nativeAdvance(id, to);
        if (k >= 100) throw new Error('the counter for keyset ' + id + ' is too far behind ' + to + ' to move there');
        var end = Math.min(to, next + NATIVE_RESTORE_WINDOW);
        return fetchSecrets(id, end - 1, 1, null)
          .then(function () { return nativeAdvance(id, end); })
          .then(function () { return step(k + 1); });
      });
    }
    return nativeReady().then(function () { return step(0); });
  }

  /* Words typed on the phone become this wallet's seed: seedAdopt, where the
   * phone shows its Replace alert and sets the old seed's counters aside.
   * Resolves true when the seed was replaced, false when the candidate is this
   * wallet's own seed already ("same"). A No, or an unknown candidate, rejects
   * as a refused keychain write always has, and nothing here has changed. */
  function adoptCandidate(candidate) {
    /* Boot's one-time moves first (nativeReady): counters this page kept are
     * the seed's before the adoption, and sent afterwards they would be put on
     * the adopted seed. A phone that cannot finish them adopts nothing. */
    return nativeReady().then(function () {
      return refuseWhileSettling(candidate);
    }).then(function () {
      return nativeJson('seedAdopt', { candidate: candidate }, PERSON_MS).then(function (j) {
        if (j.adopted === true) {
          clearNativeSecrets(true, false);   // anything held was for the seed before
          nativeSeedKnown = true;
          adoptedCandidates[candidate] = secretEpoch;
          console.log('[foxy] the phone adopted the restored seed');
          return true;
        }
        if (j.adopted === false && j.same === true) {
          adoptedCandidates[candidate] = secretEpoch;
          return false;
        }
        throw new Error('the phone’s answer to seedAdopt was not understood');
      }, function (e) {
        console.error('[foxy] the phone kept the old seed:', e.message);
        throw new Error('Those words were not saved, so nothing was restored. (' + e.message + ')');
      });
    });
  }

  /* Candidates this page has seen adopted, or found to be this wallet's seed
   * already: candidate -> the secretEpoch then. While that epoch stands, the
   * candidate's words are this wallet's seed, so its secrets are this wallet's
   * own (restoreFrom). */
  var adoptedCandidates = {};
  /* A keyset each candidate was served on, for refuseWhileSettling to compare. */
  var candidateKeysets = {};

  function candidateIsSeed(candidate) {
    return nativeSeedKnown && Object.prototype.hasOwnProperty.call(adoptedCandidates, candidate)
      && adoptedCandidates[candidate] === secretEpoch;
  }

  /* New words are not adopted while a melt is held (foxy.cashu.melting) or a
   * swap's answer is still being recovered (foxy.cashu.swaps). Neither record
   * names its seed: after a Replace, a held melt's change and a lost swap's
   * recorded ranges would be restored under the new seed, and found nowhere
   * (review L10). Words that are this wallet's seed already ("same") change
   * nothing and are let through: the phone's secret for counter 0 of a keyset
   * the candidate was scanned on is compared with this wallet's own, which the
   * phone serves with no alert. A candidate never scanned cannot be compared,
   * and waits like new words. */
  var SETTLING = 'A payment or swap is still settling. Wait for it to finish before replacing the seed.';

  function settling() {
    var melting = load(K.melting, []);
    /* A locked send's record does not count as settling.
     *
     * `restoreSwap` can never match one — the expectation is the whole swap and
     * only the change is restorable by counter — so a record kept for a later
     * connect stays for ever, and "a payment or swap is still settling" then
     * refuses a restore of different words until the app is reinstalled. It is
     * stranded, not in flight, and it must not hold the wallet hostage. */
    var swaps = loadSwaps().filter(function (r) { return !(r && r.locked && r.locked.length); });
    /* Ecash that has arrived and is not swapped in yet counts too
     * (foxy.req.unclaimed, 07-request-delivery.js).
     *
     * It is locked to a key this wallet's seed derives, and replacing the seed
     * takes that seed away — with it the only key that opens those proofs.
     * `foxy-p2pk.json` goes aside with the counters on a Replace, so the new
     * seed derives a different key at every index and the waiting payment is
     * money nobody can move. It is in the balance and the person can see it;
     * the wait is until the swap finishes, which is minutes at the outside.
     *
     * This is the same class of mistake the melt and swap records above are
     * here for, and it was missed when the delayed claim was built: the money
     * had left the payer, was counted as ours, and nothing stood between it and
     * a restore of different words.
     *
     * An entry this seed cannot open at all does not count (`stranded`), for
     * the reason the locked-send carve-out above gives: it is not in flight, it
     * will never finish, and it must not hold the wallet hostage. */
    var waiting = unclaimedWaiting();
    return (Array.isArray(melting) && melting.length > 0) || swaps.length > 0 || waiting > 0;
  }

  function refuseWhileSettling(candidate) {
    if (!settling()) return Promise.resolve();
    var refused = new Error(SETTLING);
    var id = candidateKeysets[candidate];
    if (!id) return Promise.reject(refused);
    return Promise.all([
      nativeJson('restoreSecrets', { keysetId: id, start: 0, count: 1, candidate: candidate }),
      nativeJson('restoreSecrets', { keysetId: id, start: 0, count: 1 }),
    ]).then(function (both) {
      var typed = readSecrets(both[0], id, 0, 1, '').list[0];
      var own = readSecrets(both[1], id, 0, 1, '').list[0];
      if (typed.s !== own.s || typed.r !== own.r) throw refused;
    }, function () { throw refused; });
  }

  /* w.restore, with the secrets for the range brought from the phone first:
   * this wallet's seed, or the candidate w scans. A wallet not built on the
   * placeholder has no secrets to restore with, and is refused rather than
   * left to cashu-ts's own derivation. */
  function restoreFrom(w, start, count, keysetId) {
    if (!(w && w.foxyNativeSecrets)) return Promise.reject(new Error('A restore needs a wallet whose secrets come from the phone.'));
    var candidate = w.foxyCandidate || null;
    return fetchSecrets(keysetId, start, count, candidate).then(null, function (e) {
      /* The phone keeps an adopted candidate until the page forgets it, once
       * its scans have ended, but drops every candidate when Foxy goes to the
       * background or the page loads again. A batch refused then, of words that
       * are this wallet's seed now, is restored with this wallet's own seed,
       * inside the phone's window, rather than marking the row partial and
       * leaving a restore that looks finished when it is not (review M6). */
      if (!candidate || String(e && e.message) !== 'unknown candidate' || !candidateIsSeed(candidate)) throw e;
      console.warn('[foxy] the phone no longer holds the adopted words; restoring counters', start, '+', count,
        'with this wallet’s own seed, which they are');
      var epoch = secretEpoch;
      return fetchSecrets(keysetId, start, count, null).then(function () {
        if (epoch !== secretEpoch || !candidateIsSeed(candidate)) throw e;
        shareOwnSecrets(keysetId, start, count, 'c:' + candidate);
      });
    }).then(function () {
      return w.restore(start, count, { keysetId: keysetId });
    });
  }

  /* This wallet's secrets for a range, copied for a candidate's creator: only
   * for a candidate whose words are this wallet's seed (candidateIsSeed). The
   * originals stay, in case an operation reserved any of them. */
  function shareOwnSecrets(keysetId, start, count, ns) {
    var id = String(keysetId).toLowerCase(), list = [];
    for (var i = 0; i < count; i++) {
      var e = secretCache.get('|' + id + ':' + (start + i));
      if (!e) throw new Error('Foxy has no secret from the phone for counter ' + (start + i) + ' on keyset ' + id);
      list.push({ ns: ns, id: id, counter: e.counter, s: e.s, r: e.r });
    }
    keepSecrets(list, ns, id, start, count);
  }

  /* Scans still asking with each candidate: candidate -> count, and what waits
   * for them to end (forgetSeedCandidate). */
  var candidateScans = {}, candidateWaiters = {};

  function holdCandidate(candidate) {
    candidateScans[candidate] = (candidateScans[candidate] || 0) + 1;
    var released = false;
    return function release() {
      if (released) return;
      released = true;
      if (--candidateScans[candidate] > 0) return;
      delete candidateScans[candidate];
      var waiting = candidateWaiters[candidate] || [];
      delete candidateWaiters[candidate];
      waiting.forEach(function (ok) { ok(); });
    };
  }

  /* Resolves once no scan is asking with the candidate. */
  function candidateFree(candidate) {
    if (!candidateScans[candidate]) return Promise.resolve();
    return new Promise(function (ok) { (candidateWaiters[candidate] = candidateWaiters[candidate] || []).push(ok); });
  }

  /* What a scan looks at: { own: true } for this wallet's
   * seed (no words given), { candidate } for words typed on the phone, or a
   * throw for words, which never reach the page. */
  function nativeScanTarget(phrase) {
    if (phrase == null || (typeof phrase === 'string' && !phrase.trim())) return { own: true, candidate: null };
    if (typeof phrase === 'object' && !Array.isArray(phrase) && typeof phrase.candidate === 'string' && phrase.candidate) {
      return { own: false, candidate: phrase.candidate };
    }
    throw new Error(WORDS_STAY + ' Enter the words on the phone to restore them.');
  }

  /* Ask the native side something and wait for the answer. */
  function bridgeAsk(action, extra, ms) {
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (!mh) return Promise.reject(new Error('This needs the app.'));
    return new Promise(function (ok, no) {
      var id = 'b' + Date.now() + Math.random().toString(36).slice(2, 7);
      var settled = false;
      FoxyWallet._scans[id] = {
        ok: function (t) { if (!settled) { settled = true; ok(String(t)); } },
        no: function (e) { if (!settled) { settled = true; no(new Error(String((e && e.message) || e))); } }
      };
      var msg = { action: action, id: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      mh.postMessage(msg);
      setTimeout(function () {
        if (!settled) {
          settled = true;
          delete FoxyWallet._scans[id];
          no(new Error(action + ' did not answer.'));
        }
      }, ms || 20000);
    });
  }

  /* Every cashu-ts Wallet, built one way: through the native side.
   *
   * The Mint gets customRequest, so every mint call goes over the bridge and
   * the native side decides the route — Tor, or the open connection if the
   * person chose that — per request. A wallet built before Tor came up is no
   * longer stale when it does: the route is chosen when the request is made,
   * not when the wallet was.
   *
   * customRequest goes on the Mint, not the Wallet. Passing it in Wallet's
   * options is silently ignored — Wallet.ts never reads it — and for two hours
   * mint calls used cashu-ts's own fetch while the opposite was reported.
   *
   * With no native side (a desktop browser, the tests) there is nothing to
   * route through, and cashu-ts uses its own fetch. */
  function newWallet(url, opts) {
    var o = opts ? Object.assign({}, opts) : {};
    /* A restore of words typed on the phone names their candidate; it is
     * Foxy's, not an option cashu-ts knows. */
    var candidate = o.foxyCandidate || null;
    delete o.foxyCandidate;
    /* The placeholder seed goes only into a wallet whose outputs come from the
     * phone (the creator, above): cashu-ts's own creator would derive from it.
     * With no bridge there is no phone to send them. */
    var native = isPlaceholderSeed(o.bip39seed);
    if (native) {
      if (!bridged()) throw new Error('A wallet on the placeholder seed needs secrets from the phone, and this page has no bridge to it.');
      o.outputDataCreator = nativeOutputCreator(candidate ? 'c:' + candidate : '');
    } else if (candidate) {
      throw new Error('A restore candidate is scanned only on the placeholder seed.');
    } else {
      // so a locked send is written down whatever the secrets come from
      o.outputDataCreator = plainOutputCreator();
    }
    var target = url;
    if (bridged() && window.CashuTS && window.CashuTS.Mint) {
      target = new window.CashuTS.Mint(url, { customRequest: FoxyWallet.nativeRequest });
    }
    var made = Object.keys(o).length
      ? new window.CashuTS.Wallet(target, o)
      : new window.CashuTS.Wallet(target);
    /* Whether what this wallet makes comes from the seed. A connect before the
     * seed is ready has random secrets, and change from such a wallet cannot
     * be restored; addOwnProofs reads this. */
    try { made.foxySeeded = !!o.bip39seed; } catch (e) {}
    if (native) { try { made.foxyNativeSecrets = true; } catch (e) {} }   // restoreFrom reads this
    if (candidate) { try { made.foxyCandidate = candidate; } catch (e) {} }  // and this
    return made;
  }

  /* Serialise and parse the way cashu-ts does.
   *
   * Its JSONInt is BigInt-safe; JSON is not. Falling back to JSON only if the
   * library does not expose it, which would be a version change worth noticing
   * rather than working around silently. */
  function serialiseBody(body) {
    var C = window.CashuTS;
    if (C && C.JSONInt && C.JSONInt.stringify) return C.JSONInt.stringify(body);
    if (C && C.bigIntStringify) return C.bigIntStringify(body);
    console.warn('[foxy] cashu-ts exposes no BigInt-safe stringify — falling back');
    return JSON.stringify(body);
  }

  function parseBody(text) {
    var C = window.CashuTS;
    if (C && C.JSONInt && C.JSONInt.parse) return C.JSONInt.parse(text);
    return JSON.parse(text);
  }

  /* One counter store for every wallet object this page makes: the phone's.
   *
   * cashu-ts gives each wallet object its own copy of the counters unless it is
   * handed a source. Foxy made a new object on every connect, each starting
   * from a snapshot, and wrote back whatever its own copy said on each
   * reservation. Two objects on one keyset — a connect racing a claim — could
   * hand out the same counters, which the mint refuses with "outputs have
   * already been signed", and a late write-back could move a counter down.
   * cashu.me shares one source.
   *
   * Every call here goes to the phone. It reserves atomically, so two wallet
   * objects never get the same counters, and it never moves a counter down. A
   * reservation brings its counters' secrets in the same answer (nativeReserve).
   * A refusal rejects before cashu-ts builds any output, so the request is never
   * sent (`unsent`). */
  var sharedCounters = {
    reserve: function (id, n) {
      if (n < 0) return Promise.reject(new Error('reserve called with a negative count'));
      return nativeReserve(id, null, n);
    },
    reserveAt: function (id, start, n) {
      if (start < 0 || n < 0) return Promise.reject(new Error('reserveAt called with a negative start or count'));
      return nativeReserve(id, start, n);
    },
    advanceToAtLeast: function (id, to) {
      return nativeAdvance(id, to).then(function () {});
    },
    /* Never down. Nothing in Foxy calls this, but cashu-ts passes a wallet's
     * counters.setNext straight through, and this used to assign whatever it
     * was given: a lower counter hands out secrets the mint has already signed,
     * and a restore of an operation's recorded ranges would then find another
     * operation's proofs there. */
    setNext: function (id, next) {
      if (next < 0) return Promise.reject(new Error('setNext: negative next not allowed'));
      /* The phone only moves a counter up, and answers where it is: a next
       * below that was not applied, and is refused here as it always was. */
      return nativeAdvance(id, next).then(function (now) {
        if (now > Number(next)) {
          throw new Error('setNext: counter ' + next + ' for keyset ' + id +
            ' is below the next one (' + now + '); counters only move forward');
        }
      });
    },
    snapshot: function () {
      return nativeSnapshot();
    },
  };

  /* A pause before a background check at a mint.
   *
   * On a connect or a return the sweeps asked about every outstanding invoice,
   * held melt and lost swap one straight after another. Each now leaves on its
   * own circuit, but requests that arrive in the same second from different
   * exits still read as one wallet to a mint few people use. A random pause of
   * 1.5 to 5 seconds comes before each (MINT-PRIVACY.md N4). Only in the app:
   * without the phone there is no Tor to spread across, and the tests set
   * `FoxyWallet._sweepPause` to the range they want. Never inside the proof
   * lock, where it would hold up a payment. */
  function sweepPause() {
    var range = FoxyWallet._sweepPause || (bridged() ? [1500, 5000] : [0, 0]);
    var lo = Number(range[0]) || 0, hi = Math.max(lo, Number(range[1]) || 0);
    var ms = lo + Math.floor(Math.random() * (hi - lo + 1));
    return ms > 0 ? new Promise(function (r) { setTimeout(r, ms); }) : Promise.resolve();
  }

  /* `chain`, then a pause when there is one to take: no pause adds no step. */
  function afterPause(chain) {
    var range = FoxyWallet._sweepPause || (bridged() ? [1500, 5000] : [0, 0]);
    return (Number(range[1]) || 0) > 0 ? chain.then(sweepPause) : chain;
  }

  /* Are the keys this wallet was given the ones everyone gets?
   *
   * A mint could publish a keyset to one visitor only and then recognise that
   * wallet's ecash wherever it turned up. The DLEQ check proves a signature
   * matches the keys the mint published to this wallet; it cannot say whether
   * anyone else was shown them. So, some time after a connect, the mint's
   * keyset list is asked for again on a circuit nothing else uses, a request
   * the mint cannot tie to this wallet. Keyset ids are derived from the keys
   * (cashu-ts drops keys that do not match their id), so an id the wallet holds
   * that is missing from that list is a keyset shown to this wallet alone. A
   * miss is asked once more, later, on another circuit, before it is reported
   * through onMintTrouble. Once a session per mint; only in the app
   * (MINT-PRIVACY.md C10). Tests set `FoxyWallet._keysetCheckDelay`. */
  var keysetsChecked = Object.create(null);

  function checkKeysetsElsewhere(u, w, tries) {
    if (!bridged() || !w || keysetsChecked[u]) return;
    var mine = [];
    try { mine = ((w.keyChain && w.keyChain.getKeysets && w.keyChain.getKeysets()) || []).map(function (k) { return String(k.id); }); } catch (e) {}
    if (!mine.length) return;
    keysetsChecked[u] = true;
    var range = FoxyWallet._keysetCheckDelay || [30000, 120000];
    var lo = Number(range[0]) || 0, hi = Math.max(lo, Number(range[1]) || 0);
    /* Half a minute to two minutes is long enough for Tor to drop inside it —
     * a phone changing network — and the pass that found the gate shut used to
     * put the flag back and stop there, with nothing calling this again until
     * the next connect: the check that catches a mint handing this wallet a
     * keyset of its own quietly never ran for the session. It waits again
     * instead, up to eight times. The on-chain watcher stopped the same way. */
    askLater(0);

    function askLater(waits) {
      setTimeout(function () {
        if (!routeOpen()) {
          if (waits < 8) { askLater(waits + 1); return; }
          keysetsChecked[u] = false;
          return;
        }
        /* Asked of the mint itself, never of what Foxy remembers: the whole
         * point is a second, independent answer (nativeRequest, foxyFresh). */
        FoxyWallet.nativeRequest({ endpoint: String(u).replace(/\/+$/, '') + '/v1/keysets', method: 'GET',
                                   foxyCircuit: newCircuitLabel(), foxyFresh: true })
          .then(function (j) {
            var theirs = ((j && j.keysets) || []).map(function (k) { return String(k && k.id); });
            var unseen = mine.filter(function (id) { return theirs.indexOf(id) < 0; });
            if (!unseen.length) return;
            if (tries < 1) {
              keysetsChecked[u] = false;
              checkKeysetsElsewhere(u, w, tries + 1);
              return;
            }
            console.warn('[foxy] ' + hostOf(u) + ' gave this wallet ' + unseen.length +
              ' keyset(s) its list elsewhere does not show');
            if (typeof FoxyWallet._onMintTrouble === 'function') {
              try { FoxyWallet._onMintTrouble({ mint: hostOf(u), keysetsUnseen: unseen.length }); } catch (x) {}
            }
          }, function () { keysetsChecked[u] = false; });
      }, lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
  }

  /* The connected wallet for work that asks the mint nothing.
   *
   * `need()` below asserts the route and puts the wallet on a fresh Tor
   * circuit, because nearly every caller is about to make a request. A caller
   * that only reads what is already cached — the fee on a set of pieces,
   * whether the pile can make an amount exactly — needs neither, and asserting
   * there is what refused an exact-change send that never touches the network:
   * the whole reason a payer with no signal could not pay anybody.
   *
   * No circuit label either, because a view that never sends a request has
   * nothing to label. Anything that might send one must use `need()`, and a
   * caller that starts local and then decides to ask the mint must re-acquire
   * through it — `sendToken` does exactly that in its swap branch. */
  function needLocal() {
    if (!wallet) throw new Error('No mint connected yet. Call FoxyWallet.connect() first.');
    return wallet;
  }

  /* The connected wallet, on a Tor circuit of its own for the job asking. */
  function need() {
    assertRoute();
    if (!wallet) throw new Error('No mint connected yet. Call FoxyWallet.connect() first.');
    return onCircuit(wallet);
  }

  /* One circuit kept ready for whatever the person does next.
   *
   * Every job leaves on a circuit of its own, and a circuit takes a second or
   * three to build after Foxy comes to the front. Now and then one goes
   * nowhere at all: the request sits on it until its clock runs out, while
   * the mint is answering the phone beside it. A swap sat on such a circuit
   * for 56 seconds in front of two people holding their phones together.
   *
   * So one circuit is opened ahead of time, by asking the mint something it
   * tells anybody (its keysets), and kept only once the mint has answered on
   * it. The next job a person is waiting for takes it: an invoice, a fee
   * quote, a payment, a token. That job starts on a road that has just been
   * shown to reach the mint, and another is opened behind it.
   *
   * It is still one circuit to a job. The spare is handed out once and is
   * then that job's alone; what the mint sees on it is a question about its
   * keysets followed by the job, which is what a job's first connect looks
   * like anyway. Work nobody is waiting on (sweeps, checks, top-ups) does not
   * take it. It is let go after five minutes, when Tor would be retiring the
   * circuit, when the mint changes, and when Foxy has been away. */
  var spare = /** @type {?{ label: string, mint: string, at: number }} */ (null);
  var sparing = /** @type {?Promise<boolean>} */ (null);
  var SPARE_FOR_MS = 5 * 60 * 1000;

  function spareReady() {
    return !!(spare && wallet && spare.mint === mintOf(wallet) && Date.now() - spare.at < SPARE_FOR_MS);
  }

  function dropSpare() { spare = null; }

  /* Open one, unless one is ready or on its way. Two tries at most, each on a
   * circuit of its own and given eight seconds: a road that will not carry
   * this is not one to keep. Resolves whether a spare is ready. Silent when
   * it fails; the job that would have used it asks on a fresh circuit, as it
   * always did. */
  function warmSpare() {
    if (FoxyWallet._spareOff || !wallet || !routeOpen() || !bridged()) return Promise.resolve(false);
    if (spareReady()) return Promise.resolve(true);
    if (sparing) return sparing;
    spare = null;
    var at = mintOf(wallet);
    var tryOne = function (left) {
      var label = newCircuitLabel(), began = Date.now();
      var asked = FoxyWallet.nativeRequest({ endpoint: at + '/v1/keysets', method: 'GET',
                                              foxyFresh: true, foxyCircuit: label });
      var clock = new Promise(function (_, no) {
        setTimeout(function () { no(new Error('no answer')); }, FoxyWallet._spareWaitMs || 8000);
      });
      return Promise.race([asked, clock]).then(function () {
        // the mint changed, or the route went, while it was being opened
        if (!wallet || mintOf(wallet) !== at || !routeOpen()) return false;
        spare = { label: label, mint: at, at: Date.now() };
        console.log('[foxy] a circuit to ' + hostOf(at) + ' is ready for what comes next, in '
          + (Date.now() - began) + ' ms');
        return true;
      }, function () {
        if (left > 0 && wallet && mintOf(wallet) === at && routeOpen()) return tryOne(left - 1);
        console.log('[foxy] no circuit to ' + hostOf(at) + ' could be made ready ahead of time');
        return false;
      });
    };
    var run = tryOne(1);
    sparing = run;
    var free = function () { if (sparing === run) sparing = null; };
    run.then(free, free);
    return run;
  }

  /* A moment later, so it does not ride on the heels of the job that has just
   * taken the last one. */
  function warmSpareSoon() {
    if (FoxyWallet._spareOff) return;
    setTimeout(function () { warmSpare(); }, FoxyWallet._spareAfterMs === undefined ? 1500 : FoxyWallet._spareAfterMs);
  }

  /* The connected wallet for a job somebody is waiting on: on the spare
   * circuit when one is ready, and on a new one of its own when not. */
  function viewNow(w) {
    if (!spareReady()) { dropSpare(); warmSpareSoon(); return onCircuit(w); }
    var label = /** @type {{ label: string }} */ (spare).label;
    dropSpare();
    warmSpareSoon();
    return onLabel(w, label);
  }

  function needNow() {
    assertRoute();
    if (!wallet) throw new Error('No mint connected yet. Call FoxyWallet.connect() first.');
    return viewNow(wallet);
  }

  /* Each job at a mint leaves from its own Tor exit.
   *
   * A mint sees the exit every request comes from. All of a mint's requests
   * used to share one circuit for ten minutes, so a launch's checks, a payment
   * and a receive made in that time arrived as one person. Now each job asks
   * through a wallet view whose mint requests carry a circuit label, and the
   * phone gives each label its own circuit (MintCircuit, TorService). A job is
   * what the mint could link anyway: one payment's quote, swap and melt; one
   * invoice's polls and claim; one sent token's checks.
   *
   * `key` names requests that belong together across calls ('quote:<id>',
   * 'token:<hash>'): the same key keeps its circuit while the page is open.
   * Without one, the view gets a circuit nothing else uses. A request made on
   * the connected wallet itself, unlabelled, gets its own circuit from the
   * phone.
   *
   * The view is a Proxy: reads of `mint` return a mint whose requests carry
   * the label; everything else, writes included, is the wallet's own, so
   * counters, keysets and repairs cashu-ts records stay on the one wallet.
   * Only wallets whose requests go to the phone are wrapped. */
  var circuitKeys = [];
  var circuitByKey = Object.create(null);

  function newCircuitLabel() {
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return hexOf(b);
  }

  function circuitFor(key) {
    if (key == null || key === '') return newCircuitLabel();
    var k = String(key);
    if (!circuitByKey[k]) {
      circuitByKey[k] = newCircuitLabel();
      circuitKeys.push(k);
      if (circuitKeys.length > 500) delete circuitByKey[/** @type {string} */ (circuitKeys.shift())];
    }
    return circuitByKey[k];
  }

  function onCircuit(w, key) {
    return w ? onLabel(w, circuitFor(key)) : w;
  }

  /* `w` on the circuit `from` is on: a unit wallet for a receive, say. */
  function sameCircuit(from, w) {
    var label = from && from.foxyCircuit;
    return label && w ? onLabel(w, label) : w;
  }

  function onLabel(w, label) {
    var base = w.foxyBase || w;
    var mint = base.mint;
    if (!mint || mint._request !== FoxyWallet.nativeRequest || typeof Proxy !== 'function') return base;
    var request = function (o) {
      return FoxyWallet.nativeRequest(Object.assign({}, o, { foxyCircuit: label }));
    };
    /* The inputs of the last swap or melt this view sent. A refusal that says
     * some were already spent is answered by asking about exactly these
     * (dropSpentInputs): the mint has just seen them, so that tells it nothing. */
    var sentInputs = null;
    /* Told the inputs of a swap as it goes out, before the request: swapGuard
     * records exactly what a send took, not the whole pile it was handed. */
    var onSwap = null;
    var mintView = new Proxy(mint, {
      get: function (t, k) {
        if (k === '_request') return request;
        var v = Reflect.get(t, k);
        if ((k === 'swap' || k === 'melt') && typeof v === 'function') {
          return function () {
            var payload = k === 'swap' ? arguments[0] : arguments[1];
            sentInputs = (payload && Array.isArray(payload.inputs)) ? payload.inputs : null;
            if (k === 'swap' && onSwap && sentInputs) onSwap(sentInputs);
            return v.apply(this, arguments);
          };
        }
        return v;
      },
      set: function (t, k, v) { t[k] = v; return true; },
    });
    return new Proxy(base, {
      get: function (t, k) {
        if (k === 'mint') return mintView;
        if (k === 'foxyCircuit') return label;
        if (k === 'foxySentInputs') return sentInputs;
        if (k === 'foxyOnSwap') return onSwap;
        if (k === 'foxyBase') return t;
        return Reflect.get(t, k);
      },
      set: function (t, k, v) {
        if (k === 'foxyOnSwap') { onSwap = typeof v === 'function' ? v : null; return true; }
        t[k] = v;
        return true;
      },
    });
  }

  /* A wallet object for another unit at the same mint as `w`.
   *
   * cashu-ts binds a wallet to one unit: its keyset list, its receive and its
   * restore all refuse any other. So usd ecash needs a usd wallet. It is built
   * like every other (newWallet, so it is routed the same way) and loaded from
   * what `w` already fetched — no second round of requests. `opts` are the
   * options to build it with; left out, they are the connected wallet's own:
   * this seed's deterministic secrets and the shared counter store, never
   * random secrets. Refuses a unit the mint has no keyset for. */
  function unitWallet(w, unit, opts) {
    var u = unitOf(unit);
    if (!u || u === 'sat') return Promise.reject(new Error('unitWallet is for units other than sats.'));
    var url = mintOf(w);
    var o;
    if (opts) {
      o = Object.assign({}, opts, { unit: u });
    } else {
      // the placeholder, once the phone has answered for a seed
      var seed = nativeSeedKnown ? placeholderSeed() : undefined;
      if (!seed) return Promise.reject(new Error('The seed is not ready yet, so ' + unitName(u) + ' ecash cannot be taken safely. Try again in a moment.'));
      o = { bip39seed: seed, secretsPolicy: 'deterministic', counterSource: sharedCounters, unit: u, requireSigDleq: true };
    }
    var uw = newWallet(url, o);
    var cached = null;
    try { cached = { info: w.getMintInfo().cache, keys: w.keyChain.cache }; } catch (e) {}
    var ready = (cached && cached.info && cached.keys && typeof uw.loadMintFromCache === 'function')
      ? Promise.resolve().then(function () { uw.loadMintFromCache(cached.info, cached.keys); })
      : withTimeout(uw.loadMint(), 30000, hostOf(url) + ' ' + u);
    return ready.then(function () {
      var sets = [];
      try { sets = (uw.keyChain && uw.keyChain.getKeysets) ? uw.keyChain.getKeysets() : []; } catch (e) {}
      if (!sets || !sets.length) throw new Error(hostOf(url) + ' does not issue ' + unitName(u) + ' ecash.');
      return uw;
    });
  }

  /* ---- what a mint told us last time ---------------------------------
   *
   * A wallet cannot exist without its mint's keysets: every proof names the
   * keyset that signed it, and verifying one (NUT-12) needs that keyset's
   * public keys. cashu-ts fetches them in loadMint(), which is a request, which
   * needs a route. So a phone launched with the radios off had no wallet at
   * all — no balance, no mint to select, nothing to spend — even though it was
   * holding ecash and the only thing missing was a list of public keys it had
   * already been given (seen on a phone in airplane mode).
   *
   * So they are written down. cashu-ts already has both halves of this for its
   * own reasons: `keyChain.cache` and `getMintInfo().cache` are plain JSON, and
   * `loadMintFromCache` rebuilds a wallet from them without a single request —
   * it is what unitWallet above uses to avoid a second round trip. This is the
   * same mechanism, kept across launches instead of across one.
   *
   * Nothing here is secret and nothing here is money: a keyset's public keys
   * are published by the mint to anybody who asks. What it does reveal, to
   * somebody already reading this phone's storage, is which mints it has used —
   * and the mint list (K.mints) says that already, in plainer words.
   *
   * Capped, oldest dropped first. Each mint's entry is a few tens of kilobytes
   * (one hex public key per amount per keyset), and localStorage is not
   * generous. Five is more mints than a phone switches between. */
  var MINT_CACHE_MAX = 5;

  function mintCacheSave(u, w) {
    var key = String(u || '').replace(/\/+$/, '');
    if (!key || !w) return;
    var entry;
    try {
      entry = {
        info: w.getMintInfo().cache,
        keys: w.keyChain.cache,
        at: Math.floor(Date.now() / 1000),
      };
      if (!entry.info || !entry.keys || !entry.keys.keysets || !entry.keys.keysets.length) return;
      /* Written and read back before it is kept: a cache that cannot survive
       * JSON is worse than none, because it would be found and trusted on the
       * launch that has no way to fetch a replacement. */
      entry = JSON.parse(JSON.stringify(entry));
    } catch (e) {
      console.warn('[foxy] could not write down ' + hostOf(u) + "'s keysets:", e && e.message);
      return;
    }
    try {
      var all = load(K.mintCache, {});
      if (!all || typeof all !== 'object') all = {};
      all[key] = entry;
      var urls = Object.keys(all);
      if (urls.length > MINT_CACHE_MAX) {
        urls.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
        urls.slice(0, urls.length - MINT_CACHE_MAX).forEach(function (old) { delete all[old]; });
      }
      save(K.mintCache, all);
    } catch (e) {
      // a full localStorage must not fail a connect that otherwise worked
      console.warn('[foxy] could not keep ' + hostOf(u) + "'s keysets:", e && e.message);
    }
  }

  /* The entry for this mint, or null. Only what loadMintFromCache needs counts:
   * an entry missing either half is no entry. */
  function mintCacheFor(u) {
    var key = String(u || '').replace(/\/+$/, '');
    if (!key) return null;
    try {
      var all = load(K.mintCache, {});
      var got = all && all[key];
      if (!got || !got.info || !got.keys) return null;
      if (!got.keys.keysets || !got.keys.keysets.length) return null;
      return got;
    } catch (e) { return null; }
  }

  /* Write a history entry. The mint deliberately keeps no record, so this file
   * is the only history that will ever exist. */
  /* What a payment consumed and produced.
   *
   * Kept so that when something goes wrong there is something to look at
   * rather than something to guess about. Inputs are spent and worthless;
   * outputs are live change, and also already in the proof list — this is a
   * duplicate of money the wallet holds, not a new copy of a secret.
   *
   * The last hundred in full, and four hundred more as receipts; cleared
   * whenever history is.
   *
   * In full is every piece, for working out where money went: about seven
   * kilobytes a payment and twenty for one that refills the small change, so
   * five hundred of those would be most of the page's whole store, and a
   * store that is full refuses the writes that money depends on. It is held
   * to a megabyte as well as to a hundred.
   *
   * A receipt is what proves something and nothing that spends: when, where,
   * how much, the payment's id, and the public value of each piece that left
   * (`ys`). A mint knows a piece by that value and by nothing else, so with
   * it anybody can ask whether the piece was spent, and nobody can spend it.
   * Every send keeps them from the start, because the pieces of a sent token
   * are dropped from here once it is claimed and these have to outlast them. */
  var AUDIT_FULL = 100, AUDIT_ALL = 500, AUDIT_FULL_CHARS = 1000000;

  /* The value a mint knows a piece by (NUT-00's Y), or ''. */
  function lookupOf(p) {
    try {
      var CT = window.CashuTS;
      if (!CT || !CT.hashToCurve || !p || typeof p.secret !== 'string') return '';
      return String(CT.hashToCurve(new TextEncoder().encode(p.secret)).toHex(true));
    } catch (e) { return ''; }
  }

  function slimAudit(a) {
    if (!a || a.slim) return a;
    var out = /** @type {any} */ ({ at: a.at, mint: a.mint, hash: a.hash, sats: a.sats, feeSats: a.feeSats,
                                    kind: a.kind, slim: true,
                                    ins: (a.inputs || []).length || (a.ys || []).length,
                                    outs: (a.outputs || []).length });
    if (a.ys && a.ys.length) out.ys = a.ys;
    if (a.lockedTo) out.lockedTo = a.lockedTo;
    return out;
  }

  /* Newest first: in full while there is room for it, receipts after that. */
  function shapeAudit(list) {
    var chars = 0, full = 0;
    return (list || []).slice(0, AUDIT_ALL).map(function (a) {
      if (!a || a.slim) return a;
      var size = JSON.stringify(a).length;
      if (full >= AUDIT_FULL || chars + size > AUDIT_FULL_CHARS) return slimAudit(a);
      full += 1; chars += size;
      return a;
    });
  }

  function logAudit(entry) {
    try {
      var list = load(K.audit, []);
      var rec = /** @type {any} */ (Object.assign({
        at: Math.floor(Date.now() / 1000),
        mint: String(mintUrl || '').replace(/\/+$/, ''),
      }, entry));
      // what left this wallet, by the values the mint knows it by
      if (!rec.ys) rec.ys = (rec.inputs || []).map(lookupOf).filter(Boolean);
      /* A token whose every piece is locked to one key: said on the record,
       * because those pieces are kept once it is claimed, where a plain
       * token's are dropped. Nobody but that key's holder could ever spend
       * them, and once the mint says they are spent, the signature they were
       * spent with is the proof of who took the payment (`lockedReceipt`). */
      if (rec.kind === 'token' && rec.inputs && rec.inputs.length) {
        var keys = rec.inputs.map(lockedTo);
        if (keys[0] && keys.every(function (k) { return k === keys[0]; })) rec.lockedTo = keys[0];
      }
      list.unshift(rec);
      save(K.audit, shapeAudit(list));
    } catch (e) {
      // an audit record is never worth failing a payment over
      console.warn('[foxy] could not record the audit trail:', e && e.message);
    }
  }

  /* `amendInto` is a hash that may already be in the log: an entry written
   * before the money moved, which this call finishes rather than duplicates.
   * Nothing there means this is the first word of it, and it is written. */
  /* The price of bitcoin, in dollars, as this phone last knew it — for an
   * entry to keep. 0 when it has never known one. */
  function rateNow() {
    var n = Number(FoxyWallet && FoxyWallet._rate) || 0;
    return n > 0 ? Math.round(n) : 0;
  }

  function logTx(entry, amendInto) {
    if (amendInto && amendTx(amendInto, entry)) return;
    var list = load(K.log, []);
    // which mint this happened at, so history can be read one mint at a time.
    // Entries written before this have no mint and are shown everywhere.
    /* The mint the phone is on, unless the entry names one, and an entry for
     * money that moved should: a transfer between mints has the phone on the
     * other mint for a while, and a payment that lands meanwhile was filed
     * there, at a mint it never touched. The history card then said DOES NOT
     * ADD UP at both mints for good, by that payment (tests/harness.js, "the
     * books", from tests/interleave.js). */
    /* And what bitcoin cost at the time. History shows dollars, and the
     * dollars of a payment are the dollars it was worth when it was made: a
     * figure worked out again from today's price makes last week's lunch
     * cheaper or dearer every time the list is opened.
     * Written once here, and once more when an entry that was waiting
     * settles (`amendTx`). */
    var first = { at: Math.floor(Date.now() / 1000),
                  mint: String(mintUrl || '').replace(/\/+$/, '') };
    if (rateNow()) first.rate = rateNow();
    list.unshift(Object.assign(first, entry));
    // five hundred, so the history screen's audit reaches the start
    save(K.log, list.slice(0, 500));
  }

  /* Whether history already holds an entry under this hash.
   *
   * For ecash taken offline, where the mint cannot be asked whether it has seen
   * these proofs before and the only record is this phone's own
   * (`piecesFingerprint`). Cheap: one read of a list capped at 200. */
  function txSeen(hash) {
    if (!hash) return false;
    var list = load(K.log, []);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].hash === hash) return true;
    }
    return false;
  }

  /* A name for a particular set of pieces, the same every time and different
   * for any other set.
   *
   * Not a secret and not security: the secrets themselves never leave this
   * function, and what comes out is a short fold of them used to tell one
   * bundle of ecash from another on a phone that cannot ask a mint. Sorted
   * first, so the same pieces in a different order are the same ecash. */
  function piecesFingerprint(list) {
    var parts = (Array.isArray(list) ? list : []).map(function (p) {
      return String((p && p.secret) || '');
    }).filter(Boolean).sort().join('|');
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < parts.length; i++) {
      var c = parts.charCodeAt(i);
      h1 = ((h1 ^ c) * 16777619) >>> 0;
      h2 = ((h2 + c) * 2654435761) >>> 0;
    }
    return ('0000000' + h1.toString(36)).slice(-7) + ('0000000' + h2.toString(36)).slice(-7);
  }

  /* Ecash this phone has swapped in, by fingerprint, for a while.
   *
   * A payment can land here while its "paid" never reaches the payer: both
   * phones put away for a moment, the answer sent to an app that iOS had
   * suspended. The payer then shows the same payment as a code, and scanned
   * here the mint says spent, which is true and says nothing of by whom. The
   * card read "claimed already, by someone else or by this wallet", to a
   * person holding the phone that had the money. This is how the phone knows
   * it was itself: the fingerprint of what it took, the amount and when.
   * No secret is kept (`piecesFingerprint`). Two hundred, thirty days. */
  var TAKEN_KEEP_MS = 30 * 24 * 3600 * 1000;
  function takenList() {
    var l = load(K.taken, []);
    var now = Date.now();
    return (Array.isArray(l) ? l : []).filter(function (r) {
      return r && typeof r.f === 'string' && now - (Number(r.at) || 0) < TAKEN_KEEP_MS;
    });
  }
  function noteTaken(list, sats) {
    var f = piecesFingerprint(list);
    if (!f || !(Array.isArray(list) && list.length)) return;
    var l = takenList().filter(function (r) { return r.f !== f; });
    l.push({ f: f, at: Date.now(), sats: Math.max(0, Math.round(Number(sats) || 0)) });
    // `save`, and a refusal ignored: the money is in the pile either way, and this is only for the wording of a card
    save(K.taken, l.slice(-200));
  }
  function takenBefore(list) {
    if (!(Array.isArray(list) && list.length)) return null;
    var f = piecesFingerprint(list);
    return takenList().filter(function (r) { return r.f === f; })[0] || null;
  }
  /* The same refusal, marked as this phone's own doing when it is.
   *
   * Marked, not reworded: the claim on a reconnect and the request's own
   * claim both read "already spent" in the message to learn that a token is
   * gone and its row can go (`claimUnclaimed`, `_requestPaid`). The screen
   * reads the mark (`claimFailed`). */
  function mineIfTaken(e, list) {
    if (!e || typeof e !== 'object') return e;
    var text = String(e.message || e.detail || '');
    if (!/already spent|token already|already claimed/i.test(text) && Number(e.code) !== 11001) return e;
    var rec = takenBefore(list);
    if (!rec) return e;
    try { e.foxyMine = true; e.foxyTakenAt = rec.at; e.foxyTakenSats = rec.sats; } catch (x) {}
    return e;
  }

  /* Change an entry already written, by hash. A payment that is logged before
   * it is sent — because the window where nothing is known is exactly the one
   * history must not be silent for — is finished here rather than logged twice
   * under the same hash. Returns whether it found one. */
  function amendTx(hash, fields) {
    var list = load(K.log, []);
    var found = false;
    list.forEach(function (e) {
      if (!e || e.hash !== hash) return;
      /* Settling is the moment its dollars are fixed: an entry that was
       * waiting takes the price of the moment it stopped waiting. One that
       * was already settled keeps the price it has. */
      var settling = fields && fields.settled === true && e.settled !== true;
      Object.assign(e, fields);
      if ((settling || !(Number(e.rate) > 0)) && rateNow()) e.rate = rateNow();
      found = true;
    });
    if (found) save(K.log, list);
    return found;
  }

  /* Entries from before prices were kept, given the one this phone has now.
   * It is not the price they settled at and nothing can recover that; what it
   * does is stop them moving from here on. Answers how many it stamped. */
  function stampRates() {
    var rate = rateNow();
    if (!rate) return 0;
    var list = load(K.log, []);
    var n = 0;
    list.forEach(function (e) { if (e && !(Number(e.rate) > 0)) { e.rate = rate; n += 1; } });
    if (n) {
      save(K.log, list);
      console.log('[foxy] history: ' + n + ' older entr' + (n === 1 ? 'y' : 'ies')
        + ' given today\u2019s price, so their dollars stop moving');
    }
    return n;
  }

  /* Keyset ids the connected wallet has loaded. A token from this mint decodes
   * fully; one from anywhere else falls back to metadata. */
  function keysetIdsFor(w) {
    try {
      var ks = w && (w.keysets || (w.keyChain && w.keyChain.keysets));
      if (!ks) return [];
      return (Array.isArray(ks) ? ks : Object.values(ks))
        .map(function (k) { return k && (k.id || k); })
        .filter(function (x) { return typeof x === 'string'; });
    } catch (e) { return []; }
  }

  var SHA_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

  function sha256(bytes) {
    var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var m = bytes.slice(), bits = bytes.length * 8, i, t;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    m.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < m.length; i += 64) {
      var w = new Array(64);
      for (t = 0; t < 16; t++) w[t] = (m[i+t*4] << 24) | (m[i+t*4+1] << 16) | (m[i+t*4+2] << 8) | m[i+t*4+3];
      for (t = 16; t < 64; t++) {
        var s0 = rr(w[t-15],7) ^ rr(w[t-15],18) ^ (w[t-15] >>> 3);
        var s1 = rr(w[t-2],17) ^ rr(w[t-2],19) ^ (w[t-2] >>> 10);
        w[t] = (w[t-16] + s0 + w[t-7] + s1) | 0;
      }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25), ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + SHA_K[t] + w[t]) | 0;
        var S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22), mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) | 0;
        hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      h = [h[0]+a|0, h[1]+b|0, h[2]+c|0, h[3]+d|0, h[4]+e|0, h[5]+f|0, h[6]+g|0, h[7]+hh|0];
    }
    var out = [];
    h.forEach(function (x) { out.push((x>>>24)&255, (x>>>16)&255, (x>>>8)&255, x&255); });
    return out;
  }

