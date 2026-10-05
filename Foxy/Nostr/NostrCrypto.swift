import Foundation
import CryptoKit
import CSecp256k1

/// The cryptography a Nostr private message needs: NIP-44 v2, and the keys and
/// signatures of NIP-01.
///
/// Foxy speaks Nostr for one thing only: delivering a Cashu payment to a wallet
/// whose payment request asks for it (NUT-18). It never holds a Nostr identity —
/// every payment is sealed and wrapped with keys made for that payment and
/// forgotten after (FoxyNostr.swift).
///
/// Written here rather than taken from a library: the Swift ones in use bring
/// in a second secp256k1 wrapper beside the one Foxy already builds from
/// source, and a whole cipher library for the sixty lines of ChaCha20 below.
/// Everything here is checked against the specs' own vectors
/// (FoxyTests/NostrCryptoTests.swift): RFC 8439 for ChaCha20 and
/// tests/fixtures/nip44.vectors.json, the NIP-44 reference vectors, for the
/// rest.
enum NostrCrypto {

    enum Failure: Error, Equatable {
        case badKey
        case badPeer
        case tooLong
        case platform
    }

    // MARK: Keys

    /// A private key that is a valid secp256k1 scalar, from the system's random
    /// source. Nostr calls the x-only public key the "pubkey".
    static func newKey() throws -> [UInt8] {
        for _ in 0..<64 {
            var key = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, key.count, &key) == errSecSuccess else {
                throw Failure.platform
            }
            if let ctx = context() {
                defer { secp256k1_context_destroy(ctx) }
                if secp256k1_ec_seckey_verify(ctx, key) == 1 { return key }
            }
        }
        throw Failure.platform
    }

    /// A context that can sign: the signing calls refuse the static one.
    private static func context() -> OpaquePointer? {
        guard let ctx = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else { return nil }
        var seed = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, seed.count, &seed) == errSecSuccess,
              secp256k1_context_randomize(ctx, seed) == 1 else {
            secp256k1_context_destroy(ctx)
            return nil
        }
        return ctx
    }

    /// The 32-byte x-only public key for a private key.
    static func publicKey(of secret: [UInt8]) throws -> [UInt8] {
        guard secret.count == 32, let ctx = context() else { throw Failure.platform }
        defer { secp256k1_context_destroy(ctx) }
        var pair = secp256k1_keypair()
        defer { wipe(&pair) }
        guard secp256k1_keypair_create(ctx, &pair, secret) == 1 else { throw Failure.badKey }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(ctx, &xonly, nil, &pair) == 1 else { throw Failure.badKey }
        var out = [UInt8](repeating: 0, count: 32)
        guard secp256k1_xonly_pubkey_serialize(ctx, &out, &xonly) == 1 else { throw Failure.badKey }
        return out
    }

    /// BIP-340 over a 32-byte digest (a Nostr event id), with fresh auxiliary
    /// randomness, checked before it is used: `sign32`'s header says it does not
    /// verify what it made.
    static func sign(digest: [UInt8], with secret: [UInt8]) throws -> [UInt8] {
        guard digest.count == 32, secret.count == 32, let ctx = context() else { throw Failure.platform }
        defer { secp256k1_context_destroy(ctx) }
        var pair = secp256k1_keypair()
        defer { wipe(&pair) }
        guard secp256k1_keypair_create(ctx, &pair, secret) == 1 else { throw Failure.badKey }
        var aux = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, aux.count, &aux) == errSecSuccess else { throw Failure.platform }
        var signature = [UInt8](repeating: 0, count: 64)
        guard secp256k1_schnorrsig_sign32(ctx, &signature, digest, &pair, aux) == 1 else { throw Failure.badKey }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_keypair_xonly_pub(ctx, &xonly, nil, &pair) == 1,
              secp256k1_schnorrsig_verify(ctx, signature, digest, 32, &xonly) == 1 else { throw Failure.badKey }
        return signature
    }

    /// Whether a BIP-340 signature holds for a digest and an x-only key. Used
    /// where a signature is made (above), and by the tests.
    static func verify(_ signature: [UInt8], digest: [UInt8], pubkey: [UInt8]) -> Bool {
        guard signature.count == 64, digest.count == 32, pubkey.count == 32, let ctx = context() else { return false }
        defer { secp256k1_context_destroy(ctx) }
        var xonly = secp256k1_xonly_pubkey()
        guard secp256k1_xonly_pubkey_parse(ctx, &xonly, pubkey) == 1 else { return false }
        return secp256k1_schnorrsig_verify(ctx, signature, digest, 32, &xonly) == 1
    }

    private static func wipe(_ pair: inout secp256k1_keypair) {
        withUnsafeMutableBytes(of: &pair.data) { raw in
            raw.copyBytes(from: [UInt8](repeating: 0, count: raw.count))
        }
    }

    // MARK: NIP-44 v2

    /// The conversation key two keys share: HKDF-extract over the x of a·B,
    /// with "nip44-v2" as the salt. The x is the point's, unhashed, which is
    /// what `secp256k1_ecdh` gives with the hash function below.
    static func conversationKey(secret: [UInt8], peer: [UInt8]) throws -> [UInt8] {
        guard secret.count == 32, peer.count == 32, let ctx = context() else { throw Failure.platform }
        defer { secp256k1_context_destroy(ctx) }
        // an x-only key lifted to even Y; the x of a·P does not depend on that choice
        var compressed = [UInt8](repeating: 0, count: 33)
        compressed[0] = 0x02
        for i in 0..<32 { compressed[i + 1] = peer[i] }
        var point = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &point, compressed, 33) == 1 else { throw Failure.badPeer }
        var shared = [UInt8](repeating: 0, count: 32)
        let xOnly: secp256k1_ecdh_hash_function = { out, x32, _, _ in
            guard let out, let x32 else { return 0 }
            out.update(from: x32, count: 32)
            return 1
        }
        guard secp256k1_ecdh(ctx, &shared, &point, secret, xOnly, nil) == 1 else { throw Failure.badKey }
        let key = HKDF<SHA256>.extract(inputKeyMaterial: SymmetricKey(data: shared),
                                       salt: Data("nip44-v2".utf8))
        return [UInt8](key.withUnsafeBytes { Data($0) })
    }

    /// The largest plaintext NIP-44 v2 takes here. The spec now allows up to
    /// 2^32-1 with a longer length prefix, but the wallets Foxy delivers to
    /// (cashu.me's nostr-tools 2.5.2) still refuse anything over this, and a
    /// payment is a few kilobytes.
    static let longestMessage = 65535

    /// A NIP-44 v2 payload: base64 of 0x02, the nonce, the ciphertext and the MAC.
    /// `nonce` is for the vectors; it is fresh randomness otherwise.
    static func encrypt(_ plaintext: [UInt8], conversationKey: [UInt8], nonce: [UInt8]? = nil) throws -> String {
        guard conversationKey.count == 32 else { throw Failure.badKey }
        guard !plaintext.isEmpty, plaintext.count <= longestMessage else { throw Failure.tooLong }
        var seed = nonce ?? [UInt8](repeating: 0, count: 32)
        if nonce == nil {
            guard SecRandomCopyBytes(kSecRandomDefault, seed.count, &seed) == errSecSuccess else {
                throw Failure.platform
            }
        }
        guard seed.count == 32 else { throw Failure.badKey }
        let keys = messageKeys(conversationKey: conversationKey, nonce: seed)
        let padded = pad(plaintext)
        let ciphertext = ChaCha20.apply(padded, key: keys.chacha, nonce: keys.nonce)
        let mac = hmac(key: keys.hmac, message: seed + ciphertext)
        return Data([0x02] + seed + ciphertext + mac).base64EncodedString()
    }

    /// The plaintext of a payload, or nil when anything about it is wrong: the
    /// version, its shape, the MAC, or the padding.
    static func decrypt(_ payload: String, conversationKey: [UInt8]) -> [UInt8]? {
        guard conversationKey.count == 32, !payload.hasPrefix("#"), payload.utf8.count >= 132,
              let raw = Data(base64Encoded: payload), raw.count >= 99, raw.count <= 0xFFFF + 132,
              raw[raw.startIndex] == 0x02 else { return nil }
        let bytes = [UInt8](raw)
        let nonce = Array(bytes[1..<33])
        let ciphertext = Array(bytes[33..<(bytes.count - 32)])
        let mac = Array(bytes[(bytes.count - 32)...])
        let keys = messageKeys(conversationKey: conversationKey, nonce: nonce)
        let want = hmac(key: keys.hmac, message: nonce + ciphertext)
        guard constantTimeEqual(want, mac) else { return nil }
        let padded = ChaCha20.apply(ciphertext, key: keys.chacha, nonce: keys.nonce)
        guard padded.count >= 2 else { return nil }
        let length = Int(padded[0]) << 8 | Int(padded[1])
        guard length > 0, padded.count == 2 + paddedLength(length) else { return nil }
        return Array(padded[2..<(2 + length)])
    }

    /// HKDF-expand of the conversation key over the nonce: the cipher's key and
    /// nonce, and the key its MAC is taken with.
    static func messageKeys(conversationKey: [UInt8], nonce: [UInt8]) -> (chacha: [UInt8], nonce: [UInt8], hmac: [UInt8]) {
        let bytes = [UInt8](HKDF<SHA256>.expand(pseudoRandomKey: conversationKey, info: Data(nonce),
                                                outputByteCount: 76).withUnsafeBytes { Data($0) })
        return (Array(bytes[0..<32]), Array(bytes[32..<44]), Array(bytes[44..<76]))
    }

    private static func hmac(key: [UInt8], message: [UInt8]) -> [UInt8] {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        mac.update(data: Data(message))
        return [UInt8](mac.finalize())
    }

    private static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for i in a.indices { difference |= a[i] ^ b[i] }
        return difference == 0
    }

    /// NIP-44's padding: the length in two bytes, the message, then zeros up to
    /// the next step. Messages of a size therefore all look alike.
    static func paddedLength(_ length: Int) -> Int {
        if length <= 32 { return 32 }
        let nextPower = 1 << (Int(log2(Double(length - 1))) + 1)
        let chunk = nextPower <= 256 ? 32 : nextPower / 8
        return chunk * ((length - 1) / chunk + 1)
    }

    static func pad(_ message: [UInt8]) -> [UInt8] {
        let total = paddedLength(message.count)
        return [UInt8(message.count >> 8), UInt8(message.count & 0xFF)] + message
            + [UInt8](repeating: 0, count: total - message.count)
    }
}

/// ChaCha20 as RFC 8439 §2.4 states it: a 32-byte key, a 12-byte nonce and a
/// 32-bit counter. CryptoKit has only ChaChaPoly, whose keystream starts at
/// counter 1 and which cannot be told the nonce NIP-44 derives, so the cipher
/// is here. Checked against the RFC's vectors (FoxyTests/NostrCryptoTests.swift).
enum ChaCha20 {
    static func apply(_ input: [UInt8], key: [UInt8], nonce: [UInt8], counter: UInt32 = 0) -> [UInt8] {
        guard key.count == 32, nonce.count == 12 else { return [] }
        var out = [UInt8]()
        out.reserveCapacity(input.count)
        var at = 0
        var block = counter
        while at < input.count {
            let stream = keystream(key: key, nonce: nonce, counter: block)
            for i in 0..<min(64, input.count - at) { out.append(input[at + i] ^ stream[i]) }
            at += 64
            block &+= 1
        }
        return out
    }

    private static let constants: [UInt32] = [0x6170_7865, 0x3320_646E, 0x7962_2D32, 0x6B20_6574]

    static func keystream(key: [UInt8], nonce: [UInt8], counter: UInt32) -> [UInt8] {
        var state = constants
        for i in 0..<8 { state.append(word(key, i * 4)) }
        state.append(counter)
        for i in 0..<3 { state.append(word(nonce, i * 4)) }
        var mixed = state
        for _ in 0..<10 {
            quarter(&mixed, 0, 4, 8, 12)
            quarter(&mixed, 1, 5, 9, 13)
            quarter(&mixed, 2, 6, 10, 14)
            quarter(&mixed, 3, 7, 11, 15)
            quarter(&mixed, 0, 5, 10, 15)
            quarter(&mixed, 1, 6, 11, 12)
            quarter(&mixed, 2, 7, 8, 13)
            quarter(&mixed, 3, 4, 9, 14)
        }
        var out = [UInt8]()
        out.reserveCapacity(64)
        for i in 0..<16 {
            let value = mixed[i] &+ state[i]
            out.append(UInt8(value & 0xFF))
            out.append(UInt8((value >> 8) & 0xFF))
            out.append(UInt8((value >> 16) & 0xFF))
            out.append(UInt8((value >> 24) & 0xFF))
        }
        return out
    }

    private static func word(_ bytes: [UInt8], _ at: Int) -> UInt32 {
        UInt32(bytes[at]) | UInt32(bytes[at + 1]) << 8 | UInt32(bytes[at + 2]) << 16 | UInt32(bytes[at + 3]) << 24
    }

    private static func quarter(_ s: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        s[a] = s[a] &+ s[b]; s[d] = rotate(s[d] ^ s[a], 16)
        s[c] = s[c] &+ s[d]; s[b] = rotate(s[b] ^ s[c], 12)
        s[a] = s[a] &+ s[b]; s[d] = rotate(s[d] ^ s[a], 8)
        s[c] = s[c] &+ s[d]; s[b] = rotate(s[b] ^ s[c], 7)
    }

    private static func rotate(_ value: UInt32, _ by: UInt32) -> UInt32 {
        (value << by) | (value >> (32 - by))
    }
}
