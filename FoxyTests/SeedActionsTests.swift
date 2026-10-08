import XCTest
import Security
import CryptoKit
@testable import Foxy

/// Every seed and counter action, run with a stub vault holding a known phrase:
/// their rules end to end (review: H1, M1, M2, M4, M6, M8, L5), and
/// that no reply text or error ever holds a word of the phrase or the seed
/// (L12). seedShow and seedEnter answer only `verified` and a candidate id and
/// draw screens, so they are FoxyTests' NativeSeedTests and the device tests'.
/// Runs in FoxyTests and in tools/nativetests.
final class SeedActionsTests: XCTestCase {
    private let saved = "legal winner thank year wave sausage worth useful legal winner thank yellow"
    private let made = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"
    private let typedOther = "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic"
    private let v00 = "009a1f293253e41e"
    private let v01 = "01" + String(repeating: "ab", count: 32)
    private let abandonAbout = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    /// A card's compressed public key (secp256k1's generator), as the page gives it and as bytes.
    private let cardKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    private var cardKeyBytes: [UInt8] { (try? NUT13.bytes(hex: cardKey)) ?? [] }

    private var folder: URL!
    private var suite: String!
    private var vault: StubVault!
    private var env: SeedEnvironment!
    /// Every reply any test here saw.
    private var replies: [SeedReply] = []

    /// The keychain as SeedVault's rules treat it, in memory.
    final class StubVault {
        var words: String?
        var failRead = false
        var deleteSucceeds = true
        var writeProblem: String?
        var writes: [String] = []
        var confirms = 0
        var windowOpen = true
        var windowClosedBy: [String] = []
        /// How many times the seed was asked for.
        var reads = 0

        func savedSeed() -> SeedVault.SecretsSeed {
            reads += 1
            if failRead { return .failed }
            guard let words else { return .absent }
            guard let seed = try? NUT13.seed(mnemonic: words) else { return .failed }
            return .found(seed)
        }
    }

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("seed-actions-" + UUID().uuidString)
        suite = "foxy.tests.actions.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let wordlist = BIP39.wordlist(try Data(contentsOf: repoRoot().appendingPathComponent("Foxy/Keychain/bip39-english.txt")))
        let vault = StubVault()
        vault.words = saved
        self.vault = vault
        let candidates = SeedCandidates()
        let madePhrase = made
        env = SeedEnvironment(
            savedSeed: { vault.savedSeed() },
            write: { words, replace, keep, confirm in
                // SeedVault.write's rules (writeStep), against the stub
                if vault.failRead { return "The keychain did not answer (status -25308), so nothing was written." }
                if let current = vault.words, current != words {
                    guard replace else { return "A different seed is already saved on this phone. Foxy did not replace it." }
                    vault.confirms += 1
                    guard confirm() else { return "The saved seed was not replaced." }
                }
                if let problem = vault.writeProblem { return problem }
                vault.words = words
                vault.writes.append(words)
                candidates.forgetAll(except: keep)
                return nil
            },
            delete: {
                guard vault.deleteSucceeds else { return false }
                vault.words = nil
                return true
            },
            counters: CounterStore(directory: folder),
            candidates: candidates,
            wordlist: { wordlist },
            generate: { _ in madePhrase },
            migrationWindowOpen: { vault.windowOpen },
            closeMigrationWindow: { why in
                vault.windowOpen = false
                vault.windowClosedBy.append(why)
            },
            defaults: defaults)
        replies = []
    }

    override func tearDownWithError() throws {
        // L12: whatever the test did, no reply held a word or the seed
        assertNoWords(in: replies)
        try? FileManager.default.removeItem(at: folder)
        UserDefaults().removePersistentDomain(forName: suite)
    }

    @discardableResult
    private func run(_ reply: SeedReply, file: StaticString = #filePath, line: UInt = #line) -> SeedReply {
        replies.append(reply)
        XCTAssertTrue((reply.text == nil) != (reply.error == nil), "an answer or an error, never both", file: file, line: line)
        return reply
    }

    private func range(_ id: String, _ start: UInt64, _ count: Int) -> SeedActions.CounterRequest {
        SeedActions.CounterRequest(keysetId: id, version: NUT13.keysetVersion(id) ?? 9, start: start, count: count)
    }

    private func parsed(_ reply: SeedReply) -> [String: Any] {
        guard let text = reply.text, let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            return [:]
        }
        return object
    }

    private func assertNoWords(in replies: [SeedReply], file: StaticString = #filePath, line: UInt = #line) {
        var secrets = Set<String>()
        for phrase in [saved, made, typedOther, abandonAbout] {
            phrase.split(separator: " ").forEach { secrets.insert(String($0)) }
        }
        var seeds: [String] = []
        for phrase in [saved, made, typedOther, abandonAbout] {
            if let seed = try? NUT13.seed(mnemonic: phrase) {
                seeds.append(seed.key.withUnsafeBytes { NUT13.hex(Array($0)) })
            }
        }
        for reply in replies {
            for text in [reply.text, reply.error].compactMap({ $0 }) {
                let lower = text.lowercased()
                let tokens = Set(lower.split(whereSeparator: { !$0.isLetter }).map(String.init))
                for word in secrets where tokens.contains(word) {
                    XCTFail("a reply holds the word \"\(word)\": \(text)", file: file, line: line)
                }
                for seed in seeds where lower.contains(seed) || lower.contains(String(seed.prefix(32))) || lower.contains(String(seed.suffix(32))) {
                    XCTFail("a reply holds seed bytes: \(text)", file: file, line: line)
                }
            }
        }
    }

    // MARK: No words, anywhere (L12)

    func testEveryActionAnswersWithoutTheWordsOrTheSeed() throws {
        let counters = env.counters
        let candidates = env.candidates
        // status, create, migrate in each state
        run(SeedActions.status(env))
        run(SeedActions.create(env))
        run(SeedActions.migrate(saved, env: env))
        run(SeedActions.migrate(typedOther, env: env))
        vault.failRead = true
        run(SeedActions.status(env))
        run(SeedActions.create(env))
        run(SeedActions.migrate(saved, env: env))
        run(SeedActions.counterReserve(range(v00, 0, 3), env: env))
        vault.failRead = false
        // counters
        run(SeedActions.countersImport([v00: 5, v01: 2], env: env))
        run(SeedActions.countersImport([v00: 6], env: env))
        run(SeedActions.counterSnapshot(env))
        run(SeedActions.counterAdvance(.init(keysetId: v00, next: 20), env: env))
        run(SeedActions.counterAdvance(.init(keysetId: v00, next: 90_000), env: env))
        run(SeedActions.counterReserve(range(v00, 0, 0), env: env))
        run(SeedActions.counterReserve(range(v00, 0, 4), env: env))
        run(SeedActions.counterReserve(range(v01, 0, 4), env: env))
        run(SeedActions.counterReserveAt(range(v00, 0, 2), env: env))
        run(SeedActions.counterReserveAt(range(v00, 30, 2), env: env))
        run(SeedActions.counterReserveAt(range(v00, 9_000, 2), env: env))
        // restores
        run(SeedActions.restoreSecrets(.init(range: range(v00, 0, 50), candidate: nil), env: env))
        run(SeedActions.restoreSecrets(.init(range: range(v00, 5_000, 1), candidate: nil), env: env))
        let other = try candidates.add(typedOther)
        let same = try candidates.add(saved)
        run(SeedActions.restoreSecrets(.init(range: range(v00, 0, 100), candidate: other), env: env))
        run(SeedActions.restoreSecrets(.init(range: range(v00, 900, 1), candidate: other), env: env))
        run(SeedActions.restoreSecrets(.init(range: range(v01, 0, 10), candidate: same), env: env))
        run(SeedActions.restoreSecrets(.init(range: range(v00, 0, 1), candidate: "0123456789abcdef0123456789abcdef"), env: env))
        // the keys a payment request locks ecash to
        run(SeedActions.p2pkReserve(count: 0, env: env))
        run(SeedActions.p2pkReserve(count: 8, env: env))
        run(SeedActions.p2pkPubkeys(.init(start: 0, count: 300), env: env))
        run(SeedActions.p2pkKey(index: 0, env: env))
        run(SeedActions.p2pkKey(index: 19_999, env: env))
        run(SeedActions.p2pkKey(index: 1_000_000, env: env))
        // a card's owner key and its signatures, and what they refuse
        run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env))
        run(SeedActions.cardOwnerKey(key: [0x04] + cardKeyBytes.dropFirst(), env: env))
        run(SeedActions.cardOwnerKey(key: [], env: env))
        for label in CardOwner.Label.allCases {
            run(SeedActions.cardOwnerSign(sampleRequest(label), env: env))
        }
        run(SeedActions.cardOwnerSign(.init(key: cardKeyBytes, label: .setLimit, nonce: nonceBytes, value: [1, 2, 3]), env: env))
        // adopt: the saved words, declined, unknown, replaced
        run(SeedActions.adopt(same, env: env) { false })
        run(SeedActions.adopt(other, env: env) { false })
        run(SeedActions.adopt("0123456789abcdef0123456789abcdef", env: env) { true })
        run(SeedActions.adopt(other, env: env) { true })
        run(SeedActions.candidateForget(other, env: env))
        // wipe, failing and working
        vault.deleteSucceeds = false
        run(SeedActions.wipe(env))
        vault.deleteSucceeds = true
        run(SeedActions.wipe(env))
        // with no seed at all
        vault.words = nil
        vault.windowOpen = false
        run(SeedActions.migrate(saved, env: env))
        run(SeedActions.status(env))
        run(SeedActions.counterReserve(range(v00, 0, 1), env: env))
        run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env))
        run(SeedActions.cardOwnerSign(sampleRequest(.load), env: env))
        _ = counters
        XCTAssertGreaterThanOrEqual(replies.count, 35)
        XCTAssertTrue(replies.contains { $0.text?.contains("\"secrets\":[\"") == true }, "secrets were answered, and checked")
        // the fixed messages of SeedVault and its read rules, too
        let messages = [
            SeedVault.writeStep(current: .failed("x"), words: saved, replace: true),
            SeedVault.writeStep(current: .found(made), words: saved, replace: false),
        ].compactMap { step -> String? in if case .refuse(let why) = step { return why }; return nil }
            + [SeedVault.hiddenBehindPasscode, SeedVault.describe(errSecUserCanceled), SeedVault.describe(-1)]
        replies += messages.map { SeedReply.refuse($0) }
    }

    // MARK: H1: a second id of one derivation path

    func testAnAliasReachesTheRealKeysetsCounterAndBurnsIt() throws {
        let aliases = CounterRulesTests.aliases
        run(SeedActions.counterReserve(range(aliases[0], 0, 40), env: env))
        for alias in aliases.dropFirst() {
            XCTAssertEqual(run(SeedActions.counterReserveAt(range(alias, 0, 10), env: env)).error, "range already issued", alias)
            XCTAssertEqual(run(SeedActions.counterReserveAt(range(alias, 39, 1), env: env)).error, "range already issued", alias)
        }
        let at = run(SeedActions.counterReserveAt(range(aliases[3], 40, 10), env: env))
        XCTAssertEqual(parsed(at)["start"] as? Int, 40)
        XCTAssertEqual(try env.counters.next(aliases[0]), 50, "reserving through an alias burnt the real keyset's counters")
        let next = run(SeedActions.counterReserve(range(aliases[0], 0, 1), env: env))
        XCTAssertEqual(parsed(next)["start"] as? Int, 50, "never the alias's range again")
        XCTAssertEqual(parsed(run(SeedActions.counterSnapshot(env)))["counters"] as? [String: Int], [aliases[0]: 51],
                       "one entry, under the first id")
    }

    func testAnAliasGetsTheRealKeysetsRestoreWindowNotItsOwn() {
        let aliases = CounterRulesTests.aliases
        run(SeedActions.counterReserve(range(aliases[0], 0, 10), env: env))
        // the window is the real keyset's: 10 + 1000
        XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(aliases[1], 910, 100), candidate: nil), env: env)).error)
        XCTAssertEqual(run(SeedActions.restoreSecrets(.init(range: range(aliases[2], 911, 100), candidate: nil), env: env)).error,
                       "outside the restore window")
        // advancing an alias moves the one counter, capped as the real one
        XCTAssertEqual(run(SeedActions.counterAdvance(.init(keysetId: aliases[3], next: 5_000), env: env)).error, "too far ahead")
        XCTAssertEqual(try env.counters.next(aliases[0]), 10)
    }

    // MARK: M1: capped moves

    func testCounterAdvanceIsCappedAtAHundredOrWhatARestoreServed() throws {
        run(SeedActions.counterReserve(range(v00, 0, 40), env: env))
        XCTAssertEqual(run(SeedActions.counterAdvance(.init(keysetId: v00, next: 10_040), env: env)).error, "too far ahead")
        XCTAssertEqual(parsed(run(SeedActions.counterAdvance(.init(keysetId: v00, next: 140), env: env)))["next"] as? Int, 140)
        XCTAssertEqual(parsed(run(SeedActions.counterAdvance(.init(keysetId: v00, next: 3), env: env)))["next"] as? Int, 140,
                       "never lower")
        // a restore of the saved seed served to 440: adopting what it found may move there
        XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(v00, 340, 100), candidate: nil), env: env)).error)
        XCTAssertEqual(parsed(run(SeedActions.counterAdvance(.init(keysetId: v00, next: 440), env: env)))["next"] as? Int, 440)
        XCTAssertEqual(run(SeedActions.counterAdvance(.init(keysetId: v00, next: 10_000), env: env)).error, "too far ahead")
        // typed words' scans count too
        let id = try env.candidates.add(saved)
        for start in stride(from: UInt64(0), to: 2_000, by: 400) {
            XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(v01, start, 400), candidate: id), env: env)).error)
        }
        XCTAssertNil(run(SeedActions.counterAdvance(.init(keysetId: v01, next: 2_000), env: env)).error)
        XCTAssertEqual(run(SeedActions.counterAdvance(.init(keysetId: v01, next: 2_101), env: env)).error, "too far ahead")
    }

    func testCounterReserveAtStartsAtMostAHundredAheadBeforeAnyPrompt() throws {
        run(SeedActions.counterReserve(range(v01, 0, 12), env: env))
        vault.failRead = true   // a Face ID prompt would be this read
        XCTAssertEqual(run(SeedActions.counterReserveAt(range(v01, 113, 5), env: env)).error, "too far ahead")
        XCTAssertEqual(run(SeedActions.counterReserveAt(range(v01, 11, 5), env: env)).error, "range already issued")
        vault.failRead = false
        XCTAssertNil(run(SeedActions.counterReserveAt(range(v01, 112, 5), env: env)).error)
        XCTAssertEqual(try env.counters.next(v01), 117)
    }

    func testCountersImportAnswersOnce() throws {
        let first = run(SeedActions.countersImport([v00: 30, v01: 9_007_199_254_740_991], env: env))
        XCTAssertEqual(parsed(first)["counters"] as? [String: Int], [v00: 30, v01: 9_007_199_254_740_991])
        XCTAssertEqual(run(SeedActions.countersImport([v00: 31], env: env)).error, "counters were already imported")
        XCTAssertEqual(run(SeedActions.countersImport([:], env: env)).error, "counters were already imported")
        XCTAssertEqual(try env.counters.next(v00), 30)
        XCTAssertTrue(env.defaults.bool(forKey: "foxy.counters.imported"))
    }

    func testAnImportThatFailsCanBeSentAgain() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: folder.appendingPathComponent(CounterStore.fileName))
        XCTAssertEqual(run(SeedActions.countersImport([v00: 3], env: env)).error, "the counters could not be read")
        XCTAssertFalse(env.defaults.bool(forKey: CounterStore.importedKey))
    }

    func testImportedValuesAreCappedPerVersion() {
        let reply = run(SeedActions.countersImport([v00: 9_007_199_254_740_991], env: env))
        XCTAssertEqual(parsed(reply)["counters"] as? [String: Int], [v00: 1 << 31])
        XCTAssertEqual(run(SeedActions.counterReserve(range(v00, 0, 1), env: env)).error, "outside the keyset's counters")
    }

    // MARK: M2 and M6: typed words raise the counters, and stay

    func testAdoptedCountersStop1000ShortOfWhatWasServed() {
        // a scan ends with ten empty batches of 100: the served end less 1000 is
        // the end of its last batch with a signature, inside every restore's reach
        XCTAssertEqual(RestoreWindow.adoptedCounters([v00: 1403, v01: 250, "00b4cd27d8861a44": 300]),
                       [v00: 403, v01: 0, "00b4cd27d8861a44": 0])
    }

    func testAdoptingTheSavedWordsRaisesCounters1000ShortOfWhereTheyWereServed() throws {
        let aliases = CounterRulesTests.aliases
        run(SeedActions.counterReserve(range(aliases[1], 0, 40), env: env))
        let id = try env.candidates.add(saved)
        for start in stride(from: UInt64(0), to: 20_000, by: 1_000) {
            XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(aliases[0], start, 1_000), candidate: id), env: env)).error)
        }
        XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(v01, 0, 250), candidate: id), env: env)).error)
        let reply = run(SeedActions.adopt(id, env: env) { XCTFail("the saved words need no yes"); return true })
        XCTAssertEqual(reply.text, #"{"adopted":false,"same":true}"#)
        XCTAssertEqual(try env.counters.next(aliases[1]), 19_000, "at most 1000 handed-out secrets ahead of the counter")
        XCTAssertEqual(try env.counters.next(v01), 0, "a scan that found nothing raises nothing")
        XCTAssertTrue(vault.writes.isEmpty)
        XCTAssertTrue(env.candidates.contains(id))
        // never lowered
        run(SeedActions.counterAdvance(.init(keysetId: v01, next: 240), env: env))
        XCTAssertEqual(run(SeedActions.adopt(id, env: env) { true }).text, #"{"adopted":false,"same":true}"#)
        XCTAssertEqual(try env.counters.next(v01), 240)
    }

    func testReplacingTheSeedSetsCountersAsideThenRaisesThemAndKeepsTheCandidate() throws {
        run(SeedActions.counterReserve(range(v00, 0, 7_000), env: env))
        let id = try env.candidates.add(typedOther)
        let spare = try env.candidates.add(made)
        XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(v01, 0, 1_420), candidate: id), env: env)).error)
        let reply = run(SeedActions.adopt(id, env: env) { true })
        XCTAssertEqual(reply.text, #"{"adopted":true}"#)
        XCTAssertEqual(vault.confirms, 1)
        XCTAssertEqual(vault.words, typedOther)
        XCTAssertEqual(try env.counters.snapshot(), [v01: 420], "the old seed's counters aside, the new one's raised")
        XCTAssertTrue(env.candidates.contains(id), "a scan still running with the words can finish")
        XCTAssertFalse(env.candidates.contains(spare), "every other candidate went with the write")
        XCTAssertNil(run(SeedActions.restoreSecrets(.init(range: range(v01, 420, 100), candidate: id), env: env)).error)
        XCTAssertTrue(vault.windowClosedBy.contains("typed words were adopted"))
        // a later seed change drops it too
        vault.deleteSucceeds = true
        XCTAssertNil(run(SeedActions.wipe(env)).error)
        XCTAssertFalse(env.candidates.contains(id))
    }

    // MARK: M8: the yes, and the passcode after it

    func testADeclinedReplaceChangesNothing() throws {
        run(SeedActions.counterReserve(range(v00, 0, 5), env: env))
        let id = try env.candidates.add(typedOther)
        XCTAssertEqual(run(SeedActions.adopt(id, env: env) { false }).error, "Nothing was changed.")
        XCTAssertEqual(vault.words, saved)
        XCTAssertEqual(try env.counters.snapshot(), [v00: 5])
        XCTAssertTrue(env.candidates.contains(id))
        XCTAssertEqual(run(SeedActions.adopt("feed", env: env) { true }).error, "unknown candidate")
        vault.failRead = true
        XCTAssertEqual(run(SeedActions.adopt(id, env: env) { true }).error, "the seed could not be read")
    }

    // MARK: M4: seedMigrate once its window has closed

    func testMigrateStillComparesWithTheWindowClosedAndNeverWrites() {
        vault.windowOpen = false
        XCTAssertEqual(run(SeedActions.migrate(saved, env: env)).text, #"{"migrated":false,"same":true}"#)
        XCTAssertEqual(run(SeedActions.migrate(typedOther, env: env)).text, #"{"different":true,"migrated":false}"#)
        vault.words = nil
        XCTAssertEqual(run(SeedActions.migrate(saved, env: env)).error, "no migration here")
        XCTAssertTrue(vault.writes.isEmpty)
        XCTAssertNil(vault.words)
        vault.failRead = true
        XCTAssertEqual(run(SeedActions.migrate(saved, env: env)).error, "the seed could not be read")
    }

    func testMigrateWritesOnlyWithTheWindowOpenAndClosesItOnAnAnswer() {
        vault.words = nil
        vault.failRead = true
        XCTAssertEqual(run(SeedActions.migrate(saved, env: env)).error, "the seed could not be read")
        XCTAssertTrue(vault.windowOpen, "an error leaves it open for the words to come again")
        vault.failRead = false
        XCTAssertEqual(run(SeedActions.migrate(saved, env: env)).text, #"{"migrated":true}"#)
        XCTAssertEqual(vault.writes, [saved])
        XCTAssertEqual(vault.windowClosedBy, ["seedMigrate answered"])
    }

    // MARK: L5: a wipe that could not delete

    func testAWipeThatLeavesTheSeedMovesNothing() throws {
        run(SeedActions.counterReserve(range(v00, 0, 9), env: env))
        _ = try env.candidates.add(typedOther)
        vault.deleteSucceeds = false
        XCTAssertEqual(run(SeedActions.wipe(env)).error, "the seed could not be deleted")
        XCTAssertEqual(try env.counters.snapshot(), [v00: 9], "counters not set aside")
        XCTAssertEqual(vault.words, saved)
        vault.deleteSucceeds = true
        XCTAssertEqual(run(SeedActions.wipe(env)).text, #"{"created":true,"wiped":true}"#)
        XCTAssertEqual(vault.words, made)
        XCTAssertEqual(try env.counters.snapshot(), [:])
        XCTAssertEqual(env.candidates.count, 0)
    }

    func testCreateNeverWritesOverASavedSeed() {
        XCTAssertEqual(run(SeedActions.create(env)).error, "a seed already exists")
        vault.words = nil
        XCTAssertEqual(run(SeedActions.create(env)).text, #"{"created":true}"#)
        XCTAssertEqual(vault.words, made)
        XCTAssertTrue(vault.windowClosedBy.contains("a seed was made on the phone"))
    }

    func testStatusClosesTheWindowOnlyWhenASeedIsFound() {
        vault.words = nil
        XCTAssertEqual(run(SeedActions.status(env)).text, #"{"exists":false}"#)
        XCTAssertTrue(vault.windowOpen)
        vault.words = saved
        XCTAssertEqual(run(SeedActions.status(env)).text, #"{"exists":true}"#)
        // on a phone with no passcode, and only there, the answer says so
        env.passcodeSet = { false }
        XCTAssertTrue(run(SeedActions.status(env)).text?.contains(#""passcode":false"#) == true)
        XCTAssertTrue(run(SeedActions.status(env)).text?.contains(#""exists":true"#) == true)
        XCTAssertFalse(vault.windowOpen)
    }

    // MARK: The keys a payment request locks ecash to

    private func pubkeys(_ reply: SeedReply) -> [String] {
        (parsed(reply)["pubkeys"] as? [String]) ?? []
    }

    /// The index moves, the public keys come back, and the private halves do not.
    func testReservingLockKeysMovesTheIndexAndAnswersPublicKeysOnly() throws {
        XCTAssertEqual(run(SeedActions.p2pkReserve(count: 0, env: env)).text,
                       #"{"start":0,"next":0,"pubkeys":[]}"#)
        XCTAssertEqual(try env.counters.p2pkNext(), 0, "a peek moves nothing")

        let first = run(SeedActions.p2pkReserve(count: 8, env: env))
        XCTAssertEqual(parsed(first)["start"] as? Int, 0)
        XCTAssertEqual(parsed(first)["next"] as? Int, 8)
        XCTAssertEqual(pubkeys(first).count, 8)
        XCTAssertEqual(try env.counters.p2pkNext(), 8, "written before the keys came back")
        for key in pubkeys(first) {
            XCTAssertEqual(key.count, 66)
            XCTAssertTrue(key.hasPrefix("02") || key.hasPrefix("03"))
        }
        XCTAssertEqual(Set(pubkeys(first)).count, 8, "one key per index, never shared")
        XCTAssertNil(parsed(first)["privkeys"])
        XCTAssertFalse(first.text?.contains("priv") == true)

        // and the next reservation carries on from there
        let second = run(SeedActions.p2pkReserve(count: 2, env: env))
        XCTAssertEqual(parsed(second)["start"] as? Int, 8)
        XCTAssertEqual(parsed(second)["next"] as? Int, 10)

        // the same index, derived alone, is the same key
        let alone = try P2PK.key(seed: try NUT13.seed(mnemonic: saved), index: 3)
        XCTAssertEqual(pubkeys(first)[3], NUT13.hex(alone.publicKey))
    }

    /// No seed, no index: a reservation that cannot derive must not spend one.
    func testAReservationWithNoSeedMovesNothing() {
        vault.words = nil
        XCTAssertEqual(run(SeedActions.p2pkReserve(count: 4, env: env)).error, "no seed")
        XCTAssertEqual(try? env.counters.p2pkNext(), 0)
        vault.words = saved
        vault.failRead = true
        XCTAssertEqual(run(SeedActions.p2pkReserve(count: 4, env: env)).error, "the seed could not be read")
        XCTAssertEqual(try? env.counters.p2pkNext(), 0)
    }

    /// The scan a restore does: public keys for a range, nothing moved, and the
    /// range noted so the key at an index it walked can be asked for.
    func testAScanMovesNothingAndOpensWhatItWalked() throws {
        run(SeedActions.p2pkReserve(count: 1, env: env))
        XCTAssertEqual(try env.counters.p2pkNext(), 1)

        // outside the window, and nothing has walked there
        XCTAssertEqual(run(SeedActions.p2pkKey(index: 1480, env: env)).error, "outside the lock-key window")

        let walked = run(SeedActions.p2pkPubkeys(.init(start: 1300, count: 300), env: env))
        XCTAssertEqual(parsed(walked)["start"] as? Int, 1300)
        XCTAssertEqual(parsed(walked)["next"] as? Int, 1, "the index is reported and not moved")
        XCTAssertEqual(pubkeys(walked).count, 300)
        XCTAssertEqual(try env.counters.p2pkNext(), 1)

        let key = run(SeedActions.p2pkKey(index: 1480, env: env))
        XCTAssertEqual(parsed(key)["index"] as? Int, 1480)
        XCTAssertEqual(parsed(key)["pubkey"] as? String, pubkeys(walked)[180],
                       "the same key the walk found, which is how the page matches a lock")
        let privateKey = try XCTUnwrap(parsed(key)["privkey"] as? String)
        XCTAssertEqual(privateKey.count, 64)
        XCTAssertNil(parsed(key)["chain"], "the parent's chain code gives every other index")
        XCTAssertEqual(Set(parsed(key).keys), ["index", "privkey", "pubkey"])

        // one past what the walk served is still refused
        XCTAssertEqual(run(SeedActions.p2pkKey(index: 1600, env: env)).error, "outside the lock-key window")
    }

    /// A key near what has been reserved needs no walk: every row this install
    /// wrote is below its own index.
    func testAKeyNearWhatIsReservedNeedsNoWalk() {
        run(SeedActions.p2pkReserve(count: 8, env: env))
        for index in [0, 7, 8, 1007] as [UInt64] {
            XCTAssertNotNil(run(SeedActions.p2pkKey(index: index, env: env)).text, "\(index)")
        }
        XCTAssertEqual(run(SeedActions.p2pkKey(index: 1008, env: env)).error, "outside the lock-key window")
    }

    /// A new seed derives a different key at every index — which is why the page
    /// compares the public key it is answered with against the one its row kept.
    func testTheIndexGoesAsideWithTheSeedAndTheKeysChange() throws {
        let before = pubkeys(run(SeedActions.p2pkReserve(count: 4, env: env)))
        let candidate = try env.candidates.add(typedOther)
        XCTAssertEqual(run(SeedActions.adopt(candidate, env: env) { true }).text, #"{"adopted":true}"#)
        XCTAssertEqual(vault.words, typedOther)
        XCTAssertEqual(try env.counters.p2pkNext(), 0, "the lock index went aside with the counters")
        let after = pubkeys(run(SeedActions.p2pkReserve(count: 4, env: env)))
        XCTAssertEqual(after.count, 4)
        XCTAssertTrue(Set(before).isDisjoint(with: Set(after)),
                      "the same indices under another seed give other keys, which the page's row check catches")
    }

    /// A wipe takes them too: the new seed's lock keys start at zero.
    func testAWipeTakesTheLockIndex() {
        run(SeedActions.p2pkReserve(count: 5, env: env))
        XCTAssertEqual(try? env.counters.p2pkNext(), 5)
        XCTAssertEqual(run(SeedActions.wipe(env)).text, #"{"created":true,"wiped":true}"#)
        XCTAssertEqual(try? env.counters.p2pkNext(), 0)
    }

    /// An index file that cannot be read must not end every locked token in hand.
    ///
    /// Reserving is rightly refused — starting again from 0 would derive keys
    /// already put in requests. Walking the path is not: it reads nothing and
    /// moves nothing, and it is the only way a token whose row is gone is ever
    /// opened. Before this, one damaged one-number file made every P2PK-locked
    /// token on the phone unopenable for good (review finding).
    func testADamagedIndexFileStillLetsAWalkFindAndOpenAKey() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("not json at all".utf8).write(to: folder.appendingPathComponent("foxy-p2pk.json"))
        XCTAssertThrowsError(try env.counters.p2pkNext())

        // reserving is refused, because it would have to know where to start
        XCTAssertEqual(run(SeedActions.p2pkReserve(count: 4, env: env)).error, "the counters could not be read")

        // the walk answers, and opens what it walked
        let walked = run(SeedActions.p2pkPubkeys(.init(start: 0, count: 300), env: env))
        XCTAssertEqual(pubkeys(walked).count, 300)
        XCTAssertEqual(parsed(walked)["next"] as? Int, 0, "told as 0 rather than refused; the page ignores it")
        let key = run(SeedActions.p2pkKey(index: 250, env: env))
        XCTAssertEqual(parsed(key)["pubkey"] as? String, pubkeys(walked)[250])

        // and one the walk did not reach is still refused, because that half of
        // the window is what the file is the only record of
        XCTAssertEqual(run(SeedActions.p2pkKey(index: 5_000, env: env)).error, "the counters could not be read")
    }

    // MARK: A card's owner key

    private func bytes(_ hex: String) -> [UInt8] { (try? NUT13.bytes(hex: hex)) ?? [] }

    private let nonce = "000102030405060708090a0b0c0d0e0f"
    private var nonceBytes: [UInt8] { bytes(nonce) }

    /// A request of each label with a value of the shape it takes.
    private func sampleValue(_ label: CardOwner.Label) -> String {
        switch label {
        case .changePin: return "31323334"
        case .setLimit: return "000186a0"
        case .setOwner: return "04" + String(repeating: "ab", count: 64)
        case .setCard: return "01" + "02" + String(repeating: "22", count: 32) + "04" + String(repeating: "33", count: 64) + "03" + "6d6d6d"
        case .load: return ""
        }
    }

    private func sampleRequest(_ label: CardOwner.Label, key: String? = nil) -> CardOwner.SignRequest {
        CardOwner.SignRequest(key: bytes(key ?? cardKey), label: label, nonce: nonceBytes, value: bytes(sampleValue(label)))
    }

    private func fixtureCases() throws -> [[String: Any]] {
        let data = try Data(contentsOf: repoRoot().appendingPathComponent("tests/fixtures/card-owner-vectors.json"))
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(all["cases"] as? [[String: Any]])
    }

    /// What the page is given: one `pub`, 130 lowercase hex characters.
    private func ownerPub(_ key: String) -> String? {
        let reply = run(SeedActions.cardOwnerKey(key: bytes(key), env: env))
        let object = parsed(reply)
        let want: Set<String> = reply.text == nil ? [] : ["pub"]
        XCTAssertEqual(Set(object.keys), want, "nothing but the public key")
        return object["pub"] as? String
    }

    /// The signature, or nil: one `sig` and nothing else.
    private func ownerSig(_ request: CardOwner.SignRequest) -> String? {
        let reply = run(SeedActions.cardOwnerSign(request, env: env))
        let object = parsed(reply)
        let want: Set<String> = reply.text == nil ? [] : ["sig"]
        XCTAssertEqual(Set(object.keys), want, "nothing but the signature")
        return object["sig"] as? String
    }

    /// Whether `sig` is the owner key's signature, as CryptoKit reads it, over "FoxyCard/" + label || nonce || value.
    private func verifies(_ sig: String?, pub: String?, label: String, nonce: String, value: String) -> Bool {
        guard let sig, let pub,
              let key = try? P256.Signing.PublicKey(x963Representation: Data(bytes(pub))),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: Data(bytes(sig))) else { return false }
        return key.isValidSignature(signature, for: Data(Array("FoxyCard/\(label)".utf8) + bytes(nonce) + bytes(value)))
    }

    /// The public key is Node's, for the two phrases the stub vault can hold, and moves nothing.
    func testTheOwnerPublicKeyIsTheSeedAndTheKeysAndMovesNothing() throws {
        let cases = try fixtureCases()
        vault.words = abandonAbout
        XCTAssertEqual(ownerPub(cardKey), cases[0]["pub"] as? String)
        XCTAssertEqual(ownerPub(cardKey), cases[0]["pub"] as? String, "asked again, answered the same")
        // the same words on a new phone give the same key; other words, another
        vault.words = saved
        XCTAssertEqual(cases[1]["mnemonic"] as? String, saved)
        let elsewhere = ownerPub(try XCTUnwrap(cases[1]["cardKey"] as? String))
        XCTAssertEqual(elsewhere, cases[1]["pub"] as? String)
        XCTAssertNotEqual(elsewhere, cases[0]["pub"] as? String)
        // another card under the same seed, and one bit of the key
        let sameSeed = ownerPub(cardKey)
        XCTAssertNotEqual(sameSeed, ownerPub("03" + String(cardKey.dropFirst(2))))
        XCTAssertNotEqual(sameSeed, ownerPub(String(cardKey.dropLast(2)) + "99"))
        let pub = try XCTUnwrap(elsewhere)
        XCTAssertEqual(pub.count, 130)
        XCTAssertTrue(pub.hasPrefix("04"))
        XCTAssertEqual(pub, pub.lowercased())
        // no counter and no index moved
        XCTAssertEqual(try env.counters.snapshot(), [:])
        XCTAssertEqual(try env.counters.p2pkNext(), 0)
    }

    /// A signature made on the phone verifies against the key cardOwnerKey gave, for each label, and only for what was asked.
    func testASignatureVerifiesAgainstTheOwnerKeyForWhatWasAskedAndNothingElse() throws {
        vault.words = abandonAbout
        let pub = ownerPub(cardKey)
        for label in CardOwner.Label.allCases {
            let value = sampleValue(label)
            let sig = ownerSig(sampleRequest(label))
            XCTAssertTrue(verifies(sig, pub: pub, label: label.rawValue, nonce: nonce, value: value), label.rawValue)
            // over the label, the nonce and the value together: change any one and it is no signature
            for other in CardOwner.Label.allCases where other != label {
                XCTAssertFalse(verifies(sig, pub: pub, label: other.rawValue, nonce: nonce, value: value), "\(label.rawValue) as \(other.rawValue)")
            }
            XCTAssertFalse(verifies(sig, pub: pub, label: "lock", nonce: nonce, value: value), "not a lock")
            XCTAssertFalse(verifies(sig, pub: pub, label: "time", nonce: nonce, value: value), "not a time")
            XCTAssertFalse(verifies(sig, pub: pub, label: label.rawValue, nonce: "ff" + String(nonce.dropFirst(2)), value: value), "another nonce")
            XCTAssertFalse(verifies(sig, pub: pub, label: label.rawValue, nonce: nonce, value: value + "00"), "a longer value")
            if !value.isEmpty {
                let changed = String(value.dropLast(2)) + (value.hasSuffix("00") ? "01" : "00")
                XCTAssertFalse(verifies(sig, pub: pub, label: label.rawValue, nonce: nonce, value: changed), "another value")
            }
            // and not another card's key, or another seed's
            XCTAssertFalse(verifies(sig, pub: ownerPub("03" + String(cardKey.dropFirst(2))), label: label.rawValue, nonce: nonce, value: value))
        }
        // the signature is for this card: asked for another card's, it is that key's
        let sig3 = ownerSig(sampleRequest(.load, key: "03" + String(cardKey.dropFirst(2))))
        XCTAssertTrue(verifies(sig3, pub: ownerPub("03" + String(cardKey.dropFirst(2))), label: "load", nonce: nonce, value: ""))
        XCTAssertFalse(verifies(sig3, pub: pub, label: "load", nonce: nonce, value: ""))
        // another seed signs as another owner
        vault.words = saved
        let alien = ownerSig(sampleRequest(.load))
        XCTAssertFalse(verifies(alien, pub: pub, label: "load", nonce: nonce, value: ""))
        XCTAssertTrue(verifies(alien, pub: ownerPub(cardKey), label: "load", nonce: nonce, value: ""))
        XCTAssertEqual(try env.counters.snapshot(), [:])
        XCTAssertEqual(try env.counters.p2pkNext(), 0)
    }

    /// Node's own signatures verify here (NUT13Tests), and ours verify against Node's public keys: the stub vault holds two of its phrases.
    func testOurSignaturesVerifyAgainstTheKeysNodeWorkedOut() throws {
        let cases = try fixtureCases()
        for (index, c) in cases.enumerated() {
            guard let words = c["mnemonic"] as? String else { continue }
            vault.words = words
            let card = try XCTUnwrap(c["cardKey"] as? String)
            for s in try XCTUnwrap(c["signatures"] as? [[String: String]]) {
                let label = try XCTUnwrap(s["label"]), value = try XCTUnwrap(s["value"]), nonce = try XCTUnwrap(s["nonce"])
                let body: [String: Any] = ["key": card, "label": label, "nonce": nonce, "value": value]
                let request = try XCTUnwrap(CardOwner.signRequest(body), "case \(index) \(label)")
                XCTAssertTrue(verifies(ownerSig(request), pub: c["pub"] as? String, label: label, nonce: nonce, value: value), "case \(index) \(label)")
            }
        }
    }

    func testTheOwnerAnswersHoldNeitherTheWordsNorTheSeedNorTheKey() throws {
        vault.words = abandonAbout
        let seed = try NUT13.seed(mnemonic: abandonAbout)
        var scalar = try XCTUnwrap(CardOwner.scalar(seed: seed, cardKey: cardKeyBytes))
        defer { NUT13.wipe(&scalar) }
        let scalarHex = NUT13.hex(scalar)
        let seedHex = seed.key.withUnsafeBytes { NUT13.hex(Array($0)) }
        var texts: [String] = []
        let key = run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env))
        XCTAssertNil(key.error)
        let pubText = try XCTUnwrap(key.text)
        let pub = try XCTUnwrap(parsed(key)["pub"] as? String)
        XCTAssertEqual(pubText, "{\"pub\":\"\(pub)\"}")
        texts.append(pubText)
        for label in CardOwner.Label.allCases {
            let reply = run(SeedActions.cardOwnerSign(sampleRequest(label), env: env))
            XCTAssertNil(reply.error)
            let text = try XCTUnwrap(reply.text)
            let sig = try XCTUnwrap(parsed(reply)["sig"] as? String)
            XCTAssertEqual(text, "{\"sig\":\"\(sig)\"}")
            XCTAssertEqual(sig, sig.lowercased())
            XCTAssertTrue(sig.hasPrefix("30"), "DER")
            texts.append(text)
        }
        // refusals say a fixed thing too
        vault.words = nil
        texts += [run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env)), run(SeedActions.cardOwnerSign(sampleRequest(.load), env: env))].compactMap { $0.error }
        for text in texts {
            let lower = text.lowercased()
            for part in [seedHex, String(seedHex.prefix(32)), String(seedHex.suffix(32)), scalarHex, String(scalarHex.prefix(32)), String(scalarHex.suffix(32)), "abandon", "about"] {
                XCTAssertFalse(lower.contains(part), "an answer holds \(part.prefix(12))")
            }
        }
        // the public key is not the private one's bytes either
        XCTAssertFalse(pub.contains(scalarHex))
        XCTAssertEqual(pub.count, 130)
    }

    /// With no seed there is nothing to derive from: a refusal, and no answer. A seed that cannot be read is another.
    func testWithNoSeedTheOwnerKeyAndItsSignaturesAreRefused() {
        vault.words = nil
        for reply in [run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env)),
                      run(SeedActions.cardOwnerSign(sampleRequest(.changePin), env: env))] {
            XCTAssertNil(reply.text)
            XCTAssertEqual(reply.error, "no seed")
        }
        vault.words = saved
        vault.failRead = true
        for reply in [run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env)),
                      run(SeedActions.cardOwnerSign(sampleRequest(.setCard), env: env))] {
            XCTAssertNil(reply.text)
            XCTAssertEqual(reply.error, "the seed could not be read")
        }
    }

    /// A key that is not a compressed public key, and a request that is not whole,
    /// are refused before the seed is read (the bridge refuses them first; this is the second guard).
    func testARequestThatIsNotWholeIsRefusedBeforeTheSeedIsRead() {
        let body = [UInt8](repeating: 0x11, count: 32)
        let before = vault.reads
        let notCardKeys: [[UInt8]] = [[], [0x02] + body.dropLast(), [0x04] + body, [0x00] + body, [0x02] + body + [0x11], [0x04] + body + body]
        for key in notCardKeys {
            let reply = run(SeedActions.cardOwnerKey(key: key, env: env))
            XCTAssertNil(reply.text, "\(key.count) bytes starting \(key.first ?? 0)")
            XCTAssertEqual(reply.error, "bad request")
            // a signature for a key that is not a card's
            let sign = run(SeedActions.cardOwnerSign(.init(key: key, label: .load, nonce: nonceBytes, value: []), env: env))
            XCTAssertNil(sign.text)
            XCTAssertEqual(sign.error, "bad request")
        }
        let wrongShapes: [CardOwner.SignRequest] = [
            .init(key: cardKeyBytes, label: .load, nonce: nonceBytes, value: [0]),                          // load takes nothing
            .init(key: cardKeyBytes, label: .changePin, nonce: nonceBytes, value: [0x31, 0x32, 0x33]),      // three digits
            .init(key: cardKeyBytes, label: .changePin, nonce: nonceBytes, value: [0x31, 0x32, 0x33, 0x3A]),
            .init(key: cardKeyBytes, label: .setLimit, nonce: nonceBytes, value: [0, 0, 0]),
            .init(key: cardKeyBytes, label: .setOwner, nonce: nonceBytes, value: [0x02] + [UInt8](repeating: 0, count: 64)),
            .init(key: cardKeyBytes, label: .setCard, nonce: nonceBytes, value: bytes(sampleValue(.setCard)).dropLast().map { $0 }),
            .init(key: cardKeyBytes, label: .setCard, nonce: nonceBytes, value: []),
            .init(key: cardKeyBytes, label: .load, nonce: Array(nonceBytes.dropLast()), value: []),         // a nonce of 15 bytes
            .init(key: cardKeyBytes, label: .load, nonce: nonceBytes + [0], value: []),                    // and of 17
            .init(key: cardKeyBytes, label: .load, nonce: [], value: []),
        ]
        for request in wrongShapes {
            XCTAssertFalse(request.isWellFormed)
            let reply = run(SeedActions.cardOwnerSign(request, env: env))
            XCTAssertNil(reply.text, "\(request.label) \(request.value.count) bytes")
            XCTAssertEqual(reply.error, "bad request")
        }
        XCTAssertEqual(vault.reads, before, "the seed was not asked for")
        // and a whole one is the one thing that asks for it
        _ = run(SeedActions.cardOwnerKey(key: cardKeyBytes, env: env))
        XCTAssertEqual(vault.reads, before + 1)
        _ = run(SeedActions.cardOwnerSign(sampleRequest(.load), env: env))
        XCTAssertEqual(vault.reads, before + 2)
    }
}
