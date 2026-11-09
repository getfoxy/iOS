import XCTest
import CryptoKit
import CSecp256k1
@testable import Foxy

/// The Foxy ID's keys, NUT-28's blinding, a payment's one-time key, the payer's
/// proved name and the payer's throwaway keys (CashuID.swift, docs/FOXY-ID.md),
/// held to tests/fixtures/cashu-id-vectors.json: NUT-28's own vectors from the
/// spec, and Foxy's made by tests/harness.js's BigInt arithmetic, which shares no
/// code with libsecp256k1. tests/cashu-id.js holds cashu-ts's
/// deriveP2BKBlindedPubkeys and the page's own arithmetic to the same numbers.
///
/// Runs in FoxyTests and in tools/nativetests.
final class CashuIDTests: XCTestCase {

    /// The phrase tests/harness.js gives a phone.
    private let phone = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    // m/129373'/20'/1'/0'/0' of that phrase
    private let q = "25f4589423e0743eab93d96ab27d7de24fdb0ddf382405e6ca7c892321b990f7"

    private struct Vectors: Decodable {
        struct NUT28: Decodable {
            let e, E, p, P, pG, Zx, skNeg0, skStd0: String
            let r, blinded: [String]
        }
        struct Foxy: Decodable {
            let d, id, nostr, bindSig, pay, recoverySecret, recovery, e, E, r0, L, k, refund, refundBlinded: String
            let lockOfNegatedId, kOfNegatedId, peer, tag, base, piece0, piece1: String
            let baseIndex: UInt32
            let baseLocktime: UInt64
        }
        struct Drop: Decodable {
            struct Slot: Decodable { let slot: UInt8; let tweak, key, secret: String }
            let day: UInt32
            let slots: [Slot]
            let nextDayKey0, anyId, anyKey, anySecret: String
        }
        let nut28: NUT28
        let foxy: Foxy
        let drop: Drop
    }

    private func vectors() throws -> Vectors {
        let url = repoRoot().appendingPathComponent("tests/fixtures/cashu-id-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func b(_ hex: String) throws -> [UInt8] { try NUT13.bytes(hex: hex) }
    private func seed() throws -> NUT13.Seed { try NUT13.seed(mnemonic: phone) }

    func testTheKeysAtTheirOwnPaths() throws {
        let v = try vectors().foxy
        let s = try seed()
        XCTAssertEqual(NUT13.hex(try CashuID.secret(seed: s, path: CashuID.idPath)), v.d)
        XCTAssertEqual(NUT13.hex(try CashuID.secret(seed: s, path: CashuID.deliveryPath)), q)
        XCTAssertEqual(NUT13.hex(try CashuID.secret(seed: s, path: CashuID.payPath)), v.pay)
        // the recovery key, m/129373'/20'/3'/0'/0': its own path, and none of the others
        XCTAssertEqual(CashuID.recoveryPath, [3, 0, 0])
        XCTAssertEqual(NUT13.hex(try CashuID.secret(seed: s, path: CashuID.recoveryPath)), v.recoverySecret)
        var env = SeedEnvironment.live
        let words = phone
        env.savedSeed = { .found(try! NUT13.seed(mnemonic: words)) }
        XCTAssertEqual(NUT13.hex(try SeedActions.cashuIdRecoverySecret(env)), v.recoverySecret)
        let keys = try CashuID.publicKeys(seed: s)
        XCTAssertEqual(NUT13.hex(keys.id), v.id)
        XCTAssertEqual(NUT13.hex(keys.nostr), v.nostr)
        XCTAssertEqual(NUT13.hex(keys.recovery), v.recovery)
        XCTAssertNotEqual(keys.recovery, keys.nostr)
        // the binding signature has no auxiliary randomness: the same every time, and the harness's own
        XCTAssertEqual(NUT13.hex(keys.sig), v.bindSig)
        XCTAssertEqual(try CashuID.publicKeys(seed: s).sig, keys.sig)
        XCTAssertEqual(CashuID.publicReply(keys), "{\"id\":\"\(v.id)\",\"nostr\":\"\(v.nostr)\",\"sig\":\"\(v.bindSig)\",\"recovery\":\"\(v.recovery)\"}")
        // and none is a lock key a payment request takes (m/129373'/10'/0'/0'/i)
        let locks = try P2PK.publicKeys(seed: s, start: 0, count: 16).map { NUT13.hex($0) }
        XCTAssertFalse(locks.contains(v.id))
    }

    /// NUT-28's own vectors: the shared x, every slot's r and P′, and the one-time
    /// key for a receiver whose natural key has the other parity (skNeg).
    func testNUT28Vectors() throws {
        let v = try vectors().nut28
        try NUT13.withContext { ctx in
            let z = try NUT13.multiply(point: try b(v.P), by: try b(v.e), ctx)
            XCTAssertEqual(NUT13.hex(Array(z[1..<33])), v.Zx)
            // the receiver's side gives the same x
            let z2 = try NUT13.multiply(point: try b(v.E), by: try b(v.p), ctx)
            XCTAssertEqual(NUT13.hex(Array(z2[1..<33])), v.Zx)
            XCTAssertEqual(NUT13.hex(try NUT13.publicKey(try b(v.e), ctx)), v.E)
            XCTAssertEqual(NUT13.hex(try NUT13.publicKey(try b(v.p), ctx)), v.pG)
            for slot in 0..<11 {
                XCTAssertEqual(NUT13.hex(try CashuID.tweak(sharedX: try b(v.Zx), slot: UInt8(slot), ctx)), v.r[slot], "r\(slot)")
                XCTAssertEqual(NUT13.hex(try CashuID.blind(try b(v.P), e: try b(v.e), slot: UInt8(slot), ctx)), v.blinded[slot], "P′\(slot)")
            }
            // P was blinded with the 02 parity of a key whose natural point is 03: −p + r₀
            let k = try CashuID.oneTime(d: try b(v.p), id: try b(v.pG), e: try b(v.E), lock: try b(v.blinded[0]), ctx)
            XCTAssertEqual(NUT13.hex(k), v.skNeg0)
            XCTAssertNotEqual(NUT13.hex(k), v.skStd0)
            // a slot-1 key is not the lock key, and no one-time key comes of it
            XCTAssertThrowsError(try CashuID.oneTime(d: try b(v.p), id: try b(v.pG), e: try b(v.E), lock: try b(v.blinded[1]), ctx)) {
                XCTAssertEqual($0 as? CashuID.Failure, .notLocked)
            }
        }
    }

    /// Foxy's own: the ID blinded at slot 0 by e = 3, the refund key at slot 1 by
    /// the same e (cashu-ts's deriveP2BKBlindedPubkeys([ID, R], e)), the one-time
    /// key both ways, the proved name from both sides, and the paying key's base.
    func testFoxyVectors() throws {
        let v = try vectors().foxy
        try NUT13.withContext { ctx in
            XCTAssertEqual(NUT13.hex(try NUT13.publicKey(try b(v.e), ctx)), v.E)
            XCTAssertEqual(NUT13.hex(try CashuID.blind(try b(v.id), e: try b(v.e), slot: 0, ctx)), v.L)
            XCTAssertEqual(NUT13.hex(try CashuID.blind(try b(v.refund), e: try b(v.e), slot: 1, ctx)), v.refundBlinded)
            XCTAssertEqual(NUT13.hex(try CashuID.tweak(point: try b(v.E), scalar: try b(v.d), slot: 0, ctx)), v.r0)
            let k = try CashuID.oneTime(d: try b(v.d), id: try b(v.id), e: try b(v.E), lock: try b(v.L), ctx)
            XCTAssertEqual(NUT13.hex(k), v.k)
            XCTAssertEqual(NUT13.hex(try NUT13.publicKey(k, ctx)), v.L)
            let kn = try CashuID.oneTime(d: try b(v.d), id: try b(v.id), e: try b(v.E), lock: try b(v.lockOfNegatedId), ctx)
            XCTAssertEqual(NUT13.hex(kn), v.kOfNegatedId)
            // the ID key itself is not a lock this signs for
            XCTAssertThrowsError(try CashuID.oneTime(d: try b(v.d), id: try b(v.id), e: try b(v.E), lock: try b(v.id), ctx))
        }
        XCTAssertEqual(NUT13.hex(try CashuID.tag(seed: try seed(), peer: try b(v.peer), e: try b(v.E))), v.tag)
        XCTAssertEqual(NUT13.hex(try CashuID.payBase(seed: try seed(), id: try b(v.peer), index: v.baseIndex, locktime: v.baseLocktime)), v.base)
        XCTAssertNotEqual(NUT13.hex(try CashuID.payBase(seed: try seed(), id: try b(v.peer), index: v.baseIndex + 1, locktime: v.baseLocktime)), v.base)
        XCTAssertNotEqual(NUT13.hex(try CashuID.payBase(seed: try seed(), id: try b(v.peer), index: v.baseIndex, locktime: v.baseLocktime + 1)), v.base)
        // the page's piece keys from it (08e-cashu-id.js cidPieceKey): SHA-256(base ‖ j as two bytes)
        XCTAssertEqual(NUT13.hex(Array(SHA256.hash(data: try b(v.base) + [0, 0]))), v.piece0)
        XCTAssertEqual(NUT13.hex(Array(SHA256.hash(data: try b(v.base) + [0, 1]))), v.piece1)
    }

    /// The drop boxes (`CashuID.dropTweak`): the payer's key from the delivery key alone, the receiver's secret
    /// from q, both the vectors' (harness.js's BigInt arithmetic, and the page's noble curve in tests/cashu-id.js);
    /// each secret's key is its key; the delivery key's point is odd, so the secrets are n − q + t.
    func testDropBoxVectors() throws {
        let v = try vectors().drop
        let nostr = try b(try vectors().foxy.nostr)
        let base = try b(q)
        try NUT13.withContext { ctx in
            XCTAssertEqual(try NUT13.publicKey(base, ctx)[0], 3, "the vectors' delivery key has the odd point")
            for slot in v.slots {
                XCTAssertEqual(NUT13.hex(try CashuID.dropTweak(nostr: nostr, day: v.day, slot: slot.slot, ctx)), slot.tweak)
            }
        }
        for slot in v.slots {
            XCTAssertEqual(NUT13.hex(try CashuID.dropKey(nostr: nostr, day: v.day, slot: slot.slot)), slot.key)
        }
        XCTAssertEqual(NUT13.hex(try CashuID.dropKey(nostr: nostr, day: v.day + 1, slot: 0)), v.nextDayKey0)
        let secrets = try CashuID.dropSecrets(base: base, days: [v.day])
        XCTAssertEqual(secrets.count, CashuID.dropSlots)
        for slot in v.slots { XCTAssertEqual(NUT13.hex(secrets[Int(slot.slot)]), slot.secret) }
        // every secret opens its own key, and a day's sixteen keys are sixteen, none the delivery key, none the next day's
        // (NUT13.xOnlyKey, the BIP-340 key NostrCrypto.publicKey also makes: this file builds in tools/nativetests, which has no Nostr)
        let keys = try secrets.map { s in NUT13.hex(try NUT13.withContext { try NUT13.xOnlyKey(s, $0) }) }
        let next = try (0..<UInt8(CashuID.dropSlots)).map { NUT13.hex(try CashuID.dropKey(nostr: nostr, day: v.day + 1, slot: $0)) }
        for (j, key) in keys.enumerated() {
            XCTAssertEqual(key, NUT13.hex(try CashuID.dropKey(nostr: nostr, day: v.day, slot: UInt8(j))))
        }
        XCTAssertEqual(Set(keys).count, CashuID.dropSlots)
        XCTAssertFalse(keys.contains(NUT13.hex(nostr)))
        XCTAssertTrue(Set(keys).isDisjoint(with: next))
        // an ANY WALLET request's key
        let id = try b(v.anyId)
        XCTAssertEqual(NUT13.hex(try CashuID.anyKey(nostr: nostr, id: id)), v.anyKey)
        let any = try CashuID.anySecrets(base: base, ids: [id])
        XCTAssertEqual(any.map { NUT13.hex($0) }, [v.anySecret])
        XCTAssertEqual(NUT13.hex(try NUT13.withContext { try NUT13.xOnlyKey(any[0], $0) }), v.anyKey)
        // refused: a slot past fifteen, a key of the wrong length, an id of the wrong length
        XCTAssertThrowsError(try CashuID.dropKey(nostr: nostr, day: v.day, slot: 16))
        XCTAssertThrowsError(try CashuID.dropKey(nostr: Array(nostr.prefix(31)), day: v.day, slot: 0))
        XCTAssertThrowsError(try CashuID.anyKey(nostr: nostr, id: [1, 2, 3]))
    }

    private func secret(_ key: String, refund: String) -> String {
        "[\"P2PK\",{\"nonce\":\"00\",\"data\":\"\(key)\",\"tags\":[[\"locktime\",\"1900000000\"],[\"refund\",\"\(refund)\"]]}]"
    }

    func testSignsOnlyWhatIsLockedToItsBlindedKey() throws {
        let v = try vectors().foxy
        let s = try seed()
        let e = try b(v.E)
        let one = CashuID.Piece(secret: secret(v.L, refund: v.refundBlinded), e: e)
        let sigs = try CashuID.sign(seed: s, pieces: [one, one])
        XCTAssertEqual(sigs.count, 2)
        // each verifies under L′, over SHA-256 of its secret: NUT-11's witness
        let ctx = try XCTUnwrap(secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)))
        defer { secp256k1_context_destroy(ctx) }
        var point = secp256k1_pubkey()
        XCTAssertEqual(secp256k1_ec_pubkey_parse(ctx, &point, try b(v.L), 33), 1)
        var xonly = secp256k1_xonly_pubkey()
        XCTAssertEqual(secp256k1_xonly_pubkey_from_pubkey(ctx, &xonly, nil, &point), 1)
        let digest = Array(SHA256.hash(data: Array(one.secret.utf8)))
        for sig in sigs { XCTAssertEqual(secp256k1_schnorrsig_verify(ctx, sig, digest, 32, &xonly), 1) }
        // nothing signed when one piece is locked elsewhere: the ID key itself, or this key under another E
        XCTAssertThrowsError(try CashuID.sign(seed: s, pieces: [one, CashuID.Piece(secret: secret(v.id, refund: v.refund), e: e)])) {
            XCTAssertEqual($0 as? CashuID.Failure, .notLocked)
        }
        XCTAssertThrowsError(try CashuID.sign(seed: s, pieces: [CashuID.Piece(secret: one.secret, e: try b(v.peer))])) {
            XCTAssertEqual($0 as? CashuID.Failure, .notLocked)
        }
        // nor the refund key's slot
        XCTAssertThrowsError(try CashuID.sign(seed: s, pieces: [CashuID.Piece(secret: secret(v.refundBlinded, refund: v.refund), e: e)]))
        // never over the whole transaction, nor any other kind
        XCTAssertNil(CashuID.lockOf("[\"P2PK\",{\"nonce\":\"00\",\"data\":\"\(v.L)\",\"tags\":[[\"sigflag\",\"SIG_ALL\"]]}]"))
        XCTAssertNil(CashuID.lockOf("[\"HTLC\",{\"nonce\":\"00\",\"data\":\"\(v.L)\"}]"))
        // an E that is no point
        XCTAssertThrowsError(try CashuID.sign(seed: s, pieces: [CashuID.Piece(secret: one.secret, e: [2] + [UInt8](repeating: 0, count: 32))]))
    }

    /// TAKE IT ANYWAY (docs/FOXY-ID.md, "Paid to the ID key itself"): the ID key's own signature, only over
    /// secrets locked to the ID as it is, either parity, and nothing at all when one is anything else.
    func testSignsUnblindedOnlyWhatIsLockedToTheIdItself() throws {
        let v = try vectors().foxy
        let s = try seed()
        let bare = secret(v.id, refund: v.refund)
        let other = "03" + String(v.id.dropFirst(2))
        let bareOther = secret(v.id.hasPrefix("02") ? other : "02" + String(v.id.dropFirst(2)), refund: v.refund)
        let sigs = try CashuID.signUnblinded(seed: s, secrets: [bare, bareOther])
        XCTAssertEqual(sigs.count, 2)
        let ctx = try XCTUnwrap(secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)))
        defer { secp256k1_context_destroy(ctx) }
        var point = secp256k1_pubkey()
        XCTAssertEqual(secp256k1_ec_pubkey_parse(ctx, &point, try b(v.id), 33), 1)
        var xonly = secp256k1_xonly_pubkey()
        XCTAssertEqual(secp256k1_xonly_pubkey_from_pubkey(ctx, &xonly, nil, &point), 1)
        for (sig, text) in zip(sigs, [bare, bareOther]) {
            XCTAssertEqual(secp256k1_schnorrsig_verify(ctx, sig, Array(SHA256.hash(data: Array(text.utf8))), 32, &xonly), 1)
        }
        // a blinded key, the refund key, or one bare and one not: nothing is signed
        for list in [[secret(v.L, refund: v.refundBlinded)], [secret(v.refund, refund: v.refund)], [bare, secret(v.L, refund: v.refundBlinded)]] {
            XCTAssertThrowsError(try CashuID.signUnblinded(seed: s, secrets: list)) { XCTAssertEqual($0 as? CashuID.Failure, .notLocked) }
        }
        XCTAssertThrowsError(try CashuID.signUnblinded(seed: s, secrets: []))
        var env = SeedEnvironment.live
        let words = phone
        env.savedSeed = { .found(try! NUT13.seed(mnemonic: words)) }
        let reply = SeedActions.cashuIdSignUnblinded(secrets: [bare], env: env)
        XCTAssertNotNil(reply.text)
        XCTAssertFalse((reply.text ?? "").contains(v.d))
        XCTAssertEqual(SeedActions.cashuIdSignUnblinded(secrets: [secret(v.L, refund: v.refundBlinded)], env: env).error,
                       "That ecash is not locked to this Foxy ID.")
        XCTAssertEqual(SeedActions.cashuIdSignUnblinded(secrets: ["[\"HTLC\",{\"nonce\":\"00\",\"data\":\"\(v.id)\"}]"], env: env).error, "bad request")
        XCTAssertEqual(SeedActions.cashuIdSignUnblinded(secrets: [], env: env).error, "bad request")
    }

    func testTheActionsAnswerNoPrivateKey() throws {
        let v = try vectors().foxy
        let words = phone
        var env = SeedEnvironment.live
        env.savedSeed = { .found(try! NUT13.seed(mnemonic: words)) }
        let pub = SeedActions.cashuIdPublic(env)
        XCTAssertEqual(pub.text, "{\"id\":\"\(v.id)\",\"nostr\":\"\(v.nostr)\",\"sig\":\"\(v.bindSig)\",\"recovery\":\"\(v.recovery)\"}")
        let piece = CashuID.Piece(secret: secret(v.L, refund: v.refundBlinded), e: try b(v.E))
        let signed = SeedActions.cashuIdSign(pieces: [piece], env: env)
        XCTAssertNotNil(signed.text)
        let tag = SeedActions.cashuIdTag(peer: try b(v.peer), e: try b(v.E), env: env)
        XCTAssertEqual(tag.text, "{\"tag\":\"\(v.tag)\"}")
        let base = SeedActions.cashuIdEphemeral(id: try b(v.peer), index: v.baseIndex, locktime: v.baseLocktime, env: env)
        XCTAssertEqual(base.text, "{\"base\":\"\(v.base)\"}")
        for reply in [pub.text ?? "", signed.text ?? "", tag.text ?? "", base.text ?? ""] {
            XCTAssertFalse(reply.contains(v.d))
            XCTAssertFalse(reply.contains(q))
            XCTAssertFalse(reply.contains(v.k))
            XCTAssertFalse(reply.contains(v.r0))
            XCTAssertFalse(reply.contains(v.pay))
            XCTAssertFalse(reply.contains(v.recoverySecret))
        }
        XCTAssertEqual(SeedActions.cashuIdSign(pieces: [CashuID.Piece(secret: secret(v.id, refund: v.refund), e: try b(v.E))], env: env).error,
                       "That ecash is not locked to this Foxy ID.")
        XCTAssertEqual(SeedActions.cashuIdSign(pieces: [CashuID.Piece(secret: piece.secret, e: [1, 2, 3])], env: env).error, "bad request")
        XCTAssertEqual(SeedActions.cashuIdSign(pieces: [], env: env).error, "bad request")
        XCTAssertEqual(SeedActions.cashuIdTag(peer: [2, 3], e: try b(v.E), env: env).error, "bad request")
    }
}
