# Live testing against a production mint

The Docker mints in `local-mint.sh` are fake-Lightning sandboxes. They cannot
show what a real mint does: its actual fee schedule, its keyset rotation, its
Lightning backend, or how a third-party wallet behaves against Foxy. A real
mint has shown things no sandbox did (below).

The real-money scenarios are the `real-*` ones in `offline-cross-scenarios.js`.
They run only when started with `FOXY_LIVE_REAL=1`, reach the mints through
Tor as the app does, and keep their wallets in `~/.foxy-live/real-pair/`
between runs. `FOXY_REAL_DRY=1` rehearses the same scenarios against the
fake-money mints first, so a change to them is run for nothing before it is
run for money.

## The rules

- **A person funds the wallet. No script and no test buys anything or tops it
  up.** A person starts every run that moves real money.
- When it is empty, it is empty: say so and stop, rather than ask for more
  mid-task.
- It lives in the **simulator** (or headless wallets), never on a phone used
  for anything else, under its own seed that holds nothing else.
- **The backup is a token, not the seed.** Money at rest is swept out to a
  Cashu token in `~/.foxy-live/`, and only what a run needs is claimed into
  the wallet. Nothing else needs writing down, so the twelve words are never
  revealed, never stored, and never pass through a transcript, which is also
  what the app's own backup screen asks for ("never save them on a
  computer"). The cost is that a crash mid-run strands whatever was in play;
  that is bounded by how little is claimed in.
- `~/.foxy-live/` is outside this repository, and outside any folder macOS
  syncs to iCloud (`~/Desktop`, `~/Documents`).
- Report the balance at the start and the end of any session that spends.

## What this buys, and what it costs

Real records at a real third party. Every run leaves a trace at the mint: a
melt quote, a swap, a Lightning payment. That is the point, because it is the
production behaviour no sandbox reproduces, but it is not a sandbox, and it is
worth remembering before each run.

## What production mints showed

- **A crossing between two production mints costs a flat 2 sats.** Lightning
  and the move-and-pay crossing, both directions, amounts from 1 to 300 sats:
  every crossing cost exactly 2 sats, nothing was left in between, and every
  wallet's entries added up after each one. A payment by Lightning to a mint
  whose reserve is 2 sats costs the whole reserve, with no change back.
- **A mint can turn Foxy itself away.** One production mint answered 429 to
  33 requests in a minute (an invoice asked about every two seconds, beside a
  first-contact restore). Each was retried on a fresh circuit. The watch now
  asks a mint that says so once in five seconds.
- **Implementations differ in NUT-06 `max_array_length`.** A production
  Nutshell 0.21.0 advertised 1000 and a production cdk-mintd 0.17.6 advertised
  500. Foxy's restore walk (100 per call) sits inside both.
- **A token from a mint Foxy is not on.** Pasted into a wallet at another mint,
  a 60 sat token was quoted (fee between 0 and 10, at least 50 net) and 50
  landed; the 6 sats of change stayed at the source mint rather than being
  spent chasing themselves, and the card says so ("left at the source"). A
  3 sat token was refused as not worth the fee to move, with FEE and NET drawn
  as dashes and the button reading to keep it where it is: the wallet stayed
  on its own mint and showed the other as a second balance.

## cashu.me cannot pay a Foxy payment request, and loses the money trying

Reproduced with real money, both wallets at the same mint.

Foxy's Cashu request QR carried exactly one transport, an onion:

```json
"t": [{ "t": "post", "a": "http://<onion address>/<path>", "g": [] }],
"a": 100, "u": "sat", "m": ["https://<mint>"]
```

cashu.me understands all of it. It decodes the amount, the unit and the mint,
switches to that mint, prefills 100, and draws the card "Payment request via
HTTP" with the onion address. Its `parseAndPayPaymentRequest` has a `POST`
branch and takes it.

Then, on PAY, in this order:

```
POST https://<mint>/v1/swap                -> 200
POST http://<onion address>/<path>         -> TypeError: Failed to fetch
```

**The swap happens first.** By the time the delivery fails, the money has
already moved at the mint: cashu.me's balance went down by 100, and the 100
sats never reached Foxy (its onion inbox was never contacted, because a
browser cannot resolve `.onion`).

And the token is then lost, not merely undelivered. cashu.me logged:

```
Could not persist ecash history token
DataCloneError: Failed to execute 'put' on 'IDBObjectStore': #<ps> could not be cloned.
```

The history row carries the `PaymentRequest` class instance, which is not
structured-cloneable, so IndexedDB refuses the whole row. Afterwards its
history holds only the incoming 200; the outgoing 100 is in no store, reserved
or otherwise. Those proofs are live unspent ecash at the mint, reachable only
by a seed restore, by someone who knows to try one.

So this is not "third-party wallets cannot pay a Foxy request". It is
**third-party wallets lose money trying**, and the surface that triggers it is
Foxy's own choice to advertise an onion as the only way to be paid.

The `DataCloneError` is cashu.me's bug and worth reporting upstream. The
onion-only transport is ours. Advertising a Nostr transport alongside the onion
lets a browser wallet take the path it can actually use; the privacy cost of
doing so is an ephemeral key per request and a gift-wrapped ciphertext left
sitting on relays.

The 100 sats were recovered with cashu.me's own restore wizard (Settings,
Backup & Restore, Restore ecash), driven with its own seed moved inside the
page so the words never left the browser: 16 restore and checkstate calls, and
the balance was back. That the proofs were recoverable at all is worth noting:
they were derived deterministically from cashu.me's seed (NUT-13), so the mint
could be walked for them. A wallet without deterministic secrets would have
lost them outright. The person would still have to know to try.

## The Nostr transport, and the bug a live run found

Foxy's request now carries both transports, Nostr first, which is what a
browser wallet needs:

```
1. nostr  nprofile1…  tags [["n","17"]]
2. post   http://<onion address>/<path>  tags []
```

cashu.me read it as `["nostr","post"]` and said it would pay over `nostr`. The
first attempt still failed, and failed silently, which is worse:

**Foxy asked the relays for the wrong window.** The subscription carried
`since: now - 60`, meaning "anything from the last minute". But a gift wrap's
`created_at` is deliberately random up to **two days** in the past (NIP-59, and
Foxy's own `NostrEvent.backdated` does it too), exactly so the timestamp says
nothing about when the message was really sent. About 0.03% of wraps would land
inside a one-minute window. The relays did as they were told and returned
nothing; cashu.me's 50 sats were swapped, published, and never collected. The
comment above `unwrap` in Foxy's own source says the wrap times "are
meaningless by design", and the filter read them anyway.

`since` now covers the whole backdating window plus an hour. The second run
worked: Foxy's log shows `nostr inbox: a payment arrived`, `a request was paid
over Tor: 50 sats; redeeming`, and cashu.me opened `wss://` to all four relays
and made no onion request at all, which is the point of the ordering. The 50
sats the first attempt stranded were recovered by the same restore. A Swift
test now pins the window against what `giftWrapped` actually produces, and it
fails against the sixty seconds this shipped with.

With Nostr listed first, two Foxys still go phone to phone: the paying side
logged `onion http: connected`, the receiver `onion inbox: a payment arrived`
and then closed its Nostr inbox unused, and nothing was published to any relay.
The ordering changes what a wallet that cannot reach an onion does, and changes
nothing for a wallet that can.
