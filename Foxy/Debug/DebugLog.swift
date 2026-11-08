import Foundation
import UIKit

#if DEBUG
// MARK: - The Debug-only file log
//
// Every phone test so far has rested on what the tester could see in Console.app
// and paste into a chat window. That is a poor foundation for a wallet: the
// interesting lines scroll past, the OS fills the window with its own noise
// (`nw_socket_handle_socket_event`, layout constraints, keyboard sessions), and
// a result ends up resting on someone's memory of what they saw.
//
// This writes every line `print` produces to a file inside the app container,
// so a test can be run with NO DEBUGGER ATTACHED — which is the only way to see
// what a real suspension does, since a debugger stops iOS suspending the app at
// all — and the evidence pulled off the phone afterwards with
// `sh tools/pull-device-log.sh`.
//
// Why this is safe to have, and only in DEBUG:
//
//  - The whole file is fenced. A Release build has no file logger, no file, and
//    nothing to pull; smoke check 35 fails if that fence is ever broken, or if
//    `Print.swift` reaches this from its Release half.
//  - A log in the system log is ephemeral. A log in a FILE persists, is copied
//    to a Mac, and may be pasted into a chat. So the lines are redacted on the
//    way in, by the field log's own list (LogRedaction): a cashu token, a
//    lightning invoice, a payment request, an onion address, a nostr key and
//    any long hex run are replaced by their length. `Print.swift`'s own note explains why the prints
//    name mint hosts and amounts; those stay, because they are the evidence.
//  - Bounded: two files of 4 MB. A long test cannot fill the phone.
//
// It must never call `print`. `Print.swift` defines a module-wide `print` that
// calls straight back here, so a print in this file is an infinite loop. Its own
// troubles go to NSLog.

enum DebugLog {

    // MARK: Where it goes

    /// `Library/Application Support/foxy-logs/foxy.log`, rotating once.
    ///
    /// Application Support rather than Caches: iOS may empty Caches when
    /// storage runs low, and a log that vanishes before it is pulled is worse
    /// than no log, because it looks like nothing happened.
    private static let folder: URL? = {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                                     in: .userDomainMask).first else { return nil }
        let dir = support.appendingPathComponent("foxy-logs", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: DebugLogFile.protection])
            // and again for a folder an earlier build made without it
            DebugLogFile.applyProtection(dir)
            // A debug log says nothing a backup should carry to another device.
            var mutable = dir
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? mutable.setResourceValues(values)
            return dir
        } catch {
            NSLog("[foxy] debug log: no folder: %@", String(describing: error))
            return nil
        }
    }()

    /// Deliberately not `current`/`previous`. Smoke check 22 collects the
    /// symbols declared inside `#if DEBUG` and fails on any use outside one, to
    /// catch the case where a Release build will not compile. A member called
    /// `current` declared here makes every `UITraitCollection.current` and
    /// `UNUserNotificationCenter.current` elsewhere in the app look like that
    /// mistake. The check is textual on purpose; the cheap answer is a name of
    /// our own.

    /// 4 MB a file. `-FoxyLogBytes N` sets a smaller size for one run, so a
    /// rotation can be watched in minutes rather than hours.
    private static let mostBytes: Int = {
        let asked = UserDefaults.standard.integer(forKey: "FoxyLogBytes")
        return asked > 0 ? asked : 4 * 1024 * 1024
    }()
    private static let queue = DispatchQueue(label: "foxy.debuglog")
    private static let file: DebugLogFile? = folder.map {
        DebugLogFile(folder: $0, mostBytes: mostBytes)
    }
    private static var started = false

    // MARK: Writing

    /// One line, stamped and redacted. Safe from any thread.
    static func write(_ line: String) {
        queue.async { append(line) }
    }

    /// Console.app while it runs, and the file for afterwards.
    ///
    /// The diagnostics that call NSLog directly rather than `print` went only to
    /// the system log, so the tests whose whole verdict IS an NSLog line — the
    /// seed screens, the network block, the keychain rules, the seed self-test —
    /// could not be judged from a pulled file at all. `tools/pull-device-log.sh`
    /// even had a section grepping for them that could never fill. One call now
    /// reaches both places.
    ///
    /// Safe to persist: none of those lines carries seed material. `seedCreate`
    /// answers `{"created":true}`, `seedEnter` answers a candidate handle with
    /// the phrase held natively, `restoreSecrets` is summarised to counts by the
    /// harness, and the keychain self-test runs on a scratch entry with fixed
    /// vectors. Words never cross the bridge, which is the property §14 exists
    /// to check; if that ever changes, this is one of the places it leaks to.
    static func both(_ tag: String, _ message: String) {
        NSLog("%@ %@", tag, message)
        write(tag + " " + message)
    }

    /// Called once per launch, before anything else writes, so a pulled file
    /// says which run it is and where the previous one ended.
    static func begin() {
        queue.async {
            guard !started else { return }
            started = true
            rotateIfFull(force: false)
            let device = UIDevice.current
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
            let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
            // Every -Foxy argument actually passed, read from the command line. A
            // list of names kept here fell behind: -FoxyTorStall auth ran three
            // launches that this banner called "launch arguments: none".
            let args = ProcessInfo.processInfo.arguments
            var flags: [String] = []
            for (i, arg) in args.enumerated() where arg.hasPrefix("-Foxy") {
                let next = i + 1 < args.count ? args[i + 1] : ""
                flags.append(String(arg.dropFirst()) + (next.isEmpty || next.hasPrefix("-") ? "" : "=" + next))
            }
            append("")
            append("==== foxy launch ====")
            append("app \(version) (\(build)) on \(device.systemName) \(device.systemVersion), \(device.model)")
            append("launch arguments: " + (flags.isEmpty ? "none" : flags.joined(separator: " ")))
            append("debugger attached: \(debuggerAttached ? "YES - suspension tests are INVALID" : "no")")
            // the class a locked phone's pull depends on, as this phone reports it
            if let file { append("log files: " + file.classes()) }
        }
    }

    /// A debugger stops iOS suspending the app, which quietly invalidates every
    /// background, resume and suspension test. The log says so rather than
    /// leaving a reader to wonder why the app never got suspended.
    private static var debuggerAttached: Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0 else { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }

    // MARK: The queue's own work — never call these from outside it

    private static func append(_ line: String) {
        file?.append(stamp() + " " + redact(line))
    }

    private static func rotateIfFull(force: Bool) { file?.rotateIfFull(force: force) }

    /// One formatter, not one per line: this runs on every print.
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        f.timeZone = .current
        return f
    }()

    private static func stamp() -> String { clock.string(from: Date()) }

    // MARK: Redaction
    //
    // A file is copied and pasted in a way the system log is not. What comes
    // out of a line here is what comes out of a field log line: one list, in
    // LogRedaction, so the two cannot drift apart. They had: this file's own
    // copy knew tokens, invoices and long hex, and still kept the payment
    // requests, onion addresses and nostr keys the field log took out.

    private static func redact(_ line: String) -> String { LogRedaction.redact(line) }
}

/// The log's two files: where the lines go, the rotation, and the protection
/// class. Its own type so FoxyTests can drive it in a folder of its own at a
/// small size. Only DebugLog's queue calls it.
final class DebugLogFile {
    let folder: URL
    let logFile: URL
    let rolledFile: URL
    let mostBytes: Int
    /// Gives a file or folder its protection class. FoxyTests stands one in that
    /// records the calls, since the simulator keeps no class at all.
    private let protect: (URL) -> Void
    private var handle: FileHandle?
    private(set) var written = 0

    /// Readable from the first unlock after a restart, not only while the
    /// phone is unlocked: the app writes while the screen is locked, and a
    /// pull copies the files off a locked phone. A pull of a locked phone read
    /// the rolled file and came back with an empty current file, so the class
    /// is set on the folder when it is made, and on the file again after every
    /// create, rather than trusted to the create call's attributes.
    static let protection = FileProtectionType.completeUntilFirstUserAuthentication

    static func applyProtection(_ url: URL) {
        do {
            try FileManager.default.setAttributes([.protectionKey: protection], ofItemAtPath: url.path)
        } catch {
            NSLog("[foxy] debug log: could not set the protection of %@: %@",
                  url.lastPathComponent, String(describing: error))
        }
    }

    init(folder: URL, mostBytes: Int, protect: @escaping (URL) -> Void = DebugLogFile.applyProtection) {
        self.folder = folder
        logFile = folder.appendingPathComponent("foxy.log")
        rolledFile = folder.appendingPathComponent("foxy.log.1")
        self.mostBytes = mostBytes
        self.protect = protect
    }

    func close() { try? handle?.close(); handle = nil }

    /// One finished line, stamped and redacted by the caller.
    func append(_ line: String) {
        let url = logFile
        guard let data = (line + "\n").data(using: .utf8) else { return }
        if handle == nil {
            let fm = FileManager.default
            if !fm.fileExists(atPath: url.path) {
                fm.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: Self.protection])
                written = 0
            } else {
                let attributes = try? fm.attributesOfItem(atPath: url.path)
                written = (attributes?[.size] as? Int) ?? 0
            }
            // On every open, a new file or the one a relaunch finds, so a file
            // made under another class by an earlier build is moved to this one.
            protect(url)
            handle = try? FileHandle(forWritingTo: url)
            try? handle?.seekToEnd()
        }
        guard let handle else { return }
        do {
            try handle.write(contentsOf: data)
            written += data.count
        } catch {
            NSLog("[foxy] debug log: write failed: %@", String(describing: error))
            return
        }
        if written >= mostBytes { rotateIfFull(force: true) }
    }

    func rotateIfFull(force: Bool) {
        let url = logFile, old = rolledFile
        let fm = FileManager.default
        let attributes = try? fm.attributesOfItem(atPath: url.path)
        let size = (attributes?[.size] as? Int) ?? 0
        guard force || size >= mostBytes else { return }
        try? handle?.close()
        handle = nil
        written = 0
        guard size > 0 else { return }
        try? fm.removeItem(at: old)
        try? fm.moveItem(at: url, to: old)
    }

    /// The class each file and the folder really has, for the launch banner, so
    /// a pulled log says whether a locked phone can copy it.
    func classes() -> String {
        func of(_ url: URL) -> String {
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return "none" }
            return (attributes[.protectionKey] as? FileProtectionType)?.rawValue ?? "not reported"
        }
        return "folder \(of(folder)), foxy.log \(of(logFile)), foxy.log.1 \(of(rolledFile))"
    }
}
#endif
