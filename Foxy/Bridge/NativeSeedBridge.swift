import UIKit

/* The seed out of the page (SEED-HANDLING.md). The words stay on the phone:
 * native makes them, shows them, takes typed ones for a restore and writes
 * them. Native also owns the NUT-13 counters, and hands the page secrets only
 * for ranges it has reserved, or for a restore inside NUT-13's scan window.
 *
 * Since stage 4 this is the only path, in Debug and Release builds alike: the
 * page's old word actions (seedRead, seedWrite, seedDelete) are gone from the
 * action table, and there is no switch. Replies are JSON text; errors are
 * plain strings. */

extension FoxyBridge {
    /// The seed actions. Every one answers in every build.
    static let nativeSeedActions: Set<String> = [
        "seedStatus", "seedCreate", "seedMigrate",
        "countersImport", "counterReserve", "counterReserveAt", "counterAdvance", "counterSnapshot",
        "restoreSecrets",
        "p2pkReserve", "p2pkPubkeys", "p2pkKey",
        "cardOwnerKey", "cardOwnerSign",
        "seedShow", "seedEnter", "seedAdopt", "seedCandidateForget", "seedWipe",
        "seedProtection", "seedProtect",
    ]

    /// Keychain reads, the counter file and derivation, one request at a time.
    /// A seed replaced or wiped, and its counters set aside, is never interleaved
    /// with a reservation; and a second request waits for the first one's Face ID
    /// and then finds the seed it kept, rather than asking again.
    static let seedQueue = DispatchQueue(label: "io.getfoxi.foxy.nativeSeed", qos: .userInitiated)

    /// The most counters one request derives.
    static let largestSecretsBatch = 1000

    /// A JavaScript number that is a whole number JavaScript holds exactly. Not
    /// a boolean, which WebKit also hands over as an NSNumber, and not a string.
    static func exactInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded(.towardZero) == double,
              abs(double) <= 9_007_199_254_740_991 else { return nil }
        return Int(exactly: double)
    }

    // MARK: Input checks, before anything is read (FoxyTests/NativeSeedTests.swift)

    enum NativeCheck<Value: Equatable>: Equatable {
        case ok(Value)
        case refuse(String)
    }

    // The request types, replies and errors live in SeedActions
    // (Foxy/Keychain/SeedActions.swift), where tools/nativetests reaches them.
    typealias CounterRequest = SeedActions.CounterRequest
    typealias RestoreRequest = SeedActions.RestoreRequest
    typealias AdvanceRequest = SeedActions.AdvanceRequest
    typealias P2PKRange = SeedActions.P2PKRange
    typealias Refusal = SeedActions.Refusal
    typealias MigrateOutcome = SeedMigrationWindow.Outcome

    /// The most keysets one countersImport carries: no more than the counter file holds.
    static let mostImportedKeysets = CounterRules.mostKeysets

    /// A hex keyset id, 00 and 16 characters or 01 and 66, lowercased.
    static func keyset(_ value: Any?) -> (id: String, version: UInt8)? {
        guard let id = value as? String, let version = NUT13.keysetVersion(id) else { return nil }
        return (id.lowercased(), version)
    }

    /// A counter from the page: a whole number from 0 to 2^53 − 1.
    static func counterValue(_ value: Any?) -> UInt64? {
        guard let n = exactInteger(value), n >= 0 else { return nil }
        return UInt64(n)
    }

    /// counterReserve {keysetId, count}: count 0 (a peek) to 1000.
    static func counterReserveCheck(_ body: [String: Any]) -> NativeCheck<CounterRequest> {
        guard let k = keyset(body["keysetId"]),
              let count = exactInteger(body["count"]), (0...largestSecretsBatch).contains(count) else {
            return .refuse("bad request")
        }
        return .ok(CounterRequest(keysetId: k.id, version: k.version, start: 0, count: count))
    }

    /// counterReserveAt and restoreSecrets' range {keysetId, start, count}: count
    /// 1 to 1000, and every counter in it one the keyset's version has, the last
    /// as well as the first. A 00 keyset's counter is a hardened index below
    /// 2^31; a 01 keyset's stops at 2^53 − 1, where cashu-ts stops.
    static func counterRangeCheck(_ body: [String: Any]) -> NativeCheck<CounterRequest> {
        guard let k = keyset(body["keysetId"]),
              let start = counterValue(body["start"]),
              let count = exactInteger(body["count"]), (1...largestSecretsBatch).contains(count),
              NUT13.countersFit(version: k.version, start: start, count: count) else {
            return .refuse("bad request")
        }
        return .ok(CounterRequest(keysetId: k.id, version: k.version, start: start, count: count))
    }

    static func counterReserveAtCheck(_ body: [String: Any]) -> NativeCheck<CounterRequest> {
        counterRangeCheck(body)
    }

    /// restoreSecrets {keysetId, start, count, candidate?}. A candidate of null
    /// is no candidate: the saved seed, under the stricter window.
    static func restoreSecretsCheck(_ body: [String: Any]) -> NativeCheck<RestoreRequest> {
        let range: CounterRequest
        switch counterRangeCheck(body) {
        case .refuse(let why): return .refuse(why)
        case .ok(let asked): range = asked
        }
        switch body["candidate"] {
        case nil, is NSNull:
            return .ok(RestoreRequest(range: range, candidate: nil))
        case let candidate as String where !candidate.isEmpty && candidate.utf8.count <= 64:
            return .ok(RestoreRequest(range: range, candidate: candidate))
        default:
            return .refuse("bad request")
        }
    }

    /// counterAdvance {keysetId, next}.
    static func counterAdvanceCheck(_ body: [String: Any]) -> NativeCheck<AdvanceRequest> {
        guard let k = keyset(body["keysetId"]), let next = counterValue(body["next"]) else { return .refuse("bad request") }
        return .ok(AdvanceRequest(keysetId: k.id, next: next))
    }

    /// p2pkReserve {count}: 0 (a peek) to 64 lock keys.
    static func p2pkReserveCheck(_ body: [String: Any]) -> NativeCheck<Int> {
        guard let count = exactInteger(body["count"]), (0...P2PK.mostReserved).contains(count) else {
            return .refuse("bad request")
        }
        return .ok(count)
    }

    /// p2pkPubkeys {start, count}: count 1 to 300, every index a normal BIP-32
    /// child, and none past 20,000 — the last one as well as the first.
    static func p2pkPubkeysCheck(_ body: [String: Any]) -> NativeCheck<P2PKRange> {
        guard let start = counterValue(body["start"]),
              let count = exactInteger(body["count"]), (1...P2PK.mostScanned).contains(count),
              P2PK.scanFits(start: start, count: count) else {
            return .refuse("bad request")
        }
        return .ok(P2PKRange(start: start, count: count))
    }

    /// p2pkKey {index}: an index a normal BIP-32 child has. Whether this phone
    /// will answer for it is the window's question (SeedActions.p2pkKey), not
    /// this one's.
    static func p2pkKeyCheck(_ body: [String: Any]) -> NativeCheck<UInt64> {
        guard let index = counterValue(body["index"]), index <= P2PK.lastIndex else { return .refuse("bad request") }
        return .ok(index)
    }

    /// cardOwnerKey {key}: a card's compressed public key, 66 hex characters (either
    /// case) for 33 bytes that start 02 or 03. Answers the bytes. Which card it is
    /// is not this check's question, and nothing is read until it has passed.
    static func cardOwnerKeyCheck(_ body: [String: Any]) -> NativeCheck<[UInt8]> {
        guard let key = CardOwner.key(from: body["key"]) else { return .refuse("bad request") }
        return .ok(key)
    }

    /// cardOwnerSign {key, label, nonce, value}: the key as above; the label exactly
    /// one of change-pin, set-limit, set-owner, set-card and load; the nonce 32 hex
    /// characters; the value hex of the shape that label takes (empty for load).
    /// CardOwner.signRequest holds the rules, so the Mac's tests run them.
    static func cardOwnerSignCheck(_ body: [String: Any]) -> NativeCheck<CardOwner.SignRequest> {
        guard let request = CardOwner.signRequest(body) else { return .refuse("bad request") }
        return .ok(request)
    }

    /// countersImport {counters: {id: n}}: every id a 00 or 01 hex keyset id and
    /// every value a safe integer, or the whole import is refused. Ids that differ
    /// only in case are one keyset, at the larger value.
    static func countersImportCheck(_ body: [String: Any]) -> NativeCheck<[String: UInt64]> {
        guard let given = body["counters"] as? [String: Any], given.count <= mostImportedKeysets else {
            return .refuse("bad request")
        }
        var out: [String: UInt64] = [:]
        for (id, value) in given {
            guard let k = keyset(id), let n = counterValue(value) else { return .refuse("bad request") }
            out[k.id] = max(out[k.id] ?? 0, n)
        }
        return .ok(out)
    }

    /// seedAdopt and seedCandidateForget {candidate}.
    static func candidateCheck(_ body: [String: Any]) -> NativeCheck<String> {
        guard let candidate = body["candidate"] as? String, !candidate.isEmpty, candidate.utf8.count <= 64 else {
            return .refuse("bad request")
        }
        return .ok(candidate)
    }

    /// The longest words text seedMigrate reads: 24 of the longest words (eight
    /// letters) with their spaces is 215 bytes. Anything longer is not a seed.
    static let mostMigrateBytes = 1000

    /// seedMigrate {words}: a BIP-39 phrase, 12 to 24 words from the English
    /// list with a right checksum, as one string separated by spaces (as the
    /// page's seedWrite sent it) or as an array of words. Answers the phrase
    /// joined with single spaces, which is how the page wrote and saved words.
    static func seedMigrateCheck(_ body: [String: Any], wordlist: [String]) -> NativeCheck<String> {
        let words: [String]
        switch body["words"] {
        case let text as String where text.utf8.count <= mostMigrateBytes:
            // as the page stored them: spaces trimmed and collapsed by the split, capitals folded
            words = text.split(whereSeparator: { $0.isWhitespace }).map { $0.lowercased() }
        case let list as [Any] where list.count <= 24:
            guard let strings = list as? [String] else { return .refuse("bad request") }
            words = strings.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        default:
            return .refuse("bad request")
        }
        guard BIP39.isValid(words, wordlist: wordlist) else { return .refuse("bad request") }
        return .ok(words.joined(separator: " "))
    }

    // MARK: Replies

    static func json(_ object: [String: Any]) -> String {
        SeedActions.json(object)
    }

    static func countersReply(_ counters: [String: UInt64]) -> String {
        SeedActions.countersReply(counters)
    }

    static func problem(_ error: Error) -> String {
        SeedActions.problem(error)
    }

    /// seedMigrate's decision, for FoxyTests (SeedActions.decideMigration).
    static func migrate(_ phrase: String, windowOpen: Bool, saved: SeedVault.SecretsSeed,
                        write: (String) -> String?) -> MigrateOutcome {
        SeedActions.decideMigration(phrase, windowOpen: windowOpen, saved: saved, write: write)
    }

    static func migrateReply(_ outcome: MigrateOutcome) -> SeedReply {
        SeedActions.migrateReply(outcome)
    }

    /// Runs an action on seedQueue with the app's environment, and answers.
    private func onSeedQueue(id: String, _ action: @escaping (SeedEnvironment) -> SeedReply) {
        Self.seedQueue.async {
            let reply = action(.live)
            self.resolve(id: id, text: reply.text, error: reply.error)
        }
    }

    // MARK: Seed status and creation

    /// { quiet } → {"exists": true|false}. Quiet asks the keychain whether an
    /// item is there and nothing more; without it the seed is read, which is
    /// Face ID or the passcode.
    func handleSeedStatus(id: String, body: [String: Any]) {
        let quiet = body["quiet"] as? Bool ?? false
        onSeedQueue(id: id) { SeedActions.status($0, quiet: quiet) }
    }

    /// {} → {"mode": "device"|"none", "passcode": true|false}. Asks nothing.
    func handleSeedProtection(id: String, body: [String: Any]) {
        onSeedQueue(id: id) { SeedActions.protection($0) }
    }

    /// { mode } → {"mode": …}. The SECURE FOXY card's answer: what the person
    /// wants standing in front of the seed. Taking Face ID off reads the seed
    /// from behind it first, so iOS asks before the guard comes off.
    func handleSeedProtect(id: String, body: [String: Any]) {
        let mode = body["mode"] as? String ?? ""
        onSeedQueue(id: id) { SeedActions.setProtection($0, mode: mode) }
    }

    /// {} → {"created": true}, or "a seed already exists".
    func handleSeedCreate(id: String, body: [String: Any]) {
        guard beginSeedChange(id: id) else { return }
        Self.seedQueue.async {
            let made = SeedActions.create(.live)
            self.endSeedChange(id: id, text: made.text, error: made.error)
        }
    }

    // MARK: Moving words the page still holds

    /// {words} → {"migrated": true} | {"migrated": false, "same": true} |
    /// {"migrated": false, "different": true}, or "bad request".
    ///
    /// For an install that still holds words in the page's storage from before
    /// the keychain, or a seed the page made and never saved. The words are
    /// checked first in every case, never answered back, and not kept: they live
    /// in this request only. They are written only inside the one-time window
    /// (SeedMigrationWindow) and only where no seed is saved; outside it a saved
    /// seed is still compared, and with none saved the answer is "no migration
    /// here". The counters are left alone: the page's own counters come across
    /// with countersImport, and setting them aside here would lose them.
    func handleSeedMigrate(id: String, body: [String: Any]) {
        guard let wordlist = BIP39.english else {
            return resolve(id: id, text: nil, error: "the wordlist could not be checked")
        }
        let phrase: String
        switch Self.seedMigrateCheck(body, wordlist: wordlist) {
        case .refuse(let why): return resolve(id: id, text: nil, error: why)
        case .ok(let asked): phrase = asked
        }
        // one seed change at a time: nothing replaces or wipes the seed between the read and the write
        guard beginSeedChange(id: id) else { return }
        Self.seedQueue.async {
            // the window is read here, on seedQueue, where the answer that closes it is given
            let reply = SeedActions.migrate(phrase, env: .live)
            self.endSeedChange(id: id, text: reply.text, error: reply.error)
        }
    }

    // MARK: Counters

    /// {counters: {id: n}} → {"counters": {...}}, per keyset the larger value;
    /// once per install, then "counters were already imported".
    func handleCountersImport(id: String, body: [String: Any]) {
        switch Self.countersImportCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let incoming): onSeedQueue(id: id) { SeedActions.countersImport(incoming, env: $0) }
        }
    }

    /// {} → {"counters": {...}}.
    func handleCounterSnapshot(id: String, body: [String: Any]) {
        onSeedQueue(id: id) { SeedActions.counterSnapshot($0) }
    }

    /// {keysetId, next} → {"keysetId", "next"}: the value now stored, never
    /// lower; "too far ahead" past CounterRules.advance.
    func handleCounterAdvance(id: String, body: [String: Any]) {
        switch Self.counterAdvanceCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.counterAdvance(request, env: $0) }
        }
    }

    /// {keysetId, count} → {"keysetId", "start", "secrets", "blindingFactors"}
    /// for `next ..< next + count`, which is reserved first. Count 0 is a peek.
    func handleCounterReserve(id: String, body: [String: Any]) {
        switch Self.counterReserveCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.counterReserve(request, env: $0) }
        }
    }

    /// {keysetId, start, count} → as counterReserve, for exactly that range; the
    /// counters below it are burnt. A start below next is "range already issued",
    /// and one more than 100 past it "too far ahead".
    func handleCounterReserveAt(id: String, body: [String: Any]) {
        switch Self.counterReserveAtCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.counterReserveAt(request, env: $0) }
        }
    }

    // MARK: Restore

    /// {keysetId, start, count, candidate?} → as counterReserve, counters unchanged.
    /// The saved seed only inside RestoreWindow; a candidate's words from 0,
    /// contiguously, up to 20,000 per keyset.
    func handleRestoreSecrets(id: String, body: [String: Any]) {
        switch Self.restoreSecretsCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.restoreSecrets(request, env: $0) }
        }
    }

    // MARK: The keys a payment request locks ecash to (P2PK.swift)

    /// {count} → {"start", "next", "pubkeys"} for `next ..< next + count`, which
    /// is reserved first. Count 0 is a peek. Public halves only.
    func handleP2PKReserve(id: String, body: [String: Any]) {
        switch Self.p2pkReserveCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let count): onSeedQueue(id: id) { SeedActions.p2pkReserve(count: count, env: $0) }
        }
    }

    /// {start, count} → the same shape for exactly that range, moving nothing.
    /// The scan a restore uses to find which index a token in hand is locked to.
    func handleP2PKPubkeys(id: String, body: [String: Any]) {
        switch Self.p2pkPubkeysCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let range): onSeedQueue(id: id) { SeedActions.p2pkPubkeys(range, env: $0) }
        }
    }

    /// {index} → {"index", "privkey", "pubkey"}: one lock key's private half,
    /// inside 300 of the last index reserved or inside a range this session's
    /// scan served. "outside the lock-key window" otherwise.
    func handleP2PKKey(id: String, body: [String: Any]) {
        switch Self.p2pkKeyCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let index): onSeedQueue(id: id) { SeedActions.p2pkKey(index: index, env: $0) }
        }
    }

    // MARK: A card's owner key (CardOwner, in NUT13.swift)

    /// {key} → {"pub"}: the owner public key for the card at `key`, 130 hex
    /// characters. The private half is derived from the seed and never leaves.
    func handleCardOwnerKey(id: String, body: [String: Any]) {
        switch Self.cardOwnerKeyCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let key): onSeedQueue(id: id) { SeedActions.cardOwnerKey(key: key, env: $0) }
        }
    }

    /// {key, label, nonce, value} → {"sig"}: the owner key's signature for one of
    /// five labels and the shape of value it takes, which is all the page can have
    /// signed. Refused with "bad request", before the seed is read, otherwise.
    func handleCardOwnerSign(id: String, body: [String: Any]) {
        switch Self.cardOwnerSignCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.cardOwnerSign(request, env: $0) }
        }
    }

    // MARK: Screens

    /// {verify} → {"verified": true|false} once the screen is closed. The words
    /// are read here, under the usual unlock, and go only to the screen.
    /// Refused while a seed screen is queued or open, and for ten seconds after
    /// a read that failed, so a script cannot line up Face ID prompts (L1).
    func handleSeedShow(id: String, body: [String: Any]) {
        let verify = (body["verify"] as? Bool) ?? false
        SeedScreens.watchSeedChanges()
        guard !SeedScreens.queue.busy else {
            return resolve(id: id, text: nil, error: SeedScreens.busyRefusal)
        }
        guard !SeedScreens.showPause.refuses(at: Date()) else {
            return resolve(id: id, text: nil, error: SeedScreens.pauseRefusal)
        }
        SeedScreens.queue.enqueue(onCancel: {
            self.resolve(id: id, text: Self.json(["verified": false]), error: nil)
        }) { finished in
            let turn = SeedScreens.queue.generation
            // On the queue every seed change runs on, so the read never races a
            // replace or a wipe (L4).
            Self.seedQueue.async {
                let saved = SeedVault.wordsForScreen()
                DispatchQueue.main.async {
                    // closed while it read (the background, the page, a seed change): no screen
                    guard SeedScreens.queue.generation == turn else {
                        self.resolve(id: id, text: Self.json(["verified": false]), error: nil)
                        return finished()
                    }
                    let text: String
                    switch saved {
                    case .absent:
                        self.resolve(id: id, text: nil, error: "no seed")
                        return finished()
                    case .failed:
                        SeedScreens.showPause.start(at: Date())
                        self.resolve(id: id, text: nil, error: "the seed could not be read")
                        return finished()
                    case .found(let found):
                        text = found
                    }
                    let list = text.split(separator: " ").map(String.init)
                    guard [12, 15, 18, 21, 24].contains(list.count) else {
                        self.resolve(id: id, text: nil, error: "the seed could not be read")
                        return finished()
                    }
                    guard let presenter = self.presenter else {
                        self.resolve(id: id, text: nil, error: "Nothing to present the screen from.")
                        return finished()
                    }
                    // `revealed`: whether TAP TO REVEAL was pressed, so the page's VERIFY WORDS waits for it
                    let screen = SeedShowController(words: list, startOnQuiz: verify) { verified, deleteAsked, revealed in
                        self.resolve(id: id, text: Self.json(["verified": verified, "delete": deleteAsked, "revealed": revealed]), error: nil)
                        finished()
                    }
                    SeedScreens.present(screen, on: presenter)
                }
            }
        }
    }

    /// {} → {"candidate": id} for a checked phrase, or "cancelled".
    func handleSeedEnter(id: String, body: [String: Any]) {
        SeedScreens.watchSeedChanges()
        guard !SeedScreens.queue.busy else {
            return resolve(id: id, text: nil, error: SeedScreens.busyRefusal)
        }
        // refused before the screen, rather than after the words are typed
        guard SeedCandidates.shared.count < SeedCandidates.most else {
            return resolve(id: id, text: nil, error: "too many candidates")
        }
        guard let wordlist = BIP39.english else {
            return resolve(id: id, text: nil, error: "the wordlist could not be checked")
        }
        SeedScreens.queue.enqueue(onCancel: {
            self.resolve(id: id, text: nil, error: "cancelled")
        }) { finished in
            guard let presenter = self.presenter else {
                self.resolve(id: id, text: nil, error: "Nothing to present the screen from.")
                return finished()
            }
            let screen = SeedEnterController(wordlist: wordlist) { phrase in
                defer { finished() }
                guard let phrase else {
                    return self.resolve(id: id, text: nil, error: "cancelled")
                }
                // checked on the screen; checked again before it is kept
                guard BIP39.isValid(phrase.split(separator: " ").map(String.init), wordlist: wordlist) else {
                    return self.resolve(id: id, text: nil, error: "the words could not be read")
                }
                do {
                    let candidate = try SeedCandidates.shared.add(phrase)
                    self.resolve(id: id, text: Self.json(["candidate": candidate]), error: nil)
                } catch {
                    self.resolve(id: id, text: nil, error: Self.problem(error))
                }
            }
            SeedScreens.present(screen, on: presenter)
        }
    }

    // MARK: Adopting typed words, and wiping

    /// {candidate} → {"adopted": false, "same": true} for the saved words;
    /// otherwise the Replace alert and then Face ID or the passcode, then
    /// {"adopted": true} or "Nothing was changed.". Either way the counters are
    /// raised to where the typed words were served, and the candidate is kept.
    func handleSeedAdopt(id: String, body: [String: Any]) {
        let candidate: String
        switch Self.candidateCheck(body) {
        case .refuse(let why): return resolve(id: id, text: nil, error: why)
        case .ok(let asked): candidate = asked
        }
        guard SeedCandidates.shared.contains(candidate) else {
            return resolve(id: id, text: nil, error: "unknown candidate")
        }
        guard beginSeedChange(id: id) else { return }
        // On seedQueue for the whole change, alert and passcode included: no
        // counter is reserved against either seed between the yes and the
        // counters going aside.
        Self.seedQueue.async {
            let reply = SeedActions.adopt(candidate, env: .live) {
                guard self.confirmSeedChangeAndWait(
                    title: Self.replaceSeedTitle, message: Self.noPasscodeNote(Self.replaceSeedMessage, "replaced"),
                    action: "Replace") else { return false }
                // a yes a pasted lure led someone to is not enough: the device owner, asked by iOS (M8)
                return SeedVault.deviceOwnerApproves(reason: Self.replaceSeedReason)
            }
            self.endSeedChange(id: id, text: reply.text, error: reply.error)
        }
    }

    /// What iOS says when it asks for Face ID or the passcode to replace the seed.
    static let replaceSeedReason = "Replace this wallet's seed"

    /// A seed alert's message, and on a phone with no passcode a sentence saying
    /// nothing else will be asked: iOS has no Face ID or passcode to ask there, so
    /// the change goes ahead on this alert alone (a deliberate decision).
    static func noPasscodeNote(_ message: String, _ what: String) -> String {
        SeedVault.passcodeSet ? message
            : message + " This iPhone has no passcode, so nothing else will be asked before the seed is \(what)."
    }

    /// What iOS says when it asks for Face ID or the passcode to delete the seed.
    static let deleteSeedReason = "Delete this wallet's seed"

    /// {candidate} → {"forgotten": true}, known or not.
    func handleSeedCandidateForget(id: String, body: [String: Any]) {
        let candidate: String
        switch Self.candidateCheck(body) {
        case .refuse(let why): return resolve(id: id, text: nil, error: why)
        case .ok(let asked): candidate = asked
        }
        let reply = SeedActions.candidateForget(candidate, env: .live)
        resolve(id: id, text: reply.text, error: reply.error)
    }

    /// {} → the Delete alert and then Face ID or the passcode, then
    /// {"wiped": true, "created": true}: the seed
    /// deleted and checked gone ("the seed could not be deleted" otherwise, with
    /// nothing else changed), its counters set aside, every candidate dropped and
    /// a new seed made. No: "Nothing was erased.".
    ///
    /// The only delete the bridge has. The page's seedDelete, which left no seed,
    /// is gone: a delete with no new seed beside it let a script follow it with
    /// a seed of its own choosing.
    func handleSeedWipe(id: String, body: [String: Any]) {
        guard beginSeedChange(id: id) else { return }
        confirmSeedChange(title: Self.deleteSeedTitle, message: Self.noPasscodeNote(Self.deleteSeedMessage, "deleted"),
                          action: "Delete") { yes in
            guard yes else {
                return self.endSeedChange(id: id, text: nil, error: "Nothing was erased.")
            }
            Self.seedQueue.async {
                // The rule: deleting the seed asks for the
                // device owner too, as replacing it does. A yes in an alert is one
                // tap from anyone holding an unlocked phone with Foxy open; the
                // words are recoverable only from paper once they are gone.
                guard SeedVault.deviceOwnerApproves(reason: Self.deleteSeedReason) else {
                    return self.endSeedChange(id: id, text: nil, error: "Nothing was erased.")
                }
                let reply = SeedActions.wipe(.live)
                self.endSeedChange(id: id, text: reply.text, error: reply.error)
            }
        }
    }
}
