import Foundation
import CryptoKit

/// Tap to pay: the parts with no radio in them, so they can be tested on a
/// simulator, which has no Bluetooth (TAP-TO-PAY.md).
enum TapProtocol {

    static let service = "F0C5A7A0-7A11-4B1D-9E57-F0C5F0C5A001"
    /// Notify: two bytes of length, big-endian, then the payload's UTF-8.
    static let invoiceCharacteristic = "F0C5A7A0-7A11-4B1D-9E57-F0C5F0C5A002"
    /// Write with response: the payer's 16 random bytes.
    static let nonceCharacteristic = "F0C5A7A0-7A11-4B1D-9E57-F0C5F0C5A003"
    /// Write with response: the payment itself, framed like the offer.
    ///
    /// The ecash goes back over the link that is already open rather than over
    /// a fresh onion rendezvous, which is seconds of the wait for something the
    /// two phones are already holding between them. Nothing about it is secret
    /// to the link: the proofs are bearer money, and anyone in Bluetooth range
    /// who could take them could equally take the token off the QR code the
    /// screen was showing a moment earlier.
    static let paymentCharacteristic = "F0C5A7A0-7A11-4B1D-9E57-F0C5F0C5A004"
    /// A payment is proofs, and a big one is many: room for them, and a cap so
    /// a stranger in range cannot fill this phone's memory by writing forever.
    ///
    /// Below 65535 on purpose. The frame announces its length in two bytes, so
    /// 65535 is the most that can ever be claimed — a cap at or above that is
    /// not a cap at all, it just reads like one. At 48 KB a payment of a
    /// hundred and fifty proofs still fits and the limit means something.
    static let maxPayment = 48 * 1024

    static let nonceLength = 16
    static let maxInvoice = 2048
    /// Both ways of being paid, and the JSON around them.
    static let maxPayload = 4096

    /// The four digits both screens show. The payer's nonce is written only
    /// after the payload has arrived, so a phone pretending to be the
    /// receiver has already committed to everything it offered and cannot
    /// pick an offer whose digits match.
    ///
    /// Over the whole payload, not just the invoice inside it. Two phones on
    /// one mint pay by ecash instead, and a code that covered only the invoice
    /// would leave the payment request — the part that says which mint and
    /// where to deliver — unsigned by the digits the two people compare.
    static func code(payload: String, nonce: Data) -> String {
        var h = SHA256()
        h.update(data: Data("foxy tap v1".utf8))
        h.update(data: Data([0]))
        h.update(data: Data(payload.utf8))
        h.update(data: nonce)
        let d = Array(h.finalize())
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        return String(format: "%04u", n % 10000)
    }

    /// A BOLT11 invoice, and nothing else: `ln`, a network, an amount, `1`, and
    /// bech32's characters, in one case. The page checks it again (classify).
    static func isInvoice(_ s: String) -> Bool {
        guard s.utf8.count >= 20, s.utf8.count <= maxInvoice else { return false }
        let t = s.lowercased()
        guard s == t || s == s.uppercased() else { return false }
        return t.range(of: "^ln[a-z0-9]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$",
                       options: .regularExpression) != nil
    }

    /// A Cashu payment request, by shape alone. What is in it — the mint, the
    /// amount, where to deliver — is the page's to read, with a real decoder;
    /// this only says the string is one and is not enormous.
    ///
    /// Deliberately loose about the alphabet. cashu-ts encodes with
    /// `toBase64({alphabet: "base64url"})`, which keeps `=` padding, and a
    /// pattern that allowed only the unpadded alphabet threw out every request
    /// that happened to need it. Nothing said so: the offer was refused whole,
    /// the receiver went on advertising the invoice by itself, and two phones
    /// on one mint quietly paid each other over Lightning. A shape test that is stricter than the encoder is a way to
    /// lose a feature silently.
    static func isRequest(_ s: String) -> Bool {
        guard s.utf8.count >= 20, s.utf8.count <= maxPayload else { return false }
        return s.range(of: "^creq[A-Za-z0-9_=+/-]{16,}$", options: .regularExpression) != nil
    }

    /// What the receiver offers, as it goes over the air:
    ///
    ///     {"v":1,"inv":"ln…","req":"creqA…"}
    ///
    /// Either may be missing and at least one must be there. `inv` is the
    /// Lightning invoice, which anyone can pay; `req` is a Cashu payment
    /// request naming the receiver's mint, which a payer on that same mint
    /// pays with ecash instead — phone to phone, no Lightning, no fee.
    ///
    /// The payer checks this before it writes its nonce, exactly as it used to
    /// check the invoice: nothing is committed to until the offer is known to
    /// be well formed.
    static func isPayload(_ s: String) -> Bool {
        guard s.utf8.count <= maxPayload,
              let data = s.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (o["v"] as? Int) == 2 else { return false }
        let inv = o["inv"] as? String
        let req = o["req"] as? String
        if let inv, !isInvoice(inv) { return false }
        if let req, !isRequest(req) { return false }
        return inv != nil || req != nil
    }

    /// The payload as it goes over the air: its length, then its bytes.
    static func frame(_ invoice: String) -> Data {
        let body = Data(invoice.utf8)
        return Data([UInt8(body.count >> 8), UInt8(body.count & 0xff)]) + body
    }

    /// The pieces of a framed message put back together, on either side.
    ///
    /// `limit` and `check` are what the two directions differ by: the offer is
    /// small and must be a well-formed offer, the payment is larger and is only
    /// checked for being text — the page reads it with a real parser, and a
    /// second opinion here would be a second thing to get wrong.
    struct Assembler {
        var limit = TapProtocol.maxPayload
        var check: (String) -> Bool = TapProtocol.isPayload
        private(set) var buffer = Data()

        enum Result: Equatable { case more, done(String), bad }

        mutating func add(_ piece: Data) -> Result {
            buffer.append(piece)
            guard buffer.count >= 2 else { return .more }
            let b = [UInt8](buffer.prefix(2))
            let want = Int(b[0]) << 8 | Int(b[1])
            guard want > 0, want <= limit else { return .bad }
            if buffer.count < 2 + want { return .more }
            guard buffer.count == 2 + want,
                  let text = String(data: buffer.dropFirst(2), encoding: .utf8),
                  check(text) else { return .bad }
            return .done(text)
        }

        /// For the payment direction: bigger, and text is all it must be.
        static func forPayment() -> Assembler {
            Assembler(limit: TapProtocol.maxPayment, check: { !$0.isEmpty })
        }
    }

    /// The same framing, for messages that are not text.
    ///
    /// v2's messages carry public keys, nonces and ciphertext — bytes that
    /// mean nothing as characters and do not survive being read as UTF-8. The
    /// text assembler above stays for v1's offer; this one hands back what
    /// arrived, unchanged.
    struct Bytes {
        var limit = TapProtocol.maxPayment
        private(set) var buffer = Data()

        enum Result: Equatable { case more, done(Data), bad }

        /// How much of the message in hand has arrived, how long it says it
        /// is, and its first byte — which is its kind. For saying how far a
        /// large one has got; nil until the length is known.
        var progress: (have: Int, want: Int, kind: UInt8?)? {
            guard buffer.count >= 2 else { return nil }
            let b = [UInt8](buffer.prefix(3))
            return (buffer.count, 2 + (Int(b[0]) << 8 | Int(b[1])), b.count > 2 ? b[2] : nil)
        }

        mutating func add(_ piece: Data) -> Result {
            buffer.append(piece)
            guard buffer.count >= 2 else { return .more }
            let b = [UInt8](buffer.prefix(2))
            let want = Int(b[0]) << 8 | Int(b[1])
            guard want > 0, want <= limit else { return .bad }
            if buffer.count < 2 + want { return .more }
            guard buffer.count == 2 + want else { return .bad }
            let body = Data(buffer[(buffer.startIndex + 2)..<buffer.endIndex])
            buffer = Data()
            return .done(body)
        }
    }
}

/// Which receiver the payer's phone is close enough to talk to.
///
/// Signal strength only chooses the phone. It proves nothing about who owns
/// it: the code does that.
/// Which edges to hold together, by the pair of phones.
///
/// The Bluetooth antenna is not in the same place on every iPhone. Side by
/// side the two edges that touch are always opposite ones, so there is one
/// question per pair: which side of the receiver the payer goes. Measured on
/// an XS, a 15 Pro Max and a 17 Pro, every ordered pair:
/// anything paying the 17 Pro holds its RIGHT edge to the 17's LEFT, and every
/// other pair is the payer's left to the receiver's right.
///
/// That fits where the antennas are. From the X to the 16 the Bluetooth
/// antenna sits by the rear camera, which is the top right seen from the
/// screen (repair guides; no model contradicts it), so those take the default
/// with no entry here. The 17 Pro moved its antennas around the camera
/// plateau, and the 18 Pro kept that design.
///
/// Model identifiers are the kernel's, which is also what iOS serves as the
/// Device Information model number.
enum TapEdges {
    /// Receivers a payer holds its right edge against (the receiver's left).
    static let leftEdgeReceivers: Set<String> = [
        "iPhone18,1",               // 17 Pro — measured
        "iPhone18,2",               // 17 Pro Max — ASSUMED, same design as the 17 Pro
        "iPhone19,2",               // 18 Pro — ASSUMED, the same plateau and antennas
        "iPhone19,3", "iPhone19,7", // 18 Pro Max, US and elsewhere — ASSUMED
    ]

    static func edges(payer: String, receiver: String) -> (payer: String, receiver: String) {
        leftEdgeReceivers.contains(receiver) ? ("right", "left") : ("left", "right")
    }

    /// This phone's model, as the kernel names it ("iPhone18,1"). The
    /// simulator reports the Mac's architecture, so its own variable is read.
    static var thisModel: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
        }
    }

}

struct TapProximity {
    /// The median reading, in dBm, a phone must reach. Roughly 10 cm (4 inches)
    /// between two iPhones.
    ///
    /// The number belongs to a direction, not to a distance. It was set while
    /// the receiver advertised and the payer listened: -48 (six inches) was
    /// loose enough that phones on a desk found each other, -38 (three) was
    /// too fussy, and -44 sat between them.
    ///
    /// Then the roles were swapped, so the till never transmits and the payer
    /// advertises instead — and the same two phones at the same distance read
    /// about 10 dB weaker that way round. -44 stopped meaning four inches and
    /// started meaning touching. In testing every connection came
    /// at -37 to -44, always with the phones pressed together, while a hand's
    /// width apart sat at -47 to -56 and was refused.
    ///
    /// So the number moves with the direction. Signal falls about 6 dB each
    /// time the distance halves; -52 is 8 dB out from touching, which is two
    /// and a bit halvings back — four inches again. Clearly-apart readings in
    /// that same session sat at -59 to -61, which this still refuses.
    /* Four inches, measured in this direction rather than reasoned about.
     *
     * Advertisements, two phones:
     *
     *     touching   -38, -41
     *     two feet   -46, -46, -48, -48
     *
     * Seven decibels across two feet is a flatter curve than the other
     * direction gave, which is why -54 let two feet pair. -44 is the middle of
     * the gap: it refuses every two-foot reading measured and accepts every
     * touching one, and four inches should sit on the near side of it.
     *
     * Advertisements decide because they are the steady scale — the same
     * distance gave -46, -46, -48, -48 — while the open link gave -37, -49 and
     * -51 for those same three taps.
     *
     * Then a third phone. An iPhone 15 Pro Max held against the
     * 17 Pro read -45 to -51 either way round — touching, on that pair, is
     * where two feet was on the other — and -44 refused every one of a
     * dozen attempts. There is no one number that is "touching" on every
     * pair of iPhones; the antennas differ and so do the cases. -50 takes the
     * 15 touching and still refuses the -52 to -61 that every pair has given
     * for clearly apart. What it gives up is the two-foot refusal on the
     * XS/17 pair: a phone at that distance can now be linked, and the four
     * digits and the amount on the confirmation are what catch a wrong one —
     * which is what they are for.
     *
     * And back in, to -40: -50 paired too readily. Touching is the rule. A phone that reads weaker than that
     * when touching — the 15 Pro Max read -45 to -51 — is told it is close by
     * the TAP TO PAY toast (`nearbyDbm`) and has to be held tighter, or its
     * case taken off. */
    var nearDbm = -33   // -30 was at the limit; on trial
    /// A receiver this strong is near enough to be told about — the payer's
    /// screen says TAP TO PAY — but not near enough to connect by itself.
    /// -60 reached across a room; -52 still too far, -48
    /// a little too near; -50, and then -54 once the card only points the way.
    var nearbyDbm = -54
    /* The link only ever confirms, never decides.
     *
     * A single reflection over an open link read -37 at two feet, stronger
     * than touching, so it cannot be trusted on its own — and the fallback
     * below requires the phone's last advertisement to have passed `nearDbm`
     * as well.
     *
     * Loose, because the link's scale is unreliable in both directions on
     * these phones: it read -37 at two feet and -51 with them touching, while
     * the advertisements said -46 and -33 for those same two moments. It is
     * not a distance measurement. Its only job here is to notice a link that
     * has genuinely gone, in the case where advertisements have stopped
     * arriving altogether; the `lastAd` gate is what does the real work. */
    var nearLinkedDbm = -60
    /// How long a phone must have been heard, and how many times.
    ///
    /// Two, not three, and it took a diary line that said which half of the
    /// rule fell short to know why. On the split's payer screen the receiver
    /// heard a payer at -43, -44, -46, -48 dBm — every one well inside -52 —
    /// and printed `only 2 reading(s)` for ten seconds together. An open link answers `readRSSI` about once
    /// a second, because an idle BLE connection drifts to a slow interval, so
    /// three readings inside the memory were never going to arrive.
    ///
    /// Two is only safe because `median` takes the weaker of a pair (below):
    /// both readings have to be close, so a reflection still cannot decide.
    ///
    /// This is the only part of a tap that is Foxy's to spend. Timed on the
    /// two phones: from the moment a payer is picked, the
    /// radio connection takes about 800 ms and iOS's service discovery another
    /// 600, with the characteristics and the first word 200 more — 1.6 s that
    /// CoreBluetooth offers no lever on. This hold sits in front of all of it.
    ///
    /// Three readings over a third of a second still needs two of the three to
    /// be close, so a single strong reflection cannot pick a phone, and the
    /// tie rule is untouched. Shorter than this and the median stops meaning
    /// anything.
    var hold: TimeInterval = 0.35
    /// The hold when another receiver is within `tieDb`: the closer one is
    /// chosen across this long.
    var rivalHold: TimeInterval = 1.0
    var minReadings = 2
    /// A second phone this close to the best one makes it a tie.
    var tieDb = 8
    /// Close enough to be worth opening a link to before the verdict is in.
    ///
    /// Roughly a metre or two. Connecting is not talking: the receiver opens
    /// the link and discovers the doors while somebody is still moving their
    /// phone in, and says nothing through it until `near`. That is worth about
    /// 1.3 s, which is what connecting and iOS's service discovery cost and
    /// which the payer's screen used to spend staring at SEARCHING while the
    /// receiver's had already said CONNECTED.
    ///
    /// A phone warmed and then not paid learns nothing: no callback reaches
    /// its app, no message crosses, and the link closes. The cost of setting
    /// this too loose is a radio engaged for nothing, not a leak.
    /// Readings older than this are forgotten.
    ///
    /// Two seconds, because the readings no longer all come from
    /// advertisements. Once a link is open the receiver asks it directly
    /// (`readRSSI`, TapLink.swift) and an answer costs a round trip, so they
    /// arrive around twice a second where advertisements arrived ten times.
    /// At one second of memory that left two readings in the window against a
    /// `minReadings` of three, and the verdict could never be reached: the
    /// two phones sat at -42, -29, -34 dBm — every one of them well inside
    /// -52 — printing "not close enough" for twenty seconds. The median is what guards against a lucky reading, and it needs
    /// enough of them to be a median.
    var memory: TimeInterval = 2.0

    enum Verdict: Equatable {
        case nothing
        /// A Foxy is there, not close enough; its median reading.
        case far(Int)
        /// Why the last `.far` was not a `.near`, for the log. Three readings
        /// spanning the hold is as much of the rule as the median is, and a
        /// line that says only the median cannot tell a phone that is too far
        /// from one that is close and not being heard often enough — which is
        /// what twenty seconds of "-29 dBm, not close enough" turned out to be
        /// about.
        case near(UUID, Int)
    }

    /* Two scales, kept apart.
     *
     * An advertisement's RSSI and an open link's `readRSSI` are not the same
     * measurement, and they are not a fixed offset apart either: across 22
     * links in the diaries the open-link reading differs from the
     * advertisement by anywhere from -10 dB to +15 dB (one read -39
     * against an advertisement of -53; another read -66 against -56). They
     * were poured into one pool and the median taken across both.
     *
     * That is worse than it sounds, because the median takes the weaker of a
     * pair. In one session the one tap that worked held [-46, -55, -46] and
     * scraped in at -46 — had the verdict been taken one advertisement
     * earlier the pool would have been [-46, -55], the median -55, and the tap
     * would have been refused. It worked by one reading.
     *
     * So each scale has its own pool and its own threshold. Advertisements
     * decide while they are arriving; once a link is open iOS stops handing
     * this scan that peripheral's advertisements (which is why `readRSSI`
     * exists at all), and the link's own readings decide instead. */
    private var heard: [UUID: [(at: TimeInterval, dbm: Int)]] = [:]
    private var linked: [UUID: [(at: TimeInterval, dbm: Int)]] = [:]
    /* The last advertisement from each phone, kept past the memory window.
     *
     * `heard` ages out after two seconds and advertisements arrive about every
     * 0.6 s, so the pool empties between them often enough to matter — and
     * every time it did, the link's own reading decided alone. That is how two
     * feet paired on a link reading -37 while the advertisements sitting a
     * third of a second either side of it said -46. */
    private var lastAd: [UUID: Int] = [:]
    /// When that last advertisement was heard, for `rival`.
    private var lastAdAt: [UUID: TimeInterval] = [:]
    /// What the last verdict fell short on, in words, for the log.
    private(set) var why = ""
    /* Which pool the last verdict came from, so the log can name the number
     * that actually decided. It printed `nearDbm` either way, so two feet
     * getting through read as "a receiver at -38 dBm (needs -54)" while the
     * link's own -63 was the one letting it in. */
    private(set) var decidedOnLink = false
    /// The threshold the last verdict was taken against.
    var lastThreshold: Int { decidedOnLink ? nearLinkedDbm : nearDbm }

    init() {}

    /// An advertisement's reading. iOS reports 127 when it has none.
    mutating func add(_ id: UUID, dbm: Int, at: TimeInterval) {
        guard dbm < 0, dbm > -120 else { return }
        heard[id, default: []].append((at, dbm))
        lastAd[id] = dbm
        lastAdAt[id] = at
    }

    /// An open link's own reading, on its own scale. See `linked`.
    mutating func addLinked(_ id: UUID, dbm: Int, at: TimeInterval) {
        guard dbm < 0, dbm > -120 else { return }
        linked[id, default: []].append((at, dbm))
    }

    mutating func forget() { heard = [:]; linked = [:]; lastAd = [:]; lastAdAt = [:] }

    /// The most recent advertisement from a phone, for saying in the log how
    /// an advertisement and a connection event compare — and for the check
    /// below, which will not let a link decide on its own.
    func lastHeard(_ id: UUID) -> Int? { lastAd[id] }

    var warmDbm = -64

    /// The strongest candidate worth opening a link to, before any verdict.
    /// Two readings, because one is a reflection; no hold, because the hold is
    /// what this exists to run underneath.
    mutating func warmest(at now: TimeInterval) -> UUID? {
        heard = heard.compactMapValues { r in
            let kept = r.filter { now - $0.at <= memory }
            return kept.isEmpty ? nil : kept
        }
        let ranked = heard.map { (id: $0.key, median: Self.median($0.value.map(\.dbm)), count: $0.value.count) }
            .filter { $0.count >= 2 && $0.median >= warmDbm }
            .sorted { $0.median > $1.median }
        return ranked.first?.id
    }

    /* Another receiver that has plainly been nearer than the one the quiet
     * link is open to, or nil.
     *
     * The quiet link is opened to the strongest receiver heard, and it is the
     * link that "near" is said down: the receiver at the other end puts up
     * CONNECT TO PAY. It was never looked at again. A phone carried from one
     * till to the till beside it kept its link to the first, which went on
     * showing the card, while the one the phone was being held to showed
     * nothing; it worked only when the first till's invoice was closed.
     *
     * So the link moves, on the same terms a tap is chosen on: the other
     * receiver is near enough to be told about (`nearbyDbm`), has been heard
     * for a full second (`rivalHold`), and is stronger by more than two phones
     * side by side differ (`tieDb`). Two tills that read alike keep the link
     * where it is, and whichever is touched is the one that is paid.
     *
     * The linked receiver is measured on advertisements too, while they still
     * arrive; then by its last one for a few seconds; and after that by the
     * link's own readings, which are a rougher scale but the only one left. */
    mutating func rival(of target: UUID, at now: TimeInterval) -> (id: UUID, median: Int, theirs: Int)? {
        heard = heard.compactMapValues { r in
            let kept = r.filter { now - $0.at <= memory }
            return kept.isEmpty ? nil : kept
        }
        let others = heard.filter { $0.key != target }
            .map { (id: $0.key, median: Self.median($0.value.map(\.dbm)), readings: $0.value) }
            .sorted { $0.median > $1.median }
        guard let best = others.first, best.readings.count >= minReadings, best.median >= nearbyDbm else { return nil }
        let span = (best.readings.last?.at ?? now) - (best.readings.first?.at ?? now)
        guard span >= rivalHold - 0.05 else { return nil }
        let theirs: Int
        if let ads = heard[target] {
            theirs = Self.median(ads.map(\.dbm))
        } else if let last = lastAd[target], let at = lastAdAt[target], now - at <= 5 {
            theirs = last
        } else if let link = linked[target]?.filter({ now - $0.at <= memory }), !link.isEmpty {
            theirs = Self.median(link.map(\.dbm))
        } else {
            theirs = -127
        }
        return best.median >= theirs + tieDb ? (best.id, best.median, theirs) : nil
    }

    mutating func verdict(at now: TimeInterval) -> Verdict {
        heard = heard.compactMapValues { r in
            let kept = r.filter { now - $0.at <= memory }
            return kept.isEmpty ? nil : kept
        }
        linked = linked.compactMapValues { r in
            let kept = r.filter { now - $0.at <= memory }
            return kept.isEmpty ? nil : kept
        }
        /* The link's own readings, when the advertisements have dried up.
         *
         * iOS stops handing this scan a peripheral's advertisements once a link
         * to it is open, so a warm link starves the pool that would decide. The
         * link answers instead — on its own scale, against its own threshold,
         * never mixed into the median with advertisements. Only ever for the
         * one phone a link is open to, and only when nothing is advertising:
         * an advertisement is the measurement the other number was set on, so
         * it wins whenever there is one. */
        /* The link confirms; it never decides alone.
         *
         * `lastAd` is what makes that possible: the advertisement pool empties
         * between arrivals, but the last thing this phone actually advertised
         * at is still known. A link reading -37 with a last advertisement of
         * -46 is a reflection, not four inches. */
        if heard.isEmpty, let one = linked.first(where: { $0.value.count >= minReadings }),
           let advertised = lastAd[one.key], advertised >= nearDbm {
            let median = Self.median(one.value.map(\.dbm))
            let span = (one.value.last?.at ?? now) - (one.value.first?.at ?? now)
            guard median >= nearLinkedDbm, span >= hold - 0.05 else {
                why = median < nearLinkedDbm ? "too far, over the link"
                    : String(format: "heard over the link for %.2fs", span)
                return .far(median)
            }
            why = ""
            decidedOnLink = true
            return .near(one.key, median)
        }
        decidedOnLink = false
        let ranked = heard.map { (id: $0.key, median: Self.median($0.value.map(\.dbm)), readings: $0.value) }
            .sorted { $0.median > $1.median }
        guard let best = ranked.first else { return .nothing }
        let span = (best.readings.last?.at ?? now) - (best.readings.first?.at ?? now)
        /* Two receivers close together: the closer one wins, judged across a
         * full second rather than the usual hold. It used
         * to refuse both as a tie and ask the person to hold nearer one phone;
         * with every invoice on the air that is a till with two customers
         * waiting. A second of readings is enough for the medians to settle,
         * and the four digits are the check if the second was still wrong. */
        if ranked.count > 1, ranked[1].median >= best.median - tieDb, ranked[1].median >= nearDbm - tieDb {
            guard best.median >= nearDbm else { return .far(best.median) }
            guard span >= rivalHold - 0.05 else {
                why = String(format: "two phones close; choosing across %.1fs (%.2fs so far)", rivalHold, span)
                return .far(best.median)
            }
            why = ""
            return .near(best.id, best.median)
        }
        guard best.median >= nearDbm, best.readings.count >= minReadings, span >= hold - 0.05 else {
            why = best.median < nearDbm ? "too far"
                : best.readings.count < minReadings ? "only \(best.readings.count) reading(s)"
                : String(format: "heard for %.2fs", span)
            return .far(best.median)
        }
        why = ""
        return .near(best.id, best.median)
    }

    /// The middle reading, and for an even count the weaker of the two middle
    /// ones. Identical to the true median at every odd count, and the
    /// conservative half of it otherwise — which is what makes deciding on a
    /// pair safe: `[-70, -40]` reads as -70, so one strong reflection beside
    /// one weak reading is still far.
    static func median(_ v: [Int]) -> Int {
        let s = v.sorted()
        return s.isEmpty ? -127 : s[(s.count - 1) / 2]
    }
}

/// What becomes of change a receiver has sent, as the payer's word arrives or
/// does not.
///
/// The page is answered once: `kept` when the payer says it wrote the change
/// down, `notHanded` when the wait runs out or the payer goes first. A payer
/// that says "kept" after that is still heard — it was suspended, or slow at
/// the mint — and that is `late`: the page takes the code down and writes
/// "given back". Anything else after the first answer is nothing.
///
/// It lived as a captured flag in the bridge, where nothing could test it; the
/// two bugs it replaced were both about when "given back" may be said.
final class ChangeHandover {
    enum Word: Equatable { case kept, notHanded, late }
    private(set) var answered = false

    /// The payer said it kept the change (`true`), or the wait ended without
    /// that (`false`). What to tell the page, or nil for nothing.
    func heard(kept: Bool) -> Word? {
        if answered { return kept ? .late : nil }
        answered = true
        return kept ? .kept : .notHanded
    }
}

/// How far something large has got, said every four points and not more often.
///
/// A payment of a hundred pieces crosses in a hundred writes, and a screen
/// told about each would redraw a hundred times. Both radios use this: the
/// payer counting writes acknowledged, the receiver counting bytes in.
struct TapProgress {
    private var last = -1

    /// The percentage to say now, or nil when it has not moved enough.
    /// `cap` is 99 on the side that is still waiting for the last byte.
    mutating func step(done: Int, of total: Int, cap: Int = 100) -> Int? {
        guard total > 0 else { return nil }
        let pct = max(0, min(cap, done * 100 / total))
        guard pct >= last + 4 else { return nil }
        last = pct
        return pct
    }
}
