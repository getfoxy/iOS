import XCTest
#if canImport(FoxyCardTap)
@testable import FoxyCardTap
#else
@testable import Foxy
#endif

/// A card's address on its way to the page: kept until the page can take it, told once
/// (Foxy/Flashcard/CardTapDelivery.swift). Runs in FoxyTests and in tools/nativetests,
/// where the file is its own module, FoxyCardTap.
final class CardTapDeliveryTests: XCTestCase {
    /// A delivery with a clock, a timer and a page of its own, all run by hand.
    private final class Rig {
        let delivery = CardTapDelivery()
        var clock = Date(timeIntervalSince1970: 1_000_000)
        /// What the page says to each question, in order; the last answer is repeated.
        var answers: [Bool] = [true]
        /// Questions held back, for a page that is slow to answer (`holdAnswers`).
        var held: [(Bool) -> Void] = []
        var holdAnswers = false
        var asked = 0
        var timers: [() -> Void] = []
        var lines: [String] = []

        init() {
            delivery.now = { [unowned self] in self.clock }
            delivery.wait = { [unowned self] _, run in self.timers.append(run) }
            delivery.say = { [unowned self] in self.lines.append($0) }
            delivery.tell = { [unowned self] done in
                let answer = self.answers[min(self.asked, self.answers.count - 1)]
                self.asked += 1
                if self.holdAnswers { self.held.append(done) } else { done(answer) }
            }
        }

        /// The page is loaded, nothing is over it, and Foxy never left.
        func open() {
            delivery.pageLoaded()
            delivery.coverChanged(up: false)
        }

        /// Every timer that is waiting, once.
        func fireTimers() {
            let due = timers
            timers = []
            due.forEach { $0() }
        }

        func advance(_ seconds: TimeInterval) { clock = clock.addingTimeInterval(seconds) }
    }

    private let card = URL(string: "https://getfoxy.io/card")

    /// The page is up and the card is tapped: it is told, at once, and once.
    func testToldAtOnceWhenThePageIsReady() {
        let rig = Rig()
        rig.open()
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 1)
        XCTAssertNil(rig.delivery.since, "a yes ends it")
        XCTAssertEqual(rig.lines, ["a card's address arrived", "told the page"])
        XCTAssertTrue(rig.timers.isEmpty, "nothing is left to ask again")
    }

    /// A launch from the banner: the address comes before the page is loaded or uncovered, and waits.
    func testKeptUntilThePageIsReadyThenToldOnce() {
        let rig = Rig()
        XCTAssertFalse(rig.delivery.ready)
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 0, "not loaded, and the launch image is up")
        XCTAssertNotNil(rig.delivery.since, "kept")
        rig.delivery.pageLoaded()
        XCTAssertEqual(rig.asked, 0, "loaded, but the launch image is still up")
        rig.delivery.coverChanged(up: false)
        XCTAssertEqual(rig.asked, 1, "told when the last thing in the way went")
        XCTAssertNil(rig.delivery.since)
        // and never again for the same tap, whatever else happens
        rig.delivery.pageLoaded()
        rig.delivery.coverChanged(up: false)
        rig.delivery.cameBack()
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 1)
    }

    /// iOS can hand a SwiftUI app one address in more than one way, and a person can tap twice: one tap, one message.
    func testAddressesWhileOneWaitsAreTheSameTap() {
        let rig = Rig()
        rig.delivery.received(card)
        rig.delivery.received(card)
        rig.delivery.received(URL(string: "https://getfoxy.io/card/?again=1"))
        XCTAssertEqual(rig.lines, ["a card's address arrived"], "said once")
        rig.open()
        XCTAssertEqual(rig.asked, 1)
        XCTAssertNil(rig.delivery.since)
    }

    /// Once told, the next address is a tap of its own, and the page rules on that one too.
    func testAnotherTapAfterBeingToldIsAnotherTap() {
        let rig = Rig()
        rig.open()
        rig.delivery.received(card)
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 2)
    }

    /// The page has loaded and not booted: its answer is the only sign, so it is asked until it says yes.
    func testAskedAgainUntilThePageSaysYes() {
        let rig = Rig()
        rig.answers = [false, false, true]
        rig.open()
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 1)
        XCTAssertEqual(rig.timers.count, 1, "one question to come")
        XCTAssertNotNil(rig.delivery.since)
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 2)
        XCTAssertEqual(rig.timers.count, 1)
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 3)
        XCTAssertNil(rig.delivery.since)
        XCTAssertTrue(rig.timers.isEmpty, "a yes leaves no timer")
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 3, "and nothing asks again")
    }

    /// A page that never says yes is asked for a minute, and then given up on.
    func testGivenUpAMinuteAfterTheAddressArrived() {
        let rig = Rig()
        rig.answers = [false]
        rig.open()
        rig.delivery.received(card)
        rig.advance(59)
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 2, "still asked at 59 seconds")
        XCTAssertNotNil(rig.delivery.since)
        rig.advance(2)
        rig.fireTimers()
        XCTAssertEqual(rig.asked, 2, "not at 61")
        XCTAssertNil(rig.delivery.since)
        XCTAssertTrue(rig.timers.isEmpty, "nothing keeps asking")
        XCTAssertEqual(rig.lines.last, "given up, the page did not take it within a minute")
        rig.fireTimers()
        rig.delivery.pageLoaded()
        XCTAssertEqual(rig.asked, 2)
    }

    /// An address that waited under a cover for more than a minute is not acted on when the cover comes down.
    func testAnOldAddressIsNeverToldWhenTheCoverGoesLater() {
        let rig = Rig()
        rig.delivery.pageLoaded()
        rig.delivery.received(card)
        rig.advance(300)
        rig.delivery.coverChanged(up: false)
        XCTAssertEqual(rig.asked, 0)
        XCTAssertNil(rig.delivery.since)
        XCTAssertEqual(rig.lines.last, "given up, the page did not take it within a minute")
    }

    /// A tap renews the wait: the minute is counted from the latest address.
    func testALaterAddressRenewsTheWait() {
        let rig = Rig()
        rig.answers = [false]
        rig.open()
        rig.delivery.received(card)
        rig.advance(50)
        rig.delivery.received(card)
        rig.advance(50)
        rig.fireTimers()
        XCTAssertNotNil(rig.delivery.since, "100 seconds after the first, 50 after the second")
        rig.advance(11)
        rig.fireTimers()
        XCTAssertNil(rig.delivery.since)
    }

    /// The page raises its lock when it is told Foxy is back, so a card is never told before that.
    func testAfterABackgroundNothingIsToldUntilTheReturnIs() {
        let rig = Rig()
        rig.open()
        rig.delivery.wentToBackground()
        XCTAssertFalse(rig.delivery.ready)
        rig.delivery.received(card)
        rig.delivery.coverChanged(up: true)
        rig.delivery.coverChanged(up: false)
        rig.delivery.pageLoaded()
        XCTAssertEqual(rig.asked, 0, "back and uncovered, but the page has not been told it is back")
        rig.delivery.cameBack()
        XCTAssertEqual(rig.asked, 1)
        XCTAssertNil(rig.delivery.since)
    }

    /// The address that comes with a return can arrive before the return is told, or after it.
    func testAnAddressAfterTheReturnIsToldAtOnce() {
        let rig = Rig()
        rig.open()
        rig.delivery.wentToBackground()
        rig.delivery.cameBack()
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 1)
    }

    /// The launch image and the app-switcher cover are both covers.
    func testNothingIsToldUnderACover() {
        let rig = Rig()
        rig.open()
        rig.delivery.coverChanged(up: true)
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 0)
        rig.delivery.coverChanged(up: true)
        XCTAssertEqual(rig.asked, 0, "up again changes nothing")
        rig.delivery.coverChanged(up: false)
        XCTAssertEqual(rig.asked, 1)
    }

    /// A page whose process ended is being loaded again; it is not asked until it has loaded.
    func testAPageThatWentIsNotAskedUntilItIsBack() {
        let rig = Rig()
        rig.open()
        rig.delivery.pageGone()
        XCTAssertFalse(rig.delivery.ready)
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 0)
        rig.delivery.pageLoaded()
        XCTAssertEqual(rig.asked, 1)
    }

    /// A page that is slow to answer is not asked a second time while it thinks.
    func testAQuestionIsNotAskedTwiceWhileItIsOut() {
        let rig = Rig()
        rig.holdAnswers = true
        rig.open()
        rig.delivery.received(card)
        rig.delivery.pageLoaded()
        rig.delivery.coverChanged(up: false)
        rig.delivery.cameBack()
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 1)
        rig.held.removeFirst()(true)
        XCTAssertNil(rig.delivery.since, "the second address was the first, said again")
        XCTAssertEqual(rig.asked, 1)
        XCTAssertTrue(rig.timers.isEmpty)
    }

    /// An answer that arrives after the tap was given up on starts nothing.
    func testALateNoAfterTheGiveUpStartsNothing() {
        let rig = Rig()
        rig.holdAnswers = true
        rig.open()
        rig.delivery.received(card)
        rig.advance(120)
        rig.delivery.cameBack()
        XCTAssertNil(rig.delivery.since, "given up")
        rig.held.removeFirst()(false)
        XCTAssertTrue(rig.timers.isEmpty, "no timer for a tap that is over")
        XCTAssertEqual(rig.asked, 1)
    }

    /// The same delivery serves every tap of a session: the shared one is the app's.
    func testTheAppHasOneDelivery() {
        XCTAssertTrue(CardTapDelivery.shared === CardTapDelivery.shared)
        XCTAssertEqual(CardTapDelivery.lapse, 60)
        XCTAssertGreaterThan(CardTapDelivery.retryAfter, 0)
        XCTAssertLessThan(CardTapDelivery.retryAfter, 1)
    }
}
