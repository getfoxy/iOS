import Foundation

/// What is taken out of a field log line before it is kept (FieldLog.write).
///
/// These lines are meant to be copied into a message, which the system log
/// never was. The three shapes that carry money or a payee go, and so does an
/// onion address — this phone's inbox, or someone else's, is a name for a
/// person. Mint hosts and sat amounts stay: they are what makes a report
/// answerable, and the screens say so before anything is copied.
///
/// Its own file, with no UIKit, so tools/nativetests can build it on a Mac and
/// hold the connection diary's lines to it (FoxyNetDiary, NetDiaryTests).
enum LogRedaction {

    private static let secrets: [(NSRegularExpression, String)] = {
        func re(_ p: String) -> NSRegularExpression? {
            try? NSRegularExpression(pattern: p, options: [.caseInsensitive])
        }
        return [
            (re("cashu[AB][A-Za-z0-9_=-]{20,}"), "cashu token"),
            (re("ln(bc|tb|bcrt)[0-9][a-z0-9]{30,}"), "lightning invoice"),
            (re("creq[A-Za-z0-9_=-]{20,}"), "payment request"),
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
