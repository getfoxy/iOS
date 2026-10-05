import XCTest
@testable import Foxy

/// The relay directory Foxy ships with (Foxy/Tor/TorSeed.swift).
///
/// None of this is a security boundary — Tor verifies every microdescriptor
/// against the signed consensus whatever the seed says — so what is pinned
/// here is that the seed is real, that it unpacks, and that it never stands on
/// a directory the phone has already built for itself.
final class TorSeedTests: XCTestCase {

    private func scratch() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("torseed-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// The bundled file is there, and is the directory it claims to be.
    func testTheBundledSeedUnpacksIntoMicrodescriptors() throws {
        let bundle = Bundle(for: TorSeedTests.self)
        guard let url = bundle.url(forResource: TorSeed.resource, withExtension: "xz")
                ?? Bundle.main.url(forResource: TorSeed.resource, withExtension: "xz") else {
            return XCTFail("no \(TorSeed.resource).xz in the bundle — run tools/make-tor-seed.sh")
        }
        let packed = try Data(contentsOf: url)
        XCTAssertGreaterThan(packed.count, 100_000, "the seed is too small to be a relay directory")
        XCTAssertLessThan(packed.count, 8_000_000, "the seed has outgrown what belongs in the bundle")

        let plain = try XCTUnwrap(TorSeed.unpack(packed), "the seed did not unpack")
        XCTAssertGreaterThan(plain.count, 1_000_000)
        // Tor's own format: every entry annotated, every entry an onion key
        let head = String(decoding: plain.prefix(200), as: UTF8.self)
        XCTAssertTrue(head.hasPrefix("@last-listed "), "not Tor's microdescriptor cache: \(head.prefix(40))")
        let text = String(decoding: plain, as: UTF8.self)
        // "ntor-onion-key" has no newline straight after it, so only the RSA
        // line each microdescriptor opens with is counted here
        let annotations = text.components(separatedBy: "@last-listed ").count - 1
        let bodies = text.components(separatedBy: "onion-key\n").count - 1
        XCTAssertGreaterThan(annotations, 1000, "only \(annotations) relays in the seed")
        XCTAssertEqual(annotations, bodies, "an annotation without a microdescriptor behind it")
    }

    /// Rubbish in, nothing out — never a half-written cache.
    func testSomethingThatIsNotTheSeedUnpacksToNothing() {
        XCTAssertNil(TorSeed.unpack(Data("not compressed at all".utf8)))
        XCTAssertNil(TorSeed.unpack(Data()))
    }

    /// A directory Tor has already built is never replaced by the bundle's.
    func testAnExistingCacheIsLeftAlone() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = dir.appendingPathComponent(TorSeed.cacheName)
        let mine = Data("@last-listed 2026-09-20 00:00:00\nonion-key\n".utf8)
        try mine.write(to: cache)

        XCTAssertFalse(TorSeed.plant(in: dir), "the seed overwrote a cache Tor was keeping")
        XCTAssertEqual(try Data(contentsOf: cache), mine)
    }

    /// A first run gets one, and it is what the bundle holds.
    func testAFirstRunIsGivenTheDirectory() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = dir.appendingPathComponent(TorSeed.cacheName)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path))

        let bundle = Bundle(for: TorSeedTests.self)
        guard bundle.url(forResource: TorSeed.resource, withExtension: "xz") != nil
                || Bundle.main.url(forResource: TorSeed.resource, withExtension: "xz") != nil else {
            throw XCTSkip("no seed in the test bundle")
        }
        XCTAssertTrue(TorSeed.plant(in: dir, bundle: bundle.url(forResource: TorSeed.resource, withExtension: "xz") != nil ? bundle : .main))
        let written = try Data(contentsOf: cache)
        XCTAssertGreaterThan(written.count, 1_000_000)
        XCTAssertTrue(String(decoding: written.prefix(13), as: UTF8.self) == "@last-listed ")
        // and nothing half-written left beside it
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path + ".seed"))
    }
}
