import XCTest
@testable import Foxy

/// Which addresses Foxy will ask for, where a redirect may go, and which hosts
/// need the person's Allow.
final class RouteTests: XCTestCase {
    private func url(_ text: String) -> URL { URL(string: text)! }

    // MARK: putting Foxy away

    func testASwapAndItsTopUpAreWaitedFor() {
        XCTAssertEqual(Route.leaving(money: 1, tidying: false, out: 1, waited: 0.4, onTheRest: 0), .wait)
        XCTAssertEqual(Route.leaving(money: 0, tidying: true, out: 0, waited: 12, onTheRest: 0), .wait)
        // however long the rest has been waited for, money still is
        XCTAssertEqual(Route.leaving(money: 1, tidying: false, out: 3, waited: 19, onTheRest: 9), .wait)
    }

    func testAfterTwentySecondsTorLeavesWhateverIsOut() {
        XCTAssertEqual(Route.leaving(money: 1, tidying: false, out: 1, waited: 20.1, onTheRest: 0), .leave(after: 0))
        XCTAssertEqual(Route.leaving(money: 0, tidying: true, out: 0, waited: 20.1, onTheRest: 0), .leave(after: 0))
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 2, waited: 20.1, onTheRest: 1), .leave(after: 0))
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 0, waited: 20.1, onTheRest: 0), .leave(after: 0.5))
    }

    func testARequestThatMovesNoMoneyIsWaitedForThreeSeconds() {
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 1, waited: 0.4, onTheRest: 0), .wait)
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 2, waited: 3.2, onTheRest: 2.9), .wait)
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 2, waited: 3.6, onTheRest: 3.1), .leave(after: 0))
        // the three seconds are counted from when money last moved, not from the putting-away
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 1, waited: 15, onTheRest: 0.5), .wait)
    }

    func testWithNothingOutTorLeavesAfterHalfASecond() {
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 0, waited: 0.4, onTheRest: 0), .leave(after: 0.5))
        XCTAssertEqual(Route.leaving(money: 0, tidying: false, out: 0, waited: 9, onTheRest: 3.5), .leave(after: 0.5))
    }

    func testTheDoorShutsForAFewSecondsAndOpensByItself() {
        defer { Route.openDoor() }
        XCTAssertFalse(Route.shut(at: 100))
        Route.shutDoor(at: 100)
        XCTAssertTrue(Route.shut(at: 100))
        XCTAssertTrue(Route.shut(at: 100 + Route.shutFor - 0.1))
        // nobody opened it: a missed return cannot leave the wallet without a route
        XCTAssertFalse(Route.shut(at: 100 + Route.shutFor))
        Route.shutDoor(at: 200)
        Route.openDoor()
        XCTAssertFalse(Route.shut(at: 200.1))
    }

    func testNothingLeavesWhileTheDoorIsShutAndWhatIsOutIsCounted() {
        // the open connection, so that a request can start with no Tor in the test host;
        // the address is this machine's own, on a port nothing listens on
        Route.unprotected = true
        defer { Route.unprotected = false; Route.openDoor() }
        let request = URLRequest(url: url("https://127.0.0.1:1/v1/keysets"))
        let before = Route.out

        Route.shutDoor()
        var called = false
        XCTAssertNil(Route.start(request) { _, _, _ in called = true })
        XCTAssertEqual(Route.out, before, "a request that was refused is not out")

        Route.openDoor()
        let answered = expectation(description: "the request ends")
        var during = -1
        let task = Route.start(request) { _, _, _ in answered.fulfill() }
        during = Route.out
        XCTAssertNotNil(task)
        XCTAssertEqual(during, before + 1, "out from the moment it starts")
        wait(for: [answered], timeout: 20)
        XCTAssertEqual(Route.out, before, "and not once it has ended, however it ended")
        XCTAssertFalse(called, "the refused request's answer was never asked for")
    }

    func testMintAddressesAreHttpsOrHttpToAnOnion() {
        XCTAssertNil(Route.urlProblem(url("https://mint.minibits.cash/Bitcoin")))
        XCTAssertNil(Route.urlProblem(url("HTTPS://Mint.Example.com:3338/v1/info")))
        XCTAssertNil(Route.urlProblem(url("https://mint.example.com./v1/keys")))
        for refused in ["http://mint.example.com/", "ftp://abcdef.onion/", "file://abcdef.onion/x",
                        "wss://mint.example.com/", "javascript:alert(1)", "mint.example.com"] {
            XCTAssertNotNil(Route.urlProblem(url(refused)), refused)
        }
    }

    func testHostsFoxyWillNotAskFor() {
        for refused in ["https://localhost/", "https://127.0.0.1/", "https://0x7f.1/", "https://127.1/",
                        "https://192.168.1.1/", "https://[::1]/", "https://[fe80::1]/", "https://router/",
                        "https://printer.local/", "https://nas.home.arpa/", "https://x.internal/",
                        "https://box.lan/", "https://pc.localdomain/", "https://app.localhost/", "https:///v1"] {
            XCTAssertNotNil(Route.hostProblem(url(refused)), refused)
        }
    }

    func testAnOnionNeedsTor() {
        // the app hosting these tests starts no Tor
        XCTAssertFalse(TorService.isRunning)
        XCTAssertEqual(Route.urlProblem(url("http://abcdefghijklmnop.onion/v1/info")),
                       "An .onion address needs Tor, and Foxy is not connected to Tor.")
    }

    func testARedirectStaysOnItsHostAndMeetsTheSameRules() {
        let from = url("https://mint.example.com/v1/keys")
        XCTAssertNil(Route.redirectProblem(from: from, to: url("https://mint.example.com/v1/keysets")))
        XCTAssertNil(Route.redirectProblem(from: from, to: url("https://MINT.example.com./other")))
        XCTAssertEqual(Route.redirectProblem(from: from, to: url("https://pay.example.com/")),
                       "A redirect to another host is not followed.")
        XCTAssertNotNil(Route.redirectProblem(from: from, to: url("http://mint.example.com/")))
        XCTAssertNotNil(Route.redirectProblem(from: from, to: url("https://192.168.1.1/")))
        XCTAssertNotNil(Route.redirectProblem(from: nil, to: url("https://mint.example.com/")))
    }

    // MARK: Host approvals

    func testAnAllowedHostCoversItsSubdomains() {
        let allowed: Set<String> = ["mint.example.com"]
        for yes in ["mint.example.com", "pay.mint.example.com", "MINT.Example.com.", " mint.example.com "] {
            XCTAssertTrue(HostApprovals.approves(yes, approved: allowed, carried: []), yes)
        }
        for no in ["example.com", "evilmint.example.com", "mint.example.com.evil.net", "", "."] {
            XCTAssertFalse(HostApprovals.approves(no, approved: allowed, carried: []), no)
        }
    }

    func testTheDefaultMintsAreApproved() {
        for host in HostApprovals.builtIn {
            XCTAssertTrue(HostApprovals.approves(host, approved: HostApprovals.builtIn, carried: []), host)
        }
        XCTAssertFalse(HostApprovals.approves("cashu.space", approved: HostApprovals.builtIn, carried: []))
    }

    /// The two block explorers a card's clock is fetched from are approved without an alert, and no other onion is.
    func testTheBlockExplorersAreApprovedAndNoOtherOnion() {
        let known = HostApprovals.builtIn.union(HostApprovals.explorers)
        XCTAssertEqual(HostApprovals.explorers.count, 2)
        for host in HostApprovals.explorers {
            XCTAssertTrue(host.hasSuffix(".onion"), host)
            XCTAssertTrue(HostApprovals.approves(host, approved: known, carried: []), host)
        }
        for other in ["example.onion", "mempool.space", "evilmempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion"] {
            XCTAssertFalse(HostApprovals.approves(other, approved: known, carried: []), other)
        }
    }

    /// I4(b): a carried host approves itself, never the names under it.
    func testACarriedHostIsApprovedExactly() {
        let carried = Set(HostApprovals.carriable(["co.uk", "getalby.com", "mint.coinos.io", "8333.space"]))
        for yes in ["co.uk", "getalby.com", "GetAlby.com.", "mint.coinos.io", "8333.space"] {
            XCTAssertTrue(HostApprovals.approves(yes, approved: [], carried: carried), yes)
        }
        for no in ["attacker.co.uk", "api.getalby.com", "x.mint.coinos.io", "coinos.io", "evil.8333.space"] {
            XCTAssertFalse(HostApprovals.approves(no, approved: [], carried: carried), no)
        }
        // a carried host under an allowed one is still covered by the allowed one
        XCTAssertTrue(HostApprovals.approves("pay.example.com", approved: ["example.com"], carried: ["co.uk"]))
    }

    func testWhatACarryOverTakes() {
        XCTAssertEqual(HostApprovals.carriable([" Mint.Example.COM. ", "localhost", "", "a b.com", "x@y.com",
                                                "https://x.com", "ok-host.io", "mint.example.com:3338"]),
                       ["mint.example.com", "ok-host.io"])
        XCTAssertEqual(HostApprovals.carriable(Array(repeating: "a.com", count: 300)).count, 200)
        XCTAssertEqual(HostApprovals.carriable([String(repeating: "a", count: 250) + ".com"]), [])
    }
}

/// How long Tor is kept on the network once Foxy is put away and its work is
/// over (Route.holding): for what iOS allows, less what leaving cleanly needs.
final class TorHoldTests: XCTestCase {
    func testTorIsHeldForWhatIOSAllowsLessTheTimeToLeave() {
        XCTAssertTrue(Route.holding(waited: 0.9, remaining: 29), "just put away, with the usual thirty seconds")
        XCTAssertTrue(Route.holding(waited: 20, remaining: 9.5), "twenty seconds on, and still time to leave cleanly")
        XCTAssertTrue(Route.holding(waited: 23, remaining: 6.1))
        XCTAssertFalse(Route.holding(waited: 24, remaining: 6), "the reserve: Tor's answer can take four seconds")
        XCTAssertFalse(Route.holding(waited: 3, remaining: 4), "iOS allowing less than usual ends it early")
    }

    func testTheHoldEndsByItselfWhateverIOSSays() {
        // with a debugger attached iOS names no limit; Tor is still taken off
        XCTAssertTrue(Route.holding(waited: 25.9, remaining: .greatestFiniteMagnitude))
        XCTAssertFalse(Route.holding(waited: 26, remaining: .greatestFiniteMagnitude))
        XCTAssertFalse(Route.holding(waited: 5, remaining: .nan), "an answer that is no number is no time")
        // and all of it fits in what iOS allows: the hold, then Tor's four seconds
        XCTAssertLessThanOrEqual(Route.holdAtMost + 4, 30)
        XCTAssertGreaterThanOrEqual(Route.holdReserve, 4 + 1)
    }
}

/// When the cover over a return comes off without waiting for the page.
final class ReturnCoverTests: XCTestCase {
    func testAReturnThePageDoesNothingForIsUncoveredAtOnce() {
        XCTAssertTrue(WebHostController.coverOffAtOnce(wentAway: false, away: 0),
                      "Face ID, Control Center, a screenshot: Foxy never left")
        XCTAssertTrue(WebHostController.coverOffAtOnce(wentAway: true, away: 0),
                      "to the background and back inside a second: the page is told 0 and does nothing")
        XCTAssertFalse(WebHostController.coverOffAtOnce(wentAway: true, away: 1),
                       "a second or more: the page answers, and says when it has the screen")
        XCTAssertFalse(WebHostController.coverOffAtOnce(wentAway: true, away: 300))
    }
}

/// When RESTART TOR is offered (TorStuck, in TorTransport.swift). The rule the
/// page shows the button by, held to the cases a phone once showed.
final class TorStuckTests: XCTestCase {
    private func offered(connecting: Bool = true, link: Bool = true, quiet: TimeInterval,
                         counted: Bool = true) -> Bool {
        TorStuck.offered(connecting: connecting, hasLink: link, quiet: quiet, bytesCounted: counted)
    }

    func testNoControlLinkIsOfferedAfterTenSeconds() {
        XCTAssertFalse(offered(link: false, quiet: 9.9), "a launch still authenticating")
        XCTAssertTrue(offered(link: false, quiet: 10), "the authentication hang")
    }

    /// Weak cellular: the percentage stood at 50% while bytes kept arriving.
    /// Every byte resets `quiet`, so a download in progress is never stuck.
    func testALinkThatIsStillReceivingIsNotOffered() {
        XCTAssertFalse(offered(quiet: 13), "13s at one percentage, with data arriving, was offered before")
        XCTAssertFalse(offered(quiet: 29.9))
        XCTAssertTrue(offered(quiet: 30), "nothing at all for 30s")
    }

    /// Past Orbot or over a bridge Tor cannot count the bytes, so only its events
    /// show life, and they come further apart.
    func testWhereBytesAreNotCountedItWaitsLonger() {
        XCTAssertFalse(offered(quiet: 59.9, counted: false))
        XCTAssertTrue(offered(quiet: 60, counted: false))
    }

    /// Snowflake on good signal went 70s without an event while downloading, and
    /// connected 11s later. It is not offered before two minutes.
    func testSnowflakeWaitsTwoMinutes() {
        XCTAssertFalse(TorStuck.offered(connecting: true, hasLink: true, quiet: 70, bytesCounted: false, snowflake: true),
                       "the quiet stretch a working Snowflake had")
        XCTAssertFalse(TorStuck.offered(connecting: true, hasLink: true, quiet: 119.9, bytesCounted: false, snowflake: true))
        XCTAssertTrue(TorStuck.offered(connecting: true, hasLink: true, quiet: 120, bytesCounted: false, snowflake: true))
        XCTAssertTrue(TorStuck.offered(connecting: true, hasLink: false, quiet: 10, bytesCounted: false, snowflake: true),
                      "a lost control link is still offered at 10s on Snowflake")
        XCTAssertTrue(TorStuck.offered(connecting: true, hasLink: true, quiet: 60, bytesCounted: false, snowflake: false),
                      "obfs4 and past Orbot stay at 60s")
    }

    func testNeverOfferedUnlessConnecting() {
        // up, failed (CANNOT CONNECT has RETRY), stopped (reopen Foxy), or parked in the background
        XCTAssertFalse(offered(connecting: false, link: false, quiet: 600))
        XCTAssertFalse(offered(connecting: false, quiet: 600))
    }

    /// Radios off: Tor is taken off the network on purpose and says nothing.
    /// A return to the front with still no network was read as connecting and
    /// quiet, and RESTART TOR was offered thirty seconds later, every time.
    func testATorTakenOffTheNetworkIsNotConnecting() {
        func connecting(ready: Bool = false, failed: Bool = false, stopped: Bool = false,
                        parked: Bool = false, offNetwork: Bool = false, running: Bool = true) -> Bool {
            TorStuck.connecting(running: running, ready: ready, failed: failed, stopped: stopped,
                                parked: parked, offNetwork: offNetwork)
        }
        XCTAssertTrue(connecting(), "setting up, with a network: this is when a restart can help")
        XCTAssertFalse(connecting(offNetwork: true), "the phone has no network; nothing to restart through")
        XCTAssertFalse(connecting(parked: true), "Foxy is put away")
        XCTAssertFalse(connecting(ready: true))
        XCTAssertFalse(connecting(failed: true), "CANNOT CONNECT has RETRY")
        XCTAssertFalse(connecting(stopped: true), "reopen Foxy")
        XCTAssertFalse(connecting(running: false), "not started")
        // and so however long it is quiet, nothing is offered
        XCTAssertFalse(TorStuck.offered(connecting: connecting(offNetwork: true), hasLink: true,
                                        quiet: 600, bytesCounted: true))
    }
}

/// A bridge that worked is used first for a day, so a place where direct Tor is
/// blocked does not sit out a failed direct attempt - 45 seconds - on every
/// launch; then direct is tried again, so one bad network does not leave every
/// later launch, anywhere, on a bridge.
final class RememberedTransportTests: XCTestCase {
    private let key = "foxy.tor.transport"
    private let sinceKey = "foxy.tor.transport.since"
    private var saved: (Any?, Any?)

    override func setUp() {
        let d = UserDefaults.standard
        saved = (d.object(forKey: key), d.object(forKey: sinceKey))
        d.removeObject(forKey: key)
        d.removeObject(forKey: sinceKey)
    }

    override func tearDown() {
        let d = UserDefaults.standard
        if let v = saved.0 { d.set(v, forKey: key) } else { d.removeObject(forKey: key) }
        if let v = saved.1 { d.set(v, forKey: sinceKey) } else { d.removeObject(forKey: sinceKey) }
    }

    private func setSince(hoursAgo: Double) {
        UserDefaults.standard.set(Date().timeIntervalSince1970 - hoursAgo * 3600, forKey: sinceKey)
    }

    func testNothingRememberedIsDirect() {
        XCTAssertEqual(TorTransport.remembered, .direct)
    }

    func testABridgeThatConnectedIsUsedFirstNextLaunch() {
        TorTransport.remembered = .obfs4
        XCTAssertEqual(TorTransport.remembered, .obfs4)
        TorTransport.remembered = .snowflake
        XCTAssertEqual(TorTransport.remembered, .snowflake)
    }

    func testABridgeIsRememberedForADayThenDirectIsTriedAgain() {
        TorTransport.remembered = .obfs4
        setSince(hoursAgo: 23.9)
        XCTAssertEqual(TorTransport.remembered, .obfs4, "within the day")
        setSince(hoursAgo: 24.1)
        XCTAssertEqual(TorTransport.remembered, .direct, "a day on, direct gets its chance")
    }

    /// Reconnecting over the same bridge within the day does not stretch the day:
    /// otherwise a phone always on a bridge would never try direct again.
    func testTheSameBridgeAgainDoesNotStartANewDay() {
        TorTransport.remembered = .obfs4
        setSince(hoursAgo: 23)
        TorTransport.remembered = .obfs4
        setSince(hoursAgo: 23.5)       // as if an hour on, measured from the first connection
        XCTAssertEqual(TorTransport.remembered, .obfs4)
        let since = UserDefaults.standard.double(forKey: sinceKey)
        XCTAssertLessThan(since, Date().timeIntervalSince1970 - 23 * 3600, "the day still counts from the first connection")
    }

    /// Direct failing again after the day, and the bridge connecting, starts a new day.
    func testABridgeReachedAfterTheDayStartsANewOne() {
        TorTransport.remembered = .obfs4
        setSince(hoursAgo: 25)
        XCTAssertEqual(TorTransport.remembered, .direct)
        TorTransport.remembered = .obfs4
        XCTAssertEqual(TorTransport.remembered, .obfs4)
        XCTAssertGreaterThan(UserDefaults.standard.double(forKey: sinceKey), Date().timeIntervalSince1970 - 60)
    }

    func testDirectConnectingForgetsTheBridge() {
        TorTransport.remembered = .obfs4
        TorTransport.remembered = .direct
        XCTAssertEqual(TorTransport.remembered, .direct)
        XCTAssertNil(UserDefaults.standard.object(forKey: sinceKey))
    }
}

/// The Tor circuit label a mint request carries (MintCircuit).
final class MintCircuitTests: XCTestCase {
    func testThePageLabelIsKept() {
        let label = "0123456789abcdef0123456789abcdef"
        XCTAssertEqual(MintCircuit.label(label), label)
    }

    func testNoLabelGetsACircuitOfItsOwn() {
        let a = MintCircuit.label(nil), b = MintCircuit.label("")
        XCTAssertEqual(a.count, 32)
        XCTAssertTrue(a.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertNotEqual(a, b, "two unlabelled requests must not share a circuit")
    }

    func testAnythingElseIsNotUsedAsALogin() {
        // not hex, too short, too long, not a string, or Tor's extended-parameter prefix
        for bad in ["<torS0X>0" + String(repeating: "a", count: 20), "short", String(repeating: "a", count: 65),
                    "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef 123456789abcdef"] {
            XCTAssertNotEqual(MintCircuit.label(bad), bad, bad)
        }
        XCTAssertEqual(MintCircuit.label(42).count, 32)
    }

    /// A VPN left on with Wi-Fi and cellular off is no network.
    ///
    /// Its tunnel stays up with nothing under it and the path reads as
    /// satisfied; called "other", it was a network, and a phone in that state
    /// sent a swap into the tunnel and stalled the payment after it (from a
    /// phone log).
    func testATunnelWithNothingUnderItIsNoNetwork() {
        func kind(_ wifi: Bool, _ cellular: Bool, _ wired: Bool, _ names: [String], satisfied: Bool = true) -> String {
            NetworkKind.of(satisfied: satisfied, wifi: wifi, cellular: cellular, wired: wired, interfaces: names)
        }
        XCTAssertEqual(kind(true, false, false, ["en0"]), "wifi")
        XCTAssertEqual(kind(true, false, false, ["utun4", "en0"]), "wifi", "Wi-Fi under a VPN")
        XCTAssertEqual(kind(false, true, false, ["utun4", "pdp_ip0"]), "cellular", "cellular under a VPN")
        XCTAssertEqual(kind(false, false, true, ["en5"]), "wired")
        XCTAssertEqual(kind(false, false, false, ["utun4"]), "none", "the VPN's tunnel and nothing else")
        XCTAssertEqual(kind(false, false, false, ["utun4", "ipsec0"]), "none")
        XCTAssertEqual(kind(false, false, false, ["pan0"]), "other", "tethered over Bluetooth is a network")
        XCTAssertEqual(kind(false, false, false, ["utun4", "pan0"]), "other")
        XCTAssertEqual(kind(false, false, false, []), "other", "nothing named is not an accusation")
        XCTAssertEqual(kind(true, true, true, ["en0"], satisfied: false), "none")
        for name in ["utun0", "utun12", "ipsec1", "ppp0", "tun0", "tap0"] { XCTAssertTrue(NetworkKind.isTunnel(name), name) }
        for name in ["en0", "pdp_ip0", "pan0", "bridge100", "awdl0", "lo0"] { XCTAssertFalse(NetworkKind.isTunnel(name), name) }
    }
}
