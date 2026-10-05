import Foundation
import Network

/// A GET to 127.0.0.1 over raw TCP: no proxy, no App Transport Security, and
/// no way to leave the phone. For Orbot's local API.
enum LoopbackHTTP {
    private static let queue = DispatchQueue(label: "foxy.loopback.http")

    static func get(port: UInt16, path: String, token: String?, timeout: TimeInterval = 5,
                    _ done: @escaping (_ code: Int?, _ body: String) -> Void) {
        guard let p = NWEndpoint.Port(rawValue: port) else { done(nil, ""); return }
        let conn = NWConnection(host: NWEndpoint.Host("127.0.0.1"), port: p, using: .tcp)
        var buffer = Data()
        var finished = false

        func finish() {
            if finished { return }
            finished = true
            conn.cancel()
            let text = String(data: buffer, encoding: .utf8) ?? ""
            let code = text.split(separator: " ", maxSplits: 2).dropFirst().first.flatMap { Int($0) }
            let body = text.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
            DispatchQueue.main.async { done(code, body) }
        }

        func receive() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                if let data { buffer.append(data) }
                // Orbot's answer is a few hundred bytes. Anything else listening on
                // this port could send without end and run Foxy out of memory.
                if buffer.count > 65536 { buffer.removeAll(); finish(); return }
                if complete || error != nil { finish() } else { receive() }
            }
        }

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                var req = "GET \(path) HTTP/1.1\r\nHost: localhost:\(port)\r\nConnection: close\r\n"
                if let token { req += "X-Token: \(token)\r\n" }
                req += "\r\n"
                conn.send(content: req.data(using: .utf8), completion: .contentProcessed { _ in })
                receive()
            case .failed, .waiting: finish()      // refused: nothing is listening
            default: break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { finish() }
    }
}
