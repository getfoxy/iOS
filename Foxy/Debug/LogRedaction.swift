import Foundation
import CryptoKit

/// What is taken out of a field log line before it is kept (FieldLog.write).
///
/// These lines are meant to be copied into a message, which the system log
/// never was. The shapes that carry money or a payee go (a token, an invoice, a payment request, a Foxy ID and the nprofile it is delivered to), and so does an
/// onion address — this phone's inbox, or someone else's, is a name for a
/// person. Sat amounts stay: they are what makes a report answerable, and the
/// screens say so before anything is copied.
///
/// The one list, for the Debug file log too (DebugLog), so the two cannot
/// drift apart again.
///
/// Its own file, with no UIKit, so tools/nativetests can build it on a Mac and
/// hold the connection diary's lines to it (FoxyNetDiary, NetDiaryTests).
enum LogRedaction {
    /* Hosts, as the app's own lines name them.
     *
     * A Release build's prints go to the field log, and the field log is
     * copied into messages: a line naming a host names a mint this wallet
     * uses, a payee's address, where a payment was redirected, a host the
     * person allowed. The rule the Tor lines keep for relays is kept for all of
     * them: never by name. A Release line says `host` and the first eight hex
     * characters of the SHA-256 of the name, lowercased, so two lines about one
     * host can still be told to be about the same one, and someone who already
     * knows a host can check it, and nobody else learns it. A Debug build,
     * which only a developer runs, names it. */

    /// Whether lines name hosts: in a Debug build only.
    #if DEBUG
    static let namesHosts = true
    #else
    static let namesHosts = false
    #endif

    /// A host as a line may give it.
    static func host(_ name: String?, named: Bool = namesHosts) -> String {
        guard let name, !name.isEmpty else { return "?" }
        if named { return name }
        let digest = SHA256.hash(data: Data(name.lowercased().utf8))
        return "host " + digest.prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    /// An address as a line may give it: in a Debug build its first 120
    /// characters, and otherwise its host alone, as above. Its path and query
    /// may carry a payment's own ids, so they never go further than the host.
    static func address(_ url: URL?, named: Bool = namesHosts) -> String {
        guard let url else { return "?" }
        return named ? String(url.absoluteString.prefix(120)) : host(url.host, named: false)
    }

    private static let secrets: [(NSRegularExpression, String)] = {
        func re(_ p: String) -> NSRegularExpression? {
            try? NSRegularExpression(pattern: p, options: [.caseInsensitive])
        }
        return [
            (re("cashu[AB][A-Za-z0-9_=-]{20,}"), "cashu token"),
            (re("ln(bc|tb|bcrt)[0-9][a-z0-9]{30,}"), "lightning invoice"),
            (re("creq[A-Za-z0-9_=-]{20,}"), "payment request"),
            // a Foxy ID (docs/FOXY-ID.md) names a person for as long as they keep it, and so does the nprofile it is delivered to
            (re("foxyid1[A-Za-z0-9_-]{20,}"), "foxy id"),
            (re("\\bnprofile1[02-9ac-hj-np-z]{20,}"), "nostr profile"),
            // a Lightning address (name@host.tld) is a person; the host after it is the payee's, so the whole address goes
            (re("[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+"), "lightning address"),
            (re("\\b[a-z2-7]{55,56}\\.onion\\b"), "onion address"),
            (re("\\bnsec1[02-9ac-hj-np-z]{20,}"), "nostr key"),
            (re("\\b[0-9a-f]{64,}\\b"), "hex"),
        ].compactMap { pair in pair.0.map { ($0, pair.1) } }
    }()

    static func redact(_ line: String) -> String {
        var out = line
        for (pattern, what) in secrets {
            let full = NSRange(out.startIndex..., in: out)
            // back to front, so an earlier replacement cannot move a later range
            for m in pattern.matches(in: out, range: full).reversed() {
                guard let r = Range(m.range, in: out) else { continue }
                out.replaceSubrange(r, with: "<\(what), \(m.range.length) chars, not logged>")
            }
        }
        return out
    }
}
