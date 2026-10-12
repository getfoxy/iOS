import XCTest
#if canImport(FoxyCardTap)
@testable import FoxyCardTap
#else
@testable import Foxy
#endif

/// The address a card raises when it is held to a phone, and the one message the page gets
/// about it (Foxy/Flashcard/CardAddress.swift). Runs in FoxyTests and in tools/nativetests,
/// where the file is its own module, FoxyCardTap.
final class CardAddressTests: XCTestCase {
    private func card(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws -> Bool {
        let url = try XCTUnwrap(URL(string: text), "\(text) is not a URL", file: file, line: line)
        return CardAddress.isCard(url)
    }

    /// The address that is on every card, and nothing around it that matters.
    func testTheCardsOwnAddressIsRecognised() throws {
        XCTAssertEqual("\(CardAddress.scheme)://\(CardAddress.host)\(CardAddress.path)", "https://getfoxy.io/card")
        XCTAssertTrue(try card("https://getfoxy.io/card"))
        XCTAssertTrue(try card("https://getfoxy.io/card/"), "a trailing slash is the same place")
    }

    /// A query or a fragment is accepted and means nothing: it is neither read nor passed on.
    func testAQueryOrAFragmentIsAcceptedAndIgnored() throws {
        for text in ["https://getfoxy.io/card?x=1", "https://getfoxy.io/card?", "https://getfoxy.io/card#top",
                     "https://getfoxy.io/card#", "https://getfoxy.io/card/?a=1&b=2#c",
                     "https://getfoxy.io/card?next=https://evil.example/", "https://getfoxy.io/card#https://evil.example/"] {
            XCTAssertTrue(try card(text), text)
        }
    }

    /// Scheme and host are written without regard to case, as every URL does; the path is not.
    func testSchemeAndHostAreNotCaseSensitiveButThePathIs() throws {
        XCTAssertTrue(try card("HTTPS://GETFOXY.IO/card"))
        XCTAssertTrue(try card("Https://GetFoxy.io/card/"))
        XCTAssertFalse(try card("https://getfoxy.io/Card"))
        XCTAssertFalse(try card("https://getfoxy.io/CARD"))
    }

    /// Every way of being almost the card's address.
    func testNothingElseIsTheCardsAddress() {
        let others = [
            // another scheme: the web's own, and this app's
            "http://getfoxy.io/card", "foxy://card", "foxy://getfoxy.io/card", "ftp://getfoxy.io/card",
            "file:///card", "javascript:alert(1)", "mailto:card@getfoxy.io", "data:text/html,getfoxy.io/card",
            // another host: a subdomain, the www, one that ends with the name, one that starts with it, a dot after it
            "https://www.getfoxy.io/card", "https://sub.getfoxy.io/card", "https://evilgetfoxy.io/card",
            "https://getfoxy.io.evil.example/card", "https://getfoxy.io./card", "https://getfoxy.com/card",
            "https://evil.example/card", "https://getfoxy%2Eio/card", "https://localhost/card",
            // something before the host: user information, with and without a password, and a name that is only a user
            "https://user@getfoxy.io/card", "https://user:secret@getfoxy.io/card", "https://getfoxy.io@evil.example/card",
            "https://getfoxy.io:443@evil.example/card", "https://:@getfoxy.io/card",
            // a port, the default one too
            "https://getfoxy.io:8443/card", "https://getfoxy.io:443/card", "https://getfoxy.io:/card",
            // another path, a longer one, a shorter one, and the same one spelled another way
            "https://getfoxy.io/", "https://getfoxy.io", "https://getfoxy.io/cards", "https://getfoxy.io/card/extra",
            "https://getfoxy.io/card//", "https://getfoxy.io//card", "https://getfoxy.io/card/.", "https://getfoxy.io/card/..",
            "https://getfoxy.io/card;x=1", "https://getfoxy.io/c%61rd", "https://getfoxy.io/card%2F", "https://getfoxy.io/card%00",
            "https://getfoxy.io/other/card", "https://getfoxy.io/card.html", "https://getfoxy.io/.well-known/card",
            // the address named by something else's query or fragment
            "https://evil.example/?u=https://getfoxy.io/card", "https://evil.example/card?https://getfoxy.io/card",
            "https://evil.example/#https://getfoxy.io/card",
            // not an address at all
            "https:", "https://", "https:///card", "card", "//getfoxy.io/card", "/card",
        ]
        for text in others {
            XCTAssertFalse(CardAddress.isCard(URL(string: text)), "\(text) is not the card's address")
        }
    }

    func testNoAddressAtAllIsNotTheCardsAddress() {
        XCTAssertFalse(CardAddress.isCard(nil))
        XCTAssertNil(URL(string: ""), "an empty string is no URL")
        XCTAssertFalse(CardAddress.isCard(URL(string: "")))
        // an address built from parts, with one of them wrong
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = "getfoxy.io"
        parts.path = "/card"
        XCTAssertTrue(CardAddress.isCard(parts.url))
        parts.port = 443
        XCTAssertFalse(CardAddress.isCard(parts.url))
        parts.port = nil
        parts.user = "u"
        XCTAssertFalse(CardAddress.isCard(parts.url))
        parts.user = nil
        parts.host = "www.getfoxy.io"
        XCTAssertFalse(CardAddress.isCard(parts.url))
    }

    /// Read letter by letter: the host ends where the path begins, so nothing can be hidden between them.
    func testNothingCanBeHiddenBetweenTheHostAndThePath() {
        for text in ["https://getfoxy.io:/card", "https://getfoxy.io@/card", "https://getfoxy.io\\@evil.example/card",
                     "https://getfoxy.io%2f@evil.example/card", "https://getfoxy.io?@evil.example/card",
                     "https://getfoxy.io#@evil.example/card", "https://getfoxy.io /card", "https://getfoxy.io\u{00A0}/card"] {
            XCTAssertFalse(CardAddress.isCard(URL(string: text)), "\(text) is not the card's address")
        }
        // and a letter that only looks like one of ours
        XCTAssertFalse(CardAddress.isCard(URL(string: "https://getfoxy.i\u{043E}/card")), "a Cyrillic o")
        XCTAssertFalse(CardAddress.isCard(URL(string: "https://g\u{0435}tfoxy.io/card")), "a Cyrillic e")
        XCTAssertFalse(CardAddress.isCard(URL(string: "https://getfoxy.io\u{FF0F}card")), "a fullwidth slash")
    }

    /// What the page is told is one fixed call: nothing of the address is in it, and nothing can be put into it.
    func testThePageIsToldOneFixedMessage() {
        XCTAssertEqual(CardAddress.pageCall,
                       "window.FoxyWallet && window.FoxyWallet._cardTapped && window.FoxyWallet._cardTapped()")
        XCTAssertFalse(CardAddress.pageCall.contains("getfoxy"), "no part of the address")
        XCTAssertFalse(CardAddress.pageCall.contains("http"), "no part of the address")
        XCTAssertFalse(CardAddress.pageCall.contains("card?"), "no query")
        // it takes no argument: the call's brackets are empty
        XCTAssertTrue(CardAddress.pageCall.hasSuffix("._cardTapped()"))
        XCTAssertFalse(CardAddress.pageCall.contains("\n"))
    }

    /// A different address, or none, leaves the delivery as it was and says nothing.
    func testAnotherAddressGoesNowhere() {
        let delivery = CardTapDelivery()
        var lines = [String]()
        var asked = 0
        delivery.say = { lines.append($0) }
        delivery.tell = { _ in asked += 1 }
        delivery.pageLoaded()
        delivery.coverChanged(up: false)
        for text in ["https://www.getfoxy.io/card", "foxy://card", "https://getfoxy.io/cards", "https://evil.example/card"] {
            delivery.received(URL(string: text))
        }
        delivery.received(nil)
        XCTAssertEqual(asked, 0)
        XCTAssertNil(delivery.since)
        XCTAssertTrue(lines.isEmpty, "dropped without a word: \(lines)")
        // and the card's own is not
        delivery.received(URL(string: "https://getfoxy.io/card?x=1#y"))
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(lines.first, "a card's address arrived")
        XCTAssertFalse(lines.joined().contains("getfoxy"), "the address is not logged")
    }
}
