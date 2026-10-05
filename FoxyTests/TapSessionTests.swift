import XCTest
@testable import Foxy

/// The whole conversation, both sides run against each other in memory.
/// No radio, so this is where the protocol is actually proved.
final class TapSessionTests: XCTestCase {

    /// Carries one side's output to the other, and hands back what it said.
    private func hand(_ step: TapSession.Step, to other: TapSession) -> TapSession.Step {
        guard case .send(let bytes) = step else { return .waiting }
        return other.received(bytes)
    }

    /// A tap from first contact to the money landing.
    func testAWholeTapFromHelloToPaid() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)

        // M1, M2, M3
        let m2 = hand(payer.begin(), to: receiver)
        let m3 = hand(m2, to: payer)
        let linked = hand(m3, to: receiver)
        guard case .linked(let receiverCode) = linked else { return XCTFail("the receiver did not link: \(linked)") }

        // both screens show the same four digits
        XCTAssertEqual(receiverCode.count, 4)
        XCTAssertEqual(receiverCode, payer.code)
        XCTAssertEqual(receiverCode, receiver.code)

        // M4: the offer
        let offerText = "{\"v\":2,\"inv\":\"lnbc10n1pn9\",\"req\":\"creqAabcdefghijklmnop\"}"
        let m4 = try XCTUnwrap(receiver.sealOffer(offerText))
        guard case .offer(let got, let payerCode) = payer.received(m4) else { return XCTFail("no offer") }
        XCTAssertEqual(got, offerText)
        XCTAssertEqual(payerCode, receiverCode)

        // M5: the ecash, after the person taps SEND
        let paymentText = "{\"mint\":\"https://mint.example\",\"proofs\":[{\"amount\":21}]}"
        let m5 = try XCTUnwrap(payer.sealPayment(paymentText))
        guard case .payment(let paid) = receiver.received(m5) else { return XCTFail("no payment") }
        XCTAssertEqual(paid, paymentText)

        // M6: what became of it
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        guard case .result(let answer) = payer.received(m6) else { return XCTFail("no result") }
        XCTAssertEqual(answer, "{\"ok\":true}")

        /* M7: the change, when the payer could not make the amount exactly and
         * handed over more than was asked. A token like any other, and the
         * receiver's to make. */
        let changeText = "cashuBchangetokenforthepayer"
        let m7 = try XCTUnwrap(receiver.sealChange(changeText))
        guard case .change(let back) = payer.received(m7) else { return XCTFail("no change") }
        XCTAssertEqual(back, changeText)

        /* M8: the payer's page saying it is written down. Not the radio's word —
         * bytes arriving says nothing about money being kept, which is the whole
         * reason M6 became the page's answer rather than an ack from the link. */
        let m8 = try XCTUnwrap(payer.sealChangeTaken())
        guard case .changeTaken = receiver.received(m8) else { return XCTFail("no change receipt") }
    }

    /// A payer that was away while the result and the change went by asks for
    /// them again (M12), gets the same bytes, opens them in order, and the
    /// tap finishes. One that missed nothing is sent nothing.
    func testAPayerThatWasAwayHearsItAgain() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        let linked = hand(hand(hand(payer.begin(), to: receiver), to: payer), to: receiver)
        guard case .linked = linked else { return XCTFail("not linked: \(linked)") }
        let m4 = try XCTUnwrap(receiver.sealOffer("{\"v\":2,\"req\":\"creqAabcdefghijklmnop\"}"))
        guard case .offer = payer.received(m4) else { return XCTFail("no offer") }
        let m5 = try XCTUnwrap(payer.sealPayment("{\"proofs\":[{\"amount\":21}]}"))
        guard case .payment = receiver.received(m5) else { return XCTFail("no payment") }

        // said while the payer's app was suspended: neither reaches it
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        let m7 = try XCTUnwrap(receiver.sealChange("cashuBchangetokenforthepayer"))

        let m12 = try XCTUnwrap(payer.sealAgain())
        guard case .again(let from) = receiver.received(m12) else { return XCTFail("no repeat request") }
        let again = receiver.framesSince(from)
        XCTAssertEqual(again, [m6, m7], "the same bytes, in the order they were said")
        guard case .result(let answer) = payer.received(again[0]) else { return XCTFail("no result the second time") }
        XCTAssertEqual(answer, "{\"ok\":true}")
        guard case .change(let back) = payer.received(again[1]) else { return XCTFail("no change the second time") }
        XCTAssertEqual(back, "cashuBchangetokenforthepayer")

        // and the tap goes on from there
        let m8 = try XCTUnwrap(payer.sealChangeTaken())
        guard case .changeTaken = receiver.received(m8) else { return XCTFail("no change receipt") }

        // a payer that has heard everything is told nothing twice
        let once = try XCTUnwrap(payer.sealAgain())
        guard case .again(let now) = receiver.received(once) else { return XCTFail("no second repeat request") }
        XCTAssertTrue(receiver.framesSince(now).isEmpty)
        // and a receiver cannot ask
        XCTAssertNil(receiver.sealAgain())
    }

    /// Two phones linked, with a payment handed over: where every suspension
    /// case starts.
    private func paidPair() throws -> (payer: TapSession, receiver: TapSession) {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        guard case .linked = hand(hand(hand(payer.begin(), to: receiver), to: payer), to: receiver) else {
            XCTFail("not linked"); throw NSError(domain: "tap", code: 1)
        }
        let m4 = try XCTUnwrap(receiver.sealOffer("{\"v\":2,\"req\":\"creqAabcdefghijklmnop\"}"))
        guard case .offer = payer.received(m4) else { XCTFail("no offer"); throw NSError(domain: "tap", code: 2) }
        let m5 = try XCTUnwrap(payer.sealPayment("{\"proofs\":[{\"amount\":21}]}"))
        guard case .payment = receiver.received(m5) else { XCTFail("no payment"); throw NSError(domain: "tap", code: 3) }
        return (payer, receiver)
    }

    /// Suspended after the result and before the change: only the change is
    /// said again, because the result has been opened and cannot be opened twice.
    func testAPayerThatMissedOnlyTheChangeIsSentOnlyTheChange() throws {
        let (payer, receiver) = try paidPair()
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        guard case .result = payer.received(m6) else { return XCTFail("no result") }
        let m7 = try XCTUnwrap(receiver.sealChange("cashuBchange"))   // missed
        guard case .again(let from) = receiver.received(try XCTUnwrap(payer.sealAgain())) else { return XCTFail("no repeat request") }
        XCTAssertEqual(receiver.framesSince(from), [m7])
        guard case .change(let back) = payer.received(m7) else { return XCTFail("no change") }
        XCTAssertEqual(back, "cashuBchange")
    }

    /// "A person is deciding" is a message too, and uses a counter: missed
    /// along with the result, it has to be repeated first or the result will
    /// not open.
    func testAMissedWaitIsRepeatedBeforeTheResultItCameBefore() throws {
        let (payer, receiver) = try paidPair()
        let m9 = try XCTUnwrap(receiver.sealAsking())
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        guard case .again(let from) = receiver.received(try XCTUnwrap(payer.sealAgain())) else { return XCTFail("no repeat request") }
        let again = receiver.framesSince(from)
        XCTAssertEqual(again, [m9, m6], "in the order they were sealed")
        guard case .asking = payer.received(again[0]) else { return XCTFail("the wait did not open") }
        guard case .result = payer.received(again[1]) else { return XCTFail("the result did not open") }
        // out of order it would not have: this is what the counter is for
        let (p2, r2) = try paidPair()
        _ = try XCTUnwrap(r2.sealAsking())
        let late = try XCTUnwrap(r2.sealResult("{\"ok\":true}"))
        guard case .stop = p2.received(late) else { return XCTFail("a result opened with a message missing before it") }
    }

    /// The same message twice is refused, which is why the payer asks from
    /// the count it has opened and does not ask twice before the answer.
    func testAMessageAlreadyOpenedIsNotOpenedAgain() throws {
        let (payer, receiver) = try paidPair()
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        guard case .result = payer.received(m6) else { return XCTFail("no result") }
        guard case .stop = payer.received(m6) else { return XCTFail("the same result opened twice") }
    }

    /// A payer that asks, with nothing said yet, is told nothing — and the
    /// answer that comes afterwards still opens.
    func testAskingBeforeAnythingWasSaidCostsNothing() throws {
        let (payer, receiver) = try paidPair()
        guard case .again(let from) = receiver.received(try XCTUnwrap(payer.sealAgain())) else { return XCTFail("no repeat request") }
        XCTAssertTrue(receiver.framesSince(from).isEmpty)
        let m6 = try XCTUnwrap(receiver.sealResult("{\"ok\":true}"))
        guard case .result = payer.received(m6) else { return XCTFail("the result did not open after an early ask") }
    }

    /// A payment bigger than one message goes as parts and arrives whole; one
    /// that fits still goes as one; and there is a size no payment may pass.
    func testALargePaymentGoesInPartsAndArrivesWhole() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        let linked = hand(hand(hand(payer.begin(), to: receiver), to: payer), to: receiver)
        guard case .linked = linked else { return XCTFail("not linked: \(linked)") }
        let m4 = try XCTUnwrap(receiver.sealOffer("{\"v\":2,\"req\":\"creqAabcdefghijklmnop\"}"))
        guard case .offer = payer.received(m4) else { return XCTFail("no offer") }

        // about 100 KB, and with a character that is more than one byte in it
        let big = "{\"proofs\":\"" + String(repeating: "abcdefghi\u{20BF}", count: 8_400) + "\"}"
        XCTAssertGreaterThan(big.utf8.count, 2 * TapCrypto.partBody)
        /* The size is said first, so it is sealed first: messages open in the
         * order they were sealed. Sealed after the parts it would not open and
         * the receiver would stop — which is what the first build of this did
         * on a phone. The figure comes from the length, with nothing sealed. */
        let estimate = payer.paymentWireEstimate(big)
        let size = try XCTUnwrap(payer.sealPaymentSize(estimate))
        let frames = try XCTUnwrap(payer.sealPaymentFrames(big))
        XCTAssertEqual(frames.count, 3, "three parts for about a hundred kilobytes")
        XCTAssertTrue(frames.allSatisfy { $0.count < 65_535 }, "each fits a frame's two-byte length")
        let actual = frames.reduce(0) { $0 + $1.count + 2 }
        XCTAssertLessThan(abs(actual - estimate), 200, "the estimate is the wire size to within a few bytes a part")

        guard case .paymentSize(let said) = receiver.received(size) else { return XCTFail("the size did not open first") }
        XCTAssertEqual(said, estimate)
        guard case .waiting = receiver.received(frames[0]) else { return XCTFail("the first part did not wait") }
        guard case .waiting = receiver.received(frames[1]) else { return XCTFail("the second part did not wait") }
        guard case .payment(let got) = receiver.received(frames[2]) else { return XCTFail("no payment at the last part") }
        XCTAssertEqual(got, big, "joined, it is what was sent")

        // an ordinary payment is still one message
        let other = TapSession(role: .payer, service: service)
        let recv2 = TapSession(role: .receiver, service: service)
        guard case .linked = hand(hand(hand(other.begin(), to: recv2), to: other), to: recv2) else { return XCTFail("not linked") }
        XCTAssertEqual(try XCTUnwrap(other.sealPaymentFrames("{\"proofs\":[]}")).count, 1)
        // a size sealed after the payment is a message out of order, and is refused
        let p3 = TapSession(role: .payer, service: service)
        let r3 = TapSession(role: .receiver, service: service)
        guard case .linked = hand(hand(hand(p3.begin(), to: r3), to: p3), to: r3) else { return XCTFail("not linked") }
        let lateFrames = try XCTUnwrap(p3.sealPaymentFrames(big))
        let lateSize = try XCTUnwrap(p3.sealPaymentSize(1))
        guard case .stop = r3.received(lateSize) else { return XCTFail("a size sealed out of order opened") }
        _ = lateFrames
        // and past the cap nothing is sealed at all
        XCTAssertNil(other.sealPaymentFrames(String(repeating: "x", count: TapCrypto.mostPaymentTotal + 1)))
        // only a payer says how much is coming
        XCTAssertNil(recv2.sealPaymentSize(1000))
    }

    /// Only the receiver may send change, and only the payer may say it kept it.
    /// A role that seals the other's message would be sealing with a key the
    /// other side never opens with, which fails silently later; it is refused here.
    func testEachSideCanOnlySealItsOwnHalfOfTheChangeLeg() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        let m2 = hand(payer.begin(), to: receiver)
        let m3 = hand(m2, to: payer)
        _ = hand(m3, to: receiver)

        XCTAssertNil(payer.sealChange("cashuBnope"), "a payer cannot send change")
        XCTAssertNil(receiver.sealChangeTaken(), "a receiver cannot say it kept the change")
        XCTAssertNotNil(receiver.sealChange("cashuByes"))
        XCTAssertNotNil(payer.sealChangeTaken())
    }

    /// Change out of place stops the link, the way every other message does.
    func testChangeInTheWrongPlaceStopsTheLink() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)

        // change before there is a key at all
        var bare = Data([0x07]); bare.append(contentsOf: [1, 2, 3])
        guard case .stop = payer.received(bare) else { return XCTFail("change before a key was taken") }

        // and a receipt arriving at the payer, which only the receiver may hear
        let m2 = hand(payer.begin(), to: receiver)
        let m3 = hand(m2, to: payer)
        _ = hand(m3, to: receiver)
        let m8 = try XCTUnwrap(payer.sealChangeTaken())
        guard case .stop = payer.received(m8) else { return XCTFail("the payer heard its own receipt") }
    }

    /// Every change message is the same size on the wire, whatever it carries.
    ///
    /// A payment is bucketed in 4096s because it can be any size. Change cannot
    /// be: its size tracks the number of pieces, which tracks the amount, so a
    /// bucket would say roughly how much is going back and from that roughly what
    /// was paid — on a link somebody chose because it says nothing.
    func testChangeIsAlwaysTheSameSizeOnTheWire() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        let m2 = hand(payer.begin(), to: receiver)
        let m3 = hand(m2, to: payer)
        _ = hand(m3, to: receiver)

        let small = try XCTUnwrap(receiver.sealChange("cashuBa"))
        let large = try XCTUnwrap(receiver.sealChange(String(repeating: "x", count: 1200)))
        XCTAssertEqual(small.count, large.count,
                       "a change message the size of its token would say how much it is")
    }

    /// Change too big for the one size still crosses, and arrives whole.
    ///
    /// It was refused outright, so 1,190 sats of change — six locked pieces,
    /// more than 2,048 bytes — never went back to the phone that had overpaid.
    func testChangeTooBigForOneSizeStillCrosses() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        let m2 = hand(payer.begin(), to: receiver)
        let m3 = hand(m2, to: payer)
        _ = hand(m3, to: receiver)

        let big = "cashuB" + String(repeating: "y", count: 3000)
        let m7 = try XCTUnwrap(receiver.sealChange(big), "large change was refused")
        guard case .change(let back) = payer.received(m7) else { return XCTFail("no change") }
        XCTAssertEqual(back, big)
    }

    /// The promise is the whole protection: a payer that reveals a key it did
    /// not promise is someone who waited to see the receiver's and then chose.
    func testAKeyThatWasNotPromisedIsRefused() {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)

        _ = hand(payer.begin(), to: receiver)      // the receiver now holds the promise
        // a reveal carrying somebody else's key, against that promise
        let other = TapSession(role: .payer, service: service)
        let forged = Data([0x03]) + other.publicKey + TapCrypto.randomNonce()
        if case .stop(let why) = receiver.received(forged) {
            XCTAssertTrue(why.contains("promised"), why)
        } else {
            XCTFail("a key that was never promised was accepted")
        }
    }

    /// Two sessions that never agreed cannot read each other.
    func testAnOfferFromAnotherHandshakeDoesNotOpen() throws {
        let a = TapCrypto.newService()
        let payerA = TapSession(role: .payer, service: a)
        let receiverA = TapSession(role: .receiver, service: a)
        _ = hand(hand(hand(payerA.begin(), to: receiverA), to: payerA), to: receiverA)

        let b = TapCrypto.newService()
        let payerB = TapSession(role: .payer, service: b)
        let receiverB = TapSession(role: .receiver, service: b)
        _ = hand(hand(hand(payerB.begin(), to: receiverB), to: payerB), to: receiverB)

        let fromB = try XCTUnwrap(receiverB.sealOffer("{\"v\":2,\"inv\":\"lnbc1\"}"))
        if case .stop(let why) = payerA.received(fromB) {
            XCTAssertTrue(why.contains("would not open"), why)
        } else {
            XCTFail("a payer opened an offer from a handshake it was not part of")
        }
    }

    /// One payer per arming, on the protocol side.
    ///
    /// The receiver holds one conversation and hands the offer to whoever
    /// shook hands first. A second payer arriving with its own handshake gets
    /// a session of its own — which is exactly why TapLink stops advertising
    /// and refuses writes from anybody but the payer holding the slot. This
    /// pins the half that lives here: two payers never share keys or a code,
    /// so an offer sealed for one cannot be opened by the other.
    func testTwoPayersNeverShareAHandshake() throws {
        let service = TapCrypto.newService()
        let first = TapSession(role: .payer, service: service)
        let second = TapSession(role: .payer, service: service)
        let toFirst = TapSession(role: .receiver, service: service)
        let toSecond = TapSession(role: .receiver, service: service)

        _ = hand(hand(hand(first.begin(), to: toFirst), to: first), to: toFirst)
        _ = hand(hand(hand(second.begin(), to: toSecond), to: second), to: toSecond)
        XCTAssertNotEqual(first.code, second.code, "two payers, two codes")

        // the offer meant for the first payer is unreadable by the second
        let offer = try XCTUnwrap(toFirst.sealOffer("{\"v\":2,\"inv\":\"lnbc1\"}"))
        if case .stop(let why) = second.received(offer) {
            XCTAssertTrue(why.contains("would not open"), why)
        } else {
            XCTFail("a second payer opened an offer sealed for the first")
        }
    }

    /// Messages arriving in the wrong order, or out of nowhere, stop the link
    /// rather than being half-handled.
    func testMessagesOutOfPlaceStopTheLink() {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)

        if case .stop = payer.received(Data([0x04, 1, 2, 3])) {} else { XCTFail("an offer before any key") }
        if case .stop = receiver.received(Data([0x05, 1, 2, 3])) {} else { XCTFail("a payment before any key") }
        if case .stop = receiver.received(Data([0x63, 1, 2])) {} else { XCTFail("a kind nobody knows") }
        if case .stop = receiver.received(Data()) {} else { XCTFail("nothing at all") }
        if case .stop = receiver.received(Data([0x01, TapCrypto.version, 1, 2])) {} else { XCTFail("a promise of the wrong size") }
        if case .stop = receiver.received(Data([0x01])) {} else { XCTFail("a promise with nothing in it") }
    }

    /// The version goes first, in the clear, in the first message each way.
    func testEachSideSaysItsVersionFirst() {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        guard case .send(let m1) = payer.begin() else { return XCTFail("no promise") }
        XCTAssertEqual(Array(m1.prefix(2)), [0x01, TapCrypto.version])
        XCTAssertEqual(m1.count, 2 + 32)
        guard case .send(let m2) = receiver.received(m1) else { return XCTFail("no hello") }
        XCTAssertEqual(Array(m2.prefix(2)), [0x02, TapCrypto.version])
        XCTAssertEqual(m2.count, 2 + 32 + TapCrypto.nonceLength)
    }

    /// A Foxy from before a version was sent promises a key with nothing in
    /// front of it. It is told apart at that first message, so the person can
    /// be told why the two phones will not talk; it used to look like a tap
    /// that did nothing.
    func testAPhoneFromBeforeTheVersionIsToldApart() {
        let service = TapCrypto.newService()
        let receiver = TapSession(role: .receiver, service: service)
        let oldPromise = Data([0x01]) + Data(repeating: 7, count: 32)
        XCTAssertEqual(receiver.received(oldPromise), .otherVersion(theirs: 2, reply: nil))
        XCTAssertNil(receiver.code, "and no key was agreed with it")

        let payer = TapSession(role: .payer, service: service)
        _ = payer.begin()
        let oldHello = Data([0x02]) + Data(repeating: 7, count: 32 + TapCrypto.nonceLength)
        XCTAssertEqual(payer.received(oldHello), .otherVersion(theirs: 2, reply: nil))
        XCTAssertNil(payer.code)
    }

    /// A phone that speaks another version is answered with this phone's own,
    /// and nothing else: the version is read before the size, so whatever a
    /// later version puts after it, both phones learn why they cannot talk.
    func testAnotherVersionIsAnsweredWithThisOne() {
        let service = TapCrypto.newService()
        let receiver = TapSession(role: .receiver, service: service)
        let newer = TapCrypto.version + 1
        let promise = Data([0x01, newer]) + Data(repeating: 7, count: 40)     // a size this version does not know
        let said = receiver.received(promise)
        XCTAssertEqual(said, .otherVersion(theirs: Int(newer), reply: Data([0x02, TapCrypto.version])))
        XCTAssertNil(receiver.code)

        // and the payer at the other end of such an answer reads it the same way
        let payer = TapSession(role: .payer, service: service)
        _ = payer.begin()
        XCTAssertEqual(payer.received(Data([0x02, newer])), .otherVersion(theirs: Int(newer), reply: nil))
        XCTAssertNil(payer.code)
    }

    /// The kind of a sealed message is in the clear, and is part of what was
    /// sealed. Relabelled on the air, a message stops the link instead of
    /// being read as something its sender never said.
    func testASealedMessageRelabelledOnTheAirStopsTheLink() throws {
        let service = TapCrypto.newService()
        let payer = TapSession(role: .payer, service: service)
        let receiver = TapSession(role: .receiver, service: service)
        _ = hand(hand(hand(payer.begin(), to: receiver), to: payer), to: receiver)
        let offer = try XCTUnwrap(receiver.sealOffer("{\"v\":2,\"req\":\"creqA\"}"))
        guard case .offer = payer.received(offer) else { return XCTFail("no offer") }

        // the payer asks to hear it again (M12); on the air it becomes "I kept the change" (M8)
        var asked = try XCTUnwrap(payer.sealAgain())
        XCTAssertEqual(asked[0], 0x0C)
        asked[0] = 0x08
        if case .stop(let why) = receiver.received(asked) {
            XCTAssertTrue(why.contains("would not open"), why)
        } else {
            XCTFail("a question relabelled as a receipt for change was believed")
        }
    }

    /// Everything after the handshake is padded to a size that says nothing
    /// about the amount.
    func testWhatGoesOverTheWireIsAlwaysTheSameShape() throws {
        func linkedPair() -> (TapSession, TapSession) {
            let service = TapCrypto.newService()
            let p = TapSession(role: .payer, service: service)
            let r = TapSession(role: .receiver, service: service)
            _ = hand(hand(hand(p.begin(), to: r), to: p), to: r)
            return (p, r)
        }
        let (_, r1) = linkedPair()
        let (_, r2) = linkedPair()
        let small = try XCTUnwrap(r1.sealOffer("{\"v\":2}"))
        let longer = try XCTUnwrap(r2.sealOffer(String(repeating: "x", count: 900)))
        XCTAssertEqual(small.count, longer.count, "an offer is one size whatever is in it")

        // a payment falls into a block, so its size says "about this much"
        let (p3, _) = linkedPair()
        let (p4, _) = linkedPair()
        let few = try XCTUnwrap(p3.sealPayment(String(repeating: "a", count: 300)))
        let many = try XCTUnwrap(p4.sealPayment(String(repeating: "a", count: 3000)))
        XCTAssertEqual(few.count, many.count, "payments inside one block are the same size")
        let (p5, _) = linkedPair()
        let lots = try XCTUnwrap(p5.sealPayment(String(repeating: "a", count: 5000)))
        XCTAssertGreaterThan(lots.count, few.count, "a much larger payment is a larger bucket")
    }
}
