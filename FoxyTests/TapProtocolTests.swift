import XCTest
@testable import Foxy

/// Tap to pay without a radio: the code, the invoice check, the framing and
/// the proximity rule (TAP-TO-PAY.md). The simulator has no Bluetooth.
final class TapProtocolTests: XCTestCase {

    let invoice = "lnbc10n1pn9xyzpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq"

    func testCodeIsFourDigitsAndFixed() {
        let nonce = Data(repeating: 7, count: 16)
        let a = TapProtocol.code(payload: invoice, nonce: nonce)
        XCTAssertEqual(a.count, 4)
        XCTAssertTrue(a.allSatisfy(\.isNumber))
        XCTAssertEqual(a, TapProtocol.code(payload: invoice, nonce: nonce))
    }

    /// Both inputs move the code: another offer, or another nonce.
    func testCodeDependsOnPayloadAndNonce() {
        var differ = 0
        for i in 0..<50 {
            let n1 = Data((0..<16).map { UInt8(($0 + i) & 0xff) })
            let n2 = Data((0..<16).map { UInt8(($0 + i + 1) & 0xff) })
            if TapProtocol.code(payload: invoice, nonce: n1) != TapProtocol.code(payload: invoice, nonce: n2) { differ += 1 }
            if TapProtocol.code(payload: invoice, nonce: n1) != TapProtocol.code(payload: invoice + "q", nonce: n1) { differ += 1 }
        }
        XCTAssertGreaterThan(differ, 95)
    }

    /// The published formula, so another implementation can be checked against it.
    func testCodeMatchesTheFormula() {
        let nonce = Data(0..<16)
        let code = TapProtocol.code(payload: "lnbc1test", nonce: nonce)
        var msg = Data("foxy tap v1".utf8); msg.append(0); msg.append(Data("lnbc1test".utf8)); msg.append(nonce)
        let d = Array(SHA256Hex.digest(msg))
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        XCTAssertEqual(code, String(format: "%04u", n % 10000))
    }

    /// What the receiver offers, and what a payer must refuse before it has
    /// committed anything. Either half may be missing; neither may be junk.
    func testOnlyAWellFormedOfferPasses() {
        let req = "creqApGF0gaNhdGVub3N0cmFheDQ3YWJjZGVmMTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNk"
        XCTAssertTrue(TapProtocol.isPayload("{\"v\":2,\"inv\":\"\(invoice)\"}"))
        XCTAssertTrue(TapProtocol.isPayload("{\"v\":2,\"req\":\"\(req)\"}"))
        XCTAssertTrue(TapProtocol.isPayload("{\"v\":2,\"inv\":\"\(invoice)\",\"req\":\"\(req)\"}"))
        // neither half
        XCTAssertFalse(TapProtocol.isPayload("{\"v\":2}"))
        // padded, which is what cashu-ts actually produces
        XCTAssertTrue(TapProtocol.isPayload("{\"v\":2,\"req\":\"\(req)=\"}"))
        XCTAssertTrue(TapProtocol.isPayload("{\"v\":2,\"req\":\"\(req)==\"}"))
        XCTAssertTrue(TapProtocol.isRequest(req + "="))
        // a half that is not what it claims
        XCTAssertFalse(TapProtocol.isPayload("{\"v\":2,\"inv\":\"bc1qxy2kgdygjrsqtzq2n0\"}"))
        XCTAssertFalse(TapProtocol.isPayload("{\"v\":2,\"req\":\"cashuBo2F0gaJhaUgA\"}"))
        // not this protocol, or not JSON at all
        XCTAssertFalse(TapProtocol.isPayload("{\"v\":3,\"inv\":\"\(invoice)\"}"))
        XCTAssertFalse(TapProtocol.isPayload(invoice))
        XCTAssertFalse(TapProtocol.isPayload("{"))
        XCTAssertFalse(TapProtocol.isPayload("{\"v\":2,\"inv\":\"lnbc10n1" + String(repeating: "q", count: 5000) + "\"}"))
    }

    /// The code covers the whole offer, not just the invoice in it: the mint
    /// and the delivery address live in the request half, and the four digits
    /// two people compare must stand for those too.
    func testCodeCoversTheRequestHalfAsWell() {
        let nonce = Data(repeating: 3, count: 16)
        let a = "{\"v\":2,\"inv\":\"\(invoice)\",\"req\":\"creqAaaaaaaaaaaaaaaaaaaa\"}"
        let b = "{\"v\":2,\"inv\":\"\(invoice)\",\"req\":\"creqAbbbbbbbbbbbbbbbbbbbb\"}"
        XCTAssertNotEqual(TapProtocol.code(payload: a, nonce: nonce),
                          TapProtocol.code(payload: b, nonce: nonce))
    }

    func testOnlyInvoicesPass() {
        XCTAssertTrue(TapProtocol.isInvoice(invoice))
        XCTAssertTrue(TapProtocol.isInvoice(invoice.uppercased()))
        XCTAssertFalse(TapProtocol.isInvoice("cashuBo2F0gaJhaUgA"))
        XCTAssertFalse(TapProtocol.isInvoice("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"))
        XCTAssertFalse(TapProtocol.isInvoice("lnbc10n1" + String(repeating: "q", count: 3000)))
        XCTAssertFalse(TapProtocol.isInvoice("lnbc10n1pn9<script>"))
        XCTAssertFalse(TapProtocol.isInvoice("lnbc10n1pN9xyz" + String(repeating: "q", count: 40)))
    }

    func testFramingRoundTripsInPieces() {
        let offer = "{\"v\":2,\"inv\":\"\(invoice)\"}"
        let frame = TapProtocol.frame(offer)
        for size in [1, 20, 182, 500] {
            var a = TapProtocol.Assembler()
            var got: TapProtocol.Assembler.Result = .more
            var i = 0
            while i < frame.count {
                got = a.add(frame.subdata(in: i..<min(i + size, frame.count)))
                i += size
            }
            XCTAssertEqual(got, .done(offer), "pieces of \(size)")
        }
    }

    func testFramingRefusesTooLongOrNotAnOffer() {
        let offer = "{\"v\":2,\"inv\":\"\(invoice)\"}"
        var a = TapProtocol.Assembler()
        XCTAssertEqual(a.add(Data([0x20, 0x00])), .bad)          // 8192 announced
        var b = TapProtocol.Assembler()
        XCTAssertEqual(b.add(TapProtocol.frame("cashuBo2F0gaJhaUgAAAAAAAAAAAAA")), .bad)
        var c = TapProtocol.Assembler()
        XCTAssertEqual(c.add(TapProtocol.frame(offer) + Data([1])), .bad)   // more than announced
    }

    /* ---- the payment coming back over the same link ---------------------- */

    /// A payment is proofs and can be long, so it crosses in many pieces. The
    /// assembler for it is the same one, with a bigger cap and no opinion about
    /// what the text means — the page parses it with a real parser.
    func testAPaymentRoundTripsInPieces() {
        let body = "{\"proofs\":[" + Array(repeating: "{\"amount\":1}", count: 400).joined(separator: ",") + "]}"
        let frame = TapProtocol.frame(body)
        XCTAssertGreaterThan(frame.count, 4096, "longer than an offer may be")
        for size in [20, 182, 512] {
            var a = TapProtocol.Assembler.forPayment()
            var got: TapProtocol.Assembler.Result = .more
            var i = 0
            while i < frame.count {
                got = a.add(frame.subdata(in: i..<min(i + size, frame.count)))
                i += size
            }
            XCTAssertEqual(got, .done(body), "pieces of \(size)")
        }
    }

    /// Anyone in Bluetooth range can write here, so it is bounded: a stranger
    /// cannot announce a payment larger than the cap and fill this phone.
    func testAPaymentLargerThanTheCapIsRefused() {
        var a = TapProtocol.Assembler.forPayment()
        XCTAssertEqual(a.add(Data([0xff, 0xff])), .bad, "65535 announced, past the cap")
        XCTAssertLessThan(TapProtocol.maxPayment, 0xffff,
                          "a cap the two-byte length cannot reach is not a cap")
        var b = TapProtocol.Assembler.forPayment()
        XCTAssertEqual(b.add(Data([0x00, 0x00])), .bad, "nothing announced")
    }

    /// The offer's assembler keeps its own, smaller rules: a payment-sized
    /// body must not sail through the door the offer comes in by.
    func testTheOfferDoorStaysNarrow() {
        var a = TapProtocol.Assembler()
        XCTAssertEqual(a.add(Data([0x20, 0x00])), .bad, "8192 announced at the offer door")
    }

    /* ---- proximity ------------------------------------------------------ */

    let a = UUID(), b = UUID()

    func feed(_ p: inout TapProximity, _ id: UUID, _ dbm: Int, from t0: TimeInterval, to t1: TimeInterval) {
        var t = t0
        while t <= t1 + 1e-9 { p.add(id, dbm: dbm, at: t); t += 0.05 }
    }

    func testNothingHeard() {
        var p = TapProximity()
        XCTAssertEqual(p.verdict(at: 10), .nothing)
    }

    func testCloseForLongEnoughIsNear() {
        var p = TapProximity()
        feed(&p, a, -30, from: 0, to: 0.1)
        XCTAssertEqual(p.verdict(at: 0.1), .far(-30), "not held long enough yet")
        feed(&p, a, -30, from: 0.15, to: 0.4)
        XCTAssertEqual(p.verdict(at: 0.4), .near(a, -30))
    }

    /// One strong reading among weak ones still cannot pick a phone, which is
    /// what the shorter hold has to keep true.
    func testAReflectionAmongWeakReadingsIsNotATap() {
        var p = TapProximity()
        feed(&p, a, -62, from: 0, to: 0.4)
        p.add(a, dbm: -30, at: 0.41)
        XCTAssertEqual(p.verdict(at: 0.41), .far(-62))
    }

    /* Measurements with the payer as central, on two phones. Two feet paired
     * at -54 and had to come down to four inches — and back out to -50 when
     * a third phone touching read -45 to -51. What is refused as "apart" is now -52 and beyond. */
    func testTwoFeetIsRefusedAndTouchingIsNot() {
        for (dbm, what) in [(-52, "apart"), (-54, "apart")] {
            var p = TapProximity()
            feed(&p, a, dbm, from: 0, to: 0.5)
            XCTAssertEqual(p.verdict(at: 0.5), .far(dbm), "\(what) at \(dbm) should be refused")
        }
        for dbm in [-26, -30] {
            var p = TapProximity()
            feed(&p, a, dbm, from: 0, to: 0.5)
            XCTAssertEqual(p.verdict(at: 0.5), .near(a, dbm), "touching at \(dbm) should connect")
        }
    }

    /* An open link read -37 at two feet while the advertisements either side of
     * it said -46 — a reflection, and it decided the tap because the
     * advertisement pool happened to be empty at that instant. The link may
     * confirm; it may not decide. */
    func testALinkReadingCannotOutvoteTheAdvertisement() {
        var p = TapProximity()
        // an advertisement clearly apart (-52 since the cut-off moved to -50), then let it age out of the pool
        p.add(a, dbm: -52, at: 0)
        p.addLinked(a, dbm: -37, at: 3.0)
        p.addLinked(a, dbm: -37, at: 3.6)
        if case .near = p.verdict(at: 3.7) {
            XCTFail("a link reading decided on its own against a -52 advertisement")
        }
        // and with the advertisement inside the threshold, the link may confirm
        var q = TapProximity()
        q.add(a, dbm: -30, at: 0)
        q.addLinked(a, dbm: -29, at: 3.0)
        q.addLinked(a, dbm: -29, at: 3.6)
        XCTAssertEqual(q.verdict(at: 3.7), .near(a, -29))
    }

    /* The gate has to let a phone through when the advertisements agree.
     *
     * Requiring the link to match the last advertisement is only safe while
     * advertisements keep arriving. They stopped being recorded the moment a
     * warm link opened, so the last one was always the far reading that
     * triggered the warming — and a phone held against another was refused
     * over and over ("almost touching and nothing
     * happens"). `didDiscover` keeps feeding the pool now; this is the shape
     * that must keep working. */
    func testAFreshAdvertisementLetsTheLinkConfirm() {
        var p = TapProximity()
        // the far reading that started the warming, then a close one as the
        // phones come together, then the link agreeing
        p.add(a, dbm: -58, at: 0)
        p.add(a, dbm: -30, at: 2.4)
        p.addLinked(a, dbm: -29, at: 2.5)
        p.addLinked(a, dbm: -29, at: 3.1)
        feed(&p, a, -30, from: 2.4, to: 3.1)
        XCTAssertEqual(p.verdict(at: 3.1), .near(a, -30))
    }

    func testAcrossTheRoomIsFar() {
        var p = TapProximity()
        feed(&p, a, -70, from: 0, to: 1)
        XCTAssertEqual(p.verdict(at: 1), .far(-70))
    }

    /// One lucky reading does not make a phone near: the median does.
    func testOneSpikeIsNotEnough() {
        var p = TapProximity()
        feed(&p, a, -65, from: 0, to: 0.8)
        p.add(a, dbm: -30, at: 0.81)
        XCTAssertEqual(p.verdict(at: 0.81), .far(-65))
    }

    /* Two phones as close: the closer wins, judged across a second. Before that it was a tie and the person was asked to hold
     * nearer one phone. */
    func testTwoPhonesAsCloseTheCloserWinsAfterASecond() {
        var p = TapProximity()
        feed(&p, a, -30, from: 0, to: 0.8)
        feed(&p, b, -34, from: 0, to: 0.8)
        if case .near = p.verdict(at: 0.8) { XCTFail("decided before a second had passed") }
        feed(&p, a, -30, from: 0.8, to: 1.1)
        feed(&p, b, -34, from: 0.8, to: 1.1)
        XCTAssertEqual(p.verdict(at: 1.1), .near(a, -30))
    }

    func testAClearlyCloserPhoneWins() {
        var p = TapProximity()
        feed(&p, a, -30, from: 0, to: 0.8)
        feed(&p, b, -62, from: 0, to: 0.8)
        XCTAssertEqual(p.verdict(at: 0.8), .near(a, -30))
    }

    /// Across a room is not a tap, and never was. The threshold itself has
    /// moved twice — -48, then -38, then back — so what is pinned here is the
    /// shape, not the number: a reading far below it stays far.
    func testWellBeyondTheThresholdIsFar() {
        var p = TapProximity()
        feed(&p, a, -62, from: 0, to: 0.8)
        XCTAssertEqual(p.verdict(at: 0.8), .far(-62))
    }

    /* The bands two phones produce with the *receiver* advertising,
     * which is the arrangement now: pressed together reads -38 to
     * -41 and two feet reads -46 to -48. Seven decibels across two feet, which
     * is a far flatter curve than the other direction gave (-37 to -44
     * touching, -47 to -56 at a hand's width) — and why the
     * threshold that suited that one let two feet pair in this one.
     *
     * A hand's width has not been measured in this direction. It sits between
     * the two bands and the threshold is -44, so it should be a tap; when it
     * is measured this is the test to put the number in. */
    /* -46 and -48 were "two feet" on the XS/17 pair and refused. Later
     * an iPhone 15 Pro Max touching the 17 Pro read -45 to -51, so
     * the cut-off moved to -50 and those two readings are taps now; what a
     * wrong phone at two feet meets instead is the code and the amount on
     * the confirmation. Clearly apart, -52 and beyond, is still refused. */
    /* And back to -40: -50 paired too readily. A pair that
     * reads weaker than -40 when touching is told TAP TO PAY and held tighter. */
    /* And to -30, on trial: the readings in the tests below that
     * stand for "touching" moved up ten with it. */
    /* Which edges meet, by the pair (TapEdges): the matrix of an XS,
     * a 15 Pro Max and a 17 Pro, every ordered pair, and the assumed ones. */
    func testEdgesFollowTheMeasuredPairs() {
        let xs = "iPhone11,2", p15 = "iPhone16,2", p17 = "iPhone18,1"
        for (payer, receiver) in [(p17, xs), (p17, p15), (xs, p15), (p15, xs)] {
            let e = TapEdges.edges(payer: payer, receiver: receiver)
            XCTAssertEqual(e.payer, "left", "\(payer) paying \(receiver)")
            XCTAssertEqual(e.receiver, "right", "\(payer) paying \(receiver)")
        }
        for payer in [xs, p15] {
            let e = TapEdges.edges(payer: payer, receiver: p17)
            XCTAssertEqual(e.payer, "right", "\(payer) paying a 17 Pro")
            XCTAssertEqual(e.receiver, "left", "\(payer) paying a 17 Pro")
        }
        // assumed to match the 17 Pro: its Max, and the 18 Pro and Pro Max
        for receiver in ["iPhone18,2", "iPhone19,2", "iPhone19,3", "iPhone19,7"] {
            XCTAssertEqual(TapEdges.edges(payer: xs, receiver: receiver).receiver, "left", receiver)
        }
        // a model nobody has measured, or none read yet, is the default
        XCTAssertEqual(TapEdges.edges(payer: xs, receiver: "iPhone14,5").receiver, "right")
        XCTAssertEqual(TapEdges.edges(payer: xs, receiver: "").payer, "left")
    }

    func testWeakerThanTouchingIsNotATap() {
        for dbm in [-42, -46, -48] {
            var p = TapProximity()
            feed(&p, a, dbm, from: 0, to: 0.8)
            XCTAssertEqual(p.verdict(at: 0.8), .far(dbm), "weaker than touching at \(dbm)")
        }
    }

    func testClearlyApartOnAnyPairIsNot() {
        for dbm in [-52, -54] {
            var p = TapProximity()
            feed(&p, a, dbm, from: 0, to: 0.8)
            XCTAssertEqual(p.verdict(at: 0.8), .far(dbm), "apart at \(dbm)")
        }
    }

    func testPressedTogetherIsATap() {
        var p = TapProximity()
        feed(&p, a, -30, from: 0, to: 0.8)
        XCTAssertEqual(p.verdict(at: 0.8), .near(a, -30))
    }

    func testClearlyApartIsNot() {
        var p = TapProximity()
        feed(&p, a, -60, from: 0, to: 0.8)
        XCTAssertEqual(p.verdict(at: 0.8), .far(-60))
    }

    /* Warming: the link is opened before the verdict so that the verdict costs
     * one round trip instead of four. It must reach further than a tap and
     * still not reach across a room, and it must not need the hold — the hold
     * is what it exists to run underneath. */
    func testWarmingReachesFurtherThanATap() {
        var p = TapProximity()
        feed(&p, a, -60, from: 0, to: 0.1)
        XCTAssertEqual(p.verdict(at: 0.1), .far(-60), "not a tap")
        XCTAssertEqual(p.warmest(at: 0.1), a, "but worth opening a link to")
    }

    func testWarmingDoesNotReachAcrossARoom() {
        var p = TapProximity()
        feed(&p, a, -80, from: 0, to: 0.5)
        XCTAssertNil(p.warmest(at: 0.5))
    }

    /// One reading is a reflection, and a link is not opened on one.
    func testOneReadingDoesNotWarm() {
        var p = TapProximity()
        p.add(a, dbm: -30, at: 0)
        XCTAssertNil(p.warmest(at: 0))
        p.add(a, dbm: -30, at: 0.05)
        XCTAssertEqual(p.warmest(at: 0.05), a)
    }

    func testWarmingPicksTheStrongest() {
        var p = TapProximity()
        feed(&p, a, -62, from: 0, to: 0.2)
        feed(&p, b, -30, from: 0, to: 0.2)
        XCTAssertEqual(p.warmest(at: 0.2), b)
    }

    /// The verdict does not care where a reading came from — an advertisement
    /// or a question put to an open link — which is what lets the warm link
    /// keep feeding it after iOS stops reporting that phone's advertisements.
    func testReadingsFromAnySourceDecideTogether() {
        var p = TapProximity()
        feed(&p, a, -60, from: 0, to: 0.2)      // advertisements, far
        XCTAssertEqual(p.verdict(at: 0.2), .far(-60))
        feed(&p, a, -30, from: 0.25, to: 0.6)   // the link, close
        XCTAssertEqual(p.verdict(at: 0.6), .near(a, -30))
        XCTAssertEqual(p.lastHeard(a), -30)
    }

    /* A pair decides, because an open link answers about once a second and
     * three readings were never arriving. Safe only because the
     * pair is read at its weaker half — which is the point of the second case:
     * -40 beside -52 is two feet with one strong reflection in it, and it is
     * refused on the -52. */
    func testAPairOfCloseReadingsIsATap() {
        var p = TapProximity()
        p.add(a, dbm: -26, at: 0)
        p.add(a, dbm: -30, at: 1.0)
        XCTAssertEqual(p.verdict(at: 1.0), .near(a, -30), "the weaker of the two")

        var q = TapProximity()
        q.add(a, dbm: -30, at: 0)
        q.add(a, dbm: -52, at: 1.0)
        XCTAssertEqual(q.verdict(at: 1.0), .far(-52), "the weaker of the two, and it is apart")
    }

    func testAPairWithOneReflectionIsNot() {
        var p = TapProximity()
        p.add(a, dbm: -70, at: 0)
        p.add(a, dbm: -30, at: 1.0)
        XCTAssertEqual(p.verdict(at: 1.0), .far(-70), "one lucky reading cannot decide")
    }

    func testTheMedianIsUnchangedForOddCounts() {
        XCTAssertEqual(TapProximity.median([-70, -50, -30]), -50)
        XCTAssertEqual(TapProximity.median([-90, -70, -50, -30, -10]), -50)
    }

    func testOldReadingsAreForgotten() {
        var p = TapProximity()
        feed(&p, a, -30, from: 0, to: 0.8)
        XCTAssertEqual(p.verdict(at: 5), .nothing)
    }

    /* Readings from an open link cost a round trip each and arrive about twice
     * a second, where advertisements arrive ten times. The memory has to be
     * long enough that a slow source still fills the median — at one second it
     * did not, and a payer well inside the threshold was refused for twenty
     * seconds. */
    func testASlowSourceStillReachesAVerdict() {
        var p = TapProximity()
        var t = 0.0
        while t <= 1.8 { p.add(a, dbm: -30, at: t); t += 0.6 }   // under twice a second
        XCTAssertEqual(p.verdict(at: 1.8), .near(a, -30))
    }

    /// And when it is short, the log says which half of the rule it was short
    /// on — the median, or how often the phone is being heard.
    func testTheVerdictSaysWhatItWasShortOf() {
        var p = TapProximity()
        feed(&p, a, -70, from: 0, to: 0.8)
        _ = p.verdict(at: 0.8)
        XCTAssertEqual(p.why, "too far")
        var q = TapProximity()
        q.add(a, dbm: -30, at: 0)
        _ = q.verdict(at: 0)
        XCTAssertEqual(q.why, "only 1 reading(s)")
        var r = TapProximity()
        r.add(a, dbm: -30, at: 0)
        r.add(a, dbm: -30, at: 0.1)
        _ = r.verdict(at: 0.1)
        XCTAssertEqual(r.why, "heard for 0.10s")
    }

    func testASlowSourceIsStillForgotten() {
        var p = TapProximity()
        var t = 0.0
        while t <= 1.8 { p.add(a, dbm: -30, at: t); t += 0.6 }
        XCTAssertEqual(p.verdict(at: 6), .nothing)
    }

    func testNoReadingIsIgnored() {
        var p = TapProximity()
        feed(&p, a, 127, from: 0, to: 1)
        XCTAssertEqual(p.verdict(at: 1), .nothing)
    }
}

import CryptoKit
private enum SHA256Hex {
    static func digest(_ d: Data) -> SHA256.Digest { SHA256.hash(data: d) }

    // MARK: change handed over, and progress (the radio's rules, without a radio)

    /// The page is answered once; a payer's word after that is "late", and
    /// anything else is nothing.
    func testChangeIsGivenBackOnlyOnThePayersWord() {
        let prompt = ChangeHandover()
        XCTAssertEqual(prompt.heard(kept: true), .kept, "the payer said so in time")
        XCTAssertNil(prompt.heard(kept: false), "a clock running out afterwards is nothing")
        XCTAssertEqual(prompt.heard(kept: true), .late, "and a second word is heard as late, never as a second answer")

        let slow = ChangeHandover()
        XCTAssertFalse(slow.answered)
        XCTAssertEqual(slow.heard(kept: false), .notHanded, "the wait ran out: the page shows the code")
        XCTAssertTrue(slow.answered)
        XCTAssertNil(slow.heard(kept: false), "the payer going afterwards changes nothing")
        XCTAssertEqual(slow.heard(kept: true), .late, "a suspended payer that kept it after all takes the code down")

        let gone = ChangeHandover()
        XCTAssertEqual(gone.heard(kept: false), .notHanded)
        XCTAssertNil(gone.heard(kept: false))
    }

    /// Every four points, never backwards, and 99 at most while the last byte
    /// is still to come.
    func testProgressIsSaidEveryFourPointsAndNoMoreOften() {
        var p = TapProgress()
        XCTAssertEqual(p.step(done: 0, of: 200), 0, "the first word is said at once")
        XCTAssertNil(p.step(done: 4, of: 200), "two points is not enough")
        XCTAssertEqual(p.step(done: 8, of: 200), 4)
        XCTAssertNil(p.step(done: 6, of: 200), "it does not go back")
        XCTAssertEqual(p.step(done: 200, of: 200), 100)
        XCTAssertNil(p.step(done: 200, of: 200), "and is not said twice")

        var r = TapProgress()
        XCTAssertEqual(r.step(done: 500, of: 500, cap: 99), 99, "the receiver never says 100 before the payment is whole")
        XCTAssertNil(r.step(done: 1, of: 0), "nothing to measure against says nothing")

        var said = 0
        var many = TapProgress()
        for i in 0...1000 where many.step(done: i, of: 1000) != nil { said += 1 }
        XCTAssertEqual(said, 26, "a thousand writes are twenty-six words to the page")
    }

    /// How far a message in hand has got: nothing until its length is known,
    /// then what has arrived against what it said, with its kind.
    func testAMessageInHandSaysHowFarItHasGot() {
        var b = TapProtocol.Bytes()
        XCTAssertNil(b.progress)
        XCTAssertEqual(b.add(Data([0x03])), .more)
        XCTAssertNil(b.progress, "one byte is not yet a length")
        XCTAssertEqual(b.add(Data([0xE8, 0x05, 0x01])), .more)   // 1000 bytes to come, kind 0x05
        let got = b.progress
        XCTAssertEqual(got?.have, 4)
        XCTAssertEqual(got?.want, 1002)
        XCTAssertEqual(got?.kind, 0x05)
        XCTAssertTrue(TapSession.carriesPayment(got?.kind))
        XCTAssertTrue(TapSession.carriesPayment(0x0D), "a part of a payment is payment too")
        XCTAssertFalse(TapSession.carriesPayment(0x06), "a result is not")
        XCTAssertFalse(TapSession.carriesPayment(nil))
    }
}
