import Foundation
import CryptoKit

/// Messages between two Cashu IDs over Nostr (docs/CASHU-ID.md, "Messages").
///
/// Two Foxys that hold each other's ID work out one secret, the same on both
/// sides, from their ID keys alone:
///
///     secret = SHA-256("foxy-msg-pair-v1" ‖ x(d_mine · ID_peer))
///
/// (x(d_A·ID_B) = x(d_B·ID_A)), and from it every key a message between them is
/// sent to. Each direction has its own chain: `dir` is 0 for messages from the
/// lower ID key to the higher (the 33 compressed bytes compared as bytes) and 1
/// the other way, and message i of a direction goes to the x-only public half of
///
///     k_i = SHA-256("foxy-msg-recv-v1" ‖ secret ‖ dir ‖ i as 4 bytes, big-endian)
///
/// (once more with 0xFF appended if that is 0 or not below n). Every message goes
/// to a key used once, which says nothing of the ID, the delivery key or the other
/// messages: the relays see wraps to keys that never repeat. Its seal (NIP-59, the
/// encrypted middle layer) is signed by
///
///     s_i = SHA-256("foxy-msg-seal-v1" ‖ secret ‖ dir ‖ i)   (the same retry)
///
/// so the receiver believes a message only when its seal is by s_i·G: somebody
/// who saw k_i·G on a relay can send a wrap to it, but not one sealed by s_i.
/// The seal's key is inside the encryption, so a relay never sees it.
///
/// **Nothing here reaches the page.** The secret gives every key of both chains;
/// it is worked out on the seed queue, kept in memory for the session (`Cache`,
/// wiped when Foxy leaves the foreground), and used only to wrap a message to the next
/// key (`cashuIdMsgSend`) and to listen on and open the keys a contact may send to
/// (`cashuIdMsgOpen`). The page gets plaintexts and how many relays took a message.
enum CashuMsg {
    enum Failure: Error, Equatable {
        /// A peer that is not a point, or is this phone's own ID.
        case badPeer
        /// No key in range after the retry: about 1 in 2^256.
        case badKey
    }

    static let pairPrefix = Array("foxy-msg-pair-v1".utf8)
    static let recvPrefix = Array("foxy-msg-recv-v1".utf8)
    static let sealPrefix = Array("foxy-msg-seal-v1".utf8)

    /// How many keys of one direction a phone listens on past the lowest it has not had a message on.
    static let window = 8
    /// The most contacts one `cashuIdMsgOpen` listens for (fifty contacts and ten who are not one yet).
    static let mostPeers = 60
    /// The most keys of one direction, for one contact, one open asks for.
    static let mostPerDirection = 8
    /// The longest message body `cashuIdMsgSend` wraps: the largest padded size (2,048) with room to spare.
    static let largestBody = 4096
    /// How many `#p` keys go in one filter of the REQ: relays refuse a filter too long, so a long list is several.
    static let keysPerFilter = 100

    // MARK: The pair and its keys

    /// SHA-256(pairPrefix ‖ x(d·peer)). The caller wipes it.
    static func pairSecret(d: [UInt8], peer: [UInt8], _ ctx: OpaquePointer) throws -> [UInt8] {
        guard CashuID.isPoint(peer), NUT13.isPoint(peer, ctx) else { throw Failure.badPeer }
        var z: [UInt8]
        do { z = try NUT13.multiply(point: peer, by: d, ctx) } catch { throw Failure.badPeer }
        defer { NUT13.wipe(&z) }
        return Array(SHA256.hash(data: pairPrefix + Array(z[1..<33])))
    }

    /// The direction byte of messages from `from` to `to`: 0 when `from`'s 33 bytes are the lower, 1 when the higher;
    /// nil for the same key (no pair with oneself).
    static func direction(from: [UInt8], to: [UInt8]) -> UInt8? {
        guard from != to else { return nil }
        return from.lexicographicallyPrecedes(to) ? 0 : 1
    }

    /// SHA-256(prefix ‖ secret ‖ dir ‖ i (4, big-endian)), once more with 0xFF appended when it is not a key. The caller wipes it.
    static func key(_ prefix: [UInt8], secret: [UInt8], dir: UInt8, index: UInt32, _ ctx: OpaquePointer) throws -> [UInt8] {
        let at: [UInt8] = [UInt8(truncatingIfNeeded: index >> 24), UInt8(truncatingIfNeeded: index >> 16),
                           UInt8(truncatingIfNeeded: index >> 8), UInt8(truncatingIfNeeded: index)]
        var head: [UInt8] = prefix
        head += secret
        head.append(dir)
        head += at
        var k = Array(SHA256.hash(data: head))
        if NUT13.isScalar(k, ctx) { return k }
        NUT13.wipe(&k)
        k = Array(SHA256.hash(data: head + [0xFF]))
        if NUT13.isScalar(k, ctx) { return k }
        NUT13.wipe(&k)
        throw Failure.badKey
    }

    /// One pair, worked out: the secret, and which direction is this phone's out and which its in.
    struct Pair {
        var secret: [UInt8]
        let out: UInt8
        let inward: UInt8
    }

    /// The pair with `peer` from the seed's ID key, from the cache when it was worked out this session.
    static func pair(seed: NUT13.Seed, peer: [UInt8]) throws -> Pair {
        guard CashuID.isPoint(peer) else { throw Failure.badPeer }
        var d = try CashuID.secret(seed: seed, path: CashuID.idPath)
        defer { NUT13.wipe(&d) }
        return try NUT13.withContext { ctx in
            let mine = try NUT13.publicKey(d, ctx)
            guard let out = direction(from: mine, to: peer) else { throw Failure.badPeer }
            let name = NUT13.hex(mine) + NUT13.hex(peer)
            if let kept = cache.get(name) { return Pair(secret: kept, out: out, inward: 1 - out) }
            var secret = try pairSecret(d: d, peer: peer, ctx)
            cache.put(name, secret)
            defer { NUT13.wipe(&secret) }
            return Pair(secret: secret, out: out, inward: 1 - out)
        }
    }

    /// What sending message `index` to `peer` needs: the x-only key it goes to, and the seal's private key. The caller wipes `seal`.
    static func sendKeys(seed: NUT13.Seed, peer: [UInt8], index: UInt32) throws -> (to: [UInt8], seal: [UInt8]) {
        var p = try pair(seed: seed, peer: peer)
        defer { NUT13.wipe(&p.secret) }
        return try NUT13.withContext { ctx in
            var k = try key(recvPrefix, secret: p.secret, dir: p.out, index: index, ctx)
            defer { NUT13.wipe(&k) }
            let seal = try key(sealPrefix, secret: p.secret, dir: p.out, index: index, ctx)
            return (try NUT13.xOnlyKey(k, ctx), seal)
        }
    }

    /// One key listened on: whose, which way, which index, its private half (to open the wrap) and the x-only key its
    /// seal must be signed by.
    struct Listened {
        let peer: String
        let inward: Bool
        let index: UInt32
        var secret: [UInt8]
        let seal: [UInt8]
    }

    /// One contact's part of a `cashuIdMsgOpen`: the indices of its messages to this phone (`inward`), and of this
    /// phone's own to it (`outward`, read back only while this phone has lost its place, after a restore).
    struct Want: Equatable {
        let peer: [UInt8]
        let inward: [UInt32]
        let outward: [UInt32]
    }

    /// The keys for every contact asked for, in an order shuffled afresh each time: the REQ names them in this order, and
    /// kept together and in the page's order (the contact that wrote last first) they would show a relay which keys are
    /// one conversation. The caller wipes each `secret`.
    static func listenKeys(seed: NUT13.Seed, wants: [Want]) throws -> [Listened] {
        var g = SystemRandomNumberGenerator()
        return try listenKeys(seed: seed, wants: wants, using: &g)
    }

    /// The same with the shuffle's source named (the tests').
    static func listenKeys<G: RandomNumberGenerator>(seed: NUT13.Seed, wants: [Want], using g: inout G) throws -> [Listened] {
        var out = [Listened]()
        for want in wants {
            var p = try pair(seed: seed, peer: want.peer)
            defer { NUT13.wipe(&p.secret) }
            try NUT13.withContext { ctx in
                for (inward, list) in [(true, want.inward), (false, want.outward)] {
                    let dir = inward ? p.inward : p.out
                    for index in list {
                        let k = try key(recvPrefix, secret: p.secret, dir: dir, index: index, ctx)
                        var s = try key(sealPrefix, secret: p.secret, dir: dir, index: index, ctx)
                        defer { NUT13.wipe(&s) }
                        out.append(Listened(peer: NUT13.hex(want.peer), inward: inward, index: index, secret: k,
                                            seal: try NUT13.xOnlyKey(s, ctx)))
                    }
                }
            }
        }
        out.shuffle(using: &g)
        return out
    }

    // MARK: The page's requests, checked before the seed is read

    /// A compressed point as the page writes one: 66 hex characters, 02 or 03 first.
    static func point(_ value: Any?) -> [UInt8]? {
        guard let text = value as? String, text.utf8.count == 66,
              let bytes = try? NUT13.bytes(hex: text.lowercased()), CashuID.isPoint(bytes) else { return nil }
        return bytes
    }

    /// A whole number from 0 to 2^32 − 1, not a boolean.
    static func index(_ value: Any?) -> UInt32? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d.isFinite, d >= 0, d <= Double(UInt32.max), d.rounded(.towardZero) == d else { return nil }
        return UInt32(d)
    }

    struct SendRequest: Equatable {
        let peer: [UInt8]
        let index: UInt32
        let body: String
    }

    /// cashuIdMsgSend {peer, i, body}: a point, an index, and a body of 1 to 4,096 bytes that is a JSON object.
    static func sendCheck(_ body: [String: Any]) -> SendRequest? {
        guard let peer = point(body["peer"]), let i = index(body["i"]),
              let text = body["body"] as? String, !text.isEmpty, text.utf8.count <= largestBody,
              let data = text.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return nil }
        return SendRequest(peer: peer, index: i, body: text)
    }

    /// cashuIdMsgOpen {since, peers: [{peer, in: [i], out: [i]}]}: 1 to 60 contacts, none twice, each with at most
    /// eight indices each way, none twice. A contact named with no index at all (its chain at its very end) is left
    /// out, not the whole request refused: a refusal leaves the phone on the keys it had, deaf to every new one. Nil
    /// when nobody is left.
    static func openCheck(_ body: [String: Any]) -> [Want]? {
        guard let list = body["peers"] as? [Any], !list.isEmpty, list.count <= mostPeers else { return nil }
        var wants = [Want]()
        var named = [[UInt8]]()
        for item in list {
            guard let entry = item as? [String: Any], let peer = point(entry["peer"]),
                  !named.contains(peer) else { return nil }
            named.append(peer)
            var sides = [[UInt32]]()
            for name in ["in", "out"] {
                let raw = entry[name] ?? [Any]()
                guard let values = raw as? [Any], values.count <= mostPerDirection else { return nil }
                var got = [UInt32]()
                for v in values {
                    guard let i = index(v), !got.contains(i) else { return nil }
                    got.append(i)
                }
                sides.append(got)
            }
            if sides[0].isEmpty && sides[1].isEmpty { continue }
            wants.append(Want(peer: peer, inward: sides[0], outward: sides[1]))
        }
        return wants.isEmpty ? nil : wants
    }

    // MARK: The session's cache

    /// The pair secrets worked out this session, by this phone's ID and the peer's, at most 64 and wiped when cleared.
    final class Cache {
        private var kept: [String: [UInt8]] = [:]
        private var order: [String] = []
        private let lock = NSLock()
        static let most = 64

        func get(_ name: String) -> [UInt8]? {
            lock.lock(); defer { lock.unlock() }
            return kept[name]
        }

        func put(_ name: String, _ secret: [UInt8]) {
            lock.lock(); defer { lock.unlock() }
            if kept[name] == nil { order.append(name) }
            kept[name] = secret
            while order.count > Self.most {
                let old = order.removeFirst()
                if var s = kept.removeValue(forKey: old) { NUT13.wipe(&s) }
            }
        }

        var count: Int { lock.lock(); defer { lock.unlock() }; return kept.count }

        func clear() {
            lock.lock(); defer { lock.unlock() }
            for name in kept.keys { if var s = kept[name] { NUT13.wipe(&s) } }
            kept.removeAll()
            order.removeAll()
        }
    }

    static let cache = Cache()
}
