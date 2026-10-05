import XCTest
@testable import Foxy

/// CounterRules: one counter per derivation path, and how far a counter may move
/// (review H1, M1, L9). Runs in FoxyTests and in tools/nativetests.
final class CounterRulesTests: XCTestCase {
    /// Four `00` ids NUT-13 derives with the same index, 864559728.
    static let aliases = ["009a1f293253e41e", "0000000033882270", "009a1f29b253e41d", "009a1f28b253e41f"]
    private let v01 = "01" + String(repeating: "ab", count: 32)

    // MARK: Slots

    func testTheFourAliasIdsAreOneSlot() {
        for id in Self.aliases {
            XCTAssertEqual(NUT13.derivationIndex(id), 864_559_728, id)
            XCTAssertEqual(CounterRules.slot(id), "00:864559728", id)
            XCTAssertEqual(CounterRules.slot(id.uppercased()), "00:864559728", "\(id) in capitals")
        }
        XCTAssertNotEqual(CounterRules.slot("00b4cd27d8861a44"), CounterRules.slot(Self.aliases[0]))
    }

    func testA01KeysetIsItsOwnIdAndAnythingElseHasNoSlot() {
        XCTAssertEqual(CounterRules.slot(v01), v01)
        XCTAssertEqual(CounterRules.slot(v01.uppercased()), v01)
        XCTAssertNil(NUT13.derivationIndex(v01))
        for bad in ["", "00", "I2yN+iRYfkzT", "02" + String(repeating: "ab", count: 32), "009a1f293253e41g"] {
            XCTAssertNil(CounterRules.slot(bad), bad)
        }
    }

    func testAnAliasIsStoredUnderTheFirstIdOfItsSlot() {
        let stored = [Self.aliases[2], "00b4cd27d8861a44", v01]
        for id in Self.aliases {
            XCTAssertEqual(CounterRules.storedKey(id, in: stored), Self.aliases[2], id)
            XCTAssertEqual(CounterRules.storedKey(id.uppercased(), in: stored), Self.aliases[2])
        }
        XCTAssertEqual(CounterRules.storedKey("00B4CD27D8861A44", in: stored), "00b4cd27d8861a44")
        XCTAssertEqual(CounterRules.storedKey("00c0ffee00c0ffee", in: stored), "00c0ffee00c0ffee", "a new keyset is its own id")
        XCTAssertEqual(CounterRules.storedKey(Self.aliases[0], in: [String]()), Self.aliases[0])
        XCTAssertEqual(CounterRules.storedKey(v01.uppercased(), in: stored), v01)
    }

    func testAFileWithAliasesIsMergedAtTheLargestValue() {
        let merged = CounterRules.merged([Self.aliases[0]: 40, Self.aliases[1]: 900, Self.aliases[3]: 7, v01: 3, "00b4cd27d8861a44": 12])
        XCTAssertEqual(merged, [Self.aliases[1]: 900, v01: 3, "00b4cd27d8861a44": 12])
        XCTAssertEqual(CounterRules.merged([Self.aliases[2]: 5, Self.aliases[0]: 5]), [Self.aliases[0]: 5],
                       "a tie keeps the smaller id, whatever order the file had")
        XCTAssertEqual(CounterRules.merged([:]), [:])
    }

    // MARK: Moves

    func testAdvanceGoesAHundredPastTheCounter() {
        XCTAssertEqual(CounterRules.advance(current: 0, next: 100, highest: 0, version: 0), .allowed)
        XCTAssertEqual(CounterRules.advance(current: 0, next: 101, highest: 0, version: 0), .tooFarAhead)
        XCTAssertEqual(CounterRules.advance(current: 40, next: 140, highest: 0, version: 1), .allowed)
        XCTAssertEqual(CounterRules.advance(current: 40, next: 10_040, highest: 0, version: 1), .tooFarAhead)
        XCTAssertEqual(CounterRules.advance(current: 40, next: 12, highest: 0, version: 0), .allowed, "lower moves nothing")
        XCTAssertEqual(CounterRules.advance(current: 40, next: 40, highest: 0, version: 0), .allowed)
    }

    func testAdvanceGoesAsFarAsARestoreServed() {
        XCTAssertEqual(CounterRules.advance(current: 40, next: 340, highest: 340, version: 0), .allowed)
        XCTAssertEqual(CounterRules.advance(current: 40, next: 341, highest: 340, version: 0), .tooFarAhead)
        XCTAssertEqual(CounterRules.advance(current: 0, next: 20_000, highest: 20_000, version: 1), .allowed)
        XCTAssertEqual(CounterRules.advance(current: 500, next: 600, highest: 300, version: 1), .allowed,
                       "a restore that served less than the counter leaves the hundred")
    }

    func testAdvanceStopsAtTheVersionsCeiling() {
        let top00: UInt64 = 1 << 31, top01: UInt64 = 1 << 53
        XCTAssertEqual(CounterRules.ceiling(version: 0), top00)
        XCTAssertEqual(CounterRules.ceiling(version: 1), top01)
        XCTAssertEqual(CounterRules.advance(current: top00 - 50, next: top00, highest: 0, version: 0), .allowed)
        XCTAssertEqual(CounterRules.advance(current: top00 - 50, next: top00 + 1, highest: 0, version: 0), .tooFarAhead)
        XCTAssertEqual(CounterRules.advance(current: 0, next: top00 + 1, highest: .max, version: 0), .tooFarAhead,
                       "not even a restore's end moves a 00 counter past 2^31")
        XCTAssertEqual(CounterRules.advance(current: top01 - 1, next: top01, highest: 0, version: 1), .allowed)
        XCTAssertEqual(CounterRules.advance(current: top01 - 1, next: top01 + 1, highest: 0, version: 1), .tooFarAhead)
        XCTAssertEqual(CounterRules.advance(current: .max - 10, next: .max, highest: 0, version: 1), .tooFarAhead)
    }

    func testReserveAtStartsAtMostAHundredPastTheCounter() {
        XCTAssertEqual(CounterRules.reserveAt(current: 0, start: 100), .allowed)
        XCTAssertEqual(CounterRules.reserveAt(current: 0, start: 101), .tooFarAhead)
        XCTAssertEqual(CounterRules.reserveAt(current: 1_000, start: 1_100), .allowed)
        XCTAssertEqual(CounterRules.reserveAt(current: 1_000, start: 5_000), .tooFarAhead)
        XCTAssertEqual(CounterRules.reserveAt(current: 12, start: 12), .allowed)
    }

    func testImportedValuesAreCutToTheCeiling() {
        XCTAssertEqual(CounterRules.capped(9_007_199_254_740_991, version: 0), 1 << 31)
        XCTAssertEqual(CounterRules.capped(9_007_199_254_740_991, version: 1), 9_007_199_254_740_991)
        XCTAssertEqual(CounterRules.capped(.max, version: 1), 1 << 53)
        XCTAssertEqual(CounterRules.capped(44, version: 0), 44)
        XCTAssertEqual(CounterRules.mostKeysets, 256)
        XCTAssertEqual(CounterRules.reach, 100)
    }
}
