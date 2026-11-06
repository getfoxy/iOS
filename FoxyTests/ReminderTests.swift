import XCTest
import UserNotifications
@testable import Foxy

/// The reminder after fifteen days away (Reminder.swift): scheduled when the person says yes, replaced every time Foxy
/// comes to the front or goes away, gone when it is turned off, and never made without iOS's permission.
final class ReminderTests: XCTestCase {
    final class Fake: Reminder.Center {
        var state: UNAuthorizationStatus = .notDetermined
        var grants = true
        var asked = 0
        var pending: [UNNotificationRequest] = []
        var adds = 0
        var onStatus: (() -> Void)?
        func status(_ done: @escaping (UNAuthorizationStatus) -> Void) { let s = state; onStatus?(); done(s) }
        func request(_ done: @escaping (Bool) -> Void) {
            asked += 1
            state = grants ? .authorized : .denied
            done(grants)
        }
        func replace(_ request: UNNotificationRequest) { pending = [request]; adds += 1 }
        func remove() { pending = [] }
    }

    private var fake = Fake()
    private var kept: (Reminder.Center, UserDefaults)!
    private let suite = "foxy.reminder.tests"

    override func setUp() {
        kept = (Reminder.center, Reminder.store)
        UserDefaults().removePersistentDomain(forName: suite)
        fake = Fake()
        Reminder.center = fake
        Reminder.store = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        Reminder.center = kept.0
        Reminder.store = kept.1
        UserDefaults().removePersistentDomain(forName: suite)
    }

    private func turnOn(ask: Bool) -> String {
        var answer = ""
        Reminder.turnOn(ask: ask) { answer = $0 }
        return answer
    }

    func testFifteenDaysAndTheWords() throws {
        XCTAssertEqual(Reminder.days, 15)
        fake.state = .authorized
        XCTAssertEqual(turnOn(ask: false), "ok")
        let r = try XCTUnwrap(fake.pending.first)
        let trigger = try XCTUnwrap(r.trigger as? UNTimeIntervalNotificationTrigger)
        XCTAssertEqual(trigger.timeInterval, 15 * 86_400)
        XCTAssertFalse(trigger.repeats)
        XCTAssertEqual(r.content.interruptionLevel, .active, "a banner and a sound, as the payment notifications")
        XCTAssertEqual(r.content.title, "Foxy")
        XCTAssertEqual(r.content.body, "You have not opened Foxy in 15 days. A payment may be waiting for you.")
        XCTAssertTrue(Reminder.enabled)
    }

    func testNotAskedWhenNotAsked() {
        XCTAssertEqual(turnOn(ask: false), "needs")
        XCTAssertEqual(fake.asked, 0)
        XCTAssertTrue(fake.pending.isEmpty)
        XCTAssertFalse(Reminder.enabled)
    }

    func testAskedOnceAndGranted() {
        XCTAssertEqual(turnOn(ask: true), "ok")
        XCTAssertEqual(fake.asked, 1)
        XCTAssertEqual(fake.pending.count, 1)
        XCTAssertTrue(Reminder.enabled)
    }

    func testRefusedMakesNothing() {
        fake.grants = false
        XCTAssertEqual(turnOn(ask: true), "refused")
        XCTAssertTrue(fake.pending.isEmpty)
        XCTAssertFalse(Reminder.enabled)
        XCTAssertEqual(turnOn(ask: true), "refused")
        XCTAssertEqual(fake.asked, 1, "iOS is asked once")
    }

    func testEveryComingAndGoingReplacesTheOne() {
        fake.state = .authorized
        _ = turnOn(ask: false)
        let before = fake.adds
        Reminder.refresh()
        Reminder.refresh()
        XCTAssertEqual(fake.adds, before + 2)
        XCTAssertEqual(fake.pending.count, 1, "never more than one pending")
    }

    func testOffCancelsAndStaysOff() {
        fake.state = .authorized
        _ = turnOn(ask: false)
        Reminder.turnOff()
        XCTAssertTrue(fake.pending.isEmpty)
        XCTAssertFalse(Reminder.enabled)
        Reminder.refresh()
        XCTAssertTrue(fake.pending.isEmpty, "off stays off")
    }

    func testRefreshWithoutSayingYesMakesNothing() {
        fake.state = .authorized
        Reminder.refresh()
        XCTAssertTrue(fake.pending.isEmpty)
    }

    func testTurnedOffWhileRefreshReadsSettingsMakesNothing() {
        fake.state = .authorized
        _ = turnOn(ask: false)
        fake.onStatus = { Reminder.turnOff() }
        Reminder.refresh()
        XCTAssertTrue(fake.pending.isEmpty, "a switch turned off meanwhile is not undone")
    }

    func testWhatThePageMayAsk() {
        XCTAssertEqual(Reminder.parse(["days": 15]), .on(ask: true))
        XCTAssertEqual(Reminder.parse(["days": 15, "ask": false]), .on(ask: false))
        XCTAssertEqual(Reminder.parse(["cancel": true]), .cancel)
        XCTAssertEqual(Reminder.parse(["days": 1]), .refused)
        XCTAssertEqual(Reminder.parse(["days": 15.5]), .refused)
        XCTAssertEqual(Reminder.parse(["days": "15"]), .refused)
        XCTAssertEqual(Reminder.parse([:]), .refused)
        XCTAssertEqual(Reminder.parse(["cancel": false]), .refused)
    }

    func testPermissionTakenAwayInSettingsClearsIt() {
        fake.state = .authorized
        _ = turnOn(ask: false)
        fake.state = .denied
        Reminder.refresh()
        XCTAssertTrue(fake.pending.isEmpty)
    }
}
