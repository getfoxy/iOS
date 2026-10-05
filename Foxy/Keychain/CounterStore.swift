import Foundation

/// The NUT-13 counters, kept by native in every build: per keyset, the next
/// counter a secret is derived from. A new install, or one from before stage 4,
/// has no file: the store starts empty, the page's counters come across once
/// with countersImport, and the first write makes the folder and the file.
///
/// A counter handed out twice makes outputs the mint has already signed, and
/// secrets a page could use twice. So a counter only moves forward, and no range
/// is handed out until the file that records it has been written.
///
/// One JSON file, `Application Support/foxy-counters.json`, `{keysetId: next}`:
/// - one entry per derivation path (CounterRules): a `00` keyset's entry is
///   keyed by the first id stored for its derivation index, and every id with
///   that index reaches it; a `01` keyset's by its id. A file from before, with
///   two ids of one index, is merged at the larger value when it is read;
/// - at most 256 keysets;
/// - written whole to a temporary file beside it, flushed to the disk with
///   F_FULLFSYNC, then renamed over it, so a crash or a power loss leaves the old
///   file or the new one, never half of one and never an older one;
/// - protected `completeUntilFirstUserAuthentication`: unreadable from a phone
///   that has not been unlocked since it started, readable after, so a payment
///   finishing while the phone locks still gets its counters;
/// - excluded from backups, set again after every write, because the renamed
///   file is a new file and would not keep the old one's exclusion.
///
/// Moves are capped (CounterRules): counterAdvance goes at most 100 past the
/// counter, or to the end of what a restore served this process; counterReserveAt
/// starts at most 100 past it; countersImport answers once per install.
///
/// The counters belong to the seed in use. When that seed is replaced or wiped
/// the file is moved aside, to `foxy-counters.replaced.<unix time>.json`, and the
/// store starts empty: the old seed's counters carried into a new seed would
/// leave gaps a restore in another wallet gives up at.
///
/// **A second file, `foxy-p2pk.json`, `{"next": n}`**: the next index a payment
/// request's lock key is derived from (P2PK.swift). It is written the same way
/// — whole, flushed, renamed — and moved aside with the counters when the seed
/// changes.
///
/// It is a file of its own and not an entry in `foxy-counters.json`, and that is
/// deliberate. `parse` refuses the whole counter file when any key is not a
/// keyset id, because dropping an entry it did not understand would take that
/// keyset back to zero. An older Foxy installed over this one would find a
/// `"p2pk"` key there, refuse the file, and hand out no counter at all — the
/// wallet would stop making outputs. A file it has never heard of it simply does
/// not open.
final class CounterStore {
    enum Failure: Error, Equatable {
        /// The file is there and could not be read, or is not a counter list.
        /// Nothing is handed out: starting from zero would reuse counters.
        case unreadable
        case unwritable
        /// counterReserveAt below the keyset's next counter.
        case alreadyIssued
        /// Past the keyset version's last counter.
        case outOfRange
        /// counterAdvance or counterReserveAt past what CounterRules allows.
        case tooFarAhead
        /// A 257th keyset.
        case tooManyKeysets
        /// countersImport a second time on this install.
        case alreadyImported

        var message: String {
            switch self {
            case .unreadable: return "the counters could not be read"
            case .unwritable: return "the counters could not be saved"
            case .alreadyIssued: return "range already issued"
            case .outOfRange: return "outside the keyset's counters"
            case .tooFarAhead: return "too far ahead"
            case .tooManyKeysets: return "too many keysets"
            case .alreadyImported: return "counters were already imported"
            }
        }
    }

    static let fileName = "foxy-counters.json"

    /// The lock-key index, in its own file for the reason the class comment gives.
    static let p2pkFileName = "foxy-p2pk.json"

    /// UserDefaults: countersImport has answered on this install. It goes with
    /// the app on an uninstall, as the counter file does.
    static let importedKey = "foxy.counters.imported"

    /// The largest `next` stored: one past a 01 keyset's last counter, 2^53 − 1.
    static let largestNext: UInt64 = 1 << 53

    static let shared = CounterStore(
        directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])

    let directory: URL
    var fileURL: URL { directory.appendingPathComponent(Self.fileName) }
    var p2pkURL: URL { directory.appendingPathComponent(Self.p2pkFileName) }

    private let now: () -> Date
    private let lock = NSLock()
    /// The file as last read or written; nil until the first request reads it.
    private var counters: [String: UInt64]?
    /// Per slot (CounterRules.slot), the end of the furthest range restoreSecrets
    /// served this process, for the saved seed or typed words. Memory only.
    private var served: [String: UInt64] = [:]
    /// `foxy-p2pk.json` as last read or written; nil until the first request reads it.
    private var p2pkStored: UInt64?
    /// The end of the furthest range p2pkPubkeys served this process. Memory only,
    /// like `served`, and for the same reason: it widens what may be asked for
    /// only while the app that did the asking is still running.
    private var p2pkServedEnd: UInt64 = 0

    /// `directory` and `now` are for FoxyTests; the app uses `shared`.
    init(directory: URL, now: @escaping () -> Date = Date.init) {
        self.directory = directory
        self.now = now
    }

    func snapshot() throws -> [String: UInt64] {
        try locked { try load() }
    }

    /// The counter of this id's entry: another id with the same derivation
    /// index reads the same one.
    func next(_ keysetId: String) throws -> UInt64 {
        try locked {
            let c = try load()
            return c[CounterRules.storedKey(keysetId, in: c.keys)] ?? 0
        }
    }

    /// The page's counters, when it moves them here: per keyset the larger of
    /// the two, so neither side's history is lowered, each cut to its version's
    /// last counter.
    func importMax(_ incoming: [String: UInt64]) throws -> [String: UInt64] {
        try locked {
            var c = try load()
            let before = c
            // sorted, so which of two aliases in one import is stored is not up to the dictionary
            for (id, value) in incoming.sorted(by: { $0.key < $1.key }) {
                guard let version = NUT13.keysetVersion(id) else { continue }
                let k = try key(id, in: c)
                c[k] = max(c[k] ?? 0, CounterRules.capped(value, version: version))
            }
            if c != before { try save(c) }
            return c
        }
    }

    /// countersImport: importMax, once per install. A failure (a file that
    /// cannot be read or saved) leaves the import still to do.
    func importOnce(_ incoming: [String: UInt64], defaults: UserDefaults) throws -> [String: UInt64] {
        guard !defaults.bool(forKey: Self.importedKey) else { throw Failure.alreadyImported }
        let merged = try importMax(incoming)
        defaults.set(true, forKey: Self.importedKey)
        return merged
    }

    /// Reserves `next ..< next + count` and returns its start. A count of 0 only
    /// reads `next`. The range is written before it is returned.
    func reserve(_ keysetId: String, version: UInt8, count: Int) throws -> UInt64 {
        try locked {
            var c = try load()
            let k = CounterRules.storedKey(keysetId, in: c.keys)
            let start = c[k] ?? 0
            guard count > 0 else { return start }
            guard NUT13.countersFit(version: version, start: start, count: count) else { throw Failure.outOfRange }
            let stored = try key(keysetId, in: c)
            c[stored] = start + UInt64(count)
            try save(c)
            return start
        }
    }

    /// Reserves `start ..< start + count`, burning every counter below `start`.
    /// A start below `next` has been handed out already and is refused, and one
    /// more than 100 past it is too far ahead.
    func reserve(_ keysetId: String, version: UInt8, at start: UInt64, count: Int) throws {
        try locked {
            var c = try load()
            let k = try key(keysetId, in: c)
            let current = c[k] ?? 0
            guard start >= current else { throw Failure.alreadyIssued }
            guard CounterRules.reserveAt(current: current, start: start) == .allowed else { throw Failure.tooFarAhead }
            guard count > 0, NUT13.countersFit(version: version, start: start, count: count) else { throw Failure.outOfRange }
            c[k] = start + UInt64(count)
            try save(c)
        }
    }

    /// Moves `next` up to `value`, never down, and returns what is stored. At
    /// most 100 past the counter, or to the end of what a restore served.
    func advance(_ keysetId: String, to value: UInt64) throws -> UInt64 {
        try locked {
            var c = try load()
            guard let version = NUT13.keysetVersion(keysetId), let slot = CounterRules.slot(keysetId) else {
                throw Failure.outOfRange
            }
            let found = CounterRules.storedKey(keysetId, in: c.keys)
            let current = c[found] ?? 0
            guard value > current else { return current }
            guard CounterRules.advance(current: current, next: value, highest: served[slot] ?? 0, version: version) == .allowed else {
                throw Failure.tooFarAhead
            }
            let k = try key(keysetId, in: c)
            c[k] = value
            try save(c)
            return value
        }
    }

    /// Typed words adopted, or found to be the saved seed (seedAdopt): each
    /// entry raised to at least the end served for its keyset, never lowered,
    /// cut to the version's last counter. One write for all of them.
    func raise(_ ends: [String: UInt64]) throws -> [String: UInt64] {
        try locked {
            var c = try load()
            let before = c
            for (id, end) in ends.sorted(by: { $0.key < $1.key }) {
                guard let version = NUT13.keysetVersion(id), end > 0 else { continue }
                let k = try key(id, in: c)
                c[k] = max(c[k] ?? 0, CounterRules.capped(end, version: version))
            }
            if c != before { try save(c) }
            return c
        }
    }

    /// restoreSecrets handed out `..< end` for this keyset's entry.
    func noteServed(_ keysetId: String, end: UInt64) {
        guard let slot = CounterRules.slot(keysetId) else { return }
        locked { served[slot] = max(served[slot] ?? 0, end) }
    }

    /// The end of the furthest range a restore served this keyset's entry this process.
    func highestServed(_ keysetId: String) -> UInt64 {
        guard let slot = CounterRules.slot(keysetId) else { return 0 }
        return locked { served[slot] ?? 0 }
    }

    // MARK: The lock-key index (P2PK.swift)

    /// The next index a payment request's lock key is derived from.
    func p2pkNext() throws -> UInt64 {
        try locked { try loadP2PK() }
    }

    /// Reserves `next ..< next + count` and returns its start, written before it
    /// is returned — the same rule the counters follow, for a weaker reason.
    ///
    /// An index handed out twice is not the disaster a counter handed out twice
    /// is: two requests would carry the same lock, which links two payments to
    /// one another and is worth avoiding, but neither payment is lost. It is
    /// written first anyway, because a reservation the disk does not know about
    /// is exactly the kind of thing that is right until the day the app is
    /// killed mid-request.
    ///
    /// A count of 0 only reads `next`, and reads no seed.
    func p2pkReserve(count: Int) throws -> UInt64 {
        try locked {
            let start = try loadP2PK()
            guard count > 0 else { return start }
            guard P2PK.indicesFit(start: start, count: count) else { throw Failure.outOfRange }
            try saveP2PK(start + UInt64(count))
            return start
        }
    }

    /// p2pkPubkeys handed out `..< end`.
    func noteP2PKServed(end: UInt64) {
        locked { p2pkServedEnd = max(p2pkServedEnd, end) }
    }

    /// The end of the furthest range p2pkPubkeys served this process.
    func highestP2PKServed() -> UInt64 {
        locked { p2pkServedEnd }
    }

    // MARK: Set aside

    /// The seed changed: the files go aside, kept for manual recovery and read
    /// by nothing, and the store starts empty. A file that could not be read goes
    /// aside too: whatever seed it counted for, it is not the new one. Returns
    /// where the counter file went, or nil when there was none.
    ///
    /// Both files, under one stamp, so a seed's counters and its lock indices are
    /// recognisable afterwards as one pair.
    @discardableResult
    func moveAside() throws -> URL? {
        try locked {
            let fm = FileManager.default
            let hasCounters = fm.fileExists(atPath: fileURL.path)
            let hasIndex = fm.fileExists(atPath: p2pkURL.path)
            /* The served window is this app session's, and the session is now
             * looking at a different seed. Cleared whatever the moves do. */
            p2pkServedEnd = 0
            guard hasCounters || hasIndex else {
                counters = [:]
                p2pkStored = 0
                return nil
            }
            var stamp = Int(now().timeIntervalSince1970)
            while (hasCounters && fm.fileExists(atPath: Self.replacedURL(directory, stamp).path))
                || (hasIndex && fm.fileExists(atPath: Self.replacedP2PKURL(directory, stamp).path)) {
                stamp += 1
            }
            var moved: URL?
            if hasCounters {
                let target = Self.replacedURL(directory, stamp)
                do {
                    try fm.moveItem(at: fileURL, to: target)
                } catch {
                    print("[foxy] counters: could not be set aside: \(error)")
                    throw Failure.unwritable
                }
                moved = target
                print("[foxy] counters: set aside as \(target.lastPathComponent)")
            }
            counters = [:]
            if hasIndex {
                let target = Self.replacedP2PKURL(directory, stamp)
                do {
                    try fm.moveItem(at: p2pkURL, to: target)
                    p2pkStored = 0
                    print("[foxy] lock keys: the index set aside as \(target.lastPathComponent)")
                } catch {
                    /* Left where it is, and not a failure.
                     *
                     * The counters must start again from zero under a new seed or
                     * a restore elsewhere finds gaps and gives up. The lock index
                     * need not: the same index under a different seed derives a
                     * different key, so carrying it forward reuses nothing. It
                     * only wastes indices. Refusing the whole seed change over
                     * that would be the tail wagging the dog. */
                    print("[foxy] lock keys: the index file could not be set aside (\(error));"
                        + " it is kept and counts on, which reuses no key")
                    p2pkStored = nil
                }
            } else {
                p2pkStored = 0
            }
            return moved
        }
    }

    static func replacedURL(_ directory: URL, _ stamp: Int) -> URL {
        directory.appendingPathComponent("foxy-counters.replaced.\(stamp).json")
    }

    static func replacedP2PKURL(_ directory: URL, _ stamp: Int) -> URL {
        directory.appendingPathComponent("foxy-p2pk.replaced.\(stamp).json")
    }

    // MARK: The file

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Lock held. Where an id's counter goes: its slot's stored id, or a new
    /// entry, which a full file refuses.
    private func key(_ keysetId: String, in c: [String: UInt64]) throws -> String {
        let k = CounterRules.storedKey(keysetId, in: c.keys)
        guard c[k] != nil || c.count < CounterRules.mostKeysets else { throw Failure.tooManyKeysets }
        return k
    }

    /// Lock held.
    private func load() throws -> [String: UInt64] {
        if let counters { return counters }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            counters = [:]
            return [:]
        }
        guard let data = try? Data(contentsOf: fileURL), let parsed = Self.parse(data) else {
            print("[foxy] counters: the file could not be read; no counter is handed out")
            throw Failure.unreadable
        }
        // one entry per derivation path; written back with the next change
        let merged = CounterRules.merged(parsed)
        if merged.count != parsed.count {
            print("[foxy] counters: \(parsed.count - merged.count) entries of the same derivation path merged")
        }
        counters = merged
        return merged
    }

    /// A counter file, or nil if any entry is not a lowercase 00 or 01 keyset id
    /// with a whole number from 0 to 2^53. One bad entry refuses the whole file:
    /// dropping it would lower that keyset's counter to zero.
    static func parse(_ data: Data) -> [String: UInt64]? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var out: [String: UInt64] = [:]
        for (id, value) in object {
            guard NUT13.keysetVersion(id) != nil, id == id.lowercased(),
                  let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let double = number.doubleValue
            guard double.isFinite, double >= 0, double.rounded(.towardZero) == double,
                  double <= Double(largestNext) else { return nil }
            out[id] = UInt64(double)
        }
        return out
    }

    /// Lock held. Memory changes only once the file has.
    private func save(_ c: [String: UInt64]) throws {
        do {
            try write(c.mapValues { NSNumber(value: $0) }, to: fileURL)
        } catch {
            print("[foxy] counters: not saved (\(error)); no counter is handed out")
            throw Failure.unwritable
        }
        counters = c
    }

    /// Lock held. The lock-key index, read once and kept.
    ///
    /// A file that is there and cannot be read hands out nothing, as the counter
    /// file does. Starting again from zero would derive lock keys this phone has
    /// already put in requests, and a request whose lock this phone cannot open
    /// is money destroyed by paying it.
    private func loadP2PK() throws -> UInt64 {
        if let p2pkStored { return p2pkStored }
        guard FileManager.default.fileExists(atPath: p2pkURL.path) else {
            p2pkStored = 0
            return 0
        }
        guard let data = try? Data(contentsOf: p2pkURL), let parsed = Self.parseP2PK(data) else {
            print("[foxy] lock keys: the index file could not be read; no lock key is handed out")
            throw Failure.unreadable
        }
        p2pkStored = parsed
        return parsed
    }

    /// Lock held.
    private func saveP2PK(_ next: UInt64) throws {
        do {
            try write(["next": NSNumber(value: next)], to: p2pkURL)
        } catch {
            print("[foxy] lock keys: the index was not saved (\(error)); no lock key is handed out")
            throw Failure.unwritable
        }
        p2pkStored = next
    }

    /// `{"next": n}`, or nil when `next` is missing or is not a whole number an
    /// index could be.
    ///
    /// Keys this build does not know are left alone rather than refused — unlike
    /// the counter file, where every key is a keyset id and an unknown one means
    /// the file is not a counter file at all. Here a newer Foxy may have written
    /// something beside `next`, and ignoring it costs nothing: `next` is the only
    /// value that must not go backwards, and it is read.
    static func parseP2PK(_ data: Data) -> UInt64? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let number = object["next"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double >= 0, double.rounded(.towardZero) == double,
              double <= Double(P2PK.largestNext) else { return nil }
        return UInt64(double)
    }

    /// Lock held. Written to a temporary file in the same folder, flushed with
    /// F_FULLFSYNC, renamed over the file, and the folder flushed so the rename
    /// is on the disk too. Then excluded from backups again, because the renamed
    /// file is a new file and would not keep the old one's exclusion.
    private func write(_ object: [String: NSNumber], to url: URL) throws {
        let fm = FileManager.default
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            try data.write(to: temporary, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
            try Self.flush(temporary)
            guard rename(temporary.path, url.path) == 0 else { throw Failure.unwritable }
            // the rename is the folder's change; losing it would bring the old file back
            try? Self.flush(directory)
        } catch {
            try? fm.removeItem(at: temporary)
            throw error
        }
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try target.setResourceValues(values)
        } catch {
            // these are saved, and are not secret; a backup holding them is untidy, not a loss
            print("[foxy] \(url.lastPathComponent): saved, but not excluded from backups: \(error)")
        }
    }

    /// F_FULLFSYNC: the drive writes its cache out, not only the kernel. A file
    /// system that cannot (a test's temporary folder on some disks) gets fsync.
    static func flush(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { throw Failure.unwritable }
        defer { close(fd) }
        if fcntl(fd, F_FULLFSYNC) != 0, fsync(fd) != 0 {
            throw Failure.unwritable
        }
    }
}
