import XCTest
import Security
import LocalAuthentication
@testable import Foxy

/// SeedVault's rules, apart from the keychain: what a read answers, when the
/// older item's seed moves, what a write may do, what a Face ID unlock covers,
/// and when a delete left no seed. Runs in FoxyTests and in tools/nativetests.
final class SeedVaultTests: XCTestCase {
    private let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let other = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong"

    func testTheProtectedItemSettlesAFoundSeedOrAFailure() {
        XCTAssertEqual(SeedVault.protectedAnswer(.found(words)), .found(words))
        XCTAssertEqual(SeedVault.protectedAnswer(.failed(errSecUserCanceled)),
                       .failed("Face ID or the passcode was cancelled"))
        XCTAssertEqual(SeedVault.protectedAnswer(.failed(errSecInteractionNotAllowed)), .failed("the phone is locked"))
        XCTAssertNil(SeedVault.protectedAnswer(.absent), "nothing there: the older item is asked next")
    }

    func testNoSeedIsAnsweredOnlyWhenNoneIsHidden() {
        XCTAssertEqual(SeedVault.olderStep(.absent, passcodeSet: true, hidden: false), .answer(.absent))
        XCTAssertEqual(SeedVault.olderStep(.absent, passcodeSet: false, hidden: false), .answer(.absent),
                       "a phone that never had a passcode still makes its first seed")
    }

    /// I10: no passcode, and the note says a seed was put behind one. The
    /// protected item's "not found" is not believed.
    func testASeedBehindARemovedPasscodeIsAFailureNotNoSeed() {
        XCTAssertEqual(SeedVault.olderStep(.absent, passcodeSet: false, hidden: true),
                       .answer(.failed(SeedVault.hiddenBehindPasscode)))
    }

    func testAHiddenSeedIsNeverWrittenOver() {
        guard case .answer(let read) = SeedVault.olderStep(.absent, passcodeSet: false, hidden: true) else {
            return XCTFail("a hidden seed did not settle the read")
        }
        for replace in [false, true] {
            guard case .refuse(let why) = SeedVault.writeStep(current: read, words: words, replace: replace) else {
                return XCTFail("a new seed would be written over a hidden one (replace \(replace))")
            }
            XCTAssertTrue(why.contains("nothing was written"), why)
        }
    }

    func testTheOlderItemsSeedMovesOnlyWithAPasscode() {
        XCTAssertEqual(SeedVault.olderStep(.found(words), passcodeSet: true, hidden: false), .move(words))
        XCTAssertEqual(SeedVault.olderStep(.found(words), passcodeSet: false, hidden: false), .keep(words))
        XCTAssertEqual(SeedVault.olderStep(.found(words), passcodeSet: false, hidden: true), .keep(words),
                       "a seed the phone can read is used, and nothing new is made")
        XCTAssertEqual(SeedVault.olderStep(.failed(errSecAuthFailed), passcodeSet: true, hidden: false),
                       .answer(.failed("Face ID or the passcode did not match")))
    }

    func testTheWriteRules() {
        XCTAssertEqual(SeedVault.writeStep(current: .failed("status -25308"), words: words, replace: true),
                       .refuse("The keychain did not answer (status -25308), so nothing was written."))
        XCTAssertEqual(SeedVault.writeStep(current: .found(other), words: words, replace: false),
                       .refuse("A different seed is already saved on this phone. Foxy did not replace it."))
        XCTAssertEqual(SeedVault.writeStep(current: .found(other), words: words, replace: true), .askToReplace)
        XCTAssertEqual(SeedVault.writeStep(current: .found(words), words: words, replace: false), .write)
        XCTAssertEqual(SeedVault.writeStep(current: .found(words), words: words, replace: true), .write)
        XCTAssertEqual(SeedVault.writeStep(current: .absent, words: words, replace: false), .write)
    }

    // MARK: Review

    /// L2: an unlock covers the next read only, within 30 seconds, and never the words screen.
    func testAnUnlockCoversOnlyTheNextReadAndNeverTheWordsScreen() {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(SeedVault.unlockCovers(notedAt: at, now: at.addingTimeInterval(29), forScreen: false))
        XCTAssertFalse(SeedVault.unlockCovers(notedAt: at, now: at.addingTimeInterval(30), forScreen: false))
        XCTAssertFalse(SeedVault.unlockCovers(notedAt: at, now: at.addingTimeInterval(-1), forScreen: false))
        XCTAssertFalse(SeedVault.unlockCovers(notedAt: at, now: at, forScreen: true), "the words screen always asks")

        let unlock = LAContext()
        SeedVault.noteUnlock(unlock)
        XCTAssertTrue(SeedVault.takeUnlock(forScreen: false) === unlock)
        XCTAssertNil(SeedVault.takeUnlock(forScreen: false), "used up by the read it covered")

        SeedVault.noteUnlock(unlock)
        XCTAssertNil(SeedVault.takeUnlock(forScreen: true))
        XCTAssertNil(SeedVault.takeUnlock(forScreen: false), "the screen's read used it up too")

        SeedVault.noteUnlock(unlock)
        SeedVault.forgetNativeSeed()                  // the background, the page gone, a seed write
        XCTAssertNil(SeedVault.takeUnlock(forScreen: false))

        SeedVault.noteUnlock(unlock)
        XCTAssertNil(SeedVault.takeUnlock(forScreen: false, now: Date().addingTimeInterval(31)))
    }

    /// The seed in memory serves the work Foxy does as it is put away, and
    /// nothing after it.
    ///
    /// It was forgotten the instant Foxy left and read again for the
    /// small-change top-up. Behind Face ID that read cannot be made from the
    /// background (-25308), so on a phone that protects its seed the top-up
    /// never ran (from a phone log).
    func testASeedPutAwayServesTheWorkOfLeavingAndNothingAfter() throws {
        let seed = try NUT13.seed(mnemonic: words)
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        func visit() {
            SeedVault.forgetNativeSeed()
            SeedVault.keep(seed, readAt: SeedVault.epochNow)
        }

        XCTAssertTrue(SeedVault.leavingCovers(keptAt: at, now: at))
        XCTAssertTrue(SeedVault.leavingCovers(keptAt: at, now: at.addingTimeInterval(SeedVault.leavingSeconds - 1)))
        XCTAssertFalse(SeedVault.leavingCovers(keptAt: at, now: at.addingTimeInterval(SeedVault.leavingSeconds)))
        XCTAssertFalse(SeedVault.leavingCovers(keptAt: at, now: at.addingTimeInterval(-1)), "a clock that went backwards covers nothing")
        XCTAssertLessThanOrEqual(SeedVault.leavingSeconds, 30, "iOS allows about thirty seconds in the background")

        // a visit holds the seed; put away, it is there for the top-up
        visit()
        XCTAssertTrue(SeedVault.kept(now: at)?.sameBytes(as: seed) == true)
        SeedVault.putAway(now: at)
        XCTAssertTrue(SeedVault.kept(now: at.addingTimeInterval(5))?.sameBytes(as: seed) == true, "for the work of leaving")
        // and a read begun before Foxy left keeps nothing for the visit after it
        XCTAssertNotEqual(SeedVault.epochNow, 0)
        // out of time, it is gone, and stays gone when the clock is asked again
        XCTAssertNil(SeedVault.kept(now: at.addingTimeInterval(SeedVault.leavingSeconds)))
        XCTAssertNil(SeedVault.kept(now: at.addingTimeInterval(1)), "dropped, not waiting for an earlier time")

        // the work is over, or Foxy is back in front: nothing is kept, so the next read asks
        visit()
        SeedVault.putAway(now: at)
        SeedVault.endLeaving()
        XCTAssertNil(SeedVault.kept(now: at.addingTimeInterval(1)))

        // a read that was waiting on Face ID when Foxy left does not put a seed back
        visit()
        let before = SeedVault.epochNow
        SeedVault.putAway(now: at)
        SeedVault.endLeaving()
        SeedVault.keep(seed, readAt: before)
        XCTAssertNil(SeedVault.kept(now: at), "its epoch has passed")

        // a visit that never read the seed leaves with none
        SeedVault.forgetNativeSeed()
        SeedVault.putAway(now: at)
        XCTAssertNil(SeedVault.kept(now: at))

        // everything that forgets the seed forgets this one too
        let forgets: [(String, () -> Void)] = [
            ("forgetNativeSeed", SeedVault.forgetNativeSeed),
            ("forgetUnlock", SeedVault.forgetUnlock),
            ("pageWillLoad", SeedVault.pageWillLoad),
        ]
        for (name, forget) in forgets {
            visit()
            SeedVault.putAway(now: at)
            forget()
            XCTAssertNil(SeedVault.kept(now: at.addingTimeInterval(1)), name)
        }

        // and being put away still gives up the unlock and the typed words, as it did
        let unlock = LAContext()
        SeedVault.noteUnlock(unlock)
        _ = try SeedCandidates.shared.add(words)
        visit()
        SeedVault.noteUnlock(unlock)
        SeedVault.putAway(now: at)
        XCTAssertNil(SeedVault.takeUnlock(forScreen: false), "no approval is carried into the background")
        XCTAssertEqual(SeedCandidates.shared.count, 0, "nor words typed for a restore")
        SeedVault.forgetNativeSeed()
    }

    /// M7: a write that reported a problem is a success when the keychain holds the words after all.
    func testAWriteWhoseReadBackFailedIsASuccessIfTheWordsAreThere() {
        var reads = 0
        XCTAssertNil(SeedVault.writeOutcome(problem: nil, words: words) { reads += 1; return .absent })
        XCTAssertEqual(reads, 0, "no problem, no second read")
        XCTAssertNil(SeedVault.writeOutcome(problem: "it did not read back", words: words) { reads += 1; return .found(words) })
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(SeedVault.writeOutcome(problem: "it did not read back", words: words) { .found(other) }, "it did not read back")
        XCTAssertEqual(SeedVault.writeOutcome(problem: "the keychain refused the write", words: words) { .failed("the phone is locked") },
                       "the keychain refused the write")
        XCTAssertEqual(SeedVault.writeOutcome(problem: "x", words: words) { .absent }, "x")
    }

    /// L5: a wipe goes on only when every seed item answers "not found" after its delete.
    func testADeleteLeftNoSeedOnlyWhenEveryItemIsGone() {
        XCTAssertTrue(SeedVault.seedGone(deleted: [true, true], stillThere: [false, false]))
        XCTAssertTrue(SeedVault.seedGone(deleted: [false, true], stillThere: [false, false]), "a delete that failed on nothing")
        XCTAssertFalse(SeedVault.seedGone(deleted: [true, true], stillThere: [true, false]))
        XCTAssertFalse(SeedVault.seedGone(deleted: [false, true], stillThere: [false, true]))
        XCTAssertFalse(SeedVault.seedGone(deleted: [true, true], stillThere: [nil, false]), "a keychain that would not say")
        XCTAssertFalse(SeedVault.seedGone(deleted: [true], stillThere: [false, false]))
    }

    func testTheSeedChangedNotificationIsTheOneTheScreensCloseOn() {
        XCTAssertEqual(SeedVault.seedChanged.rawValue, "FoxySeedChanged")
    }
}
