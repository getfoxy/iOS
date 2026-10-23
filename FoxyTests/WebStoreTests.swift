import XCTest
import WebKit
import SQLite3
#if canImport(FoxyWebStore)
@testable import FoxyWebStore
#else
@testable import Foxy
#endif

/// The page's fixed address and the check that carries a stored wallet to it
/// (Foxy/WebStore). Runs in FoxyTests and in tools/nativetests, where the two
/// files are their own module, FoxyWebStore, and the web views are a Mac's:
/// nothing they load leaves the scheme handler.
final class WebStoreTests: XCTestCase {

    private var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("webstore-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    // MARK: Fixtures: stores laid out and written the way WebKit writes them

    enum Stored {
        case utf16(String)   // a blob of UTF-16LE code units: what WebKit writes
        case text(String)    // a TEXT value
    }

    /// A localstorage database with WebKit's table. With `keepOpen`, the
    /// connection is returned open in WAL mode, so the items are still only in
    /// the -wal file beside a near-empty database, as a running WebKit leaves it.
    @discardableResult
    private func makeStore(_ file: URL, _ items: [(String, Stored)], keepOpen: Bool = false) throws -> OpaquePointer? {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK)
        if keepOpen {
            XCTAssertEqual(sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;", nil, nil, nil), SQLITE_OK)
        }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);", nil, nil, nil), SQLITE_OK)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (key, value) in items {
            var st: OpaquePointer?
            XCTAssertEqual(sqlite3_prepare_v2(db, "INSERT INTO ItemTable (key, value) VALUES (?, ?)", -1, &st, nil), SQLITE_OK)
            sqlite3_bind_text(st, 1, key, -1, transient)
            switch value {
            case .utf16(let s):
                var bytes: [UInt8] = []
                for u in s.utf16 { bytes.append(UInt8(u & 0xff)); bytes.append(UInt8(u >> 8)) }
                sqlite3_bind_blob(st, 2, bytes, Int32(bytes.count), transient)
            case .text(let s):
                sqlite3_bind_text(st, 2, s, -1, transient)
            }
            XCTAssertEqual(sqlite3_step(st), SQLITE_DONE)
            sqlite3_finalize(st)
        }
        if keepOpen { return db }
        sqlite3_close(db)
        return nil
    }

    /// WebKit's `origin` file: scheme and host as length-prefixed strings, twice.
    private func originFile(_ scheme: String, _ host: String) -> Data {
        var d = Data()
        for _ in 0..<2 {
            for part in [scheme, host] {
                var n = UInt32(part.utf8.count).littleEndian
                d.append(Data(bytes: &n, count: 4))
                d.append(1)
                d.append(Data(part.utf8))
            }
            d.append(0)
        }
        return d
    }

    /// A store in the iOS 17+ layout: Default/<a>/<b>/LocalStorage/localstorage.sqlite3.
    @discardableResult
    private func bucket(_ root: URL, _ name: String, origin: (String, String), _ items: [(String, Stored)],
                        modified: Date? = nil, keepOpen: Bool = false) throws -> (URL, OpaquePointer?) {
        let folder = root.appendingPathComponent("WebsiteData/Default/\(name)/\(name)", isDirectory: true)
        let file = folder.appendingPathComponent("LocalStorage/localstorage.sqlite3")
        let db = try makeStore(file, items, keepOpen: keepOpen)
        try originFile(origin.0, origin.1).write(to: folder.appendingPathComponent("origin"))
        if let modified {
            try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: file.path)
        }
        return (file, db)
    }

    /// Roughly what a used wallet holds: piles, history, settings.
    private func wallet(piles: Int, extra: Int = 0) -> [(String, Stored)] {
        var items: [(String, Stored)] = [
            ("foxy.schema", .utf16("2")),
            ("foxy.cashu.mint", .utf16("https://mint.example")),
            ("foxy.cashu.log", .utf16("[{\"t\":1,\"sats\":21,\"note\":\"h\u{e9}llo \u{1F98A}\"}]")),
            ("foxy.backed.up", .text("1")),
            ("foxy.cashu.quotes", .utf16("[]")),
        ]
        for i in 0..<piles { items.append(("foxy.cashu.proofs.https://m\(i).example", .utf16("[{\"amount\":\(i + 1)}]"))) }
        for i in 0..<extra { items.append(("foxy.setting.\(i)", .utf16("on"))) }
        return items
    }

    private func scan(_ root: URL, mark: String = String(repeating: "a", count: 32)) -> WebStore.Scan {
        WebStore.scan(webKit: root, scratch: temp.appendingPathComponent("scratch"), mark: mark)
    }

    // MARK: Reading a store

    func testBothValueEncodingsAreReadExactly() throws {
        let file = temp.appendingPathComponent("LocalStorage/localstorage.sqlite3")
        try makeStore(file, [
            ("blob", .utf16("h\u{e9}llo \u{1F98A} {\"a\":[1,2]}")),
            ("text", .text("plain \u{e9}")),
            ("empty", .utf16("")),
            ("long", .utf16(String(repeating: "x", count: 100_000))),
        ])
        let read = try WebStore.items(of: file, scratch: temp.appendingPathComponent("s"))
        let got = Dictionary(uniqueKeysWithValues: read.items.map { ($0[0], $0[1]) })
        XCTAssertEqual(got["blob"], "h\u{e9}llo \u{1F98A} {\"a\":[1,2]}")
        XCTAssertEqual(got["text"], "plain \u{e9}")
        XCTAssertEqual(got["empty"], "")
        XCTAssertEqual(got["long"]?.count, 100_000)
        XCTAssertEqual(read.repaired, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: temp.appendingPathComponent("s").path + "/x"),
                       "the copy it read from is gone")
    }

    func testTheWalletsKeysAreCountedAsThePageCountsThem() throws {
        let file = temp.appendingPathComponent("LocalStorage/localstorage.sqlite3")
        let mark = String(repeating: "b", count: 32)
        try makeStore(file, [
            ("foxy.schema", .utf16("2")),                      // every launch writes it: not the wallet
            ("foxy.seed.v1.toPhone", .utf16("{\"at\":1}")),   // a one-time move's record
            ("foxy.cashu.quotes", .utf16("[]")),               // empty
            ("foxy.price.last", .utf16("0")),                  // empty
            ("flash.cashu.proofs", .utf16("[{\"amount\":1}]")), // the old name of the pile
            ("foxy.cashu.proofs.https://a.example", .text("[{\"amount\":2}]")),
            ("other", .utf16("x")),                             // not the wallet's
            (WebStore.markKey, .utf16(mark)),
        ])
        let c = try WebStore.summary(of: file, scratch: temp.appendingPathComponent("s"), mark: mark)
        XCTAssertEqual(c, WebStore.Contents(items: 8, keys: 2, money: true, piles: 2, marked: true))
        let other = try WebStore.summary(of: file, scratch: temp.appendingPathComponent("s"), mark: String(repeating: "c", count: 32))
        XCTAssertFalse(other.marked, "another install's mark is not this one's")
    }

    func testEveryStoreIsFoundAndReadFromACopyEvenWhenItsItemsAreOnlyInTheLog() throws {
        let root = temp.appendingPathComponent("WebKit")
        let (liveFile, live) = try bucket(root, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", origin: ("file", ""),
                                          wallet(piles: 3), keepOpen: true)
        defer { sqlite3_close(live) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: liveFile.path + "-wal"), "the fixture keeps its items in the log")
        try bucket(root, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", origin: ("foxy-app", "wallet"), [])
        // the layout before iOS 17
        try makeStore(root.appendingPathComponent("WebsiteData/LocalStorage/file__0.localstorage"), wallet(piles: 1))

        func listing() -> [String: Int] {
            var out: [String: Int] = [:]
            for case let url as URL in FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)! {
                out[url.path] = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
            }
            return out
        }
        let before = listing()
        let found = scan(root)
        XCTAssertEqual(listing(), before, "nothing is written beside WebKit's own files")
        XCTAssertEqual(found.unread, [])
        XCTAssertEqual(found.buckets.map(\.path), [
            "WebsiteData/Default/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "WebsiteData/Default/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "WebsiteData/LocalStorage/file__0.localstorage",
        ])
        XCTAssertEqual(found.buckets.map(\.origin), ["file", "foxy-app://wallet", "file"])
        XCTAssertEqual(found.buckets[0].contents.piles, 3, "the items only in the -wal are read")
        XCTAssertEqual(found.buckets[0].contents.keys, 6, "mint, history, backed-up and three piles; not the schema or the empty quotes")
        XCTAssertEqual(found.buckets[1].tier, 0)
        XCTAssertEqual(found.buckets[2].tier, 2)
    }

    // MARK: The decision

    private let mark = String(repeating: "d", count: 32)

    private func fake(_ path: String, keys: Int, money: Bool = true, marked: Bool = false, age: TimeInterval = 0,
                      bytes: Int = 1000) -> WebStore.Bucket {
        WebStore.Bucket(path: path, file: URL(fileURLWithPath: "/x/" + path), origin: "file",
                        modified: Date(timeIntervalSince1970: 1_800_000_000 - age), bytes: bytes,
                        contents: WebStore.Contents(items: keys, keys: keys, money: money, piles: money ? 1 : 0, marked: marked))
    }

    private func state(moved: Bool, taken: Set<String> = []) -> WebStore.State {
        WebStore.State(moved: moved, taken: taken, mark: mark)
    }

    func testAFreshInstallKeepsItsEmptyStoreAndMarksIt() {
        let d = WebStore.decide(.init(marked: false, keys: 0), scan: .init(), state: state(moved: false))
        guard case .keep(_, let markIt, _) = d else { return XCTFail("\(d)") }
        XCTAssertTrue(markIt)
    }

    func testAnEmptyNewStoreBesideAFullOldOneTakesTheFullOne() {
        // the 4 KB store the page opened after the install, with a restore's
        // few proofs in it and newer, beside the 57-key wallet it lost
        let full = fake("Default/old/old", keys: 57, age: 3600, bytes: 8_400_000)
        let thin = fake("Default/new/new", keys: 4, age: 60, bytes: 4096)
        let empty = fake("Default/empty/empty", keys: 0, money: false)
        let d = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [thin, empty, full]), state: state(moved: false))
        guard case .copy(let pick, let others, _) = d else { return XCTFail("\(d)") }
        XCTAssertEqual(pick.path, full.path, "the fullest, not the newest")
        XCTAssertEqual(others.map(\.path), [thin.path], "the other wallet is named in the log, never merged")
    }

    func testBetweenTwoEquallyFullStoresTheNewestWins() {
        let older = fake("Default/a/a", keys: 30, age: 7200)
        let newer = fake("Default/b/b", keys: 30, age: 10)
        let d = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [older, newer]), state: state(moved: false))
        guard case .copy(let pick, _, _) = d else { return XCTFail("\(d)") }
        XCTAssertEqual(pick.path, newer.path)
    }

    func testOnceMovedAnErasedWalletIsNeverRefilledFromTheOldFileStores() {
        let oldFile = fake("Default/file/file", keys: 57)
        let d = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [oldFile]), state: state(moved: true))
        guard case .keep(_, let markIt, _) = d else { return XCTFail("an unmarked store was taken after the move: \(d)") }
        XCTAssertTrue(markIt)
        // and the page's own store, marked and emptied by the wallet's erase, is left empty
        let erased = WebStore.decide(.init(marked: true, keys: 0), scan: .init(buckets: [oldFile]), state: state(moved: false))
        guard case .keep(_, let again, let settle) = erased else { return XCTFail("\(erased)") }
        XCTAssertFalse(again)
        XCTAssertTrue(settle, "a store found carrying the mark is what settles the move")
    }

    func testAReKeyedStoreAfterTheMoveIsCarriedFromTheMarkedOne() {
        let before = fake("Default/x/y", keys: 57, marked: true)
        let oldFile = fake("Default/file/file", keys: 57, age: 99999)
        let d = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [oldFile, before]), state: state(moved: true))
        guard case .copy(let pick, _, _) = d else { return XCTFail("\(d)") }
        XCTAssertEqual(pick.path, before.path)
        // never the same store twice
        let twice = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [before]),
                                    state: state(moved: true, taken: [before.path]))
        guard case .keep = twice else { return XCTFail("a store was taken twice: \(twice)") }
        // the old file:// store and one taken before are not named as left behind: only one it could have taken
        let taken = fake("Default/t/t", keys: 40, marked: true)
        let rival = fake("Default/r/r", keys: 20, marked: true)
        let named = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [oldFile, before, taken, rival]),
                                    state: state(moved: true, taken: [taken.path]))
        guard case .copy(let p, let others, _) = named else { return XCTFail("\(named)") }
        XCTAssertEqual(p.path, before.path)
        XCTAssertEqual(others.map(\.path), [rival.path])
    }

    func testAStoreThatHoldsTheWalletIsKept() {
        let other = fake("Default/a/a", keys: 99)
        let d = WebStore.decide(.init(marked: false, keys: 3, money: true), scan: .init(buckets: [other]), state: state(moved: false))
        guard case .keep(_, let markIt, _) = d else { return XCTFail("\(d)") }
        XCTAssertTrue(markIt, "never copied over a store that holds money or history")
    }

    func testTheOriginFileIsReadForTheLog() {
        XCTAssertEqual(WebStore.originLabel(originFile("file", "")), "file")
        XCTAssertEqual(WebStore.originLabel(originFile("foxy-app", "wallet")), "foxy-app://wallet")
        XCTAssertEqual(WebStore.originLabel(Data()), "?")
        XCTAssertEqual(WebStore.legacyOrigin(URL(fileURLWithPath: "/a/file__0.localstorage")), "file")
    }

    // MARK: The scheme handler

    private func webRoot() throws -> URL {
        let root = temp.appendingPathComponent("Caches/web", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("img"), withIntermediateDirectories: true)
        try Data("<!doctype html><title>t</title>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data("window.ran = 1;".utf8).write(to: root.appendingPathComponent("app.js"))
        try Data((0..<100).map { UInt8($0) }).write(to: root.appendingPathComponent("img/a.png"))
        try Data("hidden".utf8).write(to: root.appendingPathComponent(".hidden.html"))
        // beside the folder, and a link out of it
        try Data("secret".utf8).write(to: temp.appendingPathComponent("Caches/outside.html"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.html"),
                                                   withDestinationURL: temp.appendingPathComponent("Caches/outside.html"))
        return root
    }

    private func get(_ address: String, method: String = "GET", range: String? = nil, root: URL) -> WebSchemeHandler.Outcome {
        var r = URLRequest(url: URL(string: address)!)
        r.httpMethod = method
        if let range { r.setValue(range, forHTTPHeaderField: "Range") }
        return WebSchemeHandler.outcome(for: r, root: root)
    }

    func testOnlyFilesInsideTheStagedFolderAreServedAndOnlyToGET() throws {
        let root = try webRoot()
        guard case .reply(let page) = get("foxy-app://wallet/index.html", root: root) else { return XCTFail() }
        XCTAssertEqual(page.status, 200)
        XCTAssertEqual(page.headers["Content-Type"], "text/html; charset=utf-8")
        XCTAssertEqual(String(decoding: page.body, as: UTF8.self), "<!doctype html><title>t</title>")
        guard case .reply(let js) = get("foxy-app://wallet/app.js", root: root) else { return XCTFail() }
        XCTAssertEqual(js.headers["Content-Type"], "text/javascript; charset=utf-8")
        XCTAssertEqual(js.headers["X-Content-Type-Options"], "nosniff")
        guard case .reply = get("foxy-app://wallet/img/a.png", root: root) else { return XCTFail("a subfolder's file") }

        for refused in [
            "foxy-app://wallet/../outside.html",
            "foxy-app://wallet/%2e%2e/outside.html",
            "foxy-app://wallet/img/..%2f..%2foutside.html",
            "foxy-app://wallet/img/%2e%2e/%2e%2e/outside.html",
            "foxy-app://wallet/link.html",           // a link out of the folder
            "foxy-app://wallet/.hidden.html",        // the page hash leaves dot-files out
            "foxy-app://wallet/img",                  // a folder
            "foxy-app://wallet/img/",
            "foxy-app://wallet/",
            "foxy-app://wallet/missing.js",
            "foxy-app://wallet:8080/index.html",
            "foxy-app://user@wallet/index.html",
            "foxy-app://other/index.html",
            "file:///index.html",
            "https://wallet/index.html",
        ] {
            guard case .refused = get(refused, root: root) else { return XCTFail("served: \(refused)") }
        }
        for method in ["POST", "PUT", "HEAD", "DELETE", "OPTIONS"] {
            guard case .refused = get("foxy-app://wallet/index.html", method: method, root: root) else {
                return XCTFail("\(method) was served")
            }
        }
    }

    func testTheHandlerAnswersAWebKitTaskAndFailsARefusedOne() throws {
        let root = try webRoot()
        let handler = WebSchemeHandler(root: { root })
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let served = FakeTask(URLRequest(url: URL(string: "foxy-app://wallet/app.js")!))
        handler.webView(webView, start: served)
        XCTAssertEqual(served.status, 200)
        XCTAssertEqual(served.body, Data("window.ran = 1;".utf8))
        XCTAssertTrue(served.finished)
        var post = URLRequest(url: URL(string: "foxy-app://wallet/index.html")!)
        post.httpMethod = "POST"
        let refused = FakeTask(post)
        handler.webView(webView, start: refused)
        XCTAssertNotNil(refused.error)
        XCTAssertNil(refused.status, "a refused request gets no response at all")
        let above = FakeTask(URLRequest(url: URL(string: "foxy-app://wallet/%2e%2e/outside.html")!))
        handler.webView(webView, start: above)
        XCTAssertNotNil(above.error)
        XCTAssertTrue(above.body.isEmpty)
    }

    func testRangesForTheVideo() throws {
        let root = try webRoot()
        guard case .reply(let part) = get("foxy-app://wallet/img/a.png", range: "bytes=10-19", root: root) else { return XCTFail() }
        XCTAssertEqual(part.status, 206)
        XCTAssertEqual(part.headers["Content-Range"], "bytes 10-19/100")
        XCTAssertEqual(part.body, Data((10..<20).map { UInt8($0) }))
        XCTAssertEqual(WebSchemeHandler.range("bytes=0-1", size: 100), .part(0, 1))
        XCTAssertEqual(WebSchemeHandler.range("bytes=90-", size: 100), .part(90, 99))
        XCTAssertEqual(WebSchemeHandler.range("bytes=-10", size: 100), .part(90, 99))
        XCTAssertEqual(WebSchemeHandler.range("bytes=50-500", size: 100), .part(50, 99))
        XCTAssertEqual(WebSchemeHandler.range("bytes=100-", size: 100), .unsatisfiable)
        XCTAssertEqual(WebSchemeHandler.range("bytes=0-1,5-6", size: 100), .whole)
        XCTAssertEqual(WebSchemeHandler.range("bytes=5-1", size: 100), .whole)
        XCTAssertEqual(WebSchemeHandler.range("bytes=+5-", size: 100), .whole)
        XCTAssertEqual(WebSchemeHandler.range(nil, size: 100), .whole)
        guard case .reply(let none) = get("foxy-app://wallet/img/a.png", range: "bytes=200-", root: root) else { return XCTFail() }
        XCTAssertEqual(none.status, 416)
    }

    func testNavigationReachesOnlyTheCheckPageAndStagedPages() throws {
        let root = try webRoot()
        XCTAssertTrue(WebSchemeHandler.allowsNavigation(to: WebStore.indexURL, root: root, checking: false))
        XCTAssertTrue(WebSchemeHandler.allowsNavigation(to: WebStore.checkURL, root: root, checking: true))
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: WebStore.checkURL, root: root, checking: false),
                       "the blank check page only while a check is under way")
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: URL(string: "foxy-app://wallet/app.js")!, root: root, checking: true))
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: URL(string: "foxy-app://wallet/link.html")!, root: root, checking: true))
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: URL(string: "foxy-app://wallet/../outside.html")!, root: root, checking: true))
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: root.appendingPathComponent("index.html"), root: root, checking: true),
                       "the staged file's own file URL is not the page any more")
        XCTAssertFalse(WebSchemeHandler.allowsNavigation(to: URL(string: "https://example.com/index.html")!, root: root, checking: true))
    }

    // MARK: A real web view (on the Mac, no network: everything is answered by the handler)

    private final class Waiter: NSObject, WKNavigationDelegate {
        var finished: (() -> Void)?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished?() }
    }

    private func webView(root: URL) -> (WKWebView, Waiter, WebSchemeHandler) {
        let handler = WebSchemeHandler(root: { root })
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(handler, forURLScheme: WebStore.scheme)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 100, height: 100), configuration: config)
        let waiter = Waiter()
        view.navigationDelegate = waiter
        return (view, waiter, handler)
    }

    private func load(_ view: WKWebView, _ waiter: Waiter, _ url: URL) {
        let done = expectation(description: "loaded \(url)")
        waiter.finished = { waiter.finished = nil; done.fulfill() }
        view.load(URLRequest(url: url))
        wait(for: [done], timeout: 20)
    }

    private func js(_ view: WKWebView, _ body: String, _ args: [String: Any] = [:]) -> Any? {
        let done = expectation(description: "script")
        var out: Any?
        view.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { result in
            if case .success(let v) = result { out = v } else { XCTFail("\(result)") }
            done.fulfill()
        }
        wait(for: [done], timeout: 20)
        return out
    }

    func testThePagesOriginIsTheFixedSchemeAndItsPolicyStillLetsItsOwnScriptsRun() throws {
        let root = try webRoot()
        // the page's own policy, as build/shell/head.html writes it
        let head = try String(contentsOf: repoRoot().appendingPathComponent("build/shell/head.html"), encoding: .utf8)
        let policy = try XCTUnwrap(head.range(of: #"<meta http-equiv="Content-Security-Policy"[^>]*>"#, options: .regularExpression))
        try Data(("<!doctype html><html><head>" + head[policy] + "<script src=\"app.js\"></script></head><body></body></html>").utf8)
            .write(to: root.appendingPathComponent("index.html"))
        let (view, waiter, _) = webView(root: root)
        load(view, waiter, WebStore.indexURL)
        let seen = js(view, """
            localStorage.setItem('k', 'v');
            return { origin: location.origin, own: window.origin, secure: window.isSecureContext,
                     ran: window.ran === 1, stored: localStorage.getItem('k'), subtle: typeof crypto.subtle };
            """) as? [String: Any]
        XCTAssertEqual(seen?["origin"] as? String, WebStore.origin)
        XCTAssertEqual(seen?["own"] as? String, "foxy-app://wallet")
        XCTAssertEqual(seen?["secure"] as? Bool, true, "a secure context, as file:// was: clipboard and WebCrypto need it")
        XCTAssertEqual(seen?["ran"] as? Bool, true, "'self' in the page's policy covers the handler's files")
        XCTAssertEqual(seen?["stored"] as? String, "v")
        XCTAssertEqual(seen?["subtle"] as? String, "object")
    }

    func testTheCheckCarriesTheFullestStoredWalletInOnceAndThenKeepsIt() throws {
        let root = try webRoot()
        let webKit = temp.appendingPathComponent("WebKit")
        let items = wallet(piles: 5, extra: 40) + [("other.key", .text("kept as it was"))]
        try bucket(webKit, "OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO", origin: ("file", ""), items,
                   modified: Date(timeIntervalSinceNow: -3600))
        try bucket(webKit, "NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWN", origin: ("file", ""),
                   [("foxy.schema", .utf16("2"))])
        let suite = "webstore-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let setup = WebStoreCheck.Setup(webKit: webKit, scratch: temp.appendingPathComponent("scratch"), defaults: defaults)
        let (view, waiter, _) = webView(root: root)

        func check() -> (WebStoreCheck.Result, [String]) {
            load(view, waiter, WebStore.checkURL)
            let (scan, state) = WebStoreCheck.scan(setup)
            var lines: [String] = []
            var result: WebStoreCheck.Result?
            let done = expectation(description: "check")
            WebStoreCheck.run(in: view, scan: scan, state: state, setup: setup, log: { lines.append($0) }) {
                result = $0
                done.fulfill()
            }
            wait(for: [done], timeout: 30)
            return (result ?? .failed("no answer"), lines)
        }

        let (first, said) = check()
        XCTAssertEqual(first, .ready)
        XCTAssertTrue(said.contains { $0.hasPrefix("took \(items.count) items into foxy-app://wallet from WebsiteData/Default/OLDOLDOL…") },
                      said.joined(separator: "\n"))
        let stored = js(view, "var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o;") as? [String: String]
        for (key, value) in items {
            switch value {
            case .utf16(let s), .text(let s): XCTAssertEqual(stored?[key], s, key)
            }
        }
        XCTAssertEqual(stored?[WebStore.markKey], WebStore.state(defaults).mark)
        // nothing settled yet: WebKit writes the copy to disk later, in another process
        XCTAssertFalse(defaults.bool(forKey: WebStore.movedKey))
        XCTAssertNil(defaults.stringArray(forKey: WebStore.takenKey))
        XCTAssertEqual(defaults.string(forKey: WebStore.pendingKey), "WebsiteData/Default/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO")

        // the app ended before the copy reached the disk: the next launch finds the store empty and copies again
        _ = js(view, "localStorage.clear(); return true;")
        let (lost, redoLost) = check()
        XCTAssertEqual(lost, .ready)
        XCTAssertTrue(redoLost.contains { $0.hasPrefix("took \(items.count) items") }, redoLost.joined(separator: "\n"))

        // the next launch finds its own store, copies nothing, and only now records the move and the store taken
        let (second, again) = check()
        XCTAssertEqual(second, .ready)
        XCTAssertFalse(again.contains { $0.hasPrefix("took") }, again.joined(separator: "\n"))
        XCTAssertTrue(again.contains { $0.contains("this install's own") }, again.joined(separator: "\n"))
        XCTAssertTrue(defaults.bool(forKey: WebStore.movedKey))
        XCTAssertEqual(defaults.stringArray(forKey: WebStore.takenKey), ["WebsiteData/Default/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO"])
        XCTAssertNil(defaults.string(forKey: WebStore.pendingKey))

        // a copy cut off part way (the app ended mid-copy) is cleared and made again, never kept
        _ = js(view, "localStorage.clear(); localStorage.setItem('foxy.cashu.log', '[\"part\"]'); localStorage.setItem(markKey, 'copying:' + mark); return true;",
               ["markKey": WebStore.markKey, "mark": WebStore.state(defaults).mark])
        // as the first launch's copy left it: nothing recorded as taken, the move not settled
        defaults.set([String](), forKey: WebStore.takenKey)
        defaults.set(false, forKey: WebStore.movedKey)
        let (cut, redo) = check()
        XCTAssertEqual(cut, .ready)
        XCTAssertTrue(redo.contains { $0.contains("cut off part way") }, redo.joined(separator: "\n"))
        XCTAssertTrue(redo.contains { $0.hasPrefix("took \(items.count) items") }, redo.joined(separator: "\n"))
        let redone = js(view, "return [localStorage.getItem('foxy.cashu.log'), localStorage.getItem(markKey)];",
                        ["markKey": WebStore.markKey]) as? [String]
        XCTAssertEqual(redone?.first, "[{\"t\":1,\"sats\":21,\"note\":\"h\u{e9}llo \u{1F98A}\"}]")
        XCTAssertEqual(redone?.last, WebStore.state(defaults).mark)

        // the wallet's erase (every foxy. key) does not bring it back
        _ = js(view, "var g = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf('foxy.') === 0) g.push(k); } g.forEach(function (k) { localStorage.removeItem(k); }); return g.length;")
        let (third, after) = check()
        XCTAssertEqual(third, .ready)
        XCTAssertFalse(after.contains { $0.hasPrefix("took") }, after.joined(separator: "\n"))
    }

    func testACopyThatCannotBeReadBackLeavesTheStoreAsItWas() throws {
        let root = try webRoot()
        let (view, waiter, _) = webView(root: root)
        load(view, waiter, WebStore.checkURL)
        var args = WebStore.arguments(mark: mark)
        // two items under one key: the second read-back differs, and everything set is taken back
        args["items"] = [["foxy.cashu.log", "[1]"], ["foxy.cashu.log", "[2]"], ["foxy.a", "x"]]
        let answer = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertNotNil(answer?["error"])
        let left = js(view, "return localStorage.length;") as? NSNumber
        XCTAssertEqual(left?.intValue, 0)
    }

    func testTheCheckTellsSettingsFromMoneyAndACopyWritesOverSettingsAndPutsThemBackOnFailure() throws {
        let root = try webRoot()
        let (view, waiter, _) = webView(root: root)
        load(view, waiter, WebStore.checkURL)
        var args = WebStore.arguments(mark: mark)
        _ = js(view, "localStorage.clear(); localStorage.setItem('foxy.intro.seen', '1'); return true;")
        var probe = js(view, WebStore.checkScript, args) as? [String: Any]
        XCTAssertEqual((probe?["keys"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual(probe?["money"] as? Bool, false, "a setting is not money or history")
        // a copy that fails puts the setting back as it was
        args["items"] = [["foxy.intro.seen", "2"], ["foxy.cashu.log", "[1]"], ["foxy.cashu.log", "[2]"]]
        let failed = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertNotNil(failed?["error"])
        XCTAssertEqual(js(view, "return [localStorage.length, localStorage.getItem('foxy.intro.seen')];") as? [AnyHashable], [1, "1"])
        // one that works writes over it
        args["items"] = [["foxy.intro.seen", "2"], ["foxy.cashu.log", "[1]"]]
        let copied = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertEqual((copied?["copied"] as? NSNumber)?.intValue, 2, "\(String(describing: copied))")
        probe = js(view, WebStore.checkScript, WebStore.arguments(mark: mark)) as? [String: Any]
        XCTAssertEqual(probe?["marked"] as? Bool, true)
        XCTAssertEqual(probe?["money"] as? Bool, true)
        // and never over money or history
        _ = js(view, "localStorage.clear(); localStorage.setItem('foxy.cashu.proofs.https://m.example', '[{}]'); return true;")
        let held = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertEqual(held?["skipped"] as? String, "holds")
    }

    // MARK: The review's cases

    func testAStoreThatCouldNotBeReadStopsTheCheckInsteadOfCountingAsNone() {
        let unread = WebStore.Scan(buckets: [], unread: ["Default/x/x: could not open"])
        for moved in [false, true] {
            let d = WebStore.decide(.init(marked: false, keys: 0), scan: unread, state: state(moved: moved))
            guard case .wait = d else { return XCTFail("an empty store was settled beside one that could not be read: \(d)") }
        }
        // a store that is the page's own, or holds the wallet, is still kept: nothing is taken then
        guard case .keep = WebStore.decide(.init(marked: true, keys: 0), scan: unread, state: state(moved: true)) else { return XCTFail() }
        guard case .keep = WebStore.decide(.init(marked: false, keys: 4, money: true), scan: unread, state: state(moved: false)) else { return XCTFail() }
        // one that holds settings alone is not: it waits, as an empty one does
        guard case .wait = WebStore.decide(.init(marked: false, keys: 1), scan: unread, state: state(moved: false)) else { return XCTFail() }
    }

    func testADamagedStoreIsUnreadAndAStoreWithNoTableIsEmpty() throws {
        let root = temp.appendingPathComponent("WebKit")
        let damaged = root.appendingPathComponent("WebsiteData/Default/DDDD/DDDD/LocalStorage/localstorage.sqlite3")
        try FileManager.default.createDirectory(at: damaged.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0x5a, count: 8192).write(to: damaged)
        let bare = root.appendingPathComponent("WebsiteData/Default/EEEE/EEEE/LocalStorage/localstorage.sqlite3")
        try FileManager.default.createDirectory(at: bare.deletingLastPathComponent(), withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(bare.path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE other (a);", nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)
        let found = scan(root)
        XCTAssertEqual(found.unread.count, 1, "\(found.unread)")
        XCTAssertTrue(found.unread.first?.hasPrefix("WebsiteData/Default/DDDD/DDDD") == true)
        XCTAssertEqual(found.buckets.map(\.path), ["WebsiteData/Default/EEEE/EEEE"])
        XCTAssertEqual(found.buckets.first?.tier, 0)
    }

    func testTheCheckStopsWithNothingRecordedWhenAStoreCannotBeRead() throws {
        let root = try webRoot()
        let webKit = temp.appendingPathComponent("WebKit")
        let damaged = webKit.appendingPathComponent("WebsiteData/Default/DDDD/DDDD/LocalStorage/localstorage.sqlite3")
        try FileManager.default.createDirectory(at: damaged.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0x5a, count: 8192).write(to: damaged)
        let (defaults, suite) = try freshDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let setup = WebStoreCheck.Setup(webKit: webKit, scratch: temp.appendingPathComponent("scratch"), defaults: defaults)
        let (view, waiter, _) = webView(root: root)
        let (result, said) = check(view, waiter, setup)
        XCTAssertEqual(result, .failed("a stored wallet could not be read"))
        XCTAssertTrue(said.contains { $0.hasPrefix("NOTHING DECIDED") }, said.joined(separator: "\n"))
        XCTAssertFalse(said.contains { $0.contains("fresh install") }, said.joined(separator: "\n"))
        XCTAssertFalse(defaults.bool(forKey: WebStore.movedKey))
        XCTAssertNil(defaults.object(forKey: WebStore.lastCheckKey))
        XCTAssertEqual(js(view, "return localStorage.getItem(k) === null;", ["k": WebStore.markKey]) as? Bool, true,
                       "the empty store is not marked")
    }

    func testThePhoneLockingDuringTheCheckDecidesNothing() throws {
        let root = try webRoot()
        let webKit = temp.appendingPathComponent("WebKit")
        try bucket(webKit, "OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO", origin: ("file", ""), wallet(piles: 2))
        let (defaults, suite) = try freshDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        var setup = WebStoreCheck.Setup(webKit: webKit, scratch: temp.appendingPathComponent("scratch"), defaults: defaults)
        setup.unlocked = { false }
        let (view, waiter, _) = webView(root: root)
        let (result, _) = check(view, waiter, setup)
        XCTAssertEqual(result, .locked)
        XCTAssertEqual((js(view, "return localStorage.length;") as? NSNumber)?.intValue, 0, "nothing copied or marked")
        XCTAssertNil(defaults.string(forKey: WebStore.pendingKey))
        XCTAssertNil(defaults.object(forKey: WebStore.lastCheckKey))
    }

    func testFailedChecksInARowShowTheMessageTwiceThenOpenThePage() {
        let suite = "webstore-fail-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = WebStoreCheck.afterFailure(WebStore.noteFailure(defaults))
        XCTAssertFalse(first.open)
        XCTAssertTrue(first.message.contains("Close Foxy and open it again"))
        let second = WebStoreCheck.afterFailure(WebStore.noteFailure(defaults))
        XCTAssertFalse(second.open)
        XCTAssertTrue(second.message.contains("If it happens again, Foxy opens without it"))
        XCTAssertTrue(WebStoreCheck.afterFailure(WebStore.noteFailure(defaults)).open, "never a lockout")
        WebStore.noteChecked(defaults)
        XCTAssertEqual(WebStore.noteFailure(defaults), 1, "a finished check starts the count again")
    }

    func testACopyNeverSeenOnDiskIsMadeAgainBeforeAndAfterTheMove() {
        let source = fake("Default/s/s", keys: 57)
        var st = state(moved: false)
        st.pending = source.path
        guard case .copy(let p, _, _) = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [source]), state: st) else { return XCTFail() }
        XCTAssertEqual(p.path, source.path)
        // a re-keying after the move: the marked store from before, copied and lost
        let before = fake("Default/m/m", keys: 57, marked: true)
        var moved = state(moved: true)
        moved.pending = before.path
        guard case .copy(let q, _, _) = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [before]), state: moved) else { return XCTFail() }
        XCTAssertEqual(q.path, before.path)
        // seen marked: settled, and the source recorded as taken
        let suite = "webstore-settle-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        WebStore.notePending(before.path, defaults)
        XCTAssertFalse(WebStore.state(defaults).moved)
        WebStore.noteSettled(defaults)
        XCTAssertEqual(WebStore.state(defaults).taken, [before.path])
        XCTAssertTrue(WebStore.state(defaults).moved)
        XCTAssertNil(WebStore.state(defaults).pending)
    }

    func testTheStoreThePageWasUsingWinsOverAFullerStaleOne() {
        // re-keyed long ago, restored and used since: the salt names the live store
        let live = fake("Default/live/live", keys: 30, age: 60)
        let stale = fake("Default/stale/stale", keys: 57, age: 30 * 86400, bytes: 8_400_000)
        var found = WebStore.Scan(buckets: [stale, live])
        found.fileStores = [live.path]
        guard case .copy(let pick, let others, let why) = WebStore.decide(.init(marked: false, keys: 0), scan: found, state: state(moved: false)) else { return XCTFail() }
        XCTAssertEqual(pick.path, live.path)
        XCTAssertEqual(others.map(\.path), [stale.path], "the other is named, never merged")
        XCTAssertTrue(why.contains("the store the page was using at file://"), why)
        // the store the salt names is empty (the re-keying itself): the fullest is taken
        let empty = fake("Default/new/new", keys: 0, money: false)
        found = WebStore.Scan(buckets: [stale, empty])
        found.fileStores = [empty.path]
        guard case .copy(let full, _, _) = WebStore.decide(.init(marked: false, keys: 0), scan: found, state: state(moved: false)) else { return XCTFail() }
        XCTAssertEqual(full.path, stale.path)
        // after the move the salt's file:// store is not taken: it carries no mark
        found = WebStore.Scan(buckets: [live])
        found.fileStores = [live.path]
        guard case .keep = WebStore.decide(.init(marked: false, keys: 0), scan: found, state: state(moved: true)) else { return XCTFail() }
    }

    // MARK: The second review's cases

    /// Opened as it is after three failed checks, the page writes a setting or two (the intro seen) into its near-empty store.
    /// That store is not the wallet: the file:// wallet is still carried in, and nothing is marked or settled meanwhile.
    func testAStoreOfSettingsAloneIsCopiedIntoAndOnlyMoneyOrHistoryIsKeptAsIs() {
        let used = fake("Default/file/file", keys: 57)
        var found = WebStore.Scan(buckets: [used])
        found.fileStores = [used.path]
        let d = WebStore.decide(.init(marked: false, keys: 1), scan: found, state: state(moved: false))
        guard case .copy(let pick, _, let why) = d else { return XCTFail("a store of settings was kept beside the wallet: \(d)") }
        XCTAssertEqual(pick.path, used.path)
        XCTAssertTrue(why.contains("holds no money or history"), why)
        // after the move, the marked store from before is carried into one of settings alone as well
        let before = fake("Default/m/m", keys: 57, marked: true)
        guard case .copy(let q, _, _) = WebStore.decide(.init(marked: false, keys: 2), scan: .init(buckets: [before]), state: state(moved: true)) else { return XCTFail() }
        XCTAssertEqual(q.path, before.path)
        // settings alone and nothing to carry in: kept and marked, as an empty store is
        guard case .keep(_, let markIt, _) = WebStore.decide(.init(marked: false, keys: 2), scan: .init(), state: state(moved: true)) else { return XCTFail() }
        XCTAssertTrue(markIt)
        // money or history: kept, never copied over
        guard case .keep = WebStore.decide(.init(marked: false, keys: 2, money: true), scan: found, state: state(moved: false)) else { return XCTFail() }
    }

    func testAfterOpeningAsIsNothingIsMarkedOrSettledUntilACopyIsMade() {
        let used = fake("Default/file/file", keys: 57)
        var found = WebStore.Scan(buckets: [used], unread: ["Default/x/x: could not open"])
        found.fileStores = [used.path]
        var st = state(moved: false)
        st.asIs = true
        // the store got money in the sessions opened as it is: kept, but not marked, so the move is not settled on it
        guard case .keep(_, let markIt, let settle) = WebStore.decide(.init(marked: false, keys: 5, money: true), scan: found, state: st) else { return XCTFail() }
        XCTAssertFalse(markIt)
        XCTAssertFalse(settle)
        // a store marked before: not settled while anything could still be carried in
        guard case .keep(_, let m2, let s2) = WebStore.decide(.init(marked: true, keys: 5, money: true), scan: found, state: st) else { return XCTFail() }
        XCTAssertFalse(m2)
        XCTAssertFalse(s2)
        // the store is still the empty one: the wallet is copied in (and the copy clears the hold, WebStoreCheck.run)
        guard case .copy(let pick, _, _) = WebStore.decide(.init(marked: false, keys: 1), scan: found, state: st) else { return XCTFail() }
        XCTAssertEqual(pick.path, used.path)
        // nothing left on the phone that could be carried in: marked and settled as ever
        guard case .keep(_, _, let s3) = WebStore.decide(.init(marked: true, keys: 5), scan: .init(), state: st) else { return XCTFail() }
        XCTAssertTrue(s3)
        guard case .keep(_, let m4, _) = WebStore.decide(.init(marked: false, keys: 5, money: true), scan: .init(), state: st) else { return XCTFail() }
        XCTAssertTrue(m4)
        // remembered across launches
        let suite = "webstore-asis-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(WebStore.state(defaults).asIs)
        WebStore.noteOpenedAsIs(defaults)
        XCTAssertTrue(WebStore.state(defaults).asIs)
        WebStore.clearAsIs(defaults)
        XCTAssertFalse(WebStore.state(defaults).asIs)
    }

    func testTheFileStoreThePageUsedIsCopiedEvenBesideAStoreThatCouldNotBeRead() {
        let used = fake("Default/file/file", keys: 57)
        var found = WebStore.Scan(buckets: [used], unread: ["Default/x/x: could not open"])
        found.fileStores = [used.path]
        guard case .copy(let pick, _, _) = WebStore.decide(.init(marked: false, keys: 0), scan: found, state: state(moved: false)) else { return XCTFail() }
        XCTAssertEqual(pick.path, used.path)
        // not the salt's store (or it holds nothing): nothing is taken beside one that could not be read
        let other = fake("Default/o/o", keys: 57)
        var unnamed = WebStore.Scan(buckets: [other], unread: ["Default/x/x: could not open"])
        unnamed.fileStores = ["Default/empty/empty"]
        guard case .wait = WebStore.decide(.init(marked: false, keys: 0), scan: unnamed, state: state(moved: false)) else { return XCTFail() }
    }

    /// Before the move settles, the page's store from before a re-keying (with this install's mark) beats the file:// store it was
    /// copied from: copying that one again would bring back what was spent since and hide what was received. After it, between two
    /// marked stores, the newest.
    func testAMarkedStoreOutranksTheStoreItWasCopiedFromAndTheNewestMarkedWins() {
        let used = fake("Default/file/file", keys: 57, age: 86400)
        let own = fake("Default/own/own", keys: 40, marked: true, age: 60)
        var found = WebStore.Scan(buckets: [used, own])
        found.fileStores = [used.path]
        var st = state(moved: false)
        st.pending = used.path
        guard case .copy(let pick, let others, _) = WebStore.decide(.init(marked: false, keys: 0), scan: found, state: st) else { return XCTFail() }
        XCTAssertEqual(pick.path, own.path, "the marked store, not the file:// one it was copied from")
        XCTAssertEqual(others.map(\.path), [used.path])
        // after the move: two marked stores, the older fuller
        let older = fake("Default/a/a", keys: 60, marked: true, age: 7200)
        let newer = fake("Default/b/b", keys: 30, marked: true, age: 10)
        guard case .copy(let p2, _, _) = WebStore.decide(.init(marked: false, keys: 0), scan: .init(buckets: [older, newer]), state: state(moved: true)) else { return XCTFail() }
        XCTAssertEqual(p2.path, newer.path, "the newest marked store, not the one with the most keys")
        XCTAssertEqual(WebStore.candidates([used, older, newer, own], state: state(moved: false)).map(\.path), [newer.path, own.path, older.path, used.path])
    }

    func testACopyCutOffPartWayIsNeverKeptAndNeverOpenedAsIs() {
        // the review's case: a copy cut off, nothing on the phone left to copy again
        let d = WebStore.decide(.init(marked: false, keys: 4, copying: true), scan: .init(), state: state(moved: true))
        guard case .wait = d else { return XCTFail("a cut-off copy was kept: \(d)") }
        guard case .wait = WebStore.decide(.init(marked: false, keys: 4, copying: true, money: true), scan: .init(), state: state(moved: false)) else { return XCTFail() }
        // its source still there: copied again
        let source = fake("Default/s/s", keys: 57)
        guard case .copy = WebStore.decide(.init(marked: false, keys: 4, copying: true, money: true), scan: .init(buckets: [source]), state: state(moved: false)) else { return XCTFail() }
        // and three failed checks in a row never open the page on it
        XCTAssertTrue(WebStoreCheck.afterFailure(WebStore.failuresBeforeOpening).open)
        let refused = WebStoreCheck.afterFailure(WebStore.failuresBeforeOpening + 5, copying: true)
        XCTAssertFalse(refused.open)
        XCTAssertTrue(refused.message.contains("Nothing was removed"), refused.message)
        let suite = "webstore-copying-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        WebStore.noteCopying(true, defaults)
        XCTAssertTrue(WebStore.state(defaults).copying)
        WebStore.noteCopying(false, defaults)
        XCTAssertFalse(WebStore.state(defaults).copying)
    }

    func testTheCheckPageDyingRestartsTheCheckTwiceALaunchThenEndsAsAFailedCheck() {
        XCTAssertTrue(WebStoreCheck.restartAfterDeath(1))
        XCTAssertTrue(WebStoreCheck.restartAfterDeath(2))
        XCTAssertFalse(WebStoreCheck.restartAfterDeath(3))
    }

    func testTheScanNamesTheStoresTheSaltPointsAt() throws {
        let root = temp.appendingPathComponent("WebKit")
        let salt = Data([1, 2, 3, 4, 5, 6, 7, 8])
        let fileName = WebStore.folderName(origin: "file://", salt: salt)
        let pageName = WebStore.folderName(origin: WebStore.origin, salt: salt)
        try bucket(root, fileName, origin: ("file", ""), wallet(piles: 1))
        try bucket(root, pageName, origin: ("foxy-app", "wallet"), [])
        try salt.write(to: root.appendingPathComponent("WebsiteData/Default/salt"))
        let found = scan(root)
        XCTAssertEqual(found.fileStores, ["WebsiteData/Default/\(fileName)/\(fileName)"])
        XCTAssertEqual(found.pageStores, ["WebsiteData/Default/\(pageName)/\(pageName)"])
        try Data([1, 2]).write(to: root.appendingPathComponent("WebsiteData/Default/salt"))
        XCTAssertEqual(scan(root).fileStores, [], "a salt that is not 8 bytes names nothing")
    }

    /// The folder names are WebKit's own: a real persistent store on this Mac,
    /// one page at file:// and one at foxy-app://wallet, and the folders it made.
    func testTheFolderNamesAreTheOnesWebKitMakes() throws {
        #if !os(macOS)
        throw XCTSkip("run on the Mac (tools/nativetests), where the store's folders can be looked at")
        #else
        guard #available(macOS 14.0, *) else { throw XCTSkip("needs a store by identifier (macOS 14)") }
        let id = UUID()
        let root = try webRoot()
        var origins: [String] = []
        do {
            let handler = WebSchemeHandler(root: { root })
            let config = WKWebViewConfiguration()
            config.websiteDataStore = WKWebsiteDataStore(forIdentifier: id)
            config.setURLSchemeHandler(handler, forURLScheme: WebStore.scheme)
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: config)
            let waiter = Waiter()
            view.navigationDelegate = waiter
            let page = root.appendingPathComponent("index.html")
            let fileDone = expectation(description: "file page")
            waiter.finished = { waiter.finished = nil; fileDone.fulfill() }
            view.loadFileURL(page, allowingReadAccessTo: root)
            wait(for: [fileDone], timeout: 20)
            origins.append(js(view, "localStorage.setItem('k', 'v'); return location.origin;") as? String ?? "?")
            load(view, waiter, WebStore.indexURL)
            origins.append(js(view, "localStorage.setItem('k', 'v'); return location.origin;") as? String ?? "?")
            RunLoop.main.run(until: Date().addingTimeInterval(2))   // WebKit writes the stores
        }
        XCTAssertEqual(origins, ["file://", WebStore.origin])
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/WebKit")
        var salts: [URL] = []
        for case let url as URL in FileManager.default.enumerator(at: home, includingPropertiesForKeys: nil)!
        where url.path.lowercased().contains(id.uuidString.lowercased()) && url.lastPathComponent == "salt"
            && url.deletingLastPathComponent().lastPathComponent == "Origins" {
            salts.append(url)
        }
        defer {
            if let store = salts.first?.deletingLastPathComponent().deletingLastPathComponent() { try? FileManager.default.removeItem(at: store) }
            WKWebsiteDataStore.remove(forIdentifier: id) { _ in }
        }
        let saltFile = try XCTUnwrap(salts.first, "no Origins/salt for the store")
        let salt = try Data(contentsOf: saltFile)
        for o in ["file://", WebStore.origin] {
            let name = WebStore.folderName(origin: o, salt: salt)
            let store = saltFile.deletingLastPathComponent().appendingPathComponent("\(name)/\(name)/LocalStorage/localstorage.sqlite3")
            XCTAssertTrue(FileManager.default.fileExists(atPath: store.path), "WebKit's store for \(o) is not at \(name)")
        }
        #endif
    }

    func testAStoreChangedSinceTheLastLaunchIsNamed() {
        let since = Date(timeIntervalSince1970: 1_800_000_000 - 1000)
        var st = state(moved: true)
        st.lastCheck = since
        let older = fake("Default/x/x", keys: 50, age: 0)            // an older Foxy used it after this one last ran
        let page = fake("Default/p/p", keys: 50, age: 0)
        let quiet = fake("Default/q/q", keys: 50, age: 5000)
        var found = WebStore.Scan(buckets: [older, page, quiet])
        found.pageStores = [page.path]
        XCTAssertEqual(WebStore.changedSince(found, state: st).map(\.path), [older.path])
        st.lastCheck = nil
        XCTAssertEqual(WebStore.changedSince(found, state: st), [], "nothing to compare with on the first launch")
    }

    func testTheCheckNamesAnotherStoreChangedSinceTheLastLaunch() throws {
        let root = try webRoot()
        let webKit = temp.appendingPathComponent("WebKit")
        try bucket(webKit, "OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO", origin: ("file", ""), wallet(piles: 2))
        let (defaults, suite) = try freshDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let setup = WebStoreCheck.Setup(webKit: webKit, scratch: temp.appendingPathComponent("scratch"), defaults: defaults)
        let (view, waiter, _) = webView(root: root)
        XCTAssertEqual(check(view, waiter, setup).0, .ready)          // copied
        XCTAssertEqual(check(view, waiter, setup).0, .ready)          // settled
        // an older Foxy runs on the file:// store and receives money there
        defaults.set(Date(timeIntervalSinceNow: -60), forKey: WebStore.lastCheckKey)
        let file = webKit.appendingPathComponent("WebsiteData/Default/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO/OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO/LocalStorage/localstorage.sqlite3")
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        let (result, said) = check(view, waiter, setup)
        XCTAssertEqual(result, .ready)
        XCTAssertTrue(said.contains { $0.hasPrefix("ANOTHER STORE CHANGED SINCE THE LAST LAUNCH") && $0.contains("OLDOLDOL…") },
                      said.joined(separator: "\n"))
    }

    func testAWalletAsLargeAsTheStoreHoldsIsCarriedAndOneTooLargeIsTakenBack() throws {
        let root = try webRoot()
        let (view, waiter, _) = webView(root: root)
        load(view, waiter, WebStore.checkURL)
        var args = WebStore.arguments(mark: mark)
        // 4.8 million characters in 24 items, under WebKit's 5 MB a store; carried whole through the arguments
        args["items"] = (0..<24).map { ["foxy.cashu.proofs.https://m\($0).example", String(repeating: "p", count: 200_000)] }
        let ok = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertEqual((ok?["copied"] as? NSNumber)?.intValue, 24, "\(String(describing: ok))")
        _ = js(view, "localStorage.clear(); return true;")
        // more than a store holds: refused part way, and everything set is taken back
        args["items"] = (0..<30).map { ["foxy.cashu.proofs.https://m\($0).example", String(repeating: "p", count: 200_000)] }
        let over = js(view, WebStore.copyScript, args) as? [String: Any]
        XCTAssertTrue((over?["error"] as? String)?.contains("QuotaExceeded") == true, "\(String(describing: over))")
        XCTAssertEqual((js(view, "return localStorage.length;") as? NSNumber)?.intValue, 0)
    }

    private func freshDefaults() throws -> (UserDefaults, String) {
        let suite = "webstore-test-" + UUID().uuidString
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    /// One launch's check: the check page, the scan, the run.
    private func check(_ view: WKWebView, _ waiter: Waiter, _ setup: WebStoreCheck.Setup) -> (WebStoreCheck.Result, [String]) {
        load(view, waiter, WebStore.checkURL)
        let (scan, state) = WebStoreCheck.scan(setup)
        var lines: [String] = []
        var result: WebStoreCheck.Result?
        let done = expectation(description: "check")
        WebStoreCheck.run(in: view, scan: scan, state: state, setup: setup, log: { lines.append($0) }) {
            result = $0
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        return (result ?? .failed("no answer"), lines)
    }
}

/// A WebKit task the handler can be handed directly.
private final class FakeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var status: Int?
    var body = Data()
    var finished = false
    var error: Error?

    init(_ request: URLRequest) { self.request = request }

    func didReceive(_ response: URLResponse) { status = (response as? HTTPURLResponse)?.statusCode }
    func didReceive(_ data: Data) { body.append(data) }
    func didFinish() { finished = true }
    func didFailWithError(_ error: Error) { self.error = error }
}
