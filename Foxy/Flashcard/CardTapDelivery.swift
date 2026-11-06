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
///
/// An arrival. A person without Foxy who taps a card is sent to get it; once it is
/// installed they tap the card again, and that address opens a Foxy that has no wallet
/// yet. The first run (the words, what to hold) goes on as ever, and the card's screen
/// is what follows it. So on a first run (`firstRun`: no seed when Foxy started, said by
/// the launch) the address is not a tap but an arrival, `Arrival`, a named kind and a
/// code: kept here for as long as Foxy runs (in memory only), and asked of the page
/// (`askArrival`, `Arrival.pageCall`) every `arrivalEvery` while the page answers "keep",
/// so a page loaded again during the set-up has it too. The page opens it when home is
/// first reached and answers "shown"; "over" is a page whose first run was over before
/// the arrival came, and the arrival is then what it would have been on any other run
/// (`arrivalFallbacks`: a card's is a tap). Either answer ends the first run here. Off a
/// first run nothing of this is used and a card's address is a tap, as it always was.
/// The card's kind is this file's; a build can read other addresses as kinds of its
/// own (`arrivalReaders`, `arrive`).
struct Arrival: Equatable {
    /// What arrived, in lower-case letters: "card", or a kind a build adds.
    let kind: String
    /// What came with it, letters and digits only; "" for none.
    let code: String

    init?(kind: String, code: String = "") {
        let lower = Set("abcdefghijklmnopqrstuvwxyz")
        let plain = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        guard (1...16).contains(kind.count), kind.allSatisfy({ lower.contains($0) }),
              code.count <= 32, code.allSatisfy({ plain.contains($0) }) else { return nil }
        self.kind = kind
        self.code = code
    }

    static let card = Arrival(kind: "card")!

    /// What the page is asked: the kind and the code, both checked above to need no quoting.
    /// The answer is the page's "keep", "shown" or "over"; nothing, until the page has put
    /// `_arrived` on its wallet.
    var pageCall: String {
        "window.FoxyWallet && window.FoxyWallet._arrived && window.FoxyWallet._arrived('\(kind)', '\(code)')"
    }
}

final class CardTapDelivery {
    static let shared = CardTapDelivery()

    /// How long after the address arrived a tap is still told.
    static let lapse: TimeInterval = 60
    /// How long between one question to the page and the next.
    static let retryAfter: TimeInterval = 0.3
    /// How often an arrival the page keeps is asked about again, and how long one is kept at most.
    static let arrivalEvery: TimeInterval = 0.5
    static let arrivalLapse: TimeInterval = 30 * 60

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

    /// Whether Foxy started with no wallet: set by the launch, ended by the page's answer
    /// to an arrival.
    var firstRun = false
    /// Asks the page about an arrival, and calls back with its answer (nil for none). The
    /// web view's controller sets it (FoxyWebView.swift).
    var askArrival: ((Arrival, @escaping (String?) -> Void) -> Void)?
    /// Addresses other than the card's, read as arrivals by a build that has them; read
    /// only on a first run.
    var arrivalReaders: [(URL) -> Arrival?] = []
    /// What an arrival is on a run whose first run was over, by kind. The card's is a tap.
    var arrivalFallbacks: [String: (Arrival) -> Void] = [:]
    /// The arrival the page has not shown yet, and when it came.
    private(set) var arrival: Arrival?
    private var arrivalSince: Date?
    private var askingArrival = false

    /// An address arrived, by whichever way iOS delivered it. Anything but the card's own is
    /// dropped without a word, except on a first run, where a build's own readers may know it.
    func received(_ url: URL?) {
        if CardAddress.isCard(url) {
            if !arrive(.card) { cardTapped() }
            return
        }
        guard firstRun, let url else { return }
        for read in arrivalReaders {
            if let found = read(url) { arrive(found); return }
        }
    }

    /// An arrival, kept for the end of the first run: true when it was, false when this is
    /// not a first run and the caller does what it always did.
    @discardableResult
    func arrive(_ found: Arrival) -> Bool {
        guard firstRun else { return false }
        if arrival == nil { say("an arrival was kept for the end of the first run") }
        arrival = found
        arrivalSince = now()
        attemptArrival()
        return true
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
        attemptArrival()
    }

    /// The page is gone (its process ended) and is being loaded again.
    func pageGone() {
        loaded = false
    }

    /// The launch image or the app-switcher cover went up or came down.
    func coverChanged(up: Bool) {
        covered = up
        if !up { attempt(); attemptArrival() }
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
        attemptArrival()
    }

    /// Whether the page may be asked now.
    var ready: Bool { loaded && !covered && !returning }

    private func attemptArrival() {
        guard let found = arrival, let began = arrivalSince else { return }
        if now().timeIntervalSince(began) >= Self.arrivalLapse {
            arrival = nil
            arrivalSince = nil
            say("an arrival given up, the first run did not reach home within half an hour")
            return
        }
        guard ready, !askingArrival, let askArrival else { return }
        askingArrival = true
        askArrival(found) { [weak self] answer in
            guard let self else { return }
            self.askingArrival = false
            // another arrived while the page was asked: that one is asked about now
            guard self.arrival == found else { self.attemptArrival(); return }
            switch answer {
            case "shown":
                self.arrival = nil
                self.arrivalSince = nil
                self.firstRun = false
                self.say("the page showed the arrival")
            case "over":
                self.arrival = nil
                self.arrivalSince = nil
                self.firstRun = false
                self.say("the first run was over before the arrival came")
                if found == .card { self.cardTapped() } else { self.arrivalFallbacks[found.kind]?(found) }
            default:
                self.wait(Self.arrivalEvery) { [weak self] in self?.attemptArrival() }
            }
        }
    }

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
