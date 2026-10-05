import XCTest
@testable import Foxy

/// What a failed mint request is called.
///
/// A mint address Foxy validated cannot be malformed, so NSURLErrorBadURL
/// against it is standing in for something else: a session whose SOCKS proxy
/// moved when Tor restarted. The person was told "bad URL" — "connect failed,
/// attempt 1 — bad URL", "could not claim invoice … — bad URL" — which sends
/// them to edit a setting that is fine.
final class MintFailureWordsTests: XCTestCase {

    private func words(domain: String, code: Int, saying: String) -> String {
        FoxyBridge.mintFailureWords(NSError(
            domain: domain, code: code,
            userInfo: [NSLocalizedDescriptionKey: saying]))
    }

    func testBadURLIsNotBlamedOnTheAddress() {
        let said = words(domain: NSURLErrorDomain, code: NSURLErrorBadURL, saying: "bad URL")
        XCTAssertFalse(said.lowercased().contains("url"), said)
        XCTAssertTrue(said.contains("Try again"), said)
    }

    func testEveryOtherFailureKeepsItsOwnWords() {
        for (code, saying) in [
            (NSURLErrorTimedOut, "The request timed out."),
            (NSURLErrorNetworkConnectionLost, "The network connection was lost."),
            (NSURLErrorSecureConnectionFailed, "An SSL error has occurred and a secure connection to the server cannot be made."),
            (NSURLErrorCannotConnectToHost, "Could not connect to the server."),
            (NSURLErrorNotConnectedToInternet, "The Internet connection appears to be offline."),
        ] {
            XCTAssertEqual(words(domain: NSURLErrorDomain, code: code, saying: saying), saying)
        }
    }

    /// The code alone does not decide it: -1000 in somebody else's domain is
    /// somebody else's error.
    func testTheDomainCountsToo() {
        XCTAssertEqual(words(domain: "FoxyTestDomain", code: NSURLErrorBadURL, saying: "something else"),
                       "something else")
    }
}
