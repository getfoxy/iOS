import Foundation

/// The rules for where a NUT-13 counter may be stored and how far it may move,
/// apart from the file, so FoxyTests and tools/nativetests hold them.
///
/// **One counter per derivation path.** A `00` keyset's path is
/// m/129372'/0'/(id mod (2^31 − 1))'/counter', so many ids reach the same
/// secrets: 009a1f293253e41e, 0000000033882270, 009a1f29b253e41d and
/// 009a1f28b253e41f all derive index 864559728. Keyed by the id's text, a
/// script could reserve or restore through a second id and collect secrets for
/// the real keyset's future outputs (review H1). So a `00` keyset's
/// counter is kept under its derivation index: the file keeps the first id
/// stored for that index, and any other id with the same index reaches that
/// entry. A `01` keyset's path is its whole id, so it is keyed by the id.
///
/// **Moves are capped** (review M1). A counter pushed far ahead
/// hides every later receipt from a restore, which stops after 300 empty
/// counters, and past the version's last counter it stops the keyset for good.
/// The page's skips move a counter 10, 50 or 100 at a time, and adopting a
/// restore moves it to what the restore found, which native served.
enum CounterRules {
    /// The furthest a counter may move past its current value in one step,
    /// beyond what a restore served.
    static let reach: UInt64 = 100

    /// The most keysets the counter file holds (review L9). A
    /// wallet has a handful; the file is rewritten whole on every reservation.
    static let mostKeysets = 256

    /// One past a keyset version's last counter: 2^31 for `00` (a hardened
    /// index), 2^53 for `01` (JavaScript's largest exact integer plus one).
    static func ceiling(version: UInt8) -> UInt64 {
        version == 0 ? 1 << 31 : 1 << 53
    }

    /// What a counter entry is: `00:<index>` for a `00` keyset, the lowercased
    /// id for a `01` keyset, nil for anything else.
    static func slot(_ keysetId: String) -> String? {
        switch NUT13.keysetVersion(keysetId) {
        case 0: return NUT13.derivationIndex(keysetId).map { "00:\($0)" }
        case 1: return keysetId.lowercased()
        default: return nil
        }
    }

    /// The key an id's counter is stored under: the stored id with the same
    /// slot if there is one, otherwise the id itself, lowercased.
    static func storedKey<Keys: Sequence>(_ keysetId: String, in keys: Keys) -> String where Keys.Element == String {
        let id = keysetId.lowercased()
        guard let wanted = slot(id) else { return id }
        if NUT13.keysetVersion(id) == 1 { return id }
        return keys.first { slot($0) == wanted } ?? id
    }

    enum Move: Equatable {
        case allowed
        case tooFarAhead
    }

    /// counterAdvance {next}: allowed up to 100 past the current counter, or up
    /// to the end of the furthest range a restore served this keyset this
    /// process, whichever is further, and never past the version's ceiling. A
    /// next at or below the current counter moves nothing and is allowed.
    static func advance(current: UInt64, next: UInt64, highest: UInt64, version: UInt8) -> Move {
        guard next > current else { return .allowed }
        guard next <= ceiling(version: version) else { return .tooFarAhead }
        let (near, overflow) = current.addingReportingOverflow(reach)
        return overflow || next <= max(near, highest) ? .allowed : .tooFarAhead
    }

    /// counterReserveAt {start}: at most 100 past the current counter.
    static func reserveAt(current: UInt64, start: UInt64) -> Move {
        let (near, overflow) = current.addingReportingOverflow(reach)
        return overflow || start <= near ? .allowed : .tooFarAhead
    }

    /// A value the page hands over (countersImport), cut to the version's ceiling.
    static func capped(_ value: UInt64, version: UInt8) -> UInt64 {
        min(value, ceiling(version: version))
    }

    /// A counter file from before the counters were kept by derivation index:
    /// entries whose indices collide become one, at the largest of their values,
    /// under the id that held it (the smallest id on a tie). The real keyset is
    /// the one that was used, so its id is the one kept.
    static func merged(_ counters: [String: UInt64]) -> [String: UInt64] {
        var bySlot: [String: (id: String, next: UInt64)] = [:]
        for (id, next) in counters {
            let key = slot(id) ?? id
            if let held = bySlot[key] {
                if next > held.next || (next == held.next && id < held.id) {
                    bySlot[key] = (id, next)
                }
            } else {
                bySlot[key] = (id, next)
            }
        }
        var out: [String: UInt64] = [:]
        for (_, entry) in bySlot { out[entry.id] = entry.next }
        return out
    }
}
