import UIKit
import Security

/* Foxy's own seed screens, drawn natively over the web view, in every build
 * (NativeSeedBridge.swift): the twelve words with
 * their verify quiz (seedShow), and twelve words typed for a restore
 * (seedEnter). With these the page never holds the words. Their wording is the
 * page's: showSeed in build/app/14-reconcile-seed-restore.js, showVerify in
 * 08-mint-entry-and-notes.js, and the restore screen's in
 * 27-render-mints-restore-backup.js. */

// MARK: - The pure parts (FoxyTests/NativeSeedTests.swift)

/// The verify quiz: the words scrambled, and tapped back in order.
struct SeedQuiz {
    let words: [String]
    /// The words in the order their tiles are drawn, fixed for a phrase.
    let pool: [String]
    /// Per tile, whether it has been placed.
    private(set) var used: [Bool]
    private(set) var picked: [String] = []

    enum Tap: Equatable {
        case right
        /// Not the next word: the quiz starts again, and `expected` is the word
        /// number that was due, from 1.
        case wrong(expected: Int)
        case done
        /// A tile already placed, a tile that does not exist, or a finished quiz.
        case ignored
    }

    /// `random(n)` is a number below n: the system's random source, unless a
    /// test gives its own.
    init(words: [String], random: (_ below: UInt32) -> UInt32 = SeedQuiz.systemRandom(below:)) {
        self.words = words
        pool = Self.scramble(words, random: random)
        used = Array(repeating: false, count: words.count)
    }

    var isComplete: Bool { !words.isEmpty && picked.count == words.count }

    /// Tiles are tracked by place, not by word, so a phrase with a repeated
    /// word can still be finished.
    mutating func tap(_ tile: Int) -> Tap {
        guard pool.indices.contains(tile), !used[tile], !isComplete else { return .ignored }
        guard pool[tile] == words[picked.count] else {
            let expected = picked.count + 1
            picked = []
            used = Array(repeating: false, count: words.count)
            return .wrong(expected: expected)
        }
        used[tile] = true
        picked.append(pool[tile])
        return isComplete ? .done : .right
    }

    /// The tiles' order: a Fisher–Yates shuffle of places, drawn afresh for every
    /// quiz. It used to be the page's scramble, seeded by a 32-bit hash of the
    /// words, so a photo of the tiles gave their order back offline (review
    /// L3). Places are shuffled, not words, so a repeated word stays
    /// two tiles.
    static func scramble(_ words: [String], random: (_ below: UInt32) -> UInt32) -> [String] {
        var out = words
        var i = out.count - 1
        while i > 0 {
            let bound = UInt32(i + 1)
            out.swapAt(i, Int(random(bound) % bound))
            i -= 1
        }
        return out
    }

    /// A number below `n` from SecRandomCopyBytes, with no modulo bias. Should
    /// that source fail, Swift's system generator, also a cryptographic one.
    static func systemRandom(below n: UInt32) -> UInt32 {
        guard n > 1 else { return 0 }
        // the largest multiple of n that fits: draws at or above it are drawn again
        let limit = UInt32.max - UInt32.max % n
        while true {
            var value: UInt32 = 0
            let status = withUnsafeMutableBytes(of: &value) { SecRandomCopyBytes(kSecRandomDefault, 4, $0.baseAddress!) }
            guard status == errSecSuccess else { return UInt32.random(in: 0..<n) }
            if value < limit { return value % n }
        }
    }
}

/// The restore screen's twelve cells.
enum SeedEntry {
    static let cells = 12

    /// Lowercase ASCII letters are all a BIP-39 English word has.
    static func isLetter(_ c: Character) -> Bool {
        c.isASCII && c >= "a" && c <= "z"
    }

    /// The words in what was typed, as the page reads a cell: lowercased, and
    /// split at anything that is not a letter.
    static func parts(_ typed: String) -> [String] {
        typed.lowercased().split(whereSeparator: { !isLetter($0) }).map(String.init)
    }

    /// Cell `index` after `typed`. Several words, a pasted phrase, fill that cell
    /// and the ones after it.
    static func apply(_ typed: String, at index: Int, to cells: [String]) -> [String] {
        var out = cells
        guard out.indices.contains(index) else { return out }
        let words = parts(typed)
        if words.count > 1 {
            for (k, word) in words.enumerated() where index + k < out.count { out[index + k] = word }
        } else {
            out[index] = words.first ?? ""
        }
        return out
    }

    struct Check: Equatable {
        /// Cells, from 0, holding something that is not on the list.
        let unknown: [Int]
        let filled: Int
        /// Twelve words on the list, with the checksum right.
        let valid: Bool
    }

    static func check(_ cells: [String], wordlist: [String]) -> Check {
        let unknown = cells.indices.filter { !cells[$0].isEmpty && BIP39.index(of: cells[$0], in: wordlist) == nil }
        let filled = cells.filter { !$0.isEmpty }.count
        let valid = cells.count == Self.cells && filled == Self.cells && unknown.isEmpty
            && BIP39.isValid(cells, wordlist: wordlist)
        return Check(unknown: unknown, filled: filled, valid: valid)
    }

    static func phrase(_ cells: [String]) -> String {
        cells.joined(separator: " ")
    }

    /// The restore screen while the screen is recorded, mirrored or shared
    /// (review M3). Hiding the cells was not enough: the bar above
    /// the keyboard kept offering each word, the field kept its focus, and the
    /// keyboard's key pop-ups showed what was typed. So while captured no cell
    /// is being edited, none can be, the bar is empty and hidden, and the cells'
    /// box shows its notice. When capture ends the cells take typing again, but
    /// no cell is focused for the person: a tap puts the keyboard back.
    struct Capture: Equatable {
        private(set) var captured = false

        var fieldsEnabled: Bool { !captured }
        var suggestionsShown: Bool { !captured }
        var noticeShown: Bool { captured }

        struct Step: Equatable {
            /// End editing and give up the keyboard, now.
            let endEditing: Bool
        }

        /// The capture state now: checked when the screen appears and on every
        /// change. Every captured answer ends editing again.
        mutating func set(_ now: Bool) -> Step {
            captured = now
            return Step(endEditing: now)
        }

        /// The words offered above the keyboard for the focused cell's text.
        func suggestions(_ typed: String?, wordlist: [String]) -> [String] {
            guard suggestionsShown, let typed else { return [] }
            return BIP39.suggestions(typed, wordlist: wordlist)
        }
    }
}

/// One job at a time, and none started while an alert of NativePrompts is up,
/// so a seed screen never draws over another or over a question. A job calls
/// `finished` once its screen is gone. Main queue only.
final class ScreenQueue {
    typealias Job = (_ finished: @escaping () -> Void) -> Void

    private var jobs: [(run: Job, cancel: () -> Void)] = []
    private(set) var running = false
    /// Moves on at every cancelAll: a job already running when it did, whose
    /// screen is not up yet, answers as cancelled instead of showing it.
    private(set) var generation = 0
    private let alertShowing: () -> Bool
    /// How soon to look again while an alert is up; nil, never (the tests call pump()).
    private let retryEvery: TimeInterval?

    init(alertShowing: @escaping () -> Bool, retryEvery: TimeInterval?) {
        self.alertShowing = alertShowing
        self.retryEvery = retryEvery
    }

    var waitingCount: Int { jobs.count }

    /// A job waiting or running: seedShow and seedEnter are refused then
    /// (review L1).
    var busy: Bool { running || !jobs.isEmpty }

    /// `onCancel` answers the job's request if cancelAll drops it before it starts.
    func enqueue(onCancel: @escaping () -> Void = {}, _ job: @escaping Job) {
        dispatchPrecondition(condition: .onQueue(.main))
        jobs.append((run: job, cancel: onCancel))
        pump()
    }

    /// Drops every waiting job, answering each as cancelled, and moves
    /// `generation` on for the running one.
    func cancelAll() {
        dispatchPrecondition(condition: .onQueue(.main))
        generation += 1
        let dropped = jobs
        jobs = []
        dropped.forEach { $0.cancel() }
    }

    func pump() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !running, !jobs.isEmpty else { return }
        guard !alertShowing() else {
            if let every = retryEvery {
                DispatchQueue.main.asyncAfter(deadline: .now() + every) { [weak self] in self?.pump() }
            }
            return
        }
        running = true
        let job = jobs.removeFirst().run
        var over = false
        job { [weak self] in
            dispatchPrecondition(condition: .onQueue(.main))
            guard !over else { return }
            over = true
            self?.running = false
            self?.pump()
        }
    }
}

/// A pause after a seedShow whose read of the words failed, most often Face ID
/// or the passcode cancelled, so a script cannot put the prompt straight back
/// up, over and over (review L1).
struct RetryPause {
    let span: TimeInterval
    private(set) var since: Date?

    init(span: TimeInterval) {
        self.span = span
    }

    /// A clock set back never refuses for good.
    func refuses(at now: Date) -> Bool {
        guard let since, now >= since else { return false }
        return now.timeIntervalSince(since) < span
    }

    mutating func start(at now: Date) {
        since = now
    }
}

// MARK: - Presenting

enum SeedScreens {
    static let queue = ScreenQueue(alertShowing: { NativePrompts.shared.isShowing }, retryEvery: 0.5)

    static let busyRefusal = "a seed screen is already open"
    static let pauseRefusal = "try again in a moment"
    /// After a failed read for the words screen. Main queue.
    static var showPause = RetryPause(span: 10)

    private static var seedChanges: NSObjectProtocol?

    /// A seed written or deleted (FoxySeedChanged, posted on the main queue)
    /// closes any seed screen and cancels any waiting, so no screen shows words
    /// read before the change (review L4). Started by the first
    /// seedShow or seedEnter, before any screen can exist. Main queue.
    static func watchSeedChanges() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard seedChanges == nil else { return }
        seedChanges = NotificationCenter.default.addObserver(
            forName: Notification.Name("FoxySeedChanged"), object: nil, queue: .main) { _ in
            print("[foxy] the seed changed; seed screens closed")
            closeAll()
        }
    }

    /// The seed screen up now, if any: there is only ever one.
    private static weak var current: SeedScreenController?

    /// Over whatever is on top. Main queue.
    static func present(_ screen: SeedScreenController, on presenter: UIViewController) {
        dispatchPrecondition(condition: .onQueue(.main))
        var top = presenter
        while let shown = top.presentedViewController { top = shown }
        current = screen
        top.present(screen, animated: true)
        // A presentation UIKit refused (the screen under it was on its way out)
        // would leave the queue waiting for good, and the page for its answer.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak screen] in
            guard let screen, screen.presentingViewController == nil else { return }
            print("[foxy] a seed screen did not appear; answered as closed")
            screen.close()
        }
    }

    /// Foxy went to the background, the page went, or the seed changed. A seed
    /// screen left up would sit over the page's PIN lock when Foxy came back,
    /// showing the words to whoever holds the phone, so it closes with the answer
    /// its back button gives. Screens still waiting are answered the same way and
    /// never shown. Main queue.
    static func closeAll() {
        dispatchPrecondition(condition: .onQueue(.main))
        queue.cancelAll()
        current?.close()
    }
}

// MARK: - Style

/// Foxy's look, as the page draws it: near-black, warm white, the orange, and
/// bold spaced capitals for titles and buttons.
enum SeedStyle {
    static let background = UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
    static let ink = UIColor(red: 245 / 255, green: 241 / 255, blue: 236 / 255, alpha: 1)
    static let accent = UIColor(red: 242 / 255, green: 128 / 255, blue: 46 / 255, alpha: 1)
    static let red = UIColor(red: 1, green: 92 / 255, blue: 92 / 255, alpha: 1)

    static func ink(_ alpha: CGFloat) -> UIColor { ink.withAlphaComponent(alpha) }

    static func spaced(_ text: String, size: CGFloat, weight: UIFont.Weight = .heavy,
                       color: UIColor = ink, kern: CGFloat = 1) -> NSAttributedString {
        NSAttributedString(string: text.uppercased(), attributes: [
            .font: UIFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
            .kern: kern,
        ])
    }

    static func title(_ text: String) -> UILabel {
        let label = UILabel()
        label.attributedText = spaced(text, size: 22, kern: 1.4)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.accessibilityTraits = .header
        return label
    }

    static func body(_ text: String, size: CGFloat = 18, color: UIColor = ink(0.62)) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: size, weight: .semibold)
        label.textColor = color
        label.textAlignment = .center
        label.numberOfLines = 0
        return label
    }

    static func rule() -> UIView {
        let line = UIView()
        line.backgroundColor = ink(0.12)
        line.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return line
    }

    /// The page's main button: full width, 60 points, the orange.
    static func primaryButton(_ title: String) -> UIButton {
        let button = UIButton(type: .custom)
        button.layer.cornerRadius = 30
        button.heightAnchor.constraint(equalToConstant: 60).isActive = true
        setPrimary(button, title: title, enabled: true)
        return button
    }

    static func setPrimary(_ button: UIButton, title: String, enabled: Bool) {
        button.isEnabled = enabled
        button.backgroundColor = enabled ? accent : ink(0.14)
        let text = spaced(title, size: 18, color: enabled ? .white : ink(0.4), kern: 1.2)
        button.setAttributedTitle(text, for: .normal)
        button.setAttributedTitle(text, for: .disabled)
    }

    static func backButton() -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "arrow.left",
                                withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .semibold)), for: .normal)
        button.tintColor = ink
        button.backgroundColor = ink(0.07)
        button.layer.cornerRadius = 26
        button.layer.borderWidth = 1
        button.layer.borderColor = ink(0.16).cgColor
        button.accessibilityLabel = "Back"
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 52),
            button.heightAnchor.constraint(equalToConstant: 52),
        ])
        return button
    }

    static let nativeBarText = "On this iPhone · not the web page"

    /// The top of every seed screen: a bar of iOS's own material, a lock, and
    /// where the screen is. The page draws nothing like it, and the sheet the
    /// screen sits in shows Foxy's page behind it (review L8).
    static func nativeBar() -> UIVisualEffectView {
        let bar = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
        let lock = UIImageView(image: UIImage(systemName: "lock.shield",
                                              withConfiguration: UIImage.SymbolConfiguration(textStyle: .subheadline, scale: .large)))
        lock.tintColor = .systemGreen
        lock.setContentHuggingPriority(.required, for: .horizontal)
        let label = UILabel()
        label.text = nativeBarText
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textColor = .label
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.8
        let row = UIStackView(arrangedSubviews: [lock, label])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 7
        let line = UIView()
        line.backgroundColor = .separator
        [row, line].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            bar.contentView.addSubview($0)
        }
        NSLayoutConstraint.activate([
            row.centerXAnchor.constraint(equalTo: bar.contentView.centerXAnchor),
            row.leadingAnchor.constraint(greaterThanOrEqualTo: bar.contentView.leadingAnchor, constant: 16),
            // room above the row for the sheet's grabber
            row.topAnchor.constraint(equalTo: bar.contentView.topAnchor, constant: 20),
            row.bottomAnchor.constraint(equalTo: bar.contentView.bottomAnchor, constant: -11),
            line.leadingAnchor.constraint(equalTo: bar.contentView.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: bar.contentView.trailingAnchor),
            line.bottomAnchor.constraint(equalTo: bar.contentView.bottomAnchor),
            line.heightAnchor.constraint(equalToConstant: 0.5),
        ])
        bar.isAccessibilityElement = true
        bar.accessibilityLabel = nativeBarText
        return bar
    }

    /// TAP TO REVEAL over `target`, inside `container`: iOS's blur, a button over
    /// it and the pill. What is under it must be stand-ins, never the words.
    static func veil(over target: UIView, in container: UIView, onReveal: @escaping () -> Void) {
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        blur.isUserInteractionEnabled = false
        blur.layer.cornerRadius = 15
        blur.clipsToBounds = true
        let veil = UIButton(type: .custom)
        veil.accessibilityLabel = "Tap to reveal"
        let pill = UILabel()
        pill.attributedText = spaced("TAP TO REVEAL", size: 16, color: ink, kern: 0.7)
        pill.textAlignment = .center
        pill.backgroundColor = UIColor.black.withAlphaComponent(0.62)
        pill.layer.cornerRadius = 24
        pill.layer.borderWidth = 1
        pill.layer.borderColor = ink(0.16).cgColor
        pill.clipsToBounds = true
        pill.isUserInteractionEnabled = false
        [blur, veil, pill].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview($0)
        }
        NSLayoutConstraint.activate([
            blur.topAnchor.constraint(equalTo: target.topAnchor),
            blur.bottomAnchor.constraint(equalTo: target.bottomAnchor),
            blur.leadingAnchor.constraint(equalTo: target.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: target.trailingAnchor),
            veil.topAnchor.constraint(equalTo: target.topAnchor),
            veil.bottomAnchor.constraint(equalTo: target.bottomAnchor),
            veil.leadingAnchor.constraint(equalTo: target.leadingAnchor),
            veil.trailingAnchor.constraint(equalTo: target.trailingAnchor),
            pill.centerXAnchor.constraint(equalTo: target.centerXAnchor),
            pill.centerYAnchor.constraint(equalTo: target.centerYAnchor),
            pill.heightAnchor.constraint(equalToConstant: 48),
            pill.widthAnchor.constraint(equalTo: pill.heightAnchor, multiplier: 4.2),
        ])
        veil.addAction(UIAction { _ in onReveal() }, for: .touchUpInside)
    }

    enum Chip {
        case tile, used, placed, empty

        var background: UIColor {
            switch self {
            case .tile: return UIColor(red: 23 / 255, green: 23 / 255, blue: 26 / 255, alpha: 1)
            case .used: return ink(0.06)
            case .placed: return UIColor(red: 42 / 255, green: 42 / 255, blue: 46 / 255, alpha: 1)
            case .empty: return .clear
            }
        }
        var text: UIColor {
            switch self {
            case .tile, .placed: return ink
            case .used: return ink(0.24)
            case .empty: return ink(0.38)
            }
        }
        var stroke: UIColor? {
            switch self {
            case .tile: return ink(0.16)
            case .empty: return ink(0.22)
            case .used, .placed: return nil
            }
        }
    }

    /// A word in the quiz: a tile to tap, a tile used, a word placed with its
    /// number, or an empty numbered place.
    static func chip(_ text: String, number: Int? = nil, _ kind: Chip) -> UIButton {
        var title = AttributedString()
        if let number {
            var n = AttributedString("\(number)  ")
            n.uiKit.font = .systemFont(ofSize: 14, weight: .heavy)
            n.uiKit.foregroundColor = ink(0.45)
            title += n
        }
        var word = AttributedString(text)
        word.uiKit.font = .systemFont(ofSize: 18, weight: .bold)
        word.uiKit.foregroundColor = kind.text
        title += word
        var config = UIButton.Configuration.plain()
        config.attributedTitle = title
        config.baseForegroundColor = kind.text
        config.contentInsets = NSDirectionalEdgeInsets(top: 11, leading: 14, bottom: 11, trailing: 14)
        config.background.backgroundColor = kind.background
        config.background.cornerRadius = 16
        if let stroke = kind.stroke {
            config.background.strokeColor = stroke
            config.background.strokeWidth = 1.5
        }
        let button = UIButton(configuration: config)
        button.isUserInteractionEnabled = kind == .tile
        return button
    }
}

/// Views in centred rows that wrap, as the page's flex-wrap does.
final class FlowView: UIView {
    var spacing: CGFloat = 8
    private var laidOutWidth: CGFloat = -1

    func setItems(_ items: [UIView]) {
        subviews.forEach { $0.removeFromSuperview() }
        items.forEach { addSubview($0) }
        laidOutWidth = -1
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: arrange(width: bounds.width, apply: false))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        _ = arrange(width: bounds.width, apply: true)
        if bounds.width != laidOutWidth {
            laidOutWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    /// The height the rows take at `width`, placing them when `apply`.
    private func arrange(width: CGFloat, apply: Bool) -> CGFloat {
        guard width > 0, !subviews.isEmpty else { return 0 }
        var rows: [[(UIView, CGSize)]] = [[]]
        var rowWidth: CGFloat = 0
        for item in subviews {
            var size = item.intrinsicContentSize
            size.width = min(size.width, width)
            if !rows[rows.count - 1].isEmpty, rowWidth + spacing + size.width > width {
                rows.append([])
                rowWidth = 0
            }
            rowWidth += (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
            rows[rows.count - 1].append((item, size))
        }
        var y: CGFloat = 0
        for row in rows {
            let used = row.reduce(0) { $0 + $1.1.width } + spacing * CGFloat(row.count - 1)
            let height = row.map { $0.1.height }.max() ?? 0
            var x = (width - used) / 2
            for (item, size) in row {
                if apply { item.frame = CGRect(x: x, y: y + (height - size.height) / 2, width: size.width, height: size.height) }
                x += size.width + spacing
            }
            y += height + spacing
        }
        return y - spacing
    }
}

/// Words on a screen, and what shows instead while the screen is recorded,
/// mirrored or shared.
final class SecretBox: UIView {
    let content = UIView()
    private let notice = SeedStyle.body("Hidden while the screen is recorded or shared", size: 17)

    init() {
        super.init(frame: .zero)
        content.translatesAutoresizingMaskIntoConstraints = false
        notice.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        addSubview(notice)
        notice.isHidden = true
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            notice.centerYAnchor.constraint(equalTo: centerYAnchor),
            notice.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            notice.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            heightAnchor.constraint(greaterThanOrEqualTo: notice.heightAnchor, constant: 24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    /// A hidden view is not in a recording; a blurred one could be read back.
    func setCaptured(_ captured: Bool) {
        content.isHidden = captured
        notice.isHidden = !captured
    }
}

// MARK: - The screens

/// What every seed screen shares: a sheet of iOS's with the native bar on top,
/// Foxy's colours inside, the words hidden while the screen is captured, a
/// warning after a screenshot, and one answer, given once the screen is gone.
class SeedScreenController: UIViewController {
    private var finished = false
    private var boxes: [SecretBox] = []
    private var shotWarning: UIView?
    private var opened = false
    /// iOS's material and the lock: the screen's content starts below it.
    let lockBar = SeedStyle.nativeBar()

    init() {
        super.init(nibName: nil, bundle: nil)
        // A page sheet with its grabber, so the host shows around the screen,
        // rather than a full screen a page could imitate edge to edge (L8).
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        // no swipe down: the only ways out answer the page
        isModalInPresentation = true
        overrideUserInterfaceStyle = .dark
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    /// Whether words are on this screen, for the screenshot warning.
    var showsWords: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = SeedStyle.background
        lockBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(lockBar)
        NSLayoutConstraint.activate([
            lockBar.topAnchor.constraint(equalTo: view.topAnchor),
            lockBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            lockBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (screen: SeedScreenController, _: UITraitCollection) in
            screen.captureChanged()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(screenshotTaken),
                                               name: UIApplication.userDidTakeScreenshotNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        captureChanged()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !opened else { return }
        opened = true
        // felt as the screen opens (L8)
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    }

    /// A box for words, hidden while the screen is captured.
    func secretBox() -> SecretBox {
        let box = SecretBox()
        boxes.append(box)
        box.setCaptured(FoxyBridge.screenCaptured(self))
        return box
    }

    func forgetBoxes() {
        boxes = []
    }

    func captureChanged() {
        let captured = FoxyBridge.screenCaptured(self)
        boxes.forEach { $0.setCaptured(captured) }
    }

    /// A back button at the top, a scrolling column under it, and `bottom`
    /// pinned below the column, above `floor` (the safe area unless given).
    func column(in container: UIView, bottom: UIView?, floor: NSLayoutYAxisAnchor? = nil) -> UIStackView {
        let back = SeedStyle.backButton()
        back.addAction(UIAction { [weak self] _ in self?.backTapped() }, for: .touchUpInside)
        let scroll = UIScrollView()
        scroll.indicatorStyle = .white
        scroll.keyboardDismissMode = .interactive
        let stack = UIStackView()
        stack.axis = .vertical
        [back, scroll, stack].forEach { $0.translatesAutoresizingMaskIntoConstraints = false }
        container.addSubview(back)
        container.addSubview(scroll)
        scroll.addSubview(stack)
        let guide = container.safeAreaLayoutGuide
        var constraints = [
            back.topAnchor.constraint(equalTo: lockBar.bottomAnchor, constant: 8),
            back.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 22),
            scroll.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: scroll.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 22),
            stack.widthAnchor.constraint(equalTo: scroll.widthAnchor, constant: -44),
        ]
        let limit = floor ?? guide.bottomAnchor
        if let bottom {
            bottom.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(bottom)
            constraints += [
                bottom.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 22),
                bottom.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -22),
                bottom.bottomAnchor.constraint(equalTo: limit, constant: -12),
                scroll.bottomAnchor.constraint(equalTo: bottom.topAnchor, constant: -10),
            ]
        } else {
            constraints.append(scroll.bottomAnchor.constraint(equalTo: limit))
        }
        NSLayoutConstraint.activate(constraints)
        return stack
    }

    // MARK: Screenshots

    /// iOS cannot stop a screenshot. One taken of the words is named for what it is.
    @objc private func screenshotTaken() {
        guard view.window != nil, !finished, showsWords else { return }
        print("[foxy] a screenshot was taken while a seed screen showed words")
        showScreenshotWarning()
    }

    private func showScreenshotWarning() {
        guard shotWarning == nil else { return }
        let backdrop = UIView()
        backdrop.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        let card = UIView()
        card.backgroundColor = UIColor(red: 20 / 255, green: 21 / 255, blue: 24 / 255, alpha: 1)
        card.layer.cornerRadius = 28
        card.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        card.layer.borderWidth = 1
        card.layer.borderColor = SeedStyle.accent.withAlphaComponent(0.5).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false
        let title = SeedStyle.title("THAT SCREENSHOT SHOWS YOUR SEED")
        let reason = SeedStyle.body("Anyone who sees that picture can take the money. Delete it from Photos, "
                                    + "then from Recently Deleted, and from anywhere it has already synced.")
        let closeButton = SeedStyle.primaryButton("CLOSE")
        closeButton.addAction(UIAction { [weak self, weak backdrop] _ in
            backdrop?.removeFromSuperview()
            self?.shotWarning = nil
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [title, reason, closeButton])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(24, after: reason)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(backdrop)
        backdrop.addSubview(card)
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: view.topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            backdrop.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            card.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            card.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 28),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -26),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
        ])
        shotWarning = backdrop
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        UIAccessibility.post(notification: .screenChanged, argument: title)
    }

    // MARK: Leaving

    /// The back button. It leaves the screen, unless a screen has somewhere of
    /// its own to go back to first.
    func backTapped() {
        close(animated: true)
    }

    /// Closed without finishing: the back button, Foxy going to the background,
    /// or the page going. Each screen gives its own answer for that.
    func close(animated: Bool = false) {
        finish(animated: animated) {}
    }

    /// Takes the screen down, then answers once it is gone, so the next one in
    /// the queue never draws over it. Only the first call counts.
    func finish(animated: Bool = true, _ answer: @escaping () -> Void) {
        guard !finished else { return }
        finished = true
        view.endEditing(true)
        // the one that presented this dismisses it, with anything drawn above it
        guard let presenting = presentingViewController else {
            answer()
            return
        }
        presenting.dismiss(animated: animated, completion: answer)
    }
}

/// seedShow: the words behind TAP TO REVEAL, the verify quiz, and BACKED UP.
final class SeedShowController: SeedScreenController {
    private enum Stage { case words, quiz, backedUp }

    private let words: [String]
    private var quiz: SeedQuiz
    private let answer: (_ verified: Bool, _ deleteAsked: Bool, _ revealed: Bool) -> Void
    private var stage: Stage
    /// DELETE ALL DATA was held down: the page asks twice, then the wipe asks
    /// iOS for Face ID or the passcode (seedWipe). Nothing is erased here.
    private var deleteAsked = false
    private var revealed = false
    private let page = UIView()
    private var quizSubtitle: UILabel?
    private var slots: FlowView?
    private var tiles: FlowView?

    /// `answer` runs once, on the main queue, after the screen is gone: whether
    /// the quiz was finished, and whether DELETE ALL DATA was held. The words
    /// and the quiz's tiles are both behind TAP TO REVEAL, which is tapped once
    /// per screen.
    init(words: [String], startOnQuiz: Bool, answer: @escaping (_ verified: Bool, _ deleteAsked: Bool, _ revealed: Bool) -> Void) {
        self.words = words
        quiz = SeedQuiz(words: words)
        self.answer = answer
        stage = startOnQuiz ? .quiz : .words
        super.init()
    }

    override var showsWords: Bool { stage != .backedUp }

    override func viewDidLoad() {
        super.viewDidLoad()
        page.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(page)
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: lockBar.bottomAnchor),
            page.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        build()
    }

    override func close(animated: Bool = false) {
        let verified = quiz.isComplete
        let deleteAsked = deleteAsked
        let revealed = revealed
        finish(animated: animated) { [answer] in answer(verified, deleteAsked, revealed) }
    }

    /// Back from the quiz is back to the words. Somebody who has tapped a wrong
    /// word wants to look at them again, and the back button used to close the
    /// whole screen and leave them at Foxy's own. What has been tapped in
    /// order so far is kept for when they return. From the words, and from
    /// BACKED UP, back leaves as it always did.
    override func backTapped() {
        if stage == .quiz {
            show(.words)
        } else {
            close(animated: true)
        }
    }

    private func show(_ next: Stage) {
        stage = next
        build()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func build() {
        page.subviews.forEach { $0.removeFromSuperview() }
        forgetBoxes()
        switch stage {
        case .words: buildWords()
        case .quiz: buildQuiz()
        case .backedUp: buildBackedUp()
        }
    }

    private func buildWords() {
        let verify = SeedStyle.primaryButton("VERIFY WORDS")
        verify.addAction(UIAction { [weak self] _ in self?.show(.quiz) }, for: .touchUpInside)
        /* DELETE ALL DATA lives here, on the phone's screen, and takes a long
         * press: a tap in passing does nothing. The screen
         * closes and Foxy asks twice before the wipe asks for Face ID. */
        let delete = UIButton(type: .custom)
        delete.layer.cornerRadius = 28
        delete.layer.borderWidth = 1.5
        delete.layer.borderColor = SeedStyle.red.withAlphaComponent(0.5).cgColor
        delete.backgroundColor = SeedStyle.red.withAlphaComponent(0.1)
        delete.heightAnchor.constraint(equalToConstant: 56).isActive = true
        delete.setAttributedTitle(SeedStyle.spaced("HOLD TO DELETE ALL DATA", size: 15, color: SeedStyle.red, kern: 1),
                                  for: .normal)
        delete.accessibilityHint = "Touch and hold to erase this wallet from the iPhone"
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(deleteHeld(_:)))
        hold.minimumPressDuration = 1.2
        delete.addGestureRecognizer(hold)
        delete.addAction(UIAction { _ in UISelectionFeedbackGenerator().selectionChanged() }, for: .touchDown)
        let buttons = UIStackView(arrangedSubviews: [verify, delete])
        buttons.axis = .vertical
        buttons.spacing = 12
        let stack = column(in: page, bottom: buttons)
        let title = SeedStyle.title("YOUR SEED PHRASE")
        let sub = SeedStyle.body("These twelve words recover everything, on any Cashu wallet. Anyone who has "
                                 + "them has your money. Write these down on paper, never take a photo of them "
                                 + "or save them on a computer.")
        let rule = SeedStyle.rule()
        var items: [(UIView, CGFloat)] = [(title, 10.0), (sub, 16.0)]
        // no passcode: nothing asked before this screen opens, and the person should know
        if !SeedVault.passcodeSet {
            items.append((SeedStyle.body("This iPhone has no passcode, so anyone who picks it up can open this "
                                         + "screen. Setting one in Settings makes Foxy ask for it first."), 16.0))
        }
        items.append((rule, 16.0))
        for (item, after) in items {
            stack.addArrangedSubview(item)
            stack.setCustomSpacing(after, after: item)
        }

        // Hidden until asked for: an open phrase is one shoulder away from gone,
        // and anyone holding the unlocked phone can reach this screen.
        let box = secretBox()
        let grid = UIStackView()
        grid.axis = .vertical
        grid.spacing = 9
        grid.translatesAutoresizingMaskIntoConstraints = false
        for first in stride(from: 0, to: words.count, by: 2) {
            let row = UIStackView(arrangedSubviews: [wordCell(first), first + 1 < words.count ? wordCell(first + 1) : UIView()])
            row.axis = .horizontal
            row.distribution = .fillEqually
            row.spacing = 9
            grid.addArrangedSubview(row)
        }
        box.content.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: box.content.topAnchor),
            grid.bottomAnchor.constraint(equalTo: box.content.bottomAnchor),
            grid.leadingAnchor.constraint(equalTo: box.content.leadingAnchor),
            grid.trailingAnchor.constraint(equalTo: box.content.trailingAnchor),
        ])
        if !revealed {
            // the words are not drawn at all until the tap, not only blurred
            SeedStyle.veil(over: grid, in: box.content) { [weak self] in self?.reveal() }
        }
        stack.addArrangedSubview(box)
    }

    private func reveal() {
        revealed = true
        build()
    }

    @objc private func deleteHeld(_ hold: UILongPressGestureRecognizer) {
        guard hold.state == .began, !deleteAsked else { return }
        deleteAsked = true
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        close(animated: true)
    }

    private func wordCell(_ i: Int) -> UIView {
        let cell = UIView()
        cell.backgroundColor = SeedStyle.ink(0.05)
        cell.layer.cornerRadius = 15
        cell.layer.borderWidth = 1
        cell.layer.borderColor = SeedStyle.ink(0.1).cgColor
        let number = UILabel()
        number.text = String(i + 1)
        number.font = .systemFont(ofSize: 14, weight: .bold)
        number.textColor = SeedStyle.ink(0.38)
        let word = UILabel()
        word.text = revealed ? words[i] : "••••••"
        word.font = .systemFont(ofSize: 20, weight: .bold)
        word.textColor = revealed ? SeedStyle.ink : SeedStyle.ink(0.3)
        word.adjustsFontSizeToFitWidth = true
        word.minimumScaleFactor = 0.7
        [number, word].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview($0)
        }
        NSLayoutConstraint.activate([
            cell.heightAnchor.constraint(equalToConstant: 54),
            number.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 13),
            number.widthAnchor.constraint(equalToConstant: 22),
            number.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            word.leadingAnchor.constraint(equalTo: number.trailingAnchor, constant: 10),
            word.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -10),
            word.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        cell.isAccessibilityElement = revealed
        cell.accessibilityLabel = revealed ? "\(i + 1), \(words[i])" : nil
        return cell
    }

    private func buildQuiz() {
        let tilesBox = secretBox()
        let tiles = FlowView()
        let stack = column(in: page, bottom: tilesBox)
        let title = SeedStyle.title("VERIFY")
        let sub = SeedStyle.body("Tap the twelve words back in order.", color: SeedStyle.ink)
        let rule = SeedStyle.rule()
        for (item, after) in [(title, 8.0), (sub, 14.0), (rule, 16.0)] as [(UIView, CGFloat)] {
            stack.addArrangedSubview(item)
            stack.setCustomSpacing(after, after: item)
        }
        let slotsBox = secretBox()
        let slots = FlowView()
        for (flow, box) in [(slots, slotsBox), (tiles, tilesBox)] {
            flow.translatesAutoresizingMaskIntoConstraints = false
            box.content.addSubview(flow)
            NSLayoutConstraint.activate([
                flow.topAnchor.constraint(equalTo: box.content.topAnchor),
                flow.bottomAnchor.constraint(equalTo: box.content.bottomAnchor),
                flow.leadingAnchor.constraint(equalTo: box.content.leadingAnchor),
                flow.trailingAnchor.constraint(equalTo: box.content.trailingAnchor),
            ])
        }
        if !revealed {
            // the tiles are the words, scrambled: behind the same tap (L3)
            SeedStyle.veil(over: tiles, in: tilesBox.content) { [weak self] in self?.reveal() }
        }
        stack.addArrangedSubview(slotsBox)
        quizSubtitle = sub
        self.slots = slots
        self.tiles = tiles
        drawQuiz()
    }

    private func drawQuiz() {
        var placed: [UIView] = quiz.picked.enumerated().map { SeedStyle.chip($0.element, number: $0.offset + 1, .placed) }
        for k in quiz.picked.count..<words.count {
            placed.append(SeedStyle.chip(String(k + 1), .empty))
        }
        slots?.setItems(placed)
        tiles?.setItems(quiz.pool.enumerated().map { tile, word in
            guard revealed else {
                // a stand-in under the veil: nothing of a word is drawn
                let chip = SeedStyle.chip("••••••", .tile)
                chip.isUserInteractionEnabled = false
                chip.accessibilityElementsHidden = true
                return chip
            }
            let chip = SeedStyle.chip(word, quiz.used[tile] ? .used : .tile)
            chip.addAction(UIAction { [weak self] _ in self?.tap(tile) }, for: .touchUpInside)
            return chip
        })
    }

    private func tap(_ tile: Int) {
        switch quiz.tap(tile) {
        case .ignored:
            return
        case .wrong(let expected):
            quizSubtitle?.text = "That is not word \(expected). Start again."
            quizSubtitle?.textColor = SeedStyle.red
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .right:
            quizSubtitle?.text = "Tap the twelve words back in order."
            quizSubtitle?.textColor = SeedStyle.ink
        case .done:
            print("[foxy] seed phrase verified")
            show(.backedUp)
            return
        }
        drawQuiz()
    }

    private func buildBackedUp() {
        let done = SeedStyle.primaryButton("DONE")
        done.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let verified = self.quiz.isComplete
            let revealed = self.revealed
            self.finish { [answer = self.answer] in answer(verified, false, revealed) }
        }, for: .touchUpInside)
        let ring = UIView()
        ring.backgroundColor = SeedStyle.accent.withAlphaComponent(0.16)
        ring.layer.cornerRadius = 44
        let tick = UIImageView(image: UIImage(systemName: "checkmark",
                                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 36, weight: .bold)))
        tick.tintColor = SeedStyle.accent
        tick.translatesAutoresizingMaskIntoConstraints = false
        ring.addSubview(tick)
        let title = SeedStyle.title("BACKED UP")
        let sub = SeedStyle.body("Keep those twelve words somewhere safe. They are the only way back.")
        let column = UIStackView(arrangedSubviews: [ring, title, sub])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 16
        column.setCustomSpacing(6, after: title)
        [column, done].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            page.addSubview($0)
        }
        NSLayoutConstraint.activate([
            ring.widthAnchor.constraint(equalToConstant: 88),
            ring.heightAnchor.constraint(equalToConstant: 88),
            tick.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            tick.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
            sub.widthAnchor.constraint(lessThanOrEqualToConstant: 300),
            column.centerYAnchor.constraint(equalTo: page.centerYAnchor, constant: -30),
            column.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 22),
            column.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -22),
            done.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 22),
            done.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -22),
            done.bottomAnchor.constraint(equalTo: page.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
    }
}

/// seedEnter: twelve words typed or pasted for a restore, checked against the
/// wordlist and the checksum before they leave this screen.
final class SeedEnterController: SeedScreenController, UITextFieldDelegate, UITextDropDelegate {
    private let wordlist: [String]
    private let answer: (String?) -> Void
    private var cells = Array(repeating: "", count: SeedEntry.cells)
    private var fields: [SeedField] = []
    private var frames: [UIView] = []
    private var focused: Int?
    private var capture = SeedEntry.Capture()
    /// Said in place of the usual note after a refused paste, until the next edit.
    private var pasteNotice: String?
    /// An allowed paste on its way into the cells: the pasteboard's change count then.
    private var pendingPaste: (count: Int, at: Date)?
    private let subtitle = SeedStyle.body("")
    private let note = SeedStyle.body("", size: 16, color: SeedStyle.red)
    private let cta = SeedStyle.primaryButton("LOOK FOR BALANCES")
    private let bar = SuggestionBar()
    private weak var scroll: UIScrollView?
    /// LOOK FOR BALANCES shows only once the twelve words are a valid phrase;
    /// until then the words have the room it took.
    private var aboveCta: NSLayoutConstraint?
    private var aboveKeyboard: NSLayoutConstraint?

    /// `answer` runs once, on the main queue, after the screen is gone: the
    /// checked phrase, or nil when closed.
    init(wordlist: [String], answer: @escaping (String?) -> Void) {
        self.wordlist = wordlist
        self.answer = answer
        super.init()
    }

    override var showsWords: Bool { cells.contains { !$0.isEmpty } }

    override func viewDidLoad() {
        super.viewDidLoad()
        cta.addAction(UIAction { [weak self] _ in self?.submit() }, for: .touchUpInside)
        bar.onPick = { [weak self] word in self?.pick(word) }
        let stack = column(in: view, bottom: nil, floor: view.keyboardLayoutGuide.topAnchor)
        let scroll = stack.superview as? UIScrollView
        self.scroll = scroll
        // column() pinned the scroll's bottom to the keyboard; LOOK FOR BALANCES takes it over when shown
        if let scroll, let floor = view.constraints.first(where: { $0.firstItem === scroll && $0.firstAttribute == .bottom }) {
            aboveKeyboard = floor
            cta.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(cta)
            aboveCta = scroll.bottomAnchor.constraint(equalTo: cta.topAnchor, constant: -10)
            NSLayoutConstraint.activate([
                cta.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 22),
                cta.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -22),
                cta.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
            ])
        }
        for name in [UIResponder.keyboardDidChangeFrameNotification, UIResponder.keyboardDidShowNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved), name: name, object: nil)
        }
        let title = SeedStyle.title("RESTORE A WALLET")
        let rule = SeedStyle.rule()
        for (item, after) in [(title, 8.0), (subtitle, 16.0), (rule, 16.0)] as [(UIView, CGFloat)] {
            stack.addArrangedSubview(item)
            stack.setCustomSpacing(after, after: item)
        }
        let box = secretBox()
        let grid = UIStackView()
        grid.axis = .vertical
        grid.spacing = 9
        grid.translatesAutoresizingMaskIntoConstraints = false
        for first in stride(from: 0, to: SeedEntry.cells, by: 2) {
            let row = UIStackView(arrangedSubviews: [cell(first), cell(first + 1)])
            row.axis = .horizontal
            row.distribution = .fillEqually
            row.spacing = 9
            grid.addArrangedSubview(row)
        }
        box.content.addSubview(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: box.content.topAnchor),
            grid.bottomAnchor.constraint(equalTo: box.content.bottomAnchor),
            grid.leadingAnchor.constraint(equalTo: box.content.leadingAnchor),
            grid.trailingAnchor.constraint(equalTo: box.content.trailingAnchor),
        ])
        stack.addArrangedSubview(box)
        stack.setCustomSpacing(12, after: box)
        stack.addArrangedSubview(note)
        refresh()
    }

    override func close(animated: Bool = false) {
        clear()
        finish(animated: animated) { [answer] in answer(nil) }
    }

    private func cell(_ i: Int) -> UIView {
        let frame = UIView()
        frame.backgroundColor = SeedStyle.ink(0.05)
        frame.layer.cornerRadius = 15
        frame.layer.borderWidth = 1
        let number = UILabel()
        number.text = String(i + 1)
        number.font = .systemFont(ofSize: 14, weight: .bold)
        number.textColor = SeedStyle.ink(0.38)
        let field = SeedField()
        field.tag = i
        field.delegate = self
        field.shouldPaste = { [weak self] in self?.pasteAllowed() ?? false }
        // no word dragged out to another app, and none dropped in from the page
        field.textDragInteraction?.isEnabled = false
        field.textDropDelegate = self
        if #available(iOS 18.0, *) { field.writingToolsBehavior = .none }
        field.font = .systemFont(ofSize: 20, weight: .bold)
        field.textColor = SeedStyle.ink
        field.tintColor = SeedStyle.accent
        field.accessibilityLabel = "Word \(i + 1)"
        // what the keyboard may do to a seed word: nothing
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.keyboardType = .asciiCapable
        field.keyboardAppearance = .dark
        field.returnKeyType = i == SeedEntry.cells - 1 ? .done : .next
        field.inputAccessoryView = bar
        [number, field].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            frame.addSubview($0)
        }
        NSLayoutConstraint.activate([
            frame.heightAnchor.constraint(equalToConstant: 54),
            number.leadingAnchor.constraint(equalTo: frame.leadingAnchor, constant: 13),
            number.widthAnchor.constraint(equalToConstant: 22),
            number.centerYAnchor.constraint(equalTo: frame.centerYAnchor),
            field.leadingAnchor.constraint(equalTo: number.trailingAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: frame.trailingAnchor, constant: -10),
            field.topAnchor.constraint(equalTo: frame.topAnchor),
            field.bottomAnchor.constraint(equalTo: frame.bottomAnchor),
        ])
        fields.append(field)
        frames.append(frame)
        return frame
    }

    // MARK: Typing

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange,
                   replacementString string: String) -> Bool {
        guard !capture.captured else { return false }
        let current = textField.text ?? ""
        guard let swiftRange = Range(range, in: current) else { return false }
        let proposed = current.replacingCharacters(in: swiftRange, with: string)
        let index = textField.tag
        pasteNotice = nil
        cells = SeedEntry.apply(proposed, at: index, to: cells)
        for (i, field) in fields.enumerated() where field.text != cells[i] {
            field.text = cells[i]
        }
        let typed = SeedEntry.parts(proposed).count
        if typed > 1, let paste = pendingPaste, Date().timeIntervalSince(paste.at) < 2 {
            pendingPaste = nil
            let filled = min(typed, SeedEntry.cells - index)
            // The phrase is in the cells; off the pasteboard, and so off Universal
            // Clipboard, unless something else was copied since (L7).
            DispatchQueue.main.async {
                if SeedPasteboard.clearAfterPaste(filled: filled, countAtPaste: paste.count,
                                                  countNow: UIPasteboard.general.changeCount) {
                    SeedPasteboard.clear()
                }
            }
        }
        if typed > 1 {
            // a pasted phrase: on to the cell after its last word
            fields[min(index + typed, SeedEntry.cells - 1)].becomeFirstResponder()
        } else if string.contains(" "), !cells[index].isEmpty, index + 1 < SeedEntry.cells {
            // a space after a word means the next one
            fields[index + 1].becomeFirstResponder()
        }
        refresh()
        return false
    }

    func textFieldShouldBeginEditing(_ textField: UITextField) -> Bool {
        !capture.captured
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        focused = textField.tag
        refresh()
        showFocused()
    }

    @objc private func keyboardMoved() {
        showFocused()
    }

    /// The cell being typed in, in view above the keyboard and the suggestions
    /// over it, never under them.
    ///
    /// After the layout, not during it: asked while the keyboard was still
    /// coming up, the scroll view had its old height and cell 12 stayed under
    /// the keyboard (in the simulator).
    private func showFocused() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let i = self.focused, let scroll = self.scroll,
                  self.frames.indices.contains(i) else { return }
            self.view.layoutIfNeeded()
            let rect = self.frames[i].convert(self.frames[i].bounds, to: scroll)
            /* The offset, not scrollRectToVisible: this scroll view's content
             * is as wide as its frame and its contentSize width reads 0, and
             * scrollRectToVisible then moves nothing (in the simulator). */
            let furthest = max(0, scroll.contentSize.height - scroll.bounds.height)
            let below = min(max(0, rect.maxY + 14 - scroll.bounds.height), furthest)
            let above = min(max(0, rect.minY - 14), furthest)
            if scroll.contentOffset.y < below {
                scroll.setContentOffset(CGPoint(x: 0, y: below), animated: true)
            } else if scroll.contentOffset.y > above {
                scroll.setContentOffset(CGPoint(x: 0, y: above), animated: true)
            }
        }
    }

    /// The edit menu without Share, Look Up, Translate or Replace; copy and cut
    /// are refused by SeedField itself.
    func textField(_ textField: UITextField, editMenuForCharactersIn range: NSRange,
                   suggestedActions: [UIMenuElement]) -> UIMenu? {
        UIMenu(children: SeedField.menu(suggestedActions))
    }

    func textDroppableView(_ textDroppableView: UIView & UITextDroppable,
                           proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
        UITextDropProposal(operation: .forbidden)
    }

    // MARK: Pasting

    /// Asked by a cell before a paste. Words Foxy put on the pasteboard itself
    /// (a copy the page asked for, or the web view's own) are refused: a page
    /// could otherwise copy words it knows and lead the person to restore them
    /// as their own (review M8). Typing is never asked about.
    private func pasteAllowed() -> Bool {
        guard !capture.captured else { return false }
        let count = UIPasteboard.general.changeCount
        switch SeedPasteboard.paste(changeCount: count, lastFoxyWrite: SeedPasteboard.lastFoxyWrite) {
        case .refuse:
            print("[foxy] a paste of text Foxy copied was refused on the restore screen")
            pasteNotice = SeedPasteboard.refusal
            pendingPaste = nil
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            refresh()
            return false
        case .allow:
            pasteNotice = nil
            pendingPaste = (count, Date())
            return true
        }
    }

    // MARK: Capture

    /// While the screen is recorded, mirrored or shared (SeedEntry.Capture).
    override func captureChanged() {
        super.captureChanged()
        guard !fields.isEmpty else { return }
        let step = capture.set(FoxyBridge.screenCaptured(self))
        if step.endEditing {
            view.endEditing(true)
            fields.forEach { $0.resignFirstResponder() }
            focused = nil
        }
        fields.forEach { $0.isEnabled = capture.fieldsEnabled }
        bar.isHidden = !capture.suggestionsShown
        refresh()
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        if focused == textField.tag { focused = nil }
        refresh()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField.tag + 1 < SeedEntry.cells {
            fields[textField.tag + 1].becomeFirstResponder()
        } else {
            textField.resignFirstResponder()
        }
        return false
    }

    private func pick(_ word: String) {
        guard !capture.captured, let i = focused else { return }
        cells[i] = word
        fields[i].text = word
        if i + 1 < SeedEntry.cells {
            fields[i + 1].becomeFirstResponder()
        } else {
            fields[i].resignFirstResponder()
        }
        refresh()
    }

    private func refresh() {
        let check = SeedEntry.check(cells, wordlist: wordlist)
        for i in frames.indices {
            // the word being typed is not wrong yet
            let wrong = check.unknown.contains(i) && focused != i
            let color = wrong ? SeedStyle.red : cells[i].isEmpty ? SeedStyle.ink(0.12) : SeedStyle.accent.withAlphaComponent(0.45)
            frames[i].layer.borderColor = color.cgColor
        }
        if let pasteNotice {
            note.text = pasteNotice
        } else if let first = check.unknown.first(where: { $0 != focused }) {
            note.text = "Word \(first + 1) is not one of the 2048 seed words."
        } else if check.filled == SeedEntry.cells, check.unknown.isEmpty, !check.valid {
            note.text = "These twelve words are not a valid seed phrase. Check each one."
        } else {
            note.text = ""
        }
        subtitle.text = check.valid
            ? "Twelve words in. Look for balances, then tap a mint."
            : "Type or paste the twelve words from your other wallet."
        SeedStyle.setPrimary(cta, title: "LOOK FOR BALANCES", enabled: check.valid)
        if cta.isHidden == check.valid, let aboveCta, let aboveKeyboard {
            cta.isHidden = !check.valid
            aboveKeyboard.isActive = !check.valid
            aboveCta.isActive = check.valid
            view.layoutIfNeeded()
            showFocused()
        }
        // nothing above the keyboard while the screen is captured
        bar.show(capture.suggestions(focused.map { cells[$0] }, wordlist: wordlist))
    }

    private func submit() {
        guard SeedEntry.check(cells, wordlist: wordlist).valid else { return }
        let phrase = SeedEntry.phrase(cells)
        clear()
        finish { [answer] in answer(phrase) }
    }

    /// The typed words off the screen and out of this controller's cells.
    private func clear() {
        cells = Array(repeating: "", count: SeedEntry.cells)
        fields.forEach { $0.text = "" }
        pendingPaste = nil
        pasteNotice = nil
    }
}

/// A restore cell. What it holds cannot be copied, cut, shared, looked up or
/// translated (review L7), and a paste asks `shouldPaste` first.
final class SeedField: UITextField {
    var shouldPaste: (() -> Bool)?

    /// The edit actions a cell offers: paste and selecting, nothing that sends
    /// its words anywhere.
    static let allowedActions: Set<Selector> = [
        #selector(UIResponderStandardEditActions.paste(_:)),
        #selector(UIResponderStandardEditActions.select(_:)),
        #selector(UIResponderStandardEditActions.selectAll(_:)),
        #selector(UIResponderStandardEditActions.delete(_:)),
    ]
    /// Menus of the edit menu that take words elsewhere.
    static let hiddenMenus: Set<UIMenu.Identifier> = [.share, .lookup, .learn, .replace]

    static func menu(_ suggested: [UIMenuElement]) -> [UIMenuElement] {
        suggested.filter { element in
            guard let menu = element as? UIMenu else { return true }
            return !hiddenMenus.contains(menu.identifier)
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        Self.allowedActions.contains(action) && super.canPerformAction(action, withSender: sender)
    }

    override func copy(_ sender: Any?) {}

    override func cut(_ sender: Any?) {}

    override func paste(_ sender: Any?) {
        guard shouldPaste?() ?? true else { return }
        super.paste(sender)
    }

    override func paste(itemProviders: [NSItemProvider]) {
        guard shouldPaste?() ?? true else { return }
        super.paste(itemProviders: itemProviders)
    }
}

/// Words from the list that start with what is typed, above the keyboard.
final class SuggestionBar: UIInputView {
    var onPick: ((String) -> Void)?
    private let stack = UIStackView()

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 50), inputViewStyle: .keyboard)
        autoresizingMask = .flexibleWidth
        overrideUserInterfaceStyle = .dark
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    func show(_ words: [String]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for word in words {
            let button = UIButton(type: .system)
            button.setTitle(word, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
            button.tintColor = SeedStyle.ink
            button.backgroundColor = SeedStyle.ink(0.12)
            button.layer.cornerRadius = 8
            button.addAction(UIAction { [weak self] _ in self?.onPick?(word) }, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
    }
}
