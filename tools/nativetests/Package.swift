// swift-tools-version:5.9
//
// Foxy's native seed code, tested on a Mac without the iOS Simulator:
//
//     swift test --package-path tools/nativetests
//
// The module is named Foxy and compiles Foxy/Keychain as it is, every Swift file
// the app compiles there (Sources/Foxy is a link to that folder), so the tests
// in FoxyTests that need nothing of the app's UI build here unchanged with
// `@testable import Foxy` (Tests/FoxyTests is a link to that folder). They
// cover NUT-13 against the spec's vectors and tests/fixtures/nut13-cross.json,
// the P2PK lock keys against BIP-32's own vector and a second implementation,
// BIP-39, the counter store and its rules (derivation-index keys, capped moves,
// one import, the lock-key index in its own file), the seedMigrate window,
// SeedVault's rules, and every seed and counter action run with a stub vault,
// whose replies must hold no words, and the rules the phone mock answers by
// (tests/fixtures/native-rules.json) against the Swift that holds them.
//
// libsecp256k1 is Vendor/secp256k1 (Sources/CSecp256k1's src and include are
// links to it), compiled with the defines and optimisation project.yml gives it.
// tools/check-all.sh runs this, and GitHub's checks run it on macOS.
import PackageDescription

let package = Package(
    name: "FoxyNativeTests",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "CSecp256k1",
            path: "Sources/CSecp256k1",
            sources: ["src/secp256k1.c", "src/precomputed_ecmult.c", "src/precomputed_ecmult_gen.c"],
            publicHeadersPath: "include",
            cSettings: [
                // as project.yml: the source's own fallback table sizes, written out, and -O2
                .define("ECMULT_WINDOW_SIZE", to: "15"),
                .define("COMB_BLOCKS", to: "11"),
                .define("COMB_TEETH", to: "6"),
                // the modules Foxy/Nostr needs, as project.yml turns them on
                .define("ENABLE_MODULE_ECDH", to: "1"),
                .define("ENABLE_MODULE_EXTRAKEYS", to: "1"),
                .define("ENABLE_MODULE_SCHNORRSIG", to: "1"),
                .unsafeFlags(["-O2"]),
            ]
        ),
        .target(
            name: "Foxy",
            dependencies: ["CSecp256k1"],
            path: "Sources/Foxy",
            exclude: ["bip39-english.txt"]
        ),
        .testTarget(
            name: "FoxyTests",
            dependencies: ["Foxy"],
            path: "Tests/FoxyTests",
            // the app's own tests, which need Foxy.app (sh tools/unit-tests.sh)
            exclude: [
                "AnswerCapTests.swift", "BridgeTests.swift", "CounterRangeCheckTests.swift", "NativeSeedTests.swift",
                "NativeRulesBridgeTests.swift",
                "PromptQueueTests.swift", "RouteTests.swift",
            ],
            sources: [
                "RepoRoot.swift",
                "NUT13Tests.swift",
                "P2PKTests.swift",
                "BIP39Tests.swift",
                "CounterStoreTests.swift",
                "CounterRulesTests.swift",
                "NativeRulesTests.swift",
                "SeedMigrationWindowTests.swift",
                "SeedVaultTests.swift",
                "SeedActionsTests.swift",
            ]
        ),
    ]
)
