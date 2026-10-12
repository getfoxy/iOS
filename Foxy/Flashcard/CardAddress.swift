import Foundation

/// The address a Foxy card raises when it is held to a phone, and the one thing the
/// phone says to the page about it.
///
/// Every Flashcard of card software 1.19 answers as an NFC tag that carries one
/// address, `https://getfoxy.io/card`, the same on every card. There is no part of it
/// that belongs to one card, and there must never be one: the address is not an
/// identity, only a way to open Foxy. With the screen on, iOS reads the tag by
/// itself and shows a banner; a tap on the banner opens the app that is associated
/// with the address (the Associated Domains entitlement, `applinks:getfoxy.io`,
/// tools/flashcard.entitlements), or Safari, where the page on the site says what
/// the card is, when no such app is installed. iOS gives the app that address and
/// no session with the card, so Foxy can do one thing: tell the page a card was
/// tapped, and the page does what MENU > FLASHCARD does if it is a moment for it
/// (build/app/26f-flashcard.js, `cardTapped`).
///
/// Nothing of the address reaches the page, and nothing of it is kept or logged.
/// It is only checked here, and the page is told the same words whatever the query
/// or the fragment held. Nothing here touches NFC or the web view, so FoxyTests can
/// hold it to its rules.
enum CardAddress {
    static let scheme = "https"
    static let host = "getfoxy.io"
    static let path = "/card"

    /// Whether this is the card's address: `https`, the host `getfoxy.io` and nothing
    /// else of the authority (not `www.`, not a subdomain, no user, no port), and the
    /// path `/card`, or `/card/`, with nothing after it. A query or a fragment is
    /// accepted and means nothing. Anything else is not the card's, and the caller
    /// drops it without a word.
    ///
    /// It is read as it was handed over, letter by letter, and not through a URL
    /// parser's idea of a host, a user or a port: the address has to start
    /// `https://getfoxy.io/card`, and what may follow is the end, a slash and then the
    /// end, a `?` or a `#`, or a `?` or a `#` at once. Any other character after the
    /// host (a colon, an `@`, a dot, a letter) is another address, and so is any other
    /// way of spelling the path: the tag says `/card`, and `/c%61rd` is somebody
    /// else's idea of it. The scheme and the host are written without regard to case,
    /// as every URL does, and compared that way in ASCII; the path is not.
    static func isCard(_ url: URL?) -> Bool {
        guard let url else { return false }
        let text = Array(url.absoluteString.utf8)
        let head = Array((scheme + "://" + host).utf8)
        let route = Array(path.utf8)
        guard text.count >= head.count + route.count else { return false }
        for (i, wanted) in head.enumerated() where ascii(lower: text[i]) != wanted { return false }
        for (i, wanted) in route.enumerated() where text[head.count + i] != wanted { return false }
        var rest = text[(head.count + route.count)...]
        if rest.first == UInt8(ascii: "/") { rest = rest.dropFirst() }
        guard let next = rest.first else { return true }
        return next == UInt8(ascii: "?") || next == UInt8(ascii: "#")
    }

    /// An ASCII letter in lower case; every other byte as it is.
    private static func ascii(lower byte: UInt8) -> UInt8 {
        (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte) ? byte | 0x20 : byte
    }

    /// The whole of what the page is told, with nothing put into it. It is a call
    /// that does nothing, and answers nothing, until the page has put `_cardTapped`
    /// on its wallet; when it has, the answer is true, and that is how the phone
    /// learns the page has the request and can stop asking (CardTapDelivery).
    static let pageCall = "window.FoxyWallet && window.FoxyWallet._cardTapped && window.FoxyWallet._cardTapped()"
}
