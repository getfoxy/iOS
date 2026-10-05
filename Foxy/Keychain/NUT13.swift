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
        precondition(x.count == 32)
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
