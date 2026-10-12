import Foundation

/// A card held to the phone, on its way to the page: one message, kept until the page
/// can take it, and told once.
///
/// iOS hands the app the card's address (CardAddress) and nothing else, and the app
/// passes on that a card was tapped. The page decides what to do with it, by what is
/// on its screen (build/app/26f-flashcard.js, `cardTapRule`); this only gets the
/// message there, and it must not do it too early or twice:
///
///  - Kept. The address often arrives before the page can take it: a launch from the
///    banner brings it before the page has even loaded. It waits, and is told when
///    the page is up.
///  - Not under a cover. While the launch image or the app-switcher cover is over the
///    page, nobody is looking at it.
///  - Not before the return is told. When Foxy comes back from the background the page
///    raises its lock on hearing so (`_resumed`), and a card heard of before that
///    would find no lock to wait behind. After a trip to the background nothing is
///    told until the return has been (`cameBack`).
///  - Asked again. A page that has loaded has not booted, and it has no way to say it
///    is ready: its answer is the only sign, so the question is asked every
///    `retryAfter` until the answer is yes. It is given up `lapse` after the address
///    arrived, so a phone that is opened by hand much later is never sent to a card.
///  - Once. Addresses that arrive while one waits are the same tap, and a yes ends
///    it. iOS can hand SwiftUI one address in more than one way.
///
/// The page is told a fixed message (CardAddress.pageCall). Nothing of the address is
/// here, and nothing of it is logged. Main thread only.
final class CardTapDelivery {
    static let shared = CardTapDelivery()

    /// How long after the address arrived a tap is still told.
    static let lapse: TimeInterval = 60
    /// How long between one question to the page and the next.
    static let retryAfter: TimeInterval = 0.3

    /// Asks the page, and calls back with whether it took the message. The web view's
    /// controller sets it (FoxyWebView.swift).
    var tell: ((@escaping (Bool) -> Void) -> Void)?
    // the clock, the timer and the log, replaceable so FoxyTests can run them by hand
    var now: () -> Date = { Date() }
    var wait: (TimeInterval, @escaping () -> Void) -> Void = { seconds, run in
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: run)
    }
    var say: (String) -> Void = { print("[foxy] card tap: " + $0) }

    /// When the tap that has not been told yet arrived, or nil.
    private(set) var since: Date?
    private var asking = false
    private var loaded = false
    private var covered = true
    private var returning = false

    /// An address arrived, by whichever way iOS delivered it. Anything but the card's own is
    /// dropped without a word.
    func received(_ url: URL?) {
        guard CardAddress.isCard(url) else { return }
        cardTapped()
    }

    /// A card was tapped. Addresses while one waits are the same tap, and a later one
    /// renews how long it waits.
    func cardTapped() {
        if since == nil { say("a card's address arrived") }
        since = now()
        attempt()
    }

    /// The page has finished loading. It has not necessarily booted: the question is
    /// asked, and asked again, until it answers yes.
    func pageLoaded() {
        loaded = true
        attempt()
    }

    /// The page is gone (its process ended) and is being loaded again.
    func pageGone() {
        loaded = false
    }

    /// The launch image or the app-switcher cover went up or came down.
    func coverChanged(up: Bool) {
        covered = up
        if !up { attempt() }
    }

    /// Foxy went to the background: nothing is told until it is back and the page has
    /// been told so.
    func wentToBackground() {
        returning = true
    }

    /// Foxy is back and the page has been told it is (`_resumed`).
    func cameBack() {
        returning = false
        attempt()
    }

    /// Whether the page may be asked now.
    var ready: Bool { loaded && !covered && !returning }

    private func attempt() {
        guard let began = since else { return }
        if now().timeIntervalSince(began) >= Self.lapse {
            since = nil
            say("given up, the page did not take it within a minute")
            return
        }
        guard ready, !asking, let tell else { return }
        asking = true
        tell { [weak self] taken in
            guard let self else { return }
            self.asking = false
            guard self.since != nil else { return }
            if taken {
                self.since = nil
                self.say("told the page")
                return
            }
            self.wait(Self.retryAfter) { [weak self] in self?.attempt() }
        }
    }
}
