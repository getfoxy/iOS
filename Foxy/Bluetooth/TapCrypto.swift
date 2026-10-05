import Foundation
import CryptoKit

/// Tap to pay v2: the handshake, the keys and the four digits (TAP-TO-PAY.md).
///
/// No radio in here, so all of it is tested on a simulator. What it gives the
/// two phones is a key nobody listening can work out, and a four-digit code
/// that differs for the two of them if anybody is sitting in the middle.
///
/// The shape is Bluetooth's own numeric comparison, and ZRTP's before it: the
/// payer commits to its public key before it has seen the receiver's, and the
/// receiver sends its own before it has seen the payer's. Neither side can
/// then choose a key that makes the digits come out any particular way, so a
/// phone in the middle is left guessing — one chance in ten thousand, once,
/// per tap. Without the commitment four digits would simply be ground down.
enum TapCrypto {

    // MARK: Labels
    //
    // Every hash in here is domain-separated. The same bytes hashed for two
    // purposes is how protocols get confused with each other.
    private static let commitLabel = Data("foxy tap v2 commit".utf8)
    private static let transcriptLabel = Data("foxy tap v2".utf8)
    private static let codeLabel = Data("foxy tap v2 code".utf8)
    private static let keysInfo = Data("foxy tap v2 keys".utf8)
    private static let inLabel = Data("foxy tap v2 in".utf8)
    private static let outLabel = Data("foxy tap v2 out".utf8)
    private static let nearLeftLabel = Data("foxy tap v2 near left".utf8)
    private static let nearRightLabel = Data("foxy tap v2 near right".utf8)

    static let nonceLength = 16
    static let keyLength = 32

    /// The version of the wire. It goes first in M1 and M2, in the clear, and
    /// into the transcript, so two phones that speak different versions learn
    /// it at the first message and can say so. Without it a change to the
    /// wire looks, to both people, like a tap that simply did not work.
    ///
    ///     2   the commitment handshake. No version was sent, and a sealed
    ///         message was bound to its handshake but not to its own kind.
    ///     3   the version byte, and every sealed message bound to its kind.
    ///
    /// The labels below still say "v2". They name the shape of the handshake,
    /// which has not changed, and the doors' labels have to stay as they are:
    /// they are how any two Foxys find each other, whatever they speak, and a
    /// phone that cannot be found cannot be told to update.
    static let version: UInt8 = 3

    // MARK: The service, and the two characteristics under it

    /// A fresh service UUID, new for every invoice. Nothing about it is Foxy's:
    /// to a scanner it is one anonymous 128-bit number that will not be seen
    /// again.
    static func newService() -> UUID { UUID() }

    /// The characteristics are derived from the service, so no constant of
    /// Foxy's appears even to somebody who has connected.
    static func inCharacteristic(for service: UUID) -> UUID { derive(inLabel, service) }
    static func outCharacteristic(for service: UUID) -> UUID { derive(outLabel, service) }
    /// A third door that carries nothing: a payer subscribes to it when it is
    /// near enough to show CONNECT TO PAY, so the receiver's screen can show
    /// the same card and where to touch. Derived like the
    /// other two, so it is as anonymous as they are.
    ///
    /// Two of them, and which one the payer subscribes to is the one bit it
    /// says: which edge of the receiver's screen the mark goes on. The payer
    /// knows both models (its own, and the receiver's from iOS's own Device
    /// Information service) and the receiver knows neither's antenna; so the
    /// payer works out both edges and names the receiver's by its choice of
    /// door. Nothing about the payer's phone crosses but that bit.
    static func nearCharacteristic(for service: UUID, edge: String) -> UUID {
        derive(edge == "left" ? nearLeftLabel : nearRightLabel, service)
    }

    private static func derive(_ label: Data, _ service: UUID) -> UUID {
        var h = SHA256()
        h.update(data: label)
        h.update(data: bytes(of: service))
        let d = Array(h.finalize().prefix(16))
        return UUID(uuid: (d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7],
                           d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]))
    }

    static func bytes(of id: UUID) -> Data {
        let u = id.uuid
        return Data([u.0, u.1, u.2, u.3, u.4, u.5, u.6, u.7,
                     u.8, u.9, u.10, u.11, u.12, u.13, u.14, u.15])
    }

    // MARK: The handshake

    /// What the payer sends first: a promise about a key it has not shown yet.
    static func commitment(publicKey p: Data, nonce np: Data) -> Data {
        var h = SHA256()
        h.update(data: commitLabel)
        h.update(data: p)
        h.update(data: np)
        return Data(h.finalize())
    }

    static func randomNonce() -> Data {
        var b = [UInt8](repeating: 0, count: nonceLength)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b)
    }

    /// Everything both sides have seen, in one hash. It is the salt for the
    /// keys and the associated data for every sealed message, so a message
    /// from one handshake cannot be replayed into another.
    static func transcript(version: UInt8 = TapCrypto.version,
                           service: UUID, r: Data, p: Data, nr: Data, np: Data) -> Data {
        var h = SHA256()
        h.update(data: transcriptLabel)
        // the version both sides said, so neither can be talked down to another
        h.update(data: Data([version]))
        h.update(data: bytes(of: service))
        h.update(data: r)
        h.update(data: p)
        h.update(data: nr)
        h.update(data: np)
        return Data(h.finalize())
    }

    /// One direction each, so neither side ever seals with the other's key.
    struct Keys {
        /// receiver → payer
        let receiverToPayer: SymmetricKey
        /// payer → receiver
        let payerToReceiver: SymmetricKey
        /// The four digits on both screens.
        let code: String
        /// What every sealed message is bound to.
        let transcript: Data
    }

    /// Derive both keys and the code from an agreed secret.
    ///
    /// The code takes in the shared secret as well as the transcript. The
    /// transcript is public to anyone listening; without the secret in there,
    /// a bystander could work out the number on the two screens and read over
    /// somebody's shoulder without being in the room.
    static func keys(shared: SharedSecret, transcript th: Data) -> Keys {
        let secret = shared.withUnsafeBytes { Data($0) }
        let okm = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret),
                                         salt: th, info: keysInfo, outputByteCount: 64)
        let raw = okm.withUnsafeBytes { Data($0) }
        var h = SHA256()
        h.update(data: codeLabel)
        h.update(data: th)
        h.update(data: secret)
        let d = Array(h.finalize().prefix(4))
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        return Keys(receiverToPayer: SymmetricKey(data: Data(raw[0..<32])),
                    payerToReceiver: SymmetricKey(data: Data(raw[32..<64])),
                    code: String(format: "%04u", n % 10000),
                    transcript: th)
    }

    // MARK: Sealing

    /// A counter, not a random number: each key seals at most a few messages
    /// and the counters never repeat under one key, which is all ChaChaPoly
    /// asks. Twelve bytes, big-endian, zero-padded.
    static func nonce(_ counter: UInt64) -> ChaChaPoly.Nonce {
        var b = Data(repeating: 0, count: 12)
        for i in 0..<8 { b[11 - i] = UInt8((counter >> (8 * UInt64(i))) & 0xff) }
        return (try? ChaChaPoly.Nonce(data: b)) ?? ChaChaPoly.Nonce()
    }

    /// What a sealed message is bound to: the handshake it belongs to, and
    /// the kind of message it is.
    ///
    /// The kind travels in the clear in front of the sealed bytes, because the
    /// other side needs it to know which key to open with. It was left out of
    /// this, so somebody able to change bytes on the air could relabel one
    /// sealed message as another kind going the same way, and it still opened:
    /// a payer's "say that again" read as "I kept the change", say. Bound
    /// here, a relabelled message is one that will not open.
    private static func bound(_ th: Data, _ kind: UInt8) -> Data { th + Data([kind]) }

    static func seal(_ message: Data, with key: SymmetricKey, counter: UInt64, transcript th: Data,
                     kind: UInt8) -> Data? {
        guard let box = try? ChaChaPoly.seal(message, using: key,
                                             nonce: nonce(counter), authenticating: bound(th, kind)) else { return nil }
        /* Copied, so what comes back starts at zero.
         *
         * A SealedBox's `ciphertext` is a slice of its combined buffer and
         * begins at index 12, and `+` keeps the left side's indices — so this
         * used to hand back a Data whose first byte was at [12]. Anything that
         * then indexed it from zero trapped, which took the whole test host
         * down rather than failing a test. Library types are
         * allowed to hand out offset slices; a function of ours is not. */
        return Data(box.ciphertext) + Data(box.tag)
    }

    /// nil when it has been touched, when the counter is wrong, when it is
    /// not the kind it says it is, or when it
    /// belongs to another handshake. The caller drops the link and says
    /// nothing about which: there is nothing useful to tell anybody, and an
    /// error that distinguishes them is an oracle.
    static func open(_ sealed: Data, with key: SymmetricKey, counter: UInt64, transcript th: Data,
                     kind: UInt8) -> Data? {
        guard sealed.count > 16 else { return nil }
        /* Copies, not slices.
         *
         * Data's prefix and suffix keep the parent's indices, so `suffix(16)`
         * is a Data whose first element is at 9, not 0. Handing one of those to
         * CryptoKit took the whole test host down rather than failing.
         * Whatever the library does with an offset buffer, it is not
         * worth finding out on a path that handles money. */
        let body = Data(sealed[sealed.startIndex..<(sealed.endIndex - 16)])
        let tag = Data(sealed[(sealed.endIndex - 16)..<sealed.endIndex])
        guard let box = try? ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: body, tag: tag) else { return nil }
        return try? ChaChaPoly.open(box, using: key, authenticating: bound(th, kind))
    }

    // MARK: Padding
    //
    // Encryption hides what crossed; it does not hide how much. A payment of
    // four proofs and one of forty are plainly different sizes, and size
    // tracks the amount. Padded, an offer is always an offer and a payment
    // falls into a bucket four kilobytes wide.

    static let offerSize = 2048
    static let paymentBlock = 4096
    /* Room for a reason, because M6 now carries one.
     *
     * 64 bytes held `{"ok":true}` and nothing else, which was all M6 ever said
     * — it was sealed from the radio's knowledge rather than the page's, so
     * there was never anything to explain. Now that the receiver answers with
     * what really became of the payment, a refusal has to say which refusal it
     * was, and `pad` returns nil for anything that does not fit: a reason one
     * byte too long would mean no M6 at all and a payer left waiting.
     * Still one flat size, so nothing is read off the wire. */
    static let resultSize = 256

    /* Change goes back in one flat size, like the offer and unlike the payment.
     *
     * A payment is padded in 4096 blocks because it can be any size and hiding
     * that exactly would cost more than it buys. Change is different: it is a
     * token for whatever was overpaid, and its size tracks the number of pieces,
     * which tracks the amount. A bucketed size would say roughly how much change
     * is going back, and from that roughly what was paid — on a link somebody
     * chose because it says nothing. So one size for every change message, big
     * enough for the largest token a change leg should ever carry. */
    static let changeSize = 2048
    static let mostPayment = 48 * 1024
    /* A payment bigger than one message goes in several (TapSession,
     * `paymentPart`). A frame says its length in two bytes, so one message can
     * never be more than 64 KB whatever this says; 128 KB in all is about three
     * hundred pieces, and a payment that size took a code of 39,000 characters
     * and 48 seconds to scan when it could not go this way. */
    static let mostPaymentTotal = 128 * 1024
    /// The most of a payment's own bytes one part carries: eleven blocks, less
    /// the four that say how long it is.
    static let partBody = 11 * 4096 - 4

    /// Four bytes of length, the body, then zeros to `to`.
    static func pad(_ body: Data, to size: Int) -> Data? {
        guard body.count + 4 <= size else { return nil }
        var out = Data(capacity: size)
        let n = UInt32(body.count)
        out.append(contentsOf: [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff),
                                UInt8(n >> 8 & 0xff), UInt8(n & 0xff)])
        out.append(body)
        out.append(Data(repeating: 0, count: size - out.count))
        return out
    }

    /// A payment is padded up to the next whole block rather than one fixed
    /// size: fixing it would mean sending 48 KB for every payment.
    static func padPayment(_ body: Data) -> Data? {
        let need = body.count + 4
        guard need <= mostPayment else { return nil }
        let size = ((need + paymentBlock - 1) / paymentBlock) * paymentBlock
        return pad(body, to: min(size, mostPayment))
    }

    static func unpad(_ padded: Data) -> Data? {
        guard padded.count >= 4 else { return nil }
        let b = [UInt8](padded.prefix(4))
        let n = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard n >= 0, 4 + n <= padded.count else { return nil }
        return padded.subdata(in: 4..<(4 + n))
    }
}
