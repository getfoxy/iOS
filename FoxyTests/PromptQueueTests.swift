import XCTest
@testable import Foxy

/// I3: native alerts wait their turn, and one that is gone without an answer is a no.
final class PromptQueueTests: XCTestCase {

    /// Stands in for UIKit: records what is shown, and taps for the test.
    private final class Screen {
        var shown: [String] = []
        var up: Set<String> = []
        var dismissed: [String] = []
        var taps: [String: (Bool) -> Void] = [:]
        var nothingToPresentOn = false

        func show(_ prompt: NativePrompt, _ presenter: UIViewController?,
                  _ answer: @escaping (Bool) -> Void) -> PromptQueue.Shown? {
            if nothingToPresentOn { return nil }
            let title = prompt.title
            shown.append(title)
            up.insert(title)
            taps[title] = { [unowned self] yes in
                self.up.remove(title)
                answer(yes)
            }
            return PromptQueue.Shown(
                dismiss: { [unowned self] in
                    self.up.remove(title)
                    self.dismissed.append(title)
                },
                stillShown: { [unowned self] in self.up.contains(title) })
        }

        func tap(_ title: String, _ yes: Bool) { taps[title]?(yes) }
    }

    private func prompt(_ title: String) -> NativePrompt {
        NativePrompt(title: title, message: "", no: "No", yes: "Yes", yesStyle: .default)
    }

    private func queue(_ screen: Screen) -> PromptQueue {
        PromptQueue(show: { screen.show($0, $1, $2) }, checkEvery: nil)
    }

    func testOneAlertAtATimeInTheOrderAsked() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [String] = []
        q.ask(prompt("Allow Foxy to contact x?"), on: nil) { heard.append("host \($0)") }
        q.ask(prompt("Replace this wallet's seed?"), on: nil) { heard.append("replace \($0)") }
        q.ask(prompt("Continue without Tor?"), on: nil) { heard.append("tor \($0)") }
        XCTAssertEqual(screen.shown, ["Allow Foxy to contact x?"], "a second alert went up over the first")
        XCTAssertEqual(q.waitingCount, 2)

        screen.tap("Allow Foxy to contact x?", true)
        XCTAssertEqual(screen.shown.last, "Replace this wallet's seed?")
        XCTAssertEqual(screen.up.count, 1)
        screen.tap("Replace this wallet's seed?", false)
        screen.tap("Continue without Tor?", true)
        XCTAssertEqual(heard, ["host true", "replace false", "tor true"])
        XCTAssertFalse(q.isShowing)
    }

    func testAnswersCountOnce() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [Bool] = []
        q.ask(prompt("A"), on: nil) { heard.append($0) }
        screen.tap("A", false)
        screen.taps["A"]?(true)
        XCTAssertEqual(heard, [false])
    }

    func testNothingToPresentOnIsANo() {
        let screen = Screen()
        screen.nothingToPresentOn = true
        let q = queue(screen)
        var heard: [Bool] = []
        q.ask(prompt("A"), on: nil) { heard.append($0) }
        q.ask(prompt("B"), on: nil) { heard.append($0) }
        XCTAssertEqual(heard, [false, false])
        XCTAssertFalse(q.isShowing)
    }

    func testCancellingOneThatWaitsAnswersNoAndNeverShowsIt() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [String] = []
        q.ask(prompt("A"), on: nil) { heard.append("A \($0)") }
        let b = q.ask(prompt("B"), on: nil) { heard.append("B \($0)") }
        b.cancel()
        XCTAssertEqual(heard, ["B false"])
        screen.tap("A", true)
        XCTAssertEqual(screen.shown, ["A"])
        XCTAssertEqual(heard, ["B false", "A true"])
    }

    /// seedAdopt's wait running out: the alert comes down, and a tap on it after
    /// that is not a yes.
    func testCancellingTheOneShownTakesItDownAndALateTapDoesNotCount() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [String] = []
        let a = q.ask(prompt("Replace this wallet's seed?"), on: nil) { heard.append("replace \($0)") }
        q.ask(prompt("B"), on: nil) { heard.append("B \($0)") }
        a.cancel()
        XCTAssertEqual(screen.dismissed, ["Replace this wallet's seed?"])
        XCTAssertEqual(heard, ["replace false"])
        XCTAssertEqual(screen.shown.last, "B")
        screen.taps["Replace this wallet's seed?"]?(true)
        XCTAssertEqual(heard, ["replace false"])
    }

    func testAnAlertGoneWithoutAnAnswerIsANo() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [String] = []
        q.ask(prompt("A"), on: nil) { heard.append("A \($0)") }
        q.ask(prompt("B"), on: nil) { heard.append("B \($0)") }
        screen.up.remove("A")          // went down with the screen under it
        q.check()
        XCTAssertEqual(heard, [], "one missed check is not enough")
        q.check()
        XCTAssertEqual(heard, ["A false"])
        XCTAssertEqual(screen.shown.last, "B")
    }

    func testATapStillArrivingIsNotTakenForAGap() {
        let screen = Screen()
        let q = queue(screen)
        var heard: [Bool] = []
        q.ask(prompt("A"), on: nil) { heard.append($0) }
        screen.up.remove("A")
        q.check()
        screen.tap("A", true)
        q.check()
        XCTAssertEqual(heard, [true])
    }
}
