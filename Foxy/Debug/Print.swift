import Foundation

/// Release builds say nothing.
///
/// The prints in this module name mint hosts, amounts, Tor state and clipboard
/// sizes: useful at a desk, and a gift to anything that can read the device
/// log. Outside DEBUG, print is a no-op for the whole module, so a new print
/// cannot quietly reintroduce it. Debug-only diagnostics use NSLog on purpose.
#if !DEBUG
/// Silent, but not forgetful: the line still goes to FieldLog, which is memory
/// on this phone and reaches nobody unless the person taps COPY on the LOGS
/// screen. Nothing here reaches the system log or a file, which is what "a
/// Release build says nothing" has always meant, and what smoke check 35 and
/// tools/sim/release-silence.sh hold it to.
@inline(__always)
func print(_ items: Any..., separator: String = " ", terminator: String = "\n") {
    FieldLog.write(items.map { "\($0)" }.joined(separator: separator))
}
#else
/// Debug builds put every print in the system log too. A phone running without
/// Xcode attached — the only way to see what a real suspension does, since a
/// debugger keeps the app awake — can then be read in Console.app.
///
/// And into a file in the app's container (`DebugLog`), because Console.app is
/// read by a person and a file is read by a grep: a phone test can then be run
/// with nothing attached and the evidence pulled off afterwards with
/// `sh tools/pull-device-log.sh`. DebugLog is fenced to DEBUG the same way this
/// half is, so a Release build writes no file — smoke check 35 holds both.
func print(_ items: Any..., separator: String = " ", terminator: String = "\n") {
    let line = items.map { "\($0)" }.joined(separator: separator)
    NSLog("%@", line)
    DebugLog.write(line)
    // and the copy the person can reach, the same in every build
    FieldLog.write(line)
}
#endif
