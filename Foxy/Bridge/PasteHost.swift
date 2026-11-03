import UIKit
import WebKit

// MARK: - system paste button

/// Hosts a `UIPasteControl` and forwards whatever it pastes.
///
/// `UIPasteControl` hands its payload to a target that supports paste
/// configuration, which is what this view is for.
// UIView already conforms to UIPasteConfigurationSupporting, so the protocol is
// not restated here — doing so is a compile error, not a redundancy warning.
final class PasteHost: UIView {

    private let onText: (String) -> Void
    private weak var control: UIPasteControl?
    /// Armed by a touch on the control, cancelled by the paste it brings.
    private var tapCheck: DispatchWorkItem?
    private var pastedOnce = false

    init(onText: @escaping (String) -> Void) {
        self.onText = onText
        super.init(frame: .zero)
        backgroundColor = .clear
        pasteConfiguration = UIPasteConfiguration(forAccepting: NSString.self)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Build the control.
    ///
    /// `invisible` draws it with clear background and clear label, so the app's
    /// own designed button shows through while Apple's control still takes the
    /// tap. Both colours are supported configuration, so nothing is being
    /// subverted — but note this does go against the intent of the API, which
    /// is for people to recognise the system paste button. Setting `alpha` to
    /// zero instead would not work: UIKit skips hit-testing on views below
    /// about 1% opacity, so the button would stop responding.
    ///
    /// A visible yellow system button was tried after a security
    /// review and taken back out: it covered the designed button and did not
    /// match the app. Kept invisible by design.
    func build(cornerRadius: CGFloat, invisible: Bool = true) {
        let config = UIPasteControl.Configuration()
        config.displayMode = .labelOnly
        config.cornerStyle = .capsule
        config.baseBackgroundColor = invisible ? .clear
            : UIColor(red: 1, green: 0.949, blue: 0.016, alpha: 1)   // the accent yellow
        config.baseForegroundColor = invisible ? .clear : .black

        let control = UIPasteControl(configuration: config)
        control.target = self
        control.frame = bounds
        control.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        if invisible {
            // Clear colours alone are not enough — the control still paints its
            // own system background. Opacity is the only thing that reliably
            // hides it. It cannot go to zero: UIKit skips hit-testing below
            // roughly 1% opacity, so the button would stop taking taps. 2% is
            // under the threshold of sight and above the threshold of touch.
            control.alpha = 0.02
        }

        addSubview(control)
        self.control = control
    }

    /// A tap that pasted nothing.
    ///
    /// Seen on a phone: a token copied inside Foxy, home,
    /// PASTE. The control took the touch — its hit test armed the prompt
    /// window — and nothing followed: no paste, no prompt, no log line, and
    /// the page's own PASTE underneath never heard the tap because the
    /// control had it. The same steps on the simulator pasted at once, so
    /// what disabled the control is not known; what is known is that a dead
    /// system button over a live page button is the worst of both.
    ///
    /// So a touch starts a short clock. If no paste has arrived when it runs
    /// out and Foxy is still the active app — iOS's "Allow Paste" alert
    /// takes focus, so a prompt on screen stops this — the pasteboard is
    /// read the way the page's own button reads it (FoxyBridge.readClipboard):
    /// text only, never a seed phrase, and it names the control's state so
    /// the next diary says which it was.
    private func touched() {
        guard tapCheck == nil else { return }
        pastedOnce = false
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.tapCheck = nil
            guard !self.pastedOnce, self.window != nil,
                  UIApplication.shared.applicationState == .active else { return }
            let state = self.control.map { $0.isEnabled ? "enabled" : "disabled" } ?? "gone"
            guard UIPasteboard.general.hasStrings else {
                print("[foxy] paste control took a tap and pasted nothing (\(state)); the pasteboard has no text")
                return
            }
            print("[foxy] paste control took a tap and pasted nothing (\(state)); reading the pasteboard directly")
            self.pastedOnce = true
            FoxyBridge.pastePromptUntil = Date().addingTimeInterval(2)
            self.onText(UIPasteboard.general.string ?? "")
        }
        tapCheck = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        itemProviders.contains { $0.canLoadObject(ofClass: NSString.self) }
    }

    /// A touch on the control can bring up iOS's "Allow Paste" alert (it did
    /// for a tap the simulator made), which takes focus the way
    /// FoxyBridge.readClipboard's read does: not leaving Foxy, so no splash
    /// over the screen (WebHostController.resigningActive). Given back when
    /// Foxy is active again or the text arrives.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        if hit != nil, event?.type == .touches {
            FoxyBridge.pastePromptUntil = Date().addingTimeInterval(30)
            touched()
        }
        return hit
    }

    override func paste(itemProviders: [NSItemProvider]) {
        guard let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return }
        provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
            guard let text = object as? NSString else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                FoxyBridge.pastePromptUntil = Date().addingTimeInterval(2)
                self.tapCheck?.cancel()
                self.tapCheck = nil
                // the direct read already handed this tap's text over
                if self.pastedOnce { return }
                self.pastedOnce = true
                self.onText(text as String)
            }
        }
    }
}

// MARK: - where the paste button may go

/// The page's paste buttons, which are the only places the system paste button
/// is put: an element marked `data-foxy-paste="1"`, the home screen's PASTE and
/// the send screen's, whose label says PASTE.
///
/// The page says where it wants the button, and the bridge used to take any
/// rectangle in the lower two-thirds of the screen, which is where the confirm
/// buttons are too: a script in the page could have parked it over one and
/// turned a tap meant for it into a clipboard read with no prompt. Now the
/// place is checked against the page itself, by a script in a world of its own
/// (WKContentWorld.defaultClient), where the page's own scripts cannot change
/// what the browser's functions answer: what is drawn at the middle of that
/// rectangle must be one of the registered paste buttons, shown, its label
/// PASTE, and its box the rectangle asked for. Anything else is refused.
enum PasteAffordance {
    /// The mark each paste button carries, and its value.
    static let mark = "data-foxy-paste"
    static let registered = "1"
    /// The word on every one of them.
    static let word = "PASTE"
    /// How far, in points, the box may be from the rectangle asked for: the
    /// page rounds what it measures.
    static let slack: CGFloat = 2

    /// What the check runs in the page, for the rectangle asked for.
    static func script(for rect: CGRect) -> String {
        let x = Double(rect.midX), y = Double(rect.midY)
        return """
        (function () {
          var at = document.elementFromPoint(\(x), \(y));
          var b = at && at.closest('[\(mark)="\(registered)"]');
          if (!b) return { found: false };
          var r = b.getBoundingClientRect();
          var s = window.getComputedStyle(b);
          var words = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toUpperCase();
          return { found: true, x: r.left, y: r.top, w: r.width, h: r.height,
                   word: words.indexOf('\(word)') >= 0,
                   shown: s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) >= 0.5 };
        })()
        """
    }

    /// Whether the page's answer is a registered paste button at `rect`.
    static func accepts(_ answer: Any?, rect: CGRect) -> Bool {
        guard let a = answer as? [String: Any], a["found"] as? Bool == true,
              a["word"] as? Bool == true, a["shown"] as? Bool == true,
              let x = (a["x"] as? NSNumber)?.doubleValue, let y = (a["y"] as? NSNumber)?.doubleValue,
              let w = (a["w"] as? NSNumber)?.doubleValue, let h = (a["h"] as? NSNumber)?.doubleValue else { return false }
        let box = CGRect(x: x, y: y, width: w, height: h)
        return abs(box.minX - rect.minX) <= slack && abs(box.minY - rect.minY) <= slack
            && abs(box.width - rect.width) <= slack && abs(box.height - rect.height) <= slack
    }

    /// Ask the page, in a world of its own, whether `rect` is one of its paste
    /// buttons. `done` on the main queue; no answer is a no.
    static func check(_ rect: CGRect, in webView: WKWebView, _ done: @escaping (Bool) -> Void) {
        webView.evaluateJavaScript(script(for: rect), in: nil, in: .defaultClient) { result in
            switch result {
            case .success(let answer): done(accepts(answer, rect: rect))
            case .failure: done(false)
            }
        }
    }
}
