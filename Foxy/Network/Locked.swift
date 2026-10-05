import Foundation

/// A value read from more than one queue, behind a lock.
///
/// Route's redirect guard runs on URLSession's own queue and asks whether Tor
/// is up; the main queue writes that answer and Route.unprotected. Plain static
/// variables read that way are a data race, which Swift does not promise to
/// survive (audit I9). Each read and write here takes the lock, so
/// a reader sees one whole value, old or new.
final class Locked<Value> {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) {
        stored = value
    }

    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }

    /// Read and write as ONE step, answering what was there before.
    ///
    /// `value` locks the read and locks the write, but not the pair, so
    /// `guard !flag.value else { return }; flag.value = true` is a race: two
    /// queues can both pass the guard. That is not hypothetical here — a
    /// timeout on one queue and a socket answer on another raced exactly that
    /// way to decide who got to finish a Nostr send (NostrDelivery), and a
    /// double finish miscounted the relays left, so the page's promise was
    /// either answered twice or never.
    ///
    ///     if once.exchange({ _ in true }) { return }   // somebody else got here first
    @discardableResult
    func exchange(_ change: (Value) -> Value) -> Value {
        lock.lock()
        defer { lock.unlock() }
        let was = stored
        stored = change(was)
        return was
    }
}
