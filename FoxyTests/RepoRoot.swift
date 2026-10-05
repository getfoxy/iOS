import Foundation

/// The repository's root folder, found from a test file's path by walking up to
/// project.yml. The same tests run in FoxyTests on the simulator and from
/// tools/nativetests, where they are reached through a link, so a fixed number of
/// folders up is not the root in both.
func repoRoot(_ file: String = #filePath) -> URL {
    var folder = URL(fileURLWithPath: file).deletingLastPathComponent()
    while folder.path != "/" {
        if FileManager.default.fileExists(atPath: folder.appendingPathComponent("project.yml").path) {
            return folder
        }
        folder.deleteLastPathComponent()
    }
    return URL(fileURLWithPath: file).deletingLastPathComponent().deletingLastPathComponent()
}
