import Foundation
import Security

/// How far restoreSecrets may reach, apart from everything else so FoxyTests can
/// hold the rules.
///
/// A page that can ask for any counter's secrets can ask for tomorrow's, and a
/// script that got into the page could keep them and spend what they receive.
/// So a restore of the saved seed reaches only as far as NUT-13's own scan does:
/// ten empty batches of 100 past the highest counter handed out. It was three:
/// a swap now hands back up to sixty shaped pieces, so a run of refused or
/// lost swaps burns counters ten times faster, and a gap of three hundred was
/// within reach of five such failures in a row.
enum RestoreWindow {
    static let beyond: UInt64 = 1000
    /// The most counters of one keyset a candidate's words are derived for.
    static let candidateCap: UInt64 = 20_000

    /// The saved seed: the range ends at most 1000 past the keyset's next counter.
    static func savedSeedAllowed(start: UInt64, count: Int, next: UInt64) -> Bool {
        guard count > 0 else { return false }
        let (end, overflow) = start.addingReportingOverflow(UInt64(count))
        guard !overflow else { return false }
        let (limit, past) = next.addingReportingOverflow(beyond)
        return past || end <= limit
    }

    /// What seedAdopt raises each counter to: 1000 short of the end the typed
    /// words were served, the end of a scan's last batch with a signature in it.
    static func adoptedCounters(_ servedEnds: [String: UInt64]) -> [String: UInt64] {
        servedEnds.mapValues { $0 > beyond ? $0 - beyond : 0 }
    }

    /// Typed words: scanned from 0, each request starting no more than 1000 past
    /// the furthest this candidate was served for the keyset, and none past 20,000.
    static func candidateAllowed(start: UInt64, count: Int, servedEnd: UInt64) -> Bool {
        guard count > 0 else { return false }
        let (end, overflow) = start.addingReportingOverflow(UInt64(count))
        return !overflow && end <= candidateCap && start <= servedEnd + beyond
    }
}

/// Words typed on the native restore screen (seedEnter), held natively under an
/// opaque id so the page can scan with them and adopt them without ever reading
/// them.
///
/// At most two at a time. They go when forgotten, and wherever the seed kept for
/// secrets goes (SeedVault): the unlock forgotten, the page gone or loaded again,
/// Foxy in the background, and any write or delete of the seed. A candidate that
/// seedAdopt has just written stays through that write, so the page's scans
/// still in flight with it can finish (review M6); it goes at the
/// next of those moments.
///
/// Served ranges are kept per derivation path (CounterRules.slot), so a second
/// `00` id with the same index continues the first's window, not a new one.
final class SeedCandidates {
    static let shared = SeedCandidates()
    static let most = 2

    enum Failure: Error, Equatable {
        case full
        case unknown
        case outsideWindow
        /// Served for more keysets than the counter file holds.
        case tooManyKeysets
        /// Not words NUT13.seed takes. seedEnter checks the phrase first, so not expected.
        case notAPhrase
        case platform
    }

    private final class Candidate {
        /// UTF-8, wiped when the candidate goes. The Strings made from it for a
        /// seed or a write cannot be wiped; this copy can.
        var words: [UInt8]
        var seed: NUT13.Seed?
        /// Per slot, the first id served and the end of the furthest range served.
        var served: [String: (id: String, end: UInt64)] = [:]

        init(words: [UInt8]) {
            self.words = words
        }

        deinit {
            NUT13.wipe(&words)
        }
    }

    private var held: [String: Candidate] = [:]
    private let lock = NSLock()

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return held.count
    }

    func contains(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return held[id] != nil
    }

    /// Keeps a checked phrase and returns its id.
    func add(_ phrase: String) throws -> String {
        let id = try Self.newId()
        lock.lock(); defer { lock.unlock() }
        guard held.count < Self.most else { throw Failure.full }
        held[id] = Candidate(words: Array(phrase.utf8))
        return id
    }

    /// The words, for seedAdopt's write.
    func phrase(_ id: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return held[id].map { String(decoding: $0.words, as: UTF8.self) }
    }

    /// The BIP-39 seed of the words, made once.
    func seed(_ id: String) throws -> NUT13.Seed {
        lock.lock(); defer { lock.unlock() }
        guard let candidate = held[id] else { throw Failure.unknown }
        return try seedOf(candidate)
    }

    /// The seed for one restoreSecrets range, if the window allows it; the
    /// range then counts as served.
    func serve(_ id: String, keysetId: String, start: UInt64, count: Int) throws -> NUT13.Seed {
        lock.lock(); defer { lock.unlock() }
        guard let candidate = held[id] else { throw Failure.unknown }
        guard let slot = CounterRules.slot(keysetId) else { throw Failure.outsideWindow }
        let held = candidate.served[slot]
        guard held != nil || candidate.served.count < CounterRules.mostKeysets else { throw Failure.tooManyKeysets }
        let served = held?.end ?? 0
        guard RestoreWindow.candidateAllowed(start: start, count: count, servedEnd: served) else { throw Failure.outsideWindow }
        let seed = try seedOf(candidate)
        candidate.served[slot] = (held?.id ?? keysetId.lowercased(), max(served, start + UInt64(count)))
        return seed
    }

    /// Per keyset served (the first id served for each derivation path), the
    /// end of the furthest range: what seedAdopt raises the counters to.
    func servedEnds(_ id: String) -> [String: UInt64] {
        lock.lock(); defer { lock.unlock() }
        guard let candidate = held[id] else { return [:] }
        var out: [String: UInt64] = [:]
        for (_, entry) in candidate.served { out[entry.id] = entry.end }
        return out
    }

    func forget(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        held[id] = nil
    }

    /// Every candidate but `kept`, which a seed write has just adopted.
    func forgetAll(except kept: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        held = held.filter { $0.key == kept }
    }

    /// Lock held.
    private func seedOf(_ candidate: Candidate) throws -> NUT13.Seed {
        if let seed = candidate.seed { return seed }
        guard let seed = try? NUT13.seed(mnemonic: String(decoding: candidate.words, as: UTF8.self)) else {
            throw Failure.notAPhrase
        }
        candidate.seed = seed
        return seed
    }

    /// 128 random bits as 32 hex digits: an id the page can use, not guess.
    static func newId() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.platform }
        return NUT13.hex(bytes)
    }
}

extension NUT13.Seed {
    /// The same 64 bytes, looking at every byte whatever it finds.
    func sameBytes(as other: NUT13.Seed) -> Bool {
        key.withUnsafeBytes { a in
            other.key.withUnsafeBytes { b in
                guard a.count == b.count else { return false }
                var difference: UInt8 = 0
                for i in 0..<a.count { difference |= a[i] ^ b[i] }
                return difference == 0
            }
        }
    }
}
