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
        /// The arrivals the page was asked about, and what it answers, in order; the last answer is repeated.
        var arrivalsAsked: [Arrival] = []
        var arrivalAnswers: [String?] = ["keep"]

        init() {
            delivery.now = { [unowned self] in self.clock }
            delivery.wait = { [unowned self] _, run in self.timers.append(run) }
            delivery.say = { [unowned self] in self.lines.append($0) }
            delivery.tell = { [unowned self] done in
                let answer = self.answers[min(self.asked, self.answers.count - 1)]
                self.asked += 1
                if self.holdAnswers { self.held.append(done) } else { done(answer) }
            }
            delivery.askArrival = { [unowned self] found, done in
                let answer = self.arrivalAnswers[min(self.arrivalsAsked.count, self.arrivalAnswers.count - 1)]
                self.arrivalsAsked.append(found)
                done(answer)
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

    // MARK: an arrival, on a first run

    /// Foxy started with no wallet, and the card's address opened it: not a tap, an arrival, asked of the page for as long
    /// as it says keep, and told nothing as a tap.
    func testOnAFirstRunTheCardIsAnArrivalNotATap() {
        let rig = Rig()
        rig.delivery.firstRun = true
        rig.delivery.received(card)
        XCTAssertEqual(rig.delivery.arrival, Arrival.card, "kept before the page is up")
        XCTAssertNil(rig.delivery.since, "and not a tap")
        XCTAssertTrue(rig.arrivalsAsked.isEmpty, "the page is not up")
        rig.open()
        XCTAssertEqual(rig.arrivalsAsked, [Arrival.card])
        XCTAssertEqual(rig.asked, 0, "the tap's question is never asked")
        XCTAssertEqual(rig.timers.count, 1, "asked again, while the page keeps it")
        rig.fireTimers()
        rig.fireTimers()
        XCTAssertEqual(rig.arrivalsAsked.count, 3)
        XCTAssertNotNil(rig.delivery.arrival, "and kept here meanwhile")
    }

    /// A page loaded again during the set-up is asked again: the arrival outlives the page, not Foxy.
    func testAnArrivalOutlivesThePageLoadedAgain() {
        let rig = Rig()
        rig.delivery.firstRun = true
        rig.open()
        rig.delivery.received(card)
        XCTAssertEqual(rig.arrivalsAsked.count, 1)
        rig.delivery.pageGone()
        rig.fireTimers()
        XCTAssertEqual(rig.arrivalsAsked.count, 1, "not asked while the page is gone")
        rig.delivery.pageLoaded()
        XCTAssertEqual(rig.arrivalsAsked.count, 2, "asked as soon as it is back")
        XCTAssertNotNil(rig.delivery.arrival)
    }

    /// The page opened it at home: it is gone, the first run is over here too, and the next card is a tap as ever.
    func testShownEndsItAndTheNextCardIsATap() {
        let rig = Rig()
        rig.arrivalAnswers = ["keep", nil, "shown"]
        rig.delivery.firstRun = true
        rig.open()
        rig.delivery.received(card)
        rig.fireTimers()
        rig.fireTimers()
        XCTAssertEqual(rig.arrivalsAsked.count, 3, "keep, then no answer (a page not booted), then shown")
        XCTAssertNil(rig.delivery.arrival)
        XCTAssertFalse(rig.delivery.firstRun)
        XCTAssertTrue(rig.timers.isEmpty, "nothing asks again")
        XCTAssertEqual(rig.asked, 0)
        rig.delivery.received(card)
        XCTAssertEqual(rig.asked, 1, "a later card is told as a tap")
        XCTAssertEqual(rig.arrivalsAsked.count, 3)
    }

    /// The page's first run was over before the arrival came: the card's arrival is then the tap it always was.
    func testOverMakesTheCardATap() {
        let rig = Rig()
        rig.arrivalAnswers = ["over"]
        rig.delivery.firstRun = true
        rig.open()
        rig.delivery.received(card)
        XCTAssertEqual(rig.arrivalsAsked.count, 1)
        XCTAssertNil(rig.delivery.arrival)
        XCTAssertFalse(rig.delivery.firstRun)
        XCTAssertEqual(rig.asked, 1, "told as a tap")
        XCTAssertNil(rig.delivery.since)
    }

    /// Off a first run nothing changes: the card is a tap, and no other address is read.
    func testOffAFirstRunTheCardIsATapAndNothingElseIsRead() {
        let rig = Rig()
        var read = 0
        rig.delivery.arrivalReaders = [{ _ in read += 1; return Arrival(kind: "other", code: "123456") }]
        rig.open()
        rig.delivery.received(card)
        rig.delivery.received(URL(string: "https://example.com/other?c=123456"))
        XCTAssertEqual(rig.asked, 1)
        XCTAssertTrue(rig.arrivalsAsked.isEmpty)
        XCTAssertEqual(read, 0, "a build's readers are not asked")
        XCTAssertFalse(rig.delivery.arrive(Arrival(kind: "other")!), "and a build's own arrival is its caller's to handle")
        XCTAssertNil(rig.delivery.arrival)
    }

    /// A build's own kind: read from its address on a first run, kept as the card's is, and what it always was if the first
    /// run was over.
    func testABuildsOwnKindOnAFirstRun() {
        let rig = Rig()
        var fellBack: [Arrival] = []
        rig.delivery.arrivalReaders = [{ url in url.host == "example.com" ? Arrival(kind: "other", code: "123456") : nil }]
        rig.delivery.arrivalFallbacks = ["other": { fellBack.append($0) }]
        rig.delivery.firstRun = true
        rig.delivery.received(URL(string: "https://example.org/x"))
        XCTAssertNil(rig.delivery.arrival, "an address nobody reads is dropped")
        rig.delivery.received(URL(string: "https://example.com/other?c=123456"))
        XCTAssertEqual(rig.delivery.arrival, Arrival(kind: "other", code: "123456"))
        rig.arrivalAnswers = ["over"]
        rig.open()
        XCTAssertEqual(fellBack, [Arrival(kind: "other", code: "123456")!])
        XCTAssertEqual(rig.asked, 0, "not a card's tap")
    }

    /// The latest arrival is the one: a second address replaces the first, and is what the page is asked about.
    func testTheLatestArrivalIsAskedAbout() {
        let rig = Rig()
        rig.delivery.firstRun = true
        rig.delivery.received(card)
        XCTAssertTrue(rig.delivery.arrive(Arrival(kind: "other", code: "654321")!))
        rig.open()
        XCTAssertEqual(rig.arrivalsAsked, [Arrival(kind: "other", code: "654321")!])
    }

    /// Not asked under a cover or before the return is told, as a tap is not.
    func testAnArrivalWaitsAsATapDoes() {
        let rig = Rig()
        rig.delivery.firstRun = true
        rig.open()
        rig.delivery.wentToBackground()
        rig.delivery.received(card)
        rig.delivery.coverChanged(up: true)
        rig.delivery.coverChanged(up: false)
        XCTAssertTrue(rig.arrivalsAsked.isEmpty, "back, but the return not told")
        rig.delivery.cameBack()
        XCTAssertEqual(rig.arrivalsAsked.count, 1)
    }

    /// Kept half an hour at most: a first run left that long is not sent anywhere when it ends.
    func testAnArrivalIsGivenUpAfterHalfAnHour() {
        let rig = Rig()
        rig.delivery.firstRun = true
        rig.open()
        rig.delivery.received(card)
        rig.advance(29 * 60)
        rig.fireTimers()
        XCTAssertNotNil(rig.delivery.arrival)
        rig.advance(2 * 60)
        rig.fireTimers()
        XCTAssertNil(rig.delivery.arrival)
        XCTAssertTrue(rig.timers.isEmpty)
        XCTAssertEqual(rig.lines.last, "an arrival given up, the first run did not reach home within half an hour")
    }

    /// Kinds and codes need no quoting in the page's call, and anything else is no arrival.
    func testWhatAnArrivalMayBe() {
        XCTAssertEqual(Arrival.card.pageCall,
                       "window.FoxyWallet && window.FoxyWallet._arrived && window.FoxyWallet._arrived('card', '')")
        XCTAssertEqual(Arrival(kind: "other", code: "123456")?.pageCall.hasSuffix("._arrived('other', '123456')"), true)
        XCTAssertNil(Arrival(kind: ""))
        XCTAssertNil(Arrival(kind: "Card"))
        XCTAssertNil(Arrival(kind: "card", code: "1'); x('"))
        XCTAssertNil(Arrival(kind: "card", code: String(repeating: "1", count: 33)))
        XCTAssertNil(Arrival(kind: "averyveryverylongkind"))
    }

    /// The same delivery serves every tap of a session: the shared one is the app's.
    func testTheAppHasOneDelivery() {
        XCTAssertTrue(CardTapDelivery.shared === CardTapDelivery.shared)
        XCTAssertEqual(CardTapDelivery.lapse, 60)
        XCTAssertGreaterThan(CardTapDelivery.retryAfter, 0)
        XCTAssertLessThan(CardTapDelivery.retryAfter, 1)
    }
}
