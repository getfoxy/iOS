import UIKit

/* The pasteboard around the seed (SeedScreens.swift, FoxyBridge.swift):
 *
 * - where words pasted into RESTORE A WALLET came from: words Foxy itself put
 *   on the pasteboard are refused there, so a page cannot copy words it knows
 *   and lead the person to paste them in as their own (review M8);
 * - a phrase pasted there is cleared from the pasteboard once it is in (L7);
 * - the page is never handed a seed phrase from the clipboard (L7).
 *
 * The decisions are pure, and tested in FoxyTests/SeedScreenTests.swift. */
enum SeedPasteboard {
    // MARK: Where a paste came from

    static let refusal = "These words were copied inside Foxy. Type or paste words you wrote down yourself."

    /// `UIPasteboard.general.changeCount` just after Foxy last wrote the
    /// pasteboard; nil when it has not since launch. Main queue.
    private(set) static var lastFoxyWrite: Int?
    /// The change count when Foxy last came to the front: changes up to it were
    /// made outside Foxy.
    private static var countAtActivation: Int?
    private static var watching: [NSObjectProtocol] = []

    /// Foxy wrote the pasteboard: a copy the page asked for, the share sheet's
    /// Copy, or a clear. Main queue.
    static func foxyWrote() {
        dispatchPrecondition(condition: .onQueue(.main))
        lastFoxyWrite = UIPasteboard.general.changeCount
    }

    /// The web view can also write the pasteboard, without the bridge: a script's
    /// navigator.clipboard.writeText or execCommand("copy") on a tap. UIKit tells
    /// Foxy of changes made in its own process while it is in front, so a change
    /// then is taken as Foxy's; one made by another app while Foxy was away is
    /// at or below the count Foxy came back to. Once, from the bridge. Main queue.
    static func watch() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard watching.isEmpty else { return }
        countAtActivation = UIPasteboard.general.changeCount
        let center = NotificationCenter.default
        watching.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil,
                                           queue: .main) { _ in
            countAtActivation = UIPasteboard.general.changeCount
        })
        watching.append(center.addObserver(forName: UIPasteboard.changedNotification, object: nil,
                                           queue: .main) { _ in
            let now = UIPasteboard.general.changeCount
            if madeInFoxy(active: UIApplication.shared.applicationState == .active,
                          count: now, countAtActivation: countAtActivation) {
                lastFoxyWrite = now
            }
        })
    }

    /// A pasteboard change seen while Foxy is in front, past the count it came
    /// back to, was made in Foxy's process.
    static func madeInFoxy(active: Bool, count: Int, countAtActivation: Int?) -> Bool {
        active && count != countAtActivation
    }

    enum Paste: Equatable {
        case allow
        /// The pasteboard still holds what Foxy last put there.
        case refuse
    }

    /// A paste into the restore screen. Typing never comes here.
    static func paste(changeCount: Int, lastFoxyWrite: Int?) -> Paste {
        changeCount == lastFoxyWrite ? .refuse : .allow
    }

    // MARK: Clearing a pasted phrase

    /// After a paste that filled `filled` cells: clear the pasteboard only if it
    /// still holds what was pasted, not something copied since.
    static func clearAfterPaste(filled: Int, countAtPaste: Int, countNow: Int) -> Bool {
        filled > 1 && countNow == countAtPaste
    }

    /// Empties the pasteboard, which also takes the phrase off Universal
    /// Clipboard. Main queue.
    static func clear() {
        UIPasteboard.general.items = []
        foxyWrote()
        print("[foxy] a phrase pasted into the restore screen was cleared from the pasteboard")
    }

    // MARK: The page's clipboard

    /// Whether `text` holds a BIP-39 phrase: 12, 15, 18, 21 or 24 words in a row
    /// that are on the list and have a right checksum, read as the restore screen
    /// reads words (lower case, split at anything not a letter), so a numbered
    /// list or a phrase inside a note counts.
    static func holdsSeedPhrase(_ text: String, wordlist: [String]) -> Bool {
        guard wordlist.count == 2048 else { return false }
        var run: [String] = []
        func runHoldsOne() -> Bool {
            for length in [12, 15, 18, 21, 24] where run.count >= length {
                for start in 0...(run.count - length)
                where BIP39.isValid(Array(run[start..<start + length]), wordlist: wordlist) {
                    return true
                }
            }
            return false
        }
        for part in SeedEntry.parts(text) {
            if BIP39.index(of: part, in: wordlist) != nil {
                run.append(part)
            } else {
                if runHoldsOne() { return true }
                run = []
            }
        }
        return runHoldsOne()
    }

    /// What the page may be handed of clipboard text: nothing, when it holds a
    /// seed phrase, as if the clipboard held nothing usable. Without the pinned
    /// wordlist nothing can be checked, so nothing is handed over.
    static func forPage(_ text: String, from place: String) -> String {
        guard !text.isEmpty else { return text }
        guard let wordlist = BIP39.english else {
            print("[foxy] \(place): the wordlist is not loaded, so clipboard text was not given to the page")
            return ""
        }
        guard !holdsSeedPhrase(text, wordlist: wordlist) else {
            print("[foxy] \(place): the clipboard held a seed phrase; the page was not given it")
            return ""
        }
        return text
    }
}
