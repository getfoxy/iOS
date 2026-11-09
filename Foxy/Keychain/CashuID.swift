import Foundation
import CryptoKit

/// A Foxy ID: a name another wallet can pay, which the payer learns once and
/// keeps in its contacts (docs/FOXY-ID.md).
///
/// Four keys come from the seed for it, each at a path of its own that no other
/// key of Foxy's uses:
///
///     m/129373'/20'/0'/0'/0'    the ID key d: what payments are locked to, blinded
///     m/129373'/20'/1'/0'/0'    the delivery key: NIP-17 messages for this wallet, nothing else
///     m/129373'/20'/2'/0'/0'    the paying key: this phone's own throwaway keys, for what it pays others
///     m/129373'/20'/3'/0'/0'    the recovery key: a copy of each payment this phone makes, to itself
///
/// 129373' is the purpose NUT-13 gives P2PK keys; the lock keys a payment
/// request takes are account 10' (P2PK.swift). Account 20' is the Foxy ID's,
/// and every level is hardened, so no public key and chain code of these paths
/// gives any other key. The same twelve words give the same keys on any phone.
///
/// **Payments are NUT-28's pay-to-blinded-key (P2BK)**, as cashu-ts makes them
/// (`deriveP2BKBlindedPubkeys`), so another wallet that has the ID's key can pay
/// it. A payer makes a throwaway key e for each piece, E = e·G, and blinds every
/// key of the lock by its slot i (0 the lock key, 1 the refund key):
///
///     Zx = x(e·P) = x(p·E)
///     rᵢ = SHA-256("Cashu_P2BK_v1" ‖ Zx ‖ i)      (once more with 0xFF appended if not 0 < rᵢ < n)
///     P′ = P + rᵢ·G
///
/// and puts E on the proof (`p2pk_e`, `pe` in a V4 token), which the wallet
/// strips before the mint sees it. The mint sees P′, a key nobody has seen
/// before, and nothing that ties it to the ID or to any other payment.
///
/// Here, with the ID key d: d·E has the same x, so rᵢ is the same number, and
/// the one-time key is d + r₀ when P′ = ID + r₀·G, or −d + r₀ when the payer
/// blinded the other point with the same x (BIP-340 keys carry no parity).
///
/// **The one-time key never leaves this file.** The page could choose an e of
/// its own, work r₀ out from the public ID, and with the one-time key recover
/// d = k − r₀: one call would hand it the ID key itself. So nothing here answers
/// a private key. The page gets the public keys, a signature binding the
/// delivery key to the ID, the delivery and recovery keys' private halves only
/// inside native (the inboxes, FoxyBridge+CashuID.swift), and signatures (`sign`): NUT-11's
/// Schnorr signature over SHA-256 of each proof's secret, for secrets whose lock
/// key is the blinding of this ID by that proof's own E, and for nothing else.
enum CashuID {
    enum Failure: Error, Equatable {
        /// An E or a key that is not a point on the curve.
        case badPoint
        /// No rᵢ in range after the retry, or a one-time key of 0: about 1 in 2^256.
        case badTweak
        /// A secret that is not a NUT-10 P2PK secret locked to this E's blinding of the ID.
        case notLocked
        /// libsecp256k1's context, or its serialisation, failed.
        case platform
    }

    static let purpose: UInt32 = 129373
    static let account: UInt32 = 20
    /// The ID key's path below the account, the delivery key's and the paying key's: every level hardened.
    static let idPath: [UInt32] = [0, 0, 0]
    static let deliveryPath: [UInt32] = [1, 0, 0]
    static let payPath: [UInt32] = [2, 0, 0]
    /// The recovery key's: NIP-17 copies of this phone's own payments to contacts, sent to itself so that the
    /// words find an uncollected payment again (docs/FOXY-ID.md, "Restoring"). Never in the ID string, never
    /// a lock key, never the delivery key; nothing but those copies is ever addressed to it.
    static let recoveryPath: [UInt32] = [3, 0, 0]

    /// NUT-28's domain, exactly as cashu-ts writes it (`P2BK_DST`): plain bytes, no tagged hash.
    static let p2bkPrefix = Array("Cashu_P2BK_v1".utf8)
    /// The payer's name on a delivery, proved to the receiver: SHA-256 of this, x(d_payer·ID_receiver) and E.
    static let fromPrefix = Array("foxy-cashu-id-from-v1".utf8)
    /// What the ID key signs once, so that a delivery key cannot be swapped under an ID: SHA-256 of this, ID and the delivery key.
    static let bindPrefix = Array("foxy-cashu-id-bind-v1".utf8)
    /// The paying key's HMAC domain for a payment's throwaway keys.
    static let payPrefix = Array("foxy-cashu-id-e-v1".utf8)

    /// The most secrets one `cashuIdSign` signs: the most pieces a payment carries.
    static let mostSecrets = 100
    /// The longest secret signed, as cashu-ts's MAX_SECRET_LENGTH.
    static let longestSecret = 1024

    // MARK: Keys

    /// The secret key at purpose' / account' / path' (hardened throughout). The caller wipes it.
    static func secret(seed: NUT13.Seed, path: [UInt32]) throws -> [UInt8] {
        try NUT13.withContext { ctx in
            var node = try NUT13.master(seed: seed, ctx)
            defer { node.wipe() }
            for level in [purpose, account] + path {
                var next = try NUT13.child(node, level | 0x8000_0000, ctx)
                swap(&node, &next)
                next.wipe()
            }
            NUT13.wipe(&node.chain)
            return node.key
        }
    }

    /// The digest the ID key signs to bind its delivery key: SHA-256(bindPrefix ‖ ID ‖ delivery key).
    static func bindDigest(id: [UInt8], nostr: [UInt8]) -> [UInt8] {
        Array(SHA256.hash(data: bindPrefix + id + nostr))
    }

    /// The ID public key (33 bytes, compressed), the delivery public key (32, x-only),
    /// the ID key's BIP-340 signature over `bindDigest`, made with no auxiliary
    /// randomness so the ID string is the same every time it is shown, and the
    /// recovery key's x-only public key (32), which the page sends its copies to
    /// and puts nowhere else.
    static func publicKeys(seed: NUT13.Seed) throws -> (id: [UInt8], nostr: [UInt8], sig: [UInt8], recovery: [UInt8]) {
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        var q = try secret(seed: seed, path: deliveryPath)
        defer { NUT13.wipe(&q) }
        var c = try secret(seed: seed, path: recoveryPath)
        defer { NUT13.wipe(&c) }
        return try NUT13.withContext { ctx in
            let id = try NUT13.publicKey(d, ctx)
            let nostr = try NUT13.xOnlyKey(q, ctx)
            let recovery = try NUT13.xOnlyKey(c, ctx)
            let sig = try NUT13.schnorr(digest: bindDigest(id: id, nostr: nostr), key: d, ctx,
                                        aux: [UInt8](repeating: 0, count: 32))
            return (id, nostr, sig, recovery)
        }
    }

    /// `cashuIdPublic`: {"id": <66 hex>, "nostr": <64 hex>, "sig": <128 hex>, "recovery": <64 hex>}.
    static func publicReply(_ keys: (id: [UInt8], nostr: [UInt8], sig: [UInt8], recovery: [UInt8])) -> String {
        "{\"id\":\"\(NUT13.hex(keys.id))\",\"nostr\":\"\(NUT13.hex(keys.nostr))\",\"sig\":\"\(NUT13.hex(keys.sig))\","
            + "\"recovery\":\"\(NUT13.hex(keys.recovery))\"}"
    }

    // MARK: NUT-28's blinding

    /// Whether `bytes` is a compressed point: 33 bytes starting 02 or 03 (the curve is checked when it is parsed).
    static func isPoint(_ bytes: [UInt8]) -> Bool {
        bytes.count == 33 && (bytes[0] == 2 || bytes[0] == 3)
    }

    /// rᵢ from the shared x coordinate and the slot, as cashu-ts's
    /// deriveP2BKBlindingTweakFromECDH: SHA-256(prefix ‖ Zx ‖ i), and once more
    /// with 0xFF appended when that is 0 or not below n. The caller wipes it.
    static func tweak(sharedX: [UInt8], slot: UInt8, _ ctx: OpaquePointer) throws -> [UInt8] {
        guard sharedX.count == 32 else { throw Failure.badTweak }
        var r = Array(SHA256.hash(data: p2bkPrefix + sharedX + [slot]))
        if NUT13.isScalar(r, ctx) { return r }
        NUT13.wipe(&r)
        r = Array(SHA256.hash(data: p2bkPrefix + sharedX + [slot, 0xFF]))
        if NUT13.isScalar(r, ctx) { return r }
        NUT13.wipe(&r)
        throw Failure.badTweak
    }

    /// rᵢ for `point` times `scalar` (e·P on the payer's side, p·E on the receiver's).
    static func tweak(point: [UInt8], scalar: [UInt8], slot: UInt8, _ ctx: OpaquePointer) throws -> [UInt8] {
        guard isPoint(point), NUT13.isPoint(point, ctx) else { throw Failure.badPoint }
        var z: [UInt8]
        do { z = try NUT13.multiply(point: point, by: scalar, ctx) } catch { throw Failure.badTweak }
        defer { NUT13.wipe(&z) }
        return try tweak(sharedX: Array(z[1..<33]), slot: slot, ctx)
    }

    /// The payer's side, for the vectors: P′ = P + rᵢ·G with rᵢ from e·P.
    static func blind(_ P: [UInt8], e: [UInt8], slot: UInt8, _ ctx: OpaquePointer) throws -> [UInt8] {
        var r = try tweak(point: P, scalar: e, slot: slot, ctx)
        defer { NUT13.wipe(&r) }
        return try NUT13.addTweak(point: P, r, ctx)
    }

    /// The one-time key for a lock key P′ (slot 0) blinded from the ID by E:
    /// d + r₀ when P′ = ID + r₀·G, −d + r₀ when P′ = −ID + r₀·G, and `notLocked`
    /// for any other key. The caller wipes it.
    static func oneTime(d: [UInt8], id: [UInt8], e point: [UInt8], lock: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        var r = try tweak(point: point, scalar: d, slot: 0, ctx)
        defer { NUT13.wipe(&r) }
        if try NUT13.addTweak(point: id, r, ctx) == lock {
            do { return try NUT13.addScalar(d, r, ctx) } catch { throw Failure.badTweak }
        }
        if try NUT13.addTweak(point: try NUT13.negated(point: id, ctx), r, ctx) == lock {
            var minus = try NUT13.negated(scalar: d, ctx)
            defer { NUT13.wipe(&minus) }
            do { return try NUT13.addScalar(minus, r, ctx) } catch { throw Failure.badTweak }
        }
        throw Failure.notLocked
    }

    // MARK: Signing

    /// The key a NUT-10 P2PK secret is locked to, as its `data` names it, as bytes;
    /// nil for any other secret, or one that asks for a signature over the whole
    /// transaction (SIG_ALL), which this signs for nothing.
    static func lockOf(_ secret: String) -> [UInt8]? {
        guard secret.utf8.count <= longestSecret, let data = secret.data(using: .utf8),
              let parts = (try? JSONSerialization.jsonObject(with: data)) as? [Any],
              parts.count == 2, (parts[0] as? String) == "P2PK",
              let body = parts[1] as? [String: Any],
              let key = body["data"] as? String, key.utf8.count == 66,
              let bytes = try? NUT13.bytes(hex: key), isPoint(bytes) else { return nil }
        if let tags = body["tags"] as? [Any] {
            for tag in tags {
                guard let pair = tag as? [Any], let name = pair.first as? String else { continue }
                if name.lowercased() == "sigflag", pair.count > 1, (pair[1] as? String)?.uppercased() == "SIG_ALL" { return nil }
            }
        }
        return bytes
    }

    /// One piece to sign: its secret, and the E it carried (`p2pk_e`).
    struct Piece: Equatable {
        let secret: String
        let e: [UInt8]
    }

    /// `cashuIdSign`'s work: one signature for each piece, in order. Every piece's
    /// lock key must be this ID blinded by that piece's own E; one that is not
    /// refuses the whole request (`notLocked`) and nothing is signed. Each one-time
    /// key is wiped before this returns.
    static func sign(seed: NUT13.Seed, pieces: [Piece]) throws -> [[UInt8]] {
        guard !pieces.isEmpty, pieces.count <= mostSecrets else { throw Failure.notLocked }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            let id = try NUT13.publicKey(d, ctx)
            var keys = [[UInt8]]()
            defer { for i in keys.indices { NUT13.wipe(&keys[i]) } }
            for piece in pieces {
                guard let lock = lockOf(piece.secret) else { throw Failure.notLocked }
                keys.append(try oneTime(d: d, id: id, e: piece.e, lock: lock, ctx))
            }
            return try zip(pieces, keys).map { piece, k in
                try NUT13.schnorr(digest: Array(SHA256.hash(data: Array(piece.secret.utf8))), key: k, ctx)
            }
        }
    }

    /// `cashuIdSignUnblinded`'s work, and only on the receiver's TAKE IT ANYWAY: one signature by the ID key
    /// itself for each secret, in order. Every secret's lock key must be the ID as it is (`data` with the ID's x,
    /// either parity: BIP-340 keys carry none), not a blinding of it; one that is anything else refuses the whole
    /// request (`notLocked`) and nothing is signed. A payer who locked to the bare ID showed the mint the ID at the
    /// claim, so signing here links that payment to the ID at the mint; the page asks first (docs/FOXY-ID.md,
    /// "Paid to the ID key itself"). The key is wiped before this returns, and never answered.
    static func signUnblinded(seed: NUT13.Seed, secrets: [String]) throws -> [[UInt8]] {
        guard !secrets.isEmpty, secrets.count <= mostSecrets else { throw Failure.notLocked }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            let id = try NUT13.publicKey(d, ctx)
            for text in secrets {
                guard let lock = lockOf(text), lock.count == 33, Array(lock[1..<33]) == Array(id[1..<33]) else {
                    throw Failure.notLocked
                }
            }
            return try secrets.map { text in
                try NUT13.schnorr(digest: Array(SHA256.hash(data: Array(text.utf8))), key: d, ctx)
            }
        }
    }

    /// `cashuIdSign`: {"sigs": [...]}.
    static func signReply(_ sigs: [[UInt8]]) -> String {
        "{\"sigs\":[" + sigs.map { "\"" + NUT13.hex($0) + "\"" }.joined(separator: ",") + "]}"
    }


    // MARK: A shop's sales, collected (docs/FOXY-ID.md, "Shops")

    /// What the ID key signs to prove to a shop that this phone is the keeper of the shop's Foxy ID:
    /// SHA-256(collectPrefix ‖ the shop's nonce (32 bytes) ‖ the shop's host ‖ the request's full path, as UTF-8: the
    /// link's path joined with the call's, as the shop's engine checks it), so a signature is good for one call at one shop. Nothing else
    /// signed by the ID key starts with these bytes, and no NUT-10 secret is a string that does.
    static let collectPrefix = Array("foxy-shop-collect-v1".utf8)
    /// NUT-20's amended message, as cashu-ts writes it (`Cashu_MintQuoteSig_v1`): plain bytes, then each field
    /// with its length as 4 bytes, big-endian.
    static let quoteSigPrefix = Array("Cashu_MintQuoteSig_v1".utf8)
    /// The most outputs one collected quote is minted into, the longest quote id and the longest host.
    static let mostOutputs = 256
    static let longestQuote = 256
    static let longestHost = 253

    /// A host as a shop's link names it: 1 to 253 characters of lowercase letters, digits, dots and dashes.
    static func isShopHost(_ host: String) -> Bool {
        let bytes = Array(host.utf8)
        guard !bytes.isEmpty, bytes.count <= longestHost else { return false }
        return bytes.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2e || $0 == 0x2d }
    }

    /// A quote id as a mint makes it: 1 to 256 characters of letters, digits, dashes and underscores.
    static func isQuoteId(_ quote: String) -> Bool {
        let bytes = Array(quote.utf8)
        guard !bytes.isEmpty, bytes.count <= longestQuote else { return false }
        return bytes.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d || $0 == 0x5f }
    }

    /// A request's path as a shop's call sends it (FOXY-ID.md, Shops): "" or "/" and up to 199 more of letters, digits and . _ ~ / -.
    static func isShopPath(_ path: String) -> Bool {
        let bytes = Array(path.utf8)
        if bytes.isEmpty { return true }
        guard bytes.count <= 200, bytes[0] == 0x2f else { return false }
        return bytes.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x30 && $0 <= 0x39)
            || $0 == 0x2e || $0 == 0x5f || $0 == 0x7e || $0 == 0x2f || $0 == 0x2d }
    }

    static func collectDigest(nonce: [UInt8], host: String, path: String) -> [UInt8] {
        Array(SHA256.hash(data: collectPrefix + nonce + Array(host.utf8) + Array(path.utf8)))
    }

    /// The ID key's BIP-340 signature over `collectDigest`, and the ID's public key (33): the shop checks the
    /// signature against the ID it was set up with. Nothing is signed for a nonce that is not 32 bytes or a host
    /// that is not a host.
    static func collectSign(seed: NUT13.Seed, nonce: [UInt8], host: String, path: String) throws -> (id: [UInt8], sig: [UInt8]) {
        guard nonce.count == 32, isShopHost(host), isShopPath(path) else { throw Failure.notLocked }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            let id = try NUT13.publicKey(d, ctx)
            return (id, try NUT13.schnorr(digest: collectDigest(nonce: nonce, host: host, path: path), key: d, ctx))
        }
    }

    /// One output of a mint request: its amount and its blinded message B_ (33 bytes).
    struct Output: Equatable {
        let amount: UInt64
        let blinded: [UInt8]
    }

    /// The amount as NUT-20's amended message carries it: big-endian with no leading zero bytes, none for 0.
    static func amountBytes(_ amount: UInt64) -> [UInt8] {
        var out = [UInt8]()
        var v = amount
        while v > 0 { out.insert(UInt8(v & 0xff), at: 0); v >>= 8 }
        return out
    }

    private static func length4(_ n: Int) -> [UInt8] {
        let v = UInt32(n)
        return [UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)]
    }

    /// NUT-20's two messages for a quote and its outputs: the amended one (cashu-ts `signMintQuote`'s
    /// successor, sent first) and the legacy one, SHA-256(quote id ‖ each B_ as hex), which an older mint asks for.
    static func quoteDigests(quote: String, outputs: [Output]) -> (amended: [UInt8], legacy: [UInt8]) {
        var amended = quoteSigPrefix
        let q = Array(quote.utf8)
        amended += length4(q.count) + q
        var legacy = q
        for o in outputs {
            let a = amountBytes(o.amount)
            amended += length4(a.count) + a + length4(o.blinded.count) + o.blinded
            legacy += Array(NUT13.hex(o.blinded).utf8)
        }
        return (Array(SHA256.hash(data: amended)), Array(SHA256.hash(data: legacy)))
    }

    /// d + r, the key of the ID moved by a shop's order number r (P′ = ID + r·G), and P′. r must be a number
    /// above 0 and below n, so the ID key itself is never what signs; the caller wipes the key. The key kept is
    /// never changed: r moves a copy.
    private static func movedKey(d: [UInt8], r: [UInt8], _ ctx: OpaquePointer) throws -> (k: [UInt8], P: [UInt8]) {
        guard NUT13.isScalar(r, ctx) else { throw Failure.badTweak }
        var k: [UInt8]
        do { k = try NUT13.addScalar(d, r, ctx) } catch { throw Failure.badTweak }
        do { return (k, try NUT13.publicKey(k, ctx)) } catch { NUT13.wipe(&k); throw error }
    }

    /// NUT-20's signatures, amended and legacy, by d + r over a quote locked to `pubkey`, which must be ID + r·G;
    /// for any other key nothing is signed (`notLocked`). The digests are made here from the quote and the outputs,
    /// never handed in.
    static func signQuote(seed: NUT13.Seed, r: [UInt8], quote: String, pubkey: [UInt8], outputs: [Output]) throws -> (sig: [UInt8], legacy: [UInt8]) {
        guard isQuoteId(quote), !outputs.isEmpty, outputs.count <= mostOutputs,
              outputs.allSatisfy({ isPoint($0.blinded) }), isPoint(pubkey) else { throw Failure.notLocked }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            var moved = try movedKey(d: d, r: r, ctx)
            defer { NUT13.wipe(&moved.k) }
            guard moved.P == pubkey else { throw Failure.notLocked }
            let digests = quoteDigests(quote: quote, outputs: outputs)
            return (try NUT13.schnorr(digest: digests.amended, key: moved.k, ctx),
                    try NUT13.schnorr(digest: digests.legacy, key: moved.k, ctx))
        }
    }

    /// NUT-11's signature by d + r for each secret, in order: every one a P2PK secret (not SIG_ALL) locked to
    /// exactly ID + r·G, or nothing is signed (`notLocked`).
    static func signMoved(seed: NUT13.Seed, r: [UInt8], secrets: [String]) throws -> [[UInt8]] {
        guard !secrets.isEmpty, secrets.count <= mostSecrets else { throw Failure.notLocked }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            var moved = try movedKey(d: d, r: r, ctx)
            defer { NUT13.wipe(&moved.k) }
            for text in secrets {
                guard let lock = lockOf(text), lock == moved.P else { throw Failure.notLocked }
            }
            return try secrets.map { text in
                try NUT13.schnorr(digest: Array(SHA256.hash(data: Array(text.utf8))), key: moved.k, ctx)
            }
        }
    }

    /// `cashuIdShop` kind collect: {"pub": <66 hex>, "sig": <128 hex>}.
    static func collectReply(_ signed: (id: [UInt8], sig: [UInt8])) -> String {
        "{\"pub\":\"\(NUT13.hex(signed.id))\",\"sig\":\"\(NUT13.hex(signed.sig))\"}"
    }

    /// `cashuIdShop` kind quote: {"sig": <128 hex>, "legacy": <128 hex>}.
    static func quoteReply(_ signed: (sig: [UInt8], legacy: [UInt8])) -> String {
        "{\"sig\":\"\(NUT13.hex(signed.sig))\",\"legacy\":\"\(NUT13.hex(signed.legacy))\"}"
    }

    // MARK: The payer's name, proved

    /// SHA-256(fromPrefix ‖ x(d·peer) ‖ E): the same on both sides, the payer with
    /// its d and the receiver's ID, the receiver with its d and the payer's ID.
    static func tag(seed: NUT13.Seed, peer: [UInt8], e: [UInt8]) throws -> [UInt8] {
        guard isPoint(peer), isPoint(e) else { throw Failure.badPoint }
        var d = try secret(seed: seed, path: idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            guard NUT13.isPoint(peer, ctx), NUT13.isPoint(e, ctx) else { throw Failure.badPoint }
            var z: [UInt8]
            do { z = try NUT13.multiply(point: peer, by: d, ctx) } catch { throw Failure.badTweak }
            defer { NUT13.wipe(&z) }
            return Array(SHA256.hash(data: fromPrefix + Array(z[1..<33]) + e))
        }
    }

    /// `cashuIdTag`: {"tag": <64 hex>}.
    static func tagReply(_ tag: [UInt8]) -> String { "{\"tag\":\"\(NUT13.hex(tag))\"}" }

    // MARK: The payer's throwaway keys

    /// The base a payment's throwaway keys come from: HMAC-SHA256 keyed by the
    /// paying key, over payPrefix ‖ the receiver's ID (33) ‖ the payment's index
    /// (4, big-endian) ‖ its locktime (8, big-endian). The page makes piece j's
    /// key from it as SHA-256(base ‖ j as 2 bytes), once more with 0xFF appended
    /// when that is not a key (08e-cashu-id.js `cidPieceKey`). The same words, the
    /// same contact, index and locktime give the same keys, so this phone finds
    /// the E and the blinded refund key of any payment of its own again.
    static func payBase(seed: NUT13.Seed, id: [UInt8], index: UInt32, locktime: UInt64) throws -> [UInt8] {
        guard isPoint(id) else { throw Failure.badPoint }
        var k = try secret(seed: seed, path: payPath)
        defer { NUT13.wipe(&k) }
        var message = payPrefix + id
        message += (0..<4).reversed().map { UInt8(truncatingIfNeeded: index >> (UInt32($0) * 8)) }
        message += (0..<8).reversed().map { UInt8(truncatingIfNeeded: locktime >> (UInt64($0) * 8)) }
        return Array(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: k)))
    }

    /// `cashuIdEphemeral`: {"base": <64 hex>}.
    static func baseReply(_ base: [UInt8]) -> String { "{\"base\":\"\(NUT13.hex(base))\"}" }

    // MARK: The drop boxes: the delivery key's rotating children

    /// A payment is never wrapped to the delivery key Q itself (docs/FOXY-ID.md, "The drop boxes"), but to one
    /// of sixteen keys of the UTC day it is posted on, each Q moved by a tweak anybody holding the ID string can
    /// work out:
    ///
    ///     tⱼ = SHA-256("foxy-cashu-id-drop-v1" ‖ Q ‖ day (4, big-endian) ‖ j)   (once more with 0xFF appended if not 0 < t < n)
    ///     key(day, j) = x(lift_x(Q) + tⱼ·G)
    ///
    /// with `day` the unix time divided by 86,400 and j from 0 to 15. The payer picks j at random; the receiver,
    /// who holds q, opens key(day, j) with q′ + tⱼ, q′ being q or n − q, whichever has the even point
    /// (BIP-340's lift_x). So the relays are asked for a day's sixteen keys, never for Q, and one day's keys
    /// share nothing a relay can see with another day's. Anybody with the ID string can work every key out:
    /// a payer, and a relay that was handed the string.
    static let dropPrefix = Array("foxy-cashu-id-drop-v1".utf8)
    /// An ANY WALLET request's own key: the same move of Q by SHA-256("foxy-cashu-id-any-v1" ‖ Q ‖ the request's
    /// id (4 bytes)), so a wallet that cannot work out a day's keys pays a key no other request names, and the
    /// request does not show Q.
    static let anyPrefix = Array("foxy-cashu-id-any-v1".utf8)
    /// The keys of one day.
    static let dropSlots = 16

    /// SHA-256(message), or SHA-256(message ‖ 0xFF) when that is 0 or not below n, as NUT-28's rᵢ.
    private static func hashedTweak(_ message: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        var t = Array(SHA256.hash(data: message))
        if NUT13.isScalar(t, ctx) { return t }
        NUT13.wipe(&t)
        t = Array(SHA256.hash(data: message + [0xFF]))
        if NUT13.isScalar(t, ctx) { return t }
        NUT13.wipe(&t)
        throw Failure.badTweak
    }

    /// tⱼ for the delivery key's x-only half, a UTC day and a slot.
    static func dropTweak(nostr: [UInt8], day: UInt32, slot: UInt8, _ ctx: OpaquePointer) throws -> [UInt8] {
        guard nostr.count == 32, slot < dropSlots else { throw Failure.badPoint }
        let day4 = (0..<4).reversed().map { UInt8(truncatingIfNeeded: day >> (UInt32($0) * 8)) }
        return try hashedTweak(dropPrefix + nostr + day4 + [slot], ctx)
    }

    /// An ANY WALLET request's tweak, by its 4-byte id.
    static func anyTweak(nostr: [UInt8], id: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard nostr.count == 32, id.count == 4 else { throw Failure.badPoint }
        return try hashedTweak(anyPrefix + nostr + id, ctx)
    }

    /// x(lift_x(Q) + t·G): what a payer wraps to.
    static func moved(nostr: [UInt8], tweak: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard nostr.count == 32, NUT13.isPoint([2] + nostr, ctx) else { throw Failure.badPoint }
        let point = try NUT13.addTweak(point: [2] + nostr, tweak, ctx)
        return Array(point[1..<33])
    }

    /// q′ + t, the secret of x(lift_x(Q) + t·G) for the delivery key's secret q. The caller wipes it.
    static func movedSecret(base q: [UInt8], tweak: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        let point = try NUT13.publicKey(q, ctx)
        var even = point[0] == 3 ? try NUT13.negated(scalar: q, ctx) : q
        defer { NUT13.wipe(&even) }
        do { return try NUT13.addScalar(even, tweak, ctx) } catch { throw Failure.badTweak }
    }

    /// key(day, j), x-only: the payer's half, which the page works out itself (08e-cashu-id.js `cidDropKey`).
    static func dropKey(nostr: [UInt8], day: UInt32, slot: UInt8) throws -> [UInt8] {
        try NUT13.withContext { ctx in
            var t = try dropTweak(nostr: nostr, day: day, slot: slot, ctx)
            defer { NUT13.wipe(&t) }
            return try moved(nostr: nostr, tweak: t, ctx)
        }
    }

    /// An ANY WALLET request's key, x-only.
    static func anyKey(nostr: [UInt8], id: [UInt8]) throws -> [UInt8] {
        try NUT13.withContext { ctx in
            var t = try anyTweak(nostr: nostr, id: id, ctx)
            defer { NUT13.wipe(&t) }
            return try moved(nostr: nostr, tweak: t, ctx)
        }
    }

    /// The secrets of every slot of every day named, day by day in the order given, slot 0 first. The caller wipes them.
    static func dropSecrets(base q: [UInt8], days: [UInt32]) throws -> [[UInt8]] {
        try NUT13.withContext { ctx in
            let nostr = try NUT13.xOnlyKey(q, ctx)
            var out = [[UInt8]]()
            do {
                for day in days {
                    for slot in 0..<UInt8(dropSlots) {
                        var t = try dropTweak(nostr: nostr, day: day, slot: slot, ctx)
                        defer { NUT13.wipe(&t) }
                        out.append(try movedSecret(base: q, tweak: t, ctx))
                    }
                }
            } catch {
                for i in out.indices { NUT13.wipe(&out[i]) }
                throw error
            }
            return out
        }
    }

    /// The secret of each ANY WALLET request's key, in the order given. The caller wipes them.
    static func anySecrets(base q: [UInt8], ids: [[UInt8]]) throws -> [[UInt8]] {
        try NUT13.withContext { ctx in
            let nostr = try NUT13.xOnlyKey(q, ctx)
            var out = [[UInt8]]()
            do {
                for id in ids {
                    var t = try anyTweak(nostr: nostr, id: id, ctx)
                    defer { NUT13.wipe(&t) }
                    out.append(try movedSecret(base: q, tweak: t, ctx))
                }
            } catch {
                for i in out.indices { NUT13.wipe(&out[i]) }
                throw error
            }
            return out
        }
    }
}
