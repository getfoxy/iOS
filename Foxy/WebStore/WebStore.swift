import Foundation
import SQLite3
import CryptoKit

/// Where the page's storage lives, and how the wallet gets there if WebKit
/// ever opens an empty store in its place.
///
/// THE ADDRESS. The page is served at `foxy-app://wallet/index.html` by
/// WebSchemeHandler, not loaded from a file. WebKit keys a page's
/// localStorage by the page's origin, and `foxy-app://wallet` is a name
/// written here: nothing about the phone, the install or the app's folder is
/// in it. It was `file://` before, loaded from Library/Caches/web.
///
/// WHY THE CHECK. After one ordinary install the page opened an empty store
/// while the old one, the whole wallet, sat beside it under another folder
/// name, both for the same origin. WebKit names each origin's folder with a
/// salted hash, and a store opened under a new salt or a new name is empty to
/// the page, which then sees a wallet with nothing in it. What re-keyed it is
/// not settled, so the check does not depend on knowing it: before the page
/// runs, a blank page at the same address asks the store whether it holds the
/// wallet, and when it does not and a store on the phone that this install
/// may take does, its items are copied in first.
///
/// WHAT MAY BE TAKEN.
///  - Before the move to `foxy-app://wallet` is settled: the `file://` store
///    the page was using, found the way WebKit names it (`inUse`), when it
///    holds money or history; otherwise the fullest store on the phone,
///    whatever its origin (an empty one beside a full one included).
///  - After it: only a store that carries this install's mark, a random value
///    the check writes into the store it settles on, under a key the
///    wallet's own erase leaves alone. A store with the mark that is not the
///    page's own is the page's store from before a re-keying. The old
///    `file://` stores never carry it, so an erased wallet is never brought
///    back from them.
///  - Never a store taken before (by its path under Library/WebKit, which
///    does not change when the app's folder moves), and never two at once:
///    one store is copied whole, and any other that holds money or history is
///    named in the log and left as it is. Nothing is ever deleted.
///
/// WHAT SETTLES IT. Nothing is recorded as settled until a later launch finds
/// the mark in the page's store: WebKit writes the store to disk after the
/// copy has answered, in another process, and an app that ends before that
/// leaves an empty store that is simply copied into again. A store that cannot
/// be read stops the check rather than being taken as no store (except that
/// the `file://` store the page was using, read, is still carried in), and the
/// check is never settled while the phone is locked.
///
/// WHAT IS KEPT AS IT IS. Only a page's store that holds money or history (a
/// pile, the log, words) is kept without a copy; one that holds only settings
/// (the intro seen, say) is copied into as an empty one is. A store with a
/// copy cut off part way in it is never kept. And after the page was opened
/// on its store as it is (three failed checks in a row), nothing is marked or
/// settled until a copy is made: a page that opened on a near-empty store
/// would otherwise settle the move on it, and the old wallet could never be
/// carried in.
enum WebStore {

    // MARK: The page's address

    static let scheme = "foxy-app"
    static let host = "wallet"
    static let origin = scheme + "://" + host
    static let indexURL = URL(string: "foxy-app://wallet/index.html")!
    /// The blank page the check runs in, served from code; never a staged file.
    static let checkPath = "/.store-check"
    static let checkURL = URL(string: "foxy-app://wallet/.store-check")!

    /// The fixed scheme and host, and nothing else in the authority.
    static func isOurs(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == scheme && url.host?.lowercased() == host
            && url.port == nil && url.user == nil && url.password == nil
    }

    static func isCheck(_ url: URL?) -> Bool { isOurs(url) && url?.path == checkPath }
    static func isIndex(_ url: URL?) -> Bool { isOurs(url) && url?.path == "/index.html" }

    // MARK: What this install remembers (UserDefaults, which goes with the app)

    /// Not under `foxy.`: the wallet's erase removes every `foxy.` key, and a
    /// mark that went with it would let an erased wallet be refilled.
    static let markKey = "foxy-store-mark"
    static let movedKey = "foxy.webStore.moved"
    static let takenKey = "foxy.webStore.taken"
    static let markDefaultsKey = "foxy.webStore.mark"
    /// The store copied from at the last check, recorded as taken only once a
    /// later launch finds the copy, marked, in the page's store.
    static let pendingKey = "foxy.webStore.pending"
    /// When a check last ended with the page started on its own store.
    static let lastCheckKey = "foxy.webStore.lastCheck"
    /// Checks in a row that could not be finished.
    static let failuresKey = "foxy.webStore.failures"
    /// From this many failed checks in a row the page is started on its own
    /// store as it is, with nothing settled, rather than never again.
    static let failuresBeforeOpening = 3
    /// The page was started on its own store as it is (`failuresBeforeOpening`):
    /// nothing is marked or settled until a copy is made, or nothing on the
    /// phone is left that could be.
    static let asIsKey = "foxy.webStore.asIs"
    /// A copy into the page's store was started and has not answered (the
    /// page's process or the app ended part way), or the page's store was
    /// found holding such a copy: the page is never opened on it as it is.
    static let copyingKey = "foxy.webStore.copying"

    struct State: Equatable {
        var moved: Bool
        var taken: Set<String>
        var mark: String
        var pending: String? = nil
        var lastCheck: Date? = nil
        /// The page was opened on its store as it is, and no copy made since.
        var asIs = false
        /// A copy into the page's store was left cut off.
        var copying = false
    }

    /// The state, with a mark made the first time it is asked for.
    static func state(_ defaults: UserDefaults) -> State {
        var mark = defaults.string(forKey: markDefaultsKey) ?? ""
        if mark.count != 32 || !mark.allSatisfy(\.isHexDigit) {
            mark = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            defaults.set(mark, forKey: markDefaultsKey)
        }
        return State(moved: defaults.bool(forKey: movedKey),
                     taken: Set(defaults.stringArray(forKey: takenKey) ?? []),
                     mark: mark,
                     pending: defaults.string(forKey: pendingKey),
                     lastCheck: defaults.object(forKey: lastCheckKey) as? Date,
                     asIs: defaults.bool(forKey: asIsKey),
                     copying: defaults.bool(forKey: copyingKey))
    }

    /// The page is started on its own store as it is, after failed checks.
    static func noteOpenedAsIs(_ defaults: UserDefaults) {
        defaults.set(true, forKey: asIsKey)
    }

    /// A copy was made, or nothing is left on the phone to make one from: the
    /// store may be marked and settled again.
    static func clearAsIs(_ defaults: UserDefaults) {
        defaults.removeObject(forKey: asIsKey)
    }

    /// Whether a copy into the page's store is cut off (started and not
    /// answered, or seen part way in the store), for the open-as-is rule.
    static func noteCopying(_ on: Bool, _ defaults: UserDefaults) {
        if on { defaults.set(true, forKey: copyingKey) } else { defaults.removeObject(forKey: copyingKey) }
    }

    /// The page's store was found carrying this install's mark: the move is
    /// settled, and a copy made at an earlier check is on disk, so its source
    /// is taken. The only place either is recorded.
    static func noteSettled(_ defaults: UserDefaults, now: Date = Date()) {
        defaults.set(true, forKey: movedKey)
        if let path = defaults.string(forKey: pendingKey) {
            var list = defaults.stringArray(forKey: takenKey) ?? []
            if !list.contains(path) { list.append(path) }
            defaults.set(list, forKey: takenKey)
            defaults.removeObject(forKey: pendingKey)
        }
        noteChecked(defaults, now: now)
    }

    /// A copy was made: its source is taken once a later launch sees it.
    static func notePending(_ path: String, _ defaults: UserDefaults) {
        defaults.set(path, forKey: pendingKey)
    }

    /// The check ended and the page starts on its own store.
    static func noteChecked(_ defaults: UserDefaults, now: Date = Date()) {
        defaults.set(now, forKey: lastCheckKey)
        defaults.removeObject(forKey: failuresKey)
    }

    /// One more check in a row that could not be finished; how many now.
    @discardableResult
    static func noteFailure(_ defaults: UserDefaults) -> Int {
        let n = defaults.integer(forKey: failuresKey) + 1
        defaults.set(n, forKey: failuresKey)
        return n
    }

    // MARK: Which keys are the wallet

    /// Written on every launch, or records of a one-time move: not a wallet.
    /// The same three the page's own reinstall test passes over
    /// (looksLikeReinstall, 03-seed-counters-logs.js).
    static let notTheWallet: [String] = ["foxy.schema", "foxy.counter.v1.sentToPhone", "foxy.seed.v1.toPhone"]
    static let emptyValues: [String] = ["", "[]", "{}", "null", "\"\"", "0"]

    /// The key's name in the wallet, `flash.` read as the `foxy.` the page
    /// renames it to; nil for a key that is not the wallet's.
    static func walletName(_ key: String) -> String? {
        let name = key.hasPrefix("flash.") ? "foxy." + key.dropFirst(6) : key
        guard name.hasPrefix("foxy."), !notTheWallet.contains(name) else { return nil }
        return name
    }

    /// A proof pile, the history, or words an older install kept in the page.
    static func isMoney(_ name: String) -> Bool {
        isPile(name) || name == "foxy.cashu.log" || name == "foxy.seed.v1"
    }

    static func isPile(_ name: String) -> Bool {
        name == "foxy.cashu.proofs" || name.hasPrefix("foxy.cashu.proofs.")
    }

    /// What a store holds of the wallet, counted the way the check page counts
    /// the page's own (`countScript`).
    struct Contents: Equatable {
        var items = 0
        /// The wallet's keys with something in them.
        var keys = 0
        var money = false
        var piles = 0
        var marked = false
    }

    /// `short` is the value when it is short enough to be one of the empty
    /// ones, nil when it is longer (and so not empty).
    static func add(key: String, short: String?, mark: String, to c: inout Contents) {
        c.items += 1
        if key == markKey { c.marked = c.marked || short == mark; return }
        guard let name = walletName(key) else { return }
        if let short, emptyValues.contains(short) { return }
        c.keys += 1
        if isMoney(name) { c.money = true }
        if isPile(name) { c.piles += 1 }
    }

    // MARK: The stores on the phone

    struct Bucket: Equatable {
        /// The store's folder under Library/WebKit, which a move of the app's
        /// folder does not change.
        var path: String
        var file: URL
        /// What WebKit's own `origin` file says, for the log only.
        var origin: String
        var modified: Date
        var bytes: Int
        var contents: Contents

        /// 2: money or history, 1: something of the wallet's, 0: nothing.
        var tier: Int { contents.money ? 2 : (contents.keys > 0 ? 1 : 0) }
    }

    struct Scan: Equatable {
        var buckets: [Bucket] = []
        /// Stores that could not be read, and why.
        var unread: [String] = []
        /// The folders WebKit's salt names for the page's two origins (`inUse`):
        /// the `file://` store the page was using before the move, and the
        /// page's own store now. Empty when there is no salt to read.
        var fileStores: Set<String> = []
        var pageStores: Set<String> = []
    }

    // MARK: Which folder WebKit uses for an origin

    /// WebKit names an origin's store folder `<top>/<frame>` under the folder
    /// holding its `salt` (8 bytes), each part the SHA-256 of the origin's text
    /// (`file://`, `foxy-app://wallet`) followed by the salt, in URL-safe
    /// base64 with no padding (NetworkStorageManager, `encode`). The page is
    /// always its own top frame, so both parts are the same.
    static func folderName(origin: String, salt: Data) -> String {
        var hash = SHA256()
        hash.update(data: Data(origin.utf8))
        hash.update(data: salt)
        return Data(hash.finalize()).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// For each folder of stores found, the store the salt beside it names for
    /// `origin`, as a path like a Bucket's. A salt that cannot be read names none.
    static func inUse(origin: String, parents: Set<URL>, base: URL) -> Set<String> {
        var out: Set<String> = []
        for parent in parents {
            guard let salt = try? Data(contentsOf: parent.appendingPathComponent("salt")), salt.count == 8 else { continue }
            let name = folderName(origin: origin, salt: salt)
            out.insert(relative(parent.appendingPathComponent(name).appendingPathComponent(name), to: base))
        }
        return out
    }

    /// Every localStorage store under Library/WebKit: WebKit's layout from
    /// iOS 17 (…/<hash>/<hash>/LocalStorage/localstorage.sqlite3, with an
    /// `origin` file beside LocalStorage) and the one before it
    /// (…/LocalStorage/<origin>.localstorage), whichever this phone has.
    /// Each is read from a copy in `scratch`, never in place.
    static func scan(webKit root: URL, scratch: URL, mark: String) -> Scan {
        var out = Scan()
        let fm = FileManager.default
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        guard let walk = fm.enumerator(at: base, includingPropertiesForKeys: [.isRegularFileKey]) else { return out }
        var files: [(file: URL, folder: URL, legacy: Bool)] = []
        for case let url as URL in walk {
            let parent = url.deletingLastPathComponent()
            guard parent.lastPathComponent == "LocalStorage",
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            if url.lastPathComponent == "localstorage.sqlite3" {
                files.append((url, parent.deletingLastPathComponent(), false))
            } else if url.pathExtension == "localstorage" {
                files.append((url, url, true))
            }
        }
        // the folders holding the stores, where WebKit keeps the salt
        let parents = Set(files.filter { !$0.legacy }.map { $0.folder.deletingLastPathComponent().deletingLastPathComponent() })
        out.fileStores = inUse(origin: "file://", parents: parents, base: base)
        out.pageStores = inUse(origin: origin, parents: parents, base: base)
        for (file, folder, legacy) in files.sorted(by: { $0.file.path < $1.file.path }) {
            let path = relative(folder, to: base)
            do {
                let contents = try summary(of: file, scratch: scratch, mark: mark)
                out.buckets.append(Bucket(path: path, file: file,
                                          origin: legacy ? legacyOrigin(file) : originLabel(folder),
                                          modified: modified(file), bytes: bytes(file), contents: contents))
            } catch {
                out.unread.append("\(short(path)): \(error)")
            }
        }
        return out
    }

    static func relative(_ url: URL, to base: URL) -> String {
        let full = url.standardizedFileURL.resolvingSymlinksInPath().path
        let root = base.path.hasSuffix("/") ? base.path : base.path + "/"
        return full.hasPrefix(root) ? String(full.dropFirst(root.count)) : full
    }

    private static func sideFiles(_ file: URL) -> [URL] {
        [file, URL(fileURLWithPath: file.path + "-wal")]
    }

    private static func modified(_ file: URL) -> Date {
        sideFiles(file).compactMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
            .max() ?? .distantPast
    }

    private static func bytes(_ file: URL) -> Int {
        sideFiles(file).compactMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }.reduce(0, +)
    }

    /// WebKit's `origin` file holds the scheme and host as length-prefixed
    /// strings, twice (the top frame's, then the store's). Read loosely, for
    /// the log: the first printable run is the scheme, the next different one
    /// the host.
    static func originLabel(_ folder: URL) -> String {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("origin")) else { return "?" }
        return originLabel(data)
    }

    static func originLabel(_ data: Data) -> String {
        var runs: [String] = []
        var run = ""
        for b in data {
            if b >= 0x21 && b < 0x7f { run.append(Character(UnicodeScalar(b))) } else {
                if run.count >= 3 { runs.append(run) }
                run = ""
            }
        }
        if run.count >= 3 { runs.append(run) }
        guard let scheme = runs.first else { return "?" }
        if runs.count > 1, runs[1] != scheme { return scheme + "://" + runs[1] }
        return scheme
    }

    /// `file__0.localstorage`, `foxy-app_wallet_0.localstorage`.
    static func legacyOrigin(_ file: URL) -> String {
        let parts = file.deletingPathExtension().lastPathComponent.components(separatedBy: "_")
        guard let scheme = parts.first, !scheme.isEmpty else { return "?" }
        return parts.count > 1 && !parts[1].isEmpty ? scheme + "://" + parts[1] : scheme
    }

    // MARK: Reading a store

    struct ReadError: Error, CustomStringConvertible {
        let description: String
    }

    /// Opens a copy of the database and its write-ahead log in `scratch`, so
    /// WebKit's own files are only ever read, never opened by SQLite (which
    /// would write beside them). APFS makes the copy a clone.
    static func withCopy<T>(of file: URL, scratch: URL, _ body: (OpaquePointer) throws -> T) throws -> T {
        let fm = FileManager.default
        let dir = scratch.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let copy = dir.appendingPathComponent(file.lastPathComponent)
        try fm.copyItem(at: file, to: copy)
        for suffix in ["-wal", "-journal"] where fm.fileExists(atPath: file.path + suffix) {
            try fm.copyItem(at: URL(fileURLWithPath: file.path + suffix), to: URL(fileURLWithPath: copy.path + suffix))
        }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(copy.path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db = handle else {
            let why = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "no handle"
            sqlite3_close(handle)
            throw ReadError(description: "could not open: \(why)")
        }
        defer { sqlite3_close(db) }
        return try body(db)
    }

    private static func each(_ db: OpaquePointer, _ sql: String, bind: [String] = [],
                             _ row: (OpaquePointer) -> Void) throws {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK, let st else {
            throw ReadError(description: "no ItemTable: \(String(cString: sqlite3_errmsg(db)))")
        }
        defer { sqlite3_finalize(st) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, text) in bind.enumerated() {
            sqlite3_bind_text(st, Int32(i + 1), text, -1, transient)
        }
        while true {
            let rc = sqlite3_step(st)
            if rc == SQLITE_DONE { return }
            guard rc == SQLITE_ROW else { throw ReadError(description: "read stopped: \(String(cString: sqlite3_errmsg(db)))") }
            row(st)
        }
    }

    /// A column as WebKit stored it: a blob of UTF-16 code units,
    /// little-endian, which is what it writes; or text. `repaired` says a
    /// lone surrogate in the blob could not be carried and was replaced.
    static func text(_ st: OpaquePointer, _ col: Int32) -> (value: String, repaired: Bool)? {
        let n = Int(sqlite3_column_bytes(st, col))
        switch sqlite3_column_type(st, col) {
        case SQLITE_NULL:
            return nil
        case SQLITE_BLOB:
            guard n > 0, let p = sqlite3_column_blob(st, col) else { return ("", false) }
            let raw = UnsafeRawBufferPointer(start: p, count: n)
            if n % 2 != 0 { return (String(decoding: raw, as: UTF8.self), false) }   // not UTF-16: read as UTF-8
            var units = [UInt16](repeating: 0, count: n / 2)
            for i in 0..<units.count { units[i] = UInt16(raw[2 * i]) | (UInt16(raw[2 * i + 1]) << 8) }
            let s = String(decoding: units, as: UTF16.self)
            return (s, !s.utf16.elementsEqual(units))
        default:
            guard n > 0, let p = sqlite3_column_text(st, col) else { return ("", false) }
            return (String(decoding: UnsafeRawBufferPointer(start: p, count: n), as: UTF8.self), false)
        }
    }

    /// Whether the database has WebKit's table at all. A database WebKit made
    /// and never wrote to has none, and holds nothing; a damaged one throws.
    private static func hasItemTable(_ db: OpaquePointer) throws -> Bool {
        var found = false
        try each(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'") { _ in found = true }
        return found
    }

    /// Counts what a store holds, reading only the values short enough to be
    /// empty ones, and the mark.
    static func summary(of file: URL, scratch: URL, mark: String) throws -> Contents {
        try withCopy(of: file, scratch: scratch) { db in
            var c = Contents()
            guard try hasItemTable(db) else { return c }
            try each(db, "SELECT key, CASE WHEN length(value) <= 16 OR key = ?1 THEN value END FROM ItemTable",
                     bind: [markKey]) { st in
                guard let key = text(st, 0)?.value else { return }
                add(key: key, short: text(st, 1)?.value, mark: mark, to: &c)
            }
            return c
        }
    }

    /// Every item in a store, as the page will be given them.
    static func items(of file: URL, scratch: URL) throws -> (items: [[String]], repaired: Int) {
        try withCopy(of: file, scratch: scratch) { db in
            var items: [[String]] = []
            var repaired = 0
            guard try hasItemTable(db) else { return (items, repaired) }
            try each(db, "SELECT key, value FROM ItemTable") { st in
                guard let key = text(st, 0), let value = text(st, 1) else { return }
                if key.repaired || value.repaired { repaired += 1 }
                items.append([key.value, value.value])
            }
            return (items, repaired)
        }
    }

    // MARK: The decision

    /// What the check page found in the page's own store.
    struct Probe: Equatable {
        var marked: Bool
        var keys: Int
        /// A copy into it was started and never finished (the app or the
        /// page's process ended part way): what it holds is a part of a wallet.
        var copying = false
        /// It holds money or history (`isMoney`: a pile, the log, words), not
        /// only settings: the one kind of store kept without a copy.
        var money = false
    }

    enum Decision: Equatable {
        /// The page's store is the one to use. `mark`: write the mark into it.
        /// `settle`: it carries the mark already, so the move, and any copy
        /// made at an earlier check, is recorded as done.
        case keep(String, mark: Bool, settle: Bool)
        /// Copy this store's items in first. `others`: stores this install
        /// could also have taken that hold money or history, left as they are.
        case copy(Bucket, others: [Bucket], why: String)
        /// The page's store is empty and a store on the phone could not be
        /// read: nothing is decided or recorded, and the next launch tries again.
        case wait(String)
    }

    /// The stores this install may take, best first. A store carrying this
    /// install's mark first, the newest of them first: it is the page's own
    /// store from before a re-keying, and the newest is the one the page used
    /// last (a store it was copied from is older and holds what was spent
    /// since). Then the unmarked: the most money and history, then the most of
    /// the wallet's keys (the fullest), then the newest, then the largest.
    /// Fullest before newest there because a store that was opened empty and
    /// had a restore run into it is newer than the wallet it lost, and holds a
    /// fraction of it. A store copied from at an earlier check whose copy was
    /// never seen on disk (`pending`) may be taken again.
    static func candidates(_ all: [Bucket], state: State) -> [Bucket] {
        all.filter { $0.tier > 0 && (!state.taken.contains($0.path) || $0.path == state.pending)
                     && (!state.moved || $0.contents.marked) }
            .sorted { a, b in
                if a.contents.marked != b.contents.marked { return a.contents.marked }
                if a.contents.marked, a.modified != b.modified { return a.modified > b.modified }
                if a.tier != b.tier { return a.tier > b.tier }
                if a.contents.keys != b.contents.keys { return a.contents.keys > b.contents.keys }
                if a.modified != b.modified { return a.modified > b.modified }
                if a.bytes != b.bytes { return a.bytes > b.bytes }
                return a.path < b.path
            }
    }

    /// Stores outside the page's own that hold money or history and were
    /// changed after the last check that started the page: something else, an
    /// older Foxy most likely, has used one since. Never taken from here; named.
    static func changedSince(_ scan: Scan, state: State) -> [Bucket] {
        guard let since = state.lastCheck else { return [] }
        return scan.buckets.filter {
            $0.tier == 2 && $0.modified > since && !scan.pageStores.contains($0.path) && $0.origin != origin
        }
    }

    static func decide(_ probe: Probe, scan: Scan, state: State) -> Decision {
        let list = candidates(scan.buckets, state: state)
        /* Opened as it is after failed checks, and no copy made since: kept without a mark or a settling while anything on the
         * phone could still be carried in (a store that could not be read, or one this install may take). */
        let held = state.asIs && (!scan.unread.isEmpty || !list.isEmpty)
        let heldWords = "; the page was opened on it as it is after failed checks, so nothing is marked or settled until a copy is made"
        if probe.marked {
            if held { return .keep("the page's store carries this install's mark" + heldWords, mark: false, settle: false) }
            return .keep("the page's store is this install's own (\(probe.keys) keys of the wallet)", mark: false, settle: true)
        }
        // kept as it is only when it holds money or history; a store of settings alone is copied into as an empty one is
        if probe.keys > 0 && probe.money && !probe.copying {
            return .keep("the page's store already holds \(probe.keys) keys of the wallet, money or history among them" + (held ? heldWords : ""),
                         mark: !held, settle: false)
        }
        let what = probe.copying ? "holds a copy cut off part way" : probe.keys > 0 ? "holds no money or history" : "is empty"
        // before the move: the file:// store the page was using, when it holds the wallet's money or history and was read,
        // even beside a store that could not be read; never while a store carries this install's mark (the page's own from before)
        if !state.moved, !list.contains(where: { $0.contents.marked }),
           let used = list.first(where: { scan.fileStores.contains($0.path) && $0.tier == 2 }) {
            let others = list.filter { $0.path != used.path && $0.tier == 2 }
            return .copy(used, others: others,
                         why: "the page's store at \(origin) \(what), and this is the store the page was using at file:// (named by WebKit's salt)")
        }
        // from here: nothing is taken as no store while one could not be read
        if !scan.unread.isEmpty {
            return .wait("the page's store \(what) and \(scan.unread.count) store(s) on the phone could not be read")
        }
        guard let pick = list.first else {
            // a copy cut off part way is never kept as the wallet
            if probe.copying {
                return .wait("the page's store holds a copy cut off part way and the store it came from is not on the phone to copy again")
            }
            if probe.keys > 0 {
                return .keep("the page's store holds \(probe.keys) keys of the wallet, no money or history, and no store of this install's is elsewhere",
                             mark: true, settle: false)
            }
            return .keep(state.moved ? "the page's store is empty and no store of this install's is elsewhere"
                                     : "the page's store is empty and nothing on the phone holds a wallet (a fresh install)",
                         mark: true, settle: false)
        }
        let others = list.dropFirst().filter { $0.tier == 2 }
        let ofHow = list.count == 1 ? "the only store" : "the fullest of \(list.count) stores"
        let why: String
        if state.moved || pick.contents.marked {
            why = "the page's store \(what), and this is \(pick.contents.marked && list.count > 1 ? "the newest of the stores" : ofHow) carrying this install's mark: the page's store from before"
        } else if !scan.fileStores.isEmpty {
            why = "the page's store at \(origin) \(what), the store the page was using at file:// holds no money or history, and this is \(ofHow) on the phone holding the wallet"
        } else {
            why = "the page's store at \(origin) \(what), and this is \(ofHow) on the phone holding the wallet"
        }
        return .copy(pick, others: Array(others), why: why)
    }

    // MARK: The log

    static func short(_ path: String) -> String {
        path.split(separator: "/").map { $0.count > 16 ? String($0.prefix(8)) + "…" : String($0) }.joined(separator: "/")
    }

    static func describe(_ b: Bucket) -> String {
        let when = ISO8601DateFormatter().string(from: b.modified)
        let kb = max(1, (b.bytes + 1023) / 1024)
        return "\(short(b.path)) (origin \(b.origin), \(b.contents.items) items, \(b.contents.keys) keys of the wallet, "
            + "\(b.contents.piles) proof piles, \(kb) KB, modified \(when))"
    }

    // MARK: What the check page runs (callAsyncJavaScript, arguments only)

    /// The page's own count of the wallet's keys, the rule `add` follows.
    /// Takes `notTheWallet`, `emptyValues`, `markKey` and `mark` as arguments.
    static let countScript = """
    var skip = new Set(notTheWallet), empty = new Set(emptyValues);
    // `money`: only the keys that are money or history (`isMoney`: a pile, the log, words)
    function walletKeys(money) {
      var n = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k === null || k === markKey) continue;
        var name = k.indexOf('flash.') === 0 ? 'foxy.' + k.slice(6) : k;
        if (name.indexOf('foxy.') !== 0 || skip.has(name)) continue;
        var v = localStorage.getItem(k);
        if (v === null || empty.has(v)) continue;
        if (money && !(name === 'foxy.cashu.proofs' || name.indexOf('foxy.cashu.proofs.') === 0 || name === 'foxy.cashu.log' || name === 'foxy.seed.v1')) continue;
        n++;
      }
      return n;
    }

    """

    static let checkScript = countScript + """
    var at = localStorage.getItem(markKey);
    return { marked: at === mark, copying: at === 'copying:' + mark, keys: walletKeys(), money: walletKeys(true) > 0, items: localStorage.length };
    """

    static let markScript = """
    localStorage.setItem(markKey, mark);
    return localStorage.getItem(markKey) === mark;
    """

    /// Copies `items` in only while the store still holds no money or history
    /// and is unmarked (settings alone are written over), reads every one
    /// back, then marks it. While it copies the
    /// mark says `copying:`, so a copy cut off part way is seen as one at the
    /// next check, cleared and made again, never kept as a wallet. Any failure
    /// takes back what it set, so the store is left as it was found.
    static let copyScript = countScript + """
    var at = localStorage.getItem(markKey);
    if (at === mark) return { skipped: 'marked' };
    if (at === 'copying:' + mark) localStorage.clear();
    else if (walletKeys(true) > 0) return { skipped: 'holds' };
    var set = [], was = {};
    try {
      localStorage.setItem(markKey, 'copying:' + mark);
      // the mark is this check's to write, last; a mark in the items is the old store's
      for (var i = 0; i < items.length; i++) {
        if (items[i][0] === markKey) continue;
        // (a setting the store held already is put back as it was if the copy fails)
        if (!Object.prototype.hasOwnProperty.call(was, items[i][0])) was[items[i][0]] = localStorage.getItem(items[i][0]);
        localStorage.setItem(items[i][0], items[i][1]);
        set.push(items[i][0]);
      }
      for (var j = 0; j < items.length; j++) {
        if (items[j][0] === markKey) continue;
        if (localStorage.getItem(items[j][0]) !== items[j][1]) throw new Error('an item read back differently');
      }
      localStorage.setItem(markKey, mark);
      return { copied: set.length, keys: walletKeys() };
    } catch (e) {
      for (var r = 0; r < set.length; r++) {
        try { if (was[set[r]] === null) localStorage.removeItem(set[r]); else localStorage.setItem(set[r], was[set[r]]); } catch (x) {}
      }
      try { localStorage.removeItem(markKey); } catch (x) {}
      return { error: String((e && e.name ? e.name + ': ' + e.message : e)) };
    }
    """

    static func arguments(mark: String) -> [String: Any] {
        ["notTheWallet": notTheWallet, "emptyValues": emptyValues, "markKey": markKey, "mark": mark]
    }
}
