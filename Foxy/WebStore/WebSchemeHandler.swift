import Foundation
import WebKit

/// Serves the staged page at `foxy-app://wallet/…` (WebStore), from the
/// staged folder (Library/Caches/web) and nothing above it.
///
/// The page's origin is then a fixed name, so WebKit keeps its storage under
/// the same key whatever folder iOS gives the app. Everything else is as it
/// was with a file URL: the files are the staged ones the page hash covers,
/// nothing is fetched from anywhere, and the content rule list and the
/// dead-end proxy still stand between the page and the network (this scheme
/// is answered here, in the app, and never reaches either).
///
/// Refused, with no body: anything but GET, an address that is not
/// `foxy-app://wallet` exactly (no port, no user), a path that leaves the
/// folder (`..`, a link pointing out, an encoded slash), a name starting
/// with a dot, a folder, and a file that is not there.
final class WebSchemeHandler: NSObject, WKURLSchemeHandler {

    /// The staged folder, asked for at each request.
    private let root: () -> URL?

    init(root: @escaping () -> URL?) {
        self.root = root
    }

    struct Reply: Equatable {
        var status: Int
        var headers: [String: String]
        var body: Data
    }

    enum Outcome: Equatable {
        case reply(Reply)
        case refused(String)
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let root = root() else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        switch Self.outcome(for: task.request, root: root) {
        case .refused(let why):
            print("[foxy] web: refused \(task.request.httpMethod ?? "GET") \(task.request.url?.path.prefix(80) ?? "?"): \(why)")
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorNoPermissionsToReadFile))
        case .reply(let reply):
            // Answered whole, here, on the queue WebKit called on: a task is
            // never answered after WebKit has stopped it.
            guard let url = task.request.url,
                  let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                                 headerFields: reply.headers) else {
                task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotParseResponse))
                return
            }
            task.didReceive(response)
            if !reply.body.isEmpty { task.didReceive(reply.body) }
            task.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    // MARK: The rules, apart from WebKit (FoxyTests, tools/nativetests)

    static func outcome(for request: URLRequest, root: URL) -> Outcome {
        guard let url = request.url else { return .refused("no address") }
        let method = (request.httpMethod ?? "GET").uppercased()
        guard method == "GET" else { return .refused("only GET is served") }
        guard WebStore.isOurs(url) else { return .refused("not the page's address") }
        if url.path == WebStore.checkPath {
            return .reply(Reply(status: 200, headers: [
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": String(checkPage.count),
                // the check page runs nothing of its own and loads nothing
                "Content-Security-Policy": "default-src 'none'",
                "Cache-Control": "no-store",
            ], body: checkPage))
        }
        guard let file = file(for: url, root: root) else { return .refused("not a file in the page's folder") }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return .refused("could not be read") }
        var headers = [
            "Content-Type": type(of: file),
            "Accept-Ranges": "bytes",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        ]
        switch range(request.value(forHTTPHeaderField: "Range"), size: data.count) {
        case .whole:
            headers["Content-Length"] = String(data.count)
            return .reply(Reply(status: 200, headers: headers, body: data))
        case .part(let first, let last):
            headers["Content-Range"] = "bytes \(first)-\(last)/\(data.count)"
            headers["Content-Length"] = String(last - first + 1)
            return .reply(Reply(status: 206, headers: headers, body: data.subdata(in: first..<(last + 1))))
        case .unsatisfiable:
            headers["Content-Range"] = "bytes */\(data.count)"
            headers["Content-Length"] = "0"
            return .reply(Reply(status: 416, headers: headers, body: Data()))
        }
    }

    /// The staged file a page address names, or nil. Both sides standardized
    /// and with links resolved, as the navigation check always was: a prefix
    /// of the real folder, never a substring test.
    static func file(for url: URL, root: URL) -> URL? {
        guard WebStore.isOurs(url) else { return nil }
        let path = url.path
        guard path.hasPrefix("/"), path.count > 1, !path.contains("\u{0}"), !path.contains("\\") else { return nil }
        let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        // no "..", no ".", no hidden file (the page hash leaves those out), no empty part
        guard !parts.contains(where: { $0.isEmpty || $0.hasPrefix(".") }) else { return nil }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let target = base.appendingPathComponent(parts.joined(separator: "/")).standardizedFileURL.resolvingSymlinksInPath()
        let prefix = base.path.hasSuffix("/") ? base.path : base.path + "/"
        guard target.path.hasPrefix(prefix) else { return nil }
        var folder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &folder), !folder.boolValue else { return nil }
        return target
    }

    /// What the web view may navigate to: a staged .html file, and the check
    /// page only while a check is under way (`checking`), so nothing can land
    /// the page on a blank one later.
    static func allowsNavigation(to url: URL, root: URL, checking: Bool) -> Bool {
        if WebStore.isCheck(url) { return checking }
        return url.pathExtension.lowercased() == "html" && file(for: url, root: root) != nil
    }

    enum ByteRange: Equatable {
        case whole
        case part(Int, Int)
        case unsatisfiable
    }

    /// One `bytes=` range, which is what the video player asks for; anything
    /// else that is not plainly unsatisfiable gets the whole file.
    static func range(_ header: String?, size: Int) -> ByteRange {
        guard let h = header?.trimmingCharacters(in: .whitespaces).lowercased(), h.hasPrefix("bytes=") else { return .whole }
        let spec = h.dropFirst(6)
        guard !spec.contains(",") else { return .whole }
        let ends = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard ends.count == 2 else { return .whole }
        func number(_ s: String) -> Int? { s.isEmpty || !s.allSatisfy(\.isASCII) || !s.allSatisfy(\.isNumber) ? nil : Int(s) }
        if ends[0].isEmpty {
            guard let n = number(ends[1]) else { return .whole }
            guard n > 0, size > 0 else { return .unsatisfiable }
            return .part(max(0, size - n), size - 1)
        }
        guard let first = number(ends[0]) else { return .whole }
        guard first < size else { return .unsatisfiable }
        if ends[1].isEmpty { return .part(first, size - 1) }
        guard let last = number(ends[1]), last >= first else { return .whole }
        return .part(first, min(last, size - 1))
    }

    static func type(of file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "wasm": return "application/wasm"
        case "mp4": return "video/mp4"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    /// Blank, and the colour of the app behind the splash.
    static let checkPage = Data("<!doctype html><html style=\"background:#050505\"><head><meta charset=\"utf-8\"><title>Foxy</title></head><body></body></html>".utf8)
}

/// The check before the page runs (WebStore): asks the page's store, decides,
/// and carries a store's items in when it must. Runs on the main queue with
/// the check page loaded in the web view.
enum WebStoreCheck {

    enum Result: Equatable {
        /// The page's store is ready: start the page.
        case ready
        /// The phone was locked during the check: nothing was decided; check
        /// again once it is unlocked.
        case locked
        /// The check could not be finished; nothing was recorded.
        case failed(String)
    }

    struct Setup {
        var webKit: URL
        var scratch: URL
        var defaults: UserDefaults
        /// Whether the phone's protected files can be read now (unlocked).
        var unlocked: () -> Bool = { true }

        static func live(unlocked: @escaping () -> Bool) -> Setup? {
            guard let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
            return Setup(webKit: lib.appendingPathComponent("WebKit", isDirectory: true),
                         scratch: FileManager.default.temporaryDirectory.appendingPathComponent("foxy-webstore", isDirectory: true),
                         defaults: .standard, unlocked: unlocked)
        }
    }

    /// Off the main queue: the stores on the phone and this install's state.
    static func scan(_ setup: Setup) -> (WebStore.Scan, WebStore.State) {
        // a copy left by a check that did not finish goes first
        try? FileManager.default.removeItem(at: setup.scratch)
        let state = WebStore.state(setup.defaults)
        let scan = WebStore.scan(webKit: setup.webKit, scratch: setup.scratch, mark: state.mark)
        try? FileManager.default.removeItem(at: setup.scratch)
        return (scan, state)
    }

    /// What a failed check leads to: the message, and whether the page is
    /// started anyway. From `failuresBeforeOpening` failed checks in a row the
    /// page starts on its own store as it is, with nothing recorded, so a
    /// store that can never be read does not lock the person out; every store
    /// is left on the phone as it is, and each launch checks again.
    static func afterFailure(_ failures: Int) -> (open: Bool, message: String) {
        if failures >= WebStore.failuresBeforeOpening {
            return (true, "")
        }
        let again = failures == WebStore.failuresBeforeOpening - 1
            ? " If it happens again, Foxy opens without it, and it stays on this phone as it is."
            : ""
        return (false, "Foxy could not open its stored wallet.\n\nNothing was changed or removed. Close Foxy and open it again." + again)
    }

    static func run(in webView: WKWebView, scan: WebStore.Scan, state: WebStore.State, setup: Setup,
                    log: @escaping (String) -> Void = { print("[foxy] web store: " + $0) },
                    done: @escaping (Result) -> Void) {
        let args = WebStore.arguments(mark: state.mark)
        let money = scan.buckets.filter { $0.tier == 2 }.count
        log("\(scan.buckets.count) store(s) on the phone, \(money) holding money or history"
            + (state.moved ? "" : "; the move to \(WebStore.origin) is not settled yet"))
        for why in scan.unread { log("COULD NOT READ a store: \(why)") }
        if !state.moved {
            log(scan.fileStores.isEmpty ? "no salt read: the store the page used at file:// is not known"
                                        : "the page used " + scan.fileStores.map(WebStore.short).sorted().joined(separator: ", ") + " at file://")
        }

        webView.callAsyncJavaScript(WebStore.checkScript, arguments: args, in: nil, in: .page) { answer in
            // a store read while the phone locked may look empty: nothing is decided then
            guard setup.unlocked() else { log("the phone was locked during the check; it is made again after the unlock"); done(.locked); return }
            guard case .success(let value) = answer, let found = value as? [String: Any],
                  let marked = found["marked"] as? Bool, let keys = (found["keys"] as? NSNumber)?.intValue else {
                done(.failed("the page's store could not be asked"))
                return
            }
            let copying = found["copying"] as? Bool ?? false
            if copying { log("the page's store holds a copy that was cut off part way; it is made again") }
            switch WebStore.decide(WebStore.Probe(marked: marked, keys: keys, copying: copying), scan: scan, state: state) {
            case .wait(let why):
                log("NOTHING DECIDED: \(why); the page is not started on an empty store")
                done(.failed("a stored wallet could not be read"))
            case .keep(let why, let mark, let settle):
                log(why)
                for other in WebStore.changedSince(scan, state: state) {
                    log("ANOTHER STORE CHANGED SINCE THE LAST LAUNCH and holds money or history; it is left as it is: \(WebStore.describe(other))")
                }
                if settle {
                    if let pending = state.pending { log("the copy from \(WebStore.short(pending)) is on disk: that store is taken") }
                    WebStore.noteSettled(setup.defaults)
                    done(.ready)
                    return
                }
                guard mark else { WebStore.noteChecked(setup.defaults); done(.ready); return }
                // settled at the next launch, once the mark is seen there
                webView.callAsyncJavaScript(WebStore.markScript, arguments: args, in: nil, in: .page) { marked in
                    if case .success(let ok) = marked, (ok as? Bool) == true {} else {
                        log("the mark could not be written; the store is checked again next launch")
                    }
                    WebStore.noteChecked(setup.defaults)
                    done(.ready)
                }
            case .copy(let pick, let others, let why):
                DispatchQueue.global(qos: .userInitiated).async {
                    let read = Swift.Result { try WebStore.items(of: pick.file, scratch: setup.scratch) }
                    try? FileManager.default.removeItem(at: setup.scratch)
                    DispatchQueue.main.async {
                        guard setup.unlocked() else { log("the phone was locked during the check; it is made again after the unlock"); done(.locked); return }
                        guard case .success(let got) = read else {
                            log("COULD NOT READ \(WebStore.describe(pick)): nothing was copied")
                            done(.failed("the stored wallet could not be read"))
                            return
                        }
                        var copyArgs = args
                        copyArgs["items"] = got.items
                        webView.callAsyncJavaScript(WebStore.copyScript, arguments: copyArgs, in: nil, in: .page) { copied in
                            guard case .success(let value) = copied, let r = value as? [String: Any] else {
                                log("the copy did not answer; nothing is taken as copied")
                                done(.failed("the stored wallet could not be copied"))
                                return
                            }
                            if let skipped = r["skipped"] as? String {
                                log("nothing copied: the page's store changed under the check (\(skipped))")
                                WebStore.noteChecked(setup.defaults)
                                done(.ready)
                                return
                            }
                            guard let n = (r["copied"] as? NSNumber)?.intValue else {
                                log("THE COPY FAILED and was taken back: \(r["error"] as? String ?? "?")")
                                done(.failed("the stored wallet could not be copied"))
                                return
                            }
                            // taken once a later launch sees the copy, marked, on disk
                            WebStore.notePending(pick.path, setup.defaults)
                            WebStore.noteChecked(setup.defaults)
                            log("took \(n) items into \(WebStore.origin) from \(WebStore.describe(pick)): \(why)")
                            if got.repaired > 0 {
                                log("\(got.repaired) item(s) held text that could not be carried exactly (a lone surrogate)")
                            }
                            let changed = WebStore.changedSince(scan, state: state).filter { c in c.path != pick.path && !others.contains { $0.path == c.path } }
                            for other in others + changed {
                                log("ANOTHER STORE HOLDS MONEY OR HISTORY and was left as it is: \(WebStore.describe(other))")
                            }
                            done(.ready)
                        }
                    }
                }
            }
        }
    }
}
