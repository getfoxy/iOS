import Foundation
import Compression

/// The relay directory Foxy ships with, laid down on a first run.
///
/// Tor cannot build a circuit until it holds the microdescriptor of the relays
/// it might use, and on a first run it has none: it downloads all nine thousand
/// first. On a phone that was 37 of the 45 seconds between launch and
/// the first circuit — bootstrap sat at "loading relay descriptors" from 50% to
/// 75% while everything else took eight. A copy of
/// that directory in the bundle leaves Tor only the changes since the copy was
/// made.
///
/// **Nothing here is trusted.** Tor verifies every microdescriptor against the
/// SHA-256 digest the consensus gives for it, and the consensus against the
/// directory authorities' signing keys compiled into Tor itself. A seed that is
/// stale, truncated or tampered with fails those checks entry by entry and is
/// dropped; Tor then fetches what it is missing, which is what it does today.
/// The worst a bad seed can do is waste the disk it sits on.
///
/// Nor is any of it private: the Tor directory is public, and every copy of
/// Foxy ships the same one. It says nothing about the phone it is on.
///
/// Refreshed by tools/make-tor-seed.sh before a release.
enum TorSeed {
    /// The bundled file, without its extension.
    static let resource = "tor-microdescs"

    /// The name Tor reads it under.
    static let cacheName = "cached-microdescs"

    /// Written beside the seed when it is planted, and removed the first time
    /// Tor reaches a circuit. A marker still there on a later launch means the
    /// run that laid the seed down never got through.
    ///
    /// That alone is not the seed's fault, and the marker says so. Tor reaches
    /// the relay descriptors — the only stage a seed touches — at 40%: before
    /// that it is fetching the consensus, which the seed has nothing to do
    /// with, and a first install stalled there for over a minute with the seed
    /// sitting unread (two minutes later the same install
    /// went through that stage in under five seconds and the seed's own stage
    /// took 0.3). So only a run that got as far as using the seed and still
    /// never built a circuit counts against it, and that seed is taken out
    /// rather than laid again. A bad network costs one slow launch; it does
    /// not cost the head start on every launch after it.
    static let markerName = "microdescs.unproven"

    /// The bootstrap step at which Tor starts wanting relay descriptors, which
    /// is the first moment the seed is of any use — or of any harm.
    static let usedAt = 40

    /// Tor built a circuit, so whatever is in the cache works.
    static func proven(in dir: URL) {
        let marker = dir.appendingPathComponent(markerName)
        guard FileManager.default.fileExists(atPath: marker.path) else { return }
        try? FileManager.default.removeItem(at: marker)
        print("[foxy] tor: the directory seed got through")
    }

    /// Tor has reached the stage that reads the seed. Noted, so that a run
    /// which fails from here on counts against it.
    static func reached(_ percent: Int, in dir: URL) {
        guard percent >= usedAt else { return }
        let marker = dir.appendingPathComponent(markerName)
        let fm = FileManager.default
        guard let now = try? Data(contentsOf: marker), now.isEmpty else { return }
        _ = fm            // the marker only matters while it is there
        try? Data("used".utf8).write(to: marker)
    }

    /// Lay the seed down in `dir` if Tor has no directory of its own there yet.
    ///
    /// Only ever on a first run: a cache Tor is already keeping is never
    /// replaced by one from the bundle, which would be older than what the
    /// phone has and would throw away work already done.
    @discardableResult
    static func plant(in dir: URL, bundle: Bundle = .main) -> Bool {
        let cache = dir.appendingPathComponent(cacheName)
        let marker = dir.appendingPathComponent(markerName)
        let fm = FileManager.default
        /* A seed that was read by a run which never built a circuit. It does
         * not get a second try: it is taken out, and this launch fetches the
         * directory as an unseeded Foxy does. A marker that was never reached
         * (the run stalled earlier, on the consensus) is left alone — that
         * says nothing about the seed. */
        if let mark = try? Data(contentsOf: marker) {
            if !mark.isEmpty {
                try? fm.removeItem(at: cache)
                try? fm.removeItem(at: marker)
                print("[foxy] tor: the last directory seed was read and never got through; fetching the directory instead")
                return false
            }
            print("[foxy] tor: the last launch never reached the directory; keeping the seed")
        }
        guard !fm.fileExists(atPath: cache.path) else { return false }
        guard let packed = bundle.url(forResource: resource, withExtension: "xz"),
              let data = try? Data(contentsOf: packed) else {
            print("[foxy] tor: no directory seed in the bundle; Tor will fetch its own")
            return false
        }
        let began = Date()
        guard let plain = unpack(data), !plain.isEmpty else {
            print("[foxy] tor: the directory seed would not unpack; Tor will fetch its own")
            return false
        }
        /* Written beside the cache and moved onto it, so a run that ends
         * half way through leaves no half a file for Tor to read. */
        let part = dir.appendingPathComponent(cacheName + ".seed")
        do {
            try? fm.removeItem(at: part)
            try plain.write(to: part, options: .atomic)
            try fm.moveItem(at: part, to: cache)
        } catch {
            try? fm.removeItem(at: part)
            print("[foxy] tor: the directory seed could not be written:", error)
            return false
        }
        // unproven until Tor builds a circuit with it (proven(in:))
        try? Data().write(to: marker)
        print(String(format: "[foxy] tor: directory seed laid down, %.1f MB in %.1fs",
                     Double(plain.count) / 1e6, Date().timeIntervalSince(began)))
        return true
    }

    /// xz, through the system's LZMA decoder.
    static func unpack(_ packed: Data) -> Data? {
        let size = 1 << 20
        let out = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
        defer { out.deallocate() }
        var stream = compression_stream(dst_ptr: out, dst_size: size, src_ptr: out, src_size: 0, state: nil)
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_LZMA)
                == COMPRESSION_STATUS_OK else { return nil }
        defer { compression_stream_destroy(&stream) }

        var plain = Data()
        var failed = false
        packed.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { failed = true; return }
            stream.src_ptr = base
            stream.src_size = raw.count
            while true {
                stream.dst_ptr = out
                stream.dst_size = size
                let step = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                plain.append(out, count: size - stream.dst_size)
                if step == COMPRESSION_STATUS_END { return }
                if step == COMPRESSION_STATUS_ERROR { failed = true; return }
            }
        }
        return failed ? nil : plain
    }
}
