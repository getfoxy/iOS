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
        "cashuIdPublic", "cashuIdSign", "cashuIdTag", "cashuIdEphemeral", "cashuIdSignUnblinded",
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

    /// A compressed point as the page hands one over: 66 hex characters (either
    /// case) for 33 bytes starting 02 or 03. Whether it is on the curve is the
    /// seed's question, asked after.
    static func pointText(_ value: Any?) -> [UInt8]? {
        guard let text = value as? String, text.utf8.count == 66,
              let bytes = try? NUT13.bytes(hex: text.lowercased()), CashuID.isPoint(bytes) else { return nil }
        return bytes
    }

    /// cashuIdSign {pieces: [{secret, e}]}: 1 to 100 pieces, each a NUT-10 P2PK
    /// secret of at most 1,024 characters that does not ask for SIG_ALL, with the
    /// E it carried (`p2pk_e`) as a point. Whether each is locked to this ID's
    /// blinding by its E is the seed's question (CashuID.sign), asked after.
    static func cashuIdSignCheck(_ body: [String: Any]) -> NativeCheck<SeedActions.CashuIdSignRequest> {
        guard let list = body["pieces"] as? [Any], !list.isEmpty, list.count <= CashuID.mostSecrets else {
            return .refuse("bad request")
        }
        var pieces = [CashuID.Piece]()
        for item in list {
            guard let piece = item as? [String: Any], let secret = piece["secret"] as? String,
                  CashuID.lockOf(secret) != nil, let e = pointText(piece["e"]) else { return .refuse("bad request") }
            pieces.append(CashuID.Piece(secret: secret, e: e))
        }
        return .ok(SeedActions.CashuIdSignRequest(pieces: pieces))
    }

    /// cashuIdSignUnblinded {secrets}: 1 to 100 NUT-10 P2PK secrets of at most 1,024 characters that do not ask
    /// for SIG_ALL. Whether each is locked to this ID as it is is the seed's question (CashuID.signUnblinded).
    static func cashuIdSignUnblindedCheck(_ body: [String: Any]) -> NativeCheck<SeedActions.CashuIdSignUnblindedRequest> {
        guard let list = body["secrets"] as? [Any], !list.isEmpty, list.count <= CashuID.mostSecrets else {
            return .refuse("bad request")
        }
        var secrets = [String]()
        for item in list {
            guard let secret = item as? String, CashuID.lockOf(secret) != nil else { return .refuse("bad request") }
            secrets.append(secret)
        }
        return .ok(SeedActions.CashuIdSignUnblindedRequest(secrets: secrets))
    }

    /// cashuIdTag {peer, e}: two points, the other wallet's ID and the E the tag is bound to.
    static func cashuIdTagCheck(_ body: [String: Any]) -> NativeCheck<SeedActions.CashuIdTagRequest> {
        guard let peer = pointText(body["peer"]), let e = pointText(body["e"]) else { return .refuse("bad request") }
        return .ok(SeedActions.CashuIdTagRequest(peer: peer, e: e))
    }

    /// cashuIdEphemeral {to, index, locktime}: the receiver's ID as a point (not `id`,
    /// which names the request itself), the
    /// payment's index below 2^32 and its locktime, a whole number of seconds.
    static func cashuIdEphemeralCheck(_ body: [String: Any]) -> NativeCheck<SeedActions.CashuIdEphemeralRequest> {
        guard let id = pointText(body["to"]),
              let index = exactInteger(body["index"]), index >= 0, index <= Int(UInt32.max),
              let locktime = exactInteger(body["locktime"]), locktime >= 0 else { return .refuse("bad request") }
        return .ok(SeedActions.CashuIdEphemeralRequest(id: id, index: UInt32(index), locktime: UInt64(locktime)))
    }

    /// cardOwnerKey {key}: a card's compressed public key, 66 hex characters (either
    /// case) for 33 bytes that start 02 or 03. Answers the bytes. Which card it is
    /// is not this check's question, and nothing is read until it has passed.
    static func cardOwnerKeyCheck(_ body: [String: Any]) -> NativeCheck<[UInt8]> {
        guard let key = CardOwner.key(from: body["key"]) else { return .refuse("bad request") }
        return .ok(key)
    }

    /// cardOwnerSign {key, label, nonce, value}: the key as above; the label exactly
    /// one of change-pin, set-limit, set-owner, set-card, load and reset; the nonce 32 hex
    /// characters; the value hex of the shape that label takes (empty for load and reset).
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
    ///
    /// A write asks first, as seedAdopt does: the Save alert, then Face ID or the
    /// passcode, asked by iOS. Only a write: a compare asks nothing. A page
    /// script in the window, on a phone with no seed saved yet, could otherwise
    /// make words it knew the wallet's seed and receive everything sent to it.
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
            let reply = SeedActions.migrate(phrase, env: .live) {
                guard self.confirmSeedChangeAndWait(
                    title: Self.migrateSeedTitle, message: Self.noPasscodeNote(Self.migrateSeedMessage, "saved"),
                    action: "Save") else { return false }
                // the device owner too, as for a replace: a yes in an alert is one tap from a lure
                return SeedVault.deviceOwnerApproves(reason: Self.migrateSeedReason)
            }
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

    // MARK: The Cashu ID (CashuID.swift)

    /// {} → {"id", "nostr", "sig"}: the ID's public key, its delivery key's, and the ID key's signature binding them.
    func handleCashuIdPublic(id: String, body: [String: Any]) {
        onSeedQueue(id: id) { SeedActions.cashuIdPublic($0) }
    }

    /// {pieces} → {"sigs"}: each piece's one-time key's signature, for secrets
    /// locked to this ID's blinding by that piece's E alone. No key is answered.
    func handleCashuIdSign(id: String, body: [String: Any]) {
        switch Self.cashuIdSignCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.cashuIdSign(pieces: request.pieces, env: $0) }
        }
    }

    /// {secrets} → {"sigs"}: the ID key's own signatures, over secrets locked to the ID unblinded, for the one
    /// delivery the receiver said TAKE IT ANYWAY to (CashuID.signUnblinded). No key is answered.
    func handleCashuIdSignUnblinded(id: String, body: [String: Any]) {
        switch Self.cashuIdSignUnblindedCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.cashuIdSignUnblinded(secrets: request.secrets, env: $0) }
        }
    }

    /// {peer, e} → {"tag"}: the payer's name on a delivery, proved (CashuID.tag).
    func handleCashuIdTag(id: String, body: [String: Any]) {
        switch Self.cashuIdTagCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request): onSeedQueue(id: id) { SeedActions.cashuIdTag(peer: request.peer, e: request.e, env: $0) }
        }
    }

    /// {to, index, locktime} → {"base"}: what a payment's throwaway keys come from (CashuID.payBase).
    func handleCashuIdEphemeral(id: String, body: [String: Any]) {
        switch Self.cashuIdEphemeralCheck(body) {
        case .refuse(let why): resolve(id: id, text: nil, error: why)
        case .ok(let request):
            onSeedQueue(id: id) { SeedActions.cashuIdEphemeral(id: request.id, index: request.index, locktime: request.locktime, env: $0) }
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

    /// {key, label, nonce, value, refundIndex?} → {"sig"}: the owner key's
    /// signature for one of six labels and the shape of value it takes, which is
    /// all the page can have signed. Refused with "bad request", before the seed
    /// is read, otherwise.
    ///
    /// Load, which is every top-up, signs as it always has. Every other label
    /// signs only against the keeper's yes, given before the card was held up
    /// (`cardOwnerApprove`), which it uses up: the same bytes for change-pin,
    /// reset and set-owner; the mint and unit chosen for set-card (a move written
    /// at a later tap uses the yes kept for that card); the figures chosen for
    /// set-limit, every other figure the card's own as it said it in this tap.
    /// A yes that named a lift (a withdrawal's, a reset's, a transfer's) signs
    /// lifts in its session: limits to 0 from what the card said, one at a time
    /// (CardOwner.isLift); what they were is kept on the phone (CardLifts) and the
    /// set-limit that puts exactly that back signs, in this tap or a later one.
    /// Two things sign with no yes because they change nothing the keeper chose
    /// (CardOwner.signsUnasked): a rate written before a top-up with the card's
    /// own figures, and a record at the card's own mint and unit, whose refund
    /// key SeedActions checks is this phone's. These are looked at before any yes,
    /// so that none of them uses up a yes the keeper gave for something else.
    /// Nothing is asked during the tap. Anything else is CardOwner.declined.
    func handleCardOwnerSign(id: String, body: [String: Any]) {
        let request: CardOwner.SignRequest
        switch Self.cardOwnerSignCheck(body) {
        case .refuse(let why): return resolve(id: id, text: nil, error: why)
        case .ok(let asked): request = asked
        }
        guard request.label != .load else {
            return onSeedQueue(id: id) { SeedActions.cardOwnerSign(request, env: $0) }
        }
        // a new owner key that is no key is refused before anything else
        guard request.label != .setOwner || CardOwner.isOwnerKey(request.value) else {
            return resolve(id: id, text: nil, error: "bad request")
        }
        guard cardOwnerAllows(request) else { return resolve(id: id, text: nil, error: CardOwner.declined) }
        onSeedQueue(id: id) { SeedActions.cardOwnerSign(request, env: $0) }
    }

    /// Whether the owner key signs `request` (any label but load), by the rules
    /// above; a yes it uses is used up, a lift it signs is kept, and what the card
    /// will hold after it is what the tap's next request is held to.
    func cardOwnerAllows(_ request: CardOwner.SignRequest) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        let now = Date().timeIntervalSince1970
        dropSpentCardApprovals(now: now)
        // the card held gave its key in this tap (GET_KEY), and what is signed is for it
        guard let key = cardSeen.key, key == request.key else {
            print("[foxy] card: \(request.label.rawValue) not signed: it is not for the card held, as it gave its key in this tap")
            return false
        }
        let inSession: ((approval: CardOwner.Approval, session: Int?)) -> Bool = { $0.session == self.cardSession && self.cardSessionOpen }
        let lifts = request.label == .setLimit ? CardLifts.kept() : []
        if cardApprovals.contains(where: { inSession($0) && $0.approval.lift == true && CardOwner.matches(request, $0.approval, seen: cardSeen) }),
           CardOwner.mayLift(request.key, seen: cardSeen, kept: lifts), let limits = cardSeen.limits {
            // kept for its session: a card of two currencies is lifted once for each, and put back between
            CardLifts.keep(CardOwner.Lift(card: request.key, from: limits))
            print("[foxy] card: its limit lifted against the keeper's yes before the tap; what it was is kept until it is put back")
        } else if CardOwner.signsUnasked(request, seen: cardSeen) {
            print("[foxy] card: \(request.label.rawValue) signed unasked: it changes nothing the keeper chose")
        } else if CardOwner.putsBack(request, lifts, seen: cardSeen) != nil {
            // kept until the card is seen holding it (cardSaw): one that never reached the card is asked again
            print("[foxy] card: its limit put back as it was before it was lifted")
        } else if let i = cardApprovals.firstIndex(where: { inSession($0) && $0.approval.lift != true
                                                           && CardOwner.matches(request, $0.approval, seen: cardSeen) }) {
            cardApprovals.remove(at: i)
            // limits the keeper has just chosen: a lift from before them is not put back over them
            if request.label == .setLimit { CardLifts.drop(card: request.key) }
            print("[foxy] card: \(request.label.rawValue) signed against the keeper's yes before the tap")
        } else if request.label == .setCard, CardMoves.matches(request, seen: cardSeen) {
            // kept until the card takes it (SET_CARD answered 9000, cardSaw): a record that never reached the card is signed again
            cardSeen.moveSigned = request.key
            print("[foxy] card: a move the keeper said yes to earlier is written now")
        } else {
            print("[foxy] card: \(request.label.rawValue) not signed: the keeper said yes to nothing like it")
            return false
        }
        // what the card holds once it takes this, for what is asked after it in the tap
        cardSeen = CardOwner.seen(after: request, cardSeen)
        return true
    }

    /// {label, …} → {"approved": true}, or CardOwner.declined: the keeper's yes to
    /// one owner's command, asked at the screen where it begins and before the card
    /// session (CardOwner.approval for what each label names). The phone's own
    /// alert, its words built from what the approval holds (CardOwner.question);
    /// then, for set-owner, set-card, change-pin and reset, Face ID or the
    /// passcode with a context of its own, so neither a seed already unlocked nor
    /// the seconds after an unlock stand in for the keeper. set-limit asks the
    /// alert alone. One question at a time, and no answer in 50 seconds is a no.
    /// A yes lasts for the next card session or 90 seconds, whichever ends first;
    /// a move (`keep`) is kept in the Keychain for its card until the card takes
    /// the record it signs. A yes that names a lift is asked in the same alert and kept as two
    /// (CardOwner.split): the command's own, and the lift's for its whole session.
    func handleCardOwnerApprove(id: String, body: [String: Any]) {
        guard let approval = CardOwner.approval(body, at: Date().timeIntervalSince1970),
              let question = CardOwner.question(for: approval) else {
            return resolve(id: id, text: nil, error: "bad request")
        }
        dispatchPrecondition(condition: .onQueue(.main))
        guard !cardOwnerAsking else {
            print("[foxy] card: a question refused; another is still waiting for an answer")
            return resolve(id: id, text: nil, error: Self.cardOwnerBusy)
        }
        cardOwnerAsking = true
        let finish: (Bool) -> Void = { yes in
            DispatchQueue.main.async {
                self.cardOwnerAsking = false
                guard yes else { return self.resolve(id: id, text: nil, error: CardOwner.declined) }
                // the command's own yes, and its lift's where it named one (CardOwner.split)
                for one in CardOwner.split(approval) {
                    if one.keep {
                        CardMoves.keep(one)
                    } else {
                        // for the next card session: one already open is not it
                        self.cardApprovals.append((one, nil))
                        if self.cardApprovals.count > 4 { self.cardApprovals.removeFirst(self.cardApprovals.count - 4) }
                    }
                }
                self.resolve(id: id, text: Self.json(["approved": true]), error: nil)
            }
        }
        var answered = false
        let ticket = confirmSeedChange(title: question.title, message: question.message, action: question.yes) { yes in
            answered = true
            print("[foxy] card: \"\(question.title)\" answered \(yes ? question.yes : "Cancel")")
            guard yes else { return finish(false) }
            guard question.askOwner else { return finish(true) }
            Self.cardOwnerQueue.async {
                // a fresh LAContext: the keeper, now, and not an unlock that is still warm
                finish(SeedVault.deviceOwnerApproves(reason: question.reason))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.cardOwnerAnswerWait) {
            guard !answered else { return }
            print("[foxy] card: no answer in \(Int(Self.cardOwnerAnswerWait))s, taken as no")
            ticket.cancel()
        }
    }

    /// Yeses past their 90 seconds, or bound to a session that has ended. A lift's
    /// yes, once its session has begun, lasts that session: the money can take
    /// longer than that to come off, and the card may come back to the sheet.
    func dropSpentCardApprovals(now: TimeInterval) {
        cardApprovals.removeAll { (now - $0.approval.at > CardOwner.approvalLife && !($0.approval.lift == true && $0.session != nil))
            || ($0.session != nil && ($0.session != cardSession || !cardSessionOpen)) }
    }

    /// A card session begins: yeses given since the last one are for it, and what
    /// the last card said is forgotten.
    func cardSessionBegan() {
        cardSession += 1
        cardSessionOpen = true
        cardSeen = CardOwner.Seen()
        dropSpentCardApprovals(now: Date().timeIntervalSince1970)
        for i in cardApprovals.indices where cardApprovals[i].session == nil { cardApprovals[i].session = cardSession }
    }

    /// The session has ended, for any reason: its yeses go with it.
    func cardSessionEnded() {
        cardSessionOpen = false
        cardSeen = CardOwner.Seen()
        dropSpentCardApprovals(now: Date().timeIntervalSince1970)
    }

    /// An answer the card gave in this session, kept where it says the card's
    /// limits or its record (CardOwner.Seen). Only the card's own answers, as the
    /// phone carried them: the page cannot write these.
    func cardSaw(_ command: Data, _ answer: Data) {
        let c = [UInt8](command), a = [UInt8](answer)
        guard c.count >= 4, a.count >= 2, a[a.count - 2] == 0x90, a[a.count - 1] == 0x00 else { return }
        let body = Array(a.dropLast(2))
        switch c[1] {
        case 0x01:
            if let limits = CardOwner.limitsSeen(body, granted: cardSeen.granted) {
                cardSeen.limits = limits
                /* a lift kept for this card that this answer shows it holding again is done with: from this answer's own figures
                 * alone, never from what was signed since (`seen(after:)`), nor on any other answer */
                if let key = cardSeen.key { CardLifts.settle(card: key, limits: limits) }
            }
            if CardOwner.unownedSeen(body) { cardSeen.unowned = true }
        case 0x10: if body.count == 33 { cardSeen.key = body }
        case 0x16: if let record = CardOwner.recordSeen(body) { cardSeen.unit = record.unit; cardSeen.mint = record.mint }
        // the owner's grant: from here the card says its limit on one payment
        case 0x45: cardSeen.granted = true
        // a record the card took: a move kept for it is done with
        case 0x32:
            if let key = cardSeen.moveSigned {
                CardMoves.done(card: key)
                cardSeen.moveSigned = nil
            }
        default: break
        }
    }

    /// The keeper's yes waits on its own queue, so Face ID holds up no counter
    /// a payment is reserving on seedQueue meanwhile.
    static let cardOwnerQueue = DispatchQueue(label: "foxy.card.owner")
    /// A card question with no answer by then is a no.
    static let cardOwnerAnswerWait: TimeInterval = 50
    static let cardOwnerBusy = "Another change to a card is still waiting for an answer. Nothing was changed."

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

    /// What iOS says when it asks for Face ID or the passcode to save words an
    /// older Foxy kept in its page as this wallet's seed.
    static let migrateSeedReason = "Save this wallet's seed"

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

/// The moves to another mint the keeper said yes to, kept for the card each is
/// for until the card takes the record it signs (SET_CARD answered 9000), which can
/// be a later tap than the one that moved the money (CardOwner.useMove): a record
/// signed but never taken is signed again at the next tap. In the Keychain, this device only, as a
/// list; a reinstall removes it with everything else a previous installation
/// approved.
enum CardMoves {
    static let key = "foxy.card.moves"

    static func kept() -> [CardOwner.Approval] {
        guard let text = SeedStore.load(key: key),
              let list = try? JSONDecoder().decode([CardOwner.Approval].self, from: Data(text.utf8)) else { return [] }
        return list
    }

    private static func save(_ list: [CardOwner.Approval]) {
        guard !list.isEmpty else { SeedStore.deleteIfPresent(key: key); return }
        guard let data = try? JSONEncoder().encode(list), let text = String(data: data, encoding: .utf8) else { return }
        if !SeedStore.save(text, key: key) { print("[foxy] card: the move could not be kept on the phone") }
    }

    static func keep(_ move: CardOwner.Approval) { save(CardOwner.keepMove(kept(), move)) }

    /// Whether a move kept for this card is what `request` writes. It is not used up by the signature: only by the card taking
    /// the record (`done`), so that a tap that left before SET_CARD reached the card is signed again at the next one.
    static func matches(_ request: CardOwner.SignRequest, seen: CardOwner.Seen) -> Bool {
        CardOwner.useMove(kept(), for: request, seen: seen) != nil
    }

    /// The card took the record its kept move wrote: the move is done with.
    static func done(card: [UInt8]) {
        let list = kept()
        guard list.contains(where: { $0.card == card }) else { return }
        save(list.filter { $0.card != card })
        print("[foxy] card: the move kept for it is written")
    }
}

/// A card's limits as they were before a lift the keeper said yes to, kept in the
/// Keychain beside nothing else until the card is seen holding them again, or the
/// keeper sets a limit: the put-back signs, to a card seen lifted, in the same tap
/// or a later one (CardOwner.Lift, putsBack). Only those figures, for that card.
enum CardLifts {
    static let key = "foxy.card.lifts"

    static func kept() -> [CardOwner.Lift] {
        guard let text = SeedStore.load(key: key),
              let list = try? JSONDecoder().decode([CardOwner.Lift].self, from: Data(text.utf8)) else { return [] }
        return list
    }

    private static func save(_ list: [CardOwner.Lift]) {
        guard !list.isEmpty else { SeedStore.deleteIfPresent(key: key); return }
        guard let data = try? JSONEncoder().encode(list), let text = String(data: data, encoding: .utf8) else { return }
        if !SeedStore.save(text, key: key) { print("[foxy] card: what its limit was could not be kept on the phone") }
    }

    static func keep(_ lift: CardOwner.Lift) { save(CardOwner.keepLift(kept(), lift)) }

    static func drop(card: [UInt8]) {
        let list = kept()
        if list.contains(where: { $0.card == card }) { save(list.filter { $0.card != card }) }
    }

    /// The card is seen holding these limits: a lift kept for it whose figures they are is done with.
    static func settle(card: [UInt8], limits: [CardOwner.Figure: UInt32]) {
        let list = kept()
        guard list.contains(where: { $0.card == card && CardOwner.holds($0, limits) }) else { return }
        save(list.filter { !($0.card == card && CardOwner.holds($0, limits)) })
        print("[foxy] card: its limit is seen put back")
    }
}
