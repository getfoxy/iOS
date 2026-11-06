import XCTest
@testable import Foxy

/// The push token and the secret a build of 2026-11-05 kept go at launch (RetiredKeys.swift, FoxyApp.swift).
///
/// Runs in FoxyTests and in tools/nativetests.
final class RetiredKeysTests: XCTestCase {

    func testTheThreeItemsAreGoneAndNothingElse() {
        var store = ["foxy.wake.token": String(repeating: "a", count: 64),
                     "foxy.wake.secret": String(repeating: "b", count: 64),
                     "foxy.wake.told": String(repeating: "a", count: 64),
                     "foxy.seed.v2.held": "1"]
        RetiredKeys.remove { store[$0] = nil }
        XCTAssertNil(store["foxy.wake.token"])
        XCTAssertNil(store["foxy.wake.secret"])
        XCTAssertNil(store["foxy.wake.told"])
        XCTAssertEqual(store, ["foxy.seed.v2.held": "1"])
        // with none there, nothing changes and nothing fails
        RetiredKeys.remove { store[$0] = nil }
        XCTAssertEqual(store, ["foxy.seed.v2.held": "1"])
    }

    #if os(iOS)
    /// The app's own Keychain, on the simulator: the three items written as the earlier build wrote them, then gone.
    func testTheKeychainItemsAreGone() {
        for key in RetiredKeys.keys { XCTAssertTrue(SeedStore.save(String(repeating: "c", count: 64), key: key)) }
        RetiredKeys.remove()
        for key in RetiredKeys.keys { XCTAssertNil(SeedStore.load(key: key), key) }
    }
    #endif

    func testTheLaunchRemovesThem() throws {
        let app = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/FoxyApp.swift"), encoding: .utf8)
        XCTAssertTrue(app.contains("RetiredKeys.remove()"), "FoxyApp's launch calls RetiredKeys.remove()")
    }
}
