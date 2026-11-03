import XCTest
@testable import Foxy

/// The hand-off to Orbot: one tap, Orbot's approval screen, a key back.
///
/// It is a URL and nothing else, so the only thing that can be wrong with it
/// is its shape — and once its shape was wrong in a way nothing could
/// catch: Orbot opened, matched no route, and showed its home screen, which
/// looks identical to a person declining.
final class OrbotLinkTests: XCTestCase {

    /// Orbot's own links are `scheme:path` with NO host. OrbotKit sets
    /// `urlc.scheme` and `urlc.path` and never `urlc.host`, and its install
    /// check is `URL(string: "orbot:show")`. Written with `//`, the first
    /// segment becomes the HOST and Orbot matches nothing.
    func testTheRequestUrlHasNoHost() throws {
        let source = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/OrbotLink.swift"),
                                encoding: .utf8)
        // the code, not the comment above it — which quotes both forms on purpose
        let line = try XCTUnwrap(source.split(separator: "\n")
            .first { $0.contains("let url = URL(string: \"orbot:") })
        XCTAssertFalse(line.contains("orbot://"),
                       "orbot://request/token makes \"request\" the host; Orbot wants orbot:request/token")

        let text = try XCTUnwrap(line.split(separator: "\"").first { $0.hasPrefix("orbot:") }).description
        let url = try XCTUnwrap(URL(string: text))
        XCTAssertEqual(url.scheme, "orbot")
        XCTAssertNil(url.host, "the first path segment must not be read as a host")
        /* What the whole test is about is that "request" is not the host. Where
         * Foundation puts it instead is Foundation's business and it has moved:
         * `URL.path` on an opaque scheme like `orbot:request/token` returned
         * "request/token" and now returns "" (macOS 15 / iOS 18, RFC 3986
         * parsing). Asserting the old answer made this fail on an app that had
         * not changed, which is a test lying about the code.
         *
         * So it asserts what Orbot actually receives: the part after the scheme,
         * before the query, exactly as written. */
        let opaque = text.dropFirst("orbot:".count).split(separator: "?").first.map(String.init)
        XCTAssertEqual(opaque, "request/token",
                       "Orbot reads everything between the scheme and the query")

        // and the three names are OrbotKit's own
        let query = try XCTUnwrap(URLComponents(string: text)?.queryItems)
        let names = Set(query.map(\.name))
        XCTAssertTrue(names.contains("app-id"), "OrbotKit reads app-id")
        XCTAssertTrue(names.contains("need-bypass"), "OrbotKit reads need-bypass")
        XCTAssertTrue(names.contains("app-name"), "OrbotKit reads app-name")
        XCTAssertEqual(query.first { $0.name == "need-bypass" }?.value, "true",
                       "without the bypass Foxy's own Tor still cannot run inside Orbot")
        XCTAssertEqual(query.first { $0.name == "app-id" }?.value, "io.getfoxi.foxy")
    }

    /// A hand-off that never comes back must say so. It used to give up in
    /// silence after two minutes, so a wrong URL and a declined approval were
    /// indistinguishable in the log.
    func testGivingUpIsSaidOutLoud() throws {
        let source = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/OrbotLink.swift"),
                                encoding: .utf8)
        XCTAssertTrue(source.contains("asked for a key two minutes ago and none came back"),
                      "the two-minute give-up is silent again")
    }

    /// A key is one put on the clipboard after Orbot's screen was opened. Any
    /// UUID that happened to be there was stored as Orbot's key, and with a VPN
    /// up, whatever answered on Orbot's port with it chose the port Foxy's Tor
    /// went out through.
    func testOnlyAKeyPutThereAfterTheAskIsTaken() {
        let key = "3F2504E0-4F89-41D3-9A0C-0305E82C3301"
        XCTAssertEqual(OrbotLink.keyFromClipboard(key, changeCount: 8, askedAt: 7), key)
        XCTAssertEqual(OrbotLink.keyFromClipboard("  \(key)\n", changeCount: 8, askedAt: 7), key, "trimmed as Orbot copies it")
        XCTAssertNil(OrbotLink.keyFromClipboard(key, changeCount: 7, askedAt: 7), "on the clipboard before the ask")
        XCTAssertNil(OrbotLink.keyFromClipboard(key, changeCount: 6, askedAt: 7))
        XCTAssertNil(OrbotLink.keyFromClipboard(key, changeCount: 8, askedAt: nil), "nothing was asked for")
        XCTAssertNil(OrbotLink.keyFromClipboard("not a key", changeCount: 8, askedAt: 7))
        XCTAssertNil(OrbotLink.keyFromClipboard(nil, changeCount: 8, askedAt: 7))
    }

    /// And a key taken is not kept until Orbot itself has answered 200 to it:
    /// 403 drops it, and no answer holds it to be asked about again.
    func testAKeyIsKeptOnlyOnceOrbotAnswers200() throws {
        XCTAssertEqual(OrbotLink.KeyAnswer.after(code: 200), .confirmed)
        XCTAssertEqual(OrbotLink.KeyAnswer.after(code: 403), .refused)
        for code in [nil, 500, 404, 0] as [Int?] {
            XCTAssertEqual(OrbotLink.KeyAnswer.after(code: code), .unanswered, "\(String(describing: code))")
        }
        let source = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/OrbotLink.swift"), encoding: .utf8)
        let pick = try XCTUnwrap(source.components(separatedBy: "private static func pickUpKey()").last)
        XCTAssertFalse(pick.prefix(900).contains("SeedStore.save"), "a key from the clipboard is stored before Orbot confirms it")
        XCTAssertTrue(source.contains("askedAtChange = UIPasteboard.general.changeCount"), "the count is not taken before the link opens")
    }
}
