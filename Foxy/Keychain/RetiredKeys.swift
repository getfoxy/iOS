import Foundation

/// Keychain items an earlier test build could leave behind and nothing reads now: a push token, the token last
/// registered, and a secret made for the wake server, which Foxy no longer has. Deleted early in every launch
/// (FoxyApp), so a phone that ran that build keeps no push token. Nothing is read, so nothing is logged.
enum RetiredKeys {
    static let keys = ["foxy.wake.token", "foxy.wake.secret", "foxy.wake.told"]

    /// Each one deleted where it is (the Keychain in the app, the tests' own stand-in).
    static func remove(_ delete: (String) -> Void = { _ = SeedStore.deleteIfPresent(key: $0) }) {
        for key in keys { delete(key) }
    }
}
