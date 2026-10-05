import Foundation
import CryptoKit
import Security

/// BIP-39's English words, natively: a new seed's twelve words, and a check of
/// typed ones, without the page (NativeSeedBridge.swift's seedCreate, seedEnter
/// and seedMigrate, in every build).
///
/// The list is bundled as Foxy/Keychain/bip39-english.txt and its SHA-256 is
/// checked every time it is loaded: a list with one word changed would make
/// seeds no other wallet can restore. It must be the list inside Web/bip39.js,
/// which tools/verify-vendor.py pins; smoke check 32 and BIP39Tests compare the
/// two.
enum BIP39 {
    /// bip39-english.txt: 2048 words, each followed by a newline. The same
    /// digest as english.txt in the BIP-39 repository.
    static let englishSHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

    enum Failure: Error, Equatable {
        /// Not 16, 20, 24, 28 or 32 bytes, or not a 2048-word list.
        case badEntropy
        /// The system's random source failed.
        case random
    }

    /// The bundled list, or nil when it is missing or is not the pinned list,
    /// in which case nothing is made or checked with it.
    static let english: [String]? = {
        guard let url = Bundle.main.url(forResource: "bip39-english", withExtension: "txt"),
              let data = try? Data(contentsOf: url) else {
            print("[foxy] bip39: the wordlist is not in the app")
            return nil
        }
        guard let list = wordlist(data) else {
            print("[foxy] bip39: the bundled wordlist is not the pinned list; nothing is made or checked with it")
            return nil
        }
        return list
    }()

    /// The words of a list file, only if its SHA-256 is the pinned one.
    static func wordlist(_ data: Data) -> [String]? {
        guard NUT13.hex(Array(SHA256.hash(data: data))) == englishSHA256 else { return nil }
        var lines = String(decoding: data, as: UTF8.self)
            .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.last == "" else { return nil }
        lines.removeLast()
        return lines.count == 2048 ? lines : nil
    }

    /// The words for `entropy`: the entropy followed by the first ENT/32 bits of
    /// its SHA-256, read eleven bits at a time.
    static func words(entropy: [UInt8], wordlist: [String]) throws -> [String] {
        guard [16, 20, 24, 28, 32].contains(entropy.count), wordlist.count == 2048 else { throw Failure.badEntropy }
        var digest = Array(SHA256.hash(data: entropy))
        defer { NUT13.wipe(&digest) }
        let entropyBits = entropy.count * 8
        let totalBits = entropyBits + entropy.count / 4
        func bit(_ i: Int) -> Int {
            // the checksum is at most 8 bits, so it all comes from the digest's first byte
            let byte = i < entropyBits ? entropy[i / 8] : digest[0]
            let offset = i < entropyBits ? i % 8 : i - entropyBits
            return Int(byte >> UInt8(7 - offset)) & 1
        }
        var out: [String] = []
        out.reserveCapacity(totalBits / 11)
        for first in stride(from: 0, to: totalBits, by: 11) {
            var index = 0
            for k in 0..<11 { index = index << 1 | bit(first + k) }
            out.append(wordlist[index])
        }
        return out
    }

    /// Twelve new words from 128 bits of the system's random source, as the
    /// page's generateMnemonic(wordlist, 128) made them.
    static func generate(wordlist: [String]) throws -> String {
        var entropy = [UInt8](repeating: 0, count: 16)
        defer { NUT13.wipe(&entropy) }
        guard SecRandomCopyBytes(kSecRandomDefault, entropy.count, &entropy) == errSecSuccess else { throw Failure.random }
        return try words(entropy: entropy, wordlist: wordlist).joined(separator: " ")
    }

    /// A word's place in the list. The list is sorted, so this halves it.
    static func index(of word: String, in wordlist: [String]) -> Int? {
        let i = lowerBound(word, wordlist)
        return i < wordlist.count && wordlist[i] == word ? i : nil
    }

    private static func lowerBound(_ word: String, _ list: [String]) -> Int {
        var low = 0, high = list.count
        while low < high {
            let mid = (low + high) / 2
            if list[mid] < word { low = mid + 1 } else { high = mid }
        }
        return low
    }

    /// Whether the words are a BIP-39 phrase: a length BIP-39 allows, every word
    /// on the list, and the checksum right. A typo that happens to be another
    /// word fails here, fifteen times in sixteen for twelve words, rather than at
    /// a mint that finds nothing.
    static func isValid(_ words: [String], wordlist: [String]) -> Bool {
        guard [12, 15, 18, 21, 24].contains(words.count), wordlist.count == 2048 else { return false }
        var bits = [UInt8](repeating: 0, count: words.count * 11)
        defer { NUT13.wipe(&bits) }
        for (n, word) in words.enumerated() {
            guard let i = index(of: word, in: wordlist) else { return false }
            for k in 0..<11 { bits[n * 11 + k] = UInt8((i >> (10 - k)) & 1) }
        }
        let checksumBits = bits.count / 33
        let entropyBytes = (bits.count - checksumBits) / 8
        var entropy = [UInt8](repeating: 0, count: entropyBytes)
        defer { NUT13.wipe(&entropy) }
        for b in 0..<(entropyBytes * 8) {
            entropy[b / 8] |= bits[b] << UInt8(7 - b % 8)
        }
        let first = Array(SHA256.hash(data: entropy))[0]
        var mismatch: UInt8 = 0
        for c in 0..<checksumBits {
            mismatch |= bits[entropyBytes * 8 + c] ^ ((first >> UInt8(7 - c)) & 1)
        }
        return mismatch == 0
    }

    /// Up to `limit` words that start with `prefix`, in list order.
    static func suggestions(_ prefix: String, wordlist: [String], limit: Int = 4) -> [String] {
        guard !prefix.isEmpty else { return [] }
        var out: [String] = []
        var i = lowerBound(prefix, wordlist)
        while i < wordlist.count, out.count < limit, wordlist[i].hasPrefix(prefix) {
            out.append(wordlist[i])
            i += 1
        }
        return out
    }
}
