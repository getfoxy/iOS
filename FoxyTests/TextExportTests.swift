import XCTest
#if canImport(FoxyTextExport)
@testable import FoxyTextExport
#else
@testable import Foxy
#endif

/// A text kept outside Foxy (Foxy/Bridge/TextExport.swift): a file of its own,
/// named for what it is and the day, removed with its folder, and never the
/// pasteboard. Runs in FoxyTests and in tools/nativetests, where the file is its
/// own module, FoxyTextExport. The share sheet itself needs a phone.
final class TextExportTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("text-export-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testTheTextIsWrittenToAFileOfItsOwnAndRemovedWithItsFolder() throws {
        let text = "cashuBo2FtdGh0dHBzOi8vbS50ZXN0\n\ncashuBo2FtdGh0dHBzOi8vbS50ZXN1"
        let day = Date(timeIntervalSince1970: 1_793_232_000)
        let file = try TextExport.write(text, label: "unclaimed tokens", in: dir, at: day)
        XCTAssertEqual(file.lastPathComponent, TextExport.fileName("unclaimed tokens", at: day))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), text)
        XCTAssertTrue(file.deletingLastPathComponent().lastPathComponent.hasPrefix("foxy-export-"))
        let second = try TextExport.write(text, label: "unclaimed tokens", in: dir, at: day)
        XCTAssertNotEqual(file.deletingLastPathComponent(), second.deletingLastPathComponent(), "two exports never share a folder")
        TextExport.remove(file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.deletingLastPathComponent().path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path), "removing one export leaves the other")
        TextExport.removeLeftovers(in: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }

    func testTheNameSaysWhatItIsAndTheDayAndNothingElse() {
        let day = Date(timeIntervalSince1970: 1_793_232_000)
        XCTAssertEqual(TextExport.fileName("unclaimed tokens", at: day), "Foxy unclaimed tokens 2026-10-29.txt")
        XCTAssertEqual(TextExport.fileName("../../etc/passwd", at: day), "Foxy etcpasswd 2026-10-29.txt", "no path in a name the page gives")
        XCTAssertEqual(TextExport.fileName("", at: day), "Foxy export 2026-10-29.txt")
    }

    func testNothingEmptyOrBoundlessIsExported() {
        XCTAssertEqual(TextExport.check("  \n "), .empty)
        XCTAssertNil(TextExport.check("cashuB"))
        XCTAssertEqual(TextExport.check(String(repeating: "a", count: TextExport.maxCharacters + 1)), .tooLong)
        XCTAssertThrowsError(try TextExport.write("", label: "x", in: dir, at: Date()))
    }

    func testCopyIsLeftOutOfTheSheet() {
        XCTAssertTrue(TextExport.excludedActivities.contains("com.apple.UIKit.activity.CopyToPasteboard"),
                      "the general pasteboard syncs to other devices and never expires")
    }
}
