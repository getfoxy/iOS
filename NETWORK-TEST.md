# NETWORK-TEST.md — watching what actually leaves the phone

The security review read the code and stopped there. It says so:

> The native network layer would need a live penetration test if the gate is
> upgraded to enforcement; this review stopped at the code.

This is that test, in the form one person with a Mac and a phone can run. It
answers the only question the network design exists to answer: **does anything
belonging to this app leave the phone outside Tor?**

Code review cannot answer it. Every routing change is a claim about runtime
behaviour, and this is the only thing that checks the claim.

---

## Which design each test covers

The app has changed under these tests. A result is evidence about the build it
was taken on, and nothing more.

| test | design under test | status |
|---|---|---|
| 1–3 | **The Orbot/VPN gate.** Orbot or a VPN outside the app, the old gate (`foxy-vpn-gate.js`, replaced by `foxy-tor-gate.js`) deciding in JavaScript whether to call `fetch`, a `check.torproject.org` probe, and an exposed mode entered with two taps. | **Superseded.** That gate no longer exists, and its three tests are not kept. |
| 4 | **Early embedded Tor.** Started by `FoxyWallet.torOn()` after the app had been entered in exposed mode; routing decided by checks in the page. | **Superseded.** |
| 5 | **Embedded Tor via `torOn()`**, mint calls through `customRequest` on the cashu-ts `Mint`. | **Superseded in how Tor starts.** The routing it confirmed, where every wallet is built by `newWallet()` with `customRequest`, is still what ships. |

After test 5, more captures were taken the same way (Internet Sharing over
USB, `bridge100`) during real sends on several mints. They showed no clearnet
traffic from the app. They were not written up here with packet counts and
hostnames as tests 4 and 5 were, so they are a finding, not a record.

Tests 1 to 5 were not taken on the current build as described in the next
section. One capture of it has been taken, from a fresh install with the phone's
only route the USB bridge: no mint or price host appeared in DNS or in TLS
server names over 42 mint requests in under a minute. The unprotected control
(test C below) had not been run, so that is evidence of no leak rather than
proof the capture could see one. The tests for the current build are listed
below; A has been run once as written, and B to E have not.

---

## The current design, in terms a capture can check

**Tor runs inside Foxy** (Tor 0.4.9.12, built here from signed sources, with Tor.framework 409.11.2's wrapper) and starts at
launch. It reaches the Tor network in one of three ways, tried in this order
without asking. Next launch it tries the one that last worked first.

- **direct**: connections to Tor relays
- **obfs4**: to the Tor Project's built-in bridge addresses in
  `Bridges.obfs4Lines`
- **Snowflake**: WebRTC to a volunteer proxy. The volunteer is found through a
  broker reached via a CDN (`1098762253.rsc.cdn77.org`, fronted as
  `app.datapacket.com` / `www.datapacket.com`) and public STUN servers, all
  listed in `Bridges.snowflakeLines` in `Foxy/Tor/Bridges.swift`. **These
  contacts go outside Tor by design.** They learn the phone is starting
  Snowflake. They never see a mint, an amount or a payment.

obfs4 before Snowflake is deliberate, and `TorTransport.order` says why: it is
the order that touches the fewest things outside Tor. It decides what tests A, B
and D should expect to see.

**The page cannot reach the network.** A `WKContentRuleList` blocks `http`,
`https`, `ws`, `wss` and `ftp`, installed before the page loads. The page's
Content-Security-Policy keeps `connect-src` to `'self' file: blob: data:`.

**Almost every native request goes through `Route.start`** (`Route.available` asks
first, without making a session). That means a Tor SOCKS session, made for the
request, when Tor is ready. It means an ephemeral session with no cookies or
cache only if the person chose CONTINUE UNPROTECTED and confirmed it in the
iOS alert. Otherwise the request is refused before a socket opens. Every
session re-checks redirects and never follows one to another host.

The exception is `Foxy/Network/OnionPost.swift`, which speaks SOCKS5 to Tor's
port itself over an `NWConnection`, because ATS refuses plain HTTP to an `.onion`
through URLSession. It does not ask `Route`: it checks `TorService.isRunning`
and `TorService.socksPort` directly and refuses with `.noTor` when Tor is not
running, and it never uses the ordinary connection. The gate holds, but a
reviewer bounding the search by `Route.start` would miss it. The WebSockets
(below) go through `Route.startSocket`.

**Orbot.** Foxy asks Orbot's local API on `127.0.0.1:15182`. That is loopback
and never leaves the phone. With a bypass key the person approved in Orbot,
Foxy's Tor reaches its relays, or its bridge, through Orbot's bypass SOCKS
port. Those connections leave the phone directly rather than inside Orbot's
tunnel. Requests still go only to Foxy's Tor.

**What must not appear**, unless the person continued without Tor:

- any mint host
- any price host: `api.kraken.com`, `www.bitstamp.net`, `blockchain.info`,
  `api.gemini.com`, `api.coinbase.com`. The first price source is mempool's
  onion, which has no name to look up and no server name to read: it should
  never appear in a capture at all, whatever the outcome.
- any lightning-address host being paid

Check both DNS and TLS server names. `check.torproject.org` belonged to the old
gate's probe, so it should not appear in a Release build at all; a Debug-only
diagnostic (`ResumeDiagnostics.torRequest`) still asks it, through Tor.

---

## Why not just use Wireshark on the phone's Wi-Fi

Two approaches look obvious and give the wrong answer.

**A proxy (Proxyman, Charles) won't work.** It sees only traffic the app is
configured to send through it. Tor traffic bypasses it entirely, which is
exactly the traffic in question, and a leak that goes direct would also skip
the proxy. You would see a clean capture and learn nothing.

**`rvictl` is closer but ambiguous.** It mirrors the device's network stack,
so packets heading *into* a tunnel appear alongside packets going out of it.
A mint request that is correctly tunnelled and one that leaks can look similar
in the dump, and telling them apart means reasoning about interface indices.

**Sharing the Mac's connection to the phone is decisive.** Everything the
phone sends crosses one interface on the Mac, after any tunnelling has already
happened. If `mint.minibits.cash` appears there in the clear, it left the
phone in the clear. There is nothing to interpret.

---

## Setup, once

**1. Point the phone at the Mac.**

System Settings → General → Sharing → Internet Sharing.
Share from **Wi-Fi** (or Ethernet), to **iPhone USB**. Plug the phone in and
turn Internet Sharing on. Turn the phone's Wi-Fi **off** and cellular **off**,
so the USB link is its only way out.

**2. Find the interface the phone is on.**

```bash
ifconfig | grep -A2 bridge
```

You want the one with an address like `192.168.2.1`. It is usually `bridge100`.

**3. Confirm the phone is really going through it.**

```bash
sudo tcpdump -i bridge100 -n -c 20
```

Open Safari on the phone and load anything. If lines appear, you are capturing
the phone's traffic and nothing else. Ctrl-C.

**4. Before trusting a capture, confirm what the app is doing.** Test 5 below
records why. A capture of an app whose requests were never routed looks
exactly like a clean one.

---

## Tests for the current design

Each one: start the capture, do the thing on the phone, stop the capture, read
it. Keep the files.

### A — from a fresh install to the first payment

Test 5's method, on a build where Tor starts at launch. Run once on the current
build, without the mint switch and the seed scan (see above). Start the capture
before the app is installed. Delete Foxy, install, first launch, wait for Tor,
connect a mint, receive a payment, send one, switch mints, run a seed scan.
Mint switching and seed scans are the paths that leaked in test 4.

**Expect:** relays, or Snowflake and its broker and STUN contacts, or obfs4
bridges. No name belonging to the app.

### B — Tor cannot connect

On a network where Tor does not connect, leave Foxy on **CANNOT CONNECT TO
TOR** for two minutes. Tap around, background it and reopen it twice. Do not
tap CONTINUE UNPROTECTED.

**Expect:** attempts to reach relays, Snowflake's broker and STUN servers, and
obfs4 bridges. No mint, no price feed, no lightning-address host. **This is
the test that matters,** the counterpart of old test 2.

### C — continue unprotected, as a control

From B, tap CONTINUE UNPROTECTED and confirm in the iOS alert. Pull to refresh.

**Expect:** the mint and a price host **in the clear**. If they do not
appear, the capture is not seeing the app and A and B prove nothing. If Tor
then connects, those names should stop.

### D — Orbot running, with Foxy allowed past it

Orbot on, ALLOW FOXY IN ORBOT approved, a payment made. **Not yet tested with
real Orbot on a phone.** The simulator has been tested only against a fake
Orbot.

**Expect:** Orbot's own traffic, and Foxy's Tor traffic to relays or bridges
going out directly. No mint names.

### E — background and foreground

Mid-session, background Foxy for several minutes, bring it back, make a
payment. Returns from the background have been run on a phone, with Tor
re-established in seconds, but not under a packet capture.

**Expect:** nothing belonging to the app outside Tor, at any point. Tor's
network goes off as Foxy leaves. On return a private connection is set up as
at launch, behind CONNECTING TO TOR, and a bridge transport restarts. Requests
are refused until Tor announces a new circuit, and nothing should leave outside
Tor meanwhile.

### A check without a packet capture

Debug builds accept `-FoxyNetBlockTest YES`. Two seconds after the page loads,
it tries a `fetch`, a WebSocket, a `<link rel="preconnect">`, a DNS prefetch, a
prefetch, an image, `navigator.sendBeacon` and a blob worker's `fetch`, and logs
`[netblock]` with what the page could see. Some of those loads never tell the
page whether they went anywhere, so point them at a listener with
`-FoxyNetBlockHost HOST:PORT` and watch whether a connection arrives there.

Two things stand between the page and the network, and each has a control
flag, so each can be shown to matter:

- the content rule list, which blocks http, WebSocket and ftp loads
  (`-FoxyNetBlockOff YES` skips it)
- a dead-end proxy on the web view's data store: every
  connection its network process opens goes to a SOCKS proxy on 127.0.0.1:9,
  where nothing listens, with no failover. A preconnect is a connection WebKit
  opens on its own and may not pass the rule list (`-FoxyWebProxyOff YES`
  skips the proxy)

On the simulator, with a TLS listener on the Mac's LAN address and a
logging SOCKS listener on port 18090 (`-FoxyWebProxyPort 18090`):

- **Proxy off, aimed at example.com:** `fetch`, the WebSocket and the worker were
  blocked and the beacon refused, but the page's preconnect, prefetch or image
  still opened a direct TCP connection to example.com. The rule list and the page
  policy do not stop those.
- **Proxy on, aimed at example.com:** that connection went to the SOCKS listener
  instead (`CONNECT example.com:443`), and no direct connection was seen. With the
  dead end on port 9 it fails.
- **Proxy on, aimed at the Mac's LAN address:** three TLS hellos still arrived
  directly. iOS does not send local-network addresses through the proxy, so a
  script in the page could still reach a device on the same network. It could not
  learn the phone's public address that way.

This checks the page's side only, not the native side.

---

## Reading the captures

```bash
python3 tools/read-capture.py capture.pcap
```

It lists every hostname the phone asked for and every IP it talked to, and
flags the ones that should not be there. **At volume it invents hostnames**
(see test 4), so check its verdict against tcpdump's own parsing.

To look by hand instead:

```bash
# every hostname the phone looked up
sudo tcpdump -r capture.pcap -nn port 53 2>/dev/null | grep -oE "A+\? [a-z0-9.-]+" | sort -u

# every server name in a TLS handshake
sudo tcpdump -r capture.pcap -n -A 2>/dev/null | grep -o '[a-z0-9.-]*\.\(cash\|com\|space\|org\|io\|net\|info\)' | sort -u
```

---

## Test 4 — embedded Tor, with Orbot off

> **Superseded design:** Tor started by `FoxyWallet.torOn()`, after the app had
> been entered in exposed mode. Tor now starts at launch and there is no
> exposed mode.

Foxy running its own Tor via `Tor.framework`, Orbot off, Wi-Fi and cellular
off, phone on the Mac's shared connection.

The first attempt was taken across the whole session and could not answer
anything: the app had been entered in exposed mode to get past the gate, so
clear-net mint traffic was expected for part of it. Started again after
`torOn()` and `connect()` had both succeeded, so everything captured was from
the Tor era.

Over two minutes the peers were Tor relays, plus ordinary traffic from the
phone itself to Apple. And one leak:

    Type65? mint.macadamia.cash
    AAAA?   mint.macadamia.cash
    TLS SNI:  mint.macadamia.cash

A full TLS handshake to a mint the wallet was not connected to. Nothing else,
which made it easy to chase.

**Cause, as first understood.** Five places construct a `CashuTS.Wallet` and
only `connect()` had been given `customRequest`. A seed scan across the default
mint list opened its own connections with plain `fetch`, which is why macadamia
appeared and Minibits — the connected mint, going over Tor — did not.

Fixed by routing every construction through one `newWallet()` helper, with a
smoke check that fails the build if a raw construction reappears. (Test 5
found the explanation was incomplete, and the WebSocket section below found
another cause.)

**A note on the reader.** `tools/read-capture.py` reported dozens of hostnames
including `2.3.7m.io` and `a.g.b.vn.se.n.io`. Those are not real: it scans raw
bytes for domain-shaped patterns rather than parsing DNS, and at this volume it
invents them. Its verdict should be checked against tcpdump's own parsing
(see "Reading the captures").

**Still to do:** exercise a mint switch and a seed scan deliberately on the
fixed build — the paths that leaked. Test A includes both; the one run of it so
far was a fresh install to a first payment and did neither.

---

## Test 5 — from a fresh install to the first payment, over embedded Tor

> **Superseded in how Tor starts:** Tor was turned on by `FoxyWallet.torOn()`,
> not at launch. The routing this test confirmed — `customRequest` on the
> `Mint`, every wallet built by `newWallet()` — still ships.

The strongest form of the question: from the moment the app is installed, does
the mint ever see this device's address?

Method as before — phone on the Mac's shared connection, Wi-Fi and cellular
off, Orbot off — but the capture was started *before* the app existed. Then:
delete Foxy, install from Xcode, first launch, seed generated, Tor bootstrapped,
mint connected, invoice created, payment received.

**Every hostname the phone resolved in the whole session** was the operating
system's own: Apple's install and iCloud services, and other traffic from the
phone that had nothing to do with Foxy. **No mint, no price feed, no
check.torproject.org.** Not one name belonging to this app.

The busiest peers were two addresses carrying a few thousand packets between
them: Tor relays, with everything inside them.

### What made this capture mean something, when three earlier ones did not

**Routing was verified before the capture started.** `nativeRequest` was wrapped
in a logger and `connect()` called; three `REQ` lines confirmed mint calls were
going over the bridge. Without that check a capture proves nothing, and the
earlier ones proved nothing:

**Capture 3 was read as a success and was not.** `customRequest` had been passed
in `Wallet`'s options, where it is silently ignored — it belongs on `Mint`. So
cashu-ts used its own `fetch` throughout, and the absence of proxied SNI was
read as "the proxy works" when it meant "nothing was proxied". mint.macadamia.cash
appeared in DNS and TLS and was blamed on a stray code path; it was every mint
call.

**Capture 1 covered the whole session**, including the period before Tor was
up, so clearnet mint traffic was expected and told us nothing.

**And the reader lies at volume.** `tools/read-capture.py` scans raw bytes for
domain-shaped patterns rather than parsing DNS; at tens of thousands of packets
it reported dozens of hostnames including `2.3.7m.io` and `a.g.b.vn.se.n.io`,
none of them real. Check its verdict against tcpdump's own parsing of DNS
(see "Reading the captures"), which lists every name the phone looked up, the
question being asked.

### What is not established

One device, one session, one set of mints. The phone was not quiet, and better
evidence would be a capture with nothing else running, though Foxy's absence
from a busy capture is arguably the more striking result.

And this is embedded Tor as it was then, which did not start at launch: it was
`FoxyWallet.torOn()`, with the gate-and-Orbot path still in place beside it.
Tor now starts at launch and the gate is gone; the one capture of that build is
described at the top of this file and under test A.

---

## Every place that can originate a call

Established by counting call sites. Debug-only diagnostics are not listed.

| where | what | how it is routed |
|---|---|---|
| `Web/foxy-wallet.js` | 3 × `fetch`: the price list, Kraken candles, and the lightning-address lookup | Each is the path taken **only with no native side** (a desktop browser, the tests). In the app, price and candles go to the native `price` and `candles` actions, and the lightning-address lookup to `mintRequest`. The content rule list would block them regardless. |
| `Web/cashu-ts.js` | its request function, and its WebSocket code | The request function is replaced by `customRequest` on the `Mint` every wallet is built with, in `newWallet()` (smoke check 13). The WebSocket code is never called (smoke check 14), and the rule list blocks `ws`/`wss`. |
| `Foxy/Bridge/FoxyBridge.swift` | `price`, `candles`, `mintRequest` | `Route.start`: Tor, or the ordinary connection after CONTINUE UNPROTECTED, or refused. Tor's session is made per request and invalidated once its task has started (smoke check 17e). `mintRequest` accepts only `https`, or `http` to an `.onion` host, that passes the host checks. Every session re-applies those checks to redirects and does not follow a redirect to another host. |
| `Foxy/Bridge/FoxyBridge.swift` | `share`: the system share sheet | Not a request from Foxy, but the share sheet can fetch a preview of a link it finds, from its own process and outside Tor. It is handed a `ShareText` that supplies its own header metadata (a title, no URL) and plain text, so it has nothing to fetch (smoke check 17f). Once the person sends the text, the receiving app — Messages, Mail — may preview a link in it; that is outside Foxy. |
| `Foxy/Network/OrbotLink.swift` | `OrbotLink`: `GET /info` to `127.0.0.1:15182` | Raw TCP on loopback. It does not leave the phone. |
| `Foxy/Network/OrbotLink.swift` | `orbot:request/token…` (no `//`) | Opens Orbot. Not a network request. |
| `Foxy/Network/OnionPost.swift` | `onionPost`: a payment to a payee's version 3 `.onion` address | Its own SOCKS5 connection to Tor's port over an `NWConnection`. It checks `TorService.isRunning` and `socksPort` itself and refuses with `.noTor` otherwise, and takes only `http://` to an `.onion` host. |
| `Foxy/Network/OnionInbox.swift` | the onion inbox: a listener, while a payment request is on screen | Bound to `127.0.0.1` only and published by Tor as a hidden service, so it takes connections from Tor and from nothing else. It originates nothing. |
| `Foxy/Nostr/NostrDelivery.swift` | `nostrSend`: a payment wrapped for a receiver's Nostr key | `wss` WebSockets to at most five relays the request names, or to the four built in (`relay.damus.io`, `nos.lol`, `relay.primal.net`, `relay.minibits.cash`), through `Route.startSocket`: over Tor, each on its own circuit, or refused. |
| `Foxy/Nostr/NostrInbox.swift` | listening for a payment while a request is on screen | The same four relays, up to four sockets, through `Route.startSocket`. |
| Tor.framework, IPtProxy | Tor's own connections | Relays, bridges, and Snowflake's broker and STUN contacts. Through Orbot's bypass port when Orbot has let Foxy past. |

**Originate nothing:** `foxy-tor-gate.js`, `foxy-send-progress.js`,
`build/foxy-app.js`, `bip39.js`, `qrcode.js`. The design runtime in
`index.html` has no `fetch` call of its own (the one mention is a comment), and
the rule list blocks anything else.

### Bluetooth — a second radio, outside every capture in this file

A receiver's phone advertises over Bluetooth LE while an invoice is on its screen
(it arms itself by default; with AUTO TAP TO PAY off, from the press of TAP)
until a payer subscribes, and the ecash itself crosses that link
(`Foxy/Bluetooth/`, `TAP-TO-PAY.md`). **No capture method in this file can
see it**: Internet Sharing and `tcpdump` on `bridge100` watch IP traffic, and
this never becomes IP traffic. It does not pass through Tor and is not meant
to — it does not leave the room.

What that means for this document's question: a payment made by tap puts
nothing on the network at all, which is the strongest answer there is, and in
exchange puts a radio signal in the air that says a payment is happening here
and now. `TAP-TO-PAY.md` has what a listener learns; §22b of `DEVICE-TESTS.md`
records a third phone's view of it: no name in the advertisement, and one
extra service whose characteristics give nothing to a phone that has not done
the handshake.

### The WebSocket

`cashu-ts` can open `wss://<mint>/v1/ws` for NUT-17 quote subscriptions. A
socket opened from the page does not go through `customRequest`, and nothing in
a web view can point one at a native SOCKS session. It would resolve and
connect in the clear.

That is what leaked `mint.macadamia.cash` in capture 4 — not a stray `fetch`,
which is where the search kept going.

The *page* never opens one. The subscription was removed from the wallet, and
smoke check 14 fails the build if one reappears — though the check reads only
the page's files, so it is a claim about the page and not about the app. The
content rule list also blocks `ws` and `wss` from the page. Polling does the
same job, a few seconds slower on a received payment.

Native code does open WebSockets: `Foxy/Nostr/NostrDelivery.swift` to publish a
payment, and `NostrInbox.swift` to listen for one on up to four public relays
while a payment request is on screen. Both go through `Route.startSocket`, so
both are over Tor or refused, and the relay hostnames are in the inventory
above. (An earlier version of this section said a socket is never opened, which
is true of the page and false of the app.)

No other Cashu wallet solves this: cashu.me and Minibits have no Tor, and
Zeus's Tor library proxies HTTP rather than WebSockets. Skipping the
subscription is the only option available on this platform.
