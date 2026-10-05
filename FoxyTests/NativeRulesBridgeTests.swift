import XCTest
@testable import Foxy

/// The half of `tests/fixtures/native-rules.json` that `Foxy/Bridge` owns.
///
/// The Swift package (`swift test --package-path tools/nativetests`) builds
/// `Foxy/Keychain` alone, so it cannot see the bridge's batch limit, the pause
/// after a cancelled read, or the words the bridge itself refuses with.
/// `NativeRulesTests` checks everything the Keychain owns and runs in both
/// places; this one runs on the simulator, where the whole app is built
/// (`sh tools/unit-tests.sh`).
final class NativeRulesBridgeTests: XCTestCase {

    private func table() throws -> (rules: [String: Any], says: [String: String]) {
        let url = repoRoot().appendingPathComponent("tests/fixtures/native-rules.json")
        let object = try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any]
        let loaded = try XCTUnwrap(object, "tests/fixtures/native-rules.json did not load")
        return (try XCTUnwrap(loaded["rules"] as? [String: Any]),
                try XCTUnwrap(loaded["says"] as? [String: String]))
    }

    func testTheBatchLimitAndThePauseAfterACancelledRead() throws {
        let (rules, _) = try table()
        XCTAssertEqual(FoxyBridge.largestSecretsBatch,
                       try XCTUnwrap(rules["batch"] as? NSNumber).intValue)
        // the table is in milliseconds; the Swift is a TimeInterval in seconds
        let ms = try XCTUnwrap(rules["showAfterCancelMs"] as? NSNumber).doubleValue
        XCTAssertEqual(SeedScreens.showPause.span, ms / 1000)
    }

    func testTheWordsTheScreensRefuseWith() throws {
        let (_, says) = try table()
        XCTAssertEqual(SeedScreens.busyRefusal, says["screenOpen"])
        XCTAssertEqual(SeedScreens.pauseRefusal, says["again"])
    }

    /// "bad request" is written inline at every input check, so it is asserted
    /// by asking for one: a range with no count is refused with those words.
    func testAnInputCheckRefusesWithTheWordsInTheTable() throws {
        let (_, says) = try table()
        let bad = try XCTUnwrap(says["bad"])
        XCTAssertEqual(FoxyBridge.restoreSecretsCheck(["keysetId": "00b4cd27d8861a44", "start": 0]), .refuse(bad))
        XCTAssertEqual(FoxyBridge.counterReserveAtCheck(["keysetId": "00b4cd27d8861a44"]), .refuse(bad))
    }

    /// The rest are raised where they are written, with no value to read back.
    func testTheRefusalsWrittenWhereTheyAreRaised() throws {
        let (_, says) = try table()
        let path = "Foxy/Bridge/NativeSeedBridge.swift"
        let source = try String(contentsOf: repoRoot().appendingPathComponent(path), encoding: .utf8)
        let code = source.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        for key in ["noSeed", "cancelled", "notErased"] {
            let text = try XCTUnwrap(says[key])
            XCTAssertTrue(code.contains { $0.contains("\"\(text)\"") },
                          "says.\(key) is \"\(text)\" in the table, and no line of \(path) says it")
        }
    }
}
