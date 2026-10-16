import Foundation

/// The connection diary: one line for each request to a mint, and one for each
/// change of network, in the field log that the LOGS screen shows.
///
/// A mint's operator asking "why was it slow?" needs what this phone saw: when
/// a request went, how long it was out, which circuit it took and what came
/// back. Their own logs say only that something arrived late, from a Tor exit
/// they cannot tell apart from any other. The CONNECTION view on the LOGS
/// screen shows these lines and nothing else, and they leave the phone only if
/// the person taps COPY or SHARE.
///
/// So the line says how a request went and nothing of what it said: the
/// method, the host, the path with every id masked, the first six characters
/// of the circuit label, the milliseconds and the outcome. Never a body, a
/// header's value or a query. It goes through FieldLog like every other line,
/// so redaction still applies (an onion host is removed there).
///
/// No UIKit here, so tools/nativetests can build it on a Mac (FoxyNetDiary).
enum NetDiary {

    /// What every request line starts with. The page's CONNECTION view
    /// matches on it (build/app/26c-field-log.js).
    static let prefix = "[foxy] net:"

    /// And every change of network.
    static let networkPrefix = "[foxy] network:"

    // MARK: The request line

    /// One request: written when its answer or its error comes back.
    static func line(method: String, host: String, path: String, circuit: String,
                     ms: Int, outcome: String, mark: String? = nil) -> String {
        var s = "\(prefix) \(method) \(host.lowercased())\(pathShape(path))"
            + " · circuit \(circuit.prefix(6)) · \(max(0, ms)) ms · \(outcome)"
        // the first six of what the test mint was sent, so its log line can be found
        if let mark, !mark.isEmpty { s += " · mark \(mark.prefix(6))" }
        return s
    }

    /// The host as the line shows it: a port only when it is not the scheme's own.
    static func host(of url: URL) -> String {
        let name = (url.host ?? "?").lowercased()
        guard let port = url.port else { return name }
        if (url.scheme == "https" && port == 443) || (url.scheme == "http" && port == 80) { return name }
        return "\(name):\(port)"
    }

    /* The path with what names a payment taken out.
     *
     * A quote id is what a mint files an invoice under, a keyset id says which
     * of its keys this wallet holds, and a lightning address's name is a
     * person. None of them helps anyone read a timing, and every one of them
     * would put this wallet's own business into a log that is meant to be
     * pasted. So: everything after /mint/quote/<method>/, /melt/quote/<method>/,
     * /keys/ and a lightning address's lookup is ':id', and so is any segment
     * that looks like an id wherever it is (long, digit-heavy, or carrying
     * characters a path word does not). A mint's own prefix, such as
     * /Bitcoin, stays: it says which mint at that host was asked. */
    static func pathShape(_ path: String) -> String {
        guard !path.isEmpty else { return "/" }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        var rest = false
        for (i, seg) in parts.enumerated() {
            if seg.isEmpty { out.append(seg); continue }
            if rest || looksLikeId(seg) { out.append(":id"); continue }
            out.append(seg)
            let low = seg.lowercased()
            let prev = i > 0 ? parts[i - 1].lowercased() : ""
            let prev2 = i > 1 ? parts[i - 2].lowercased() : ""
            // the payment method is kept; the quote id after it is not
            if prev == "quote" && (prev2 == "mint" || prev2 == "melt") { rest = true }
            if low == "keys" { rest = true }
            // a lightning address's name, and the callbacks that carry its payment
            if prev == ".well-known" || ["lnurlp", "lnurlw", "lnurl", "callback", "cb"].contains(low) { rest = true }
            // a block explorer's address lookup names somebody's coins
            if low == "address" || low == "scripthash" { rest = true }
        }
        return out.joined(separator: "/")
    }

    static func looksLikeId(_ seg: String) -> Bool {
        if seg.count >= 16 { return true }
        if seg.filter(\.isNumber).count >= 4 { return true }
        if seg.contains(where: { "@%=:+~".contains($0) }) { return true }
        return false
    }

    /// A failure in a few words, the URL error's own code beside it: what a
    /// reader matches against their own side's timeouts and resets.
    static func failure(_ error: Error) -> String {
        let e = error as NSError
        guard e.domain == NSURLErrorDomain else { return "failed: error [\(e.domain) \(e.code)]" }
        let what: String
        switch e.code {
        case NSURLErrorTimedOut: what = "timeout"
        case NSURLErrorCancelled: what = "cancelled"
        // the proxy refused the stream before a byte left (FoxyBridge.sendMintRequest)
        case NSURLErrorBadURL: what = "no stream"
        case NSURLErrorNetworkConnectionLost: what = "connection lost"
        case NSURLErrorNotConnectedToInternet: what = "offline"
        case NSURLErrorCannotConnectToHost: what = "no connection"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: what = "no such host"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorClientCertificateRejected:
            what = "tls"
        case NSURLErrorBadServerResponse: what = "bad answer"
        default: what = "error"
        }
        return "failed: \(what) [\(e.code)]"
    }

    // MARK: The network

    /// wifi, cellular, wired, other or none (NetworkKind), and whether iOS
    /// calls the path expensive (cellular, or a hotspot) or constrained (Low
    /// Data Mode): both change how a slow request should be read.
    static func networkLine(kind: String, expensive: Bool, constrained: Bool) -> String {
        guard kind != "none" else { return "\(networkPrefix) none" }
        var s = "\(networkPrefix) \(kind)"
        if expensive { s += ", expensive" }
        if constrained { s += ", constrained (Low Data Mode)" }
        return s
    }

    // MARK: X-Request-Id, for a test mint only

    /* A mark a test mint can find in its own log.
     *
     * Sixteen random hex characters, new for every request, made by the page
     * and saying nothing about the wallet. Sent as X-Request-Id only to a host
     * on this list, which is empty unless a Debug build was launched with
     * `-FoxyRequestIdHosts host1,host2` (FoxyWebView). The page keeps a list of
     * its own (FoxyWallet.requestIdHosts) and a request must be on both, so a
     * page cannot start sending it to a production mint by itself: a Release
     * build has no way to fill this one. */
    static let markHeader = "X-Request-Id"

    private static let lock = NSLock()
    private static var hosts: Set<String> = []

    /// The hosts that are sent a mark, from a comma-separated list. Returns
    /// what was kept, lowercased, for the page to be told.
    @discardableResult
    static func setMarkHosts(_ list: String?) -> [String] {
        let kept = (list ?? "").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { name in
                !name.isEmpty && name.allSatisfy { c in c.isASCII && (c.isLetter || c.isNumber || ".-:".contains(c)) }
            }
        lock.lock(); hosts = Set(kept); lock.unlock()
        return kept.sorted()
    }

    static var markHosts: [String] {
        lock.lock(); defer { lock.unlock() }
        return hosts.sorted()
    }

    /// Sixteen lowercase hex characters, or nil: nothing else is ever sent.
    static func mark(_ raw: Any?) -> String? {
        guard let s = raw as? String, s.count == 16,
              s.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else { return nil }
        return s
    }

    /// Put the mark on the request when both sides list its host; the mark
    /// that was sent, or nil when none was.
    @discardableResult
    static func applyMark(_ raw: Any?, to request: inout URLRequest) -> String? {
        guard let url = request.url, let m = mark(raw) else { return nil }
        let name = (url.host ?? "").lowercased()
        let withPort = host(of: url)
        lock.lock(); let listed = hosts.contains(name) || hosts.contains(withPort); lock.unlock()
        guard listed else { return nil }
        request.setValue(m, forHTTPHeaderField: markHeader)
        return m
    }
}
