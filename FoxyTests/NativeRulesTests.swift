import XCTest
@testable import Foxy

/// The native seed's rules, against the one file that holds them.
///
/// The rules were written twice: in the Swift that ships, and again in
/// `tests/harness.js`'s phone mock, which is what every wallet test runs
/// against. Kept in step by hand, they drift, and the drift is invisible — the
/// page keeps passing against a mock that no longer describes the phone.
///
/// `tests/fixtures/native-rules.json` is now the only copy. The harness reads
/// it; this compares it with the Swift, so a rule cannot change on one side
/// alone. Its `asserted` map says which side checks what, and why: the Swift
/// package builds `Foxy/Keychain` alone, so anything `Foxy/Bridge` owns is
/// checked by `NativeRulesBridgeTests` on the simulator instead.
///
/// Runs in FoxyTests and in tools/nativetests.
final class NativeRulesTests: XCTestCase {

    // MARK: The table

    static let table: [String: Any] = {
        let url = repoRoot().appendingPathComponent("tests/fixtures/native-rules.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }()

    private func rules() throws -> [String: Any] {
        try XCTUnwrap(Self.table["rules"] as? [String: Any], "tests/fixtures/native-rules.json did not load")
    }

    private func says() throws -> [String: String] {
        try XCTUnwrap(Self.table["says"] as? [String: String], "tests/fixtures/native-rules.json did not load")
    }

    private func number(_ key: String) throws -> UInt64 {
        let value = try XCTUnwrap(try rules()[key] as? NSNumber, "rules.\(key) is missing")
        return value.uint64Value
    }

    /// Everything the table names is checked by one side or the other, and the
    /// two sides do not overlap. Without this a value could be added to the
    /// table, used by the mock, and compared with nothing.
    func testEverySideOfTheTableIsAccountedFor() throws {
        let asserted = try XCTUnwrap(Self.table["asserted"] as? [String: [String]])
        let named = asserted.values.flatMap { $0 }.sorted()
        XCTAssertEqual(named.count, Set(named).count, "a value is claimed by both sides")
        let all = (try rules().keys.map { "rules.\($0)" } + (try says().keys.map { "says.\($0)" })).sorted()
        XCTAssertEqual(named, all, "the table and its `asserted` map disagree about what exists")
        let where_ = try XCTUnwrap(Self.table["where"] as? [String: String])
        XCTAssertEqual(where_.keys.sorted(), all, "every value names the Swift it mirrors")
    }

    // MARK: Numbers the Keychain owns

    func testHowFarARestoreReaches() throws {
        XCTAssertEqual(RestoreWindow.beyond, try number("window"))
        XCTAssertEqual(RestoreWindow.candidateCap, try number("candidateCap"))
        XCTAssertEqual(UInt64(SeedCandidates.most), try number("candidates"))
    }

    func testHowFarACounterMoves() throws {
        XCTAssertEqual(CounterRules.reach, try number("ahead"))
        XCTAssertEqual(UInt64(CounterRules.mostKeysets), try number("keysets"))
    }

    /// The lock keys a payment request locks ecash to (P2PK.swift).
    func testHowManyLockKeysAtATime() throws {
        XCTAssertEqual(UInt64(P2PK.mostReserved), try number("lockBatch"))
        XCTAssertEqual(UInt64(P2PK.mostScanned), try number("lockScan"))
        XCTAssertEqual(P2PK.lastScanned, try number("lockCap"))
        // the mock reads the lock index's ceiling out of largestNext["00"]: a
        // normal BIP-32 index and a hardened one both stop one below 2^31
        XCTAssertEqual(P2PK.largestNext, CounterRules.ceiling(version: 0))
        // and the window a private key may be asked in is the restore window's own
        XCTAssertEqual(P2PK.beyond, RestoreWindow.beyond)
    }

    func testTheCeilingOfEachKeysetVersion() throws {
        let largest = try XCTUnwrap(try rules()["largestNext"] as? [String: NSNumber])
        XCTAssertEqual(CounterRules.ceiling(version: 0), try XCTUnwrap(largest["00"]).uint64Value)
        XCTAssertEqual(CounterRules.ceiling(version: 1), try XCTUnwrap(largest["01"]).uint64Value)
    }

    // MARK: Words the Keychain says

    /// The refusals with a value to compare: the counter store's failures, and
    /// what SeedActions turns a candidate's failure into.
    func testTheRefusalsWithAValueToCompare() throws {
        let says = try says()
        XCTAssertEqual(CounterStore.Failure.alreadyIssued.message, says["issued"])
        XCTAssertEqual(CounterStore.Failure.tooFarAhead.message, says["ahead"])
        XCTAssertEqual(CounterStore.Failure.outOfRange.message, says["outOfRange"])
        XCTAssertEqual(CounterStore.Failure.alreadyImported.message, says["imported"])
        XCTAssertEqual(CounterStore.Failure.tooManyKeysets.message, says["keysets"])
        XCTAssertEqual(SeedMigrationWindow.noMigration, says["noMigration"])
        XCTAssertEqual(SeedActions.problem(SeedCandidates.Failure.unknown), says["unknown"])
        XCTAssertEqual(SeedActions.problem(SeedCandidates.Failure.outsideWindow), says["window"])
        XCTAssertEqual(SeedActions.problem(SeedCandidates.Failure.full), says["full"])
    }

    /// The rest are written where they are raised, with no value to read back.
    /// Asserted as the words in the file that `where` names — the same way
    /// BridgeTests holds the bridge's action table against THREAT-MODEL.md.
    func testTheRefusalsWrittenWhereTheyAreRaised() throws {
        let says = try says()
        for key in ["unreadable", "exists", "unchanged", "lockWindow"] {
            let text = try XCTUnwrap(says[key])
            try assertSwiftSays(text, in: "Foxy/Keychain/SeedActions.swift", key: key)
        }
    }

    /// The literal is in the named file, outside a comment.
    func assertSwiftSays(_ text: String, in path: String, key: String,
                         file: StaticString = #filePath, line: UInt = #line) throws {
        let source = try String(contentsOf: repoRoot().appendingPathComponent(path), encoding: .utf8)
        let code = source.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        XCTAssertTrue(code.contains { $0.contains("\"\(text)\"") },
                      "says.\(key) is \"\(text)\" in the table, and no line of \(path) says it",
                      file: file, line: line)
    }
}
