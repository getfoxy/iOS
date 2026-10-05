import XCTest
@testable import Foxy

/// seedMigrate's one-time window (Foxy/Keychain/SeedMigrationWindow.swift).
/// Runs in FoxyTests and in tools/nativetests.
final class SeedMigrationWindowTests: XCTestCase {
    func testOpenOnlyOnAnInstallWithPageStorageThatHasNotClosed() {
        XCTAssertTrue(SeedMigrationWindow.open(closed: false, hadPageStorage: true))
        XCTAssertFalse(SeedMigrationWindow.open(closed: true, hadPageStorage: true), "closed stays closed")
        XCTAssertFalse(SeedMigrationWindow.open(closed: false, hadPageStorage: false), "a fresh install has nothing to move")
        XCTAssertFalse(SeedMigrationWindow.open(closed: true, hadPageStorage: false))
    }

    /// Review M4: closed, a saved seed is still compared; only a
    /// write needs the window open.
    func testAWriteNeedsTheWindowOpenAndASavedSeedIsComparedEitherWay() {
        for open in [true, false] {
            XCTAssertEqual(SeedMigrationWindow.step(open: open, saved: .found(same: true)), .answer(.same), "open \(open)")
            XCTAssertEqual(SeedMigrationWindow.step(open: open, saved: .found(same: false)), .answer(.different), "open \(open)")
            XCTAssertEqual(SeedMigrationWindow.step(open: open, saved: .failed), .answer(.refused("the seed could not be read")))
        }
        XCTAssertEqual(SeedMigrationWindow.step(open: true, saved: .absent), .write)
        XCTAssertEqual(SeedMigrationWindow.step(open: false, saved: .absent), .answer(.refused("no migration here")))
    }

    /// L12: the close decision, apart from the handler.
    func testOnlyAnAnswerAboutTheWordsClosesTheWindow() {
        XCTAssertTrue(SeedMigrationWindow.closes(after: .migrated))
        XCTAssertTrue(SeedMigrationWindow.closes(after: .same))
        XCTAssertTrue(SeedMigrationWindow.closes(after: .different))
        for why in ["the seed could not be read", "Face ID or the passcode was cancelled", "the keychain refused the write",
                    "no migration here", "the words could not be read"] {
            XCTAssertFalse(SeedMigrationWindow.closes(after: .refused(why)), why)
        }
    }

    func testPageStorageIsFoundOnlyWhereWebKitKeepsLocalStorage() throws {
        let fm = FileManager.default
        let library = fm.temporaryDirectory.appendingPathComponent("foxy-window-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: library) }

        XCTAssertFalse(SeedMigrationWindow.pageStorageExists(in: library), "no WebKit folder at all")

        let caches = library.appendingPathComponent("WebKit/WebsiteDataStore/abc/Caches", isDirectory: true)
        try fm.createDirectory(at: caches, withIntermediateDirectories: true)
        try Data("cache".utf8).write(to: caches.appendingPathComponent("cache.db"))
        XCTAssertFalse(SeedMigrationWindow.pageStorageExists(in: library), "other WebKit data is not page storage")

        let storage = library.appendingPathComponent("WebKit/WebsiteDataStore/abc/Origins/x/LocalStorage", isDirectory: true)
        try fm.createDirectory(at: storage, withIntermediateDirectories: true)
        let file = storage.appendingPathComponent("localstorage.sqlite3")
        try Data().write(to: file)
        XCTAssertFalse(SeedMigrationWindow.pageStorageExists(in: library), "an empty file holds nothing")

        try Data("SQLite format 3".utf8).write(to: file)
        XCTAssertTrue(SeedMigrationWindow.pageStorageExists(in: library))
    }

    func testClosingIsForGood() throws {
        let suite = "foxy.tests.window.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(defaults.bool(forKey: SeedMigrationWindow.closedKey))
        SeedMigrationWindow.close("a test", defaults: defaults)
        XCTAssertTrue(defaults.bool(forKey: SeedMigrationWindow.closedKey))
        SeedMigrationWindow.close("again", defaults: defaults)
        XCTAssertTrue(defaults.bool(forKey: SeedMigrationWindow.closedKey))
    }
}
