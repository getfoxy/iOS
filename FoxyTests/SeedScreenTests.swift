import XCTest
@testable import Foxy

/// The seed screens' rules from the review: the restore screen
/// while the screen is captured (M3), where a paste came from (M8), one screen
/// at a time (L1), a quiz order not made from the words and behind the reveal
/// (L3), and the clipboard kept from the page (L7).
final class SeedScreenTests: XCTestCase {
    private let other = "legal winner thank year wave sausage worth useful legal winner thank yellow"
    private let abandonArt = Array(repeating: "abandon", count: 23).joined(separator: " ") + " art"

    private func words(_ text: String) -> [String] {
        text.split(separator: " ").map(String.init)
    }

    // MARK: Capture (M3)

    func testCaptureEndsEditingEmptiesTheBarAndNeverRefocuses() throws {
        let wordlist = try XCTUnwrap(BIP39.english)
        var capture = SeedEntry.Capture()
        XCTAssertFalse(capture.captured)
        XCTAssertTrue(capture.fieldsEnabled)
        XCTAssertTrue(capture.suggestionsShown)
        XCTAssertFalse(capture.noticeShown)
        XCTAssertEqual(capture.suggestions("aban", wordlist: wordlist), ["abandon"])

        XCTAssertEqual(capture.set(true), .init(endEditing: true))
        XCTAssertFalse(capture.fieldsEnabled)
        XCTAssertFalse(capture.suggestionsShown)
        XCTAssertTrue(capture.noticeShown)
        XCTAssertEqual(capture.suggestions("aban", wordlist: wordlist), [], "the bar is empty while captured")
        XCTAssertEqual(capture.set(true), .init(endEditing: true), "every captured answer ends editing again")

        XCTAssertEqual(capture.set(false), .init(endEditing: false))
        XCTAssertTrue(capture.fieldsEnabled)
        XCTAssertTrue(capture.suggestionsShown)
        XCTAssertFalse(capture.noticeShown)
        XCTAssertEqual(capture.suggestions(nil, wordlist: wordlist), [], "no cell is focused for the person")
        XCTAssertEqual(capture.set(false), .init(endEditing: false))
    }

    // MARK: Where a paste came from (M8)

    func testAPasteOfWhatFoxyCopiedIsRefused() {
        XCTAssertEqual(SeedPasteboard.paste(changeCount: 7, lastFoxyWrite: 7), .refuse)
        XCTAssertEqual(SeedPasteboard.paste(changeCount: 8, lastFoxyWrite: 7), .allow, "copied since, elsewhere")
        XCTAssertEqual(SeedPasteboard.paste(changeCount: 0, lastFoxyWrite: nil), .allow, "Foxy has written nothing")
        XCTAssertEqual(SeedPasteboard.refusal,
                       "These words were copied inside Foxy. Type or paste words you wrote down yourself.")
    }

    func testAChangeSeenWhileFoxyIsInFrontIsFoxys() {
        XCTAssertTrue(SeedPasteboard.madeInFoxy(active: true, count: 5, countAtActivation: 4), "the web view's own copy")
        XCTAssertFalse(SeedPasteboard.madeInFoxy(active: true, count: 4, countAtActivation: 4), "made while Foxy was away")
        XCTAssertFalse(SeedPasteboard.madeInFoxy(active: false, count: 5, countAtActivation: 4))
    }

    func testARefusedPasteChangesNoCell() {
        let field = SeedField()
        field.shouldPaste = { false }
        field.paste(nil)
        XCTAssertEqual(field.text ?? "", "")
    }

    func testAPastedPhraseIsClearedOnlyWhileTheBoardStillHoldsIt() {
        XCTAssertTrue(SeedPasteboard.clearAfterPaste(filled: 12, countAtPaste: 3, countNow: 3))
        XCTAssertTrue(SeedPasteboard.clearAfterPaste(filled: 2, countAtPaste: 3, countNow: 3))
        XCTAssertFalse(SeedPasteboard.clearAfterPaste(filled: 1, countAtPaste: 3, countNow: 3), "one word, one cell")
        XCTAssertFalse(SeedPasteboard.clearAfterPaste(filled: 12, countAtPaste: 3, countNow: 4), "something copied since")
    }

    func testASeedCellOffersNothingThatSendsItsWords() {
        let field = SeedField()
        for name in ["copy:", "cut:", "_share:", "_define:", "_translate:", "_lookup:", "pasteAndMatchStyle:", "_promptForReplace:"] {
            XCTAssertFalse(field.canPerformAction(NSSelectorFromString(name), withSender: nil), name)
        }
        XCTAssertEqual(SeedField.allowedActions, [
            #selector(UIResponderStandardEditActions.paste(_:)), #selector(UIResponderStandardEditActions.select(_:)),
            #selector(UIResponderStandardEditActions.selectAll(_:)), #selector(UIResponderStandardEditActions.delete(_:)),
        ])
        XCTAssertEqual(SeedField.hiddenMenus, [.share, .lookup, .learn, .replace])
    }

    // MARK: The page's clipboard (L7)

    func testThePageIsNeverHandedAPhrase() throws {
        let wordlist = try XCTUnwrap(BIP39.english)
        let holds = { (text: String) in SeedPasteboard.holdsSeedPhrase(text, wordlist: wordlist) }
        XCTAssertTrue(holds(other))
        XCTAssertTrue(holds(other.uppercased()))
        XCTAssertTrue(holds(abandonArt), "24 words")
        XCTAssertTrue(holds(words(other).enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")),
                      "a numbered list")
        XCTAssertTrue(holds("my backup, keep safe: " + other + " (paper copy in the drawer)"), "inside a note")

        XCTAssertFalse(holds(""))
        XCTAssertFalse(holds(words(other).dropFirst().joined(separator: " ")), "eleven words")
        XCTAssertFalse(holds("legal winner thank year wave sausage worth useful legal winner thank year"), "a wrong checksum")
        XCTAssertFalse(holds("cashuBo2FteCJodHRwczovL3Rlc3RudXQuY2FzaHUuc3BhY2VhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIOkYWEQYXN4QDEzYjM"))
        XCTAssertFalse(holds("lnbc10u1pjzq2jhpp5r2fz5w0kx6gl9x3dj8zqvm4f6mq0g2y0q2e8yq8a0s6rd9zv9lqsdqqcqzzsxqyz5vqsp5"))
        XCTAssertFalse(holds("The mint at https://testnut.cashu.space answered with a new keyset, please try again."))

        XCTAssertEqual(SeedPasteboard.forPage(other, from: "test"), "", "answered as a clipboard with nothing usable")
        XCTAssertEqual(SeedPasteboard.forPage("cashuBxyz", from: "test"), "cashuBxyz")
        XCTAssertEqual(SeedPasteboard.forPage("", from: "test"), "")
    }

    // MARK: One screen at a time (L1)

    func testASeedScreenQueuedOrOpenMakesTheQueueBusy() {
        var alert = true
        let queue = ScreenQueue(alertShowing: { alert }, retryEvery: nil)
        XCTAssertFalse(queue.busy)
        var finish: (() -> Void)?
        queue.enqueue { done in finish = done }
        XCTAssertTrue(queue.busy, "queued behind an alert")
        XCTAssertNil(finish)
        alert = false
        queue.pump()
        XCTAssertNotNil(finish)
        XCTAssertTrue(queue.busy, "open")
        finish?()
        XCTAssertFalse(queue.busy)
        XCTAssertEqual(SeedScreens.busyRefusal, "a seed screen is already open")
    }

    func testCancellingAnswersWaitingScreensAndTellsTheRunningOne() {
        let queue = ScreenQueue(alertShowing: { false }, retryEvery: nil)
        var started: [Int] = []
        var cancelled: [Int] = []
        var finish: [() -> Void] = []
        var turn = -1
        queue.enqueue(onCancel: { cancelled.append(1) }) { done in
            started.append(1)
            turn = queue.generation
            finish.append(done)
        }
        for n in 2...3 {
            queue.enqueue(onCancel: { cancelled.append(n) }) { done in
                started.append(n)
                finish.append(done)
            }
        }
        XCTAssertEqual(started, [1])
        XCTAssertEqual(queue.waitingCount, 2)

        queue.cancelAll()
        XCTAssertEqual(cancelled, [2, 3], "the waiting ones are answered as cancelled")
        XCTAssertEqual(queue.waitingCount, 0)
        XCTAssertNotEqual(queue.generation, turn, "the running one sees it was cancelled")
        XCTAssertTrue(queue.busy, "until it finishes")
        finish[0]()
        XCTAssertFalse(queue.busy)
        XCTAssertEqual(started, [1], "a cancelled screen never starts")

        queue.enqueue { done in
            started.append(4)
            done()
        }
        XCTAssertEqual(started, [1, 4])
        XCTAssertFalse(queue.busy)
    }

    func testAFailedReadPausesTheWordsScreenForTenSeconds() {
        XCTAssertEqual(SeedScreens.showPause.span, 10)
        XCTAssertEqual(SeedScreens.pauseRefusal, "try again in a moment")
        var pause = RetryPause(span: 10)
        let then = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(pause.refuses(at: then))
        pause.start(at: then)
        XCTAssertTrue(pause.refuses(at: then))
        XCTAssertTrue(pause.refuses(at: then.addingTimeInterval(9.9)))
        XCTAssertFalse(pause.refuses(at: then.addingTimeInterval(10)))
        XCTAssertFalse(pause.refuses(at: then.addingTimeInterval(-60)), "a clock set back does not refuse for good")
    }

    // MARK: The quiz (L3)

    func testTheQuizOrderComesFromTheDrawsNotTheWords() {
        let draws: [UInt32] = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]
        func source() -> (UInt32) -> UInt32 {
            var i = 0
            return { n in
                defer { i += 1 }
                return draws[i % draws.count] % n
            }
        }
        let places = (0..<12).map(String.init)
        let order = SeedQuiz.scramble(places, random: source()).map { Int($0)! }
        for list in [words(other), words("absurd gravity pelican kitchen orbit ribbon marble tunnel velvet sponsor dawn hazard")] {
            XCTAssertEqual(SeedQuiz.scramble(list, random: source()), order.map { list[$0] },
                           "the same draws put any twelve words in the same places")
        }
        XCTAssertEqual(SeedQuiz.scramble([], random: source()), [])
        XCTAssertEqual(SeedQuiz.scramble(["one"], random: source()), ["one"])
    }

    func testEveryQuizOfTheSameWordsIsDrawnAfresh() {
        let list = words(other)
        let orders = Set((0..<20).map { _ in SeedQuiz(words: list).pool })
        XCTAssertGreaterThan(orders.count, 1, "the words alone do not decide the order")
        for order in orders {
            XCTAssertEqual(order.sorted(), list.sorted())
        }
        for n: UInt32 in [1, 2, 3, 12, 24] {
            for _ in 0..<64 {
                XCTAssertLessThan(SeedQuiz.systemRandom(below: n), n)
            }
        }
    }

    func testARepeatedWordCanBeFinishedInAnyOrder() {
        let list = words("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")
        for _ in 0..<10 {
            var quiz = SeedQuiz(words: list)
            var last: SeedQuiz.Tap = .ignored
            for word in list {
                let tile = quiz.pool.indices.first { quiz.pool[$0] == word && !quiz.used[$0] } ?? -1
                last = quiz.tap(tile)
            }
            XCTAssertEqual(last, .done)
        }
    }

    func testNoWordIsDrawnBeforeTheReveal() {
        let list = words("absurd gravity pelican kitchen orbit ribbon marble tunnel velvet sponsor dawn hazard")
        for startOnQuiz in [false, true] {
            let screen = SeedShowController(words: list, startOnQuiz: startOnQuiz) { _, _, _ in }
            screen.loadViewIfNeeded()
            let drawn = texts(in: screen.view).joined(separator: " ").lowercased()
            for word in list {
                XCTAssertFalse(drawn.contains(word), "\(word) is drawn before the reveal, quiz: \(startOnQuiz)")
            }
            XCTAssertTrue(drawn.contains("tap to reveal"), "quiz: \(startOnQuiz)")
            XCTAssertTrue(drawn.contains(SeedStyle.nativeBarText.lowercased()), "the native bar, quiz: \(startOnQuiz)")
            XCTAssertEqual(screen.modalPresentationStyle, .pageSheet)
            XCTAssertTrue(screen.isModalInPresentation)
        }
    }

    /// Back from the quiz goes to the words, not out of the screen; back from
    /// the words leaves, as it always did.
    func testBackFromTheQuizIsBackToTheWords() {
        let list = words("absurd gravity pelican kitchen orbit ribbon marble tunnel velvet sponsor dawn hazard")
        for startOnQuiz in [false, true] {
            var answers = 0
            let screen = SeedShowController(words: list, startOnQuiz: startOnQuiz) { _, _, _ in answers += 1 }
            screen.loadViewIfNeeded()
            let drawn = { self.texts(in: screen.view).joined(separator: " ") }
            if !startOnQuiz {
                XCTAssertTrue(drawn().contains("YOUR SEED PHRASE"))
                let verify = self.buttons(in: screen.view).first { ($0.attributedTitle(for: .normal)?.string ?? $0.title(for: .normal) ?? "").contains("VERIFY WORDS") }
                XCTAssertNotNil(verify, "the words have VERIFY WORDS under them")
                verify?.sendActions(for: .touchUpInside)
            }
            XCTAssertTrue(drawn().contains("Tap the twelve words back in order."), "the quiz, startOnQuiz: \(startOnQuiz)")
            XCTAssertFalse(drawn().contains("YOUR SEED PHRASE"))

            screen.backTapped()
            XCTAssertTrue(drawn().contains("YOUR SEED PHRASE"), "back from the quiz shows the words, startOnQuiz: \(startOnQuiz)")
            XCTAssertFalse(drawn().contains("Tap the twelve words back in order."))
            XCTAssertEqual(answers, 0, "and the screen has not been left")

            // and from the words, back leaves: the screen answers, once
            screen.backTapped()
            XCTAssertEqual(answers, 1, "back from the words leaves the screen, startOnQuiz: \(startOnQuiz)")
            screen.backTapped()
            XCTAssertEqual(answers, 1, "and only once")
        }
    }

    private func buttons(in view: UIView) -> [UIButton] {
        var out: [UIButton] = []
        if let button = view as? UIButton { out.append(button) }
        for sub in view.subviews { out += buttons(in: sub) }
        return out
    }

    private func texts(in view: UIView) -> [String] {
        var out: [String] = []
        if let label = view as? UILabel {
            out += [label.text ?? "", label.attributedText?.string ?? ""]
        }
        if let button = view as? UIButton {
            out += [button.title(for: .normal) ?? "", button.configuration?.attributedTitle.map { String($0.characters) } ?? ""]
        }
        if let field = view as? UITextField {
            out.append(field.text ?? "")
        }
        if let label = view.accessibilityLabel {
            out.append(label)
        }
        return out + view.subviews.flatMap { texts(in: $0) }
    }
}
