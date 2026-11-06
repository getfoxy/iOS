import XCTest
@testable import Foxy

/// What the page is told the keyboard covers (WebHostController.keyboardCover, FoxyWebView.swift): the page lifts every
/// field above that many points (watchKeyboard, 15-paid-wake-keyboard.js).
final class KeyboardCoverTests: XCTestCase {
    private let page = CGRect(x: 0, y: 0, width: 393, height: 852)

    func testADockedKeyboardCoversItsHeight() {
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: CGRect(x: 0, y: 852 - 336, width: 393, height: 336), page: page), 336)
    }

    func testAKeyboardGoneOffTheScreenCoversNothing() {
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: CGRect(x: 0, y: 852, width: 393, height: 336), page: page), 0)
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: .zero, page: page), 0)
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: .null, page: page), 0)
    }

    /// A hardware keyboard: only the bar above it shows, the rest of its frame below the screen.
    func testOnlyTheShowingPartCounts() {
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: CGRect(x: 0, y: 852 - 55, width: 393, height: 336), page: page), 55)
    }

    /// An iPad's floating keyboard, clear of the page's foot, moves nothing.
    func testAFloatingKeyboardCoversNothing() {
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: CGRect(x: 40, y: 300, width: 320, height: 250), page: page), 0)
    }

    func testNeverMoreThanThePage() {
        XCTAssertEqual(WebHostController.keyboardCover(keyboard: CGRect(x: 0, y: -100, width: 393, height: 2000), page: page), 852)
    }
}
