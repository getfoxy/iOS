import Foundation

/// What the seed and counter actions need from the phone. `live` is the app's:
/// SeedVault's keychain, the counter file, the typed words and the migration
/// window. FoxyTests and tools/nativetests run the same actions with a vault of
/// their own, so every reply can be checked for words (review L12).
struct SeedEnvironment {
    /// SeedVault.seedForSecrets: the saved seed, under its unlock and prompt.
    var savedSeed: () -> SeedVault.SecretsSeed
    /* Whether a seed is there, without reading it and without asking the
     * person for anything: true, false, or nil when the keychain would not
     * say. The launch uses this; reading is for when the secret is wanted. */
    var seedPresent: () -> Bool? = { SeedVault.seedIsThere() }
    /// SeedVault.write: nil when written. `confirmReplace` is asked only when a
    /// different seed is saved and `replace` is true.
    var write: (_ words: String, _ replace: Bool, _ keepCandidate: String?, _ confirmReplace: () -> Bool) -> String?
    /// SeedVault.delete: true only when no seed is left.
    var delete: () -> Bool
    var counters: CounterStore
    var candidates: SeedCandidates
    var wordlist: () -> [String]?
    var generate: (_ wordlist: [String]) throws -> String
    var migrationWindowOpen: () -> Bool
    var closeMigrationWindow: (_ why: String) -> Void
    /// Where countersImport records that it has answered.
    var defaults: UserDefaults
    /// SeedVault.passcodeSet. A phone with no passcode has no Face ID or passcode
    /// to ask before a replace or delete, so it goes ahead on the alert, and the
    /// page warns (a deliberate decision).
    var passcodeSet: () -> Bool = { true }
    /// What the person asked to stand in front of the seed (SeedVault.protection).
    var protection: () -> SeedVault.Protection = { SeedVault.protection }
    /// SeedVault.setProtection: nil when the seed is where the mode says.
    var setProtection: (_ mode: SeedVault.Protection) -> String? = { SeedVault.setProtection($0) }

    static let live = SeedEnvironment(
        savedSeed: { SeedVault.seedForSecrets() },
        write: { words, replace, keep, confirm in
            SeedVault.write(words, replace: replace, keepCandidate: keep, confirmReplace: confirm)
        },
        delete: { SeedVault.delete() },
        counters: .shared,
        candidates: .shared,
        wordlist: { BIP39.english },
        generate: { try BIP39.generate(wordlist: $0) },
        migrationWindowOpen: { SeedMigrationWindow.isOpen },
        closeMigrationWindow: { SeedMigrationWindow.close($0) },
        defaults: .standard,
        passcodeSet: { SeedVault.passcodeSet })
}

/// An action's answer to the page: JSON text, or a plain error. Never both.
struct SeedReply: Equatable {
    let text: String?
    let error: String?

    static func answer(_ text: String) -> SeedReply { SeedReply(text: text, error: nil) }
    static func refuse(_ error: String) -> SeedReply { SeedReply(text: nil, error: error) }
}

/// The seed and counter actions (THREAT-MODEL.md §1, SEED-HANDLING.md) after
/// their input checks, apart from the bridge. NativeSeedBridge.swift runs each on
/// seedQueue with `SeedEnvironment.live`. A reply is one of the agreed JSON
/// objects, NUT13.reply, or a fixed message: no words, and no seed, ever.
enum SeedActions {
    /// A keyset's counters: `start` is unused by counterReserve.
    struct CounterRequest: Equatable {
        /// Lowercase, so "00AB…" and "00ab…" are one keyset's counters, not two.
        let keysetId: String
        let version: UInt8
        let start: UInt64
        let count: Int
    }

    struct RestoreRequest: Equatable {
        let range: CounterRequest
        let candidate: String?
    }

    struct AdvanceRequest: Equatable {
        let keysetId: String
        let next: UInt64
    }

    /// p2pkPubkeys' range of lock-key indices.
    struct P2PKRange: Equatable {
        let start: UInt64
        let count: Int
    }

    /// A refusal that is its own message.
    struct Refusal: Error {
        let message: String
    }

    // MARK: Replies

    /// A JSON object as text, keys sorted.
    static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    static func countersReply(_ counters: [String: UInt64]) -> String {
        json(["counters": counters.mapValues { NSNumber(value: $0) }])
    }

    static func problem(_ error: Error) -> String {
        switch error {
        case let refusal as Refusal:
            return refusal.message
        case let failure as CounterStore.Failure:
            return failure.message
        case let failure as SeedCandidates.Failure:
            switch failure {
            case .unknown: return "unknown candidate"
            case .outsideWindow: return "outside the restore window"
            case .full: return "too many candidates"
            case .tooManyKeysets: return CounterStore.Failure.tooManyKeysets.message
            case .notAPhrase, .platform: return "the words could not be read"
            }
        // An index no window reaches, and one past 2^31, are the same answer:
        // not a lock key you may have now. The bridge refuses the second before
        // it gets here, so this is belt and braces.
        case P2PK.Failure.badIndex:
            return "outside the lock-key window"
        default:
            // NUT13: an invalid BIP-32 child or r = 0, about 1 in 2^127, never a different key instead
            return "the secrets could not be derived"
        }
    }

    /// The saved seed for derivation. On seedQueue.
    static func readSavedSeed(_ env: SeedEnvironment) throws -> NUT13.Seed {
        switch env.savedSeed() {
        case .found(let seed): return seed
        case .absent: throw Refusal(message: "no seed")
        case .failed: throw Refusal(message: "the seed could not be read")
        }
    }

    // MARK: Seed status and creation

    /// seedStatus { quiet } → {"exists": true|false}.
    ///
    /// Quiet answers from the keychain's own record that an item is there,
    /// which asks the person for nothing. Otherwise it reads the seed, which
    /// is Face ID or the passcode — the page uses that deliberately, once per
    /// visit, to have the seed ready (FoxyWallet.openSeedForVisit).
    ///
    /// The launch asks quietly now: a fresh install with no money was made to
    /// show a Face ID prompt before it had anything to protect.
    static func status(_ env: SeedEnvironment, quiet: Bool = false) -> SeedReply {
        let noPasscodeQuiet = !env.passcodeSet()
        if quiet {
            switch env.seedPresent() {
            case .some(true):
                env.closeMigrationWindow("a seed is saved")
                return .answer(json(noPasscodeQuiet ? ["exists": true, "passcode": false] : ["exists": true]))
            case .some(false):
                return .answer(json(noPasscodeQuiet ? ["exists": false, "passcode": false] : ["exists": false]))
            case .none:
                return .refuse("the seed could not be read")
            }
        }
        return statusByReading(env)
    }

    private static func statusByReading(_ env: SeedEnvironment) -> SeedReply {
        // "passcode": false only when there is none, so the answer on a phone with
        // one is unchanged
        let noPasscode = !env.passcodeSet()
        switch env.savedSeed() {
        case .found:
            env.closeMigrationWindow("a seed is saved")
            return .answer(json(noPasscode ? ["exists": true, "passcode": false] : ["exists": true]))
        case .absent:
            return .answer(json(noPasscode ? ["exists": false, "passcode": false] : ["exists": false]))
        case .failed:
            return .refuse("the seed could not be read")
        }
    }

    /// seedCreate {} → {"created": true}, or "a seed already exists". Twelve
    /// words made here, where no seed is saved, and written with SeedVault's
    /// rules, which never replace a saved seed.
    static func create(_ env: SeedEnvironment) -> SeedReply {
        switch env.savedSeed() {
        case .found: return .refuse("a seed already exists")
        case .failed: return .refuse("the seed could not be read")
        case .absent: break
        }
        guard let wordlist = env.wordlist() else { return .refuse("the wordlist could not be checked") }
        // Counters with no seed beside them belong to a seed that is gone. The
        // new seed starts from zero, where another wallet's restore looks.
        if (try? env.counters.snapshot())?.isEmpty != true {
            do {
                try env.counters.moveAside()
            } catch {
                return .refuse(problem(error))
            }
        }
        let words: String
        do {
            words = try env.generate(wordlist)
        } catch {
            return .refuse("the seed could not be made")
        }
        if let problem = env.write(words, false, nil, { false }) { return .refuse(problem) }
        print("[foxy] seed: made on the phone and saved")
        env.closeMigrationWindow("a seed was made on the phone")
        return .answer(json(["created": true]))
    }

    // MARK: Moving words the page still holds

    /// The decision, apart from the keychain: a different saved seed is never
    /// written over, a saved seed is compared whether the window is open or not,
    /// and words are written only where the window is open and no seed is saved.
    /// `write` is SeedVault.write with replace false. On seedQueue.
    static func decideMigration(_ phrase: String, windowOpen: Bool, saved: SeedVault.SecretsSeed,
                                write: (String) -> String?) -> SeedMigrationWindow.Outcome {
        let compared: SeedMigrationWindow.Saved
        switch saved {
        case .failed:
            compared = .failed
        case .absent:
            compared = .absent
        case .found(let seed):
            // compared as BIP-39 seeds, as seedAdopt compares: the seed is what the money is under
            guard let typed = try? NUT13.seed(mnemonic: phrase) else { return .refused("the words could not be read") }
            compared = .found(same: seed.sameBytes(as: typed))
        }
        switch SeedMigrationWindow.step(open: windowOpen, saved: compared) {
        case .answer(let outcome):
            if outcome == .different {
                print("[foxy] seed migrate: the page held words of a different seed than the saved one; nothing was changed")
            }
            return outcome
        case .write:
            guard let problem = write(phrase) else { return .migrated }
            // A seed saved between the read and the write: SeedVault.write reads
            // again and refuses to replace it. Still the different-seed answer.
            if problem.hasPrefix("A different seed") {
                print("[foxy] seed migrate: a different seed was saved meanwhile; nothing was changed")
                return .different
            }
            return .refused(problem)
        }
    }

    static func migrateReply(_ outcome: SeedMigrationWindow.Outcome) -> SeedReply {
        switch outcome {
        case .migrated: return .answer(json(["migrated": true]))
        case .same: return .answer(json(["migrated": false, "same": true]))
        case .different: return .answer(json(["migrated": false, "different": true]))
        case .refused(let why): return .refuse(why)
        }
    }

    /// seedMigrate {words}, checked → migrated, same or different; "no migration
    /// here" only with the window closed and no seed saved. The words live in
    /// this request only. The counters are left alone.
    static func migrate(_ phrase: String, env: SeedEnvironment) -> SeedReply {
        let outcome = decideMigration(phrase, windowOpen: env.migrationWindowOpen(), saved: env.savedSeed()) { words in
            env.write(words, false, nil, { false })
        }
        if outcome == .migrated { print("[foxy] seed migrate: the page's old words are now the saved seed") }
        if SeedMigrationWindow.closes(after: outcome) { env.closeMigrationWindow("seedMigrate answered") }
        return migrateReply(outcome)
    }

    // MARK: Counters

    /// countersImport {counters} → {"counters": {...}}, once per install.
    static func countersImport(_ incoming: [String: UInt64], env: SeedEnvironment) -> SeedReply {
        do {
            return .answer(countersReply(try env.counters.importOnce(incoming, defaults: env.defaults)))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// counterSnapshot {} → {"counters": {...}}.
    static func counterSnapshot(_ env: SeedEnvironment) -> SeedReply {
        do {
            return .answer(countersReply(try env.counters.snapshot()))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// counterAdvance {keysetId, next} → {"keysetId", "next"}: the value now stored.
    static func counterAdvance(_ request: AdvanceRequest, env: SeedEnvironment) -> SeedReply {
        do {
            let stored = try env.counters.advance(request.keysetId, to: request.next)
            return .answer(json(["keysetId": request.keysetId, "next": NSNumber(value: stored)]))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// counterReserve {keysetId, count}: `next ..< next + count`, reserved first.
    static func counterReserve(_ request: CounterRequest, env: SeedEnvironment) -> SeedReply {
        do {
            guard request.count > 0 else {
                // a peek: no seed read, nothing moved
                let next = try env.counters.reserve(request.keysetId, version: request.version, count: 0)
                return .answer(NUT13.reply(keysetId: request.keysetId, start: next, pairs: []))
            }
            // the seed before the counters: without one, none are used up
            let seed = try readSavedSeed(env)
            let start = try env.counters.reserve(request.keysetId, version: request.version, count: request.count)
            let pairs = try NUT13.derive(seed: seed, keysetId: request.keysetId, start: start, count: request.count)
            return .answer(NUT13.reply(keysetId: request.keysetId, start: start, pairs: pairs))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// counterReserveAt {keysetId, start, count}: exactly that range; the counters
    /// below it are burnt. Below next is "range already issued"; more than 100 past
    /// it is "too far ahead". Both are refused before any Face ID prompt.
    static func counterReserveAt(_ request: CounterRequest, env: SeedEnvironment) -> SeedReply {
        do {
            let current = try env.counters.next(request.keysetId)
            guard current <= request.start else { throw CounterStore.Failure.alreadyIssued }
            guard CounterRules.reserveAt(current: current, start: request.start) == .allowed else {
                throw CounterStore.Failure.tooFarAhead
            }
            let seed = try readSavedSeed(env)
            try env.counters.reserve(request.keysetId, version: request.version, at: request.start, count: request.count)
            let pairs = try NUT13.derive(seed: seed, keysetId: request.keysetId, start: request.start, count: request.count)
            return .answer(NUT13.reply(keysetId: request.keysetId, start: request.start, pairs: pairs))
        } catch {
            return .refuse(problem(error))
        }
    }

    // MARK: Restore

    /// restoreSecrets {keysetId, start, count, candidate?}: counters unchanged.
    /// The saved seed only inside RestoreWindow; a candidate's words from 0,
    /// contiguously, up to 20,000 per derivation path. Each range handed out is
    /// noted for its counter entry: counterAdvance may move the counter to it.
    static func restoreSecrets(_ request: RestoreRequest, env: SeedEnvironment) -> SeedReply {
        let range = request.range
        do {
            let seed: NUT13.Seed
            if let candidate = request.candidate {
                seed = try env.candidates.serve(candidate, keysetId: range.keysetId, start: range.start, count: range.count)
            } else {
                let next = try env.counters.next(range.keysetId)
                guard RestoreWindow.savedSeedAllowed(start: range.start, count: range.count, next: next) else {
                    throw Refusal(message: "outside the restore window")
                }
                seed = try readSavedSeed(env)
            }
            let pairs = try NUT13.derive(seed: seed, keysetId: range.keysetId, start: range.start, count: range.count)
            env.counters.noteServed(range.keysetId, end: range.start + UInt64(range.count))
            return .answer(NUT13.reply(keysetId: range.keysetId, start: range.start, pairs: pairs))
        } catch {
            return .refuse(problem(error))
        }
    }

    // MARK: The keys a payment request locks ecash to (P2PK.swift)

    /// p2pkReserve {count} → {"start", "next", "pubkeys"}: the public keys for
    /// `next ..< next + count`, which is reserved first. A count of 0 is a peek,
    /// with no seed read and nothing moved.
    ///
    /// Only the public halves come back. The private half of one index is
    /// p2pkKey's answer, asked for when there is ecash to open, so a page that
    /// primes a pool of locks is not also holding the keys that open them.
    static func p2pkReserve(count: Int, env: SeedEnvironment) -> SeedReply {
        do {
            guard count > 0 else {
                let next = try env.counters.p2pkReserve(count: 0)
                return .answer(P2PK.pubkeysReply(start: next, next: next, pubkeys: []))
            }
            // the seed before the index: without one, no index is used up
            let seed = try readSavedSeed(env)
            let start = try env.counters.p2pkReserve(count: count)
            let keys = try P2PK.publicKeys(seed: seed, start: start, count: count)
            return .answer(P2PK.pubkeysReply(start: start, next: start + UInt64(count), pubkeys: keys))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// p2pkPubkeys {start, count} → the same shape, moving nothing.
    ///
    /// This is the restore: a token in hand is locked to a public key, and
    /// nothing on this phone says which index derived it — the row that knew was
    /// in the old phone's storage. The page walks the path and compares. Each
    /// range is noted, so p2pkKey will answer for an index inside it.
    ///
    /// It needs no index file and must not be stopped by one. Reserving on a file
    /// that cannot be read is rightly refused — starting again from 0 would
    /// derive keys this phone has already put in requests — but this reads
    /// nothing and moves nothing, and refusing it over a damaged one-number file
    /// would make every P2PK-locked token in hand unopenable, for good, with no
    /// way out of the app (review finding). `next` is told for information;
    /// unreadable, it is told as 0.
    static func p2pkPubkeys(_ range: P2PKRange, env: SeedEnvironment) -> SeedReply {
        do {
            let seed = try readSavedSeed(env)
            let keys = try P2PK.publicKeys(seed: seed, start: range.start, count: range.count)
            let next = (try? env.counters.p2pkNext()) ?? 0
            env.counters.noteP2PKServed(end: range.start + UInt64(range.count))
            return .answer(P2PK.pubkeysReply(start: range.start, next: next, pubkeys: keys))
        } catch {
            return .refuse(problem(error))
        }
    }

    /// p2pkKey {index} → {"index", "privkey", "pubkey"}: the private half, for
    /// an index inside the window (P2PK.keyAllowed).
    ///
    /// The public key goes back with it so the page can check the key it is about
    /// to spend with against the one its row kept. A row written under a seed
    /// that has since been replaced names a public key this seed does not derive,
    /// and that comparison is the only thing that catches it — the index alone
    /// says nothing about which seed it belonged to.
    static func p2pkKey(index: UInt64, env: SeedEnvironment) -> SeedReply {
        do {
            /* The window a scan opened is memory's, and needs no file.
             *
             * Asked in that order on purpose. An index a scan has already walked
             * to is answered whether the index file can be read or not; reading
             * the file first made a damaged one-number file the end of every
             * P2PK-locked token in hand, for good, with the scan that found the
             * key having worked perfectly (review finding). The other half
             * of the window — "near what has been reserved" — is what the file
             * is the only record of, so that half still needs it, and a file
             * that cannot be read still refuses there.
             *
             * `index` past the last normal child is refused either way:
             * `keyAllowed` says no, and `P2PK.derive` would throw `.badIndex`. */
            let served = env.counters.highestP2PKServed()
            if !P2PK.keyAllowed(index: index, next: 0, served: served) {
                let next = try env.counters.p2pkNext()
                guard P2PK.keyAllowed(index: index, next: next, served: served) else {
                    throw Refusal(message: "outside the lock-key window")
                }
            }
            let seed = try readSavedSeed(env)
            var pair = try P2PK.key(seed: seed, index: index)
            defer { pair.wipe() }
            return .answer(P2PK.keyReply(pair))
        } catch {
            return .refuse(problem(error))
        }
    }

    // MARK: Adopting typed words, and wiping

    /// seedAdopt {candidate} → {"adopted": false, "same": true} for the saved
    /// seed's words; otherwise, where a different seed is saved, `confirmReplace`
    /// (the Replace alert, then Face ID or the passcode), then {"adopted": true}
    /// or "Nothing was changed.".
    ///
    /// Either way each counter is raised to at least 300 short of the end the
    /// typed words were served for its keyset (review M2). A scan
    /// ends with three empty batches of 100, so that is the end of the last batch
    /// that held a signature: at most 99 past the last counter used, inside every
    /// restore's reach. Raising to the served end itself put the next ecash past
    /// the three empty batches where every restore stops (found by the live
    /// multi-unit test). A script that walked the words further than
    /// the scan still holds no more than the 300 counters past the raised one. The
    /// candidate is kept: scans still running with it can finish (M6).
    static func adopt(_ candidate: String, env: SeedEnvironment, confirmReplace: () -> Bool) -> SeedReply {
        guard let words = env.candidates.phrase(candidate),
              let typed = try? env.candidates.seed(candidate) else {
            return .refuse("unknown candidate")
        }
        let served = RestoreWindow.adoptedCounters(env.candidates.servedEnds(candidate))
        switch env.savedSeed() {
        case .failed:
            return .refuse("the seed could not be read")
        case .found(let saved) where saved.sameBytes(as: typed):
            do {
                _ = try env.counters.raise(served)
            } catch {
                return .refuse(problem(error))
            }
            return .answer(json(["adopted": false, "same": true]))
        case .found, .absent:
            break
        }
        // SeedVault.write asks only when a different seed is saved, and a page
        // script can ask for this, not answer it.
        var declined = false
        let written = env.write(words, true, candidate) {
            let yes = confirmReplace()
            declined = !yes
            return yes
        }
        if declined { return .refuse("Nothing was changed.") }
        if let written { return .refuse(written) }
        env.closeMigrationWindow("typed words were adopted")
        do {
            try env.counters.moveAside()
        } catch {
            return .refuse("the seed was replaced, but its counters could not be set aside")
        }
        do {
            _ = try env.counters.raise(served)
        } catch {
            return .refuse("the seed was replaced, but its counters could not be raised")
        }
        print("[foxy] seed: replaced by typed words; the old counters set aside, the new ones raised to what was served")
        return .answer(json(["adopted": true]))
    }

    /// seedCandidateForget {candidate} → {"forgotten": true}, known or not.
    static func candidateForget(_ candidate: String, env: SeedEnvironment) -> SeedReply {
        env.candidates.forget(candidate)
        return .answer(json(["forgotten": true]))
    }

    /// seedWipe, after the yes: the seed deleted, and checked gone, then its
    /// counters set aside, every candidate dropped and a new seed made.
    // MARK: What stands in front of the seed

    /// seedProtection {} → {"mode": "device"|"none", "passcode": true|false}.
    /// Asks the person for nothing.
    static func protection(_ env: SeedEnvironment) -> SeedReply {
        .answer(json(["mode": env.protection().rawValue, "passcode": env.passcodeSet()]))
    }

    /// seedProtect { mode } → {"mode": …}. The SECURE FOXY card's answer.
    static func setProtection(_ env: SeedEnvironment, mode raw: String) -> SeedReply {
        guard let mode = SeedVault.Protection(rawValue: raw) else {
            return .refuse("that is not a way to keep the seed")
        }
        if let problem = env.setProtection(mode) { return .refuse(problem) }
        return .answer(json(["mode": env.protection().rawValue]))
    }

    static func wipe(_ env: SeedEnvironment) -> SeedReply {
        // the seed items and note, the kept seed and the candidates
        guard env.delete() else { return .refuse("the seed could not be deleted") }
        env.candidates.forgetAll()
        do {
            try env.counters.moveAside()
        } catch {
            return .refuse("the seed was deleted, but its counters could not be set aside")
        }
        let made = create(env)
        if let error = made.error {
            return .refuse("the seed was deleted, but a new one was not made: \(error)")
        }
        return .answer(json(["wiped": true, "created": true]))
    }
}
