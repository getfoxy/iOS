import Foundation
import CryptoKit

/// Nostr events, and the gift wrap a private message is carried in.
///
/// NIP-01 for the event and its id, NIP-59 for the wrapping, NIP-17 for what a
/// private message looks like inside it. A payment Foxy delivers is three
/// events, one inside the next:
///
///   - the **rumor**, kind 14, holding the payment, unsigned;
///   - the **seal**, kind 13, the rumor encrypted to the receiver, signed by a
///     key made for this payment. Wallets check this signature and that the
///     rumor names the same key (nostr-tools, rust-nostr), so it is a real
///     signature by a real key — just not one Foxy keeps;
///   - the **gift wrap**, kind 1059, the seal encrypted to the receiver again,
///     signed by a second one-time key. This is what relays see: an encrypted
///     message addressed to the receiver, from nobody.
///
/// The seal's and the wrap's times are moved back by up to two days, as the NIP
/// says, so a relay cannot line messages up by when they arrived. The rumor
/// keeps the real time; only the receiver reads it.
enum NostrEvent {

    struct Event {
        var id: String
        var pubkey: String
        var createdAt: Int
        var kind: Int
        var tags: [[String]]
        var content: String
        var sig: String
    }

    /// Up to two days back, as NIP-59 asks. Never later than now: relays drop
    /// events from the future.
    static func backdated(now: Int = Int(Date().timeIntervalSince1970)) -> Int {
        now - Int.random(in: 0...172_800)
    }

    // MARK: The three events

    /// The whole wrap, ready to publish, or a throw. `payload` is the NUT-18
    /// payment JSON; `receiver` the 32-byte x-only key it is for.
    static func giftWrapped(payload: String, receiver: [UInt8],
                            now: Int = Int(Date().timeIntervalSince1970)) throws -> Event {
        let sealKey = try NostrCrypto.newKey()
        let sealPub = try NostrCrypto.publicKey(of: sealKey)
        let receiverHex = hex(receiver)

        // the rumor: unsigned, with its id, as NIP-59 states
        let rumor = Event(id: "", pubkey: hex(sealPub), createdAt: now, kind: 14,
                          tags: [["p", receiverHex]], content: payload, sig: "")
        let rumorJSON = json(withID(rumor))

        let toReceiver = try NostrCrypto.conversationKey(secret: sealKey, peer: receiver)
        let seal = try signed(Event(id: "", pubkey: hex(sealPub), createdAt: backdated(now: now), kind: 13,
                                    tags: [], content: NostrCrypto.encrypt(Array(rumorJSON.utf8),
                                                                           conversationKey: toReceiver),
                                    sig: ""), with: sealKey)

        let wrapKey = try NostrCrypto.newKey()
        let wrapPub = try NostrCrypto.publicKey(of: wrapKey)
        let fromWrap = try NostrCrypto.conversationKey(secret: wrapKey, peer: receiver)
        return try signed(Event(id: "", pubkey: hex(wrapPub), createdAt: backdated(now: now), kind: 1059,
                                tags: [["p", receiverHex]],
                                content: NostrCrypto.encrypt(Array(json(seal).utf8), conversationKey: fromWrap),
                                sig: ""), with: wrapKey)
    }

    /// The payment inside a gift wrap addressed to `secret`, or nil.
    ///
    /// The mirror of `giftWrapped`, and every check NIP-59 asks for. A relay
    /// hands out whatever it likes, so nothing here is taken on trust:
    ///
    ///   - the wrap's own signature, over its own id;
    ///   - the seal's signature, by the key the seal names;
    ///   - the rumor naming that same seal key as its author, which is what
    ///     stops a relay (or anybody) re-sealing somebody else's rumor and
    ///     passing it off as theirs;
    ///   - both ids recomputed from the canonical form rather than believed.
    ///
    /// The wrap and seal times are meaningless by design (`backdated`), so
    /// nothing here reads them. Only the rumor's is real, and only the
    /// receiver sees it.
    static func unwrap(_ wrap: Event, to secret: [UInt8]) -> Event? {
        guard wrap.kind == 1059, verified(wrap) else { return nil }
        guard let sealJSON = decryptFrom(wrap.pubkey, wrap.content, to: secret),
              let seal = parse(sealJSON), seal.kind == 13, verified(seal) else { return nil }
        guard let rumorJSON = decryptFrom(seal.pubkey, seal.content, to: secret),
              let rumor = parse(rumorJSON), rumor.kind == 14,
              rumor.pubkey == seal.pubkey,           // the seal may only carry its own author's rumor
              withID(rumor).id == rumor.id else { return nil }
        return rumor
    }

    /// NIP-44 decrypt of `content` sent by `fromPubkey` (hex x-only) to us.
    private static func decryptFrom(_ fromPubkey: String, _ content: String, to secret: [UInt8]) -> String? {
        let peer = bytes(fromPubkey)
        guard peer.count == 32,
              let key = try? NostrCrypto.conversationKey(secret: secret, peer: peer),
              let plain = NostrCrypto.decrypt(content, conversationKey: key) else { return nil }
        return String(bytes: plain, encoding: .utf8)
    }

    /// The event's own signature over its own recomputed id.
    static func verified(_ event: Event) -> Bool {
        let key = bytes(event.pubkey), sig = bytes(event.sig)
        guard key.count == 32, sig.count == 64, withID(event).id == event.id else { return false }
        return NostrCrypto.verify(sig, digest: bytes(event.id), pubkey: key)
    }

    /// An event as a relay sends it. Read with JSONSerialization and written
    /// back out by `canonical` when an id is checked, so the escaping the
    /// writer above is careful about is applied to the read side too.
    static func parse(_ text: String) -> Event? {
        guard let data = text.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = o["id"] as? String, let pubkey = o["pubkey"] as? String,
              let kind = (o["kind"] as? NSNumber)?.intValue,
              let createdAt = (o["created_at"] as? NSNumber)?.intValue,
              let content = o["content"] as? String else { return nil }
        let tags = (o["tags"] as? [[Any]] ?? []).map { $0.compactMap { $0 as? String } }
        return Event(id: id, pubkey: pubkey, createdAt: createdAt, kind: kind,
                     tags: tags, content: content, sig: o["sig"] as? String ?? "")
    }

    /// The event with its id filled in: sha256 of the canonical array.
    static func withID(_ event: Event) -> Event {
        var out = event
        out.id = hex([UInt8](SHA256.hash(data: Data(canonical(event).utf8))))
        return out
    }

    static func signed(_ event: Event, with secret: [UInt8]) throws -> Event {
        var out = withID(event)
        out.sig = hex(try NostrCrypto.sign(digest: bytes(out.id), with: secret))
        return out
    }

    // MARK: JSON, written here

    /// What an event's id is taken over (NIP-01): a compact array, no spaces.
    static func canonical(_ event: Event) -> String {
        "[0,\"\(event.pubkey)\",\(event.createdAt),\(event.kind),\(tagsJSON(event.tags)),\(string(event.content))]"
    }

    /// The event as a relay takes it. A rumor is written without `sig`: it is
    /// not signed, and NIP-59 says so.
    ///
    /// Written by hand rather than with JSONSerialization, which escapes "/" as
    /// "\\/": a mint URL in the payment would then be hashed one way here and
    /// read another way by the receiver, and every id would be wrong.
    static func json(_ event: Event) -> String {
        "{\"id\":\"\(event.id)\",\"pubkey\":\"\(event.pubkey)\",\"created_at\":\(event.createdAt),"
            + "\"kind\":\(event.kind),\"tags\":\(tagsJSON(event.tags)),\"content\":\(string(event.content))"
            + (event.sig.isEmpty ? "" : ",\"sig\":\"\(event.sig)\"") + "}"
    }

    static func tagsJSON(_ tags: [[String]]) -> String {
        "[" + tags.map { "[" + $0.map(string).joined(separator: ",") + "]" }.joined(separator: ",") + "]"
    }

    /// A JSON string as NIP-01 asks: the six named escapes, and \\u00xx for the
    /// other control characters, with everything else left as it is.
    static func string(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    // MARK: Bytes

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func bytes(_ hex: String) -> [UInt8] {
        var out = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return [] }
            out.append(byte)
            index = next
        }
        return out
    }
}

/// bech32, for the `nprofile` (NIP-19) at both ends: reading the one a payment
/// request names, and writing the one Foxy's own request carries.
enum Bech32 {
    private static let alphabet = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")

    /// The data part of a bech32 string, as bytes, with its prefix. nil when the
    /// checksum, the characters or the case do not hold up. NIP-19 lifts
    /// bech32's 90-character limit, so length is not checked here.
    static func decode(_ text: String) -> (prefix: String, data: [UInt8])? {
        let lower = text.lowercased()
        guard lower == text || text.uppercased() == text, lower.count >= 8, lower.count <= 5000,
              let split = lower.lastIndex(of: "1"), split > lower.startIndex else { return nil }
        let prefix = String(lower[lower.startIndex..<split])
        let body = lower[lower.index(after: split)...]
        var values = [UInt8]()
        for character in body {
            guard let at = alphabet.firstIndex(of: character) else { return nil }
            values.append(UInt8(at))
        }
        guard values.count > 6, verify(prefix: prefix, values: values) else { return nil }
        return (prefix, bits(Array(values[0..<(values.count - 6)])))
    }

    /// The TLVs of an nprofile: type 0 the 32-byte key, type 1 a relay. Unknown
    /// types are skipped, as NIP-19 says.
    static func nprofile(_ text: String) -> (pubkey: [UInt8], relays: [String])? {
        guard let (prefix, data) = decode(text), prefix == "nprofile" else { return nil }
        var pubkey: [UInt8]?
        var relays = [String]()
        var at = 0
        while at + 2 <= data.count {
            let type = data[at]
            let length = Int(data[at + 1])
            guard at + 2 + length <= data.count else { return nil }
            let value = Array(data[(at + 2)..<(at + 2 + length)])
            if type == 0, length == 32 { pubkey = value }
            if type == 1, let url = String(bytes: value, encoding: .utf8) { relays.append(url) }
            at += 2 + length
        }
        guard let pubkey else { return nil }
        return (pubkey, relays)
    }

    /// An `nprofile` naming `pubkey` and the relays it is listened on.
    static func nprofile(pubkey: [UInt8], relays: [String]) -> String? {
        guard pubkey.count == 32 else { return nil }
        var tlv: [UInt8] = [0, 32] + pubkey
        for relay in relays {
            let value = Array(relay.utf8)
            guard value.count <= 255 else { continue }
            tlv += [1, UInt8(value.count)] + value
        }
        return encode(prefix: "nprofile", data: tlv)
    }

    static func encode(prefix: String, data: [UInt8]) -> String? {
        guard !prefix.isEmpty, prefix.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else { return nil }
        let values = fiveBit(data)
        let sum = checksum(prefix: prefix, values: values)
        return prefix + "1" + (values + sum).map { String(alphabet[Int($0)]) }.joined()
    }

    /// Eight-bit bytes to five-bit groups, the last one zero-padded — the
    /// inverse of `bits`.
    private static func fiveBit(_ data: [UInt8]) -> [UInt8] {
        var out = [UInt8]()
        var accumulator = 0
        var held = 0
        for byte in data {
            accumulator = (accumulator << 8) | Int(byte)
            held += 8
            while held >= 5 {
                held -= 5
                out.append(UInt8((accumulator >> held) & 31))
            }
        }
        if held > 0 { out.append(UInt8((accumulator << (5 - held)) & 31)) }
        return out
    }

    private static func checksum(prefix: String, values: [UInt8]) -> [UInt8] {
        var expanded = prefix.unicodeScalars.map { UInt8($0.value >> 5) }
        expanded.append(0)
        expanded += prefix.unicodeScalars.map { UInt8($0.value & 31) }
        let polynomial = polymod(expanded + values + [0, 0, 0, 0, 0, 0]) ^ 1
        return (0..<6).map { UInt8((polynomial >> (5 * (5 - UInt32($0)))) & 31) }
    }

    private static func bits(_ values: [UInt8]) -> [UInt8] {
        var out = [UInt8]()
        var accumulator = 0
        var held = 0
        for value in values {
            accumulator = (accumulator << 5) | Int(value)
            held += 5
            while held >= 8 {
                held -= 8
                out.append(UInt8((accumulator >> held) & 0xFF))
            }
        }
        return out
    }

    private static func verify(prefix: String, values: [UInt8]) -> Bool {
        var expanded = prefix.unicodeScalars.map { UInt8($0.value >> 5) }
        expanded.append(0)
        expanded += prefix.unicodeScalars.map { UInt8($0.value & 31) }
        return polymod(expanded + values) == 1
    }

    private static func polymod(_ values: [UInt8]) -> UInt32 {
        let generator: [UInt32] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3]
        var check: UInt32 = 1
        for value in values {
            let top = check >> 25
            check = (check & 0x1ff_ffff) << 5 ^ UInt32(value)
            for i in 0..<5 where (top >> UInt32(i)) & 1 == 1 { check ^= generator[i] }
        }
        return check
    }
}
