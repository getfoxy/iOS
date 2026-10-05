import Foundation
import LocalAuthentication
import Security

/// The seed, in the keychain.
///
/// Not a file. `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` means it never
/// leaves this device — not to a backup, not to iCloud Keychain — and is
/// unreadable while the phone is locked.
///
/// Modelled on cashubtc/wallet's KeychainService, including the update-then-add
/// order, which avoids the duplicate-item error that a bare SecItemAdd gives on
/// a second save.
enum SeedStore {
    /// One entry per thing stored. Only the mnemonic today.
    static let mnemonicKey = "foxy.seed.v1"

    private static func query(_ key: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "io.getfoxi.foxy",
            kSecAttrAccount: key,
        ]
    }

    static func save(_ value: String, key: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        var find = query(key)
        // The accessibility goes with every write, not only the first. An item
        // saved before it was set, or with another class, would otherwise keep
        // that class through every update.
        let update: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(find as CFDictionary, update as CFDictionary)

        if status == errSecItemNotFound {
            find[kSecValueData] = data
            find[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(find as CFDictionary, nil)
        }

        if status != errSecSuccess {
            print("[foxy] keychain save failed for \(key): \(status)")
            return false
        }
        return true
    }

    /// Three answers, not two. "Not there" and "the keychain did not answer"
    /// used to be the same nil — and a page told there was no seed made one,
    /// whose write then replaced the real seed.
    enum ReadResult: Equatable {
        case found(String)
        case absent
        case failed(OSStatus)
    }

    static func read(key: String) -> ReadResult {
        var find = query(key)
        find[kSecReturnData] = true
        find[kSecMatchLimit] = kSecMatchLimitOne

        var out: AnyObject?
        let status = SecItemCopyMatching(find as CFDictionary, &out)
        if status == errSecItemNotFound { return .absent }
        guard status == errSecSuccess else {
            print("[foxy] keychain read failed for \(key): \(status)")
            return .failed(status)
        }
        guard let data = out as? Data, let text = String(data: data, encoding: .utf8) else {
            return .failed(errSecDecode)
        }
        return .found(text)
    }

    /// The value, or nil for absent and failed alike. Only for callers where
    /// the two mean the same thing; the seed's own actions use read(key:).
    static func load(key: String) -> String? {
        if case .found(let value) = read(key: key) { return value }
        return nil
    }

    /// Keychain items survive app deletion. Without this, deleting Foxy and
    /// reinstalling it would find the old seed and collide with onboarding —
    /// a bug Minibits shipped a fix for.
    @discardableResult
    static func delete(key: String) -> Bool {
        let status = SecItemDelete(query(key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    static func has(key: String) -> Bool { load(key: key) != nil }

    /// Whether an item is there, without reading its value and without asking
    /// the person: true for found, or for an item that would need Face ID or the
    /// passcode; false only for not found; nil when the keychain did not say.
    static func exists(key: String) -> Bool? {
        var find = query(key)
        find[kSecReturnAttributes] = true
        find[kSecMatchLimit] = kSecMatchLimitOne
        let quiet = LAContext()
        quiet.interactionNotAllowed = true
        find[kSecUseAuthenticationContext] = quiet
        var out: AnyObject?
        switch SecItemCopyMatching(find as CFDictionary, &out) {
        case errSecSuccess, errSecInteractionNotAllowed, errSecAuthFailed: return true
        case errSecItemNotFound: return false
        default: return nil
        }
    }

    /// Deleted, and true only if there was something to delete. Reads nothing,
    /// so an item behind Face ID asks for nothing.
    @discardableResult
    static func deleteIfPresent(key: String) -> Bool {
        SecItemDelete(query(key) as CFDictionary) == errSecSuccess
    }

    // MARK: The seed behind Face ID or the passcode

    /// The seed's item: readable only with the person's
    /// approval. `mnemonicKey` is the older item, read once to move it here.
    static let protectedKey = "foxy.seed.v2"

    /// A plain note, readable without Face ID, that a seed was put in
    /// `protectedKey`. Without a passcode that item cannot be read, and iOS may
    /// answer "not found" for it rather than fail; this note is how Foxy tells
    /// that from a phone that never had a seed there (audit I10).
    static let heldKey = "foxy.seed.v2.held"

    private static func personRequired() -> SecAccessControl? {
        // this device only, as before; and every read needs Face ID or the passcode
        SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, nil)
    }

    /// Updated in place through `context`'s approval, or added with the access
    /// control. Nothing is deleted first: a write that fails leaves whatever
    /// was there.
    static func saveProtected(_ value: String, key: String, context: LAContext) -> Bool {
        guard let data = value.data(using: .utf8), let access = personRequired() else { return false }
        var find = query(key)
        find[kSecUseAuthenticationContext] = context
        var status = SecItemUpdate(find as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            /* Added without an authentication context.
             *
             * The access control is what makes every later read need Face ID or
             * the passcode; adding the item does not need the person's approval
             * and should not ask for it. Handing SecItemAdd a context alongside
             * a user-presence control makes iOS evaluate the policy there and
             * then — which is why a fresh install, with nothing yet to protect,
             * met a Face ID prompt as its seed was created.
             * The update above still carries the context: changing a protected
             * item that already exists genuinely does need approval. */
            var add = query(key)
            add[kSecValueData] = data
            add[kSecAttrAccessControl] = access
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status != errSecSuccess {
            print("[foxy] keychain protected save failed for \(key): \(status)")
            return false
        }
        return true
    }

    /// What a quiet read found: the words, when the context already carries the
    /// person's approval; `locked` when the item is there but reading it would
    /// ask them; `absent` when there is nothing there.
    enum QuietRead { case found(String), locked, absent, failed }

    /// A read that never puts up Face ID or the passcode. Used to confirm a
    /// write landed: it compares the words when it can, and otherwise settles
    /// for knowing the item is there behind the person's approval — which is
    /// all the keychain will say without asking them.
    static func readProtectedQuietly(key: String, context: LAContext) -> QuietRead {
        var find = query(key)
        find[kSecReturnData] = true
        find[kSecMatchLimit] = kSecMatchLimitOne
        context.interactionNotAllowed = true
        find[kSecUseAuthenticationContext] = context
        var out: AnyObject?
        let status = SecItemCopyMatching(find as CFDictionary, &out)
        context.interactionNotAllowed = false
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, let words = String(data: data, encoding: .utf8) else { return .failed }
            return .found(words)
        case errSecInteractionNotAllowed, errSecAuthFailed:
            return .locked
        case errSecItemNotFound:
            return .absent
        default:
            print("[foxy] keychain quiet read failed for \(key): \(status)")
            return .failed
        }
    }

    /// A read through `context`: its approval if it has one, otherwise iOS asks
    /// with its reason. An absent item answers without asking. Blocks while iOS
    /// asks, so never on the main queue.
    static func readProtected(key: String, context: LAContext) -> ReadResult {
        var find = query(key)
        find[kSecReturnData] = true
        find[kSecMatchLimit] = kSecMatchLimitOne
        find[kSecUseAuthenticationContext] = context

        var out: AnyObject?
        let status = SecItemCopyMatching(find as CFDictionary, &out)
        if status == errSecItemNotFound { return .absent }
        guard status == errSecSuccess else {
            print("[foxy] keychain protected read failed for \(key): \(status)")
            return .failed(status)
        }
        guard let data = out as? Data, let text = String(data: data, encoding: .utf8) else {
            return .failed(errSecDecode)
        }
        return .found(text)
    }

    /// The write rules for the older item in one place, so the DEBUG keychain
    /// self-test exercises the same code a seed write on a phone with no passcode
    /// goes through (SeedVault.write). Nil when written and read back; otherwise
    /// why not.
    static func writeSeed(_ words: String, replace: Bool, key: String = mnemonicKey) -> String? {
        switch read(key: key) {
        case .failed(let status):
            return "The keychain did not answer (\(status)), so nothing was written."
        case .found(let existing) where existing != words && !replace:
            print("[foxy] seed write refused: a different seed is already saved")
            return "A different seed is already saved on this phone. Foxy did not replace it."
        default:
            break
        }
        guard save(words, key: key) else { return "the keychain refused the write" }
        // read it back: a write that appeared to work and did not is the same
        // loss as no write at all
        guard load(key: key) == words else { return "the seed did not persist" }
        return nil
    }
}

/// The seed: behind Face ID or the passcode, and read only by native code.
///
/// Tor runs inside this process, and a memory bug in it that a hostile relay or
/// bridge could reach is a way in. Code that got in could read any keychain item
/// Foxy may read, without a sound. The seed now lives in an item that needs the
/// person for every read, so a read nobody asked for shows a prompt nobody
/// expected. A Face ID unlock of Foxy hands its approval to the read after it,
/// so opening the app still asks once.
///
/// Since stage 4 of taking the seed out of the page the words never reach the
/// page: native makes, shows, takes and writes them (NativeSeedBridge.swift),
/// and keeps only the BIP-39 seed made from them, in native memory, while it is
/// needed. What this does not stop: code already running while Foxy is open and
/// unlocked can ask the bridge for the secrets of counters it reserves, or read
/// this process's memory. THREAT-MODEL.md §1 and §7.
enum SeedVault {
    enum Answer: Equatable {
        case found(String)
        case absent
        case failed(String)
    }

    /// How long a Face ID unlock of Foxy covers the seed read that follows it.
    static let unlockSeconds: TimeInterval = 30
    private static var unlock: (context: LAContext, at: Date)?
    private static let lock = NSLock()

    /// Posted on the main queue after the saved seed was written or deleted.
    /// Foxy's seed screens close on it, so none shows words that were replaced.
    static let seedChanged = Notification.Name("FoxySeedChanged")

    /// The BIP-39 seed the counter and restore actions derive from
    /// (NativeSeedBridge.swift).
    /// Native memory, this page load only: it goes wherever the unlock is
    /// forgotten, when the page goes, when Foxy goes to the background, and when
    /// the saved seed is written or deleted. Words typed for a restore
    /// (SeedCandidates) go at each of those moments too.
    private static var nativeSeed: NUT13.Seed?
    /// Moves on every forget, so a read that was waiting on Face ID while the
    /// seed was forgotten answers its own request but keeps nothing.
    private static var nativeSeedEpoch = 0

    /// A Face ID unlock of Foxy succeeded with this context. Its approval covers
    /// the one seed read after it, within 30 seconds, and never the words screen.
    static func noteUnlock(_ context: LAContext) {
        lock.lock(); defer { lock.unlock() }
        unlock = (context, Date())
    }

    /// The page's process ended. Its next load gets no approval from before: a
    /// script that crashed the page could otherwise have the seed read again
    /// without a prompt inside the 30 seconds (audit I2).
    static func forgetUnlock() {
        lock.lock(); defer { lock.unlock() }
        if nativeSeed != nil { print("[foxy] seed: dropped — the unlock was given up") }
        unlock = nil
        nativeSeed = nil
        nativeSeedEpoch += 1
        SeedCandidates.shared.forgetAll()
    }

    /// Foxy is loading its page: nothing kept for the page before it (the
    /// BIP-39 seed, words typed for a restore) carries over to the new one.
    /// Called for the loads the native side starts.
    static func pageWillLoad() {
        lock.lock(); defer { lock.unlock() }
        if nativeSeed != nil { print("[foxy] seed: dropped — the page is loading again") }
        nativeSeed = nil
        nativeSeedEpoch += 1
        SeedCandidates.shared.forgetAll()
    }

    /// The page went, Foxy went to the background, or the saved seed changed:
    /// the next counter or restore action reads the keychain again, through
    /// Face ID, words typed for a restore are dropped, and a Face ID unlock no
    /// longer covers a read (review L2).
    static func forgetNativeSeed() {
        forgetNativeSeed(keepingCandidate: nil)
    }

    /// As forgetNativeSeed, except the typed words a seed write has just adopted:
    /// scans still running with them can finish (review M6).
    static func forgetNativeSeed(keepingCandidate kept: String?) {
        lock.lock(); defer { lock.unlock() }
        if nativeSeed != nil {
            print("[foxy] seed: dropped — the page went, Foxy left, or the seed changed")
        }
        unlock = nil
        nativeSeed = nil
        nativeSeedEpoch += 1
        SeedCandidates.shared.forgetAll(except: kept)
    }

    enum SecretsSeed {
        case found(NUT13.Seed)
        case absent
        case failed
    }

    /// The seed for the counter, restore and seed actions: kept from earlier in
    /// this page load, else read from the keychain under the unlock and its
    /// prompt. The words stay native; only the BIP-39 seed made from them is
    /// kept. Blocks while iOS asks; call it off the main queue.
    /* Whether this phone holds a seed at all, asking nothing of the person: the
     * keychain's own record that the item is there, which is not the secret.
     * true for either item — the seed behind Face ID, or the older one it is
     * moved from — false only when neither is there, nil when the keychain
     * would not say (a fresh install should not put up Face
     * ID before it has anything to protect). */
    static func seedIsThere() -> Bool? {
        let here = [SeedStore.protectedKey, SeedStore.mnemonicKey].map { SeedStore.exists(key: $0) }
        if here.contains(true) { return true }
        if here.contains(nil) { return nil }
        return false
    }

    static func seedForSecrets() -> SecretsSeed {
        lock.lock()
        if let seed = nativeSeed {
            lock.unlock()
            return .found(seed)
        }
        let epoch = nativeSeedEpoch
        lock.unlock()
        /* About to ask iOS, which means a prompt in front of somebody.
         *
         * The seed is kept for the whole visit on purpose, so this should happen
         * once: at the start. It was seen twice, six seconds apart, with no
         * backgrounding in between — and from outside there is no way to tell
         * which of the four things that drop the cache did it. Each of them says
         * so now, and so does this. */
        print("[foxy] seed: asking the phone for the seed — nothing is kept (epoch \(epoch))")
        switch read(context("Open your wallet")) {
        case .absent:
            return .absent
        case .failed:
            return .failed
        case .found(let words):
            // saved words that are not a mnemonic cannot be read as a seed
            guard let seed = try? NUT13.seed(mnemonic: words) else { return .failed }
            lock.lock()
            if epoch == nativeSeedEpoch { nativeSeed = seed }
            lock.unlock()
            return .found(seed)
        }
    }

    /// The saved words for Foxy's own seed screen (seedShow): read under the
    /// unlock and its prompt, and handed only to that native screen, never to the
    /// page. Blocks while iOS asks; call it off the main queue.
    ///
    /// Never through an earlier unlock: showing the words always asks (review
    /// L2).
    static func wordsForScreen() -> Answer {
        read(context("Show your wallet's seed", forScreen: true))
    }

    /// Without a device passcode an item that needs the person cannot be read at
    /// all, so on such a phone the seed stays in the older item.
    static var passcodeSet: Bool {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { return true }
        return error?.code != LAError.passcodeNotSet.rawValue
    }

    private static func context(_ reason: String, forScreen: Bool = false) -> LAContext {
        if let approved = takeUnlock(forScreen: forScreen) { return approved }
        let ctx = LAContext()
        ctx.localizedReason = reason
        return ctx
    }

    /// The unlock's context if it covers this read, and in any case the unlock
    /// is used up: its approval covers only the next read.
    static func takeUnlock(forScreen: Bool, now: Date = Date()) -> LAContext? {
        lock.lock(); defer { lock.unlock() }
        let noted = unlock
        unlock = nil
        guard let noted, unlockCovers(notedAt: noted.at, now: now, forScreen: forScreen) else { return nil }
        return noted.context
    }

    /// The rule: a read other than the words screen, within 30 seconds of the unlock.
    static func unlockCovers(notedAt: Date, now: Date, forScreen: Bool) -> Bool {
        let age = now.timeIntervalSince(notedAt)
        return !forScreen && age >= 0 && age < unlockSeconds
    }

    // MARK: What stands in front of the seed

    /// How the person asked for the seed to be kept (the SECURE FOXY card).
    ///
    /// `device` is what an installation with no recorded choice is taken to
    /// be, and what every Foxy did before there was a choice. A NEW
    /// installation records `none` on its first run (FoxyWebView, the install
    /// marker), so it starts unguarded and its user turns the guard on: the seed lives behind `.userPresence`, so reading it is Face ID
    /// or the phone's passcode. `none` keeps it in the older item, which the
    /// phone's own lock screen protects and nothing else — anyone holding the
    /// phone unlocked can spend what is in Foxy. That is offered as a choice;
    /// it is never the default and never arrived at by accident.
    enum Protection: String {
        case device
        case none
    }

    private static let protectionKey = "foxy.seed.protection"

    static var protection: Protection {
        get {
            guard let raw = UserDefaults.standard.string(forKey: protectionKey),
                  let mode = Protection(rawValue: raw) else { return .device }
            return mode
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: protectionKey) }
    }

    /// Move the saved seed to `mode`, or say why it did not.
    ///
    /// The order never leaves the phone without a seed: it is read first, then
    /// written where it is going, then read back from there, and only then is
    /// the copy it came from deleted. A step that fails stops the rest, and the
    /// seed is still wherever it was.
    ///
    /// Going to `.none` reads the seed from behind Face ID, so the person
    /// proves the phone is theirs before the guard comes off. Going to
    /// `.device` needs no proof: putting a lock on is not a thing to defend.
    static func setProtection(_ mode: Protection) -> String? {
        guard mode != protection || mode == .device else { return nil }
        guard passcodeSet || mode == .none else {
            return "This phone has no passcode, so there is no Face ID or passcode to ask for."
        }
        /* Taking the guard off never rides an earlier unlock (audit finding).
         * `seedProtect` has no native confirmation of its own — the page draws
         * the "are you sure" — so this read is the only thing a script in the
         * page cannot answer for the person. Through `context(...)` it took a
         * Face ID unlock's approval when one was still unused, and the guard
         * came off without a prompt. `forScreen` is the rule the words screen
         * already has: always ask. */
        let ctx = context(mode == .none
                          ? "Take Face ID off your wallet"
                          : "Put Face ID in front of your wallet", forScreen: mode == .none)
        let words: String
        switch read(ctx) {
        case .found(let saved): words = saved
        case .absent: 
            // nothing saved yet; the choice still stands for the seed to come
            protection = mode
            return nil
        case .failed(let why): return why
        }

        switch mode {
        case .device:
            /* Put back what it was, not `.none`.
             *
             * On a failure this recorded `.none` whatever it had been — and
             * for the KEEP FACE ID path it had been `.device`. The seed stays
             * in the protected item, so from then on write() uses the plain
             * item and read() still prefers the protected one: two seeds, and
             * a replace would report success while the wallet went on deriving
             * from the old one. */
            let was = protection
            protection = .device
            if let problem = protect(words, ctx) {
                protection = was
                return problem
            }
        case .none:
            // written and read back before anything is deleted
            if let problem = SeedStore.writeSeed(words, replace: true) { return problem }
            guard case .found(let back) = SeedStore.read(key: SeedStore.mnemonicKey), back == words else {
                return "the seed did not read back, so nothing was changed"
            }
            protection = .none
            SeedStore.delete(key: SeedStore.protectedKey)
            SeedStore.delete(key: SeedStore.heldKey)
            if SeedStore.exists(key: SeedStore.protectedKey) != false {
                // the same words in both places: harmless until a replace, which removes it (write)
                print("[foxy] seed: the copy behind Face ID could not be removed; it holds the same words")
            }
        }
        forgetNativeSeed(keepingCandidate: nil)
        print("[foxy] seed: now kept with protection \(mode.rawValue)")
        return nil
    }

    /// From the protected item; else from the older one, moved across on the way.
    private static func read(_ ctx: LAContext) -> Answer {
        let protected = SeedStore.readProtected(key: SeedStore.protectedKey, context: ctx)
        if case .found = protected, case .absent = SeedStore.read(key: SeedStore.heldKey) {
            // moved before the note existed: write it now, while the passcode is set
            _ = SeedStore.save("yes", key: SeedStore.heldKey)
        }
        if let answer = protectedAnswer(protected) { return answer }
        // Only asked when it matters, and a note that cannot be read counts as
        // there: an unreadable keychain is never a phone with nothing hidden.
        let passcode = passcodeSet
        let hidden: Bool = {
            guard !passcode else { return false }
            if case .absent = SeedStore.read(key: SeedStore.heldKey) { return false }
            return true
        }()
        switch olderStep(SeedStore.read(key: SeedStore.mnemonicKey), passcodeSet: passcode, hidden: hidden) {
        case .answer(let answer):
            if case .failed = answer, hidden {
                print("[foxy] seed: behind a passcode this phone no longer has; nothing is made or written")
            }
            return answer
        case .keep(let words):
            print("[foxy] seed: this phone has no passcode, so the seed stays in the older keychain item")
            return .found(words)
        case .move(let words):
            /* Unless the person asked for nothing in front of it. Without this
             * the choice could not stick: the seed would be written to the
             * older item and the very next read would move it straight back
             * behind Face ID, which is what this branch is for. */
            if protection == .none {
                return .found(words)
            }
            if let problem = protect(words, ctx) {
                print("[foxy] seed: not moved behind Face ID (\(problem)); it is still where it was")
            } else {
                print("[foxy] seed: moved behind Face ID or the passcode")
            }
            return .found(words)
        }
    }

    // MARK: The rules, apart from the keychain (FoxyTests/SeedVaultTests.swift)

    /// What the protected item's answer settles: the seed, or a failure. Nil
    /// when it holds nothing, and the older item is asked next.
    static func protectedAnswer(_ result: SeedStore.ReadResult) -> Answer? {
        switch result {
        case .found(let words): return .found(words)
        case .failed(let status): return .failed(describe(status))
        case .absent: return nil
        }
    }

    enum OlderStep: Equatable {
        /// The read's answer, as it is.
        case answer(Answer)
        /// A seed on a phone with no passcode: it stays in the older item.
        case keep(String)
        /// A seed to move behind Face ID or the passcode.
        case move(String)
    }

    static let hiddenBehindPasscode =
        "the seed was saved behind this phone's passcode, which is no longer set. Set a passcode again to open this wallet"

    /// After the protected item held nothing. `hidden`: there is no passcode,
    /// and the note says a seed was put behind one. Then the protected item's
    /// "nothing" cannot be believed, and with nothing in the older item either
    /// the answer is a failure, never "no seed": "no seed" makes the page write
    /// a new one, over a seed the person cannot see (audit I10).
    static func olderStep(_ result: SeedStore.ReadResult, passcodeSet: Bool, hidden: Bool) -> OlderStep {
        switch result {
        case .absent:
            return .answer(hidden ? .failed(hiddenBehindPasscode) : .absent)
        case .failed(let status):
            return .answer(.failed(describe(status)))
        case .found(let words):
            return passcodeSet ? .move(words) : .keep(words)
        }
    }

    enum WriteStep: Equatable {
        case refuse(String)
        /// A different saved seed, with replace asked for: only with a yes.
        case askToReplace
        case write
    }

    /// The write rules against what the read found: a keychain that did not
    /// answer is never written blind, and a different saved seed is replaced
    /// only when the page asked and the person says yes.
    static func writeStep(current: Answer, words: String, replace: Bool) -> WriteStep {
        switch current {
        case .failed(let why):
            return .refuse("The keychain did not answer (\(why)), so nothing was written.")
        case .found(let existing) where existing != words && !replace:
            return .refuse("A different seed is already saved on this phone. Foxy did not replace it.")
        case .found(let existing) where existing != words:
            return .askToReplace
        default:
            return .write
        }
    }

    /// Written to the protected item, read back through the same approval, and
    /// only then the older copy deleted. Nil when done.
    ///
    /// The note that a seed is behind the passcode is written first, and never
    /// taken back here: a seed there with no note is the case the note exists
    /// to catch, while a note with no seed only makes a phone whose passcode is
    /// later removed refuse to make a new seed until it has one again.
    private static func protect(_ words: String, _ ctx: LAContext) -> String? {
        guard SeedStore.save("yes", key: SeedStore.heldKey) else {
            return "the keychain refused the note that the seed is behind the passcode"
        }
        guard SeedStore.saveProtected(words, key: SeedStore.protectedKey, context: ctx) else {
            return "the keychain refused the write"
        }
        /* The write is confirmed without asking the person anything.
         *
         * This used to read the seed straight back to compare it — and reading
         * an item behind Face ID *is* the prompt, so making a wallet put one up
         * on the very first launch, before there was anything to protect
         * ("I deleted app from phone and installed again,
         * asked at the first open"). The quiet read still compares the words
         * whenever the context already carries approval — a restore, where the
         * person has just unlocked — and otherwise settles for the keychain
         * saying the item is there behind them.
         *
         * What that gives up: a keychain that reports a successful write but
         * stored the wrong bytes would not be caught here. It is caught at the
         * first read instead — the words would not parse as a mnemonic, the
         * seed reads as failed, and connect refuses rather than building a
         * wallet on it. */
        switch SeedStore.readProtectedQuietly(key: SeedStore.protectedKey, context: ctx) {
        case .found(let back) where back == words: break
        case .locked: break
        case .found, .absent, .failed: return "it did not read back"
        }
        SeedStore.delete(key: SeedStore.mnemonicKey)
        return nil
    }

    /// A seed write: a new seed (seedCreate), words the page still held from
    /// before the keychain (seedMigrate), or typed words on a restore
    /// (seedAdopt). SeedStore's
    /// rules, against whichever item holds the seed: a different saved seed is
    /// never replaced unless asked, and a keychain that cannot be read is never
    /// written blind. Blocks while iOS asks; call it off the main queue.
    /// A different saved seed is replaced only if `confirmReplace` says yes;
    /// FoxyBridge asks the person in an alert iOS draws. Off the main queue.
    ///
    /// After any write attempt the kept seed is forgotten (all typed words but
    /// `keepCandidate` with it), whatever the keychain answered. A write that
    /// reports a problem is read again: if the keychain holds the new words after
    /// all (the phone locked between the write and its read-back), it is a
    /// success, and the caller finishes the change (review M7).
    static func write(_ words: String, replace: Bool, keepCandidate: String? = nil,
                      confirmReplace: () -> Bool = { false }) -> String? {
        let ctx = context("Save your wallet's seed")
        switch writeStep(current: read(ctx), words: words, replace: replace) {
        case .refuse(let why):
            if why.hasPrefix("A different seed") { print("[foxy] seed write refused: a different seed is already saved") }
            return why
        case .askToReplace:
            guard confirmReplace() else {
                print("[foxy] seed replace declined")
                return "The saved seed was not replaced."
            }
        case .write:
            break
        }
        // the older item on a phone with no passcode, or where the person asked
        // for nothing in front of the seed; the rule above has already run against it
        let attempt = (passcodeSet && protection == .device)
            ? protect(words, ctx)
            : writePlain(words)
        // secrets from the words replaced would be the old wallet's, and a write
        // that failed may still have landed
        forgetNativeSeed(keepingCandidate: keepCandidate)
        let problem = writeOutcome(problem: attempt, words: words) { read(ctx) }
        if let attempt, problem == nil {
            print("[foxy] seed write reported a problem (\(attempt)), but the keychain holds the new words")
        }
        if problem == nil { noteSeedChanged() }
        return problem
    }

    /// The older item, and nothing left behind Face ID.
    ///
    /// `read` asks the protected item first and believes it. A copy left there
    /// — a delete that failed when the guard came off, or on a reinstall —
    /// would go on answering with the OLD words after a replace wrote the new
    /// ones here: the replace reports success, the counters go aside, and the
    /// wallet derives from the seed it was told it had replaced (audit
    /// finding; the same two-seeds trap `setProtection` documents for its
    /// own failure path). So the copy goes with the write, and a copy that will
    /// not go is a write that did not happen.
    private static func writePlain(_ words: String) -> String? {
        if let problem = SeedStore.writeSeed(words, replace: true) { return problem }
        guard SeedStore.exists(key: SeedStore.protectedKey) != false else { return nil }
        SeedStore.delete(key: SeedStore.protectedKey)
        guard SeedStore.exists(key: SeedStore.protectedKey) == false else {
            return "an older copy of the seed behind Face ID could not be removed, so the saved seed was not changed"
        }
        SeedStore.delete(key: SeedStore.heldKey)
        return nil
    }

    /// A write's answer: its problem, unless reading the keychain again finds the
    /// words it was writing. `readBack` runs only after a problem.
    static func writeOutcome(problem: String?, words: String, readBack: () -> Answer) -> String? {
        guard let problem else { return nil }
        if case .found(let now) = readBack(), now == words { return nil }
        return problem
    }

    /// The seed items deleted, and true only when no seed is left there: each
    /// delete is checked by asking, without reading, whether the item is still
    /// there (review L5). The note that a seed is behind the passcode
    /// goes only once the seed has.
    @discardableResult
    static func delete() -> Bool {
        forgetNativeSeed()
        let keys = [SeedStore.protectedKey, SeedStore.mnemonicKey]
        let deleted = keys.map { SeedStore.delete(key: $0) }
        let left = keys.map { SeedStore.exists(key: $0) }
        guard seedGone(deleted: deleted, stillThere: left) else {
            print("[foxy] seed delete: the seed is still there (deleted \(deleted), there \(left))")
            return false
        }
        if !SeedStore.delete(key: SeedStore.heldKey) {
            print("[foxy] seed delete: the note that a seed is behind the passcode was not deleted")
        }
        noteSeedChanged()
        return true
    }

    /// No seed item is left: every one answered "not found" after its delete.
    /// One still there, or one the keychain would not say about, is a seed not deleted.
    static func seedGone(deleted: [Bool], stillThere: [Bool?]) -> Bool {
        deleted.count == stillThere.count && stillThere.allSatisfy { $0 == false }
    }

    static func noteSeedChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: seedChanged, object: nil)
        }
    }

    /// Replacing the seed, after the person's yes in the Replace alert: Face ID
    /// or the device passcode, asked by iOS (review M8). A pasted
    /// lure can lead someone to tap an alert; it cannot give their passcode. A
    /// phone with no passcode has nothing to ask, and the alert's yes stands.
    /// Blocks while iOS asks; never on the main queue. No answer in two minutes is no.
    static func deviceOwnerApproves(reason: String) -> Bool {
        let ctx = LAContext()
        var unavailable: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unavailable) else {
            if unavailable?.code == LAError.passcodeNotSet.rawValue {
                print("[foxy] seed change: no passcode on this phone to ask for")
                return true
            }
            print("[foxy] seed change: Face ID or the passcode cannot be asked (\(unavailable?.code ?? 0)); nothing changed")
            return false
        }
        final class Answer: @unchecked Sendable {
            let lock = NSLock()
            var yes = false
        }
        let answer = Answer()
        let answered = DispatchSemaphore(value: 0)
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            answer.lock.lock()
            answer.yes = ok
            answer.lock.unlock()
            answered.signal()
        }
        if answered.wait(timeout: .now() + ownerAnswerWait) == .timedOut {
            ctx.invalidate()
            print("[foxy] seed change: no Face ID or passcode in \(Int(ownerAnswerWait))s, taken as no")
            return false
        }
        answer.lock.lock(); defer { answer.lock.unlock() }
        // the second half of a replace, beside the alert's answer, so a changed seed
        // in the log always shows both yeses that allowed it
        print("[foxy] seed change: Face ID or the passcode \(answer.yes ? "approved" : "declined")")
        return answer.yes
    }

    static let ownerAnswerWait: TimeInterval = 120

    static func describe(_ status: OSStatus) -> String {
        switch status {
        case errSecUserCanceled: return "Face ID or the passcode was cancelled"
        case errSecAuthFailed: return "Face ID or the passcode did not match"
        case errSecInteractionNotAllowed: return "the phone is locked"
        default: return "status \(status)"
        }
    }
}
