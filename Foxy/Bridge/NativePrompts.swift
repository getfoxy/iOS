import UIKit

/// One yes-or-no question, in an alert iOS draws.
struct NativePrompt {
    let title: String
    let message: String
    /// The cancel button: a no.
    let no: String
    let yes: String
    let yesStyle: UIAlertAction.Style
}

/// Every yes-or-no Foxy asks in an alert iOS draws, one at a time.
///
/// Three kinds used to be presented on their own: allowing a new host,
/// replacing or deleting the seed, and continuing without Tor. A second one
/// asked while the first was up was presented over it, or failed to present
/// and left its caller waiting; a Replace alert could sit on top of an Allow
/// alert (audit I3). Now each waits its turn in `shared`, and an
/// alert that is gone without an answer counts as a no.
enum NativePrompts {
    static let shared = PromptQueue(show: PromptQueue.alert, checkEvery: 1)

    /// Main queue only. `done` runs once, on the main queue: true only for a tap
    /// on the yes button.
    @discardableResult
    static func ask(_ prompt: NativePrompt, on presenter: UIViewController?,
                    _ done: @escaping (Bool) -> Void) -> PromptQueue.Ticket {
        shared.ask(prompt, on: presenter, done)
    }
}

/// The queue itself, with the way it shows a prompt passed in, so the unit
/// tests can run it without UIKit drawing anything. Main queue only.
final class PromptQueue {
    /// A prompt on screen: how to take it down, and whether it is still up.
    struct Shown {
        let dismiss: () -> Void
        let stillShown: () -> Bool
    }

    /// Show `prompt`, calling `answer` on a tap; nil when there is nothing to
    /// show it on, which is a no.
    typealias Show = (_ prompt: NativePrompt, _ presenter: UIViewController?,
                      _ answer: @escaping (Bool) -> Void) -> Shown?

    /// A prompt asked for. `cancel` answers it no, if it has no answer yet, and
    /// takes its alert down, so a late tap cannot count.
    final class Ticket {
        fileprivate weak var queue: PromptQueue?
        fileprivate let entry: Entry
        fileprivate init(queue: PromptQueue, entry: Entry) {
            self.queue = queue
            self.entry = entry
        }
        func cancel() {
            dispatchPrecondition(condition: .onQueue(.main))
            queue?.cancel(entry)
        }
    }

    fileprivate final class Entry {
        let prompt: NativePrompt
        weak var presenter: UIViewController?
        let done: (Bool) -> Void
        var answered = false
        var shown: Shown?
        /// Checks in a row that found the alert gone without an answer.
        var missing = 0
        init(prompt: NativePrompt, presenter: UIViewController?, done: @escaping (Bool) -> Void) {
            self.prompt = prompt
            self.presenter = presenter
            self.done = done
        }
    }

    private let show: Show
    /// How often the prompt on screen is checked for; nil, never (the tests call check()).
    private let checkEvery: TimeInterval?
    private var waiting: [Entry] = []
    private var current: Entry?

    init(show: @escaping Show, checkEvery: TimeInterval?) {
        self.show = show
        self.checkEvery = checkEvery
    }

    /// How many prompts are waiting behind the one on screen.
    var waitingCount: Int { waiting.count }
    var isShowing: Bool { current != nil }

    @discardableResult
    func ask(_ prompt: NativePrompt, on presenter: UIViewController?,
             _ done: @escaping (Bool) -> Void) -> Ticket {
        dispatchPrecondition(condition: .onQueue(.main))
        let entry = Entry(prompt: prompt, presenter: presenter, done: done)
        waiting.append(entry)
        pump()
        return Ticket(queue: self, entry: entry)
    }

    /// The next prompt, if none is on screen.
    private func pump() {
        while current == nil, !waiting.isEmpty {
            let entry = waiting.removeFirst()
            current = entry
            guard let shown = show(entry.prompt, entry.presenter, { [weak self, entry] yes in
                self?.answer(entry, yes)
            }) else {
                // nothing to present on: no
                answer(entry, false)
                continue
            }
            // an alert answered while it was being shown has already moved on
            if current === entry {
                entry.shown = shown
                scheduleCheck(entry)
            }
        }
    }

    private func answer(_ entry: Entry, _ yes: Bool) {
        guard !entry.answered else { return }
        entry.answered = true
        if current === entry { current = nil }
        entry.done(yes)
        pump()
    }

    fileprivate func cancel(_ entry: Entry) {
        guard !entry.answered else { return }
        if let i = waiting.firstIndex(where: { $0 === entry }) {
            waiting.remove(at: i)
        } else if current === entry {
            entry.shown?.dismiss()
        }
        answer(entry, false)
    }

    /// The alert on screen, if it is gone without an answer — it failed to
    /// present, or went down with the screen it was shown over — is a no.
    /// Two checks in a row must miss it, so a tap still being delivered as the
    /// alert goes down is not taken for a disappearance.
    func check() {
        guard let entry = current, !entry.answered, let shown = entry.shown else { return }
        if shown.stillShown() {
            entry.missing = 0
            return
        }
        entry.missing += 1
        if entry.missing >= 2 {
            print("[foxy] prompt gone without an answer, taken as no:", entry.prompt.title)
            answer(entry, false)
        }
    }

    private func scheduleCheck(_ entry: Entry) {
        guard let every = checkEvery else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + every) { [weak self, weak entry] in
            guard let self, let entry, self.current === entry, !entry.answered else { return }
            self.check()
            if self.current === entry { self.scheduleCheck(entry) }
        }
    }

    /// The real thing: a UIAlertController on the topmost screen.
    static func alert(_ prompt: NativePrompt, _ presenter: UIViewController?,
                      _ answer: @escaping (Bool) -> Void) -> Shown? {
        guard var top = presenter else { return nil }
        while let shown = top.presentedViewController { top = shown }
        let alert = UIAlertController(title: prompt.title, message: prompt.message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: prompt.no, style: .cancel) { _ in answer(false) })
        alert.addAction(UIAlertAction(title: prompt.yes, style: prompt.yesStyle) { _ in answer(true) })
        top.present(alert, animated: true)
        return Shown(
            dismiss: { [weak alert] in
                guard let alert, alert.presentingViewController != nil else { return }
                alert.dismiss(animated: true)
            },
            stillShown: { [weak alert] in alert?.presentingViewController != nil })
    }
}
