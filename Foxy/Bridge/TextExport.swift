import Foundation

/// A text the page hands over to be kept outside Foxy (the `exportText` action,
/// FoxyBridge.swift): the unclaimed tokens a storage-full phone lists before
/// anything is cleared, which can be the only copy of money.
///
/// Never the general pasteboard. What is put there reaches the person's other
/// devices (Universal Clipboard), any app can read it, and it never expires.
/// So the text is written to a file of its own in the app's temporary folder,
/// protected while the phone is locked, and offered in the share sheet, where
/// the person chooses where it goes (Save to Files, AirDrop to their own Mac, a
/// note). Copy is left out of that sheet for the same reason, and the file is
/// deleted when the sheet closes, whatever was chosen.
///
/// Foundation only, so tools/nativetests can build it on a Mac
/// (FoxyTextExport) and TextExportTests can hold it without a phone.
enum TextExport {
    /// The most the page may hand over: far more than every token a full store
    /// can hold (WebKit's 5 MiB), and a bound on a page that asks for more.
    static let maxCharacters = 16 * 1024 * 1024

    /// The share sheet's activities that are left out: Copy (the general
    /// pasteboard), and the ones that would turn bearer money into a contact,
    /// a print, a reading-list item or a photo.
    static let excludedActivities = [
        "com.apple.UIKit.activity.CopyToPasteboard",
        "com.apple.UIKit.activity.AssignToContact",
        "com.apple.UIKit.activity.Print",
        "com.apple.UIKit.activity.AddToReadingList",
        "com.apple.UIKit.activity.SaveToCameraRoll",
    ]

    enum Refusal: Error, Equatable {
        case empty
        case tooLong
    }

    /// Whether a text from the page is one to export.
    static func check(_ text: String) -> Refusal? {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
        if text.count > maxCharacters { return .tooLong }
        return nil
    }

    /// The file's name, as the person will see it where they put it: what it is
    /// and the day, nothing else (no amount, no mint).
    static func fileName(_ label: String, at date: Date) -> String {
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = TimeZone(identifier: "UTC")
        day.dateFormat = "yyyy-MM-dd"
        let plain = label.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " }
        let name = String(String.UnicodeScalarView(plain)).trimmingCharacters(in: .whitespaces)
        return "Foxy " + (name.isEmpty ? "export" : name) + " " + day.string(from: date) + ".txt"
    }

    /// Written into a folder of its own under `directory` (so two exports never
    /// share a file, and removing one removes nothing else), atomically, and on
    /// a phone with complete file protection. Answers the file's URL.
    static func write(_ text: String, label: String, in directory: URL, at date: Date) throws -> URL {
        if let refusal = check(text) { throw refusal }
        let folder = directory.appendingPathComponent("foxy-export-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(fileName(label, at: date))
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtection)
        #endif
        try Data(text.utf8).write(to: file, options: options)
        return file
    }

    /// The file and its folder gone, once the sheet has closed.
    static func remove(_ file: URL) {
        let folder = file.deletingLastPathComponent()
        if folder.lastPathComponent.hasPrefix("foxy-export-") {
            try? FileManager.default.removeItem(at: folder)
        } else {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// What is left in `directory` from an export whose sheet never closed (the
    /// app killed with it open): removed at the next export.
    static func removeLeftovers(in directory: URL) {
        let items = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for item in items where item.lastPathComponent.hasPrefix("foxy-export-") {
            try? FileManager.default.removeItem(at: item)
        }
    }
}
