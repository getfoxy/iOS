import Foundation

/// When `seedMigrate` may still write words the page hands over.
///
/// `seedMigrate` exists for one case: an install from before the keychain whose
/// page still holds its words in its own storage. Writing them anywhere else
/// would let a script in the page, on a phone with no seed saved yet, write
/// words it knows before the wallet makes its own, and then receive everything
/// sent to that wallet. So it writes only while this window is open:
///
/// - **an install that had page storage before this launch.** Checked once, in
///   `noteLaunch()`, before the page first loads. A fresh install has none, and
///   the window closes for good at its first launch.
/// - **until it is used, or a seed is there.** An answer about the words
///   (migrated, same or different) closes it. An error does not, so the page
///   can send them again; neither does "bad request", which never gets past
///   the check. A seed made on the phone, found saved, or adopted closes it too.
///
/// Closed, it still compares (review M4): with a seed saved the
/// answer is `same` or `different`, so an old install whose first compare was
/// lost (a cancelled Face ID, then seedStatus closing the window, or a crash
/// before the page saved its stamp) can still clear the words from its page.
/// It never writes. Only closed with no seed saved is it "no migration here".
///
/// Closed is kept in UserDefaults, which goes with the app on an uninstall.
enum SeedMigrationWindow {
    static let closedKey = "foxy.seedMigrate.closed"

    private static let lock = NSLock()
    private static var noted = false
    private static var hadPageStorage = false

    /// The rule itself, for the tests.
    static func open(closed: Bool, hadPageStorage: Bool) -> Bool {
        !closed && hadPageStorage
    }

    // MARK: The decision, apart from the keychain (FoxyTests, tools/nativetests)

    /// What seedMigrate did with the page's old words.
    enum Outcome: Equatable {
        /// No seed was saved and the window was open: the words are now the saved seed.
        case migrated
        /// The saved seed is these words' seed. Nothing changed.
        case same
        /// A different seed is saved. Nothing changed, and nothing is asked:
        /// the page's leftover copy is never a reason to replace the phone's seed.
        case different
        case refused(String)
    }

    /// The saved seed, as compared with the words.
    enum Saved: Equatable {
        case found(same: Bool)
        case absent
        case failed
    }

    enum Step: Equatable {
        case answer(Outcome)
        /// Write the words, never replacing a seed.
        case write
    }

    static let noMigration = "no migration here"

    /// A write only where the window is open and no seed is saved. A saved seed
    /// is compared whether the window is open or not.
    static func step(open: Bool, saved: Saved) -> Step {
        switch saved {
        case .failed: return .answer(.refused("the seed could not be read"))
        case .found(let same): return .answer(same ? .same : .different)
        case .absent: return open ? .write : .answer(.refused(noMigration))
        }
    }

    /// Closed only by an answer about the words themselves. The page sends
    /// them again after an error (a cancelled Face ID, a keychain that did not
    /// answer, a write that failed); closing then would leave an old install's
    /// words stranded in its page while a new seed was made.
    static func closes(after outcome: Outcome) -> Bool {
        switch outcome {
        case .migrated, .same, .different: return true
        case .refused: return false
        }
    }

    // MARK: The window on this install

    /// Once per process, before the page first loads: was there page storage
    /// from an earlier launch? A reload after the page's process ended does not
    /// ask again, because by then the page has written storage of its own.
    static func noteLaunch(defaults: UserDefaults = .standard,
                           library: URL? = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first) {
        lock.lock()
        defer { lock.unlock() }
        guard !noted else { return }
        noted = true
        hadPageStorage = library.map(pageStorageExists(in:)) ?? false
        if defaults.bool(forKey: closedKey) { return }
        if hadPageStorage {
            print("[foxy] seed migrate: open, page storage from before this launch")
        } else {
            defaults.set(true, forKey: closedKey)
            print("[foxy] seed migrate: closed, no page storage from before (a fresh install)")
        }
    }

    static var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return open(closed: UserDefaults.standard.bool(forKey: closedKey), hadPageStorage: hadPageStorage)
    }

    /// For good: nothing opens it again on this install.
    static func close(_ why: String, defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: closedKey) else { return }
        defaults.set(true, forKey: closedKey)
        print("[foxy] seed migrate: closed,", why)
    }

    /// WebKit keeps a page's localStorage in files under Library/WebKit whose
    /// path names LocalStorage (the folder layout differs between iOS versions,
    /// the name does not). Any such file with something in it counts.
    static func pageStorageExists(in library: URL) -> Bool {
        let root = library.appendingPathComponent("WebKit", isDirectory: true)
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else {
            return false
        }
        for case let url as URL in files where url.path.contains("LocalStorage") {
            let values = try? url.resourceValues(forKeys: Set(keys))
            if values?.isRegularFile == true, (values?.fileSize ?? 0) > 0 { return true }
        }
        return false
    }
}
