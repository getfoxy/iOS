import Foundation
import CryptoKit

/// Tap to pay v2: the six messages, with no radio in them (TAP-TO-PAY.md).
///
/// Both sides of the conversation live here as one type with two roles, so a
/// payer and a receiver can be run against each other in a test and the whole
/// exchange checked without Bluetooth. TapLink does nothing but carry bytes
/// between this and the air.
///
///   M1  payer → receiver   its version, and a promise about a key not yet shown
///   M2  receiver → payer   its version, and the receiver's key and nonce
///   M3  payer → receiver   the key it promised; the receiver checks it
///   M4  receiver → payer   the offer, sealed
///   M5  payer → receiver   the payment, sealed
///   M6  receiver → payer   what happened to it, sealed
///
/// Nothing is sealed until M4, because there is nothing to seal until both
/// sides have agreed on a key. M1 to M3 are public by design and give away
/// nothing: two public keys, two nonces and a hash.
final class TapSession {

    enum Role { case payer, receiver }

    /// What the caller should do with what came back.
    enum Step: Equatable {
        /// Put these bytes on the wire.
        case send(Data)
        /// Nothing to do yet.
        case waiting
        /// Both sides agree; this is what goes on the two screens.
        case linked(code: String)
        /// The offer arrived (payer only).
        case offer(String, code: String)
        /// The payment arrived (receiver only).
        case payment(String)
        /// The receiver's word on the payment (payer only).
        case result(String)
        /// Drop the link. The reason is for Foxy's own log, never the wire.
        case stop(String)
        /// Drop the link, and say why on the screen: the other phone speaks
        /// another version of this (`TapCrypto.version`), so nothing either
        /// says next would be understood. 2 is a Foxy from before a version
        /// was sent. `reply`, when there is one, goes on the wire first: it
        /// is this phone's own version, so the other one can say the same.
        case otherVersion(theirs: Int, reply: Data?)
        /// M7, at the payer: a token for the change owed.
        case change(String)
        /// M8, at the receiver: the payer's page has written that change down.
        case changeTaken
        /// M10, at the receiver: the payer's price, and what it makes of the
        /// dollar amount asked for.
        case quote(String)
        /// M11, at the payer: the receiver agreed to that price, and this is the
        /// request to pay — now with a sat amount on it.
        case terms(String)
        /// M9, at the payer: a person on the other phone is reading a card.
        ///
        /// Sent when both phones are offline. The receiver cannot settle unlocked
        /// ecash without a route, so it asks its user whether they trust the
        /// payer, and a person takes longer than a swap. This stretches the
        /// payer's wait and puts words on their screen: twenty seconds of nothing
        /// reads as a broken app, which is the worst possible thing to show
        /// somebody in the middle of handing over money.
        case asking
        /// M12, at the receiver: the payer was away and asks for anything said
        /// since the message with this counter.
        case again(UInt64)
        /// At the receiver: how many bytes of payment are about to arrive, in
        /// all its parts, so the screen can say how far it has got.
        case paymentSize(Int)
    }

    private enum Kind: UInt8 {
        case commit = 0x01, hello = 0x02, reveal = 0x03
        case offer = 0x04, payment = 0x05, result = 0x06
        /* The change leg, after the result.
         *
         * M7 carries a token back to the payer for whatever they overpaid; M8 is
         * the payer's page saying it has been written down. The ack is the page's
         * word and not the radio's, for the same reason M6 is: bytes arriving
         * says nothing about money being kept, and the receiver must not consider
         * change delivered until the other phone can actually spend it. */
        case change = 0x07, changeTaken = 0x08
        /* M9: "a person here is deciding". Carries nothing but its own existence
         * — no amount, no reason, nothing about who is being asked. It is sent
         * after M5 and before M6, and it changes no state on either side except
         * the clocks and what the payer's screen says. */
        case asking = 0x09
        /* The price leg, before any money.
         *
         * A receiver with no route has a bitcoin price that may be hours old, so
         * it asks in dollars and leaves the conversion to the phone that has a
         * current one. M10 is the payer saying what its price is and what that
         * makes of the amount; M11 is the receiver agreeing and sending the
         * request, now in sats. Nothing has left the payer at that point — which
         * is the whole reason the order is this way round. */
        case quote = 0x0A, terms = 0x0B
        /* M12: "say that again". A payer whose app was suspended hears nothing
         * that arrives meanwhile — iOS delivers no notifications to a suspended
         * app and does not keep them — while the link itself stays up. The
         * result and the change went by, the payer came back to a screen still
         * saying SENDING, and the person killed the app. It carries how many messages the payer has opened; the
         * receiver sends again, byte for byte, whatever it sealed from there
         * on. The same bytes under the same counter are the same ciphertext,
         * so nothing is sealed twice. */
        case again = 0x0C
        /* A payment too big for one message. A frame's length is two bytes, so
         * 64 KB is the most one can ever be; a payment of many pieces goes as
         * parts, each sealed like any other message, and the last one is an
         * ordinary `payment`. The receiver opens each as it comes and reads
         * them joined. `paymentSize` goes first when the whole is large, and
         * says only how many bytes are coming. */
        case paymentPart = 0x0D, paymentSize = 0x0E
    }

    /// What has arrived of a payment that is coming in parts.
    private var gathered = Data()
    /// Whether a byte is the kind of a message that carries payment.
    static func carriesPayment(_ kind: UInt8?) -> Bool {
        kind == Kind.payment.rawValue || kind == Kind.paymentPart.rawValue
    }

    /// What this receiver has sealed since the payment arrived, with the
    /// counter each was sealed under, so it can be said again (M12).
    private var repeatable: [(counter: UInt64, frame: Data)] = []

    /// The frames sealed under `counter` or later, oldest first.
    func framesSince(_ counter: UInt64) -> [Data] {
        repeatable.filter { $0.counter >= counter }.map { $0.frame }
    }

    let role: Role
    let service: UUID
    private let priv = Curve25519.KeyAgreement.PrivateKey()
    private let myNonce = TapCrypto.randomNonce()
    private var keys: TapCrypto.Keys?
    private var theirCommit = Data()
    private var theirNonce = Data()
    private var theirKey = Data()
    private var sentCounter: UInt64 = 0
    private var heardCounter: UInt64 = 0
    /// Said once each, so a stuck link does not fill the diary.
    private var said = Set<String>()

    init(role: Role, service: UUID) {
        self.role = role
        self.service = service
    }

    var publicKey: Data { priv.publicKey.rawRepresentation }
    /// The four digits, once there are any.
    var code: String? { keys?.code }

    /// The payer speaks first.
    func begin() -> Step {
        guard role == .payer else { return .waiting }
        let commit = TapCrypto.commitment(publicKey: publicKey, nonce: myNonce)
        note("handshake: promising a key")
        return .send(frame(.commit, Data([TapCrypto.version]) + commit))
    }

    /// One message off the wire.
    func received(_ body: Data) -> Step {
        guard let first = body.first, let kind = Kind(rawValue: first) else {
            return .stop("a message of no kind Foxy knows")
        }
        let rest = Data(body.dropFirst())
        switch (role, kind) {

        case (.receiver, .commit):
            /* A promise with no version in front of it is a Foxy from before
             * one was sent. It cannot be answered: what this side says next
             * would not read at its end, nor its at this one. Told apart here,
             * at the first message, where there is still something to say to
             * the person holding the phone. */
            if rest.count == 32 {
                note("handshake: the payer is a Foxy from before the version was sent")
                return .otherVersion(theirs: 2, reply: nil)
            }
            /* The version is read before anything else, whatever follows it:
             * a later version may send a promise of another size, and the one
             * thing every version has to be able to do with a message it
             * cannot read is say which version it speaks. The answer is a
             * hello with this phone's version and nothing after it. */
            guard let theirs = rest.first else { return .stop("a promise of the wrong size") }
            guard theirs == TapCrypto.version else {
                note("handshake: the payer speaks version \(theirs), this phone \(TapCrypto.version)")
                return .otherVersion(theirs: Int(theirs), reply: frame(.hello, Data([TapCrypto.version])))
            }
            guard rest.count == 1 + 32 else { return .stop("a promise of the wrong size") }
            theirCommit = Data(rest.dropFirst())
            note("handshake: a payer promised a key")
            return .send(frame(.hello, Data([TapCrypto.version]) + publicKey + myNonce))

        case (.payer, .hello):
            // an older receiver stops at this phone's promise and never says hello; kept for the one that does
            if rest.count == 32 + TapCrypto.nonceLength {
                note("handshake: the receiver is a Foxy from before the version was sent")
                return .otherVersion(theirs: 2, reply: nil)
            }
            // the version first, whatever its size: a receiver that cannot read this phone's promise answers with that alone
            guard let theirs = rest.first else { return .stop("a hello of the wrong size") }
            guard theirs == TapCrypto.version else {
                note("handshake: the receiver speaks version \(theirs), this phone \(TapCrypto.version)")
                return .otherVersion(theirs: Int(theirs), reply: nil)
            }
            guard rest.count == 1 + 32 + TapCrypto.nonceLength else { return .stop("a hello of the wrong size") }
            let said = Data(rest.dropFirst())
            theirKey = Data(said.prefix(32))
            theirNonce = Data(said.suffix(TapCrypto.nonceLength))
            guard settle(receiverKey: theirKey, receiverNonce: theirNonce,
                         payerKey: publicKey, payerNonce: myNonce) else {
                return .stop("that key is not a key")
            }
            note("handshake: keys agreed")
            return .send(frame(.reveal, publicKey + myNonce))

        case (.receiver, .reveal):
            guard rest.count == 32 + TapCrypto.nonceLength else { return .stop("a reveal of the wrong size") }
            let p = Data(rest.prefix(32)), np = Data(rest.suffix(TapCrypto.nonceLength))
            /* The promise is the whole protection. A payer that shows a key it
             * did not promise is somebody who waited to see ours and then
             * chose, which is exactly what the four digits cannot catch. */
            guard TapCrypto.commitment(publicKey: p, nonce: np) == theirCommit else {
                return .stop("the key shown is not the key promised")
            }
            guard settle(receiverKey: publicKey, receiverNonce: myNonce,
                         payerKey: p, payerNonce: np) else {
                return .stop("that key is not a key")
            }
            note("handshake: keys agreed, the code is on screen")
            return .linked(code: keys?.code ?? "")

        case (.receiver, .payment):
            guard let k = keys else { return .stop("a payment before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened) else {
                return .stop("a payment that would not open")
            }
            heardCounter += 1
            // the last part of several, or the only one
            let whole = gathered + body
            gathered = Data()
            guard let joined = String(data: whole, encoding: .utf8) else {
                return .stop("a payment whose parts do not read as text")
            }
            note("a payment arrived, sealed (\(rest.count) bytes on the wire"
                 + (whole.count > body.count ? ", \(whole.count) in all" : "") + ")")
            return .payment(joined)

        case (.receiver, .paymentPart):
            guard let k = keys else { return .stop("part of a payment before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened) else {
                return .stop("part of a payment that would not open")
            }
            heardCounter += 1
            gathered.append(body)
            guard gathered.count <= TapCrypto.mostPaymentTotal else {
                gathered = Data()
                return .stop("a payment bigger than any Foxy sends")
            }
            return .waiting

        case (.receiver, .paymentSize):
            guard let k = keys else { return .stop("a size before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8), let n = Int(text), n > 0 else {
                return .stop("a size that would not open")
            }
            heardCounter += 1
            return .paymentSize(n)

        case (.payer, .offer):
            guard let k = keys else { return .stop("an offer before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.receiverToPayer,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8) else {
                return .stop("an offer that would not open")
            }
            heardCounter += 1
            note("the offer arrived, sealed (\(rest.count) bytes on the wire)")
            return .offer(text, code: k.code)

        case (.payer, .change):
            guard let k = keys else { return .stop("change before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.receiverToPayer,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8) else {
                return .stop("change that would not open")
            }
            heardCounter += 1
            note("change arrived, sealed (\(rest.count) bytes on the wire)")
            return .change(text)

        case (.receiver, .again):
            guard let k = keys else { return .stop("a repeat asked for before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8), let from = UInt64(text) else {
                return .stop("a repeat request that would not open")
            }
            heardCounter += 1
            note("the payer was away and asks for what was said from message \(from) on")
            return .again(from)

        case (.receiver, .changeTaken):
            guard let k = keys else { return .stop("a change receipt before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  TapCrypto.unpad(opened) != nil else {
                return .stop("a change receipt that would not open")
            }
            heardCounter += 1
            note("the payer kept the change")
            return .changeTaken

        case (.receiver, .quote):
            guard let k = keys else { return .stop("a quote before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.payerToReceiver,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8) else {
                return .stop("a quote that would not open")
            }
            heardCounter += 1
            note("the payer's price arrived, sealed (\(rest.count) bytes on the wire)")
            return .quote(text)

        case (.payer, .terms):
            guard let k = keys else { return .stop("terms before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.receiverToPayer,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8) else {
                return .stop("terms that would not open")
            }
            heardCounter += 1
            note("they agreed the price; the request arrived, sealed (\(rest.count) bytes on the wire)")
            return .terms(text)

        case (.payer, .asking):
            guard let k = keys else { return .stop("a wait before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.receiverToPayer,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  TapCrypto.unpad(opened) != nil else {
                return .stop("a wait that would not open")
            }
            heardCounter += 1
            note("they are asking a person about this payment")
            return .asking

        case (.payer, .result):
            guard let k = keys else { return .stop("a result before there was a key") }
            guard let opened = TapCrypto.open(rest, with: k.receiverToPayer,
                                              counter: heardCounter, transcript: k.transcript, kind: first),
                  let body = TapCrypto.unpad(opened),
                  let text = String(data: body, encoding: .utf8) else {
                return .stop("a result that would not open")
            }
            heardCounter += 1
            note("the receiver answered")
            return .result(text)

        default:
            return .stop("a \(kind) where it does not belong")
        }
    }

    /// The receiver's offer, sealed and padded to one size.
    func sealOffer(_ text: String) -> Data? {
        guard role == .receiver, let k = keys else { return nil }
        guard let padded = TapCrypto.pad(Data(text.utf8), to: TapCrypto.offerSize) else {
            note("the offer is too big to hand over (\(text.utf8.count) bytes)")
            return nil
        }
        return sealed(.offer, padded, with: k.receiverToPayer)
    }

    /// M10: the payer's price, and the sats it makes of the dollar amount.
    func sealQuote(_ text: String) -> Data? {
        guard role == .payer, let k = keys,
              let padded = TapCrypto.pad(Data(text.utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.quote, padded, with: k.payerToReceiver)
    }

    /// M11: the receiver agreed to that price; here is the request, in sats.
    func sealTerms(_ text: String) -> Data? {
        guard role == .receiver, let k = keys,
              let padded = TapCrypto.pad(Data(text.utf8), to: TapCrypto.offerSize) else {
            note("the agreed request is too big to hand over")
            return nil
        }
        return sealed(.terms, padded, with: k.receiverToPayer)
    }

    /// The payer's ecash, sealed and padded up to a whole block.
    func sealPayment(_ text: String) -> Data? {
        guard role == .payer, let k = keys else { return nil }
        guard let padded = TapCrypto.padPayment(Data(text.utf8)) else {
            note("the payment is too big to hand over (\(text.utf8.count) bytes)")
            return nil
        }
        note("handing the payment over, padded to \(padded.count) bytes")
        return sealed(.payment, padded, with: k.payerToReceiver)
    }

    /// The same payment as the messages it takes: one, or parts and a last.
    func sealPaymentFrames(_ text: String) -> [Data]? {
        guard role == .payer, let k = keys else { return nil }
        let body = Data(text.utf8)
        guard body.count <= TapCrypto.mostPaymentTotal else {
            note("the payment is too big to hand over (\(body.count) bytes)")
            return nil
        }
        if body.count <= TapCrypto.partBody {
            return sealPayment(text).map { [$0] }
        }
        var frames: [Data] = []
        var at = 0
        while at < body.count {
            let end = min(at + TapCrypto.partBody, body.count)
            guard let padded = TapCrypto.padPayment(body.subdata(in: at..<end)),
                  let frame = sealed(end == body.count ? .payment : .paymentPart, padded, with: k.payerToReceiver)
            else { return nil }
            frames.append(frame)
            at = end
        }
        note("handing the payment over, \(body.count) bytes in \(frames.count) parts")
        return frames
    }

    /* How many bytes a payment will be on the wire, near enough, without
     * sealing anything.
     *
     * The size has to be SAID before the payment and so it has to be SEALED
     * before the payment: every message is sealed under the next counter, and
     * the receiver opens them in the order they arrive. Sealing the parts
     * first to measure them and then the size put the size under a later
     * counter than the receiver expected; it would not open, the receiver
     * stopped, and the payer fell back to a code — on the first large payment
     * tried ("a size that would not open"). So it is
     * worked out from the length: each part padded to whole blocks, and about
     * forty bytes of sealing and framing on each. It is only for a
     * percentage. */
    func paymentWireEstimate(_ text: String) -> Int {
        let body = text.utf8.count
        let block = TapCrypto.paymentBlock
        var left = body, total = 0
        repeat {
            let chunk = min(left, TapCrypto.partBody)
            total += ((chunk + 4 + block - 1) / block) * block + 40
            left -= chunk
        } while left > 0
        return total
    }

    /// How many bytes are about to be sent, said first when it is a lot.
    func sealPaymentSize(_ bytes: Int) -> Data? {
        guard role == .payer, let k = keys,
              let padded = TapCrypto.pad(Data(String(bytes).utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.paymentSize, padded, with: k.payerToReceiver)
    }

    /// What the receiver made of it.
    func sealResult(_ text: String) -> Data? {
        guard role == .receiver, let k = keys else { return nil }
        guard let padded = TapCrypto.pad(Data(text.utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.result, padded, with: k.receiverToPayer)
    }

    /// M7: the change owed, sealed by the receiver for the payer.
    ///
    /// One size whenever it fits, which is what keeps the size of ordinary
    /// change from saying how much it is. Change that does not fit goes in
    /// whole blocks, as a payment does, rather than not at all: it was refused
    /// outright, so a payer who had handed over 1,203 sats for a 13-sat payment
    /// — all it had was one payment it had been given — never got its 1,190
    /// back, and was told the other phone had gone. Six locked pieces are more than 2,048 bytes.
    func sealChange(_ text: String) -> Data? {
        guard role == .receiver, let k = keys else { return nil }
        let body = Data(text.utf8)
        guard let padded = TapCrypto.pad(body, to: TapCrypto.changeSize) ?? TapCrypto.padPayment(body) else {
            note("the change is too big to hand over (\(body.count) bytes)")
            return nil
        }
        if padded.count != TapCrypto.changeSize {
            note("the change is large, so it goes in \(padded.count) bytes")
        }
        return sealed(.change, padded, with: k.receiverToPayer)
    }

    /// M9: a person on this phone is being asked about the payment.
    func sealAsking() -> Data? {
        guard role == .receiver, let k = keys,
              let padded = TapCrypto.pad(Data("asking".utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.asking, padded, with: k.receiverToPayer)
    }

    /// M12: this payer was away; say again whatever came after what it has opened.
    func sealAgain() -> Data? {
        guard role == .payer, let k = keys,
              let padded = TapCrypto.pad(Data(String(heardCounter).utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.again, padded, with: k.payerToReceiver)
    }

    /// M8: the payer's page has the change written down.
    func sealChangeTaken() -> Data? {
        guard role == .payer, let k = keys,
              let padded = TapCrypto.pad(Data("kept".utf8), to: TapCrypto.resultSize) else { return nil }
        return sealed(.changeTaken, padded, with: k.payerToReceiver)
    }

    // MARK: the small print

    private func sealed(_ kind: Kind, _ padded: Data, with key: SymmetricKey) -> Data? {
        guard let k = keys,
              let box = TapCrypto.seal(padded, with: key, counter: sentCounter, transcript: k.transcript,
                                       kind: kind.rawValue) else { return nil }
        let used = sentCounter
        sentCounter += 1
        let out = frame(kind, box)
        // kept, to be said again to a payer that was away (M12); a handful at most
        if role == .receiver, kind == .asking || kind == .result || kind == .change {
            repeatable.append((used, out))
            if repeatable.count > 8 { repeatable.removeFirst(repeatable.count - 8) }
        }
        return out
    }

    private func frame(_ kind: Kind, _ body: Data) -> Data {
        Data([kind.rawValue]) + body
    }

    private func settle(receiverKey: Data, receiverNonce: Data, payerKey: Data, payerNonce: Data) -> Bool {
        let other = role == .payer ? receiverKey : payerKey
        guard let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: other),
              let shared = try? priv.sharedSecretFromKeyAgreement(with: pub) else { return false }
        let th = TapCrypto.transcript(service: service, r: receiverKey, p: payerKey,
                                      nr: receiverNonce, np: payerNonce)
        keys = TapCrypto.keys(shared: shared, transcript: th)
        return true
    }

    /// Foxy's own log, one line per thing that happened, each said once.
    ///
    /// Enough to follow a whole tap afterwards from the diary: which side, how
    /// far it got, how big the sealed messages were, and why it stopped. No
    /// key, no code, no invoice and no ecash — those are the things this whole
    /// protocol exists to keep off the air, and a log is not a reason to write
    /// them down.
    private func note(_ what: String) {
        guard said.insert(what).inserted else { return }
        print("[tap] \(role == .payer ? "pay" : "receive"): \(what)")
    }

    /// Said by the caller when it drops a link, so a stopped tap leaves a
    /// reason behind rather than silence.
    func stopped(_ why: String) {
        print("[tap] \(role == .payer ? "pay" : "receive"): stopped — \(why)")
    }
}
