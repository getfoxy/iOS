import XCTest
@testable import Foxy

/// The native counter store, in a folder of its own for each test: counters
/// never go down, a range is written before it is handed out, one entry per
/// derivation path, moves are capped, and the file goes aside when the seed
/// changes. Runs in FoxyTests and in tools/nativetests.
final class CounterStoreTests: XCTestCase {
    private var folder: URL!
    private let v00 = "009a1f293253e41e"
    private let v01 = "01" + String(repeating: "ab", count: 32)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("counters-" + UUID().uuidString)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func store(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> CounterStore {
        CounterStore(directory: folder, now: { now })
    }

    private func onDisk() throws -> [String: UInt64] {
        try XCTUnwrap(CounterStore.parse(try Data(contentsOf: folder.appendingPathComponent("foxy-counters.json"))))
    }

    // MARK: Reserving

    func testReservesFollowOneAnotherAndAreWrittenFirst() throws {
        let s = store()
        XCTAssertEqual(try s.snapshot(), [:])
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 3), 0)
        XCTAssertEqual(try onDisk(), [v00: 3], "on disk before the range is returned")
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 10), 3)
        XCTAssertEqual(try s.reserve(v01, version: 1, count: 1), 0)
        XCTAssertEqual(try s.snapshot(), [v00: 13, v01: 1])
        // a fresh store reads the same file
        XCTAssertEqual(try store().snapshot(), [v00: 13, v01: 1])
    }

    func testACountOfZeroOnlyReads() throws {
        let s = store()
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 0), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("foxy-counters.json").path))
        _ = try s.reserve(v00, version: 0, count: 4)
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 0), 4)
        XCTAssertEqual(try s.next(v00), 4)
    }

    func testKeysetIdsAreOneKeysetWhateverTheirCase() throws {
        let s = store()
        _ = try s.reserve(v00.uppercased(), version: 0, count: 5)
        XCTAssertEqual(try s.next(v00), 5)
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 1), 5)
    }

    func testReservingIsAtomicAcrossThreads() throws {
        let s = store()
        // the test's own lock: an append through Locked.value is a get and a set, not one step
        let lock = NSLock()
        var starts: [UInt64] = []
        DispatchQueue.concurrentPerform(iterations: 64) { _ in
            let start = try? s.reserve(v00, version: 0, count: 7)
            lock.lock()
            if let start { starts.append(start) }
            lock.unlock()
        }
        XCTAssertEqual(starts.count, 64)
        XCTAssertEqual(starts.sorted(), (0..<64).map { UInt64($0 * 7) }, "every range distinct, none skipped")
        XCTAssertEqual(try s.next(v00), 448)
        XCTAssertEqual(try onDisk(), [v00: 448])
    }

    func testTheKeysetsLastCounterIsTheLimit() throws {
        let s = store()
        XCTAssertEqual(try s.importMax([v00: 0x7FFF_FFFE]), [v00: 0x7FFF_FFFE])
        XCTAssertThrowsError(try s.reserve(v00, version: 0, count: 3)) { XCTAssertEqual($0 as? CounterStore.Failure, .outOfRange) }
        XCTAssertEqual(try s.next(v00), 0x7FFF_FFFE, "a refused reserve moves nothing")
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 2), 0x7FFF_FFFE)
        XCTAssertThrowsError(try s.reserve(v00, version: 0, count: 1))
        XCTAssertThrowsError(try s.advance(v00, to: (1 << 31) + 1)) { XCTAssertEqual($0 as? CounterStore.Failure, .tooFarAhead) }
        _ = try s.importMax([v01: (1 << 53) - 1])
        XCTAssertEqual(try s.reserve(v01, version: 1, count: 1), (1 << 53) - 1)
        XCTAssertEqual(try s.next(v01), 1 << 53)
        XCTAssertEqual(try store().next(v01), 1 << 53, "one past the last is stored and read back")
    }

    // MARK: Reserving at a start

    func testReserveAtRefusesAnIssuedRangeAndBurnsUpToItsStart() throws {
        let s = store()
        _ = try s.reserve(v00, version: 0, count: 10)
        for start in [0, 5, 9] as [UInt64] {
            XCTAssertThrowsError(try s.reserve(v00, version: 0, at: start, count: 1)) {
                XCTAssertEqual($0 as? CounterStore.Failure, .alreadyIssued)
                XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "range already issued")
            }
        }
        XCTAssertEqual(try s.next(v00), 10)
        try s.reserve(v00, version: 0, at: 10, count: 2)
        XCTAssertEqual(try s.next(v00), 12)
        try s.reserve(v00, version: 0, at: 100, count: 5)
        XCTAssertEqual(try s.next(v00), 105, "the counters below 100 are burnt")
        XCTAssertThrowsError(try s.reserve(v00, version: 0, at: 104, count: 1))
        XCTAssertEqual(try s.next(v00), 105)
    }

    func testReserveAtMoreThanAHundredAheadIsRefused() throws {
        let s = store()
        _ = try s.reserve(v00, version: 0, count: 10)
        XCTAssertThrowsError(try s.reserve(v00, version: 0, at: 111, count: 1)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .tooFarAhead)
            XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "too far ahead")
        }
        XCTAssertThrowsError(try s.reserve(v00, version: 0, at: 0x7FFF_FFFF, count: 2)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .tooFarAhead)
        }
        XCTAssertEqual(try s.next(v00), 10)
        try s.reserve(v00, version: 0, at: 110, count: 1)
        XCTAssertEqual(try s.next(v00), 111)
        // near the last counter the range must still fit
        _ = try s.importMax([v01: (1 << 53) - 10])
        XCTAssertThrowsError(try s.reserve(v01, version: 1, at: (1 << 53) - 5, count: 10)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .outOfRange)
        }
    }

    // MARK: Never lower, and never far ahead

    func testAdvanceNeverLowers() throws {
        let s = store()
        XCTAssertEqual(try s.advance(v00, to: 50), 50)
        XCTAssertEqual(try s.advance(v00, to: 20), 50)
        XCTAssertEqual(try s.advance(v00, to: 0), 50)
        XCTAssertEqual(try s.advance(v00, to: 51), 51)
        XCTAssertEqual(try onDisk(), [v00: 51])
        XCTAssertEqual(try s.advance(v01, to: 0), 0, "an unknown keyset at zero")
        XCTAssertEqual(try s.snapshot(), [v00: 51], "and nothing written for it")
    }

    func testAdvanceGoesAHundredOrToWhatARestoreServed() throws {
        let s = store()
        XCTAssertThrowsError(try s.advance(v00, to: 10_000)) {
            XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "too far ahead")
        }
        XCTAssertEqual(try s.snapshot(), [:], "a refused move writes nothing")
        XCTAssertEqual(try s.advance(v00, to: 100), 100)
        s.noteServed(CounterRulesTests.aliases[2], end: 400)
        XCTAssertEqual(s.highestServed(v00), 400, "served through an alias counts for the entry")
        XCTAssertEqual(try s.advance(v00, to: 400), 400)
        XCTAssertThrowsError(try s.advance(v00, to: 501))
        XCTAssertEqual(try s.advance(CounterRulesTests.aliases[1], to: 500), 500)
        XCTAssertEqual(try s.snapshot(), [v00: 500])
        s.noteServed(v00, end: 50)
        XCTAssertEqual(s.highestServed(v00), 400, "never lower")
    }

    func testImportTakesTheLargerOfEach() throws {
        let s = store()
        _ = try s.reserve(v00, version: 0, count: 30)
        let merged = try s.importMax([v00: 10, v01: 44])
        XCTAssertEqual(merged, [v00: 30, v01: 44])
        XCTAssertEqual(try s.importMax([v00: 31, v01: 2]), [v00: 31, v01: 44])
        XCTAssertEqual(try onDisk(), [v00: 31, v01: 44])
        XCTAssertEqual(try s.reserve(v01, version: 1, count: 1), 44, "the next reserve starts after the import")
        XCTAssertEqual(try s.importMax([v00: 9_007_199_254_740_991]), [v00: 1 << 31, v01: 45], "cut to the 00 ceiling")
    }

    func testImportOnceAnswersOncePerInstall() throws {
        let suite = "foxy.tests.counters.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let s = store()
        XCTAssertEqual(try s.importOnce([v00: 12], defaults: defaults), [v00: 12])
        XCTAssertTrue(defaults.bool(forKey: "foxy.counters.imported"))
        XCTAssertThrowsError(try s.importOnce([v00: 40], defaults: defaults)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .alreadyImported)
            XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "counters were already imported")
        }
        XCTAssertEqual(try s.next(v00), 12)
    }

    func testRaiseLiftsEachEntryAndLowersNone() throws {
        let s = store()
        _ = try s.reserve(v00, version: 0, count: 700)
        let aliases = CounterRulesTests.aliases
        XCTAssertEqual(try s.raise([aliases[1]: 500, aliases[2]: 900, v01: 250, "00b4cd27d8861a44": 0]), [v00: 900, v01: 250],
                       "aliases raise the one entry; a zero adds nothing")
        XCTAssertEqual(try s.raise([v01: 100]), [v00: 900, v01: 250])
        XCTAssertEqual(try s.raise([v00: 9_000_000_000]), [v00: 1 << 31, v01: 250])
        XCTAssertEqual(try onDisk(), [v00: 1 << 31, v01: 250])
    }

    // MARK: One entry per derivation path (H1)

    func testEveryAliasReachesTheFirstIdsEntry() throws {
        let aliases = CounterRulesTests.aliases
        let s = store()
        XCTAssertEqual(try s.reserve(aliases[0], version: 0, count: 40), 0)
        for alias in aliases {
            XCTAssertEqual(try s.next(alias), 40, alias)
            XCTAssertEqual(try s.reserve(alias, version: 0, count: 0), 40, "a peek")
            XCTAssertThrowsError(try s.reserve(alias, version: 0, at: 39, count: 1), alias) {
                XCTAssertEqual($0 as? CounterStore.Failure, .alreadyIssued)
            }
        }
        XCTAssertEqual(try s.reserve(aliases[3], version: 0, count: 5), 40)
        try s.reserve(aliases[2], version: 0, at: 50, count: 10)
        XCTAssertEqual(try s.advance(aliases[1], to: 80), 80)
        XCTAssertEqual(try s.importMax([aliases[3]: 70, aliases[2].uppercased(): 81]), [aliases[0]: 81])
        XCTAssertEqual(try s.snapshot(), [aliases[0]: 81], "the snapshot keeps the first id")
        XCTAssertEqual(try store().snapshot(), [aliases[0]: 81])
    }

    func testAnImportOfAliasesIsOneEntry() throws {
        let aliases = CounterRulesTests.aliases
        let s = store()
        XCTAssertEqual(try s.importMax([aliases[3]: 5, aliases[1]: 60, aliases[2]: 9]), [aliases[1]: 60],
                       "the smallest id of a new slot, at the largest value")
    }

    func testAnOldFileWithAliasesIsMergedWhenRead() throws {
        let aliases = CounterRulesTests.aliases
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("{\"\(aliases[0])\": 40, \"\(aliases[2])\": 90, \"\(v01)\": 3}".utf8)
            .write(to: folder.appendingPathComponent("foxy-counters.json"))
        let s = store()
        XCTAssertEqual(try s.snapshot(), [aliases[2]: 90, v01: 3])
        XCTAssertEqual(try s.next(aliases[0]), 90)
        XCTAssertEqual(try s.reserve(aliases[1], version: 0, count: 1), 90)
        XCTAssertEqual(try onDisk(), [aliases[2]: 91, v01: 3], "written back merged with the next change")
    }

    // MARK: At most 256 keysets (L9)

    func testTheFileHoldsAtMost256Keysets() throws {
        let s = store()
        var many: [String: UInt64] = [:]
        for n in 0..<256 { many[String(format: "00%014x", n)] = 1 }
        XCTAssertEqual(try s.importMax(many).count, 256)
        let extra = String(format: "00%014x", 256)
        XCTAssertThrowsError(try s.reserve(extra, version: 0, count: 1)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .tooManyKeysets)
            XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "too many keysets")
        }
        XCTAssertThrowsError(try s.advance(extra, to: 1))
        XCTAssertThrowsError(try s.importMax([extra: 1]))
        XCTAssertThrowsError(try s.raise([v01: 1]))
        XCTAssertEqual(try s.reserve(extra, version: 0, count: 0), 0, "a peek adds nothing, and is answered")
        // an alias of a stored keyset is not a new one: index 5 + (2^31 − 1)
        let alias = String(format: "00%014llx", UInt64(5) + 0x7FFF_FFFF)
        XCTAssertEqual(CounterRules.slot(alias), CounterRules.slot(String(format: "00%014x", 5)))
        XCTAssertEqual(try s.reserve(alias, version: 0, count: 1), 1)
        XCTAssertEqual(try s.snapshot().count, 256)
    }

    // MARK: The lock-key index, in a file of its own

    private func indexOnDisk() throws -> UInt64 {
        try XCTUnwrap(CounterStore.parseP2PK(try Data(contentsOf: folder.appendingPathComponent("foxy-p2pk.json"))))
    }

    func testTheLockIndexReservesForwardAndIsWrittenFirst() throws {
        let s = store()
        XCTAssertEqual(try s.p2pkNext(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("foxy-p2pk.json").path),
                       "reading writes nothing")
        XCTAssertEqual(try s.p2pkReserve(count: 0), 0, "a peek")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("foxy-p2pk.json").path))
        XCTAssertEqual(try s.p2pkReserve(count: 8), 0)
        XCTAssertEqual(try indexOnDisk(), 8, "on disk before the range is returned")
        XCTAssertEqual(try s.p2pkReserve(count: 1), 8)
        XCTAssertEqual(try s.p2pkNext(), 9)
        XCTAssertEqual(try store().p2pkNext(), 9, "a fresh store reads the same file")
    }

    /// Its own file, and not an entry in the counters. `parse` refuses the whole
    /// counter file when a key is not a keyset id — so an older Foxy installed
    /// over this one would find `"p2pk"` there, refuse the file and hand out no
    /// counter at all, which is a wallet that cannot make an output.
    func testTheLockIndexIsNotInTheCounterFile() throws {
        let s = store()
        _ = try s.p2pkReserve(count: 4)
        _ = try s.reserve(v00, version: 0, count: 2)
        XCTAssertEqual(try s.snapshot(), [v00: 2])
        XCTAssertEqual(try onDisk(), [v00: 2])
        let counters = try String(contentsOf: folder.appendingPathComponent("foxy-counters.json"), encoding: .utf8)
        XCTAssertFalse(counters.contains("p2pk"))
        // and an older build reads the counter file as it always did
        XCTAssertNotNil(CounterStore.parse(Data(counters.utf8)))
    }

    func testTheLockIndexStopsAtTheLastNormalChild() throws {
        let s = store()
        _ = try s.p2pkReserve(count: 1)
        try FileManager.default.removeItem(at: folder.appendingPathComponent("foxy-p2pk.json"))
        try Data("{\"next\": 2147483646}".utf8).write(to: folder.appendingPathComponent("foxy-p2pk.json"))
        let fresh = store()
        XCTAssertEqual(try fresh.p2pkNext(), 0x7FFF_FFFE)
        XCTAssertThrowsError(try fresh.p2pkReserve(count: 3)) { XCTAssertEqual($0 as? CounterStore.Failure, .outOfRange) }
        XCTAssertEqual(try fresh.p2pkNext(), 0x7FFF_FFFE, "a refused reserve moves nothing")
        XCTAssertEqual(try fresh.p2pkReserve(count: 2), 0x7FFF_FFFE)
        XCTAssertEqual(try fresh.p2pkNext(), 1 << 31)
        XCTAssertThrowsError(try fresh.p2pkReserve(count: 1))
    }

    func testAnUnreadableLockIndexHandsOutNothing() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("foxy-p2pk.json")
        for bad in ["not json", "[1,2]", "{}", "{\"next\": -1}", "{\"next\": 1.5}", "{\"next\": true}",
                    "{\"next\": \"4\"}", "{\"next\": 2147483649}", "{\"nxt\": 1}"] {
            try Data(bad.utf8).write(to: file)
            let s = store()
            XCTAssertThrowsError(try s.p2pkNext(), bad) {
                XCTAssertEqual($0 as? CounterStore.Failure, .unreadable)
            }
            XCTAssertThrowsError(try s.p2pkReserve(count: 1), bad)
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), bad, "not overwritten")
        }
        // a key this build does not know is kept, not refused: next is what matters
        try Data("{\"next\": 5, \"somethingNewer\": 1}".utf8).write(to: file)
        XCTAssertEqual(try store().p2pkNext(), 5)
    }

    /// p2pkPubkeys' served ranges are this process's, like restoreSecrets'.
    func testWhatAScanServedIsRememberedAndNeverLowered() throws {
        let s = store()
        XCTAssertEqual(s.highestP2PKServed(), 0)
        s.noteP2PKServed(end: 300)
        XCTAssertEqual(s.highestP2PKServed(), 300)
        s.noteP2PKServed(end: 100)
        XCTAssertEqual(s.highestP2PKServed(), 300, "never lower")
        s.noteP2PKServed(end: 900)
        XCTAssertEqual(s.highestP2PKServed(), 900)
        XCTAssertEqual(store().highestP2PKServed(), 0, "a new process has served nothing")
    }

    // MARK: A file that cannot be read

    func testAnUnreadableFileHandsOutNothingAndIsLeftAlone() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("foxy-counters.json")
        for bad in ["not json", "[1,2]", "{\"\(v00)\": -1}", "{\"\(v00)\": 1.5}", "{\"\(v00)\": true}",
                    "{\"\(v00)\": \"4\"}", "{\"00ZZ\": 4}", "{\"\(v00.uppercased())\": 4}", "{\"\(v00)\": 1e300}"] {
            try Data(bad.utf8).write(to: file)
            let s = store()
            XCTAssertThrowsError(try s.reserve(v00, version: 0, count: 1), bad) {
                XCTAssertEqual($0 as? CounterStore.Failure, .unreadable)
                XCTAssertEqual(($0 as? CounterStore.Failure)?.message, "the counters could not be read")
            }
            XCTAssertThrowsError(try s.snapshot())
            XCTAssertThrowsError(try s.importMax([v00: 1]))
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), bad, "a file that could not be read is not overwritten")
        }
    }

    // MARK: Moved aside

    func testMovedAsideOnReplaceOrWipeAndStartsEmpty() throws {
        let when = Date(timeIntervalSince1970: 1_800_000_123)
        let s = store(now: when)
        XCTAssertNil(try s.moveAside(), "no file, nothing to move")
        _ = try s.reserve(v00, version: 0, count: 9)
        let aside = try XCTUnwrap(try s.moveAside())
        XCTAssertEqual(aside.lastPathComponent, "foxy-counters.replaced.1800000123.json")
        XCTAssertEqual(CounterStore.parse(try Data(contentsOf: aside)), [v00: 9], "kept as it was")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("foxy-counters.json").path))
        XCTAssertEqual(try s.snapshot(), [:])
        XCTAssertEqual(try s.reserve(v00, version: 0, count: 1), 0, "the new seed's counters start at zero")
        // a second change in the same second does not overwrite the first
        let again = try XCTUnwrap(try s.moveAside())
        XCTAssertEqual(again.lastPathComponent, "foxy-counters.replaced.1800000124.json")
        XCTAssertEqual(CounterStore.parse(try Data(contentsOf: aside)), [v00: 9])
        XCTAssertEqual(try store().snapshot(), [:], "a fresh store finds no counters either")
    }

    /// The lock index belongs to the seed as much as the counters do: under a new
    /// seed every index derives a different key, so a row kept from before would
    /// name a public key this seed does not have.
    func testTheLockIndexGoesAsideWithTheCountersUnderOneStamp() throws {
        let when = Date(timeIntervalSince1970: 1_800_000_500)
        let s = store(now: when)
        _ = try s.reserve(v00, version: 0, count: 3)
        _ = try s.p2pkReserve(count: 6)
        let aside = try XCTUnwrap(try s.moveAside())
        XCTAssertEqual(aside.lastPathComponent, "foxy-counters.replaced.1800000500.json")
        let index = folder.appendingPathComponent("foxy-p2pk.replaced.1800000500.json")
        XCTAssertEqual(CounterStore.parseP2PK(try Data(contentsOf: index)), 6, "kept as it was, under the same stamp")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("foxy-p2pk.json").path))
        XCTAssertEqual(try s.p2pkNext(), 0, "the new seed's lock keys start at zero")
        XCTAssertEqual(s.highestP2PKServed(), 0)
        XCTAssertEqual(try store().p2pkNext(), 0, "a fresh store finds no index either")
    }

    func testAnIndexAloneIsStillMovedAside() throws {
        let s = store(now: Date(timeIntervalSince1970: 1_800_000_600))
        _ = try s.p2pkReserve(count: 2)
        XCTAssertNil(try s.moveAside(), "there was no counter file to return")
        XCTAssertEqual(CounterStore.parseP2PK(
            try Data(contentsOf: folder.appendingPathComponent("foxy-p2pk.replaced.1800000600.json"))), 2)
        XCTAssertEqual(try s.p2pkNext(), 0)
    }

    func testAnUnreadableFileCanStillBeMovedAside() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: folder.appendingPathComponent("foxy-counters.json"))
        let s = store()
        XCTAssertThrowsError(try s.snapshot())
        XCTAssertNotNil(try s.moveAside())
        XCTAssertEqual(try s.snapshot(), [:])
    }

    // MARK: How it is stored

    /// A Release build that has never had a counter file: a new install, or one
    /// from before stage 4. Reading makes nothing; the first write makes the
    /// folder, as Application Support may not exist yet, and the file.
    func testAStoreWithNoFileOrFolderStartsEmptyAndMakesThemOnItsFirstWrite() throws {
        let fresh = folder.appendingPathComponent("Application Support", isDirectory: true)
        let counters = CounterStore(directory: fresh)
        XCTAssertEqual(try counters.snapshot(), [:])
        XCTAssertEqual(try counters.next(v00), 0)
        XCTAssertEqual(try counters.reserve(v00, version: 0, count: 0), 0, "a peek")
        XCTAssertEqual(try counters.importMax([:]), [:])
        XCTAssertFalse(FileManager.default.fileExists(atPath: fresh.path), "reading writes nothing")
        XCTAssertEqual(try counters.importMax([v00: 4]), [v00: 4])
        let file = fresh.appendingPathComponent(CounterStore.fileName)
        XCTAssertEqual(CounterStore.parse(try Data(contentsOf: file)), [v00: 4])
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try CounterStore(directory: fresh).reserve(v00, version: 0, count: 2), 4,
                       "a new store, as after a relaunch, reads what the first wrote")
    }

    func testTheFileIsExcludedFromBackupsProtectedAndSorted() throws {
        let s = store()
        _ = try s.reserve(v01, version: 1, count: 2)
        _ = try s.reserve(v00, version: 0, count: 1)
        let file = folder.appendingPathComponent("foxy-counters.json")
        let values = try file.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true, "excluded again after the rename made a new file")
        // JSONSerialization's sorted keys compare digits as numbers ("01ab…" before "009a…"); what counts is the values
        let text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(text.count, "{\"\(v00)\":1,\"\(v01)\":2}".count)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Int], [v00: 1, v01: 2])
        if let protection = try FileManager.default.attributesOfItem(atPath: file.path)[.protectionKey] as? FileProtectionType {
            XCTAssertEqual(protection, .completeUntilFirstUserAuthentication)
        }
    }

    /// L6: a temporary file beside the counters, flushed, then renamed over them.
    /// Nothing is left behind, and a write that fails leaves the old file whole.
    func testEachWriteIsARenameOfAFlushedTemporaryFile() throws {
        let s = store()
        for n in 1...20 { _ = try s.reserve(v00, version: 0, count: n) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["foxy-counters.json"],
                       "no temporary file is left")
        XCTAssertEqual(try onDisk(), [v00: 210])
        XCTAssertNoThrow(try CounterStore.flush(folder.appendingPathComponent("foxy-counters.json")))
        XCTAssertThrowsError(try CounterStore.flush(folder.appendingPathComponent("missing")))
        // a folder that cannot be written: the write fails and the file is as it was
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path) }
        XCTAssertThrowsError(try s.reserve(v00, version: 0, count: 1)) {
            XCTAssertEqual($0 as? CounterStore.Failure, .unwritable)
        }
        XCTAssertEqual(try onDisk(), [v00: 210])
        XCTAssertEqual(try s.next(v00), 210, "memory changes only once the file has")
    }
}
