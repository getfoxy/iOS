import Foundation
import CryptoKit

/// Animated QR codes: a token too long for one code, shown as a loop of frames.
///
/// cashu.me does this with Blockchain Commons' Uniform Resources (UR): the
/// token's bytes are wrapped as CBOR, cut into fragments and sent as a fountain
/// code, one frame per QR code, `ur:bytes/<n>-<count>/<bytewords>`. The first
/// `count` frames are the fragments themselves; every frame after that is a
/// random mix of several, XORed together, so the loop can be joined at any
/// point and a missed frame is made up by later ones. A token short enough for
/// one frame is `ur:bytes/<bytewords>`.
///
/// Written here from what cashu.me runs, `@gandlaf21/bc-ur` 1.1.12, rather than
/// bundled: its frames, made by that library, are the test vectors
/// (tests/vectors/animated-qr.json, FoxyTests/AnimatedQRTests.swift). Which
/// fragments a mixed frame holds comes from a random generator seeded by the
/// frame's number and the message checksum, and has to match the encoder's
/// exactly, down to how bignumber.js rounds a division.
///
/// The frames come from whatever QR code is in front of the camera, so nothing
/// in them is trusted: a message over 100 kB, over 2,000 fragments or with
/// fragments of different sizes is refused, a message is kept only if its
/// CRC-32 matches, and only `ur:bytes` that decodes to UTF-8 text is handed on.
/// What comes out is the text a single QR code would have held; the page
/// decides what it is, as for any scan.
final class AnimatedQRReader {

    enum Step: Equatable {
        /// Not an animated code: the scanner handles it as before.
        case notAnimated
        /// A frame was taken; this share of the fragments is in hand.
        case progress(Double)
        /// The whole message.
        case done(String)
        /// Nothing usable: a frame that does not read before any frame has, or
        /// a whole message that fails its checksum (the reader starts over).
        /// A bad frame once a message is under way is skipped, not this.
        case rejected
    }

    static let maxMessageBytes = 100_000
    static let maxFragments = 2_000
    static let maxFragmentBytes = 10_000

    private var seqLength = 0
    private var messageLength = 0
    private var checksum: UInt32 = 0
    private var fragmentLength = 0
    private var simple: [Int: [UInt8]] = [:]
    private var mixed: [(Set<Int>, [UInt8])] = []
    private var queue: [(Set<Int>, [UInt8])] = []
    private var seen = Set<String>()
    private var finished: String?

    func reset() {
        seqLength = 0; messageLength = 0; checksum = 0; fragmentLength = 0
        simple = [:]; mixed = []; queue = []; seen = []; finished = nil
    }

    /// The share of fragments in hand, 0 before the first frame.
    var progress: Double {
        seqLength == 0 ? 0 : min(0.99, Double(simple.count) / Double(seqLength))
    }

    func receive(_ scanned: String) -> Step {
        let text = scanned.lowercased()
        guard text.hasPrefix("ur:") else { return .notAnimated }
        if let finished { return .done(finished) }
        // the camera reports the frame on screen many times a second
        if seen.contains(text) { return .progress(progress) }
        if seen.count > 4 * Self.maxFragments { seen.removeAll() }
        seen.insert(text)

        let parts = text.dropFirst(3).split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 || parts.count == 3, parts[0] == "bytes" else { return skip() }

        if parts.count == 2 {
            guard let cbor = Bytewords.decodeMinimal(parts[1]), let token = Self.text(fromCBOR: cbor) else { return skip() }
            finished = token
            return .done(token)
        }

        guard let (seqNum, count) = Self.sequence(parts[1]),
              let payload = Bytewords.decodeMinimal(parts[2]),
              let frame = MiniCBOR.fountainPart(payload),
              frame.seqNum == seqNum, frame.seqLength == count
        else { return skip() }

        guard frame.seqLength >= 1, frame.seqLength <= Self.maxFragments,
              frame.messageLength >= 1, frame.messageLength <= Self.maxMessageBytes,
              !frame.fragment.isEmpty, frame.fragment.count <= Self.maxFragmentBytes,
              frame.fragment.count * frame.seqLength >= frame.messageLength,
              frame.fragment.count * (frame.seqLength - 1) < frame.messageLength
        else { return skip() }

        if seqLength == 0 {
            seqLength = frame.seqLength
            messageLength = frame.messageLength
            checksum = frame.checksum
            fragmentLength = frame.fragment.count
        } else if frame.seqLength != seqLength || frame.messageLength != messageLength
                    || frame.checksum != checksum || frame.fragment.count != fragmentLength {
            // another animated code in front of the camera: start on that one
            let keep = text
            reset()
            seen.insert(keep)
            seqLength = frame.seqLength
            messageLength = frame.messageLength
            checksum = frame.checksum
            fragmentLength = frame.fragment.count
        }

        let indexes = Fountain.chooseFragments(seqNum: frame.seqNum, seqLength: seqLength, checksum: checksum)
        queue.append((Set(indexes), frame.fragment))
        while finished == nil, !queue.isEmpty {
            let (i, f) = queue.removeFirst()
            if !process(i, f) { return reject() }
        }
        if let finished { return .done(finished) }
        return .progress(progress)
    }

    private func reject() -> Step {
        reset()
        return .rejected
    }

    /// A frame that does not read: a misread one should not cost the frames
    /// already in hand. Rejected only when there are none.
    private func skip() -> Step {
        seqLength == 0 ? .rejected : .progress(progress)
    }

    /// Peel one part: take out the fragments already known, keep what is left.
    /// False when the message is complete and does not check out.
    private func process(_ given: Set<Int>, _ bytes: [UInt8]) -> Bool {
        var indexes = given
        var fragment = bytes
        for i in indexes {
            if let known = simple[i] {
                Self.xor(&fragment, known)
                indexes.remove(i)
            }
        }
        if indexes.isEmpty { return true }

        if indexes.count == 1, let i = indexes.first {
            simple[i] = fragment
            if simple.count == seqLength { return assemble() }
            var left: [(Set<Int>, [UInt8])] = []
            for (mi, mf) in mixed {
                guard mi.contains(i) else { left.append((mi, mf)); continue }
                var nf = mf
                Self.xor(&nf, fragment)
                let ni = mi.subtracting([i])
                if ni.count == 1 { queue.append((ni, nf)) } else if !ni.isEmpty { left.append((ni, nf)) }
            }
            mixed = left
            return true
        }

        if mixed.contains(where: { $0.0 == indexes }) { return true }
        for (mi, mf) in mixed where mi.isStrictSubset(of: indexes) {
            Self.xor(&fragment, mf)
            indexes.subtract(mi)
        }
        if indexes.count == 1 { queue.append((indexes, fragment)); return true }
        if indexes.isEmpty { return true }
        var left: [(Set<Int>, [UInt8])] = []
        for (mi, mf) in mixed {
            guard indexes.isStrictSubset(of: mi) else { left.append((mi, mf)); continue }
            var nf = mf
            Self.xor(&nf, fragment)
            let ni = mi.subtracting(indexes)
            if ni.count == 1 { queue.append((ni, nf)) } else { left.append((ni, nf)) }
        }
        left.append((indexes, fragment))
        // a stream of frames that never resolve cannot grow this without end
        if left.count > 4 * seqLength + 64 { left.removeFirst(left.count - (4 * seqLength + 64)) }
        mixed = left
        return true
    }

    private func assemble() -> Bool {
        var message: [UInt8] = []
        message.reserveCapacity(seqLength * fragmentLength)
        for i in 0..<seqLength {
            guard let f = simple[i] else { return false }
            message.append(contentsOf: f)
        }
        message = Array(message.prefix(messageLength))
        guard CRC32.checksum(message) == checksum, let token = Self.text(fromCBOR: message) else { return false }
        finished = token
        return true
    }

    private static func xor(_ a: inout [UInt8], _ b: [UInt8]) {
        for k in 0..<min(a.count, b.count) { a[k] ^= b[k] }
    }

    /// "n-count", both positive; n wraps to 32 bits, as the encoder's does.
    static func sequence(_ s: String) -> (UInt32, Int)? {
        let bits = s.split(separator: "-", omittingEmptySubsequences: false)
        guard bits.count == 2, !bits[0].isEmpty, !bits[1].isEmpty, bits[0].count <= 10, bits[1].count <= 6,
              bits[0].allSatisfy(\.isASCII), bits[0].allSatisfy(\.isNumber), bits[1].allSatisfy(\.isASCII), bits[1].allSatisfy(\.isNumber),
              let n = UInt64(bits[0]), let count = Int(bits[1]), n >= 1, count >= 1
        else { return nil }
        return (UInt32(truncatingIfNeeded: n), count)
    }

    /// The UR's CBOR: one byte string, read as UTF-8 text.
    static func text(fromCBOR cbor: [UInt8]) -> String? {
        var reader = MiniCBOR(cbor)
        guard let bytes = reader.byteString(), reader.atEnd, !bytes.isEmpty else { return nil }
        return String(bytes: bytes, encoding: .utf8)
    }
}

// MARK: - bytewords (BCR-2020-012), minimal style

enum Bytewords {
    static let words = "ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom"

    /// First and last letter of each word, 26 × 26, to its byte; -1 for none.
    private static let table: [Int] = {
        var t = [Int](repeating: -1, count: 26 * 26)
        let letters = Array(words.utf8)
        for i in 0..<256 {
            let first = Int(letters[i * 4]) - 97, last = Int(letters[i * 4 + 3]) - 97
            t[last * 26 + first] = i
        }
        return t
    }()

    /// Two letters a byte, then a CRC-32 of the rest in the last four bytes.
    static func decodeMinimal(_ s: String) -> [UInt8]? {
        let letters = Array(s.utf8)
        guard letters.count % 2 == 0, letters.count >= 10, letters.count <= 2 * (AnimatedQRReader.maxFragmentBytes + 64) else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(letters.count / 2)
        var k = 0
        while k < letters.count {
            let x = Int(letters[k]) - 97, y = Int(letters[k + 1]) - 97
            guard (0..<26).contains(x), (0..<26).contains(y) else { return nil }
            let v = table[y * 26 + x]
            guard v >= 0 else { return nil }
            out.append(UInt8(v))
            k += 2
        }
        let body = Array(out.dropLast(4))
        let sum = out.suffix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return CRC32.checksum(body) == sum ? body : nil
    }
}

// MARK: - CRC-32 (IEEE)

enum CRC32 {
    private static let table: [UInt32] = (0..<256).map { n in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
        return c
    }

    static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for b in bytes { crc = (crc >> 8) ^ table[Int((crc ^ UInt32(b)) & 0xFF)] }
        return crc ^ 0xFFFF_FFFF
    }
}

// MARK: - the little CBOR a UR frame uses

struct MiniCBOR {
    private let bytes: [UInt8]
    private var at = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    var atEnd: Bool { at == bytes.count }

    struct FountainFrame {
        let seqNum: UInt32
        let seqLength: Int
        let messageLength: Int
        let checksum: UInt32
        let fragment: [UInt8]
    }

    /// [seqNum, seqLength, messageLength, checksum, fragment]
    static func fountainPart(_ payload: [UInt8]) -> FountainFrame? {
        var r = MiniCBOR(payload)
        guard r.arrayHeader() == 5,
              let seqNum = r.unsigned(), seqNum <= UInt64(UInt32.max),
              let seqLength = r.unsigned(), seqLength <= UInt64(Int32.max),
              let messageLength = r.unsigned(), messageLength <= UInt64(Int32.max),
              let checksum = r.unsigned(), checksum <= UInt64(UInt32.max),
              let fragment = r.byteString(), r.atEnd
        else { return nil }
        return FountainFrame(seqNum: UInt32(seqNum), seqLength: Int(seqLength), messageLength: Int(messageLength),
                             checksum: UInt32(checksum), fragment: fragment)
    }

    /// A major type and its argument; definite lengths only.
    private mutating func head() -> (UInt8, UInt64)? {
        guard at < bytes.count else { return nil }
        let first = bytes[at]
        at += 1
        let major = first >> 5, info = first & 0x1F
        let size: Int
        switch info {
        case 0..<24: return (major, UInt64(info))
        case 24: size = 1
        case 25: size = 2
        case 26: size = 4
        case 27: size = 8
        default: return nil
        }
        guard bytes.count - at >= size else { return nil }
        var v: UInt64 = 0
        for _ in 0..<size { v = (v << 8) | UInt64(bytes[at]); at += 1 }
        return (major, v)
    }

    mutating func unsigned() -> UInt64? {
        guard let (major, v) = head(), major == 0 else { return nil }
        return v
    }

    mutating func arrayHeader() -> UInt64? {
        guard let (major, v) = head(), major == 4 else { return nil }
        return v
    }

    mutating func byteString() -> [UInt8]? {
        guard let (major, v) = head(), major == 2, v <= UInt64(bytes.count - at) else { return nil }
        let n = Int(v)
        defer { at += n }
        return Array(bytes[at..<(at + n)])
    }
}

// MARK: - which fragments a frame mixes

enum Fountain {
    /// Frames 1…count are fragment n−1; later ones mix a random set, chosen as
    /// the encoder chose it.
    static func chooseFragments(seqNum: UInt32, seqLength: Int, checksum: UInt32) -> [Int] {
        if Int(seqNum) <= seqLength { return [Int(seqNum) - 1] }
        var seed = [UInt8]()
        for v in [seqNum, checksum] { seed += [UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)] }
        var rng = Xoshiro(seed: seed)
        let degree = min(seqLength, max(1, chooseDegree(seqLength, &rng)))
        // the encoder shuffles every index; only the first `degree` are used,
        // and nothing after them draws on the generator
        var remaining = Array(0..<seqLength)
        var picked: [Int] = []
        while picked.count < degree, !remaining.isEmpty {
            let k = min(remaining.count - 1, rng.nextInt(0, remaining.count - 1))
            picked.append(remaining.remove(at: k))
        }
        return picked
    }

    /// Degree d with weight 1/d, by the Walker–Vose alias table
    /// @apocentre/alias-sampling 0.5.3 builds, in its order.
    static func chooseDegree(_ n: Int, _ rng: inout Xoshiro) -> Int {
        let t = aliasTable(n)
        let c = Int((rng.nextDouble() * Double(n)).rounded(.down))
        guard c >= 0, c < n else { return 1 }
        let pick = rng.nextDouble() < t.prob[c] ? c : (t.alias[c] ?? c)
        return pick + 1
    }

    private static var aliasCache: [Int: (prob: [Double], alias: [Int?])] = [:]
    private static let aliasLock = NSLock()

    static func aliasTable(_ n: Int) -> (prob: [Double], alias: [Int?]) {
        aliasLock.lock(); defer { aliasLock.unlock() }
        if let t = aliasCache[n] { return t }
        var p = [Double](repeating: 0, count: n)
        var sum = 0.0
        for i in 0..<n { p[i] = 1.0 / Double(i + 1); sum += p[i] }
        var P = [Double](repeating: 0, count: n)
        for i in 0..<n { P[i] = p[i] * Double(n) / sum }
        var small: [Int] = [], large: [Int] = []
        for i in stride(from: n - 1, through: 0, by: -1) {
            if P[i] < 1 { small.append(i) } else { large.append(i) }
        }
        var prob = [Double](repeating: 0, count: n)
        var alias = [Int?](repeating: nil, count: n)
        while !small.isEmpty, !large.isEmpty {
            let a = small.removeLast(), g = large.removeLast()
            prob[a] = P[a]
            alias[a] = g
            P[g] = P[g] + P[a] - 1
            if P[g] < 1 { small.append(g) } else { large.append(g) }
        }
        while let l = large.popLast() { prob[l] = 1 }
        while let s = small.popLast() { prob[s] = 1 }
        if aliasCache.count > 16 { aliasCache.removeAll() }
        aliasCache[n] = (prob, alias)
        return (prob, alias)
    }
}

/// xoshiro256**, seeded from SHA-256, as the encoder's.
struct Xoshiro {
    private var s: [UInt64] = [0, 0, 0, 0]

    init(seed: [UInt8]) {
        let digest = Array(SHA256.hash(data: Data(seed)))
        for i in 0..<4 {
            var v: UInt64 = 0
            for n in 0..<8 { v = (v << 8) | UInt64(digest[i * 8 + n]) }
            s[i] = v
        }
    }

    private static func rotl(_ x: UInt64, _ k: UInt64) -> UInt64 { (x << k) | (x >> (64 - k)) }

    mutating func next() -> UInt64 {
        let result = Self.rotl(s[1] &* 5, 7) &* 9
        let t = s[1] << 17
        s[2] ^= s[0]
        s[3] ^= s[1]
        s[1] ^= s[2]
        s[0] ^= s[3]
        s[2] ^= t
        s[3] = Self.rotl(s[3], 45)
        return result
    }

    /// next() / 2^64 as bignumber.js 9 divides it by default: rounded half up
    /// to 20 decimal places, then read as a double.
    mutating func nextDouble() -> Double { Self.bigNumberFraction(next()) }

    mutating func nextInt(_ low: Int, _ high: Int) -> Int {
        Int((nextDouble() * Double(high - low + 1) + Double(low)).rounded(.down))
    }

    static func bigNumberFraction(_ x: UInt64) -> Double {
        let ten10: UInt64 = 10_000_000_000
        // x × 10^20 in three 64-bit limbs
        let a = x.multipliedFullWidth(by: ten10)
        let b = a.low.multipliedFullWidth(by: ten10)
        let c = a.high.multipliedFullWidth(by: ten10)
        var l0 = b.low
        var (l1, o1) = c.low.addingReportingOverflow(b.high)
        var l2 = c.high &+ (o1 ? 1 : 0)
        // + 2^63, then the top two limbs are the quotient by 2^64: half up
        let (n0, o0) = l0.addingReportingOverflow(1 << 63)
        l0 = n0
        if o0 {
            let (n1, o) = l1.addingReportingOverflow(1)
            l1 = n1
            if o { l2 &+= 1 }
        }
        // digits of l2·2^64 + l1, at most 10^20
        var hi = l2, lo = l1
        var digits: [UInt8] = []
        repeat {
            let rh = hi % 10
            hi /= 10
            let (q, r) = ten.dividingFullWidth((high: rh, low: lo))
            lo = q
            digits.append(UInt8(r) + 48)
        } while hi != 0 || lo != 0
        while digits.count < 21 { digits.append(48) }
        digits.reverse()
        // 21 digits: the integer part (0 or 1) and 20 decimals
        let text = String(decoding: [digits[0], 46] + digits[1...], as: UTF8.self)
        return Double(text) ?? 0
    }

    private static let ten: UInt64 = 10
}
