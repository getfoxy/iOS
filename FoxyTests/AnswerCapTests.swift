import XCTest
@testable import Foxy

/// I6: an answer is stopped at its limit while it arrives, not measured once
/// it is all in memory.
final class AnswerCapTests: XCTestCase {

    func testTheLimitIsFourMegabytes() {
        XCTAssertEqual(Route.largestAnswer, 4 * 1024 * 1024)
    }

    func testTheRule() {
        let cap = AnswerCap(limit: 100)
        XCTAssertFalse(cap.refusesUpFront(expectedLength: -1), "an unknown length is read, and counted")
        XCTAssertFalse(cap.refusesUpFront(expectedLength: 100))
        XCTAssertTrue(cap.refusesUpFront(expectedLength: 101))
        XCTAssertTrue(cap.allows(held: 0, more: 100))
        XCTAssertTrue(cap.allows(held: 60, more: 40))
        XCTAssertFalse(cap.allows(held: 60, more: 41))
        XCTAssertFalse(cap.allows(held: 0, more: Int.max))
    }

    // MARK: Through the session delegate every request uses

    private func fetch(limit: Int, _ plan: StubServer.Plan) -> (Data?, URLResponse?, Error?) {
        StubServer.reset(plan)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubServer.self]
        let session = URLSession(configuration: cfg, delegate: Route.redirectGuard, delegateQueue: nil)
        let over = expectation(description: "the request ends")
        var result: (Data?, URLResponse?, Error?) = (nil, nil, nil)
        Route.startOnce(session, URLRequest(url: URL(string: "https://mint.example.com/v1/keys")!), limit: limit) {
            result = ($0, $1, $2)
            over.fulfill()
        }
        wait(for: [over], timeout: 20)
        return result
    }

    func testAnAnswerWithinTheLimitArrivesWhole() {
        let (data, response, error) = fetch(limit: 64_000, .init(length: nil, chunk: 16_000, total: 50_000))
        XCTAssertNil(error)
        XCTAssertEqual(data?.count, 50_000)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    func testAnAnswerExactlyAtTheLimitArrivesWhole() {
        let (data, _, error) = fetch(limit: 64_000, .init(length: 64_000, chunk: 16_000, total: 64_000))
        XCTAssertNil(error)
        XCTAssertEqual(data?.count, 64_000)
    }

    func testALengthOverTheLimitIsRefusedBeforeTheBody() {
        let (data, _, error) = fetch(limit: 64_000, .init(length: 10_000_000, chunk: 16_000, total: 10_000_000))
        XCTAssertTrue(error is AnswerTooLarge, "\(String(describing: error))")
        XCTAssertNil(data)
        XCTAssertTrue(serverStops(), "the server was told to stop")
        XCTAssertLessThan(StubServer.sent.value, 1_000_000)
    }

    func testAnAnswerWithNoLengthIsStoppedAtTheLimit() {
        let (data, _, error) = fetch(limit: 64_000, .init(length: nil, chunk: 16_000, total: 10_000_000))
        XCTAssertTrue(error is AnswerTooLarge, "\(String(describing: error))")
        XCTAssertNil(data)
        XCTAssertTrue(serverStops(), "the server was told to stop")
        XCTAssertLessThan(StubServer.sent.value, 1_000_000, "it stopped long before the end")
    }

    /// The stub server learns the connection was cancelled on its own queue, which
    /// can be a moment after the request's completion runs, longer on a busy
    /// machine. Waiting for it (two seconds at most) tests the cancel, not a race.
    private func serverStops() -> Bool {
        let deadline = Date().addingTimeInterval(2)
        while !StubServer.stopped.value && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return StubServer.stopped.value
    }

    func testTheErrorSaysWhat() {
        XCTAssertEqual(AnswerTooLarge().localizedDescription, "The answer was too large.")
    }
}

/// A server inside the test: one 200 answer, sent in chunks until done or told
/// to stop.
final class StubServer: URLProtocol {
    struct Plan {
        var length: Int?
        var chunk: Int
        var total: Int
    }
    static let plan = Locked(Plan(length: nil, chunk: 1, total: 0))
    static let sent = Locked(0)
    static let stopped = Locked(false)
    private let stop = Locked(false)

    static func reset(_ next: Plan) {
        plan.value = next
        sent.value = 0
        stopped.value = false
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let plan = Self.plan.value
        var headers = ["Content-Type": "application/json"]
        if let length = plan.length { headers["Content-Length"] = String(length) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        DispatchQueue.global().async { [self] in
            var sent = 0
            while sent < plan.total, !stop.value {
                let n = min(plan.chunk, plan.total - sent)
                client?.urlProtocol(self, didLoad: Data(repeating: 0x61, count: n))
                sent += n
                Self.sent.value = sent
                usleep(2000)
            }
            if !stop.value { client?.urlProtocolDidFinishLoading(self) }
        }
    }

    override func stopLoading() {
        stop.value = true
        Self.stopped.value = true
    }
}
