import Foundation
#if canImport(IPtProxy)
import IPtProxy
#endif

#if canImport(Tor) && canImport(IPtProxy)
/// Pluggable transports, in this process, from Vendor/IPtProxy.xcframework —
/// built from source by tools/build-iptproxy.sh.
///
/// A transport listens on 127.0.0.1 and Tor reaches its bridges through it.
/// What leaves the phone then does not look like Tor: WebRTC to a Snowflake
/// volunteer, or obfs4's random-looking stream to a bridge.
///
/// Snowflake finds a volunteer by asking a broker, through a CDN, and public
/// STUN servers. Those contacts go straight out, not through Tor — that is how
/// Snowflake works. They learn this phone is starting Snowflake; never a mint,
/// an amount or a payment, which only ever travel inside Tor.
///
/// The bridge lines are the Tor Project's built-in ones, first taken from
/// IPtProxyUI (MIT, Guardian Project) commit f764d6f. Refresh them with
/// tools/update-bridges.py, which rewrites the lines between the markers.
enum Bridges {
    // BEGIN BUILT-IN BRIDGES — tools/update-bridges.py, fetched 2026-09-13 from https://bridges.torproject.org/moat/circumvention/builtin
    static let obfs4Lines = [
        "obfs4 45.145.95.6:27015 C5B7CD6946FF10C5B3E89691A7D3F2C122D2117C cert=TD7PbUO0/0k6xYHMPW3vJxICfkMZNdkRrb63Zhl5j9dW3iRGiCx0A7mPhe5T2EDzQ35+Zw iat-mode=0",
        "obfs4 212.83.43.95:443 BFE712113A72899AD685764B211FACD30FF52C31 cert=ayq0XzCwhpdysn5o0EyDUbmSOx3X/oTEbzDMvczHOdBJKlvIdHHLJGkZARtT4dcBFArPPg iat-mode=1",
        "obfs4 51.222.13.177:80 5EDAC3B810E12B01F6FD8050D2FD3E277B289A08 cert=2uplIpLQ0q9+0qMFrK5pkaYRDOe460LL9WHBvatgkuRr/SL31wBOEupaMMJ6koRE6Ld0ew iat-mode=0",
        "obfs4 37.218.245.14:38224 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D cert=bjRaMrr1BRiAW8IE9U5z27fQaYgOhX1UCmOpg2pFpoMvo6ZgQMzLsaTzzQNTlm7hNcb+Sg iat-mode=0",
        "obfs4 212.83.43.74:443 39562501228A4D5E27FCA4C0C81A01EE23AE3EE4 cert=PBwr+S8JTVZo6MPdHnkTwXJPILWADLqfMGoVvhZClMq/Urndyd42BwX9YFJHZnBB3H0XCw iat-mode=1",
        "obfs4 209.148.46.65:443 74FAD13168806246602538555B5521A0383A1875 cert=ssH+9rP8dG2NLDN2XuFw63hIO/9MNNinLmxQDpVa+7kTOa9/m+tGWT1SmSYpQ9uTBGa6Hw iat-mode=0",
        "obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gDtDAIcUfeLqbstggjIw2rtgIKqdIhUlHp82XRqNSq/mtAjp1BIC9vHKJ2FAEpGssTPw iat-mode=0",
    ]

    static let snowflakeLines = [
        "snowflake 192.0.2.4:80 8838024498816A039FCBBAB14E6F40A0843051FA fingerprint=8838024498816A039FCBBAB14E6F40A0843051FA url=https://1098762253.rsc.cdn77.org/ fronts=app.datapacket.com,www.datapacket.com ice=stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,stun:stun.telnyx.com:3478,stun:stun.hot-chilli.net:3478,stun:stun.fitauto.ru:3478,stun:stun.m-online.net:3478 utls-imitate=hellorandomizedalpn",
        "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://1098762253.rsc.cdn77.org/ fronts=app.datapacket.com,www.datapacket.com ice=stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,stun:stun.telnyx.com:3478,stun:stun.hot-chilli.net:3478,stun:stun.fitauto.ru:3478,stun:stun.m-online.net:3478 utls-imitate=hellorandomizedalpn",
    ]
    // END BUILT-IN BRIDGES

    private static var controller: IPtProxyController?

    private static func transports(_ stateDir: URL) -> IPtProxyController? {
        if let controller { return controller }
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        #if DEBUG
        let logging = true
        #else
        let logging = false
        #endif
        controller = IPtProxyController(stateDir.path, enableLogging: logging, unsafeLogging: false,
                                        logLevel: "WARN", transportEvents: nil)
        return controller
    }

    /// Start a transport; return the Tor settings that use it. Empty for direct.
    static func torSettings(for transport: TorTransport, stateDir: URL, proxy: String? = nil) throws -> [(String, String)] {
        guard transport != .direct else { return [] }
        guard let pt = transports(stateDir) else {
            throw NSError(domain: "Foxy.Bridges", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "the transport controller did not start"])
        }
        let name: String
        let lines: [String]
        switch transport {
        case .snowflake:
            name = IPtProxySnowflake
            lines = snowflakeLines
            let args = arguments(of: snowflakeLines[0])
            pt.snowflakeBrokerUrl = args["url"] ?? ""
            pt.snowflakeFrontDomains = args["fronts"] ?? args["front"] ?? ""
            pt.snowflakeIceServers = args["ice"] ?? ""
            pt.snowflakeAmpCacheUrl = ""
        case .obfs4:
            name = IPtProxyObfs4
            lines = obfs4Lines
        case .direct:
            return []
        }
        // With Orbot's bypass, the transport reaches its bridge through it too.
        try pt.start(name, proxy: proxy)
        let port = pt.port(name)
        guard port > 0 else {
            throw NSError(domain: "Foxy.Bridges", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "\(name) did not open a port"])
        }
        return [("UseBridges", "1"), ("ClientTransportPlugin", "\(name) socks5 127.0.0.1:\(port)")]
            + lines.map { ("Bridge", $0) }
    }

    static func stopAll() {
        controller?.stop(IPtProxySnowflake)
        controller?.stop(IPtProxyObfs4)
    }

    private static func arguments(of line: String) -> [String: String] {
        var out: [String: String] = [:]
        for part in line.split(separator: " ") {
            let kv = part.split(separator: "=", maxSplits: 1)
            if kv.count == 2 { out[String(kv[0])] = String(kv[1]) }
        }
        return out
    }
}
#endif
