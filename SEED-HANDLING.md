# Seed and key handling — what the code actually does

Written for the security review. This is a findings note, not a design
document: it records what the code does today, including where a comment and
the code disagree.

**The seed is on the phone, and only there.** In every build, Debug and Release,
native Swift makes the twelve words, keeps them in the keychain, shows them on
its own screen, takes typed ones on its own screen, and owns the NUT-13
counters. The page runs the wallet on cashu-ts and never holds the words: it
asks the bridge for the secrets of counters native has reserved. There is no
launch switch and no page-side copy; the earlier designs that had them are gone.

## Generation

`Foxy/Keychain/BIP39.swift`, for `seedCreate` and a wipe's new seed:

```swift
var entropy = [UInt8](repeating: 0, count: 16)
guard SecRandomCopyBytes(kSecRandomDefault, entropy.count, &entropy) == errSecSuccess else { throw Failure.random }
return try words(entropy: entropy, wordlist: wordlist).joined(separator: " ")
```

128 bits from the system's random source, the first four bits of their SHA-256
as the checksum, twelve words. A failed `SecRandomCopyBytes` makes no seed
("the seed could not be made"); there is no weaker fallback. The English list
is bundled as `Foxy/Keychain/bip39-english.txt` and used only if its SHA-256 is
the pinned one, which is the digest of the list inside `Web/bip39.js` and of the
BIP-39 repository's `english.txt`: a list with one word changed would make seeds
no other wallet can restore. Smoke check 32 and `FoxyTests/BIP39Tests.swift`
compare the two lists; `BIP39Tests` also runs the standard's vectors.

Derived material: `NUT13.seed(mnemonic:)` (PBKDF2-SHA512 from CommonCrypto,
2048 rounds, empty passphrase) for the wallet seed, and from it the NUT-13
secrets and blinding factors in `Foxy/Keychain/NUT13.swift`: HMAC-SHA256 for
`01` keysets, BIP-32 with libsecp256k1 (`Vendor/README.md`) for `00`. They are
tested byte for byte against the spec's vectors and 856 answers from the bundled
cashu-ts (`FoxyTests/NUT13Tests.swift`). Nothing else is derived from the words
except the P2PK lock keys, at NUT-13's path (below): Foxy's own earlier labelled
SHA-256 derivation for P2PK keys was removed.

## At rest, and reading it

`Foxy/Keychain/SeedStore.swift` (`SeedStore`, `SeedVault`):

- **With Face ID on, the seed is in `foxy.seed.v2`**, an item with
  `.userPresence` access control, this device only: every read needs Face ID or
  the device passcode. Tor runs inside Foxy's process, and code that got in
  through a bug in it could otherwise read the item silently. On the first read
  after an upgrade from a version that kept the seed only in the older item, the
  words are copied from `foxy.seed.v1`, read back through the same approval, and
  only then is the older item deleted. A phone with no passcode cannot read such
  an item at all, so there the seed stays in `foxy.seed.v1` and the log says so.
  A new install starts with Face ID off (next section).
- **A keychain read has three answers:** found, absent, or failed. They used to
  be two, and a page told there was no seed made one whose write replaced the
  real seed. A failed read is never "no seed": nothing is made or written, and
  `seedStatus` answers an error.
- **A seed behind a passcode that was removed** is a failure, not "no seed". A
  plain keychain note, `foxy.seed.v2.held`, is written before a seed is put
  behind the passcode. With no passcode set and that note present, an empty
  protected item answers "the seed was saved behind this phone's passcode, which
  is no longer set", so nothing is made or written. What iOS does to the item is
  not yet observed on a phone (`DEVICE-TESTS.md` 12d).
- **One prompt each time Foxy comes to the foreground.** The seed
  is forgotten as Foxy leaves, and read again as soon as it is back, past its
  lock, rather than when a payment first needs it (`openSeedForVisit`). So a
  visit asks once, and otherwise only the words screen asks.
- **One prompt when Foxy opens.** The wallet's first need for the seed comes
  after its lock screen. A Face ID unlock of Foxy hands its approval to that
  read, so it does not ask again; a PIN unlock, or no app lock, gets one Face ID
  or passcode prompt from iOS. The approval covers only the next read, within 30
  seconds, and is used up by it (`SeedVault.takeUnlock`). It never covers the
  words screen, which always asks, and it is forgotten when Foxy goes to the
  background, the page goes or its process ends, or the seed is written. So a
  script that crashed the page cannot have the seed read again without a prompt,
  and cannot open the words screen on an unlock's back.

## What stands in front of the seed

The section above describes a seed behind `.userPresence`. That is now a
**choice**, and not the default: a new installation records
`SeedVault.protection = .none` at its install marker, so its seed is written to
the older item `foxy.seed.v1` (this device only, readable while the phone is
unlocked, **no Face ID or passcode on a read**), and stays there until the
person turns USE FACE ID on in MENU › SETTINGS or answers the SECURE FOXY card.
An installation from before that keeps `device`.

What `.none` gives up, plainly:

- Code running inside Foxy's process — the case `.userPresence` was added
  for — can read the words without a prompt.
- **The words screen asks nothing.** `wordsForScreen()` is documented as
  "always asks", and with `.none` it reads the plain item: anyone holding the
  phone unlocked with Foxy open reaches the twelve words through BACKUP and TAP
  TO REVEAL. Replace and wipe still ask for Face ID or the passcode
  (`deviceOwnerApproves`); showing the words does not. This is an open decision.

Two rules tightened by an audit:

- Taking the guard off (`seedProtect` → `none`) always puts up Face ID or the
  passcode and never rides an earlier unlock's approval. The page draws the
  only "are you sure", so that prompt is the one thing a script cannot answer.
- A write to the plain item removes any copy left behind Face ID, and fails if
  it cannot. `read` believes the protected item first, so a copy left there
  would go on answering with the old words after a replace.

## Where the seed goes

Nowhere but native code. `SeedVault` reads the words for two things only:

- `seedForSecrets()`: the BIP-39 seed made from them, for derivation. Only that
  seed is kept, in native memory, until the unlock is forgotten, the page goes
  or loads again, Foxy goes to the background, or a write of the saved seed is
  attempted (whether or not it reports success) or the seed is deleted. The
  counter, restore and seed actions share it.
- `wordsForScreen()`: the words, for Foxy's own seed screen (`seedShow`), always
  behind its own Face ID or passcode prompt when the seed is kept behind Face ID;
  with protection `none` it asks nothing (above).

No bridge action answers the words, and no network call takes them. Only
`seedMigrate` takes words from the page: the one-time move below. The only
egress is the native screen, and that is the point of it.

## The bridge's seed actions

`Foxy/Bridge/NativeSeedBridge.swift`, in the action table of every build
(`THREAT-MODEL.md` §1). The page's `seedRead`, `seedWrite` and `seedDelete` are
gone: asking for one is an unknown action. Answers are JSON text; a refusal is a
plain message.

| action | takes | answers |
|---|---|---|
| `seedStatus` | `{}` | `{"exists": true}` or `{"exists": false}`; "the seed could not be read" |
| `seedCreate` | `{}` | `{"created": true}`; "a seed already exists" |
| `seedMigrate` | `{words}` | `{"migrated": true}`, `{"migrated": false, "same": true}` or `{"migrated": false, "different": true}`; "bad request", "no migration here" |
| `countersImport` | `{counters: {keysetId: n}}`, at most 256 keysets | `{"counters": {...}}`, per keyset the larger value; once per install, then "counters were already imported" |
| `counterReserve` | `{keysetId, count}`, count 0 to 1000 | `{keysetId, start, secrets, blindingFactors}`; count 0 is a peek |
| `counterReserveAt` | `{keysetId, start, count}`, count 1 to 1000 | the same shape; "range already issued", "too far ahead" |
| `counterAdvance` | `{keysetId, next}` | `{keysetId, next}`, the value now stored, never lower; "too far ahead" |
| `counterSnapshot` | `{}` | `{"counters": {...}}` |
| `restoreSecrets` | `{keysetId, start, count, candidate?}` | the same shape as `counterReserve`, no counter moved; "outside the restore window" |
| `p2pkReserve` | `{count}`, count 0 to 64 | `{start, next, pubkeys}` for `next ..< next + count`, reserved first; count 0 is a peek. Public halves only |
| `p2pkPubkeys` | `{start, count}`, count 1 to 300, no index past 20,000 | the same shape, nothing moved: the walk that finds which index a token in hand is locked to |
| `p2pkKey` | `{index}` | `{index, privkey, pubkey}`, inside 1,000 of the last index reserved or inside a range this session's walk served; "outside the lock-key window" |
| `seedShow` | `{verify}` | `{"verified": true}` or `{"verified": false}` once the screen closes |
| `seedEnter` | `{}` | `{"candidate": id}`; "cancelled" |
| `seedAdopt` | `{candidate}` | `{"adopted": true}` or `{"adopted": false, "same": true}`; "Nothing was changed.", "unknown candidate" |
| `seedCandidateForget` | `{candidate}` | `{"forgotten": true}` |
| `seedWipe` | `{}` | `{"wiped": true, "created": true}`; "Nothing was erased.", "the seed could not be deleted" |
| `seedProtection` | `{}` | `{"mode": "device"}` or `{"mode": "none"}`, and `"passcode"`: whether the phone has one. Asks the person for nothing |
| `seedProtect` | `{mode}`, `device` or `none` | `{"mode": …}`; "that is not a way to keep the seed", or why it could not be moved. Taking Face ID off asks for Face ID or the passcode first |

A request with a malformed field is "bad request" before anything is read. A
counter change that would add a 257th keyset is "too many keysets".

Each action's work after its input check is one function in
`Foxy/Keychain/SeedActions.swift`, run on the seed queue with the app's
environment (SeedVault's keychain, the counter file, typed words, the migration
window). `FoxyTests/SeedActionsTests.swift` runs every one of them with a stub
vault holding a known phrase, and fails if any reply or error holds a word of it
or the seed.

- **New words are made in Swift.** `seedStatus` answers whether a seed exists,
  through `SeedVault`'s read and unlock. `seedCreate` makes twelve words
  (Generation, above) and writes them with `SeedVault`'s rules, so a saved seed
  is never replaced ("a seed already exists"). Counters found with no seed
  beside them are set aside first: they belong to a seed that is gone, and a new
  seed's outputs must start at 0, where other wallets look.
- **Words the page still holds move once** (`seedMigrate`). An install from
  before the keychain can still have the words in the page's storage
  (`foxy.seed.v1`, once `flash.seed.v1`), and a page could have made a seed it
  never saved. The page sends them once. Words that are not a BIP-39 phrase (12
  to 24 English words with a right checksum, as one string or an array) are
  "bad request". With no seed saved, and only inside the one-time window below,
  they are written with `SeedVault`'s rules, never replacing one: `migrated`. The
  same BIP-39 seed already saved is `same`. A different seed saved is
  `different`, with nothing changed and no alert; the log says so. Those two
  answers come whether the window is open or closed: an
  old install whose first compare was lost to a cancelled Face ID, a
  `seedStatus` that then closed the window, or a crash before the page saved its
  stamp, can still clear the words from its page. Only a closed window with no
  seed saved is "no migration here", and a closed window never writes. The
  words are never answered back, and are kept only for the request. The
  counters are left alone: the page's own counters for those words come across
  with `countersImport`, and setting them aside would lose them. Which answer
  closes the window, and when a write is allowed, are pure functions
  (`SeedMigrationWindow.closes(after:)` and `step(open:saved:)`) with their own
  tests.
- **Native owns the counters** (`Foxy/Keychain/CounterStore.swift`; the file is
  in `STORAGE.md`). The page's counters come across with `countersImport`, per
  keyset the larger value, cut to the keyset version's last counter, and only
  once per install (`foxy.counters.imported`); a second import is "counters were
  already imported". `counterReserve` reserves the next `count` counters and
  writes the file before it answers their secrets; a count of 0 only reads the
  next counter. `counterReserveAt` reserves a given range, burns the counters
  below it, refuses a range already issued, and refuses a start more than 100
  past the counter ("too far ahead"), before any Face ID prompt.
  `counterAdvance` moves a counter up, never down, and no further than 100 past
  it, or than the end of the furthest range `restoreSecrets` served that
  keyset's entry in this run of Foxy, whichever is further; never past 2^31 for
  a `00` keyset or 2^53 for a `01` one ("too far ahead"). Those are the page's
  own moves: its used-output skips go 10, 50 and 100 at a time, and adopting a
  restore moves a counter to what the restore found, which native served.
  The file holds at most 256 keysets.
  `counterSnapshot` lists them. A counter file that cannot be read hands nothing
  out rather than starting again from zero, which would reuse counters.
  The numbers above — 100, 256, the batch of 1,000, the window of 1,000, 20,000
  and the version ceilings — are held once, in `tests/fixtures/native-rules.json`.
  `tests/harness.js`'s phone mock answers by that file, and
  `FoxyTests/NativeRulesTests.swift` compares it with the Swift that ships, so
  a rule cannot change on one side alone and leave the mock describing a phone
  that no longer exists.
- **One counter per derivation path.** NUT-13 derives a
  `00` keyset's path from `id mod (2^31 − 1)`, so different ids reach the same
  secrets: `009a1f293253e41e`, `0000000033882270`, `009a1f29b253e41d` and
  `009a1f28b253e41f` all derive index 864559728. Keyed by the id's text, a
  script could reserve or restore through a second id and collect the real
  keyset's future secrets. So a `00` keyset's counter is kept by its derivation
  index (`Foxy/Keychain/CounterRules.swift`): the entry is keyed by the first id
  stored for that index, any other id with the same index reaches it, and
  reserving through an alias burns the real keyset's counters rather than
  handing out another range's secrets. `counterSnapshot` keeps its shape
  `{id: next}`. Typed words' served ranges are kept the same way. A file from
  before with two ids of one index is merged at the larger value when read. A
  `01` keyset's path is its whole id, so it is keyed by the id.
- **Secrets for a restore are bounded.** `restoreSecrets` answers without moving
  any counter. For the saved seed it answers only ranges ending no more than 1,000
  past the keyset's next counter (0 for a keyset it has not seen): a scan of ten
  empty batches of 100 past the last counter handed out. It is wide because a
  swap can burn sixty counters at a go, and three empty batches would not cross
  that. For typed
  words it answers contiguously from 0: a request may start at most 1,000 past the
  furthest range already served for those words and that derivation path, and
  none past 20,000. Adopting the words, or finding they are the saved seed,
  raises each counter to at least 1,000 short of the end they were served to
  (`RestoreWindow.adoptedCounters`). A scan ends after ten empty batches of 100,
  so that is the end of its last batch with a signature: at most 99 past the
  last counter used, where every restore of these words still looks. Raising to
  the served end itself, as first written, put new ecash past the empty batches
  where every restore stops; the live multi-unit test found it. So a script in the page cannot collect the secrets of counters far ahead
  of the wallet and wait for what they later receive: the most it holds ahead of
  a keyset's counter is the next 1,000, by design, which is the window every
  restore of these words looks across. What remains: a script that walks typed
  words much further than the scan, during a restore the person started, moves
  the counters to 1,000 short of that, and ecash made after it is past a gap no
  restore crosses.
- **The keys a payment request locks ecash to come from the seed too**
  (`Foxy/Keychain/P2PK.swift`). NUT-13 standardises a path for
  them, `m/129373'/10'/0'/0'/{index}`, and **the last level is a normal BIP-32
  child, not a hardened one** — CDK derives the same path
  (`crates/cdk/src/wallet/p2pk.rs`). Before this the key was a fresh random one
  made in the page: fine until the phone is gone, at which point ecash locked to
  it is money nobody can ever move, with nothing in the twelve words to say it
  was there.

  Be honest about what the derived key buys. A restore cannot *find* ecash
  locked to one of these keys by walking anything: those proofs were minted by
  the payer, from the payer's own blinding factors, so NUT-09's restore never
  sees them. What it buys is that a token already **in hand** — one that arrived
  and was never claimed, one pasted in afterwards, one copied off a dead phone —
  opens from the twelve words on any device. The index is not needed either:
  `p2pkPubkeys` walks the path and the page compares each public key with the
  lock the token carries.

  The page never holds the private half. `foxy.req.lockkeys` keeps
  `{i, pub}` — the index and the public key that went into the request — and
  `p2pkKey` answers the private half when there is ecash in front of it to open,
  with the public key beside it so the page can check its row still matches
  (a row left behind by a seed that has since been replaced names a key this
  seed does not derive, and that comparison is the only thing that catches it).
  **The parent chain code never crosses the bridge**: a non-hardened child and
  its parent's chain code together give the parent, and the parent gives every
  index there will ever be. The index lives in its own file,
  `foxy-p2pk.json`, and goes aside with the counters when the seed changes
  (`STORAGE.md`).

  The window on `p2pkKey` is 1,000 past the last index reserved, or inside a range
  this app session's walk served — `RestoreWindow.beyond`'s own 1,000, so the two
  cannot drift. It is a weaker guard than the restore window and it is meant to
  be: a NUT-13 secret is money on its own, and a lock private key opens only
  proofs somebody has already locked to its public half.
- **The words are shown and typed on native screens**
  (`Foxy/Bridge/SeedScreens.swift`), in the page's wording. `seedShow` reads the
  words under the usual unlock and shows them behind TAP TO REVEAL, with VERIFY
  WORDS and the quiz, whose tiles are also behind TAP TO REVEAL and whose order
  is drawn from `SecRandomCopyBytes` for every quiz, never from the words; it answers only
  `verified`. `seedEnter` takes twelve typed or pasted words with capitals,
  autocorrection and suggestions of the keyboard's own off, suggests words from
  the list above the keyboard, flags words not on the list, and checks the
  checksum. It keeps a valid phrase natively under a random 128-bit id and
  answers only the id. At most two are held; they go when adopted or forgotten
  (`seedCandidateForget`), when the unlock is forgotten, the page goes or loads
  again, Foxy goes to the background, or the saved seed is written or deleted.
  The screens are iOS page sheets under a bar of system material with a lock and
  "On this iPhone · not the web page". They come one at a time: `seedShow` and
  `seedEnter` are refused ("a seed screen is already open") while one is queued
  or open, and `seedShow` is refused for ten seconds after a failed read ("try
  again in a moment"). A screen waits for any iOS alert before it opens, but an
  alert can still come over an open screen. The words are read on the seed
  queue, and a screen closes, with queued ones answered as cancelled, when the
  seed is written or deleted. The words are hidden, not blurred, while the screen
  is recorded or shared, and the restore screen also ends editing, disables its
  cells and empties its suggestion bar, so neither the bar nor the keyboard's key
  pop-ups show a word; a screenshot while
  one is open is logged and warned about with THAT SCREENSHOT SHOWS YOUR SEED. A
  screen closes when Foxy goes to the background or the page goes, so it is never
  found over the PIN lock on return.
- **The pasteboard.** RESTORE refuses a paste while the pasteboard still holds
  what Foxy last wrote (a copy for the page, the share sheet's Copy, or the web
  view's own copy), so a page cannot hand the person words it knows to restore.
  A phrase pasted there is cleared from the pasteboard, and the cells offer no
  copy, cut, share or drag. The `clipboard` action and the paste control never
  give the page text holding a BIP-39 phrase; they answer as an empty clipboard
  (`Foxy/Bridge/SeedPasteboard.swift`).
- **Changing the seed.** `seedAdopt` compares the typed words' BIP-39 seed with
  the saved one. The same seed writes nothing and answers `same`, and raises the
  counters to 1,000 short of where the words were served. Otherwise it asks "Replace this
  wallet's seed?" with "Only replace it with words you wrote down yourself.
  Whoever gave you these words can take everything this wallet receives.", and
  after a yes iOS asks for Face ID or the device passcode (a pasted lure can
  lead someone to tap an alert, not to give their passcode). A No, a cancel or no answer is "Nothing was changed.". A phone with
  no passcode has nothing to ask, and there the alert's yes stands. Then it
  writes the words with `SeedVault`'s rules, sets the counters aside to
  `foxy-counters.replaced.<unix time>.json`, and raises the new seed's counters
  to where the typed words were served. The adopted words are kept until
  `seedCandidateForget`, the background or the page going, so scans still
  running with them can finish; the write drops every other candidate. With
  no seed saved there is nothing to replace, and it writes without asking.
  `seedWipe` asks "Delete this wallet's seed?", then Face ID or the device
  passcode ("Delete this wallet's seed", as Replace does), then deletes the seed
  and checks
  each item is gone: one still there is "the seed could not be deleted", with
  the counters left where they are. Then it sets the counters aside, drops
  all typed words and makes a new seed. There is no delete that leaves no seed:
  that let a script delete the seed and write words of its own. A replace left
  without an answer for two minutes is a no, and its alert comes down. Each is
  one seed change at a time (a create, migrate, adopt or wipe), and the counters
  are set aside only after the keychain has changed.
- **A write whose read-back failed** (the phone locked just after Replace, say)
  is read again: if the keychain holds the new words it is a success, and the
  change finishes (the counters set aside, `adopted` or `created`). The kept
  seed is forgotten after any write attempt, so nothing derives from the old
  seed against the new counters. After any write or
  delete that succeeded, `FoxySeedChanged` is posted, and the seed screens close
  on it.
- **What it does not stop.** A script in the page can still reserve counters and
  receive their secrets, which is enough to spend outputs made from them, and
  can open the seed screens, whose read of the words needs Face ID or the
  passcode. `seedMigrate` answers only in its one-time window on an install
  that had page storage before this launch, so a script in a fresh install's
  page cannot hand it words it knows before the wallet makes its own; on an
  older install with no seed saved, a script already running there before its
  first launch of this version still could, once. `same` or
  `different` tells a script only whether a phrase it already has is the saved
  seed. It can hold the secrets of the next 1,000 counters of each keyset, the
  restore window, by design; it can push a counter at most 100 at a time, which
  a restore still looks across. It cannot read the words, replace a saved seed
  without the person's yes and passcode, lower a counter, reach past the restore
  window, reach another keyset's counters through a second id of the same
  derivation path, or import counters a second time.

Tested in `FoxyTests`: `CounterStoreTests` (never lower, an atomic reserve,
reserveAt refusing an issued range and one too far ahead, import taking the
larger and answering once, the alias ids reaching one entry, an old file merged,
256 keysets, raise, the flushed rename, moved aside, a store with no file or
folder), `CounterRulesTests` (slots, the caps and ceilings, the merge),
`SeedActionsTests` (every action with a stub vault: no words in any reply, the
alias ids, the caps, typed words raising counters and staying, `seedMigrate`
with its window closed, a declined replace, a wipe whose delete failed),
`SeedVaultTests` (the read and write rules, the unlock covering one read, a
failed read-back, a delete that left a seed), `SeedMigrationWindowTests`,
`NativeSeedTests` (every seed action runs with no switch, the input checks,
`seedMigrate`'s answers and that it never writes over a different seed, the
replies, the Replace alert's words, the restore window, typed words held
natively, the quiz and entry rules, one screen at a time), `BridgeTests` (the
page's word actions are unknown), `NUT13Tests` and `BIP39Tests`. Everything but
`NativeSeedTests`, `BridgeTests` and the bridge's range checks also runs on a
Mac with no simulator, `swift test --package-path tools/nativetests`, in
`tools/check-all.sh`, which `tools/hooks/pre-push` runs before every push. Smoke
checks 24, 29, 31, 32 and 33 hold the same rules in the source, including that
none of it is under `#if` and so all of it is in a Release build. The screens
themselves are checked by hand (`DEVICE-TESTS.md` §14).

## Moving an install to the native seed

- **Keychain seeds are read as they are.** `foxy.seed.v1`, `foxy.seed.v2` and
  the note `foxy.seed.v2.held` keep their names and rules; nothing native is
  converted.
- **The counter file starts empty.** An install from before the native counters, like a new
  one, has no `foxy-counters.json`. The store reads that as no counters, writes
  nothing on a read, and makes `Application Support` and the file on its first
  write, in a Release build as in a Debug one (`CounterStoreTests`). The page
  sends its `foxy.counter.v1` across with `countersImport` before it reserves.
- **Words left in the page's storage** move with `seedMigrate`, above: once,
  and only on an install that had page storage before this launch
  (`Foxy/Keychain/SeedMigrationWindow.swift`). A fresh install closes that window
  at its first launch, and a seed made or found saved closes it too, so a script
  in a new install's page cannot plant words it knows before the wallet makes
  its own. Closed, `seedMigrate` still answers `same` or `different` where a
  seed is saved, and never writes; with no seed saved it answers "no migration
  here".

`DEVICE-TESTS.md` §15 checks a funded wallet across the upgrade on a phone.

## The page's half

The page's side of the contract is written out at "the seed on the phone" in
`build/wallet/03-seed-counters-logs.js`, and changes with the page, not here. What
native relies on:

- **Boot** hands any words the page still holds to `seedMigrate` once, then asks
  `seedStatus`, and `seedCreate` on a fresh install. The page generates no words.
- **Counters are the phone's.** The page's `foxy.counter.v1` goes across once
  (`countersImport`). Reservations are `counterReserve` and `counterReserveAt`;
  the used-output skip and a restore's adoption move counters with
  `counterAdvance`, which never moves one down.
- **Restores** fetch with `restoreSecrets`, the wallet's own seed inside the
  window, and words typed into RESTORE are typed on the phone (`seedEnter`),
  scanned by their candidate and adopted with `seedAdopt`.
- **Screens.** BACKUP and its quiz are `seedShow`; a wipe is `seedWipe`.

## The counters

`Application Support/foxy-counters.json` (`STORAGE.md`) tracks, per keyset (per
derivation path for a `00` keyset), the next counter a secret is derived from,
so a restart never reuses one. It is written whole to a temporary file beside
it, flushed to the disk with `F_FULLFSYNC` and renamed over it, before any range
is handed out, so a power loss cannot bring back an older file whose ranges were
already given out. A counter never goes down, and moves
up only as far as the rules above allow.

**If the counter file is lost but the seed survives** (a backup restored to the
same phone brings the seed back, not the file), the next reservation reuses
counters the mint has already signed. The mint refuses, and the used-output skip
moves the keyset's counter on by 10, 50, then 100. A restore of this wallet's own
seed is served only up to 1,000 past the phone's counter, so on a lost file it
reaches 1,000; adopting what it found moves the counters on, and the next scan
reaches further. Words typed into RESTORE are served from 0 up to 20,000 counters
a keyset. Worth a look during the review.

## Summary for the auditor

| | |
|---|---|
| Entropy | `SecRandomCopyBytes`, 128 bits, in Swift — the wordlist pinned by its SHA-256 |
| Derivation | PBKDF2-SHA512 2048 (BIP39 standard), natively; NUT-13 secrets from it natively (HMAC-SHA256, or BIP-32 with libsecp256k1); nothing else |
| At rest | the iOS keychain, this device only. With Face ID on (`device`): item `foxy.seed.v2`, readable only with Face ID or the device passcode (`.userPresence`); the older `foxy.seed.v1` is moved into it and deleted on the first read. With it off (`none`: where a new install starts, and on a phone with no passcode): `foxy.seed.v1`, readable while the phone is unlocked, with no prompt. A seed the page still holds from before the keychain moves in once (`seedMigrate`), never over a saved one |
| In the page | never: the page gets the secrets of counters native reserved, or of a restore inside its window |
| Counters | `foxy-counters.json`, native: flushed and renamed, never lowered, capped moves, one entry per derivation path, imported once, set aside when the seed changes |
| Protection class | keychain: when unlocked, this device only; with Face ID on every read needs the person, with it off none does. Counter file: `completeUntilFirstUserAuthentication`. The web store (proofs, not the seed) is `completeUnlessOpen`: unreadable while the phone is locked, except a file WebKit already had open |
| In backups | keychain item: never (this device only). Counter file and web store: excluded from iCloud and iTunes backups |
| App-level lock | PIN (four digits minimum, stored attempt limit with a growing wait) and Face ID |
| Egress | none — Foxy's own seed screen only |
| Builds | the same in Debug and Release: no switch |

## Restoring Foxy's seed in another wallet

Checked against cashu.me, Nutshell and the NUT-13 test vectors.
The bundled `bip39.js` and `cashu-ts.js` pass all ten NUT-13 vectors, for both
keyset versions: `00` (BIP-32 paths) and `01` (HMAC-SHA256). Foxy's seeds are
twelve English words with no passphrase, as cashu.me and Nutshell use.

- **cashu.me** uses the same cashu-ts derivation and restores Foxy's balances
  on either keyset version.
- **Nutshell 0.20.0 or later** is needed for mints with `01` keysets.
  Nutshell 0.18.2 derives only with BIP-32 paths and restores nothing on such a
  mint (tested: 0 sats on testnut.cashu.space, where Foxy restored 98).
- **Nutshell's restore gives up sooner.** By default it stops after two empty
  batches of 25 counters, so a gap of 50; Foxy looks across 1,000 per keyset.
  A Foxy history with a long run of reserved but unsigned counters — failed or
  retried swaps — needs the wider search:
  `cashu restore --to 10 --batch 100`.
- **P2PK keys come from these words.** Foxy's own earlier key scheme was
  removed. A payment request carries a fresh P2PK key, and that key used to be
  random and live in `foxy.req.lockkeys` on one device only — ecash waiting in
  `foxy.req.unclaimed` when a phone was lost could not be spent by a restored
  wallet, and it was the one kind of money in Foxy the words did not reach.
  The phone now derives it at NUT-13's P2PK path, `m/129373'/10'/0'/0'/{index}`,
  so a token already in hand opens on any phone holding these words — by index
  when the row survives, and by walking the path when it does not.

  Two things this does **not** do. A restore cannot *find* P2PK-locked ecash:
  those proofs were minted from the payer's blinding factors, so NUT-09's
  restore will never see them — the words open a token you already have, they do
  not go looking. And rows written by an earlier version still hold a random key,
  which has no index to convert it to; they go on working on the phone that
  made them and nowhere else. Imported proofs remain outside the words entirely.

How Foxy keeps restores safe:

- **Counters only move forward.** Adopting a scan never lowers a counter,
  and counters move even for keysets whose proofs were all spent.
- **Old counters stay with their seed.** Restoring different words sets the
  old seed's counters aside instead of carrying them into the new one.
- **A partial scan never replaces a pile.** A scan where a keyset did not
  answer is marked partial and adds to the pile, and can be retried. An
  overwrite never drops proofs these words cannot rebuild: imported proofs,
  or any from a replaced seed.
- **"Outputs have already been signed" is recovered.** Foxy moves the output
  keyset's counter on by 10 and tries a mint, swap or receive again; then by
  50, then by 100, before giving up (`COUNTER_SKIPS`). A budget of 160 per
  keyset per session (`SKIP_BUDGET`) keeps every skip inside the 1,000 empty
  counters a restore walks past. A melt only moves the counter on, by 10.
- **Restores walk each keyset in batches of 100.** Each batch has its own
  deadline and three tries. Ten empty batches in a row (`RESTORE_GAP`, 1,000
  counters) end the walk; a swap can burn sixty counters at a go, so three would
  not cross the gap. A batch that fails all three tries marks the scan partial, and
  what was found before it is kept. Over Tor, one slow answer used to cost the
  whole keyset.
- **One counter store for every wallet object.** Every seeded wallet object
  reserves counters from the same stored source, as cashu.me does. Before, each
  had its own copy and wrote back its own number, so two could hand out the same
  counters, which is the usual cause of "outputs have already been signed".
