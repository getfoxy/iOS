import Foundation
import UIKit

/// What Foxy has been doing, kept on the phone so it can be handed over.
///
/// The device log (`DebugLog`) is the fuller record, but it only exists in a
/// Debug build and only comes off the phone through Xcode. Someone using Foxy
/// has neither. This is the same lines, held in memory, readable by the page,
/// so the ERRORS and LOGS screens can show them and the person can copy them
/// into a message (`build/app/28-field-log.js`).
///
/// It is in EVERY build, which the module's `print` is not. Release builds
/// stay silent where silence is checked — nothing here reaches NSLog, the
/// system log or a file (tools/sim/release-silence.sh) — but a person on a
/// shipped build can still say what went wrong and be believed.
///
/// Nothing leaves the phone on its own. The buffer is memory only: it is gone
/// when Foxy is, and the only way out is the person tapping COPY.
enum FieldLog {

    /// A line, with when it happened and whether it reads as trouble.
    struct Line {
        let at: Date
        let text: String
        let bad: Bool
    }

    /// Enough to cover a launch and a real session, not a few minutes.
    ///
    /// It was 600, which is a launch and about five minutes of quiet use — and
    /// tap to pay is not quiet: a payer scanning writes a `something at -NN
    /// dBm` line about twice a second, so ten minutes of it filled the ring
    /// twice over and pushed out everything that said what had gone wrong. On a
    /// Debug build that did not matter, because the file on disk had it all. A
    /// Release build has only this, and a tester's report is only as good as
    /// what survived.
    ///
    /// 2500 lines at roughly 150 bytes is under 400 KB, which is a fair price
    /// for being able to answer someone.
    ///
    /// 10,000 while Foxy is in testing: about 1.5 MB, and a
    /// day of taps instead of an hour of them.
    static let capacity = 10000

    private static let lock = NSLock()
    private static var ring: [Line] = []

    /// Words that mark a line as trouble, so the ERRORS screen can be the short
    /// list rather than the whole thing. Matched on the redacted text.
    private static let troubles = ["error", "failed", "refused", "could not", "cannot",
                                   "no answer", "timed out", "gave up", "stopped asking",
                                   "not connected", "unavailable", "invalid", "rejected"]

    /* ---- the connection lines, kept across one relaunch ---------------- */

    /* Twice a tester was stuck on a gate screen whose buttons did nothing,
     * and twice the only way off it was the app switcher — which threw the
     * buffer away, so both logs handed over afterwards were of the healthy
     * relaunch and said nothing about the session that failed. A record that dies with the app cannot describe the thing
     * that makes people kill the app.
     *
     * Only these lines, and deliberately only these: Tor's progress, the gate's
     * screens, Orbot and the tunnel check. No mint, no amount, no token, no
     * invoice, nothing about a payment. The memory-only promise above still
     * holds for everything else, and this much is a connection diary.
     *
     * Read back once at the next launch and deleted on the spot, so it is one
     * run's worth and never accumulates. */
    /* Matched anywhere in the line, not at its start. The page's own logs reach
     * here wrapped — "[foxy-js] +195ms [log] [foxy] tor gate: connecting" — so
     * a prefix test silently kept only the native half, and the first diary off
     * a phone had every Tor line and not one gate line, which was the
     * half that said what the screen was doing. */
    private static let keepPrefixes = ["[foxy] tor:", "[foxy] tor gate:", "[foxy] orbot:",
                                       "[foxy] tunnel:", "[foxy] tor guards",
                                       // tap to pay: which phone, how close, and which way it paid
                                       "[tap] ", "[foxy] tap:",
                                       // where the seconds of a payment went,
                                       // and what became of money that arrived
                                       "[foxy] pay steps:", "[foxy] a request was paid",
                                       "[foxy] a payment for a request",
                                       /* Which screen was up, and where a native view was laid over
                                        * it. A dead button in the middle of the split's NEXT and a
                                        * live one at its left edge was the paste control parked on
                                        * a screen that had moved on, and the diary could not say so
                                        * because it kept neither line. */
                                       "[foxy] screen ", "[foxy] paste control",
                                       // and the banner: a report without a build number is a guess
                                       "[foxy] Foxy "]
    /* And more of the diary that survives a relaunch.
     *
     * This is the subset a bug report actually rests on, and 120 lines of it
     * was about ninety seconds once tap lines were being kept too. A person who
     * force-quits after a problem — which is what people do — hands over
     * whatever is here. */
    /* 3,000 while Foxy is in testing, and saved as it goes
     * (`saveSoon`), not only on the way to the background: a tester with a
     * stuck screen kills the app and opens it again, and a crash never passes
     * through the background at all. Still only the lines listed above. */
    private static let keepCapacity = 3000
    private static var saveDue = false

    /// The kept lines written out a few seconds after one is added, at most
    /// once every five seconds, off the main thread.
    private static func saveSoon() {
        // called with the lock held
        guard !saveDue else { return }
        saveDue = true
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5) {
            lock.lock(); saveDue = false; lock.unlock()
            saveForNextRun()
        }
    }
    private static var keep: [Line] = []

    private static var keepURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("foxy-lastrun.log")
    }

    /// Write the connection diary out. Called as Foxy goes to the background,
    /// which is where a force-quit starts, so the run that gets killed is the
    /// run this saves.
    static func saveForNextRun() {
        lock.lock(); let held = keep; lock.unlock()
        guard let url = keepURL, !held.isEmpty else { return }
        let text = held.map { "\(Int($0.at.timeIntervalSince1970 * 1000))\t\($0.text)" }
            .joined(separator: "\n")
        guard let data = text.data(using: .utf8) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        var u = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? u.setResourceValues(values)
    }

    /// Read last run's diary into this run's buffer, then delete it.
    static func takeLastRun() {
        guard let url = keepURL,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(at: url)
        let lines = text.split(separator: "\n").compactMap { row -> Line? in
            let parts = row.split(separator: "\t", maxSplits: 1)
            guard parts.count == 2, let ms = Double(parts[0]) else { return nil }
            // said once, however many launches ago it was
            let was = String(parts[1])
            let body = was.hasPrefix("last run · ") ? was : "last run · " + was
            return Line(at: Date(timeIntervalSince1970: ms / 1000), text: body,
                        bad: troubles.contains { body.lowercased().contains($0) })
        }
        guard !lines.isEmpty else { return }
        lock.lock()
        ring.insert(contentsOf: lines, at: 0)
        if ring.count > capacity { ring.removeFirst(ring.count - capacity) }
        /* And kept again, so they outlive this launch too. Somebody who kills
         * Foxy, opens it, sees the same thing and kills it again used to hand
         * over only the second, shorter run. */
        keep.insert(contentsOf: lines, at: 0)
        if keep.count > keepCapacity { keep.removeFirst(keep.count - keepCapacity) }
        lock.unlock()
    }

    /// The first line of any report: which build, on which phone.
    ///
    /// `DebugLog` has written this since the beginning, and `DebugLog` does not
    /// exist in a Release build — so the one log a TestFlight tester can hand
    /// over was the one that could not say what they were running. Every
    /// question worth asking about a report starts here.
    ///
    /// Nothing identifying: `UIDevice.model` is "iPhone", not the model name,
    /// and there is no identifier for vendor, no name, no locale.
    static func begin() {
        let device = UIDevice.current
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        write("[foxy] Foxy \(version) (\(build)) on \(device.systemName) \(device.systemVersion)")
        // the app switcher opens on this, and a swipe from it may be the last thing a run does
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
                                               object: nil, queue: nil) { _ in saveForNextRun() }
    }

    static func write(_ raw: String) {
        let text = redact(raw)
        let low = text.lowercased()
        let line = Line(at: Date(), text: text, bad: troubles.contains { low.contains($0) })
        lock.lock()
        ring.append(line)
        if ring.count > capacity { ring.removeFirst(ring.count - capacity) }
        if keepPrefixes.contains(where: { text.contains($0) }) {
            keep.append(line)
            if keep.count > keepCapacity { keep.removeFirst(keep.count - keepCapacity) }
            saveSoon()
        }
        lock.unlock()
    }

    /// Everything held, oldest first; `onlyBad` for the ERRORS screen.
    static func lines(onlyBad: Bool = false) -> [Line] {
        lock.lock()
        let all = ring
        lock.unlock()
        return onlyBad ? all.filter { $0.bad } : all
    }

    static func clear() {
        lock.lock()
        ring.removeAll()
        keep.removeAll()
        lock.unlock()
        if let url = keepURL { try? FileManager.default.removeItem(at: url) }
    }

    /// The page's shape: [{ at, text, bad }], newest last, as JSON.
    static func json(onlyBad: Bool = false) -> String {
        let out = lines(onlyBad: onlyBad).map { line -> [String: Any] in
            ["at": Int(line.at.timeIntervalSince1970 * 1000), "text": line.text, "bad": line.bad]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: out),
              let s = String(data: data, encoding: .utf8) else { return "[]" }
        return s
    }

    // MARK: Redaction
    //
    // These lines are meant to be copied into a message, which the system log
    // never was. The three shapes that carry money or a payee go, and so does
    // an onion address — this phone's inbox, or someone else's, is a name for a
    // person. Mint hosts and sat amounts stay: they are what makes a report
    // answerable, and the screens say so before anything is copied.

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
