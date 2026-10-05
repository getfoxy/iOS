import XCTest
import CryptoKit
@testable import Foxy

/// BIP-39 made natively: the wordlist is the page's, the words come out as the
/// standard's vectors say, a new seed's checksum is right, and typed words are
/// checked as the page checked them. Runs in FoxyTests and in tools/nativetests.
final class BIP39Tests: XCTestCase {

    private var root: URL { repoRoot() }

    private func list() throws -> [String] {
        #if SWIFT_PACKAGE
        // tools/nativetests has no app bundle: the same file, through the same pinned-digest check
        return try XCTUnwrap(BIP39.wordlist(try Data(contentsOf: root.appendingPathComponent("Foxy/Keychain/bip39-english.txt"))))
        #else
        return try XCTUnwrap(BIP39.english, "the bundled wordlist did not load, or is not the pinned list")
        #endif
    }

    /// The English list inside the bundled @scure/bip39 (Web/bip39.js), read from the file.
    private func pageWordlist() throws -> [String] {
        let js = try String(contentsOf: root.appendingPathComponent("Web/bip39.js"), encoding: .utf8)
        let start = try XCTUnwrap(js.range(of: "Object.freeze(`abandon\n"))
        let end = try XCTUnwrap(js.range(of: "\nzoo`", range: start.upperBound..<js.endIndex))
        return String(js[js.index(start.upperBound, offsetBy: -"abandon\n".count)..<js.index(end.upperBound, offsetBy: -1)])
            .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    // MARK: The wordlist

    func testTheBundledWordlistIsThePagesWordlist() throws {
        let page = try pageWordlist()
        XCTAssertEqual(page.count, 2048)
        XCTAssertEqual(try list(), page)
        XCTAssertEqual(page.first, "abandon")
        XCTAssertEqual(page.last, "zoo")
    }

    func testTheWordlistsHashIsThePinnedHash() throws {
        let file = try Data(contentsOf: root.appendingPathComponent("Foxy/Keychain/bip39-english.txt"))
        XCTAssertEqual(NUT13.hex(Array(SHA256.hash(data: file))), BIP39.englishSHA256)
        // the page's list, written as the file is, has the same digest
        let page = Data((try pageWordlist().joined(separator: "\n") + "\n").utf8)
        XCTAssertEqual(NUT13.hex(Array(SHA256.hash(data: page))), BIP39.englishSHA256)
        XCTAssertEqual(BIP39.wordlist(file), try list())
    }

    func testAListWithOneWordChangedIsRefused() throws {
        var words = try list()
        words[1000] = "foxy"
        XCTAssertNil(BIP39.wordlist(Data((words.joined(separator: "\n") + "\n").utf8)))
        XCTAssertNil(BIP39.wordlist(Data(try list().joined(separator: "\n").utf8)), "no final newline, another digest")
        XCTAssertNil(BIP39.wordlist(Data()))
    }

    // MARK: Words from entropy

    func testTheStandardsVectors() throws {
        // from the BIP-39 repository's vectors.json, English, no passphrase
        let vectors: [(String, String)] = [
            ("00000000000000000000000000000000",
             "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
            ("7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
             "legal winner thank year wave sausage worth useful legal winner thank yellow"),
            ("80808080808080808080808080808080",
             "letter advice cage absurd amount doctor acoustic avoid letter advice cage above"),
            ("ffffffffffffffffffffffffffffffff",
             "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"),
            ("9e885d952ad362caeb4efe34a8e91bd2",
             "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic"),
            ("0000000000000000000000000000000000000000000000000000000000000000",
             "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"),
        ]
        for (entropy, phrase) in vectors {
            let words = try BIP39.words(entropy: try NUT13.bytes(hex: entropy), wordlist: try list())
            XCTAssertEqual(words.joined(separator: " "), phrase)
            XCTAssertTrue(BIP39.isValid(words, wordlist: try list()), phrase)
        }
    }

    func testEntropyOfOtherLengthsIsRefused() throws {
        for count in [0, 15, 17, 33] {
            XCTAssertThrowsError(try BIP39.words(entropy: [UInt8](repeating: 1, count: count), wordlist: try list()))
        }
        XCTAssertThrowsError(try BIP39.words(entropy: [UInt8](repeating: 1, count: 16), wordlist: ["abandon"]))
    }

    func testANewSeedIsTwelveWordsWithTheChecksumRight() throws {
        var seen = Set<String>()
        for _ in 0..<50 {
            let phrase = try BIP39.generate(wordlist: try list())
            let words = phrase.split(separator: " ").map(String.init)
            XCTAssertEqual(words.count, 12)
            XCTAssertTrue(BIP39.isValid(words, wordlist: try list()), phrase)
            // and a seed the derivation takes
            XCTAssertNoThrow(try NUT13.seed(mnemonic: phrase))
            seen.insert(phrase)
        }
        XCTAssertEqual(seen.count, 50, "128 random bits never repeat in fifty")
    }

    // MARK: Checking typed words

    func testWordsThatAreNotAPhraseAreRefused() throws {
        let wordlist = try list()
        let valid = "legal winner thank year wave sausage worth useful legal winner thank yellow".split(separator: " ").map(String.init)
        XCTAssertTrue(BIP39.isValid(valid, wordlist: wordlist))
        var wrongChecksum = valid
        wrongChecksum[11] = "year"
        XCTAssertFalse(BIP39.isValid(wrongChecksum, wordlist: wordlist))
        XCTAssertFalse(BIP39.isValid(Array(repeating: "abandon", count: 12), wordlist: wordlist))
        var unknown = valid
        unknown[3] = "foxy"
        XCTAssertFalse(BIP39.isValid(unknown, wordlist: wordlist))
        var upper = valid
        upper[0] = "Legal"
        XCTAssertFalse(BIP39.isValid(upper, wordlist: wordlist), "the list is lower case; the screen lowercases first")
        XCTAssertFalse(BIP39.isValid(Array(valid.prefix(11)), wordlist: wordlist))
        XCTAssertFalse(BIP39.isValid([], wordlist: wordlist))
    }

    func testIndexAndSuggestions() throws {
        let wordlist = try list()
        XCTAssertEqual(BIP39.index(of: "abandon", in: wordlist), 0)
        XCTAssertEqual(BIP39.index(of: "zoo", in: wordlist), 2047)
        XCTAssertEqual(BIP39.index(of: "wrong", in: wordlist), 2037)
        XCTAssertNil(BIP39.index(of: "aband", in: wordlist))
        XCTAssertNil(BIP39.index(of: "", in: wordlist))
        XCTAssertEqual(BIP39.suggestions("ab", wordlist: wordlist), ["abandon", "ability", "able", "about"])
        XCTAssertEqual(BIP39.suggestions("zoo", wordlist: wordlist), ["zoo"])
        XCTAssertEqual(BIP39.suggestions("wro", wordlist: wordlist), ["wrong"])
        XCTAssertEqual(BIP39.suggestions("xyz", wordlist: wordlist), [])
        XCTAssertEqual(BIP39.suggestions("", wordlist: wordlist), [])
        XCTAssertEqual(BIP39.suggestions("a", wordlist: wordlist, limit: 2), ["abandon", "ability"])
    }
}
