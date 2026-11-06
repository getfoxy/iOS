import Foundation
import CryptoKit
import CommonCrypto
import Security
import CSecp256k1

/// NUT-13 deterministic secrets, derived here instead of in the page.
///
/// For NativeSeedBridge.swift's `counterReserve`, `counterReserveAt` and
/// `restoreSecrets`, in every build: the page builds outputs without holding the
/// seed. It must give the bytes cashu-ts 4.10.1 gives, byte for byte, or a
/// restore in any other wallet finds nothing: `tests/fixtures/nut13-vectors.json`
/// holds the spec's vectors and `tests/fixtures/nut13-cross.json` the bundled
/// cashu-ts's own answers, and FoxyTests/NUT13Tests.swift checks both.
///
/// The elliptic-curve step is libsecp256k1's (Vendor/secp256k1), never ours.
/// Hashes are CryptoKit's and PBKDF2 is CommonCrypto's.
enum NUT13 {
    enum Failure: Error, Equatable {
        /// Not a hex id starting 00 (16 characters) or 01 (66).
        case badKeysetId
        /// Outside 0 ..< 2^31 for a 00 keyset, or past 2^53 − 1 for a 01 one.
        case badCounter
        /// Not 12, 15, 18, 21 or 24 words, as @scure/bip39 requires.
        case badMnemonic
        /// A BIP-32 child, or an HMAC blinding factor, that is not a valid key.
        /// About 1 in 2^127 per step: an error, never a different key.
        case invalidKey
        /// PBKDF2, the random source or libsecp256k1's context failed.
        case platform
    }

    /// One counter's secret and blinding factor, 32 bytes each.
    struct Pair: Equatable {
        let secret: [UInt8]
        let blindingFactor: [UInt8]
    }

    /// The largest counter each keyset version derives. For 00 the counter is a
    /// hardened BIP-32 index, so 2^31 would wrap to another key; for 01 cashu-ts
    /// stops at JavaScript's largest exact integer, and so do we, so both sides
    /// agree on which counters exist.
    static let lastBip32Counter: UInt64 = 0x7FFF_FFFF
    static let lastHmacCounter: UInt64 = (1 << 53) - 1

    /// secp256k1's group order n, big-endian.
    static let order: [UInt8] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
        0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
    ]

    // MARK: The seed

    /// The 64-byte BIP-39 seed. Kept as a CryptoKit key, whose storage is
    /// zeroed when it is freed; an Array would leave copies behind.
    final class Seed {
        /// Internal, not private, so FoxyTests can compare it with BIP-39's seed.
        let key: SymmetricKey

        init(bytes: [UInt8]) {
            key = SymmetricKey(data: bytes)
        }

        fileprivate init(key: SymmetricKey) {
            self.key = key
        }
    }

    /// BIP-39's `mnemonicToSeedSync(words)`: PBKDF2-HMAC-SHA512, 2048 rounds,
    /// salt "mnemonic" (no passphrase), over the NFKD form of the words. Like
    /// @scure/bip39 it splits on single spaces and checks only the word count,
    /// not the checksum: the same words give the same seed on both sides.
    ///
    /// The words arrive as a Swift String, which cannot be wiped; the UTF-8
    /// copy and the derived bytes made here are.
    static func seed(mnemonic: String) throws -> Seed {
        let nfkd = mnemonic.decomposedStringWithCompatibilityMapping
        let words = nfkd.split(separator: " ", omittingEmptySubsequences: false).count
        guard [12, 15, 18, 21, 24].contains(words) else { throw Failure.badMnemonic }
        var password = Array(nfkd.utf8)
        let salt = Array("mnemonic".utf8)
        var derived = [UInt8](repeating: 0, count: 64)
        defer {
            wipe(&password)
            wipe(&derived)
        }
        let status = password.withUnsafeBytes { pass in
            derived.withUnsafeMutableBytes { out in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    pass.baseAddress?.assumingMemoryBound(to: CChar.self), pass.count,
                    salt, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512), 2048,
                    out.baseAddress?.assumingMemoryBound(to: UInt8.self), out.count)
            }
        }
        guard status == kCCSuccess else { throw Failure.platform }
        return derived.withUnsafeBytes { Seed(key: SymmetricKey(data: $0)) }
    }

    // MARK: Requests

    /// A keyset id this derives for: hex, "00" and 16 characters, or "01" and
    /// 66. Legacy base64 ids, and any other version, are refused.
    static func keysetVersion(_ keysetId: String) -> UInt8? {
        let hex = keysetId.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) || (0x41...0x46).contains($0) }
        guard hex else { return nil }
        if keysetId.utf8.count == 16, keysetId.hasPrefix("00") { return 0 }
        if keysetId.utf8.count == 66, keysetId.hasPrefix("01") { return 1 }
        return nil
    }

    /// A `00` keyset's BIP-32 index: the id read as a number, mod 2^31 − 1, as
    /// NUT-13 says. Different ids can share an index, and so a path and its
    /// secrets; CounterRules keeps their counters as one. Nil for anything but a
    /// `00` id.
    static func derivationIndex(_ keysetId: String) -> UInt32? {
        guard keysetVersion(keysetId) == 0, let number = UInt64(keysetId, radix: 16) else { return nil }
        return UInt32(number % 0x7FFF_FFFF)
    }

    /// Whether every counter from `start` to `start + count − 1` exists for this
    /// keyset version. The last one is checked, not only the first.
    static func countersFit(version: UInt8, start: UInt64, count: Int) -> Bool {
        guard count >= 1 else { return false }
        let last = version == 0 ? lastBip32Counter : lastHmacCounter
        let (end, overflow) = start.addingReportingOverflow(UInt64(count - 1))
        return !overflow && end <= last
    }

    /// Secrets and blinding factors for counters start ..< start + count.
    static func derive(seed: Seed, keysetId: String, start: UInt64, count: Int) throws -> [Pair] {
        guard let version = keysetVersion(keysetId) else { throw Failure.badKeysetId }
        guard countersFit(version: version, start: start, count: count) else { throw Failure.badCounter }
        if version == 1 {
            let id = try bytes(hex: keysetId)
            return try (0..<UInt64(count)).map { try hmacPair(seed: seed, keysetId: id, counter: start + $0) }
        }
        guard let keysetInt = derivationIndex(keysetId) else { throw Failure.badKeysetId }
        return try withContext { ctx in
            // m/129372'/0'/{keysetIdInt}' is the same for every counter: walked once.
            // Each key on the way is wiped once the next is made (review I2).
            var parent = try master(seed: seed, ctx)
            defer { parent.wipe() }
            for index in [129372, 0, keysetInt] as [UInt32] {
                var next = try child(parent, index | 0x8000_0000, ctx)
                swap(&parent, &next)
                next.wipe()
            }
            return try (0..<UInt64(count)).map { offset in
                var base = try child(parent, UInt32(start + offset) | 0x8000_0000, ctx)
                defer { base.wipe() }
                // children 0 and 1 hash the same public key: computed once
                let point = try publicKey(base.key, ctx)
                var secret = try child(base, 0, ctx, publicKey: point)
                var blinding = try child(base, 1, ctx, publicKey: point)
                // the keys are the answer; the chain codes are not, and go now
                NUT13.wipe(&secret.chain)
                NUT13.wipe(&blinding.chain)
                return Pair(secret: secret.key, blindingFactor: blinding.key)
            }
        }
    }

    /// counterReserve's and restoreSecrets' answer: one JSON object, the hex
    /// lowercase, in counter order.
    static func reply(keysetId: String, start: UInt64, pairs: [Pair]) -> String {
        let secrets = pairs.map { "\"" + hex($0.secret) + "\"" }.joined(separator: ",")
        let factors = pairs.map { "\"" + hex($0.blindingFactor) + "\"" }.joined(separator: ",")
        // keysetId has passed keysetVersion: hex digits only, nothing to escape
        return "{\"keysetId\":\"\(keysetId)\",\"start\":\(start),\"secrets\":[\(secrets)],\"blindingFactors\":[\(factors)]}"
    }

    // MARK: Keyset version 01: HMAC-SHA256

    /// HMAC-SHA256 keyed with the seed, over "Cashu_KDF_HMAC_SHA256" || keyset
    /// id bytes || counter (u64, big-endian) || 0x00 for the secret or 0x01 for
    /// the blinding factor, which is then reduced mod n by one subtraction.
    static func hmacPair(seed: Seed, keysetId: [UInt8], counter: UInt64) throws -> Pair {
        var message = Array("Cashu_KDF_HMAC_SHA256".utf8) + keysetId
        message += (0..<8).reversed().map { UInt8(truncatingIfNeeded: counter >> (UInt64($0) * 8)) }
        message.append(0x00)
        let secret = Array(HMAC<SHA256>.authenticationCode(for: message, using: seed.key))
        message[message.count - 1] = 0x01
        var digest = Array(HMAC<SHA256>.authenticationCode(for: message, using: seed.key))
        defer { wipe(&digest) }
        let blinding = reducedOnce(digest)
        // cashu-ts refuses r = 0 too (a 1 in 2^256 digest of 0 or n)
        guard !isZero(blinding) else { throw Failure.invalidKey }
        return Pair(secret: secret, blindingFactor: blinding)
    }

    /// x mod n for a 256-bit x, which is below 2n: x − n when x ≥ n, else x.
    /// Both are computed and one is picked with a mask, so which one does not
    /// show as a branch.
    static func reducedOnce(_ x: [UInt8]) -> [UInt8] {
        reducedOnce(x, modulo: order)
    }

    /// The same for another order above 2^255, as P-256's is (CardOwner): a
    /// 256-bit value is then below twice it, and one subtraction is all it can need.
    static func reducedOnce(_ x: [UInt8], modulo order: [UInt8]) -> [UInt8] {
        precondition(x.count == 32 && order.count == 32)
        var difference = [UInt8](repeating: 0, count: 32)
        var borrow: UInt16 = 0
        for i in (0..<32).reversed() {
            let d = UInt16(x[i]) &- UInt16(order[i]) &- borrow
            difference[i] = UInt8(truncatingIfNeeded: d)
            borrow = (d >> 15) & 1
        }
        // a borrow out of the top byte means x < n: keep x
        let keep = UInt8(truncatingIfNeeded: 0 &- borrow)
        return (0..<32).map { (x[$0] & keep) | (difference[$0] & ~keep) }
    }

    // MARK: Keyset version 00: BIP-32

    struct ExtendedKey {
        var key: [UInt8]
        var chain: [UInt8]

        /// Both halves zeroed, in place. Only the last holder of these arrays
        /// wipes the bytes: a copy that shares them is copied before it is written.
        mutating func wipe() {
            NUT13.wipe(&key)
            NUT13.wipe(&chain)
        }
    }

    /// BIP-32's master key: HMAC-SHA512 keyed "Bitcoin seed" over the seed.
    static func master(seed: Seed, _ ctx: OpaquePointer) throws -> ExtendedKey {
        var mac = seed.key.withUnsafeBytes {
            Array(HMAC<SHA512>.authenticationCode(for: $0, using: SymmetricKey(data: Array("Bitcoin seed".utf8))))
        }
        defer { wipe(&mac) }
        var master = ExtendedKey(key: Array(mac[0..<32]), chain: Array(mac[32..<64]))
        // BIP-32: a master key of 0 or ≥ n is invalid
        guard secp256k1_ec_seckey_verify(ctx, master.key) == 1 else {
            master.wipe()
            throw Failure.invalidKey
        }
        return master
    }

    /// BIP-32's CKDpriv. A hardened index hashes 0x00 || k; a normal one the
    /// compressed public key of k, which only libsecp256k1 computes.
    static func child(_ parent: ExtendedKey, _ index: UInt32, _ ctx: OpaquePointer,
                      publicKey point: [UInt8]? = nil) throws -> ExtendedKey {
        // 37 bytes at most, reserved first, so no append moves the private key
        // into a second buffer that is freed unwiped
        var data = [UInt8]()
        data.reserveCapacity(37)
        if index & 0x8000_0000 != 0 {
            data.append(0x00)
            data.append(contentsOf: parent.key)
        } else {
            data.append(contentsOf: try point ?? publicKey(parent.key, ctx))
        }
        data.append(contentsOf: [UInt8(truncatingIfNeeded: index >> 24), UInt8(truncatingIfNeeded: index >> 16),
                                 UInt8(truncatingIfNeeded: index >> 8), UInt8(truncatingIfNeeded: index)])
        var mac = Array(HMAC<SHA512>.authenticationCode(for: data, using: SymmetricKey(data: parent.chain)))
        var tweak = Array(mac[0..<32])
        defer {
            wipe(&data)
            wipe(&mac)
            wipe(&tweak)
        }
        // BIP-32: IL ≥ n makes this child invalid. IL = 0 is not (k + 0 = k):
        // seckey_verify refuses zero, so zero is let through here, and
        // tweak_add accepts 32 zero bytes. @scure/bip32 also refuses IL = 0; at
        // 1 in 2^256 the two cannot be told apart in practice.
        guard secp256k1_ec_seckey_verify(ctx, tweak) == 1 || isZero(tweak) else { throw Failure.invalidKey }
        var key = parent.key
        // fails only when k + IL ≡ 0 mod n, which BIP-32 also calls invalid
        guard secp256k1_ec_seckey_tweak_add(ctx, &key, tweak) == 1 else {
            wipe(&key)
            throw Failure.invalidKey
        }
        return ExtendedKey(key: key, chain: Array(mac[32..<64]))
    }

    /// The 33-byte compressed public key of a secret key.
    static func publicKey(_ key: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        var point = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_create(ctx, &point, key) == 1 else { throw Failure.invalidKey }
        var out = [UInt8](repeating: 0, count: 33)
        var length = out.count
        guard secp256k1_ec_pubkey_serialize(ctx, &out, &length, &point, UInt32(SECP256K1_EC_COMPRESSED)) == 1,
              length == 33 else { throw Failure.platform }
        return out
    }

    /// A libsecp256k1 context for one request, blinded with fresh randomness
    /// before any secret key touches it, as the library asks, and freed after.
    /// One per request means no context is shared between threads.
    static func withContext<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        guard let ctx = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else { throw Failure.platform }
        defer { secp256k1_context_destroy(ctx) }
        var blind = [UInt8](repeating: 0, count: 32)
        defer { wipe(&blind) }
        guard SecRandomCopyBytes(kSecRandomDefault, blind.count, &blind) == errSecSuccess,
              secp256k1_context_randomize(ctx, blind) == 1 else { throw Failure.platform }
        return try body(ctx)
    }

    // MARK: Bytes

    /// True for all zeros, looking at every byte whatever it finds.
    static func isZero(_ bytes: [UInt8]) -> Bool {
        bytes.reduce(0) { $0 | $1 } == 0
    }

    static func wipe(_ bytes: inout [UInt8]) {
        bytes.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            _ = memset_s(base, buffer.count, 0, buffer.count)
        }
    }

    static func hex(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(bytes.count * 2)
        for b in bytes {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    static func bytes(hex: String) throws -> [UInt8] {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { throw Failure.badKeysetId }
        func nibble(_ c: UInt8) throws -> UInt8 {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            case 0x41...0x46: return c - 0x41 + 10
            default: throw Failure.badKeysetId
            }
        }
        return try stride(from: 0, to: chars.count, by: 2).map { try nibble(chars[$0]) << 4 | nibble(chars[$0 + 1]) }
    }
}

/// A card's owner key, derived from the seed, and kept in native code.
///
/// A card is shown its owner as a P-256 public key when it is set up, and the owner
/// proves it later by signing, with the private half, what the card is asked to
/// do: its label, a number the card gave in that tap, and the value. The private
/// half is worked out here, from the seed and the card's own key, whenever it is
/// wanted, and never leaves. The page is given the owner PUBLIC key, signatures
/// for a fixed list of labels (each with the shape of value that label takes) and
/// nothing else, so a page that had been got at cannot take the key, and cannot
/// have anything signed that this list does not name: not LOCK_CARD, and not a time.
/// Restoring the twelve words on another phone makes the same key, so that phone
/// is the owner of every card this one was. The card's key is in the message, so
/// two cards of one owner have two keys.
///
/// h(counter) is HMAC-SHA256 keyed with the 64-byte BIP-39 seed, over "FoxyCard/owner",
/// a zero byte, the card's 33-byte compressed public key and, from counter 1 on,
/// that counter as one more byte. d is h(0) mod n, n being P-256's order; where
/// that is 0 it is h(1) mod n, and so on. That is a 1 in 2^256 event, and the
/// loop is there so that the key is always found and never left to chance.
enum CardOwner {
    static let tag = Array("FoxyCard/owner".utf8)

    /// P-256's group order n, big-endian.
    static let order: [UInt8] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84, 0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
    ]

    /// The nonce a card gives: 16 bytes.
    static let nonceLength = 16

    /// The longest value any label takes: SET_CARD's data with the longest mint
    /// (100 bytes before it and 80 for the mint). With a design it is no longer:
    /// the mint is then 77 bytes at the most, and the design three.
    static let mostValueBytes = 180

    /// What the page may have signed: the short names of the owner's commands,
    /// and no others. The bytes signed begin with "FoxyCard/" and the name, so
    /// LOCK_CARD ("FoxyCard/lock") and the time ("FoxyCard/time") are not on this
    /// list and cannot be asked for. No name is the start of another, so what was
    /// signed names its label in one way only.
    enum Label: String, CaseIterable {
        case changePin = "change-pin"
        case setLimit = "set-limit"
        case setOwner = "set-owner"
        case setCard = "set-card"
        case load
        /// RESET, card software 1.17: the card is given back to what it was in its packet, with a new key. The owner's proof is over
        /// the label and the nonce, and no value, as for load. And its let-go, card software 1.22 (RESET_CARD with P1 = 1): one opening
        /// of the card's own change given up, the proof over the label, the nonce and that opening's number, one byte from 0 to 7.
        case reset

        /// Whether `value` has the shape this label's command takes, which is
        /// what the card will read it as:
        ///  - change-pin: the new PIN, 4 to 8 bytes, each an ASCII digit;
        ///  - set-limit: the new limit, 4 bytes (the day's), or 8 (the day's and then
        ///    the limit on one tap, for a card that has one), or 12 (and then the
        ///    no-PIN allowance, for a card of software 1.16 and on), or 16 (and then
        ///    the rate, sats per dollar, for a card of software 1.23, whose figures
        ///    are cents);
        ///  - set-owner: the new owner key, 65 bytes, the first of them 04;
        ///  - set-card: the card's record, unit (1), refund key (33), time key (65, the
        ///    first of them 04, or all zeros: a card of software 1.15 and on has no time
        ///    key and reads none), mint length L (1, from 1 to 80) and the mint (L bytes);
        ///    and after the mint nothing, or the card's design (3, each a capital letter
        ///    or a digit, or all three zero for none), which a card of software 1.10 and
        ///    on reads there, after a mint of 77 bytes at the most. A record with no
        ///    design clears the card's, so a card that has one is sent it again;
        ///  - load: nothing;
        ///  - reset: nothing, or (the let-go) one byte, the number of an opening of change, 0 to 7.
        func accepts(_ value: [UInt8]) -> Bool {
            switch self {
            case .changePin:
                return (4...8).contains(value.count) && value.allSatisfy { (0x30...0x39).contains($0) }
            case .setLimit:
                return value.count == 4 || value.count == 8 || value.count == 12 || value.count == 16
            case .setOwner:
                return value.count == 65 && value[0] == 0x04
            case .setCard:
                guard value.count >= 100, value[34] == 0x04 || value[34..<99].allSatisfy({ $0 == 0 }) else { return false }
                let mint = Int(value[99])
                if (1...80).contains(mint) && value.count == 100 + mint { return true }
                // or with the design after the mint: three bytes more, and a mint no longer than a card that keeps a design takes
                guard (1...77).contains(mint), value.count == 103 + mint else { return false }
                let design = value[(100 + mint)...]
                return design.allSatisfy { $0 == 0 } || design.allSatisfy { (0x41...0x5A).contains($0) || (0x30...0x39).contains($0) }
            case .load:
                return value.isEmpty
            case .reset:
                return value.isEmpty || (value.count == 1 && value[0] <= 7)
            }
        }
    }

    /// One signature asked for, after its shape has been checked.
    struct SignRequest: Equatable {
        /// The card's compressed public key, which says whose owner key signs.
        let key: [UInt8]
        let label: Label
        let nonce: [UInt8]
        let value: [UInt8]
        /// For set-card: the lock-key index this phone derived the record's refund
        /// key at, so the key can be checked to be this phone's own (P2PK).
        var refundIndex: UInt64? = nil

        /// The shape checks again, on a request built some other way than by `CardOwner.signRequest`.
        var isWellFormed: Bool {
            CardOwner.isCardKey(key) && nonce.count == CardOwner.nonceLength && label.accepts(value)
        }
    }

    // MARK: What the phone asks before the card is held to it

    /// A new owner key for SET_OWNER is a point on P-256, the curve the card
    /// checks the owner's proofs on, and not only 65 bytes that begin 04. A card
    /// given 65 bytes that are no key could never be given an order again, by
    /// anyone; checked here, before the seed is read or anybody is asked.
    static func isOwnerKey(_ value: [UInt8]) -> Bool {
        value.count == 65 && value[0] == 0x04 && (try? P256.Signing.PublicKey(x963Representation: value)) != nil
    }

    /* The keeper's yes, given before the card session.
     *
     * The page drives the card and reads its nonces, so a script in it could
     * have the owner key sign a reset, a new owner, a new mint or a new PIN in
     * any tap. The keeper is asked instead, in the phone's own alert, at the
     * screen where the change begins and before any card is held up: the alert
     * iOS draws during a tap sits under the card sheet, and Face ID there can
     * end the session. A yes is kept as an approval, and the owner key signs
     * only a request that matches one: */

    /// The figures a limit carries: the day's, the one payment's, the no-PIN allowance.
    enum Figure: String, CaseIterable, Codable { case day, tap, noPin }

    /// A yes to one command, before the tap.
    ///  - change-pin, reset and set-owner: the exact bytes the card will be given.
    ///  - set-card: the mint, and the units it may hold there (0 bitcoin, 1 dollars;
    ///    none named is either). The rest of a record is the card's or this phone's,
    ///    and the key its money goes back to is checked against this phone's seed
    ///    when it is signed (SeedActions.cardOwnerSign).
    ///  - set-limit: which figures the keeper set; every other figure in the value
    ///    must be what the card itself said in this tap (`Seen`).
    ///  - `card`: the card it is for, where the page knows it; then no other.
    ///  - `keep`: a move to another mint whose record is written at a later tap:
    ///    kept on the phone, beside nothing else, until that write uses it.
    struct Approval: Codable, Equatable {
        let label: String
        let value: [UInt8]?
        let mint: [UInt8]?
        let units: [UInt8]?
        let figures: [Figure]?
        let card: [UInt8]?
        let keep: Bool
        let at: TimeInterval
    }

    /// What the page is told when the owner key will not sign: no yes for it,
    /// or a record whose money would go back to a key that is not this phone's.
    static let declined = "Nothing was changed on the card."

    /// How long a yes given before the tap lasts, unless its card session ends first.
    static let approvalLife: TimeInterval = 90

    /// cardOwnerApprove {label, value | mint, units, card?, keep? | figures}: the
    /// shape each label's approval takes, and nothing else. Load is asked nothing.
    static func approval(_ body: [String: Any], at: TimeInterval) -> Approval? {
        guard let name = body["label"] as? String, let label = Label(rawValue: name), label != .load else { return nil }
        var card: [UInt8]?
        if let given = body["card"] {
            guard let key = key(from: given) else { return nil }
            card = key
        }
        switch label {
        case .changePin, .reset, .setOwner:
            guard let text = body["value"] as? String, text.utf8.count <= 2 * mostValueBytes,
                  let value = try? NUT13.bytes(hex: text), label.accepts(value) else { return nil }
            if label == .setOwner, !isOwnerKey(value) { return nil }
            return Approval(label: name, value: value, mint: nil, units: nil, figures: nil, card: card, keep: false, at: at)
        case .setCard:
            guard let text = body["mint"] as? String, (1...80).contains(text.utf8.count),
                  text.utf8.allSatisfy({ (0x21...0x7E).contains($0) }) else { return nil }
            var units: [UInt8]?
            if let given = body["units"] {
                guard let list = given as? [String], !list.isEmpty, list.count <= 2 else { return nil }
                var out: [UInt8] = []
                for u in list {
                    switch u {
                    case "sat": out.append(0x00)
                    case "usd": out.append(0x01)
                    default: return nil
                    }
                }
                units = out
            }
            let keep = body["keep"] as? Bool ?? false
            // a move kept for a later tap is for one card, named
            if keep, card == nil { return nil }
            return Approval(label: name, value: nil, mint: Array(text.utf8), units: units, figures: nil, card: card, keep: keep, at: at)
        case .setLimit:
            guard let list = body["figures"] as? [String], !list.isEmpty, list.count <= 3 else { return nil }
            var figures: [Figure] = []
            for f in list {
                guard let figure = Figure(rawValue: f), !figures.contains(figure) else { return nil }
                figures.append(figure)
            }
            return Approval(label: name, value: nil, mint: nil, units: nil, figures: figures, card: card, keep: false, at: at)
        case .load:
            return nil
        }
    }

    /// What the card itself said in this tap, as the phone carried its answers:
    /// its limits (GET_INFO) and its record's unit and mint (its record).
    struct Seen: Equatable {
        var limits: [Figure: UInt32]?
        var unit: UInt8?
        var mint: [UInt8]?
        /// The card said it had no owner in this tap: this tap is its set-up, and the owner it has now is this phone.
        var unowned = false
    }

    /// Whether a GET_INFO answer (29, 30, 42 or 51 bytes) says the card has no owner: byte 16.
    static func unownedSeen(_ answer: [UInt8]) -> Bool {
        [29, 30, 42, 51].contains(answer.count) && answer[16] == 0
    }

    /// A card's limits from its GET_INFO answer of 42 bytes (P1 = 1) or 51 (P1 =
    /// 3), the status bytes off: the day's at 12, the one payment's at 30 and the
    /// no-PIN allowance at 34, four bytes each, as the page reads them
    /// (build/wallet/08a-flashcard.js, cardInfoOf). Nil for any other answer.
    static func limitsSeen(_ answer: [UInt8]) -> [Figure: UInt32]? {
        guard answer.count == 42 || answer.count == 51 else { return nil }
        func u32(_ i: Int) -> UInt32 { answer[i..<(i + 4)].reduce(0) { $0 << 8 | UInt32($1) } }
        return [.day: u32(12), .tap: u32(30), .noPin: u32(34)]
    }

    /// A card's unit and mint from its record answer (the status bytes off):
    /// the unit at 2, the mint's length at 105 and the mint after it, as the page
    /// reads them (cardRecordOf). Nil for anything that is not a record.
    static func recordSeen(_ answer: [UInt8]) -> (unit: UInt8, mint: [UInt8])? {
        guard answer.count >= 107 else { return nil }
        let length = Int(answer[105])
        guard (1...80).contains(length), answer.count == 106 + length || answer.count == 109 + length else { return nil }
        return (answer[2], Array(answer[106..<(106 + length)]))
    }

    /// The figures in a limit's value, by its length: 4 bytes the day's, 8 and the
    /// one payment's, 12 and the no-PIN allowance, 16 and then the rate, which is
    /// the phone's price and not a figure the keeper sets.
    static func figures(_ value: [UInt8]) -> [Figure: UInt32] {
        func u32(_ i: Int) -> UInt32 { value[i..<(i + 4)].reduce(0) { $0 << 8 | UInt32($1) } }
        var out: [Figure: UInt32] = [:]
        if value.count >= 4 { out[.day] = u32(0) }
        if value.count >= 8 { out[.tap] = u32(4) }
        if value.count >= 12 { out[.noPin] = u32(8) }
        return out
    }

    /// The mint a record names, and its unit.
    static func recordMint(_ value: [UInt8]) -> (unit: UInt8, mint: [UInt8])? {
        guard value.count > 100 else { return nil }
        let length = Int(value[99])
        guard value.count >= 100 + length else { return nil }
        return (value[0], Array(value[100..<(100 + length)]))
    }

    /// Whether `request` is what `approval` said yes to.
    static func matches(_ request: SignRequest, _ approval: Approval, seen: Seen) -> Bool {
        guard approval.label == request.label.rawValue else { return false }
        if let card = approval.card, card != request.key { return false }
        switch request.label {
        case .changePin, .reset, .setOwner:
            return approval.value == request.value
        case .setCard:
            guard let record = recordMint(request.value), record.mint == approval.mint else { return false }
            return approval.units.map { $0.contains(record.unit) } ?? true
        case .setLimit:
            let set = Set(approval.figures ?? [])
            for (figure, number) in figures(request.value) where !set.contains(figure) {
                guard seen.limits?[figure] == number else { return false }
            }
            return true
        case .load:
            return false
        }
    }

    /// The moves kept for a later tap, with the one `request` writes taken out:
    /// a yes kept for this card, to this mint and unit. Nil when none matches.
    /// A newer move for a card replaces the one before it (`keepMove`).
    static func useMove(_ kept: [Approval], for request: SignRequest, seen: Seen) -> [Approval]? {
        guard request.label == .setCard,
              let i = kept.firstIndex(where: { $0.keep && $0.card == request.key && matches(request, $0, seen: seen) }) else { return nil }
        var left = kept
        left.remove(at: i)
        return left
    }

    static func keepMove(_ kept: [Approval], _ move: Approval) -> [Approval] {
        Array((kept.filter { $0.card != move.card } + [move]).suffix(16))
    }

    /// What signs with nobody asked, because it changes nothing the keeper chose:
    ///  - a limit of card software 1.23 whose day's, one payment's and no-PIN
    ///    figures are the card's own, said in this tap: the rate written first,
    ///    before a top-up in sats (the rate follows the phone's price);
    ///  - a limit written in the tap that sets a card up, the card having said in it
    ///    that it had no owner: the keeper is setting it up, with its first limits;
    ///  - a record at the card's own mint and unit, said in this tap: only the key
    ///    its money goes back to changes, and that is checked to be this phone's
    ///    (a card claimed, or its backup moved to this phone's key).
    static func signsUnasked(_ request: SignRequest, seen: Seen) -> Bool {
        switch request.label {
        case .setLimit:
            if seen.unowned { return true }
            guard request.value.count == 16, let limits = seen.limits else { return false }
            return figures(request.value).allSatisfy { limits[$0.key] == $0.value }
        case .setCard:
            guard let record = recordMint(request.value), let unit = seen.unit, let mint = seen.mint else { return false }
            return record.unit == unit && record.mint == mint
        default:
            return false
        }
    }

    /// What the phone asks in its own alert, outside the page, before a yes is
    /// kept: the command, the card where it is named, and the keeper's choices.
    /// Every word is here; what is named is read from what the approval holds.
    struct Question: Equatable {
        let title: String
        let message: String
        let yes: String
        /// Face ID or the passcode after the yes, asked fresh: never the seed
        /// already unlocked, nor the moments after an unlock.
        let askOwner: Bool
        /// What iOS shows when it asks.
        let reason: String
    }

    static func question(for approval: Approval) -> Question? {
        guard let label = Label(rawValue: approval.label) else { return nil }
        let card = approval.card.map { "The card whose key begins \(shortHex(Array($0.dropFirst()), 8))." }
            ?? "The next card held to this phone."
        switch label {
        case .load:
            return nil
        case .setLimit:
            let names: [Figure: String] = [.day: "its daily limit", .tap: "its limit on one payment", .noPin: "its allowance without a PIN"]
            let chosen = (approval.figures ?? []).compactMap { names[$0] }
            let named = list(chosen)
            let sentence = String(named.prefix(1)).uppercased() + String(named.dropFirst())
            return Question(title: "Change this card's limits?",
                            message: card + " " + sentence
                                + " change\(chosen.count == 1 ? "s" : "") to what was just set. The card pays that much without this phone.",
                            yes: "Change", askOwner: false, reason: "")
        case .changePin:
            return Question(title: "Change this card's PIN?",
                            message: card + " Its PIN becomes the one just typed, and the old one stops working.",
                            yes: "Change PIN", askOwner: true, reason: "Change a card's PIN")
        case .setOwner:
            return Question(title: "Give this card to another wallet?",
                            message: card + " From then on it takes orders only from the wallet whose key begins "
                                + "\(shortHex(Array((approval.value ?? []).dropFirst()), 8)), and no longer from this phone.",
                            yes: "Give It Away", askOwner: true, reason: "Give a card to another wallet")
        case .setCard:
            let mint = approval.mint.flatMap { String(bytes: $0, encoding: .ascii) } ?? "a mint this phone cannot read"
            let units = approval.units ?? []
            let holds = units == [0x00] ? "bitcoin" : units == [0x01] ? "dollars" : "the currency it holds"
            return Question(title: "Move this card to another mint?",
                            message: card + " It will hold \(holds) at \(mint), and money it cannot spend goes back to this phone's own key.",
                            yes: "Move", askOwner: true, reason: "Move a card to another mint")
        case .reset:
            guard let opening = approval.value?.first else {
                return Question(title: "Reset this card?",
                                message: card + " It goes back to how it came, with a new key, and this phone no longer owns it.",
                                yes: "Reset", askOwner: true, reason: "Reset a card")
            }
            return Question(title: "Give up this card's change?",
                            message: card + " The change it is owed under opening \(opening) is given up for good.",
                            yes: "Give Up", askOwner: true, reason: "Give up a card's change")
        }
    }

    /// "a", "a and b", "a, b and c".
    private static func list(_ items: [String]) -> String {
        guard items.count > 1 else { return items.first ?? "its limits" }
        return items.dropLast().joined(separator: ", ") + " and " + (items.last ?? "")
    }

    /// The first `count` hex characters of `bytes`, lowercase.
    private static func shortHex(_ bytes: [UInt8], _ count: Int) -> String {
        String(bytes.map { String(format: "%02x", $0) }.joined().prefix(count))
    }

    // MARK: What the page sends

    /// A card's public key as the page gives it: 33 bytes, compressed, so
    /// starting 02 or 03.
    static func isCardKey(_ key: [UInt8]) -> Bool {
        key.count == 33 && (key[0] == 0x02 || key[0] == 0x03)
    }

    /// A card's key from the page's text: 66 hex characters, either case, for
    /// 33 bytes that start 02 or 03. Which card it is is not this check's question.
    static func key(from text: Any?) -> [UInt8]? {
        guard let text = text as? String, text.utf8.count == 66,
              let key = try? NUT13.bytes(hex: text), isCardKey(key) else { return nil }
        return key
    }

    /// cardOwnerSign's {key, label, nonce, value}: the key as above; a label that is exactly one
    /// of the six names; a nonce of 32 hex characters; and a value in hex that has the
    /// shape the label takes (an empty string for load). Nothing is read until this has passed.
    static func signRequest(_ body: [String: Any]) -> SignRequest? {
        guard let key = key(from: body["key"]),
              let name = body["label"] as? String, let label = Label(rawValue: name),
              let nonceText = body["nonce"] as? String, nonceText.utf8.count == 2 * nonceLength,
              let nonce = try? NUT13.bytes(hex: nonceText),
              let valueText = body["value"] as? String, valueText.utf8.count <= 2 * mostValueBytes,
              let value = try? NUT13.bytes(hex: valueText), label.accepts(value) else { return nil }
        // set-card's refund index, where given: a whole number a lock key can be derived at
        var refundIndex: UInt64?
        if let given = body["refundIndex"] {
            guard label == .setCard, let n = given as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue >= 0, n.doubleValue < Double(1 << 31), n.doubleValue == n.doubleValue.rounded() else { return nil }
            refundIndex = n.uint64Value
        }
        return SignRequest(key: key, label: label, nonce: nonce, value: value, refundIndex: refundIndex)
    }

    // MARK: The key

    /// What is HMACed for a counter: the tag, a zero byte, the card's key and, from
    /// counter 1 on, the counter.
    static func hashInput(cardKey: [UInt8], counter: UInt8) -> [UInt8] {
        var message = tag
        message.append(0x00)
        message += cardKey
        if counter > 0 { message.append(counter) }
        return message
    }

    /// d: the first h(counter) that is not 0 mod n, as 32 bytes, for counters 0, 1, 2 and
    /// so on. `hash` answers h(counter). A 256-bit value is below 2n, so mod n is
    /// one subtraction. Nil only if all 256 counters gave 0, which does not happen.
    static func scalar(hash: (_ counter: UInt8) -> [UInt8]) -> [UInt8]? {
        for counter in 0...UInt8.max {
            var digest = hash(counter)
            defer { NUT13.wipe(&digest) }
            let d = NUT13.reducedOnce(digest, modulo: order)
            if !NUT13.isZero(d) { return d }
        }
        return nil
    }

    /// The owner private key for the card with this key, as 32 bytes. The caller wipes it.
    static func scalar(seed: NUT13.Seed, cardKey: [UInt8]) -> [UInt8]? {
        scalar { counter in
            Array(HMAC<SHA256>.authenticationCode(for: hashInput(cardKey: cardKey, counter: counter), using: seed.key))
        }
    }

    /// Runs `body` with this card's owner private key, and wipes the scalar's bytes
    /// once it is made into a key. The key must not be kept or answered.
    static func withPrivateKey<T>(seed: NUT13.Seed, cardKey: [UInt8],
                                  _ body: (P256.Signing.PrivateKey) throws -> T) throws -> T {
        guard var d = scalar(seed: seed, cardKey: cardKey) else { throw NUT13.Failure.invalidKey }
        defer { NUT13.wipe(&d) }
        return try body(try P256.Signing.PrivateKey(rawRepresentation: d))
    }

    /// The owner public key: 65 bytes, 04 || X || Y.
    static func publicKey(seed: NUT13.Seed, cardKey: [UInt8]) throws -> [UInt8] {
        try withPrivateKey(seed: seed, cardKey: cardKey) { Array($0.publicKey.x963Representation) }
    }

    /// What the card verifies: "FoxyCard/" and the label, the nonce, the value.
    static func message(label: Label, nonce: [UInt8], value: [UInt8]) -> [UInt8] {
        Array("FoxyCard/".utf8) + Array(label.rawValue.utf8) + nonce + value
    }

    /// The owner's signature for a request that has passed its checks: ECDSA over
    /// P-256, SHA-256 of the message (CryptoKit hashes it), in DER.
    static func signature(for request: SignRequest, seed: NUT13.Seed) throws -> [UInt8] {
        let signed = Data(message(label: request.label, nonce: request.nonce, value: request.value))
        return try withPrivateKey(seed: seed, cardKey: request.key) { Array(try $0.signature(for: signed).derRepresentation) }
    }
}

// MARK: The Cashu ID's curve steps (CashuID.swift)

/// What a Cashu ID needs of the curve beyond a BIP-32 child, kept here with the
/// rest of Foxy's curve so that one file touches libsecp256k1 for the seed: a
/// point times a secret (the shared point d·E), NUT-28's blinding (P + r·G, and
/// the negated point and key for a payer that blinded the other parity), a key's
/// x-only public half (the delivery key's Nostr name), and a BIP-340 signature
/// (NUT-11's witness, and the ID's binding of its delivery key).
extension NUT13 {

    /// ser33(k·P), P a compressed point (33 bytes). Throws `invalidKey` for a P that
    /// is not on the curve or a k that is not a key.
    static func multiply(point: [UInt8], by k: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard point.count == 33, k.count == 32 else { throw Failure.invalidKey }
        var p = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &p, point, 33) == 1 else { throw Failure.invalidKey }
        guard secp256k1_ec_pubkey_tweak_mul(ctx, &p, k) == 1 else { throw Failure.invalidKey }
        var out = [UInt8](repeating: 0, count: 33)
        var length = out.count
        guard secp256k1_ec_pubkey_serialize(ctx, &out, &length, &p, UInt32(SECP256K1_EC_COMPRESSED)) == 1,
              length == 33 else { throw Failure.platform }
        return out
    }

    /// a + b mod n for two secret keys, where b is below n and above 0 and the sum is not 0.
    static func addScalar(_ a: [UInt8], _ b: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard secp256k1_ec_seckey_verify(ctx, b) == 1 else { throw Failure.invalidKey }
        var sum = a
        guard secp256k1_ec_seckey_tweak_add(ctx, &sum, b) == 1 else { wipe(&sum); throw Failure.invalidKey }
        return sum
    }

    /// Whether 32 bytes are a number above 0 and below n.
    static func isScalar(_ bytes: [UInt8], _ ctx: OpaquePointer) -> Bool {
        bytes.count == 32 && secp256k1_ec_seckey_verify(ctx, bytes) == 1
    }

    /// ser33(P + t·G), P a compressed point and t a number below n (NUT-28's P′).
    static func addTweak(point: [UInt8], _ t: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard point.count == 33, t.count == 32 else { throw Failure.invalidKey }
        var p = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &p, point, 33) == 1,
              secp256k1_ec_pubkey_tweak_add(ctx, &p, t) == 1 else { throw Failure.invalidKey }
        return try serialized(&p, ctx)
    }

    /// ser33(−P).
    static func negated(point: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard point.count == 33 else { throw Failure.invalidKey }
        var p = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &p, point, 33) == 1,
              secp256k1_ec_pubkey_negate(ctx, &p) == 1 else { throw Failure.invalidKey }
        return try serialized(&p, ctx)
    }

    /// n − k for a secret key k. The caller wipes it.
    static func negated(scalar k: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        var out = k
        guard secp256k1_ec_seckey_negate(ctx, &out) == 1 else { wipe(&out); throw Failure.invalidKey }
        return out
    }

    private static func serialized(_ p: inout secp256k1_pubkey, _ ctx: OpaquePointer) throws -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 33)
        var length = out.count
        guard secp256k1_ec_pubkey_serialize(ctx, &out, &length, &p, UInt32(SECP256K1_EC_COMPRESSED)) == 1,
              length == 33 else { throw Failure.platform }
        return out
    }

    /// Whether 33 bytes are a compressed point on the curve.
    static func isPoint(_ point: [UInt8], _ ctx: OpaquePointer) -> Bool {
        guard point.count == 33 else { return false }
        var p = secp256k1_pubkey()
        return secp256k1_ec_pubkey_parse(ctx, &p, point, 33) == 1
    }

    /// The x-only public key of a secret key (BIP-340), 32 bytes.
    static func xOnlyKey(_ key: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        var pair = secp256k1_keypair()
        defer { withUnsafeMutableBytes(of: &pair) { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
        guard secp256k1_keypair_create(ctx, &pair, key) == 1 else { throw Failure.invalidKey }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(ctx, &xonly, nil, &pair) == 1 else { throw Failure.platform }
        var out = [UInt8](repeating: 0, count: 32)
        guard secp256k1_xonly_pubkey_serialize(ctx, &out, &xonly) == 1 else { throw Failure.platform }
        return out
    }

    /// A BIP-340 signature by `key` over a 32-byte digest, checked before it is
    /// answered: with fresh auxiliary randomness, or with `aux` where a signature
    /// must come out the same each time (the Cashu ID's binding, all zeros).
    static func schnorr(digest: [UInt8], key: [UInt8], _ ctx: OpaquePointer, aux fixed: [UInt8]? = nil) throws -> [UInt8] {
        guard digest.count == 32 else { throw Failure.platform }
        var pair = secp256k1_keypair()
        defer { withUnsafeMutableBytes(of: &pair) { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
        guard secp256k1_keypair_create(ctx, &pair, key) == 1 else { throw Failure.invalidKey }
        var aux = [UInt8](repeating: 0, count: 32)
        if let fixed {
            guard fixed.count == 32 else { throw Failure.platform }
            aux = fixed
        } else {
            guard SecRandomCopyBytes(kSecRandomDefault, aux.count, &aux) == errSecSuccess else { throw Failure.platform }
        }
        var signature = [UInt8](repeating: 0, count: 64)
        guard secp256k1_schnorrsig_sign32(ctx, &signature, digest, &pair, aux) == 1 else { throw Failure.platform }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(ctx, &xonly, nil, &pair) == 1,
              secp256k1_schnorrsig_verify(ctx, signature, digest, 32, &xonly) == 1 else { throw Failure.platform }
        return signature
    }
}
