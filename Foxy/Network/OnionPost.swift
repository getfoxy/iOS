import Foundation
import Network

/// A payment posted to another phone's onion address (OnionInbox), through Tor.
///
/// Not URLSession: App Transport Security refuses plain http, and to an onion
/// address plain http is what there is (Tor encrypts and authenticates that
/// connection end to end, by the address itself). So this speaks SOCKS5 to
/// Tor's port directly — a greeting, a login that names the circuit, a CONNECT
/// to the onion name — and then one HTTP/1.1 POST, and reads one answer.
///
/// Only an onion host is accepted, and only through Tor: never the open
/// connection, where an onion name would be looked up by the phone's DNS.
enum OnionPost {
    /// An answer longer than this is cut off: the inbox says a few words.
    static let largestAnswer = 64 * 1024

    enum Failure: Error, Equatable {
        case notOnion
        case noTor
        /// Tor could not reach the address: not published yet, or gone.
        case unreachable(UInt8)
        case refusedBySocks
        case timedOut
        case broken
        var text: String {
            switch self {
            case .notOnion: return "That is not an onion address."
            case .noTor: return Route.refusal
            case .unreachable: return "Their phone could not be reached over Tor."
            case .refusedBySocks: return "Tor refused the connection."
            case .timedOut: return "Their phone did not answer in time."
            case .broken: return "The connection to their phone broke."
            }
        }
        /// The same for an onion that is a service, not a phone (a block explorer's).
        var serviceText: String {
            switch self {
            case .notOnion: return "That is not an onion address."
            case .noTor: return Route.refusal
            case .unreachable: return "It could not be reached over Tor."
            case .refusedBySocks: return "Tor refused the connection."
            case .timedOut: return "It did not answer in time."
            case .broken: return "The connection broke."
            }
        }
    }

    /// POST `body` to `url`. `done` on the main queue with the HTTP status and body.
    static func send(_ url: URL, body: Data, circuit: String, timeout: TimeInterval = 120,
                     done: @escaping (Result<(status: Int, body: String), Failure>) -> Void) {
        guard url.scheme == "http", let name = url.host, OnionAddress.isHost(name),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            done(.failure(.notOnion)); return
        }
        let host = name.lowercased()
        let head = "POST \(pathOf(url)) HTTP/1.1\r\nHost: \(host)\r\n"
            + "Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        guard let port = portOf(url) else { done(.failure(.notOnion)); return }
        _ = connect(host: host, port: port, request: Data(head.utf8) + body,
                    circuit: circuit, timeout: timeout, done: done)
    }

    /// GET `url`, for a reader rather than a payer: the price feed's onion.
    ///
    /// The same reason this file exists at all applies — App Transport Security
    /// refuses plain http, and plain http is what an onion speaks — so a price
    /// source named by an onion cannot go through URLSession the way the
    /// clearnet ones do. The returned closure stops the fetch, for a walk that
    /// has its answer from somewhere else already.
    @discardableResult
    static func get(_ url: URL, circuit: String, timeout: TimeInterval = 20,
                    done: @escaping (Result<(status: Int, body: String), Failure>) -> Void) -> () -> Void {
        /* Each way in states its own refusal rather than sharing one: this is
         * the guard that keeps a name the phone's own DNS resolver would look
         * up out of a hand-written SOCKS client, and it should be readable in
         * full at every door (tools/smoke.py, 37). */
        guard url.scheme == "http", let name = url.host, OnionAddress.isHost(name),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            done(.failure(.notOnion)); return {}
        }
        let host = name.lowercased()
        let head = "GET \(pathOf(url)) HTTP/1.1\r\nHost: \(host)\r\n"
            + "Accept: application/json\r\nConnection: close\r\n\r\n"
        guard let port = portOf(url) else { done(.failure(.notOnion)); return {} }
        return connect(host: host, port: port, request: Data(head.utf8),
                       circuit: circuit, timeout: timeout, done: done)
    }

    private static func pathOf(_ url: URL) -> String { url.path.isEmpty ? "/" : url.path }
    /// nil rather than a trap: the URL is built from page-supplied text
    /// (handleOnionPost), the host checks constrain the name and not the port,
    /// and `UInt16(_:)` crashes on anything that will not fit.
    private static func portOf(_ url: URL) -> UInt16? { UInt16(exactly: url.port ?? 80) }

    /// One exchange: SOCKS5 to Tor's port, then `request`, then one answer.
    /// The returned closure drops it without an answer.
    private static func connect(host: String, port: UInt16, request: Data, circuit: String,
                                timeout: TimeInterval,
                                done: @escaping (Result<(status: Int, body: String), Failure>) -> Void) -> () -> Void {
        #if canImport(Tor)
        guard TorService.isRunning, TorService.socksPort > 0,
              let socks = NWEndpoint.Port(rawValue: TorService.socksPort) else {
            done(.failure(.noTor)); return {}
        }
        #else
        done(.failure(.noTor)); return {}
        #endif
        let conn = NWConnection(host: "127.0.0.1", port: socks, using: .tcp)
        let exchange = Exchange(conn: conn, done: done)
        let queue = DispatchQueue(label: "foxy.onion.http")

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                exchange.socks(host: host, port: port, circuit: circuit) {
                    exchange.http(request)
                }
            case .failed, .waiting:
                exchange.finish(.failure(.noTor))
            default:
                break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { exchange.finish(.failure(.timedOut)) }
        return { queue.async { exchange.drop() } }
    }

    /// One connection's steps, on its queue.
    private final class Exchange {
        let conn: NWConnection
        private var done: ((Result<(status: Int, body: String), Failure>) -> Void)?

        init(conn: NWConnection, done: @escaping (Result<(status: Int, body: String), Failure>) -> Void) {
            self.conn = conn
            self.done = done
        }

        func finish(_ result: Result<(status: Int, body: String), Failure>) {
            guard let done else { return }
            self.done = nil
            conn.cancel()
            DispatchQueue.main.async { done(result) }
        }

        /// Stop, with nobody to tell: the caller has what it wanted elsewhere.
        func drop() {
            guard done != nil else { return }
            done = nil
            conn.cancel()
        }

        /// Exactly `count` bytes, or the exchange fails.
        private func read(_ count: Int, _ step: String, _ next: @escaping ([UInt8]) -> Void) {
            conn.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, done, error in
                guard let data, data.count == count, error == nil else {
                    #if DEBUG
                    /* Silent when this exchange was dropped: the caller has
                     * its answer from somewhere else and cancelled us, so the
                     * read failing is the cancel, not a fault. It printed
                     * either way, and a price walk that Kraken won left
                     * "connect read -1 of 4, closed" in the log looking for
                     * all the world like the onion source had failed. */
                    if self.done != nil {
                        print("[foxy] onion http: \(step) read \(data?.count ?? -1) of \(count)"
                              + (error.map { ", \($0)" } ?? "") + (done ? ", closed" : ""))
                    }
                    #endif
                    self.finish(.failure(.broken))
                    return
                }
                next([UInt8](data))
            }
        }

        private func write(_ bytes: [UInt8], _ step: String, _ next: @escaping () -> Void) {
            conn.send(content: Data(bytes), completion: .contentProcessed { error in
                if let error {
                    #if DEBUG
                    print("[foxy] onion http: \(step) write failed, \(error)")
                    #endif
                    self.finish(.failure(.broken))
                } else {
                    next()
                }
            })
        }

        /// RFC 1928 and 1929. The login is the circuit label: Tor keeps each
        /// label on circuits of its own (IsolateSOCKSAuth).
        func socks(host: String, port: UInt16, circuit: String, _ connected: @escaping () -> Void) {
            let login = Array(circuit.utf8.prefix(255))
            let name = Array(host.utf8)
            guard !login.isEmpty, name.count <= 255 else { finish(.failure(.refusedBySocks)); return }
            write([5, 1, 2], "greeting") {
                self.read(2, "greeting") { r in
                    guard r == [5, 2] else {
                        #if DEBUG
                        print("[foxy] onion http: Tor answered the greeting with \(r)")
                        #endif
                        self.finish(.failure(.refusedBySocks))
                        return
                    }
                    self.write([1, UInt8(login.count)] + login + [UInt8(login.count)] + login, "login") {
                        self.read(2, "login") { r in
                            guard r.count == 2, r[1] == 0 else { self.finish(.failure(.refusedBySocks)); return }
                            self.write([5, 1, 0, 3, UInt8(name.count)] + name + [UInt8(port >> 8), UInt8(port & 0xFF)], "connect") {
                                self.read(4, "connect") { r in
                                    guard r[0] == 5 else { self.finish(.failure(.refusedBySocks)); return }
                                    guard r[1] == 0 else { self.finish(.failure(.unreachable(r[1]))); return }
                                    let rest: Int
                                    switch r[3] {
                                    case 1: rest = 4 + 2
                                    case 4: rest = 16 + 2
                                    case 3:
                                        self.read(1, "address") { n in self.read(Int(n[0]) + 2, "address") { _ in connected() } }
                                        return
                                    default: self.finish(.failure(.refusedBySocks)); return
                                    }
                                    self.read(rest, "address") { _ in connected() }
                                }
                            }
                        }
                    }
                }
            }
        }

        func http(_ request: Data) {
            #if DEBUG
            print("[foxy] onion http: connected, sending \(request.count) bytes")
            #endif
            conn.send(content: request, completion: .contentProcessed { error in
                if let error {
                    #if DEBUG
                    print("[foxy] onion http: the request would not send, \(error)")
                    #endif
                    self.finish(.failure(.broken))
                    return
                }
                self.collect(Data())
            })
        }

        private func collect(_ buffer: Data) {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                var buffer = buffer
                if let data { buffer.append(data) }
                if buffer.count > OnionPost.largestAnswer { self.finish(.failure(.broken)); return }
                if complete || error != nil {
                    guard let answer = HTTPAnswer.parse(buffer) else {
                        #if DEBUG
                        print("[foxy] onion http: the answer was \(buffer.count) bytes"
                              + (error.map { ", \($0)" } ?? "") + (complete ? ", closed" : ""))
                        #endif
                        self.finish(.failure(.broken))
                        return
                    }
                    self.finish(.success(answer))
                    return
                }
                self.collect(buffer)
            }
        }
    }
}

/// The status line and body of an answer read to its end.
enum HTTPAnswer {
    static func parse(_ data: Data) -> (status: Int, body: String)? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        let first = head.components(separatedBy: "\r\n")[0].split(separator: " ")
        // three figures, and they must be figures: Int(_:) also reads "+200"
        guard first.count >= 2, first[0].hasPrefix("HTTP/1."),
              first[1].count == 3, first[1].allSatisfy({ $0.isASCII && $0.isNumber }),
              let status = Int(first[1]), (100...599).contains(status) else { return nil }
        return (status, String(decoding: data[end.upperBound...], as: UTF8.self))
    }
}
