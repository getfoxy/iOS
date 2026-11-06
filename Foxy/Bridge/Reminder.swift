import Foundation
import UserNotifications

/// The one reminder Foxy makes for itself: a local notification fifteen days after Foxy was last in front, so a payment or
/// message waiting at the relays is not missed. Made on the phone and sent by nobody; there is no push and no server.
///
/// The page asks once (`reminder`, FoxyBridge.swift) and the phone keeps the answer (`enabled`). From then on every coming
/// to the front and every going away replaces the pending notification with a new one fifteen days out (`refresh`), so it
/// fires only after fifteen days away. The words are fixed here; the page supplies no text.
enum Reminder {
    /// Fifteen days, in one place. The page names it in `days` and anything else is refused.
    static let days = 15
    static let title = "Foxy"
    static let body = "You have not opened Foxy in 15 days. A payment or message may be waiting for you."
    static let identifier = "foxy.reminder"
    static let enabledKey = "foxy.reminder.enabled"

    /// What the notification centre is asked, so the tests can stand in for it.
    protocol Center {
        func status(_ done: @escaping (UNAuthorizationStatus) -> Void)
        func request(_ done: @escaping (Bool) -> Void)
        func replace(_ request: UNNotificationRequest)
        func remove()
    }

    struct System: Center {
        func status(_ done: @escaping (UNAuthorizationStatus) -> Void) {
            UNUserNotificationCenter.current().getNotificationSettings { done($0.authorizationStatus) }
        }
        func request(_ done: @escaping (Bool) -> Void) {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in done(granted) }
        }
        func replace(_ request: UNNotificationRequest) {
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: [Reminder.identifier])
            center.add(request)
        }
        func remove() {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [Reminder.identifier])
        }
    }

    static var center: Center = System()
    static var store: UserDefaults = .standard

    /// Whether the person has said yes and not turned it off since.
    static var enabled: Bool { store.bool(forKey: enabledKey) }

    /// Seconds from now to the notification. A Debug build may shorten it for a phone test: `-FoxyReminderMinutes N`.
    static var interval: TimeInterval {
        #if DEBUG
        let minutes = UserDefaults.standard.double(forKey: "FoxyReminderMinutes")
        if minutes > 0 { return max(60, minutes * 60) }
        #endif
        return TimeInterval(days) * 86_400
    }

    /// What the page asked of the `reminder` action. Only the fixed number of days is taken, exactly: 15.5, "15" and the like are refused.
    enum Ask: Equatable { case cancel, on(ask: Bool), refused }

    static func parse(_ body: [String: Any]) -> Ask {
        if body["cancel"] as? Bool == true { return .cancel }
        guard (body["days"] as? Int) == days else { return .refused }
        return .on(ask: body["ask"] as? Bool ?? true)
    }

    static func request() -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.interruptionLevel = .active
        content.userInfo = ["foxy": true]
        return UNNotificationRequest(
            identifier: identifier, content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false))
    }

    /// The page asked for it on. `ask` false never shows iOS's question: it answers "needs" while that is still to be asked.
    /// Answers "ok", "needs" or "refused".
    static func turnOn(ask: Bool, done: @escaping (String) -> Void) {
        center.status { status in
            switch status {
            case .authorized, .provisional, .ephemeral:
                store.set(true, forKey: enabledKey)
                center.replace(request())
                done("ok")
            case .notDetermined:
                guard ask else { done("needs"); return }
                center.request { granted in
                    if granted {
                        store.set(true, forKey: enabledKey)
                        center.replace(request())
                    }
                    done(granted ? "ok" : "refused")
                }
            default:
                store.set(false, forKey: enabledKey)
                done("refused")
            }
        }
    }

    /// Off: nothing pending and nothing to renew.
    static func turnOff() {
        store.set(false, forKey: enabledKey)
        center.remove()
    }

    /// Foxy came to the front or went away: the pending notification is replaced by one fifteen days from now.
    static func refresh() {
        guard enabled else { return }
        center.status { status in
            switch status {
            case .authorized, .provisional, .ephemeral:
                // turned off while the settings were being read: nothing new is made
                if enabled { center.replace(request()) } else { center.remove() }
            default: center.remove()
            }
        }
    }
}
