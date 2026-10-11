import XCTest
@testable import Foxy

/// The page hash, run: manifestHash (WebHostController, in FoxyWebView.swift)
/// over a small folder whose number tools/page-hash.py also has to print. Smoke
/// check 41 builds the same folder for the tool and expects the same sixty-four
/// characters, so a rule that drifts on one side fails on that side.
final class PageHashTests: XCTestCase {

    /// What both sides must make of the folder below. smoke.py reads this line.
    static let expected = "e88922f6a46cdc3d963a5be1b22963547711e6b1615869e9143337a92edc88a1"

    /// The folder: files at the top, in a folder and in a folder inside it;
    /// names that sort differently as bytes than by eye (`img-x.js` before
    /// `img/…` before `ind`); an empty file, an empty folder, and the three
    /// places a dot can hide a file.
    static let files: [(String, [UInt8])] = [
        ("index.html", Array("<p>page</p>\n".utf8)),
        ("ind", []),
        ("img-x.js", Array("x".utf8)),
        ("b.js", Array("b".utf8)),
        ("img/a.png", [0x89, 0x50, 0x4E, 0x47]),
        ("img/deep/c.txt", Array("c".utf8)),
        (".DS_Store", Array("x".utf8)),
        (".hidden/in.js", Array("x".utf8)),
        ("img/.keep", []),
    ]

    private var dir: URL!

    override func setUpWithError() throws {
        let fm = FileManager.default
        dir = fm.temporaryDirectory.appendingPathComponent("page-hash-\(UUID().uuidString)", isDirectory: true)
        for (path, bytes) in Self.files {
            let file = dir.appendingPathComponent(path)
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(bytes).write(to: file)
        }
        try fm.createDirectory(at: dir.appendingPathComponent("empty"), withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
    }

    func testTheFolderHashesToTheNumberTheToolPrints() {
        XCTAssertEqual(WebHostController.manifestHash(of: dir), Self.expected)
    }

    /// The bug this file was written after: one folder in Web/ and the phone
    /// showed no number at all.
    func testAFolderDoesNotEmptyTheHash() throws {
        let flat = FileManager.default.temporaryDirectory.appendingPathComponent("page-hash-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: flat) }
        try FileManager.default.createDirectory(at: flat.appendingPathComponent("img"), withIntermediateDirectories: true)
        try Data("a".utf8).write(to: flat.appendingPathComponent("index.html"))
        let before = WebHostController.manifestHash(of: flat)
        XCTAssertEqual(before.count, 64)
        try Data("b".utf8).write(to: flat.appendingPathComponent("img/card.png"))
        let after = WebHostController.manifestHash(of: flat)
        XCTAssertEqual(after.count, 64)
        XCTAssertNotEqual(after, before, "a file in a folder is under the number")
    }

    func testAFileInAFolderChangesTheNumber() throws {
        try Data("d".utf8).write(to: dir.appendingPathComponent("img/deep/c.txt"))
        let changed = WebHostController.manifestHash(of: dir)
        XCTAssertEqual(changed.count, 64)
        XCTAssertNotEqual(changed, Self.expected)
    }

    func testDotFilesDoNotChangeTheNumber() throws {
        try Data("y".utf8).write(to: dir.appendingPathComponent("img/.DS_Store"))
        try Data("y".utf8).write(to: dir.appendingPathComponent(".hidden/in.js"))
        XCTAssertEqual(WebHostController.manifestHash(of: dir), Self.expected)
    }

    func testALinkGetsNoNumber() throws {
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent("img/link.js"),
                                                   withDestinationURL: dir.appendingPathComponent("b.js"))
        XCTAssertEqual(WebHostController.manifestHash(of: dir), "")
    }

    func testNothingToHashGetsNoNumber() throws {
        let fm = FileManager.default
        let none = fm.temporaryDirectory.appendingPathComponent("page-hash-\(UUID().uuidString)")
        XCTAssertEqual(WebHostController.manifestHash(of: none), "", "no folder")
        defer { try? fm.removeItem(at: none) }
        try fm.createDirectory(at: none.appendingPathComponent("img"), withIntermediateDirectories: true)
        XCTAssertEqual(WebHostController.manifestHash(of: none), "", "folders and no file")
    }
}
