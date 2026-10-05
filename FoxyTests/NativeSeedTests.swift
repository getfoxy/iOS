import XCTest
@testable import Foxy

/// The seed on the phone (stages 2 and 4), apart from the keychain and the
/// screens' drawing: which actions answer, what they accept, the one-time move
/// of the page's old words, the restore window, typed words held natively, and
/// the quiz and entry rules.
final class NativeSeedTests: XCTestCase {
    private let v00 = "009a1f293253e41e"
    private let v01 = "01" + String(repeating: "ab", count: 32)
    private let phrase = "half depart obvious quality work element tank gorilla view sugar picture humble"
    private let other = "legal winner thank year wave sausage worth useful legal winner thank yellow"
    private let abandonAbout = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private func words(_ text: String) -> [String] {
        text.split(separator: " ").map(String.init)
    }

    override func tearDown() {
        SeedCandidates.shared.forgetAll()
        super.tearDown()
    }

    // MARK: Which actions answer

    func testTheSeedActionsAreNineteenAndRunInEveryBuild() {
        XCTAssertEqual(FoxyBridge.nativeSeedActions, [
            "seedStatus", "seedCreate", "seedMigrate", "countersImport", "counterReserve", "counterReserveAt", "counterAdvance",
            "counterSnapshot", "restoreSecrets", "seedShow", "seedEnter", "seedAdopt", "seedCandidateForget", "seedWipe",
            "seedProtection", "seedProtect",
            // the keys a payment request locks ecash to (Foxy/Keychain/P2PK.swift)
            "p2pkReserve", "p2pkPubkeys", "p2pkKey",
        ])
        XCTAssertEqual(FoxyBridge.nativeSeedActions.count, 19)
        // No switch since stage 4: the test host is launched with no arguments,
        // and every seed action runs its handler, as in a Release build.
        for action in FoxyBridge.nativeSeedActions {
            XCTAssertNotNil(FoxyBridge.handlers[action], action)
            guard case .run(_, let id, _) = FoxyBridge.dispatch(["action": action, "id": "3"]) else {
                XCTFail("\(action) does not run")
                continue
            }
            XCTAssertEqual(id, "3")
        }
        XCTAssertNil(FoxyBridge.handlers["seedSecrets"], "stage 1's seedSecrets is replaced by counterReserve and restoreSecrets")
    }

    // MARK: Input checks

    func testCounterReserveTakesZeroToAThousand() {
        for count in [0, 1, 1000] {
            XCTAssertEqual(FoxyBridge.counterReserveCheck(["keysetId": v00, "count": count]),
                           .ok(.init(keysetId: v00, version: 0, start: 0, count: count)))
        }
        XCTAssertEqual(FoxyBridge.counterReserveCheck(["keysetId": v01.uppercased(), "count": 2.0]),
                       .ok(.init(keysetId: v01, version: 1, start: 0, count: 2)))
        for count in [-1, 1001, 1.5, "3", true, NSNull()] as [Any] {
            XCTAssertEqual(FoxyBridge.counterReserveCheck(["keysetId": v00, "count": count]), .refuse("bad request"), "\(count)")
        }
        XCTAssertEqual(FoxyBridge.counterReserveCheck(["count": 1]), .refuse("bad request"))
        XCTAssertEqual(FoxyBridge.counterReserveCheck(["keysetId": "I2yN+iRYfkzT", "count": 1]), .refuse("bad request"))
    }

    func testRestoreSecretsTakesACandidateOrNone() {
        let body: [String: Any] = ["keysetId": v00, "start": 0, "count": 5]
        let range = FoxyBridge.CounterRequest(keysetId: v00, version: 0, start: 0, count: 5)
        XCTAssertEqual(FoxyBridge.restoreSecretsCheck(body), .ok(.init(range: range, candidate: nil)))
        var with = body
        with["candidate"] = NSNull()
        XCTAssertEqual(FoxyBridge.restoreSecretsCheck(with), .ok(.init(range: range, candidate: nil)))
        with["candidate"] = "0123456789abcdef0123456789abcdef"
        XCTAssertEqual(FoxyBridge.restoreSecretsCheck(with),
                       .ok(.init(range: range, candidate: "0123456789abcdef0123456789abcdef")))
        for bad in [5, "", String(repeating: "a", count: 65), true, ["x"]] as [Any] {
            with["candidate"] = bad
            XCTAssertEqual(FoxyBridge.restoreSecretsCheck(with), .refuse("bad request"), "\(bad)")
        }
    }

    func testCounterAdvanceTakesASafeInteger() {
        for next in [0, 12, 9_007_199_254_740_991] as [Any] {
            guard case .ok = FoxyBridge.counterAdvanceCheck(["keysetId": v00, "next": next]) else {
                XCTFail("\(next) refused")
                continue
            }
        }
        XCTAssertEqual(FoxyBridge.counterAdvanceCheck(["keysetId": v00.uppercased(), "next": 4]),
                       .ok(.init(keysetId: v00, next: 4)))
        for next in [-1, 9_007_199_254_740_992, 1.5, "1", false, NSNull()] as [Any] {
            XCTAssertEqual(FoxyBridge.counterAdvanceCheck(["keysetId": v00, "next": next]), .refuse("bad request"), "\(next)")
        }
        XCTAssertEqual(FoxyBridge.counterAdvanceCheck(["next": 1]), .refuse("bad request"))
    }

    func testCountersImportRefusesTheWholeImportForOneBadEntry() {
        XCTAssertEqual(FoxyBridge.countersImportCheck(["counters": [v00: 3, v00.uppercased(): 9, v01: 0]]),
                       .ok([v00: 9, v01: 0]), "ids that differ only in case are one keyset, at the larger value")
        XCTAssertEqual(FoxyBridge.countersImportCheck(["counters": [String: Any]()]), .ok([:]))
        let bad: [Any?] = [
            nil, "{}", [1, 2],
            [v00: -1], [v00: 1.5], [v00: "3"], [v00: true], [v00: 9_007_199_254_740_992],
            ["00zz": 1], ["I2yN+iRYfkzT": 1], ["0012": 1], [v00: 1, "02" + String(repeating: "ab", count: 32): 1],
        ]
        for counters in bad {
            XCTAssertEqual(FoxyBridge.countersImportCheck(["counters": counters as Any]), .refuse("bad request"),
                           "\(String(describing: counters))")
        }
        var many: [String: Any] = [:]
        for n in 0..<256 { many[String(format: "00%014x", n)] = 1 }
        guard case .ok = FoxyBridge.countersImportCheck(["counters": many]) else { return XCTFail("256 keysets refused") }
        many[String(format: "00%014x", 256)] = 1
        XCTAssertEqual(FoxyBridge.countersImportCheck(["counters": many]), .refuse("bad request"), "no more than the file holds")
    }

    func testCandidateCheck() {
        XCTAssertEqual(FoxyBridge.candidateCheck(["candidate": "abc"]), .ok("abc"))
        for bad in [nil, 5, "", String(repeating: "a", count: 65)] as [Any?] {
            XCTAssertEqual(FoxyBridge.candidateCheck(["candidate": bad as Any]), .refuse("bad request"))
        }
    }

    // MARK: Replies

    func testTheReplyShapes() {
        XCTAssertEqual(FoxyBridge.json(["exists": true]), #"{"exists":true}"#)
        XCTAssertEqual(FoxyBridge.json(["exists": false]), #"{"exists":false}"#)
        XCTAssertEqual(FoxyBridge.json(["created": true]), #"{"created":true}"#)
        XCTAssertEqual(FoxyBridge.json(["adopted": false, "same": true]), #"{"adopted":false,"same":true}"#)
        XCTAssertEqual(FoxyBridge.json(["adopted": true]), #"{"adopted":true}"#)
        XCTAssertEqual(FoxyBridge.json(["wiped": true, "created": true]), #"{"created":true,"wiped":true}"#)
        XCTAssertEqual(FoxyBridge.json(["verified": false]), #"{"verified":false}"#)
        XCTAssertEqual(FoxyBridge.json(["forgotten": true]), #"{"forgotten":true}"#)
        XCTAssertEqual(FoxyBridge.json(["candidate": "0f"]), #"{"candidate":"0f"}"#)
        // key order is JSONSerialization's (digits compared as numbers); the page reads the object
        let counters = FoxyBridge.countersReply([v00: 7, v01: 0])
        let parsed = try? JSONSerialization.jsonObject(with: Data(counters.utf8)) as? [String: [String: Int]]
        XCTAssertEqual(parsed, ["counters": [v00: 7, v01: 0]])
        XCTAssertTrue(counters.hasPrefix("{\"counters\":{"), counters)
        XCTAssertEqual(FoxyBridge.countersReply([:]), #"{"counters":{}}"#)
        XCTAssertEqual(FoxyBridge.json(["keysetId": v00, "next": NSNumber(value: UInt64(9_007_199_254_740_991))]),
                       "{\"keysetId\":\"\(v00)\",\"next\":9007199254740991}")
        // a peek
        XCTAssertEqual(NUT13.reply(keysetId: v00, start: 12, pairs: []),
                       "{\"keysetId\":\"\(v00)\",\"start\":12,\"secrets\":[],\"blindingFactors\":[]}")
    }

    func testTheErrorsThePageReads() {
        XCTAssertEqual(FoxyBridge.problem(CounterStore.Failure.alreadyIssued), "range already issued")
        XCTAssertEqual(FoxyBridge.problem(CounterStore.Failure.unreadable), "the counters could not be read")
        XCTAssertEqual(FoxyBridge.problem(SeedCandidates.Failure.outsideWindow), "outside the restore window")
        XCTAssertEqual(FoxyBridge.problem(SeedCandidates.Failure.unknown), "unknown candidate")
        XCTAssertEqual(FoxyBridge.problem(SeedCandidates.Failure.full), "too many candidates")
        XCTAssertEqual(FoxyBridge.problem(FoxyBridge.Refusal(message: "no seed")), "no seed")
        XCTAssertEqual(FoxyBridge.problem(NUT13.Failure.invalidKey), "the secrets could not be derived")
        // review
        XCTAssertEqual(FoxyBridge.problem(CounterStore.Failure.tooFarAhead), "too far ahead")
        XCTAssertEqual(FoxyBridge.problem(CounterStore.Failure.alreadyImported), "counters were already imported")
        XCTAssertEqual(FoxyBridge.problem(CounterStore.Failure.tooManyKeysets), "too many keysets")
        XCTAssertEqual(FoxyBridge.problem(SeedCandidates.Failure.tooManyKeysets), "too many keysets")
    }

    /// M8: the Replace alert's words, and Face ID or the passcode after its yes.
    func testTheReplaceAlertWarnsAboutWordsSomeoneElseGave() {
        XCTAssertEqual(FoxyBridge.replaceSeedTitle, "Replace this wallet's seed?")
        XCTAssertEqual(FoxyBridge.replaceSeedMessage,
                       "Only replace it with words you wrote down yourself. Whoever gave you these words can take everything this wallet receives.")
        XCTAssertFalse(FoxyBridge.replaceSeedReason.isEmpty)
    }

    // MARK: Moving the page's old words (seedMigrate)

    func testSeedMigrateTakesOnlyABIP39Phrase() throws {
        let wordlist = try XCTUnwrap(BIP39.english)
        func check(_ words: Any?) -> FoxyBridge.NativeCheck<String> {
            FoxyBridge.seedMigrateCheck(["words": words as Any], wordlist: wordlist)
        }
        XCTAssertEqual(check(other), .ok(other))
        XCTAssertEqual(check(abandonAbout), .ok(abandonAbout))
        XCTAssertEqual(check("  " + other.replacingOccurrences(of: " ", with: "\n\t ") + " "), .ok(other),
                       "the spacing around the words is not part of the phrase")
        XCTAssertEqual(check(words(other)), .ok(other), "an array of words")
        XCTAssertEqual(check(other.uppercased()), .ok(other), "capitals folded, as the page may have stored them")
        XCTAssertEqual(check(words(other).map { " " + $0.capitalized + " " }), .ok(other), "an array's words trimmed and folded")
        let twentyFour = String(repeating: "abandon ", count: 23) + "art"
        XCTAssertEqual(check(twentyFour), .ok(twentyFour))
        var checksum = words(other)
        checksum[11] = "year"
        let bad: [Any?] = [
            nil, 5, true, NSNull(), "", ["words": other],
            checksum.joined(separator: " "),                     // every word on the list, the checksum wrong
            words(other).dropLast().joined(separator: " "),      // eleven
            other + " abandon",                                  // thirteen
            String(repeating: "abandon ", count: 11) + "abandon",
            "legal winner thank year wave sausage worth useful legal winner thank foxy",
            [1, 2, 3], words(other) + ["abandon"], Array(repeating: "abandon", count: 25),
            String(repeating: "abandon ", count: 200),
        ]
        for words in bad {
            XCTAssertEqual(check(words), .refuse("bad request"), "\(String(describing: words))")
        }
    }

    func testMigrateWritesWhereNoSeedIsSaved() {
        var written: [String] = []
        let outcome = FoxyBridge.migrate(other, windowOpen: true, saved: .absent) { words in
            written.append(words)
            return nil
        }
        XCTAssertEqual(outcome, .migrated)
        XCTAssertEqual(written, [other])
        XCTAssertEqual(FoxyBridge.migrateReply(outcome).text, #"{"migrated":true}"#)
        XCTAssertNil(FoxyBridge.migrateReply(outcome).error)
    }

    func testMigratingTheSavedSeedChangesNothing() throws {
        let saved = try NUT13.seed(mnemonic: other)
        for open in [true, false] {
            let outcome = FoxyBridge.migrate(other, windowOpen: open, saved: .found(saved)) { _ in
                XCTFail("the saved seed was written again")
                return nil
            }
            XCTAssertEqual(outcome, .same, "window open \(open)")
        }
        let outcome = FoxyBridge.MigrateOutcome.same
        XCTAssertEqual(FoxyBridge.migrateReply(outcome).text, #"{"migrated":false,"same":true}"#)
    }

    func testMigrateNeverWritesOverADifferentSeed() throws {
        let saved = try NUT13.seed(mnemonic: abandonAbout)
        XCTAssertEqual(FoxyBridge.migrate(other, windowOpen: false, saved: .found(saved)) { _ in
            XCTFail("a different saved seed was written over, with the window closed")
            return nil
        }, .different, "closed, it still compares (review M4)")
        let outcome = FoxyBridge.migrate(other, windowOpen: true, saved: .found(saved)) { _ in
            XCTFail("a different saved seed was written over")
            return nil
        }
        XCTAssertEqual(outcome, .different)
        let reply = FoxyBridge.migrateReply(outcome)
        XCTAssertEqual(reply.text, #"{"different":true,"migrated":false}"#)
        XCTAssertNil(reply.error)
        // A seed saved between the read and the write: SeedVault.write reads again
        // and refuses without replace, and the answer is still "different".
        XCTAssertEqual(FoxyBridge.migrate(other, windowOpen: true, saved: .absent) { _ in
            "A different seed is already saved on this phone. Foxy did not replace it."
        }, .different)
        // the replies never carry the words
        for outcome in [FoxyBridge.MigrateOutcome.migrated, .same, .different] {
            XCTAssertFalse(FoxyBridge.migrateReply(outcome).text?.contains("legal") ?? true)
        }
    }

    func testMigrateWithTheWindowClosedAndNoSeedWritesNothing() {
        XCTAssertEqual(FoxyBridge.migrate(other, windowOpen: false, saved: .absent) { _ in
            XCTFail("words written after the window closed")
            return nil
        }, .refused("no migration here"))
        XCTAssertEqual(FoxyBridge.migrateReply(.refused("no migration here")).error, "no migration here")
    }

    func testMigrateWritesNothingWhenTheKeychainDoesNotAnswer() {
        XCTAssertEqual(FoxyBridge.migrate(other, windowOpen: true, saved: .failed) { _ in
            XCTFail("written blind")
            return nil
        }, .refused("the seed could not be read"))
        XCTAssertEqual(FoxyBridge.migrate(other, windowOpen: true, saved: .absent) { _ in "the keychain refused the write" },
                       .refused("the keychain refused the write"))
        XCTAssertEqual(FoxyBridge.migrateReply(.refused("the keychain refused the write")).error, "the keychain refused the write")
        XCTAssertNil(FoxyBridge.migrateReply(.refused("x")).text)
    }

    // MARK: The restore window

    func testTheSavedSeedReachesAThousandPastNext() {
        XCTAssertTrue(RestoreWindow.savedSeedAllowed(start: 0, count: 1000, next: 0))
        XCTAssertFalse(RestoreWindow.savedSeedAllowed(start: 0, count: 1001, next: 0))
        XCTAssertTrue(RestoreWindow.savedSeedAllowed(start: 200, count: 100, next: 0))
        XCTAssertFalse(RestoreWindow.savedSeedAllowed(start: 1000, count: 1, next: 0), "an unknown keyset's next is 0")
        XCTAssertTrue(RestoreWindow.savedSeedAllowed(start: 0, count: 1000, next: 1000), "history before next is open")
        XCTAssertTrue(RestoreWindow.savedSeedAllowed(start: 1000, count: 1000, next: 1000))
        XCTAssertFalse(RestoreWindow.savedSeedAllowed(start: 1999, count: 2, next: 1000))
        XCTAssertFalse(RestoreWindow.savedSeedAllowed(start: 0, count: 0, next: 1000))
        XCTAssertTrue(RestoreWindow.savedSeedAllowed(start: (1 << 53) - 1, count: 1, next: 1 << 53))
        XCTAssertFalse(RestoreWindow.savedSeedAllowed(start: .max, count: 1, next: 0))
    }

    func testACandidateScansFromZeroOneWindowAtATime() {
        XCTAssertTrue(RestoreWindow.candidateAllowed(start: 0, count: 100, servedEnd: 0))
        XCTAssertTrue(RestoreWindow.candidateAllowed(start: 1000, count: 100, servedEnd: 0))
        XCTAssertFalse(RestoreWindow.candidateAllowed(start: 1001, count: 1, servedEnd: 0))
        XCTAssertTrue(RestoreWindow.candidateAllowed(start: 1400, count: 100, servedEnd: 400))
        XCTAssertFalse(RestoreWindow.candidateAllowed(start: 1401, count: 100, servedEnd: 400))
        XCTAssertTrue(RestoreWindow.candidateAllowed(start: 19_000, count: 1000, servedEnd: 19_000))
        XCTAssertFalse(RestoreWindow.candidateAllowed(start: 19_001, count: 1000, servedEnd: 19_001), "past 20,000")
        XCTAssertTrue(RestoreWindow.candidateAllowed(start: 19_999, count: 1, servedEnd: 19_900))
        XCTAssertFalse(RestoreWindow.candidateAllowed(start: 0, count: 0, servedEnd: 0))
        XCTAssertFalse(RestoreWindow.candidateAllowed(start: .max, count: 1, servedEnd: 0))
    }

    // MARK: Typed words, held natively

    func testAtMostTwoCandidatesUnderIdsThatCannotBeGuessed() throws {
        let store = SeedCandidates()
        let a = try store.add(phrase)
        let b = try store.add(other)
        for id in [a, b] {
            XCTAssertEqual(id.count, 32)
            XCTAssertTrue(id.allSatisfy { "0123456789abcdef".contains($0) }, id)
        }
        XCTAssertNotEqual(a, b)
        XCTAssertThrowsError(try store.add(phrase)) { XCTAssertEqual($0 as? SeedCandidates.Failure, .full) }
        XCTAssertEqual(store.count, 2)
        XCTAssertEqual(store.phrase(a), phrase)
        XCTAssertEqual(store.phrase(b), other)
        store.forget(a)
        XCTAssertFalse(store.contains(a))
        XCTAssertNil(store.phrase(a))
        XCTAssertThrowsError(try store.seed(a)) { XCTAssertEqual($0 as? SeedCandidates.Failure, .unknown) }
        XCTAssertNoThrow(try store.add(phrase), "a place is free again")
        store.forgetAll()
        XCTAssertEqual(store.count, 0)
    }

    func testACandidatesSeedIsTheSeedOfItsWords() throws {
        let store = SeedCandidates()
        let id = try store.add(phrase)
        let seed = try store.seed(id)
        XCTAssertTrue(seed.sameBytes(as: try NUT13.seed(mnemonic: phrase)))
        XCTAssertFalse(seed.sameBytes(as: try NUT13.seed(mnemonic: other)))
    }

    func testServingFollowsTheWindowPerKeyset() throws {
        let store = SeedCandidates()
        let id = try store.add(phrase)
        XCTAssertThrowsError(try store.serve(id, keysetId: v00, start: 1001, count: 1)) {
            XCTAssertEqual($0 as? SeedCandidates.Failure, .outsideWindow)
        }
        XCTAssertNoThrow(try store.serve(id, keysetId: v00, start: 0, count: 100))
        XCTAssertNoThrow(try store.serve(id, keysetId: v00, start: 400, count: 100))
        XCTAssertThrowsError(try store.serve(id, keysetId: v00, start: 1501, count: 1), "served to 500: 1500 at most")
        XCTAssertNoThrow(try store.serve(id, keysetId: v00, start: 1500, count: 1))
        XCTAssertNoThrow(try store.serve(id, keysetId: v00.uppercased(), start: 2501, count: 1), "the same keyset in capitals")
        // H1: another id of the same derivation index continues this window, not a new one from 0
        XCTAssertThrowsError(try store.serve(id, keysetId: "0000000033882270", start: 3503, count: 1))
        XCTAssertNoThrow(try store.serve(id, keysetId: "009a1f29b253e41d", start: 3502, count: 1))
        XCTAssertEqual(store.servedEnds(id), [v00: 3503], "one entry per path, under the first id served")
        // each keyset from its own zero
        XCTAssertThrowsError(try store.serve(id, keysetId: v01, start: 1001, count: 1))
        XCTAssertNoThrow(try store.serve(id, keysetId: v01, start: 0, count: 1))
        XCTAssertThrowsError(try store.serve("0123456789abcdef0123456789abcdef", keysetId: v00, start: 0, count: 1)) {
            XCTAssertEqual($0 as? SeedCandidates.Failure, .unknown)
        }
        // served seeds are the words' seed
        XCTAssertTrue(try store.serve(id, keysetId: v00, start: 0, count: 1).sameBytes(as: try NUT13.seed(mnemonic: phrase)))
    }

    func testACandidateStopsAtTwentyThousandCounters() throws {
        let store = SeedCandidates()
        let id = try store.add(other)
        for start in stride(from: UInt64(0), to: 20_000, by: 1000) {
            // H1: aliases take turns and still share the one 20,000
            let alias = ["009a1f293253e41e", "0000000033882270", "009a1f29b253e41d", "009a1f28b253e41f"][Int(start / 1000) % 4]
            XCTAssertNoThrow(try store.serve(id, keysetId: alias, start: start, count: 1000), "\(start)")
        }
        XCTAssertThrowsError(try store.serve(id, keysetId: v00, start: 20_000, count: 1))
        XCTAssertThrowsError(try store.serve(id, keysetId: v00, start: 19_999, count: 2))
        XCTAssertNoThrow(try store.serve(id, keysetId: v00, start: 19_999, count: 1))
    }

    func testCandidatesGoWhereTheKeptSeedGoes() throws {
        let forgets: [(String, () -> Void)] = [
            ("forgetNativeSeed", SeedVault.forgetNativeSeed),   // the page gone, the background, a seed write or delete
            ("forgetUnlock", SeedVault.forgetUnlock),
            ("pageWillLoad", SeedVault.pageWillLoad),
        ]
        for (name, forget) in forgets {
            _ = try SeedCandidates.shared.add(phrase)
            _ = try SeedCandidates.shared.add(other)
            forget()
            XCTAssertEqual(SeedCandidates.shared.count, 0, name)
        }
        // M6: a write that adopted typed words keeps those, and only those
        let adopted = try SeedCandidates.shared.add(phrase)
        let spare = try SeedCandidates.shared.add(other)
        SeedVault.forgetNativeSeed(keepingCandidate: adopted)
        XCTAssertTrue(SeedCandidates.shared.contains(adopted))
        XCTAssertFalse(SeedCandidates.shared.contains(spare))
        SeedVault.forgetNativeSeed()
        XCTAssertEqual(SeedCandidates.shared.count, 0, "and it goes at the next forget")
    }

    func testACandidateIsServedForAtMost256Keysets() throws {
        let store = SeedCandidates()
        let id = try store.add(phrase)
        for n in 0..<256 { XCTAssertNoThrow(try store.serve(id, keysetId: String(format: "00%014x", n), start: 0, count: 1)) }
        XCTAssertThrowsError(try store.serve(id, keysetId: String(format: "00%014x", 256), start: 0, count: 1)) {
            XCTAssertEqual($0 as? SeedCandidates.Failure, .tooManyKeysets)
        }
        XCTAssertNoThrow(try store.serve(id, keysetId: String(format: "00%014x", 5), start: 1, count: 1), "a keyset already served")
    }

    // MARK: The verify quiz

    // The scramble is no longer the page's: SeedScreenTests checks it is drawn
    // from the system's random source (review L3).

    private func tile(_ quiz: SeedQuiz, _ word: String) -> Int {
        quiz.pool.indices.first { quiz.pool[$0] == word && !quiz.used[$0] } ?? -1
    }

    func testTappingTheWordsInOrderFinishes() {
        let list = words(phrase)
        var quiz = SeedQuiz(words: list)
        XCTAssertEqual(Set(quiz.pool), Set(list))
        for (n, word) in list.enumerated() {
            XCTAssertFalse(quiz.isComplete)
            XCTAssertEqual(quiz.tap(tile(quiz, word)), n == list.count - 1 ? .done : .right)
        }
        XCTAssertTrue(quiz.isComplete)
        XCTAssertEqual(quiz.picked, list)
        XCTAssertEqual(quiz.tap(0), .ignored, "a finished quiz takes no more taps")
    }

    func testAWrongTapIsFlaggedAndStartsAgain() {
        let list = words(phrase)
        var quiz = SeedQuiz(words: list)
        let first = tile(quiz, list[0])
        XCTAssertEqual(quiz.tap(first), .right)
        XCTAssertEqual(quiz.tap(first), .ignored, "a placed tile")
        XCTAssertEqual(quiz.tap(tile(quiz, list[1])), .right)
        XCTAssertEqual(quiz.tap(tile(quiz, list[7])), .wrong(expected: 3))
        XCTAssertEqual(quiz.picked, [])
        XCTAssertFalse(quiz.used.contains(true))
        XCTAssertEqual(quiz.tap(tile(quiz, list[0])), .right, "and it starts again from the first word")
        XCTAssertEqual(quiz.tap(-1), .ignored)
        XCTAssertEqual(quiz.tap(12), .ignored)
        XCTAssertFalse(SeedQuiz(words: []).isComplete)
    }

    func testAPhraseWithARepeatedWordCanBeFinished() {
        let list = words("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")
        var quiz = SeedQuiz(words: list)
        var last: SeedQuiz.Tap = .ignored
        for word in list { last = quiz.tap(tile(quiz, word)) }
        XCTAssertEqual(last, .done)
        XCTAssertTrue(quiz.isComplete)
    }

    // MARK: The entry screen

    func testTypingIsLowerCaseLettersAndAPastedPhraseSpreads() {
        let empty = Array(repeating: "", count: 12)
        XCTAssertEqual(SeedEntry.apply("Abandon", at: 0, to: empty)[0], "abandon")
        XCTAssertEqual(SeedEntry.apply(" zoo1 ", at: 3, to: empty)[3], "zoo")
        XCTAssertEqual(SeedEntry.apply("", at: 3, to: SeedEntry.apply("zoo", at: 3, to: empty))[3], "")
        let pasted = SeedEntry.apply("1. Legal 2. winner\nthank, year", at: 2, to: empty)
        XCTAssertEqual(pasted, ["", "", "legal", "winner", "thank", "year", "", "", "", "", "", ""])
        let late = SeedEntry.apply(other, at: 10, to: empty)
        XCTAssertEqual(late.count, 12)
        XCTAssertEqual(Array(late[10...]), ["legal", "winner"], "a phrase pasted near the end stops at the twelfth cell")
        XCTAssertEqual(SeedEntry.apply(other, at: 0, to: empty), words(other))
        XCTAssertEqual(SeedEntry.apply("zoo", at: 12, to: empty), empty)
        XCTAssertEqual(SeedEntry.parts("über café"), ["ber", "caf"], "only a to z are letters of a seed word")
    }

    func testTheCheckOfTypedWords() throws {
        let wordlist = try XCTUnwrap(BIP39.english)
        let valid = words(other)
        XCTAssertEqual(SeedEntry.check(valid, wordlist: wordlist), .init(unknown: [], filled: 12, valid: true))
        var typo = valid
        typo[4] = "wav"
        XCTAssertEqual(SeedEntry.check(typo, wordlist: wordlist), .init(unknown: [4], filled: 12, valid: false))
        var checksum = valid
        checksum[11] = "year"
        XCTAssertEqual(SeedEntry.check(checksum, wordlist: wordlist), .init(unknown: [], filled: 12, valid: false))
        var partial = valid
        partial[7] = ""
        XCTAssertEqual(SeedEntry.check(partial, wordlist: wordlist), .init(unknown: [], filled: 11, valid: false))
        XCTAssertEqual(SeedEntry.check(Array(repeating: "", count: 12), wordlist: wordlist), .init(unknown: [], filled: 0, valid: false))
        XCTAssertFalse(SeedEntry.check(words(phrase) + ["zoo"], wordlist: wordlist).valid, "twelve cells, not thirteen")
        XCTAssertEqual(SeedEntry.phrase(valid), other)
    }

    // MARK: One screen at a time

    func testScreensComeOneAtATimeAndNeverOverAnAlert() {
        var alert = true
        let queue = ScreenQueue(alertShowing: { alert }, retryEvery: nil)
        var shown: [Int] = []
        var finish: [() -> Void] = []
        for n in 1...3 {
            queue.enqueue { done in
                shown.append(n)
                finish.append(done)
            }
        }
        XCTAssertEqual(shown, [], "an alert is up")
        XCTAssertEqual(queue.waitingCount, 3)
        alert = false
        queue.pump()
        XCTAssertEqual(shown, [1])
        XCTAssertTrue(queue.running)
        finish[0]()
        XCTAssertEqual(shown, [1, 2])
        finish[0]()
        XCTAssertEqual(shown, [1, 2], "a screen that answers twice lets one more through, not two")
        alert = true
        finish[1]()
        XCTAssertEqual(shown, [1, 2], "the next waits for the alert")
        XCTAssertFalse(queue.running)
        alert = false
        queue.pump()
        XCTAssertEqual(shown, [1, 2, 3])
        finish[2]()
        XCTAssertFalse(queue.running)
        XCTAssertEqual(queue.waitingCount, 0)
    }
}
