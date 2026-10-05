import Foundation

#if DEBUG
// MARK: - Keychain self-test — DEBUG only
//
// With -FoxyKeychainTest YES, on a signed simulator build (tools/sim-build.sh)
// or a phone: the keychain rules the page cannot reach from outside, run on
// scratch entries — never the wallet's own seed, which is only read. Lines
// start [keychaintest].
enum KeychainSelfTest {
    static func runIfAsked() {
        guard UserDefaults.standard.bool(forKey: "FoxyKeychainTest") else { return }
        func log(_ s: String) { DebugLog.both("[keychaintest]", s) }
        func check(_ name: String, _ ok: Bool) { log((ok ? "PASS " : "FAIL ") + name) }

        switch SeedStore.read(key: SeedStore.mnemonicKey) {
        case .found: log("the wallet's seed is in the keychain")
        case .absent: log("the keychain holds no wallet seed")
        case .failed(let status): log("reading the wallet's seed FAILED (\(status))")
        }

        let key = "foxy.seed.selftest"
        SeedStore.delete(key: key)
        let first = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        let other = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"
        let absent: Bool = { if case .absent = SeedStore.read(key: key) { return true }; return false }()
        check("an empty entry reads as absent, not as a failure", absent)
        check("a first seed is written", SeedStore.writeSeed(first, replace: false, key: key) == nil)
        check("the same seed written again is fine", SeedStore.writeSeed(first, replace: false, key: key) == nil)
        let refused = SeedStore.writeSeed(other, replace: false, key: key)
        check("a different seed is refused without replace", refused?.contains("different seed") == true)
        check("and the first seed is untouched", SeedStore.load(key: key) == first)
        check("replace: true replaces it", SeedStore.writeSeed(other, replace: true, key: key) == nil
              && SeedStore.load(key: key) == other)
        check("delete removes it", SeedStore.delete(key: key) && SeedStore.load(key: key) == nil)

        let orbotKey = "foxy.orbot.token.selftest"
        let token = UUID().uuidString
        check("an Orbot access key is stored and read back",
              SeedStore.save(token, key: orbotKey) && SeedStore.load(key: orbotKey) == token)
        SeedStore.delete(key: orbotKey)
        log("done")
    }
}
#endif
