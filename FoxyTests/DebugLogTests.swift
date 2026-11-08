#if DEBUG
import XCTest
@testable import Foxy

/// The Debug file log: a rotation leaves the current run in foxy.log, and every
/// file the log makes is given the class a locked phone can still copy.
///
/// A pull of a locked phone read foxy.log.1 and came back with an empty
/// foxy.log, while the same pull unlocked read the current file whole. The
/// simulator keeps no protection class, so the class is checked by the calls
/// that set it: the folder and every newly made file, the one after a rotation
/// included.
final class DebugLogTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("debuglog-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func text(_ name: String) -> String {
        (try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)) ?? ""
    }

    func testAFreshAndARotatedFileAreBothGivenTheClassAndKeepWriting() {
        var protected: [String] = []
        let log = DebugLogFile(folder: folder, mostBytes: 2_000) { protected.append($0.lastPathComponent) }
        XCTAssertEqual(DebugLogFile.protection, .completeUntilFirstUserAuthentication)

        log.append("first")
        XCTAssertEqual(protected, ["foxy.log"], "a freshly made file was not given the class")

        for n in 0..<60 { log.append("line \(n) " + String(repeating: "x", count: 50)) }
        log.close()
        XCTAssertTrue(text("foxy.log.1").contains("first"), "it never rotated")
        XCTAssertTrue(text("foxy.log").contains("line 59 "), "the lines after the rotation are not in foxy.log")
        XCTAssertGreaterThanOrEqual(protected.count, 2)
        XCTAssertEqual(Set(protected), ["foxy.log"], "only the current file is opened and given the class")
    }
}
#endif
