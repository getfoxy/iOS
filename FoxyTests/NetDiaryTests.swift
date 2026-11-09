import XCTest
#if canImport(FoxyNetDiary)
@testable import FoxyNetDiary
#else
@testable import Foxy
#endif

/// The connection diary's lines and the test mint's request mark
/// (Foxy/Debug/NetDiary.swift), and the field log's redaction run over them
/// (Foxy/Debug/LogRedaction.swift, which FieldLog.write applies to every line).
/// Runs in FoxyTests and in tools/nativetests, where the two files are their own
/// module, FoxyNetDiary.
final class NetDiaryTests: XCTestCase {

    // MARK: The line

    /// Method, host, the path's shape, six of the circuit, the time and the outcome.
    func testARequestLineSaysHowItWentAndNothingElse() {
        let line = NetDiary.line(method: "POST", host: "Mint.Example", path: "/Bitcoin/v1/swap",
                                 circuit: "3fa9c1d2e4b5a6978877665544332211", ms: 812, outcome: "200")
        XCTAssertEqual(line, "[foxy] net: POST mint.example/Bitcoin/v1/swap · circuit 3fa9c1 · 812 ms · 200")
        XCTAssertTrue(line.hasPrefix(NetDiary.prefix))
        XCTAssertFalse(line.contains("3fa9c1d"), "only the first six of the circuit label")
    }

    /// The mark's first six, so a diary line can be found in the test mint's log.
    func testAMarkedRequestCarriesSixOfItsMark() {
        let line = NetDiary.line(method: "GET", host: "testmint.example", path: "/v1/info",
                                 circuit: "aaaaaabbbbbbcccc", ms: 40, outcome: "200", mark: "0123456789abcdef")
        XCTAssertTrue(line.hasSuffix(" · mark 012345"), line)
        XCTAssertFalse(line.contains("6789abcdef"), "never the whole mark")
    }

    /// Every id is ':id': quotes, keysets, a lightning address's name, a block's hash.
    func testIdsAreMasked() {
        let cases: [(String, String)] = [
            ("/v1/info", "/v1/info"),
            ("/v1/keysets", "/v1/keysets"),
            ("/v1/keys", "/v1/keys"),
            ("/v1/keys/009a1f293253e41e", "/v1/keys/:id"),
            ("/v1/keys/00ab", "/v1/keys/:id"),
            ("/v1/mint/quote/bolt11", "/v1/mint/quote/bolt11"),
            ("/v1/mint/quote/bolt11/OdSDeOwYqjc7Ns7OVMdcx7NX0TrTn0", "/v1/mint/quote/bolt11/:id"),
            ("/v1/mint/quote/bolt11/q1", "/v1/mint/quote/bolt11/:id"),
            ("/v1/melt/quote/bolt11/7e1b1c3c-6c6e-4b8e-9f62-5c3e4a7a2b1d", "/v1/melt/quote/bolt11/:id"),
            ("/v1/mint/quote/onchain/abc", "/v1/mint/quote/onchain/:id"),
            ("/Bitcoin/v1/mint/quote/bolt11/abc/extra", "/Bitcoin/v1/mint/quote/bolt11/:id/:id"),
            ("/v1/swap", "/v1/swap"),
            ("/v1/checkstate", "/v1/checkstate"),
            ("/.well-known/lnurlp/alice", "/.well-known/lnurlp/:id"),
            ("/lnurlp/callback/abc", "/lnurlp/:id/:id"),
            ("/api/block/" + String(repeating: "0a", count: 32) + "/header", "/api/block/:id/header"),
            ("/api/blocks/tip/height", "/api/blocks/tip/height"),
            ("/api/address/bc1qxyz", "/api/address/:id"),
            ("/a/u%40b", "/a/:id"),
            ("", "/"),
        ]
        for (path, shape) in cases {
            XCTAssertEqual(NetDiary.pathShape(path), shape, path)
        }
    }

    /// The host: lowercased, a port only when it is not the scheme's own.
    func testTheHostIsShownWithAPortOnlyWhenItMatters() throws {
        XCTAssertEqual(NetDiary.host(of: try XCTUnwrap(URL(string: "https://Mint.Example/v1/info"))), "mint.example")
        XCTAssertEqual(NetDiary.host(of: try XCTUnwrap(URL(string: "https://mint.example:443/v1/info"))), "mint.example")
        XCTAssertEqual(NetDiary.host(of: try XCTUnwrap(URL(string: "https://mint.example:3338/v1/info"))), "mint.example:3338")
    }

    /// A failure in a few words with its code; and "failed", so ERRORS shows it.
    func testFailuresAreShortAndReadAsTrouble() {
        func f(_ code: Int) -> String { NetDiary.failure(NSError(domain: NSURLErrorDomain, code: code)) }
        XCTAssertEqual(f(NSURLErrorTimedOut), "failed: timeout [-1001]")
        XCTAssertEqual(f(NSURLErrorCancelled), "failed: cancelled [-999]")
        XCTAssertEqual(f(NSURLErrorBadURL), "failed: no stream [-1000]")
        XCTAssertEqual(f(NSURLErrorNetworkConnectionLost), "failed: connection lost [-1005]")
        XCTAssertEqual(f(NSURLErrorSecureConnectionFailed), "failed: tls [-1200]")
        XCTAssertEqual(f(-1), "failed: error [-1]")
        XCTAssertEqual(NetDiary.failure(NSError(domain: "Other", code: 7)), "failed: error [Other 7]")
    }

    /// The network's line: the kind, and the costs only when there are any.
    func testTheNetworkLine() {
        XCTAssertEqual(NetDiary.networkLine(kind: "wifi", expensive: false, constrained: false), "[foxy] network: wifi")
        XCTAssertEqual(NetDiary.networkLine(kind: "cellular", expensive: true, constrained: true),
                       "[foxy] network: cellular, expensive, constrained (Low Data Mode)")
        XCTAssertEqual(NetDiary.networkLine(kind: "none", expensive: true, constrained: true), "[foxy] network: none",
                       "no network has no costs")
    }

    // MARK: Redaction of the new lines

    /// FieldLog redacts every line on the way in. An ordinary diary line has
    /// nothing in it to take out, so it is kept as it was written.
    func testRedactionLeavesAnOrdinaryDiaryLineAlone() {
        let lines = [
            NetDiary.line(method: "POST", host: "mint.minibits.cash", path: "/Bitcoin/v1/mint/quote/bolt11/" + String(repeating: "f", count: 64),
                          circuit: String(repeating: "c", count: 32), ms: 20013,
                          outcome: NetDiary.failure(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)) + " · tor up",
                          mark: "fedcba9876543210"),
            NetDiary.networkLine(kind: "wifi", expensive: true, constrained: false),
        ]
        for line in lines {
            XCTAssertEqual(LogRedaction.redact(line), line)
        }
        XCTAssertTrue(lines[0].contains("/bolt11/:id"), "the quote's hash never reached the line, so redaction had nothing to do")
    }

    /// An onion host is a name for a person, and still goes.
    func testRedactionTakesAnOnionHostOutOfADiaryLine() {
        let onion = String(repeating: "a", count: 56) + ".onion"
        let line = NetDiary.line(method: "GET", host: onion, path: "/api/blocks/tip/height",
                                 circuit: "abcdefabcdef0000", ms: 900, outcome: "200")
        let kept = LogRedaction.redact(line)
        XCTAssertFalse(kept.contains(onion), kept)
        XCTAssertTrue(kept.contains("<onion address, 62 chars, not logged>"), kept)
        XCTAssertTrue(kept.hasSuffix("/api/blocks/tip/height · circuit abcdef · 900 ms · 200"), kept)
    }

    /// And the rest of what redaction always took out is still taken out.
    func testRedactionStillTakesOutTokensInvoicesAndLongHex() {
        let token = "cashuB" + String(repeating: "o2F0gaJhaUgA", count: 4)
        let invoice = "lnbc1" + String(repeating: "q", count: 40)
        let hex = String(repeating: "ab", count: 32)
        let kept = LogRedaction.redact("[foxy] x \(token) \(invoice) \(hex)")
        XCTAssertFalse(kept.contains(token) || kept.contains(invoice) || kept.contains(hex), kept)
        XCTAssertTrue(kept.contains("<cashu token,") && kept.contains("<lightning invoice,") && kept.contains("<hex, 64 chars"), kept)
    }

    /// A Lightning address names a person: the whole of it goes, the host after the at-sign with the name before it, and the
    /// key names that carry an at-sign before a unit (a pile "...@usd") are not mistaken for one.
    func testRedactionTakesOutALightningAddress() {
        let kept = LogRedaction.redact("[foxy] send starting to alice.b+tips@walletofsatoshi.com then pile foxy.cashu.proofs.https://m.test@usd")
        XCTAssertFalse(kept.contains("alice") || kept.contains("walletofsatoshi"), kept)
        XCTAssertTrue(kept.contains("<lightning address, 32 chars, not logged>"), kept)
        XCTAssertTrue(kept.contains("m.test@usd"), kept)
    }

    /// A Cashu ID string, a NUT-18 request and the nprofile a Cashu ID is delivered to name a person: none reaches the log.
    func testRedactionTakesOutACashuIDAndItsAddress() {
        let id = "foxyid1AgNlIzuO9oM0GjHpzSncvCYSxfTge7XbrS0ufWT-_AvYlmZtyOXIU-UVU9JX7nrzYmsmyeEdPbEa6ASNFPd48g26cTqHsw"
        let request = "creqA" + String(repeating: "pWFpaGI0NThkN2", count: 3)
        let requestB = "CREQB1" + String(repeating: "QYQQWAR", count: 4)
        let profile = "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p"
        let kept = LogRedaction.redact("[foxy] cashu id \(id) to \(profile) and \(request) \(requestB)")
        XCTAssertFalse(kept.contains(id) || kept.contains(profile) || kept.contains(request) || kept.contains(requestB), kept)
        XCTAssertTrue(kept.contains("<cashu id,") && kept.contains("<nostr profile,") && kept.contains("<payment request,"), kept)
    }

    /// A Release build's lines name no host: `host` and the first eight hex
    /// characters of the SHA-256 of its name, lowercased. Two lines about one
    /// host still read as the same host; a Debug build names it.
    func testAReleaseLineNamesNoHost() throws {
        let hidden = LogRedaction.host("Mint.Minibits.Cash", named: false)
        XCTAssertEqual(hidden, LogRedaction.host("mint.minibits.cash", named: false), "one host, one name, whatever its case")
        XCTAssertTrue(hidden.hasPrefix("host "), hidden)
        XCTAssertEqual(hidden.count, "host ".count + 8, hidden)
        XCTAssertFalse(hidden.lowercased().contains("minibits"), hidden)
        XCTAssertNotEqual(hidden, LogRedaction.host("kashu.me", named: false))
        XCTAssertEqual(LogRedaction.host("mint.minibits.cash", named: true), "mint.minibits.cash")
        XCTAssertEqual(LogRedaction.host(nil, named: false), "?")
        let target = try XCTUnwrap(URL(string: "https://pay.example.com/callback?k1=" + String(repeating: "9", count: 40)))
        let shown = LogRedaction.address(target, named: false)
        XCTAssertEqual(shown, LogRedaction.host("pay.example.com", named: false), "the host alone, never the path or the query")
        XCTAssertTrue(LogRedaction.address(target, named: true).hasPrefix("https://pay.example.com/callback"))
    }

    /// The lines that named a host in every build go through that rule now: the
    /// route's refusals, the hosts allowed, a payment posted to a payee, and the
    /// diary's own lines.
    func testThePrintsThatNamedHostsGoThroughTheRule() throws {
        let route = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/Route.swift"), encoding: .utf8)
        for line in route.split(separator: "\n") where line.contains("print(") {
            XCTAssertFalse(line.contains(".host ?? \"?\"") || line.contains("allowed \\(h)"), String(line))
        }
        XCTAssertTrue(route.contains("LogRedaction.address(target)"), "a redirect's target is printed whole again")
        let delivery = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Bridge/FoxyBridge+Delivery.swift"), encoding: .utf8)
        XCTAssertFalse(delivery.contains("POST \\(host)"), "a payee's host is printed by name again")
        let diary = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Debug/NetDiary.swift"), encoding: .utf8)
        XCTAssertTrue(diary.contains("LogRedaction.host(host.lowercased())"))
    }

    /// The Debug file log takes out what the field log takes out, from the one
    /// list: its own copy had no payment requests, onion addresses or nostr keys.
    func testTheDebugFileLogUsesTheFieldLogsList() throws {
        let source = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Debug/DebugLog.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("LogRedaction.redact(line)"))
        XCTAssertFalse(source.contains("NSRegularExpression"), "DebugLog keeps a list of its own again")
        let request = "creqA" + String(repeating: "b", count: 40)
        let onion = String(repeating: "c", count: 56) + ".onion"
        let nsec = "nsec1" + String(repeating: "q", count: 58)
        let kept = LogRedaction.redact("[foxy] \(request) \(onion) \(nsec)")
        XCTAssertFalse(kept.contains(request) || kept.contains(onion) || kept.contains(nsec), kept)
    }

    // MARK: The request mark

    override func tearDown() {
        NetDiary.setMarkHosts(nil)
        super.tearDown()
    }

    private func request(_ text: String) throws -> URLRequest {
        URLRequest(url: try XCTUnwrap(URL(string: text)))
    }

    /// Off by default: nothing is listed, so nothing is sent, whatever the page asks.
    func testNoHeaderWhenNoHostIsListed() throws {
        NetDiary.setMarkHosts(nil)
        var r = try request("https://testmint.example/v1/info")
        XCTAssertNil(NetDiary.applyMark("0123456789abcdef", to: &r))
        XCTAssertNil(r.value(forHTTPHeaderField: NetDiary.markHeader))
    }

    /// A host not on the list gets no header, with the list set.
    func testNoHeaderToAnUnlistedHost() throws {
        NetDiary.setMarkHosts("testmint.example")
        var r = try request("https://mint.minibits.cash/Bitcoin/v1/swap")
        XCTAssertNil(NetDiary.applyMark("0123456789abcdef", to: &r))
        XCTAssertNil(r.value(forHTTPHeaderField: NetDiary.markHeader))
        XCTAssertNil(r.allHTTPHeaderFields?[NetDiary.markHeader])
    }

    /// A listed host gets the page's sixteen hex characters, exactly.
    func testTheHeaderToAListedHost() throws {
        XCTAssertEqual(NetDiary.setMarkHosts(" TestMint.Example , other.test:3338,bad host,"), ["other.test:3338", "testmint.example"])
        var r = try request("https://testmint.example/v1/info")
        XCTAssertEqual(NetDiary.applyMark("0123456789abcdef", to: &r), "0123456789abcdef")
        let sent = try XCTUnwrap(r.value(forHTTPHeaderField: "X-Request-Id"))
        XCTAssertEqual(sent.count, 16)
        XCTAssertTrue(sent.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }, sent)
        // and a host listed with its port
        var p = try request("https://other.test:3338/v1/info")
        XCTAssertEqual(NetDiary.applyMark("fedcba9876543210", to: &p), "fedcba9876543210")
    }

    /// Nothing but sixteen lowercase hex characters ever goes as the header.
    func testOnlySixteenHexCharactersAreEverSent() throws {
        NetDiary.setMarkHosts("testmint.example")
        for bad: Any? in [nil, "", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF",
                          "0123456789abcdeg", "01234567 89abcde", 12345, ["0123456789abcdef"]] {
            var r = try request("https://testmint.example/v1/info")
            XCTAssertNil(NetDiary.applyMark(bad, to: &r), "\(String(describing: bad))")
            XCTAssertNil(r.value(forHTTPHeaderField: NetDiary.markHeader))
        }
    }
}
