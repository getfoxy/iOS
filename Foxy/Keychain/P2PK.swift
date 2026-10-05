import Foundation

/// The keys a payment request locks ecash to, derived from the seed instead of
/// made at random.
///
/// A Foxy payment request (NUT-18) may name a public key for the payer to lock
/// its ecash to (NUT-11), so a token taken off the air — or off a relay — is
/// worthless to whoever took it. Until now that key was a fresh random one, made
/// in the page and kept in `foxy.req.lockkeys`. Random is fine right up to the
/// moment the phone is gone: the twelve words rebuild every proof the seed made,
/// and rebuild nothing at all of a key that was never derived from it. Ecash
/// locked to a random key, on a phone that is lost, is money nobody can ever
/// move — and the person holding the twelve words has no way of knowing it was
/// ever there.
///
/// NUT-13 standardises a path for exactly this:
///
///     m/129373'/10'/0'/0'/{index}
///
/// 129373' is the purpose, 10' the account, and `{index}` counts up, one key per
/// request. **The last level is a normal child, not a hardened one** — that is
/// the spec, and CDK derives it the same way (`crates/cdk/src/wallet/p2pk.rs`,
/// `P2PK_PURPOSE = 129373`, `P2PK_ACCOUNT = 10`). cashu-ts has it only on its v5
/// line and Foxy bundles 4.11.0, so it is written here. (Checked:
/// the string `129373` does not appear in the shipped bundle. cashu-ts 4.11.0
/// derives P2*B*K blinded keys, which is a different thing.)
///
/// **What this does and does not buy.** A restore cannot *find* P2PK-locked
/// ecash by walking anything. Those proofs were minted by the payer, from the
/// payer's own blinding factors, so NUT-09's restore — which asks the mint about
/// blinded messages this seed can rebuild — will never see them. What the
/// derived key buys is narrower and still worth having: a token already **in
/// hand** — one that arrived and was never claimed, one pasted in later, one
/// copied off a dead phone — can still be opened from the twelve words on any
/// device. The index is not needed either: `p2pkPubkeys` walks the path and the
/// page compares each public key with the lock the token carries.
///
/// **The chain code never leaves this file.** A BIP-32 child private key and its
/// parent's chain code together give the parent, and the parent gives every
/// other index — the well-known "leaked chain code" break of a non-hardened
/// branch. So the four hardened levels are walked once, here, and every chain
/// code is zeroed before a key is handed back. The bridge answers a private key
/// and a public key, 32 and 33 bytes, and nothing else.
///
/// The elliptic-curve step is libsecp256k1's, through NUT13.swift's own helpers.
/// This file imports nothing of the library and calls none of it: there is one
/// BIP-32 in Foxy, and one file that touches the curve.
enum P2PK {
    enum Failure: Error, Equatable {
        /// An index a normal BIP-32 child does not have (2^31 or above), or a
        /// count that does not fit below it.
        case badIndex
        /// A BIP-32 child that is not a valid key. About 1 in 2^127 per step:
        /// an error, never a different key.
        case invalidKey
        /// libsecp256k1's context, or its serialisation, failed.
        case platform
    }

    /// NUT-13's path for P2PK keys. The two hardened levels below the account
    /// are `0'/0'`: the spec writes the path out in full and CDK walks the same
    /// five levels, so they are written out here rather than named.
    static let purpose: UInt32 = 129373
    static let account: UInt32 = 10

    /// The largest `{index}`. A normal BIP-32 child index stops one below the
    /// hardened half; 2^31 would be `0'`, a different key entirely.
    static let lastIndex: UInt64 = 0x7FFF_FFFF
    /// One past it, which is what the index file stores when every index is used.
    static let largestNext: UInt64 = 0x8000_0000

    /// The most keys one `p2pkReserve` moves the index by. A request takes one;
    /// the page keeps a handful primed because `paymentRequest` is synchronous
    /// and cannot wait for the phone. 64 is more than any screen needs and small
    /// enough that a script cannot run the index away in a few calls.
    static let mostReserved = 64

    /// The most public keys one `p2pkPubkeys` answers. This is a scan — the page
    /// walks the path looking for the lock a token in hand carries — so it is
    /// larger than a reservation and still one batch.
    static let mostScanned = 300

    /// No public key is derived past this index. A wallet that has asked for
    /// twenty thousand payment requests is not a wallet this scan was written
    /// for, and an unbounded walk is an unbounded wait. Mirrors
    /// `RestoreWindow.candidateCap`, which bounds the other scan for the same
    /// reason.
    static let lastScanned: UInt64 = 20_000

    /// How far past the last reserved index a private key may still be asked
    /// for: `RestoreWindow.beyond`, the same 1000 the restore window uses, so
    /// the two cannot drift apart.
    ///
    /// Be honest about what this window is worth. A NUT-13 secret is money —
    /// a script holding tomorrow's secrets can take the ecash that lands on
    /// them. A lock private key is not: it opens only proofs somebody has
    /// already locked to its public half, and the page picks which public half
    /// goes into each request anyway. The window is a speed bump, not a wall,
    /// and it is here because a bridge action that hands out key material for
    /// any index on demand is a worse thing to have than one that does not.
    static var beyond: UInt64 { RestoreWindow.beyond }

    /// One index's key pair. The private key is the caller's to wipe.
    struct Pair {
        let index: UInt64
        var privateKey: [UInt8]
        var publicKey: [UInt8]

        mutating func wipe() {
            NUT13.wipe(&privateKey)
        }
    }

    // MARK: What exists

    /// Whether every index from `start` to `start + count − 1` is a normal
    /// BIP-32 child. The last one is checked, not only the first.
    static func indicesFit(start: UInt64, count: Int) -> Bool {
        guard count >= 1 else { return false }
        let (end, overflow) = start.addingReportingOverflow(UInt64(count - 1))
        return !overflow && end <= lastIndex
    }

    /// Whether a scan may reach these indices: inside `indicesFit`, and none
    /// past `lastScanned`.
    static func scanFits(start: UInt64, count: Int) -> Bool {
        guard indicesFit(start: start, count: count) else { return false }
        let (end, overflow) = start.addingReportingOverflow(UInt64(count))
        return !overflow && end <= lastScanned
    }

    /// Whether `p2pkKey` may answer for this index: inside 300 of the last index
    /// reserved, or inside a range a scan has served this app session.
    ///
    /// `served` is the end of the furthest `p2pkPubkeys` range this process
    /// answered, which is how `CounterStore.noteServed` records the same thing
    /// for a restore. A restore on a new phone is the whole point of the derived
    /// key: its index file starts at zero, so `next + 300` reaches nowhere near
    /// an index the old phone used, and the page finds the index by scanning for
    /// it. The scan is what opens the key it found.
    static func keyAllowed(index: UInt64, next: UInt64, served: UInt64) -> Bool {
        guard index <= lastIndex else { return false }
        if index < served { return true }
        let (limit, overflow) = next.addingReportingOverflow(beyond)
        return overflow || index < limit
    }

    // MARK: Deriving

    /// The pairs for indices `start ..< start + count`.
    ///
    /// The four hardened levels are the same for every index, so they are walked
    /// once and the parent is reused — as `NUT13.derive` does for a keyset's
    /// path. Each key on the way is wiped as soon as the next is made.
    static func derive(seed: NUT13.Seed, start: UInt64, count: Int) throws -> [Pair] {
        guard indicesFit(start: start, count: count) else { throw Failure.badIndex }
        return try NUT13.withContext { ctx in
            var parent = try NUT13.master(seed: seed, ctx)
            defer { parent.wipe() }
            for level in [purpose, account, 0, 0] as [UInt32] {
                var next = try NUT13.child(parent, level | 0x8000_0000, ctx)
                swap(&parent, &next)
                next.wipe()
            }
            // every index is a normal child of the same parent, so the parent's
            // public key — which is what a normal child hashes — is computed once
            let point = try NUT13.publicKey(parent.key, ctx)
            return try (0..<UInt64(count)).map { offset in
                let index = start + offset
                var child = try NUT13.child(parent, UInt32(index), ctx, publicKey: point)
                /* The chain code goes here and no further.
                 *
                 * This is the one place in Foxy where a private key leaves for
                 * the page, and it is a *non-hardened* child: with the parent's
                 * chain code beside it, anybody can run BIP-32's derivation
                 * backwards and get the parent, and from the parent every other
                 * index. The key is 32 bytes and the reply carries 32 bytes. */
                NUT13.wipe(&child.chain)
                let pub = try NUT13.publicKey(child.key, ctx)
                return Pair(index: index, privateKey: child.key, publicKey: pub)
            }
        }
    }

    /// The public keys for a range, with the private halves wiped here: nothing
    /// that answers `p2pkReserve` or `p2pkPubkeys` ever holds one.
    static func publicKeys(seed: NUT13.Seed, start: UInt64, count: Int) throws -> [[UInt8]] {
        guard count > 0 else { return [] }
        var pairs = try derive(seed: seed, start: start, count: count)
        defer { for i in pairs.indices { pairs[i].wipe() } }
        return pairs.map { $0.publicKey }
    }

    /// One index's pair. The caller wipes it.
    static func key(seed: NUT13.Seed, index: UInt64) throws -> Pair {
        guard let one = try derive(seed: seed, start: index, count: 1).first else { throw Failure.badIndex }
        return one
    }

    // MARK: Replies

    /// `p2pkReserve` and `p2pkPubkeys`: `{start, next, pubkeys}`, the hex
    /// lowercase and compressed, in index order. `next` is the index file's, so
    /// the page can see how far the phone has been asked to go without a second
    /// request.
    static func pubkeysReply(start: UInt64, next: UInt64, pubkeys: [[UInt8]]) -> String {
        let list = pubkeys.map { "\"" + NUT13.hex($0) + "\"" }.joined(separator: ",")
        return "{\"start\":\(start),\"next\":\(next),\"pubkeys\":[\(list)]}"
    }

    /// `p2pkKey`: `{index, privkey, pubkey}`. The page checks the public key
    /// against the one its row kept before it spends anything with the private
    /// half — a row left behind by a seed that has since been replaced derives a
    /// different key, and that mismatch is the only thing that catches it.
    static func keyReply(_ pair: Pair) -> String {
        "{\"index\":\(pair.index),\"privkey\":\"\(NUT13.hex(pair.privateKey))\",\"pubkey\":\"\(NUT13.hex(pair.publicKey))\"}"
    }
}
