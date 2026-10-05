import XCTest
@testable import Foxy

/* The two hand-written HTTP readers on the direct-payment path, and the only
 * two places in Foxy where bytes from a stranger are taken apart by hand.
 *
 * HTTPRequestHead reads what a payer's wallet posts to this phone's onion
 * inbox: anyone on the phone's loopback, and anyone who has the onion address,
 * can send whatever they like to it. HTTPAnswer reads what the other phone
 * sends back down a SOCKS connection. Neither had a test until now.
 *
 * The caps here are the inbox's own (largestHead is private to it, so 8 kB is
 * written out); the small caps some of these tests pass instead are there to
 * keep from building a quarter of a megabyte to prove one boundary.
 */

/// A request the inbox would accept, and the pieces to spoil it with.
private enum Fixture {
    /// The shape of the real one: a path of 128 random bits, hex.
    static let path = "/0123456789abcdef0123456789abcdef"
    static let headCap = 8 * 1024
    static let bodyCap = OnionInbox.largestPayment
    static let json = #"{"mint":"https://m.example.com","proofs":[{"amount":1}]}"#

    static func head(_ headers: [String], method: String = "POST", path: String = Fixture.path,
                     version: String = "HTTP/1.1") -> Data {
        let lines = ["\(method) \(path) \(version)"] + headers
        return Data(lines.joined(separator: "\r\n").utf8) + Data("\r\n\r\n".utf8)
    }

    /// The head a Foxy payer actually sends (OnionPost.send builds this), with `body` after it.
    static func request(_ body: Data = Data(json.utf8), length: String? = nil,
                        extra: [String] = [], method: String = "POST",
                        path: String = Fixture.path, version: String = "HTTP/1.1") -> Data {
        var headers = ["Host: abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwxyz234567.onion",
                       "Content-Type: application/json"]
        if let length { headers.append("Content-Length: \(length)") }
        else { headers.append("Content-Length: \(body.count)") }
        headers += extra
        headers.append("Connection: close")
        return head(headers, method: method, path: path, version: version) + body
    }

    static func parse(_ data: Data, headCap: Int = Fixture.headCap, bodyCap: Int = Fixture.bodyCap)
        -> HTTPRequestHead.Outcome {
        HTTPRequestHead.parse(data, path: path, largestHead: headCap, largestBody: bodyCap)
    }

    /// The same bytes, sitting inside a larger Data so that they do not begin at
    /// index zero. Everything a parser reads must come out the same.
    static func slice(_ data: Data, offset: Int = 9_001) -> Data {
        let padded = Data(repeating: 0x41, count: offset) + data
        return padded[(padded.startIndex + offset)...]
    }
}

/// What the onion inbox takes for a payment, and what it turns away.
final class OnionInboxParsingTests: XCTestCase {
    private func parse(_ data: Data, headCap: Int = Fixture.headCap, bodyCap: Int = Fixture.bodyCap)
        -> HTTPRequestHead.Outcome {
        Fixture.parse(data, headCap: headCap, bodyCap: bodyCap)
    }

    // MARK: The one request that gets through

    func testAPostToTheSecretPathIsAPaymentWithItsBodyIntact() {
        XCTAssertEqual(parse(Fixture.request()), .payment(Fixture.json))
    }

    func testAnEmptyBodyIsStillAPayment() {
        // the mint decides whether it is worth anything; the reader only frames it
        XCTAssertEqual(parse(Fixture.request(Data(), length: "0")), .payment(""))
    }

    func testABodyIsHandedOnByteForByte() {
        // a blank line inside the body is not a second head, and neither is a lone CR
        for body in ["{}", "a\r\n\r\nb", "\r\n", "\u{1F98A} ecash", String(repeating: "x", count: 4096),
                     #"{"memo":"POST / HTTP/1.1"}"#, "\0\0"] {
            XCTAssertEqual(parse(Fixture.request(Data(body.utf8))), .payment(body), body.prefix(20).description)
        }
    }

    func testHTTP10IsReadTheSameWay() {
        XCTAssertEqual(parse(Fixture.request(version: "HTTP/1.0")), .payment(Fixture.json))
    }

    // MARK: Arriving a piece at a time

    /* The inbox re-reads a buffer that is still growing: `read` appends what the
     * connection gave it and parses the lot again. Every prefix of a request
     * that will be accepted must therefore ask for more - a prefix answered
     * with a refusal would cut off a payer mid-sentence, and one answered with
     * a payment would redeem a body that had not finished arriving. */
    func testEveryPrefixOfARequestAsksForMore() {
        for body in ["", Fixture.json, "a\r\n\r\nb", String(repeating: "p", count: 3000)] {
            let full = Fixture.request(Data(body.utf8))
            for cut in 0..<full.count {
                XCTAssertEqual(parse(full.prefix(cut)), .needMore, "cut at \(cut) of \(full.count)")
            }
            XCTAssertEqual(parse(full), .payment(body))
        }
    }

    func testAHeadThatHasNotFinishedArrivingAsksForMore() {
        XCTAssertEqual(parse(Data()), .needMore)
        XCTAssertEqual(parse(Data("P".utf8)), .needMore)
        XCTAssertEqual(parse(Data("POST \(Fixture.path) HTTP/1.1\r\n".utf8)), .needMore)
        // the blank line has not landed, so nothing in the head is judged yet
        XCTAssertEqual(parse(Data("GET /somewhere-else HTTP/1.1\r\nTransfer-Encoding: chunked\r\n".utf8)), .needMore)
    }

    func testABodyStillOnItsWayAsksForMore() {
        let full = Fixture.request(Data(String(repeating: "z", count: 500).utf8))
        XCTAssertEqual(parse(full.dropLast()), .needMore)
        XCTAssertEqual(parse(full.dropLast(499)), .needMore)
    }

    // MARK: The path, before anything else

    /* Tor forwards the onion's port 80 to a loopback port that any other app on
     * the phone can also reach. The path is the secret, so a caller that does
     * not have it must not learn anything else from the answer: not whether its
     * method would have been allowed, not whether its headers were well made. */
    func testAnotherPathIsNotFoundAndLearnsNothingElse() {
        for wrong in ["/", "/v1/info", Fixture.path + "x", String(Fixture.path.dropLast()),
                      Fixture.path.uppercased(), "/0123456789ABCDEF0123456789abcdef", "*"] {
            XCTAssertEqual(parse(Fixture.request(path: wrong)), .refuse(404), wrong)
        }
    }

    func testThePathIsCheckedBeforeTheMethodAndBeforeTheHeaders() {
        let wrong = "/not-the-secret"
        for spoiled in [Fixture.request(method: "GET", path: wrong),
                        Fixture.request(method: "DELETE", path: wrong),
                        Fixture.request(extra: ["Transfer-Encoding: chunked"], path: wrong),
                        Fixture.request(length: "not-a-number", path: wrong),
                        Fixture.request(length: "\(Fixture.bodyCap + 1)", path: wrong),
                        Fixture.head(["Nonsense"], method: "GET", path: wrong)] {
            XCTAssertEqual(parse(spoiled), .refuse(404))
        }
    }

    func testAnEmptyPathIsJustAnotherPath() {
        // "POST  HTTP/1.1": three parts, the middle one empty
        XCTAssertEqual(parse(Fixture.request(path: "")), .refuse(404))
    }

    // MARK: The method

    func testTheSecretPathWithAnotherMethodIsNotAllowed() {
        for method in ["GET", "PUT", "HEAD", "DELETE", "OPTIONS", "post", "Post", "POSTX", "", "PO\0ST"] {
            XCTAssertEqual(parse(Fixture.request(method: method)), .refuse(405), method)
        }
    }

    // MARK: How long the body says it is

    func testAPaymentMustSayHowLongItIs() {
        XCTAssertEqual(parse(Fixture.head(["Host: x.onion"]) + Data(Fixture.json.utf8)), .refuse(400))
        XCTAssertEqual(parse(Fixture.head([])), .refuse(400), "no headers at all")
    }

    func testTwoContentLengthsAreRefusedEvenWhenTheyAgree() {
        XCTAssertEqual(parse(Fixture.request(extra: ["Content-Length: \(Fixture.json.utf8.count)"])), .refuse(400))
        XCTAssertEqual(parse(Fixture.request(extra: ["Content-Length: 1"])), .refuse(400))
        XCTAssertEqual(parse(Fixture.request(extra: ["content-length: 0"])), .refuse(400))
        XCTAssertEqual(parse(Fixture.request(extra: ["CONTENT-LENGTH: 99"])), .refuse(400))
    }

    /* Digits, and nothing but digits. `Int(_:)` reads a leading plus and a
     * leading minus happily, and `.whitespaces` takes a non-breaking space off
     * the end, so values that no other HTTP reader in the world would call a
     * number were getting through and framing the body. */
    func testAContentLengthIsDigitsAndNothingElse() {
        for bad in ["", "abc", "-1", "+5", "0x10", "1e3", "5.0", "5 5", "5,5", " ", "\u{00a0}5",
                    "5\u{00a0}", "١٢", "9999999999999999999999999999", "-0", "5;q=1"] {
            XCTAssertEqual(parse(Fixture.request(length: bad)), .refuse(400), "Content-Length: \(bad)")
        }
    }

    func testASpaceOrATabAroundTheNumberIsAllowed() {
        // OWS is what HTTP lets pad a value, and a real client may send it
        for padded in [" 2", "2 ", "\t2", "  2\t "] {
            XCTAssertEqual(parse(Fixture.request(Data("hi".utf8), length: padded)), .payment("hi"), padded)
        }
    }

    func testTheNumberIsReadWithoutRegardToTheNameCase() {
        for name in ["content-length", "CONTENT-LENGTH", "Content-length", "cOnTeNt-LeNgTh"] {
            let head = Fixture.head(["Host: x.onion", "\(name): 2"])
            XCTAssertEqual(parse(head + Data("hi".utf8)), .payment("hi"), name)
        }
    }

    // MARK: No chunked bodies

    func testAnyTransferEncodingIsRefused() {
        for value in ["chunked", "identity", "", " gzip, chunked", "CHUNKED"] {
            XCTAssertEqual(parse(Fixture.request(extra: ["Transfer-Encoding: \(value)"])), .refuse(400), value)
            XCTAssertEqual(parse(Fixture.request(extra: ["transfer-encoding: \(value)"])), .refuse(400), value)
        }
        // refused whether or not a length came with it
        XCTAssertEqual(parse(Fixture.head(["Transfer-Encoding: chunked"]) + Data("0\r\n\r\n".utf8)), .refuse(400))
    }

    // MARK: The caps

    func testAHeadOverTheCapIsRefused() {
        let filler = "X-Pad: " + String(repeating: "p", count: 400)
        let many = Array(repeating: filler, count: 40)          // about 16 kB of headers
        XCTAssertEqual(parse(Fixture.request(extra: many)), .refuse(413))
        // and while it is still arriving, before any blank line has been seen
        let unfinished = Data(("POST \(Fixture.path) HTTP/1.1\r\n" + many.joined(separator: "\r\n")).utf8)
        XCTAssertEqual(parse(unfinished), .refuse(413))
        XCTAssertEqual(parse(unfinished, headCap: 1 << 20), .needMore, "under a larger cap the same bytes wait")
    }

    func testTheHeadCapIsMeasuredToTheByte() {
        let head = Fixture.head(["Content-Length: 0", "X-Pad: 0123456789"])
        let length = head.count - 4                              // the blank line is not part of it
        XCTAssertEqual(parse(head, headCap: length), .payment(""))
        XCTAssertEqual(parse(head, headCap: length - 1), .refuse(413))
    }

    /* A payment is its proofs; a body that says it is bigger than the cap is a
     * waste of the phone's time and memory, so the refusal goes out on the head
     * alone and none of that body is ever read. */
    func testABodyOverTheCapIsRefusedBeforeItArrives() {
        XCTAssertEqual(parse(Fixture.head(["Content-Length: \(Fixture.bodyCap + 1)"])), .refuse(413))
        XCTAssertEqual(parse(Fixture.head(["Content-Length: 9007199254740993"])), .refuse(413))
        // exactly the cap is allowed, and waits for its bytes
        XCTAssertEqual(parse(Fixture.head(["Content-Length: \(Fixture.bodyCap)"]) + Data(count: 10)), .needMore)
        XCTAssertEqual(parse(Fixture.head(["Content-Length: 11"]) + Data("hello".utf8), bodyCap: 10), .refuse(413))
    }

    func testMoreBodyThanTheLengthPromisedIsRefused() {
        let full = Fixture.request(Data("hi".utf8))
        XCTAssertEqual(parse(full + Data("!".utf8)), .refuse(400))
        // a second request pipelined behind the first is the same thing
        XCTAssertEqual(parse(full + Fixture.request()), .refuse(400))
        XCTAssertEqual(parse(Fixture.head(["Content-Length: 0"]) + Data("x".utf8)), .refuse(400))
    }

    // MARK: Header lines

    func testEveryHeaderLineIsANameAColonAndAValue() {
        for bad in ["Nonsense", "no colon here", ": 5", "\0", "Content-Length"] {
            XCTAssertEqual(parse(Fixture.request(extra: [bad])), .refuse(400), "[\(bad)]")
        }
    }

    /* A line opening with a space or a tab is HTTP's old line folding: it
     * continues the header above. Read as a header of its own, a folded line
     * with a colon in it is a way to slip a second Content-Length past a reader
     * that thinks it is looking at somebody's Host. Both the fold and a space
     * hiding in front of the colon are refused. */
    func testFoldedAndPaddedHeaderNamesAreRefused() {
        for bad in [" continued", "\tcontinued", " X-Fold: 1", "\tContent-Length: 1",
                    "Content-Length : 1", "X-Name\t: 1", " : 1"] {
            XCTAssertEqual(parse(Fixture.request(extra: [bad])), .refuse(400), "[\(bad)]")
        }
        // the fold is refused before its value could be believed
        let folded = Fixture.head(["Host: x.onion", " Content-Length: 2"])
        XCTAssertEqual(parse(folded + Data("hi".utf8)), .refuse(400))
    }

    func testAHeaderValueMayBeEmptyOrHoldAnythingElse() {
        for fine in ["X-Nothing:", "X-Colon: a:b:c", "X-Wide: \u{1F98A}", "X-Quote: \"a\""] {
            XCTAssertEqual(parse(Fixture.request(extra: [fine])), .payment(Fixture.json), fine)
        }
    }

    // MARK: The request line

    func testTheRequestLineIsThreeParts() {
        for bad in ["POST \(Fixture.path)", "POST", "", "POST  \(Fixture.path) HTTP/1.1",
                    "POST \(Fixture.path)  HTTP/1.1", "POST \(Fixture.path) HTTP/1.1 ",
                    " POST \(Fixture.path) HTTP/1.1", "POST\t\(Fixture.path)\tHTTP/1.1"] {
            XCTAssertEqual(parse(Data((bad + "\r\nContent-Length: 0\r\n\r\n").utf8)), .refuse(400), "[\(bad)]")
        }
    }

    func testOnlyHTTP1IsSpokenHere() {
        for version in ["HTTP/2.0", "HTTP/2", "HTTP/0.9", "RTSP/1.0", "http/1.1", "garbage", ""] {
            XCTAssertEqual(parse(Fixture.request(version: version)), .refuse(400), version)
        }
    }

    // MARK: Bytes that are not text

    func testBytesThatAreNotUTF8AreRefusedRatherThanCrash() {
        let broken = Data([0xFF, 0xFE, 0xC3, 0x28])
        // in the head
        var head = Data("POST \(Fixture.path) HTTP/1.1\r\nX-Junk: ".utf8)
        head += broken
        head += Data("\r\nContent-Length: 0\r\n\r\n".utf8)
        XCTAssertEqual(parse(head), .refuse(400))
        // in the request line, before the path could be compared
        XCTAssertEqual(parse(Data("POST ".utf8) + broken + Data(" HTTP/1.1\r\nContent-Length: 0\r\n\r\n".utf8)),
                       .refuse(400))
        // and in the body, which is handed to the page as a string
        XCTAssertEqual(parse(Fixture.head(["Content-Length: \(broken.count)"]) + broken), .refuse(400))
    }

    func testAnUnfinishedMultibyteCharacterInTheBodyIsRefusedNotTruncated() {
        let fox = Data("\u{1F98A}".utf8)
        XCTAssertEqual(parse(Fixture.head(["Content-Length: 3"]) + fox.prefix(3)), .refuse(400))
    }

    // MARK: Data that does not begin at zero

    /* `range(of:)` answers in the numbering of the Data it was handed, and a
     * Data taken out of a slice begins where its parent left off, not at zero.
     * The head cap was being compared against that raw index, so a short head
     * inside a slice read as one of many thousand bytes and the payer was
     * refused 400 for a request that was perfectly good. The inbox's own buffer
     * happens to start at zero, which is why nothing had shown it. */
    func testASliceThatDoesNotBeginAtZeroReadsTheSameWay() {
        XCTAssertEqual(parse(Fixture.slice(Fixture.request())), .payment(Fixture.json))
        XCTAssertEqual(parse(Fixture.slice(Fixture.request(), offset: 1)), .payment(Fixture.json))
        XCTAssertEqual(parse(Fixture.slice(Fixture.request(), offset: 300_000)), .payment(Fixture.json))
        XCTAssertEqual(parse(Fixture.slice(Fixture.request().dropLast())), .needMore)
        XCTAssertEqual(parse(Fixture.slice(Fixture.request(path: "/elsewhere"))), .refuse(404))
        XCTAssertEqual(parse(Fixture.slice(Fixture.request(length: "x"))), .refuse(400))
        // the cap still counts the slice's own bytes, not where it sits
        let head = Fixture.head(["Content-Length: 0"])
        XCTAssertEqual(parse(Fixture.slice(head), headCap: head.count - 4), .payment(""))
        XCTAssertEqual(parse(Fixture.slice(head), headCap: head.count - 5), .refuse(413))
    }
}

/// What comes back from the other phone (HTTPAnswer), read off a connection
/// that is closing.
final class OnionAnswerParsingTests: XCTestCase {
    private func answer(_ text: String) -> (status: Int, body: String)? { HTTPAnswer.parse(Data(text.utf8)) }

    func testAnAnswerGivesItsStatusAndBody() {
        let parsed = answer("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nContent-Type: application/json\r\n"
                            + "Connection: close\r\n\r\n{\"paid\":true}")
        XCTAssertEqual(parsed?.status, 200)
        XCTAssertEqual(parsed?.body, "{\"paid\":true}")
    }

    func testTheStatusIsWhateverTheInboxSent() {
        // every code OnionInbox.respond can send, and the edges of the range
        for status in [200, 400, 404, 405, 410, 413, 422, 504, 100, 599] {
            XCTAssertEqual(answer("HTTP/1.1 \(status) Reason\r\n\r\n")?.status, status)
        }
    }

    func testSomethingThatIsNotAStatusIsNotAnAnswer() {
        for bad in ["HTTP/1.1 99 X", "HTTP/1.1 600 X", "HTTP/1.1 1000 X", "HTTP/1.1 20 X", "HTTP/1.1 abc X",
                    "HTTP/1.1 +200 X", "HTTP/1.1 2x0 X", "HTTP/1.1 -200 X", "HTTP/1.1", "HTTP/1.1 ",
                    "HTTP/2.0 200 OK", "http/1.1 200 OK", "ICY 200 OK", "200 OK", ""] {
            XCTAssertNil(answer(bad + "\r\n\r\nbody"), bad)
        }
    }

    func testAReasonPhraseIsNotNeeded() {
        XCTAssertEqual(answer("HTTP/1.1 204\r\n\r\n")?.status, 204)
        XCTAssertEqual(answer("HTTP/1.1  200  OK  \r\n\r\n")?.status, 200, "extra spaces are skipped")
    }

    func testAnAnswerNeedsItsBlankLine() {
        XCTAssertNil(HTTPAnswer.parse(Data()))
        XCTAssertNil(answer("HTTP/1.1 200 OK"))
        XCTAssertNil(answer("HTTP/1.1 200 OK\r\n"))
        XCTAssertNil(answer("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n"))
        XCTAssertNil(answer("HTTP/1.1 200 OK\n\n"), "bare newlines do not end a head")
    }

    /* The body is everything after the blank line, and the headers are not read
     * at all: the caller (OnionPost.collect) only parses once the connection has
     * closed, which is the framing an answer carrying `Connection: close` has.
     * So a Content-Length that disagrees with what arrived changes nothing - the
     * bytes on the wire are the answer. */
    func testTheBodyIsEverythingAfterTheBlankLineWhateverTheHeadersSay() {
        XCTAssertEqual(answer("HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nshort")?.body, "short")
        XCTAssertEqual(answer("HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nlonger than that")?.body,
                       "longer than that")
        XCTAssertEqual(answer("HTTP/1.1 200 OK\r\n\r\n")?.body, "", "no headers and no body")
        XCTAssertEqual(answer("HTTP/1.1 200 OK\r\n\r\na\r\n\r\nb")?.body, "a\r\n\r\nb",
                       "only the first blank line ends the head")
    }

    func testAnswersOfAnySizeUpToTheCallersCap() {
        let big = String(repeating: "j", count: OnionPost.largestAnswer - 64)
        let parsed = HTTPAnswer.parse(Data("HTTP/1.1 200 OK\r\n\r\n".utf8) + Data(big.utf8))
        XCTAssertEqual(parsed?.status, 200)
        XCTAssertEqual(parsed?.body.count, big.count)
    }

    func testBytesThatAreNotUTF8() {
        let broken = Data([0xFF, 0xFE])
        // in the head there is nothing to read, so there is no answer
        XCTAssertNil(HTTPAnswer.parse(Data("HTTP/1.1 200 ".utf8) + broken + Data("\r\n\r\nx".utf8)))
        /* In the body they become replacement characters rather than nothing:
         * the status is what the page acts on, and a mangled message is better
         * than telling the payer the connection broke. */
        let parsed = HTTPAnswer.parse(Data("HTTP/1.1 422 X\r\n\r\n".utf8) + broken)
        XCTAssertEqual(parsed?.status, 422)
        XCTAssertEqual(parsed?.body, "\u{FFFD}\u{FFFD}")
    }

    func testASliceThatDoesNotBeginAtZeroReadsTheSameWay() {
        let raw = Data("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 2\r\n\r\nno".utf8)
        for offset in [1, 4, 70_000] {
            let parsed = HTTPAnswer.parse(Fixture.slice(raw, offset: offset))
            XCTAssertEqual(parsed?.status, 413, "offset \(offset)")
            XCTAssertEqual(parsed?.body, "no", "offset \(offset)")
        }
    }
}

/// A pocket xorshift, so that the same few thousand spoiled requests run on
/// every machine and every day. Nothing here may reach for Date or for the
/// system's randomness: a fuzz test that cannot be re-run is a rumour.
private struct Pocket {
    private var state: UInt64
    init(seed: UInt64) { state = seed | 1 }

    mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }

    mutating func below(_ n: Int) -> Int { n <= 0 ? 0 : Int(next() % UInt64(n)) }
    mutating func byte() -> UInt8 { UInt8(truncatingIfNeeded: next()) }
}

/// Thousands of spoiled requests, and what must hold for every one of them.
final class OnionHTTPFuzzTests: XCTestCase {
    private let headCap = 512
    private let bodyCap = 512

    private func parse(_ data: Data) -> HTTPRequestHead.Outcome {
        HTTPRequestHead.parse(data, path: Fixture.path, largestHead: headCap, largestBody: bodyCap)
    }

    /* A second reading of the same bytes, written out plainly, to judge a
     * .payment by. It says the thing the inbox's safety rests on: the page is
     * handed a body only when the bytes really were a POST to the secret path,
     * carrying one Content-Length within the cap, followed by exactly that many
     * bytes and no more. */
    private func reallyIsAPayment(_ data: Data, body: String) -> Bool {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return false }
        guard end.lowerBound - data.startIndex <= headCap,
              let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return false }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "POST", parts[1] == Fixture.path,
              parts[2].hasPrefix("HTTP/1.") else { return false }
        var lengths: [Int] = []
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return false }
            let name = line[..<colon]
            guard !name.hasPrefix(" "), !name.hasPrefix("\t"),
                  !name.hasSuffix(" "), !name.hasSuffix("\t") else { return false }
            let lowered = name.lowercased()
            if lowered == "transfer-encoding" { return false }
            if lowered == "content-length" {
                let value = line[line.index(after: colon)...]
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
                guard !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }),
                      let n = Int(value) else { return false }
                lengths.append(n)
            }
        }
        guard lengths.count == 1, let length = lengths.first, length >= 0, length <= bodyCap else { return false }
        let rest = data[end.upperBound...]
        return rest.count == length && String(data: rest, encoding: .utf8) == body
    }

    /// One spoiling of `base`, chosen by the generator alone.
    private func spoil(_ base: [UInt8], _ rng: inout Pocket) -> [UInt8] {
        var bytes = base
        switch rng.below(11) {
        case 0:
            bytes = Array(bytes.prefix(rng.below(bytes.count + 1)))
        case 1:
            let at = rng.below(bytes.count)
            bytes[at] ^= UInt8(1) << rng.below(8)
        case 2:
            let at = rng.below(bytes.count)
            bytes[at] = rng.byte()
        case 3:
            // the bytes that mean something to a reader of HTTP
            let poison: [UInt8] = [0x0D, 0x0A, 0x00, 0x20, 0x09, 0x3A, 0x2B, 0x2D, 0xFF, 0xC3]
            bytes.insert(poison[rng.below(poison.count)], at: rng.below(bytes.count + 1))
        case 4:
            bytes.remove(at: rng.below(bytes.count))
        case 5:
            // a header line said twice, which is how a smuggled length gets in
            let breaks = Self.lineBreaks(bytes)
            if breaks.count >= 2 {
                let which = rng.below(breaks.count - 1)
                let line = Array(bytes[breaks[which]..<breaks[which + 1]])
                bytes.insert(contentsOf: line, at: breaks[which])
            }
        case 6:
            for _ in 0..<rng.below(64) { bytes.append(rng.byte()) }
        case 7:
            let cut = rng.below(bytes.count + 1)
            bytes = Array(bytes.prefix(cut)) + Array(bytes.suffix(rng.below(bytes.count + 1)))
        case 8:
            // a length of the generator's choosing, sensible or not
            let shapes = ["\(rng.below(10_000))", "-\(rng.below(99))", "+\(rng.below(99))",
                          String(repeating: "9", count: 1 + rng.below(25)), "", " \(rng.below(20)) ",
                          "\(rng.below(20)) , \(rng.below(20))", "0\(rng.below(9))"]
            let body = Array("body".utf8)
            bytes = Array(Fixture.head(["Content-Length: \(shapes[rng.below(shapes.count)])"])) + body
        case 9:
            // wholly made up, of a length nobody chose
            bytes = (0..<rng.below(600)).map { _ in rng.byte() }
        default:
            let at = rng.below(bytes.count)
            bytes.insert(contentsOf: Array("\r\n\r\n".utf8), at: at)
        }
        return bytes
    }

    private static func lineBreaks(_ bytes: [UInt8]) -> [Int] {
        var found: [Int] = [0]
        var i = 0
        while i + 1 < bytes.count {
            if bytes[i] == 0x0D, bytes[i + 1] == 0x0A { found.append(i + 2); i += 2 } else { i += 1 }
        }
        return found
    }

    func testThousandsOfSpoiledRequestsGetNothingThroughAndCrashNothing() {
        var rng = Pocket(seed: 0x464F5859_31383230)          // "FOXY" and the day this was written
        let bases = [Array(Fixture.request(Data("{}".utf8))),
                     Array(Fixture.request(Data(String(repeating: "q", count: 300).utf8))),
                     Array(Fixture.request(Data(), length: "0")),
                     Array(Fixture.head(["Content-Length: 4"]) + Data("body".utf8))]
        var payments = 0, refusals = 0, waits = 0
        for round in 0..<4000 {
            let bytes = spoil(bases[round % bases.count], &rng)
            let data = Data(bytes)
            let outcome = parse(data)

            switch outcome {
            case .payment(let body):
                payments += 1
                XCTAssertTrue(reallyIsAPayment(data, body: body),
                              "round \(round) got through: \(String(decoding: bytes.prefix(200), as: UTF8.self).debugDescription)")
            case .needMore:
                waits += 1
                /* Waiting means the buffer may still grow, so anything already
                 * past both caps must have been refused instead: a payer that
                 * keeps sending must never be able to make this phone hold more
                 * than a head and a body. */
                XCTAssertLessThanOrEqual(data.count, headCap + 4 + bodyCap, "round \(round) waits on too many bytes")
            case .refuse(let status):
                refusals += 1
                XCTAssertTrue([400, 404, 405, 413].contains(status), "round \(round) answered \(status)")
            }

            /* The same bytes read out of a slice must come to the same answer.
             * This is the one that caught the head cap being compared against a
             * raw index rather than a length. */
            XCTAssertEqual(parse(Fixture.slice(data, offset: 1 + round % 997)), outcome,
                           "round \(round) read differently out of a slice")
        }
        // a spoiling that never got anything through would prove nothing about the accepting side
        XCTAssertGreaterThan(payments, 0, "no mutation was ever accepted, so the oracle was never tested")
        XCTAssertGreaterThan(refusals, 100)
        XCTAssertGreaterThan(waits, 0)
    }

    func testTheAnswerParserSurvivesTheSameTreatment() {
        var rng = Pocket(seed: 0x414E5357_45520001)
        let base = Array(Data("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{\"paid\":true}".utf8))
        var answers = 0
        for round in 0..<3000 {
            let data = Data(spoil(base, &rng))
            guard let (status, body) = HTTPAnswer.parse(data) else { continue }
            answers += 1
            XCTAssertTrue((100...599).contains(status), "round \(round) gave status \(status)")
            /* The body is whatever followed the first blank line, read with
             * U+FFFD in place of any byte that was not UTF-8 - so it can come
             * out longer in bytes than what arrived, and is compared as text. */
            let blank = data.range(of: Data("\r\n\r\n".utf8))!
            XCTAssertEqual(body, String(decoding: data[blank.upperBound...], as: UTF8.self), "round \(round)")
            XCTAssertEqual(HTTPAnswer.parse(Fixture.slice(data, offset: 1 + round % 89))?.status, status,
                           "round \(round) read differently out of a slice")
        }
        XCTAssertGreaterThan(answers, 0)
    }
}
