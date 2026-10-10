# DEVICE-TESTS.md — what only a phone can prove

Most of what Foxy does is covered by the JS and Swift tests and by the simulator
scripts. This is the list of what only a phone can show. Work through it with a
phone you can afford to experiment on, a Mac with this repository, and the
twelve words of any wallet you use written down first. Note each result with the
log lines or the capture that show it.

**Use test money only.** Every money step here uses a test mint
(`https://testnut.cashu.space` pays fake sats) or a few sats you would not miss.
Some tests erase or reinstall things, or change the phone's passcode (§2, §7,
§10, §12d); they say so in bold.

## How this file is arranged

| Part | What is in it |
|---|---|
| [0. Setup](#0-setup) | Build, install, capture the log, launch arguments, watch the traffic. Read once. |
| [1. Standing tests](#part-1--standing-tests) | What to run on **any** build, grouped by area. This is the tester's list. |
| [2. Status](#part-2--status) | Which sections have been run on a device, and which have not. |

The test numbers (§1, §5a, §13c, §21e …) are the ones the other documents
already use, so they have **not** been renumbered — only regrouped. A number
that looks out of order is in the area it belongs to, not in the order it was
written.

**"Simulator only" in the status table is not a pass on a device.** That is
worth having — it proves the logic — but it is not the device behaviour. Do not
promote it to a pass without a phone run.

## What cannot be run in a simulator

These need a physical iPhone. Everything else can be exercised on a simulator
first.

| Needs a phone | Which tests | Why |
|---|---|---|
| The network capture | §2, §3, §21a, and the capture legs of §4, §6 | The phone's USB bridge, with its Wi-Fi and cellular **off**, is the only way to be sure the capture sees everything the app sends |
| Face ID | §12b, §21d, and the Face ID legs of §8 and §14a | Enrolling Face ID in a simulator is a GUI-only action, so it cannot be driven or trusted |
| Startup timing | §1, and §21b's 4-to-5-second claim | A simulator runs on the Mac's network and its clock; its timings say nothing about a phone |
| Bridges | §4, §5e | Snowflake and obfs4 behaviour, and how long they really take |
| Orbot | §6 | The VPN check is the part the simulator could not test at all |
| Long suspension, and the reclaimed control listener | §5b, §5i (for real, not `-FoxyTorStall listener`) | Only iOS suspends an app and reclaims its sockets |
| Screen recording | §9, §14a step 3, §14b step 2, §14c step 4 | Control Center's recorder, and what the recording itself contains |
| Anything with a camera | §17 (scanning another wallet's QR), §18 (animated QR), §20 steps 2–4 | No camera in a simulator |
| The phone's own passcode and backups | §7, §12d | Erasing, restoring from a Finder backup, and turning the passcode off |
| **Tap to pay** | §F, all of it | A simulator has no Bluetooth. `tools/sim` has a stand-in for the link that carries a tap between two simulators over loopback (`tools/sim/README.md`): it tests the pages and the bridge, not the radio (range, RSSI, edges, a link dropped by walking away). `TapCryptoTests.swift` and `TapSessionTests.swift` cover the handshake and run both roles against each other; `TapProtocolTests.swift` covers the framing and the proximity rule. The radio itself needs **two** phones |

---

## 0. Setup

### Build and install a Debug build

```bash
cd iOS                        # the clone
sh tools/build-iptproxy.sh    # once: obfs4 and Snowflake from pinned sources (needs Go 1.25+)
python3 tools/smoke.py        # must end "clean — build it"
. ./local.env                 # exports FOXY_DEVELOPMENT_TEAM, for a phone; skip it for the simulator
xcodegen generate
bash tools/build-tor.sh       # once, and after a Tor update: tens of minutes
LANG=en_US.UTF-8 pod install
open Foxy.xcworkspace
```

**Clean the build folder once after Tor changes** (a new `build-tor.sh` build,
or the move from the prebuilt pod): in Xcode, Product → Clean Build Folder
(⇧⌘K), then Run. Xcode keeps its own copy of `tor.xcframework` and did not
refresh it when the pod moved to `Vendor/TorPod`, so a simulator app kept
linking the old prebuilt Tor 0.4.9.11. **Pass:** at launch Console shows
`Tor 0.4.9.12` and `OpenSSL 3.6.4` on the line that begins `Tor 0.4.9`. If it
still says `Tor 0.4.9.11`, quit Xcode, delete
`~/Library/Developer/Xcode/DerivedData/Foxy-*`, and run again.

**The order matters.** `xcodegen generate` rewrites the Xcode project, and
`pod install` then adds Tor to it. The other way round, the project has no Tor,
and the build stops with "Tor.framework is not linked". Run both again, in this
order, whenever `project.yml` or the `Podfile` changes.

Signing: `project.yml` reads the team from `FOXY_DEVELOPMENT_TEAM`, so put
`export FOXY_DEVELOPMENT_TEAM=XXXXXXXXXX` in `local.env` (not tracked) and run
`xcodegen generate` with it set, as above. A team chosen in Xcode's UI is lost
the next time the project is generated. Plug the phone in, pick it as the run
destination, Product → Run. Foxy needs **iOS 17 or later**.

### Capturing the log

**Untick "Debug executable" first.** Product → Scheme → Edit Scheme → Run →
Info. A debugger stops iOS suspending the app at all, so every background,
resume and suspension test below is void while one is attached — and it will
look like a pass, because the bug cannot happen. This is not optional
tidiness: it is the difference between a result and a guess.

Debug builds write every `[foxy]`, `[foxy-js]`, `[resume]` and Tor bootstrap
line to a file inside the app container (`Foxy/Debug/DebugLog.swift`). After a
test, pull it:

```bash
sh tools/pull-device-log.sh            # or: sh tools/pull-device-log.sh <udid>
```

It copies the log to `<timestamp>/foxy-all.txt` under `~/Desktop/foxy-evidence`
(a second argument names another folder) and prints the lines that decide each
result. It needs no sudo, no cable and no
`libimobiledevice`: it talks to the phone the way Xcode does, which is why it
works where `log collect` answers "Device not configured (6)" for a phone
reached over the network.

The file's first lines are a banner giving the build, the launch arguments that
were set, and **whether a debugger was attached** — so a log cannot later be
mistaken for a valid suspension run. Note the file name, not a description of
what you saw.

Tokens, invoices and long hex are redacted on the way in, but the log still
names mint hosts and amounts. Treat it as sensitive and delete it when done.

Console.app still works for watching live, and is the only option for a
Release build, which writes no file at all by design (§11).

### Launch arguments

Product → Scheme → Edit Scheme → Run → **Arguments Passed On Launch**. Tick the
ones a test asks for and untick the rest afterwards. Available in Debug builds
only:

| Argument | What it does |
|---|---|
| `-FoxyForceTransport direct` / `snowflake` / `obfs4` | Tor uses this transport first |
| `-FoxyDirectPatience 1` | Direct Tor gives up after 1 second, so the fallback runs |
| `-FoxyBridgeTest YES` | After each circuit, logs a check of Tor's listeners and one request through Tor |
| `-FoxyNetBlockTest YES` | Two seconds after the page loads, tries a fetch, a WebSocket, preconnect, DNS prefetch, prefetch, an image, a beacon and a worker's fetch from the page and logs `[netblock]` |
| `-FoxyNetBlockOff YES` | Skips the page's network block — only as the control run for `-FoxyNetBlockTest` |
| `-FoxyWebProxyOff YES` | Skips the web view's dead-end proxy (every connection its engine opens goes to 127.0.0.1:9 and fails) — only as the control run for `-FoxyNetBlockTest` |
| `-FoxyNetBlockHost HOST:PORT` | Where `-FoxyNetBlockTest` aims its preconnect, prefetch, image, beacon and worker attempts (default example.com), so a listener there shows whether any connection arrived |
| `-FoxyWebProxyPort N` | Points the web view's proxy at 127.0.0.1:N instead of the dead end on port 9, so a SOCKS listener there shows which of the page's connections the proxy carries |
| `-FoxySeedSelfTest YES` | On the fake-money mint `nofee.testnut.cashu.space`: claims 100 sats, sends and takes back a 21-sat token, scans this wallet's own seed with no words, logs the phone's counters for the keysets that scan walked (when the page offers `counterSnapshot`), and logs one `[nativesecretstest]` line ending `PASS` or `FAIL …` |
| `-FoxySeedScreenTest show` / `verify` / `enter` / `counters` / `wipe` | Three seconds after the page loads, asks the bridge from the page for the seed actions (§14) and logs one `[seedscreentest]` line with each answer, secrets as counts only. Makes a seed if there is none. `wipe` asks to delete the seed |
| `-FoxyTorStall auth` | Every reply to Tor's control authentication is dropped until RESTART TOR or RETRY is tapped: a hang a phone once showed, on demand (§5h) |
| `-FoxyTorStall listener` | The TCP control port is treated as refused once, as iOS leaves it after reclaiming a suspended app's sockets, so the recovery runs on demand (§5i) |
| `-FoxyKeychainTest YES` | At launch, checks the keychain rules on scratch entries — a different seed refused without replace, the Orbot key stored — and logs `[keychaintest]` lines. It only reads the wallet's own seed |

### Driving Foxy from outside (deep links)

Debug builds register the `foxy://` URL scheme, so a test can be put straight on
the screen it is about instead of tapping its way there. Release builds register
no scheme and ignore the parameters (`WebHostController.receiveDeepLink`,
`applyDeepLink` in `build/app/05-device-shell.js`, `tests/deep-links.js`).

```sh
xcrun simctl openurl booted "foxy://receive?amt=50&unit=sat&rail=cashu"
```

iOS asks **Open in "Foxy"?** first — that is the system, not Foxy, and nothing
reaches the app until Open is tapped. On a headless simulator the alert is
waiting even though the command returned, so tap it (or use the Simulator
window) before looking for the result.

It works on a phone too — paste the URL into Safari or Notes and tap it — and it
works whether Foxy is already open or not: a link that launches it is applied as
soon as the page has loaded. Each one logs a `[deeplink]` line, so
`sh tools/pull-device-log.sh` shows what arrived and what was dropped.

| Link | Where it lands |
|---|---|
| `foxy://home` | The home screen |
| `foxy://receive` | The amount keypad, receiving |
| `foxy://send` | SEND — the ways to pay |
| `foxy://token` | The amount keypad, making an ecash token |
| `foxy://nfc` | The home screen (the payer listens from home, so there is no tap screen) |
| `foxy://split` | Split a bill, at its keypad |

| Parameter | Values | Where it applies |
|---|---|---|
| `amt` | Digits, at most two decimal places | `receive`, `token`: the figure typed on the keypad, in whatever `unit` says. `split`: **cents**, the way that keypad counts — `amt=200` is $2.00, its minimum |
| `unit` | `sat` / `sats` / `usd` | `receive` and `token` (default `usd` for both) |
| `rail` | `lightning` / `cashu` / `onchain` | `receive` — also sets the default network a receive opens on, since that is what NEXT reads. `split` takes `lightning` or `cashu` only |

Anything unrecognised — an unknown screen, key or value, a fraction of a sat, a
decimal on the split keypad — is dropped, and the screen still opens. Nothing is
applied to a hash without `foxy=` in it.

### Reading the logs without Xcode attached

A debugger stops iOS from suspending the app, which hides the background bugs.
For any test involving the background:

1. Edit Scheme → Run → Info → **untick "Debug executable"**. Xcode still
   installs and launches with the arguments, but attaches no debugger.
2. Open **Console.app** on the Mac, select the iPhone in the sidebar, click
   **Start streaming**.
3. Search `Foxy`, then narrow with `[foxy]`, `[foxy-js]`, `[resume]` or
   `tor gate`.

Debug builds send every `[foxy]` line to the system log. Release builds send
nothing, which test 11 checks.

### Watching the phone's traffic

The capture setup is in `NETWORK-TEST.md` → **Setup, once**: Internet Sharing
from the Mac to **iPhone USB**, the phone's Wi-Fi and cellular off, capture on
`bridge100`. Start a capture with:

```bash
sudo tcpdump -i bridge100 -n -w foxy-TESTNAME.pcap
```

Stop it with Ctrl-C. Read hostnames and TLS names with the commands in
`NETWORK-TEST.md` → **Reading the captures**.

---

## Part 1 — Standing tests

Run these on any build. They are grouped by area, not by the build that first
needed them.

**Before any of them.** Test money only: `https://testnut.cashu.space` or a mint
you added for testing. Debugger detached and Console.app streaming, as in the
setup above, unless a step says otherwise.

**Menu paths.** BACKUP is at the top of the menu until the words are verified,
and under SETTINGS after that. RESTORE, LOGS, SET PIN and the AUTO TAP TO PAY
and USE FACE ID switches are under MENU → SETTINGS. SPLIT is SPLIT A BILL.

### A. Tor, the network, and what leaves the phone

#### 1. Startup time

*Needs a phone.*

In the simulator Tor sat at 0% for about 14 seconds before its first network
activity, traced to `timegm` calls that are slow only in the simulator. On a
phone this should be well under a second.

1. Launch Foxy with the debugger attached, arguments `-FoxyForceTransport direct`.
2. In Xcode's console, note the times of `Bootstrapped 0% (starting)`,
   `New control connection opened`, and `[foxy] tor: circuit established`.

**Pass:** under 2 seconds from `Bootstrapped 0%` to the control connection.
Write down the time to `circuit established`.

On a phone, a cold install usually reaches a circuit in about 13 seconds and
the price in about 16. It stands still once, at 50% (`loading_descriptors`), for
5 to 6 seconds and then moves quickly to 100%; none of that comes near RESTART
TOR's 10 seconds. A slow relay at the descriptor step is what makes the rare
long one.

**First launch after installing.** A new install downloads Tor's whole relay
directory, and a download from a slow relay used to hang: the launch screen sat
at 30% for over 30 seconds until the app was killed and reopened. Foxy now
starts Tor's connections again after 5 seconds in which Tor read nothing.

1. Delete Foxy from the phone, then Product → Run.
2. In Console, search `tor: no data for`, then `circuit established`.

**Pass:** the launch screen reaches the home screen without killing the app,
within 45 seconds. Each `no data for 5s at N%` line is a nudge; write down how
many there were and the time to `circuit established`. Repeat twice.

A run that sits at one percentage is not necessarily stalled. The watchdog
counts **bytes** (`traffic/read`), not the percentage, on purpose: the comment
on the stall watchdog in `TorService.swift` explains that restarting a slow
first handshake would stop it ever finishing. `loading_descriptors` is a long phase where the
percentage jumps coarsely while bytes trickle — the slow run above was fetching
9,315 microdescriptors. The log cannot currently tell "slow" from "stalled",
because the byte counter is never written down; if a stall is ever suspected,
that is the thing to start logging.

#### 2. Fresh install to first payment, with a capture

*Needs a phone: the capture only means anything over the USB bridge.*

**This deletes Foxy and whatever wallet it holds.** Write the words down first.

1. Start a capture (`foxy-fresh.pcap`) before deleting the app.
2. Delete Foxy. Install and launch it from Xcode.
3. Wait for Tor. Add the test mint, receive a payment, send a token, switch
   mints once, run a seed scan (Restore).
4. Stop the capture.

**Pass:** in the capture, only Tor relays (or Snowflake / obfs4 contacts, if a
fallback ran). No mint, price or lightning-address hostname anywhere. The
wallet worked end to end.

#### 21a. All traffic over Tor — the capture

*Needs a phone: the capture only means anything over the USB bridge.*

Setup is NETWORK-TEST.md "Setup, once". The part that decides whether the
capture means anything: **the phone's Wi-Fi and cellular must be off**, so the
USB bridge is its only way out. A clean capture means nothing unless that was
true, so write it down with the result.

```bash
ifconfig | grep -A2 bridge          # usually bridge100, address 192.168.2.1
sudo tcpdump -i bridge100 -n -c 20  # load anything in Safari; lines = capturing
```

Then, from a **fresh install** (delete Foxy first):

```bash
sudo tcpdump -i bridge100 -w foxy-fresh.pcap
```

Launch Foxy, let it reach a circuit, let the price load, make an invoice,
receive a payment, send one, and close. Ctrl-C.

```bash
python3 tools/read-capture.py foxy-fresh.pcap
sudo tcpdump -r foxy-fresh.pcap -nn port 53 2>/dev/null | grep -oE "A+\? [a-z0-9.-]+" | sort -u
sudo tcpdump -r foxy-fresh.pcap -n -A 2>/dev/null | grep -o "[a-z0-9.-]*\.\(cash\|com\|space\|org\|io\|net\|info\)" | sort -u
```

**Pass:** the only hostnames looked up are Apple's. No mint host, no price
host, and in particular **no `mempool.space`** — the first price source is now
a `.onion`, which is resolved inside Tor and can never appear in a DNS query or
a TLS SNI. Everything else is TCP to a handful of relay addresses. The reader
invents hostnames at volume (see test 4), so believe the two tcpdump lines over
its verdict.

Two choices keep this capture quiet, and both are worth confirming by eye:

- the clearnet mempool.space price source was removed entirely
- the keyset cache (5 minutes, GET only, three paths) means fewer repeat
  requests to the mint

**Then prove the capture can see a leak at all.** This is the half that was
missing, and without it a clean capture is worth much less than it looks: an
app that is silent and an app that is perfectly tunnelled produce the same
empty DNS list, and so does a capture that is pointed at the wrong interface.

Run it again, same setup, but tap through to **CONTINUE UNPROTECTED** at the
gate, then make an invoice.

**Pass:** `mint.minibits.cash` now **does** appear in the DNS and SNI lists.
That is the result you want here. It says the method works, which is what makes
the first capture's silence mean something. (The home banner should also be red
and read IP Address Exposed — 21d.)

Also run the page-side check, which needs no capture:

```
-FoxyNetBlockTest YES
```

**Pass:** the `[netblock]` line shows the page could not reach anything.

#### 3. Tor cannot connect, and the unprotected control

*Needs a phone.*

**Read first:** this blocks the phone's traffic on the Mac with `pf`, so
Tor, Snowflake and obfs4 all fail. DNS still works. If anything below behaves
oddly, run the undo line and turn Internet Sharing off and on.

```bash
echo 'block drop quick on bridge100 inbound proto { tcp, udp } from any to any port != 53' | sudo pfctl -a com.apple/foxyblock -f -
sudo pfctl -E
```

1. Start a capture (`foxy-blocked.pcap`). Launch Foxy.
2. Wait for **CANNOT CONNECT TO TOR**, which takes a few minutes while each
   transport times out. Leave it two minutes. Background and reopen twice.
   Do **not** tap CONTINUE UNPROTECTED yet.
3. Then tap CONTINUE UNPROTECTED and confirm the iOS alert. A red *IP ADDRESS
   EXPOSED* row should appear.
4. Remove the block, and watch Foxy move onto Tor by itself:

```bash
sudo pfctl -a com.apple/foxyblock -F all
```

**Pass:** before step 3, no mint or price hostname in the capture, only
attempts at relays, Snowflake's broker and STUN servers, and obfs4 bridges.
After step 3, mint and price hostnames appear in the clear (the control: if
they don't, the capture isn't seeing the app). After step 4, they stop and the
red row goes away.

#### 4. Bridges

*Needs a phone.*

1. Arguments `-FoxyForceTransport snowflake`. Capture `foxy-snowflake.pcap`.
   Launch, wait for Tor, make one payment.
2. Arguments `-FoxyForceTransport obfs4`. Capture `foxy-obfs4.pcap`. Same.
3. Arguments `-FoxyForceTransport direct -FoxyDirectPatience 1`. Launch.

**Pass:** 1 connects, and the capture shows a Snowflake front/broker host and
UDP to STUN and peers, no Tor relays directly. 2 connects, and the capture
shows only obfs4 bridge addresses. 3's log shows `direct did not connect …
trying obfs4` (the order is direct, obfs4, Snowflake: TorTransport.order), then
`directory info complete` and `circuit established`, and prices load straight
after. Foxy then starts with obfs4 for a day; launch once with only
`-FoxyForceTransport direct` to put it back.

**A bridge is remembered for a day.** Whatever connects is used first next
launch; a bridge for 24 hours from when it first connected, then direct is tried
again (TorTransport.remembered; RememberedTransportTests). So a place where
direct Tor is blocked does not sit out 45 seconds of direct on every launch. To
check on a phone: launch with `-FoxyForceTransport obfs4` until `circuit
established`, then launch with no arguments. The second launch's log says
`tor: starting through obfs4`. Put it back with `-FoxyForceTransport direct`.

#### 21b. The Tor directory pre-seed

*The mechanism can be seen in a simulator; the 4-to-5-second claim needs a phone.*

First launch after a **delete and reinstall**, which is the only run that
plants it.

1. **Pass:** the log says the seed was planted, and the circuit arrives in
   roughly 4 to 5 seconds rather than the 40-plus this used to take. No
   descriptor stage at all.
2. Kill and relaunch. **Pass:** nothing is planted a second time; the marker
   (`microdescs.unproven`) is gone once a circuit has proved the directory.
3. **Pass:** the capture from 21a shows the pre-seed causes no fetch of its
   own — it is a file that ships in the app, not something downloaded.

#### 21c. The price, over the onion

**Pass:** home does not appear until the price has loaded (a design choice),
and the log shows the price came from the mempool onion. The onion wins only
about half the races against the fallbacks, so a fallback now and then is
normal. Watch for a fallback being used every time — that would mean the onion
source is timing out and the others are quietly carrying it.

#### 5. Coming back from the background

*5b, 5e and 5i for real need a phone: only iOS suspends an app and reclaims its sockets.*

Debugger detached (setup, above), Console.app streaming.

**5a. A normal return.** Launch Foxy, wait until the balance and price show.
Go to the home screen for **5 minutes or more**. Come back.

**Pass:** Console shows these in order:

- `tor: kept on the network while Foxy is away` (as it leaves)
- `tor: off the network while Foxy is in the background` (about twenty-four seconds later)
- `[foxy] wake: …s in the background`
- `tor: setting up a private connection (back after …s)`
- `tor: circuit established`

The phone showed the home screen at once, with its balance and the last
price, and SECURING YOUR CONNECTION on the banner at its foot until the circuit
was established (§22m). A payment goes through. With home first switched off
(`FoxyGate.homeFirst = false`) the return waits behind the connection screen
instead, as it used to.

**The percentage on the way back, and while waiting.** A return used to show no
percentage, then Foxy's own set-up steps (10, 20, 30%, shown as 18% of the
launch number), which then stood still: 18% for 36 seconds on a Wi-Fi to
cellular return, and 44% for 63 seconds on Snowflake, and both looked like
nothing was happening. Now the number creeps one point every 3
seconds while nothing real moves, never goes backwards, and stops at 95%, or 57%
of the launch number, so it never shows Tor done before it is. The first launch
after installing says "This initial setup may take 30 seconds but Foxy will open
much faster after this." (no relay list saved yet: `tor: no relay list saved
yet: the first setup`).

**Known, not a fault: `-FoxyBridgeTest` on a resume.** Backgrounding closes
Tor's SOCKS listener and sets `socksPort` to 0, and Tor opens a new one, on a
new port, on the way back. A probe in that window used to report `SOCKS
listener 127.0.0.1:0 — REFUSED` and then a request `FAILED after 9ms` against
the discard port Route falls back to — which reads as a broken resume and is
the exact opposite: it is the route refusing to let anything leave the app
while Tor is down. Now it says so instead:
`Tor has no SOCKS listener yet, so nothing can leave the app — fail-closed, not
a failure.` A real failure still reports as one, once the listener is up.

**Known, not a fault: a `-1200 TLS error` on the way out.** Backgrounding Foxy
while `-FoxyBridgeTest`'s probe is in flight cuts that probe's TLS handshake —
Tor's network is switched off underneath it — and it reports
`NSURLErrorDomain -1200 A TLS error caused the secure connection to fail.`
One timestamp carries three lines: `to
background`, `off the network while Foxy is in the background`, and the
failure. Read them together before calling it a fault. A -1200 with **no**
backgrounding beside it is a real one, and worth keeping.

**5b. A long return.** Same, but leave it **30 minutes or more**, ideally with
the phone locked. This is the case that used to fail until Foxy was killed.

**Pass:** as 5a. If it fails, keep every `[resume]`, `tor guards` and
`[foxy] tor` line.

**5e. On a bridge.** Where direct Tor is blocked, or with the argument
`-FoxyForceTransport obfs4`, repeat 5a. The screen reads "Tor looks blocked
here. Trying a bridge."

**Pass:** as 5a, with `through obfs4` on the set-up line. Snowflake is slower,
and 90 seconds is still a pass.

**5f. Switching networks while away.** Background Foxy on Wi-Fi, turn Wi-Fi
off, and come back on cellular after a minute.

**Pass:** as 5a, with no CANNOT CONNECT screen in between.

**5g. A short return.** Background Foxy for **20 seconds**, come back. Repeat
three times.

**Pass:** as 5a, on direct within about 5 seconds each time. The `tor guards
(setting up)` line shows no `down` among the first three. If a set-up is slow,
keep the `tor guards (still setting up after 15s)` line with the rest.

**Launch.** Kill Foxy and open it.

**Pass:** one screen from launch to the home screen, under one title —
SECURING YOUR CONNECTION from the first frame to the last, one percentage
rising throughout and the mint never named. The home screen appears with its balance and
price already shown, and the first tap on it does not bring up "Loading your
balance".

**Share sheet.** Share a token or an invoice, with a proxy capture running
(Watching the phone's traffic, above). **Pass:** the sheet's header reads
"Foxy" with no page preview, and the capture shows no request from the share
sheet while it is open.

**5h. RESTART TOR, and never having to kill Foxy.** `-FoxyTorStall auth`: Tor
starts, but Foxy's login to it never gets an answer, as once happened on a
phone.

1. Launch. SECURING YOUR CONNECTION shows with no percentage. Do not touch anything.
2. After about 10 seconds **RESTART TOR** appears, with "This is taking longer
   than it should.", and the log says `nothing has moved for 10s, with no
   control link; RESTART TOR offered`. Wait until about 45 seconds.
3. Tap RESTART TOR.

**Pass:** in step 2 the log shows `this authentication reply is dropped` and
`control authentication did not answer in 10s — connecting again (2 of 3)`,
then `(3 of 3)`. If you wait past about 35 seconds instead, CANNOT CONNECT TO
TOR shows with RETRY, which does the same as step 3. After step 3:
`-FoxyTorStall auth ends with this restart`, `restarting (the person asked)`,
then `SOCKS on`, `circuit established`, and the home screen, all without
closing Foxy.

**On a slow network, no button.** RESTART TOR is offered only when a restart can
help: no control link for 10 seconds, or nothing at all arriving (no bytes, no
event from Tor) for 30 seconds, 60 over obfs4 or past Orbot, 120 over Snowflake
(`TorStuck`; a working Snowflake went 70 seconds without an event). It
used to follow the percentage, and on weak cellular that stood at
50% while Tor was still downloading: three taps undid a completed directory,
marked Tor's entry relays down (never-connected went from 20 to 42), and the run
never connected. To check: on weak signal, a cold install that sits at one
percentage shows no RESTART TOR and logs no `RESTART TOR offered` while it is
still moving. A tap also keeps the fallback clock, so on a dead network Foxy
still moves on to a bridge and then CANNOT CONNECT.

**5i. Tor's control listener, reclaimed by iOS.** iOS reclaims every socket of
a suspended app. When it takes Tor's control listener, Tor keeps running and
nothing in Foxy can reach it: every command, including the one that would open a
new listener, goes through it. Foxy now sends itself SIGHUP, which Tor handles by
reloading its torrc (named with `-f` in Tor's data directory: `~/.torrc` is the
container root, which iOS does not let an app write), written first to name a
Unix control socket at a new path, and connects there. Checked against Tor
0.4.9.12 on a Mac with a read-only home; this is the phone.

1. On demand: launch with `-FoxyTorStall listener`. Do not touch anything.
2. For real: no arguments, the app open, lock the phone for a few minutes, unlock.

**Pass:** the log shows `the control listener is gone … asking Tor to open control
socket c1`, then `Tor opened control socket c1; connecting to it`, `control link to
socket c1 connected`, `setting up a private connection (control link connected
again)` and `circuit established`, and the home screen loads without closing
Foxy. A later recovery in the same launch uses c2. If it logs `only reopening Foxy
can reach Tor`, the screen says TOR STOPPED: keep that log.

#### 6. Orbot

*Needs a phone.*

Install Orbot from the App Store. The simulator has only a fake one
(`tools/sim/orbot.sh`); this is the test against the real one.

1. Start Orbot's VPN. Launch Foxy (arguments cleared).
2. **ORBOT DETECTED** should appear. Tap ALLOW FOXY IN ORBOT, approve in Orbot,
   come back to Foxy, and allow the paste if iOS asks.
3. Wait for Tor, make a payment. Capture `foxy-orbot.pcap` meanwhile.
4. Stop Orbot's VPN mid-session. Wait a minute. Make another payment.

**Pass:**
- Console after 2: `[foxy] orbot: access key stored`, `orbot: bypass`, and
  `tor: going past Orbot through its bypass port …`.
- No `not Orbot, ignored` line. If one appears, the VPN check is wrong on this
  phone. Record the line, because this is the part the simulator could not test.
- The payment works.
- After 4: `orbot: none`, `no Orbot bypass; reaching relays directly`, and the
  second payment works.
- No mint hostnames in the capture at any point.

#### 16. One circuit per job, and nothing asked at launch

What MINT-PRIVACY.md describes: each job at a mint on its own
Tor circuit, no proof or sent-token check at launch or on a return, and spent
ecash found by the payment that picks it. **Test money only**, on
`https://testnut.cashu.space`, Debug build, debugger detached.

1. Open Foxy cold. Receive 300 sats by invoice, leaving the receive screen open
   until it is claimed.
2. Send a 100-sat token and leave its screen open for 10 seconds, then close it
   without anyone claiming it.
3. Pay a small invoice or Lightning address.
4. Background Foxy for a minute, return, and pull to refresh on the home screen.
5. Close Foxy fully and open it again. The note about an unclaimed token shows
   once; close and open once more, and it does not.
6. Pull the log: `sh tools/pull-device-log.sh`.

**Pass**, from the `mint … on circuit …` lines:
- Step 1's invoice polls and its `/v1/mint/bolt11` share one label; the quote
  that made the invoice has another.
- Step 2's `/v1/swap` has a label no other job uses, and its `/v1/checkstate`
  lines every 4 seconds all share a different one.
- Step 3's melt quote, swap and melt share a label that nothing else uses.
- Steps 4 and 5 show no `/v1/checkstate` at all.
- Each step still takes about as long as before: a new circuit per job adds
  seconds at most on a direct connection. Note the times on a bridge.

#### 13h. The page cannot reach the network on a phone

Launch arguments
`-FoxyNetBlockTest YES`. Launch, wait for the home screen. Console: `[netblock]`.

**Pass:** the fetch, the WebSocket and the worker's fetch are blocked and the
beacon refused. Then add `-FoxyWebProxyOff YES` and `-FoxyNetBlockOff YES` for a
control run: the line changes. Untick all three afterwards.

#### 11. Release build is silent

1. Edit Scheme → Run → Build Configuration → **Release**. Run.
2. Console.app streaming, search `Foxy`.

**Pass:** no `[foxy]`, `[foxy-js]` or Tor lines. Only system messages.

### B. Money in and out

#### 13a. Receiving a token twice

On the home screen tap SEND MONEY, choose ecash, and make a
10-sat token (GENERATE ECASH TOKEN, then COPY TOKEN). Tap RECEIVE and paste it.
Then RECEIVE and paste the same token again.

**Pass:** the second receive says the token was already spent, straight away.
Console shows no `moving the counters on` line for it. A restore later (13d)
still finds the right balance.

#### 13b. A payment whose answer is lost

Pay a 10-sat invoice from another
wallet on the test mint. As soon as you tap the final confirm, turn on Airplane
Mode. Wait 30 seconds, turn Airplane Mode off, and stay on the PAYMENT PENDING
card for three minutes.

**Pass:** the card says the payment is still going through and offers no way to
pay again. Within about two and a half minutes of coming back online, one of two
things happens: the payment shows as sent (the other wallet received it), or the
ecash comes back to the balance and the other wallet received nothing. Never
both. Console: `held melt … settled as paid`, or `… did not go — returned`, or
`reads UNPAID but is …s old — left held` before either.

#### 13c. A token's own note

Make a token (13a) and, on its screen, tap ADD A NOTE and
write a few words. Make a second token without a note. Then Home → HISTORY (the round button at the top left of home, not the menu),
and open the first token.

**Pass:** the token screen shows that token's note, not the note of an earlier
send.

#### 13d. Restore with a token still out

Send a 20-sat token and do not receive
it anywhere. Home → MENU → SETTINGS → RESTORE, and enter this wallet's own twelve words.

**Pass:** the balance after the restore does not include the 20 sats of the
token you sent. Receive that token in another wallet: it works.

#### 17. Paying another user of the same mint

*Needs a phone: the scan is a camera.*

Two phones with Foxy, both on the same mint (`https://testnut.cashu.space`), or
one phone and a second wallet on that mint. **Test money only.** Debug build.

1. Phone A (payer) has a balance. It need not have received by invoice: if it
   does not know the mint's node yet, scanning shows "Checking the invoice…"
   for a moment while it asks (`/v1/mint/quote/bolt11` on its own circuit in
   the log, never paid). Try once with invoices from the Minibits app and from
   cashu.me on the same mint too: each shows the card.
2. Phone B (receiver) opens RECEIVE and makes an invoice for 21 sats.
3. Phone A scans B's QR. **Pass:** PAYING ANOTHER TESTNUT USER, the two lines
   of text, USE CASHU and CONTINUE OVER LIGHTNING, with the whole card visible:
   the camera goes away while the card is up, and comes back if you tap outside
   it.
4. Tap CONTINUE OVER LIGHTNING on a second invoice first: the usual send
   confirmation opens. Back out. Scan again and tap USE CASHU.
5. **Pass:** the ECASH TOKEN screen for 21 sats with "Share this with who you
   are trying to pay" under the title.
6. Phone B taps SCAN on its invoice screen (the fourth round button) and scans
   A's token. **Pass:** B's invoice screen closes, the payment confirmation
   shows 21 sats, and closing it lands on home.
7. Phone A: leave it on the token screen for one token, and go back to home
   before B scans for another. **Pass:** with the token screen open, the sent
   confirmation; elsewhere, a note "Your ecash token for N sats was redeemed".
   Either within about 5 seconds of B scanning when the log shows no `/v1/swap`
   for the token (A had the pieces), within 15 to 45 seconds when it does. With
   A in the background, the note comes 2 to 4 seconds after A is opened again.
   A minute or so after the wallet is ready, the log shows `small change: a …
   sat piece into … pieces` once, and after that small tokens need no swap.
8. Scan an invoice from a different mint or wallet: no card.
9. Pull A's log. **Pass:** the token's `/v1/checkstate` lines all share one
   circuit label that nothing else uses, and the first comes at least 15
   seconds after the token's `/v1/swap`.

#### 18. Receiving a token from an animated QR code

*Needs a phone: the scan is a camera.*

cashu.me in a browser on a laptop or another phone, on the fake-money mint
`https://testnut.cashu.space`. **Test money only.**

1. In cashu.me, get test sats and make an ecash token large enough to animate:
   send an amount made of many proofs, or lock it, until the QR code on
   cashu.me's "Pending Ecash" screen cycles through frames. Try its SIZE button
   on S, M and L, and SPEED on F and S.
2. In Foxy, scan it three ways, one token each: the scan screen from home (the
   camera inside the page), SCAN on home (the full-screen camera; it is not in
   the menu), and SCAN on an open receive invoice screen.
3. **Pass:** while the frames come in, the camera shows "SCANNING N%", rising;
   when it has them all, Foxy takes the token as it would a
   pasted one (the new-mint screen if the token is from a mint Foxy is not on).
   A normal, single QR code still scans at once.
4. Point the camera away halfway and back: the percentage carries on from where
   it was. Point it at a second animated token halfway: it starts over on that
   one.
5. The other way: in Foxy make a token of more than two proofs (after the small
   change swap, 21 sats is 16 + 4 + 1). **Pass:** the ECASH TOKEN screen's QR
   code changes several times a second; cashu.me's scanner and another Foxy both
   take the token from it. A token of one or two proofs shows a still code.

#### 19. Your mint is the one you are on

On Minibits, with test tokens from another mint (WesternBTC or testnut).

1. Paste a token from the other mint. **Pass:** MOVE TO YOUR MINT, with REDEEM,
   CLOSE and "Keep it at …" underneath. REDEEM moves it; the wallet stays on
   Minibits.
2. If that move left change at the other mint (the log says `… left at the
   source`), paste a second token from it. **Pass:** MOVE TO YOUR MINT again,
   not a switch to that mint.
3. Paste a third and tap "Keep it at …". **Pass:** "Kept N sats at …", and the
   wallet is back on Minibits; the other mint's balance shows on the Mints
   screen.
4. Paste a token worth less than moving it costs (a few sats). **Pass:** the
   note says the fee is more than the token is worth, and the button reads
   KEEP IT AT …; CLOSE leaves the token as it is.

#### 20. Paid by Cashu, on the receive and split screens

*Steps 2 to 4 need a camera, so a phone.*

Two wallets on Minibits (Foxy and another Foxy, cashu.me or Minibits).

1. RECEIVE 21 sats. Tap NETWORK (it has a chevron): LIGHTNING and CASHU. Pick
   CASHU. **Pass:** the QR changes; COPY copies a `creqA…` request.
2. The other wallet scans it and shows a token for 21 sats. On the receive
   screen tap SCAN and scan it. **Pass:** the animation, then the payment
   received, then home.
3. Make a token of more than two proofs. **Pass:** the ECASH TOKEN QR is larger
   and animates in fewer frames than before; the other wallet reads it quickly.
4. Split a bill; on a payer's screen tap NETWORK, pick CASHU, have the other
   wallet pay with a token for exactly the share, and tap SCAN. **Pass:** the
   payer is marked paid on COLLECTING. A token for another amount, or from
   another mint, is refused with why, and nothing is taken.
5. History: a token you made and nobody has redeemed is amber, marked Pending;
   once redeemed, or taken back, it turns green.

#### 21e. The Cashu QR carries the amount

The bug this is for: a receiver typed an amount, switched to CASHU, and the
payer's scan read a request for **no** amount, which their wallet offered as
"pay any amount".

1. RECEIVE, type **$1**, switch to CASHU **immediately** — before the invoice
   has landed. **Pass:** the QR shows its loading animation, then a code; the
   payer sees **$1's worth**, never "pay any amount".
2. The same with **10 sats** typed.
3. The same with the price not yet loaded (launch and go straight to receive).
   **Pass:** still the loading animation, still never an amountless code.
4. RECEIVE with **nothing typed**. **Pass:** NEXT says "Type an amount first."
   An amountless request cannot be made from RECEIVE: the wallet supports one
   (`paymentRequest(0)` is unit-tested) but the screen does not offer it.
5. Reopen a receive from history. **Pass:** the figure comes off the invoice.

#### 21f. Paste

The control used to be destroyed and rebuilt on every render, so the first tap
landed on a control that no longer existed.

1. Copy a token in another app, open Foxy, tap PASTE **once**. **Pass:** it
   works on the first tap.
2. Tap PASTE twice quickly. **Pass:** the token is taken once.
3. Paste while a card or confirmation is on screen.
4. Receive a Lightning payment, dismiss the confirmation. **Pass:** nothing is
   pasted by the dismissal (the 700ms settle).

#### 21g. Ecash in and out

1. Receive a token from **another mint**. **Pass:** VERIFYING ECASH, then
   MOVING ECASH TO YOUR MINT, the top bank 60px lower, looping for as long as
   it takes; and the whole thing finishes well inside the 30 seconds that was
   complained about.
2. Split a bill and have the payers pay. **Pass:** they are marked complete on
   COLLECTING **while it is open** — not only in history afterwards.
   *(Known: a payer's own QR screen does not react — sitting on Payer 2 while
   Payer 2 pays, the QR stays up with nothing said, and only moving on to
   COLLECTING shows RECEIVED.)*
3. TRANSFER, back, then SWITCH. **Pass:** the switch screen appears, not the
   transfer screen; and the balance pill still opens it.
4. A transfer whose fee leaves less than asked. **Pass:** you can proceed with
   the lesser amount without going back.
5. The network picker names a default, and on-chain reads **on chain**.

### C. The seed and the keychain

#### 14. The native seed screens

*The screen-recording steps (14a.3, 14b.2, 14c.4) need a phone.*

**A test wallet only**, with its twelve words written down. A Debug build,
debugger detached, Console.app streaming, search `[seedscreentest]` and
`[foxy]`. Launch argument: one `-FoxySeedScreenTest` value at a time; untick it
afterwards. Each run asks the bridge from the page three seconds after it loads,
and the log line comes when the run ends. Every run first asks for the page's
old word actions, which must each answer `error "Unknown action: …"`.

**On every screen below:** the screen is an iOS sheet, with the grabber on top
and Foxy's page dimmed and pushed back above its edge, not a full screen. At its
top is a bar of iOS's grey material with a green lock-and-shield symbol and "On
this iPhone · not the web page"; below the bar the colours are Foxy's. The phone
taps once as the screen opens. Dragging the sheet down does not close it.

**14a. The words.** `-FoxySeedScreenTest show`.

1. Approve Face ID or the passcode if asked. YOUR SEED PHRASE appears, the
   words hidden behind TAP TO REVEAL.
2. Take a screenshot. Close the warning. Tap TAP TO REVEAL and compare the
   words with the written copy.
3. From Control Center start a screen recording, come back to Foxy for a few
   seconds, stop it.
4. Tap VERIFY WORDS. Tap a word that is not the first, then the back button at
   the top: the words are shown again (not Foxy's own screen). Tap VERIFY WORDS
   again, then the twelve in order, then DONE. From the words, the back button
   leaves the screen.

**Pass:** step 2 shows THAT SCREENSHOT SHOWS YOUR SEED over the screen, and the
words match. In step 3 the words are hidden, not blurred: "Hidden while the
screen is recorded or shared" replaces them as soon as recording starts, and the
recording shows no word. In step 4 the tiles show without another tap, since
the words were revealed on this screen; the wrong tap says "That is not word 1.
Start again." in red, twelve right taps show BACKED UP, and DONE closes it. The
log line holds `seedRead: error "Unknown action: seedRead"`, the same for
`seedWrite` and `seedDelete`, and ends `seedShow: {"verified":true} |
counterSnapshot: …`. Delete the screenshot and the recording, and empty
Recently Deleted.

**14b. Straight to the quiz, and leaving it.** `-FoxySeedScreenTest verify`.

1. The VERIFY screen opens on its own, its tiles behind TAP TO REVEAL. Tap it
   and note the order of the first four tiles. Tap the back arrow.
2. Launch again. Tap TAP TO REVEAL, place two words, then start a screen
   recording from Control Center, come back for a few seconds and stop it.
   Compare the tiles' order with step 1's. Tap the back arrow.
3. Launch again; with the quiz open, go to the home screen for five seconds and
   come back.

**Pass:** before the tap no word shows, as tiles or anywhere else. Step 2's
order is not step 1's (it is drawn afresh for every quiz, not from the words),
and during the recording the placed words and the tiles are both replaced by the
notice, and the recording shows no word. Each time the screen closes and the
line holds `seedShow: {"verified":false}`. Coming back from the home screen, no
seed screen covers Foxy, and the PIN lock shows if it is on.

**14c. Typed words.** `-FoxySeedScreenTest enter`, with the twelve words of a
*different* test wallet. Before launching, copy those twelve words from Notes:
Foxy going to the background closes the restore screen.

1. RESTORE A WALLET appears. Type the first word with a capital: it shows in
   lower case and is not corrected. The bar above the keyboard suggests words;
   tap one, and it fills the cell and moves to the next.
2. In cell 3 type `foxy` and move to cell 4: cell 3 turns red and "Word 3 is not
   one of the 2048 seed words." shows.
3. Double-tap the word in cell 1. The menu offers no Copy, Cut, Share, Look Up
   or Translate. Press and hold the word and try to drag it: it does not lift.
   Clear the cells.
4. With cell 2 focused and the keyboard up, start a screen recording from
   Control Center and come back. Tap where the cells were. Stop the recording.
5. Tap cell 1 and paste the twelve words: they spread across the cells. Double-
   tap an empty part of cell 1.
6. Change the last word to another word from the list: "These twelve words are
   not a valid seed phrase. Check each one." shows and there is no LOOK FOR
   BALANCES button. Put the right word back: LOOK FOR BALANCES appears. Tap it.
7. iOS asks "Replace this wallet's seed?". Tap **Cancel**.
8. Launch again, and tap the back arrow on RESTORE A WALLET.

**Pass:** in step 4, as soon as recording starts the keyboard goes down, the
cells are replaced by "Hidden while the screen is recorded or shared", the
suggestion bar is gone, and the tap brings up no keyboard; the recording shows
no word, no suggestion and no key pop-up. When recording stops the cells show
again and take a tap, but no keyboard comes up on its own. After step 5 Console
shows `a phrase pasted into the restore screen was cleared from the pasteboard`,
and the menu in cell 1 has no Paste. The step 7 line holds
`seedEnter: {"candidate":"…"}` with 32 hex digits, `restoreSecrets:
009a1f293253e41e start 0, 5 secrets, 5 blinding factors`, the same for the
start at 900 (typed words are served from 0, and 900 is inside the window past
what was served), `seedAdopt: error
"Nothing was changed."` and `seedCandidateForget: {"forgotten":true}`. 14a then
shows this wallet's own words, unchanged. Step 8's line holds `seedEnter: error
"cancelled"`.

**14d. Counters, and the page's old words.** `-FoxySeedScreenTest counters`. No
screen opens; the line comes after a few seconds.

**Pass:** the line holds `countersImport: {"counters":{…}}` with
`009a1f293253e41e` at 7 or more on the install's first import, and
`countersImport: error "counters were already imported"` on any later run (the
phone takes one import per install), a `counterReserve` of 3 secrets starting where
the import left the keyset, a peek of 0 secrets starting 3 later, `counterReserveAt`
answering either secrets or `error "range already issued"`, never a range below
the counter, a `counterAdvance` whose `next` is not lowered to 2, and
`restoreSecrets` serving the two ranges at 300 (22 and 23 counters), which are
inside the 1000-counter window past that counter. A range ending more than 1000
past the counter is refused with `error "outside the restore window"`; this run
does not ask for one. It then holds
`seedMigrate: error "bad request"` for twelve words with a wrong checksum, and
`seedMigrate: {"different":true,"migrated":false}` for the abandon … about
phrase (`same` only on a test wallet made from exactly those words). Console
shows `seed migrate: the page held words of a different seed than the saved
one; nothing was changed`, and 14a afterwards shows the wallet's own words.

**14e. Words Foxy copied, and the page's clipboard.** No launch argument. Keep
Foxy in front throughout steps 1 to 3.

1. In Foxy, copy something with one of the page's copy buttons (a Lightning
   invoice or an ecash token). Open the page's RESTORE, which opens the native
   restore screen, and paste into cell 1.
2. Back out. In the page, open RESTORE again, and paste again.
3. Go to Notes, copy the other test wallet's twelve words, come back to Foxy,
   open RESTORE and paste into cell 1. Back out.
4. Copy the twelve words in Notes again. In Foxy, tap the page's paste button
   where an ecash token is pasted.
5. Copy an ecash token in Notes and tap that paste button again.

**Pass:** steps 1 and 2 leave the cells empty and say in red "These words were
copied inside Foxy. Type or paste words you wrote down yourself.", with Console
`a paste of text Foxy copied was refused on the restore screen`; typing in the
cells still works. Step 3's words spread across the cells. Step 4 pastes
nothing into the page and Console shows `paste control: the clipboard held a
seed phrase; the page was not given it`. Step 5 pastes the token as before.
Delete the twelve words from Notes.

#### 9. Screen recording and screenshots

*Needs a phone.*

1. Open Foxy's seed screen and tap to reveal the words.
2. Control Center → Screen Recording → start.
3. Look at the seed screen, and at the verify screen.
4. Stop recording. Take a screenshot while the words show.

**Pass:** during recording the words are hidden, not blurred: "Hidden while the
screen is recorded or shared" shows in their place, and the recording itself
shows no word (§14). After a
screenshot, a card says **THAT SCREENSHOT SHOWS YOUR SEED**. Delete that
screenshot from Photos and Recently Deleted.

#### 12. The keychain rules

*12b and 12d need a phone.*

The simulator has tested these with a locally signed build; a phone's keychain
is the one that matters.

1. Arguments `-FoxyKeychainTest YES`. Launch Foxy with the debugger detached,
   Console.app streaming, search `[keychaintest]`.

**Pass:** every line reads `PASS`, ending in `done`. The first line should say
the wallet's seed is in the keychain, if this phone has a wallet. The test
writes only scratch entries and removes them.

**12b. Face ID for the seed.** On a phone with a passcode and Face ID, with a
wallet from a build made before the seed moved into the keychain installed. This
checks the carry-over, not the steady state.

1. Install this build over it. Open Foxy. With a PIN and Face ID on, unlock
   with Face ID.
2. Close Foxy fully and open it again, unlocking with the PIN instead.
3. Turn the app lock off in Foxy, close it fully, open it again.
4. In Console, check the order of `[foxy] seed:` lines.

**Pass:** step 1 shows one Face ID prompt, not two, and logs `seed: moved
behind Face ID or the passcode`; the balance is unchanged. Step 2 shows one
Face ID or passcode prompt after the PIN. Step 3 shows one prompt at launch.
Cancelling a prompt leaves the wallet refusing to connect with a keychain
error, never an empty wallet or a new seed.

**12c. A host Foxy has not used.** With a wallet from a build made before the
seed moved into the keychain installed, install this build and open it.

1. Your saved mint and your contacts connect and pay without any new prompt.
2. Add a mint that is not one of the defaults (for example a mint URL you have
   never used). An alert asks "Allow Foxy to contact …?". Tap Don't Allow.
3. Add it again and tap Allow. Close Foxy fully, open it, use that mint again.
4. Pay a lightning address on a domain you have never paid.

**Pass:** step 1 shows no host alerts. Step 2 refuses with "You did not allow
Foxy to contact …" and nothing reaches that mint. Step 3 connects and asks only
once, across the relaunch. Step 4 asks once for the address's domain; its
callback on the same domain or a subdomain does not ask again. A domain Foxy
only carried over from the contacts in step 1 approves only itself, so a
callback on its subdomain asks once.

**12d. Removing the passcode.** **Only on a spare phone**, with the twelve words
written down. It changes the phone's passcode, and Face ID with it. Nobody knows
yet whether iOS then fails a read of the seed's item, or answers "not found"
(`SEED-HANDLING.md`). Foxy must not make a new seed in either case.

1. With a passcode set, open Foxy, unlock it, and note the balance and the first
   and last words. Console: `[foxy] seed:`.
2. Close Foxy fully. Settings → Face ID & Passcode → Turn Passcode Off.
3. Open Foxy and let it try to open the wallet. Close it fully and open it once more.
4. Close Foxy fully. Set a passcode again (Face ID again, if wanted), open Foxy.

**Pass:** in step 3 Foxy refuses to connect with a keychain error that says the
seed is behind a passcode that is no longer set. Console shows `seed: behind a
passcode this phone no longer has` or a keychain failure status, and no `seed
written to the keychain` line. Nothing asks to replace the seed, and the seed
screen shows no new words. In step 4 the same words and balance come back. Record
the status Console shows in step 3: it is the answer to how iOS treats the item.
If step 4 finds no seed, record that too: iOS deleted the item, and only the
written words bring the wallet back.

**A phone that never had a passcode.** The rule is Face ID, else the passcode,
and with neither Foxy goes ahead on its alerts and warns. On
such a phone: the card THIS IPHONE HAS NO PASSCODE at launch until DON'T SHOW
AGAIN; the Replace and Delete alerts end "This iPhone has no passcode, so nothing
else will be asked before the seed is replaced / deleted."; and YOUR SEED PHRASE
carries a line saying anyone who picks the phone up can open it. With a passcode
none of these show.

#### 7. Backup restore on the same phone

*Needs a phone.*

**This erases the phone.** Only on a spare phone, or with every wallet's words
written down and a backup you have already restored from successfully.

1. In Foxy, note the balance and open the seed screen, and write down the words.
2. Finder → the phone → **Encrypt local backup** → Back Up Now.
3. On the phone: Settings → General → Transfer or Reset → Erase All Content.
4. Restore from that backup. Open Foxy.

**Pass:** Foxy's seed screen shows the **same** twelve words. The balance may
show zero, because proofs are not in backups, but Restore with those words
brings it back. If the words differ or Foxy starts a new wallet, record it: the
seed was lost, which is what this change was meant to stop.

#### 10. Reinstall

**This deletes the wallet on the phone.** Words written down first.

1. Delete Foxy. Install it again. Launch.

**Pass:** Foxy does not show the old wallet's balance or words, and asks for no
Face ID for them; Console shows `a seed from a previous installation was
removed`, and a new seed is made on first launch. Adding a mint used before
asks "Allow Foxy to contact …?" again. Restore with the old words brings the
old balance back.

#### 15. Moving an install to the native seed

Stage 4 took the words out of the page in every build. This checks that a
wallet made by an earlier build comes across whole; once no phone in use
predates stage 4, there is nothing left here to test. **A test wallet
only**, with its twelve words written down, on the fake-money mint
`https://testnut.cashu.space`. Debugger detached, Console.app streaming, search
`[foxy]`.

1. Install a build from before stage 4 (one that still held the words in the
   page). Make or restore a wallet, claim test sats, and
   send a token to yourself and receive it, so the counters have moved. Note
   the balance, and the first and last words on MENU → BACKUP.
2. Without deleting Foxy, install this build over it and open it. Approve Face ID
   or the passcode if asked.
3. Note the balance. Open MENU → BACKUP: Foxy's own seed screen shows the words.
4. Receive a small invoice and send a small token, so new counters are reserved.
5. MENU → SETTINGS → RESTORE with the same twelve words. When it finishes, close Foxy fully
   and open it again.
6. If a phone still has a wallet from before the keychain (a build whose words
   are only in the page's storage), repeat steps 1 to 5 there.

**Pass:** no "Replace this wallet's seed?" alert and no new words at any step, and
Console shows no `seed: made on the phone`. Step 3 shows the same balance and the
same words as step 1. Step 4 goes through with no `moving the counters on` line,
which counters that were not imported would cause. Step 5 finds the same balance,
less any token nobody received, answers the words as this wallet's own seed, and
the relaunch changes nothing. In step 6 Console shows `seed migrate: the page's
old words are now the saved seed` once, and never `a different seed`; the rest
passes as above.

#### 13e. Declining a different seed

Home → MENU → SETTINGS → RESTORE, and enter the twelve words of a
different test wallet. When iOS asks "Replace this wallet's seed?", tap
**Cancel**, not Replace.

**Pass:** nothing changes: same balance, same words on the seed screen. Relaunch
and check again.

#### 13i. Another wallet restores Foxy's words

A test wallet only. In Foxy, note
the balance at the test mint and the twelve words. In cashu.me (in a browser) or
Minibits (on a phone), restore from those words at the same mint.

**Pass:** the other wallet shows the same balance, less any token you sent and
nobody has received. Send a token from the other wallet to Foxy and receive it:
it works, with no used-output error.

#### 13j. A locked payment opens on the other phone

Two phones and a test mint. This is the whole point of deriving a payment
request's lock key from the seed instead of making a random one: with a random
key the ecash below is unspendable for ever the moment phone A is gone.

1. On phone A, open a receive screen and let the Cashu code appear. Pay it from
   phone B **without letting A claim it**: background A the moment B says done,
   or turn A's network off first. `foxy.req.unclaimed` on A now holds a token,
   and `foxy.req.lockkeys` a row of `{i, pub}` with no key in it.
2. Take the token off B (or off A's log) so you have its text.
3. On a third install — a fresh Foxy, or A after a wipe — enter phone A's twelve
   words on the native restore screen and adopt them. Paste the token in.

**Pass:** it is claimed. The log says `this token's lock is this wallet's own
key, at index N — found by walking the seed`. **Fail:** "That token is locked to
a key this wallet does not have", which is what a build that made random lock
keys would say, for ever.

Also worth watching on this run: the receive screen's code appears as promptly
as it did before (the lock keys are primed beside the onion address now, and the
first prime may be the visit's Face ID), and replacing the seed while step 1's
payment is still unclaimed is refused with "A payment or swap is still settling".

### D. The screen lock

#### 21d. SECURE FOXY, and Face ID every time

*Needs a phone: Face ID cannot be enrolled in a simulator except by hand.*

1. On a wallet with no protection, the SECURE FOXY card appears. **Pass:** the
   three choices are Face ID, PIN, and no protection, and the no-protection
   path says plainly what it means.
2. Choose Face ID. Background Foxy, return. **Pass:** Face ID is asked for on
   **every** return to the foreground, not just the first.
3. Turn Face ID off from the menu, then on again. **Pass:** the balance and the
   words survive both moves. This is the one to be slow and careful with: the
   seed is read, written to its destination, read back, and only then deleted
   from the old place — the test is that a wallet with money in it still has it
   after the round trip.
4. §10 (reinstall) and §12 (keychain rules) still pass with each protection
   setting.

#### 8. The PIN wait

*The Face ID leg needs a phone.*

1. Set a PIN. Lock (background a minute, return).
2. Enter wrong PINs until the screen says to wait. The first five are free,
   then 1 s, 2 s, 4 s…
3. While it says wait, enter the right PIN. It must be refused.
4. Force-quit Foxy (swipe it away), open it again, enter a wrong PIN.
5. With USE FACE ID off in the menu, remove the PIN and set it again. Lock and
   return, twice.
6. Turn USE FACE ID on. Lock and return; then again, cancelling the Face ID
   prompt.

**Pass:** 3 refused without unlocking. 4 still waits, and the count did not
reset. After the wait, the right PIN unlocks. Face ID, if on, unlocks and
clears the count. 5 asks nothing about Face ID while the PIN is set, and every
return shows the PIN pad with no Face ID prompt and no USE FACE ID button. 6
opens by face; cancelled, the PIN pad is there and the PIN opens it.

#### 5d. The PIN comes back

Set a PIN in Foxy. Background for a minute, return.

**Pass:** the lock screen is up on return. Also: open Control Center and close
it, and use Face ID if it is on. Neither should lock again.

### E. The screens

#### 13g. Every screen looks as it did

The screens are now drawn by one function
each. Walk through the home screen, RECEIVE (an invoice, and pasting a
token), SEND MONEY (an invoice, ecash, a lightning address) up to the confirm
screen, HISTORY (top left of home, not the menu) and one transaction's detail, MENU → CONTACTS, MENU →
SWITCH, MENU → BACKUP (the recovery phrase), MENU → SETTINGS → RESTORE, MENU → SPLIT A BILL, the PIN
screen, and a blocked card (receiving a spent token again, 13a, shows one).

**Pass:** nothing is missing, misplaced or blank, and every button still does
what it did.

#### 21h. The screens

1. Fast first install. **Pass:** the securing screen is visible, and shown
   once, not twice.
2. Take a screenshot while the splash is up. **Pass:** the splash clears.
3. Words not yet backed up. **Pass:** a red ring spins on the menu button and
   the backup button, an amber ring on history. Verify the words. **Pass:**
   both stop.
4. The app icon is the new one.

#### 13f. Typing a mint address

Home → MENU → SWITCH → TYPE URL OF ANY OTHER
MINT, and type `testnut.cashu.space` by hand.

**Pass:** iOS does not autocorrect or capitalise what you type.

---

### F. Tap to pay over Bluetooth

Needs two phones with Foxy on them. The design is `TAP-TO-PAY.md`; these are
the parts only a pair of real radios can answer. Every line quoted below is in
the diary (`[tap] `, kept by `FieldLog`).

#### 22a. A payment crosses, and the receiver is on the air only from its own screen

Receiver: RECEIVE, an amount. The screen puts the phone on the air by itself
(`tap: armed by the screen`); the QR stays up and the TAP button lights. With
MENU → SETTINGS → AUTO TAP TO PAY off, nothing is on the air until **TAP** is
pressed, and the QR should then go orange and say TAP HERE. Payer: just hold the
phone against the receiver's — from home or from SEND, with no button to press.

Expect on the **payer** `a receiver at -NN dBm (needs -33, advertised),
connecting` — the receiver advertises and the payer listens, so this line is on
the paying phone — then on the receiver `handshake: keys agreed, the code is on
screen`, the orange card becoming four digits, and the same digits on the
payer's confirmation, which opens by itself. On the payer, `pay steps: made in
… ms (locked to them, …), delivered over bluetooth in … ms` — the lock is the
point, and a run without `(locked to them` means the ecash went out unlocked.

**Read the word after the number.** `advertised` is the verdict being taken on
the scale the cut-off was measured on, which is what should happen. `over the
link` means the advertisement pool was empty and the link's own reading
decided; it is allowed, but if it is happening on every tap something is
starving the pool and `TAP-TO-PAY.md`'s *Tuning* section says what that looked
like.

**A refusal should say `too far`, not `heard for 0.0Ns`.** The second is the
pool having too few readings to judge with, and it meant a phone touching
another was turned away at -33 dBm. If it comes back, the number is not the
problem.

Then the part that is a privacy property, not a feature: the payer must never
be on the air, so a phone on home or on SEND, listening, shows nothing to a
scanner; and the receiver's one advertisement is a random service UUID and
nothing else (§22b). With AUTO TAP TO PAY off, a receive screen with the
invoice up and TAP **not** pressed must be invisible to the other phone too.
Whoever advertises is findable, and a receive screen can be open for minutes.
`tests/tap-offer.js` checks the arming and smoke check 43 reads both sides, but
only two phones show it for real.

#### 22a-ii. TAP before the invoice is ready

Enter the amount and touch the phones together at once, before the QR settles
(with AUTO TAP TO PAY off, press TAP the instant the amount is entered). The
handshake should finish and both screens should show the code while the
receiver is still making the payment request; the offer follows and the payment
completes as normal. Expect `on the air, offering nothing yet — the request is
still being made` on the receiver, then a second line with the real offer.

#### 22a-iii. The next customer

After a payment, press X on the four digits — the QR should come back — then
press TAP again. Expect a **different** service UUID in `on the air as …`: one
receiver is one payment's worth of radio. Pressing TAP while a payment is still
crossing should say so and change nothing.

#### 22b. What a third phone can see

A phone running nRF Connect (or any scanner) beside the two: it should see the
**receiver** advertising one 128-bit service UUID, fresh for that payment, with
no name, no manufacturer data and no amount — and should see the payer only as
a phone that scans, which is what every iPhone with Bluetooth on looks like.

Connect to the receiver twice, once while Foxy is not on the air and once while
it is, and compare:

| | Foxy not on the air | Foxy on the air |
|---|---|---|
| Services a stranger finds after connecting | Device Information (Manufacturer Name, Model Number), Apple Continuity, Apple Nearby, Battery Service (Battery Level), Current Time Service | the same five, **plus one**: a 128-bit service UUID new for every tap, with characteristics derived from it (`in`, `out`, and the two near doors) |
| Name in the advertisement | none | none |
| Anything readable from Foxy's characteristics | — | nothing of the payment: the notify one answers a subscriber that has not done the handshake with silence, and the write one refuses anyone else; a near door carries one byte and no secret |

So Foxy's whole footprint is one service and its characteristics, and all of
their UUIDs are made per tap (`TapCrypto.inCharacteristic`/`outCharacteristic`
derive the two from the service). Nothing in it says Foxy, and nothing repeats
between taps. What the stranger reads — model number, battery level, the time —
is iOS's own, served by every iPhone with Bluetooth on, Foxy or not. The list
had no phone name in it.

#### 22c. Both rails and a split

The CASHU rail on the receive screen offers the payment request alone; the
split's payer screen behaves as the invoice screen does. Each share is settled
by its own request (`split:<idx>`), so check that paying one share by tap marks
that row and no other.

#### 22d. What breaks it, and what should not

- Bluetooth off on either phone — the tap screen must say so.
- Walking away mid-handshake: the payer's screen goes back rather than sitting
  on CONNECTED for ever.
- Backing out of the confirmation while a payment is in flight tears the link
  down, and the payment falls back to the request's onion address. It should
  arrive in a few seconds; it should never be lost.
- Two receivers on the air near one payer: the payer chooses the closer one,
  judged across a full second, and the four digits are what catch a wrong
  choice.

#### 22e. The onion fallback, timed

The fallback used to fail: it took about two minutes and delivered nothing. The
receiver destroyed its address about 1.6 s after the screen changed — before
the payer had finished minting the token — and a *destroyed* onion fails
slowly, because the descriptor is still cached where it was published. Three
things changed, and this is how to see each of them.

**The fallback itself.** Receiver on the CASHU receive screen; tap; the moment
the payer's confirmation appears, back out **on the receiver**. Time it.

- **Expect: a few seconds.** Two minutes means the hold is not working.
- On the receiver, look for `onion inbox kept answering for 90s: a payment may
  be on its way`. If the line says `onion inbox closed` instead, no request had
  been built on that address and the hold was skipped — check the receiver
  really showed a request.
- On the payer, `pay steps: bluetooth would not take it` should be followed by a
  delivery, not by the token screen.

**The screen staying awake.** Same test, then *do not touch the payer's phone*.
It must not lock while the delivery is going. A lock parks Tor
(`TorService.backgrounded` zeroes the SOCKS port) and the next attempt comes
back `noTor` — which is what the earlier runs ended with.

**Failing fast.** Receiver force-quits Foxy mid-tap. The payer should reach the
token screen in about 30 seconds, not 120. The money is never lost either way:
the token is made before it is delivered and the payer keeps it.

**No regression.** An ordinary tap with nobody moving still settles over
Bluetooth in a fraction of a second, and a scanned QR paid to a fresh address
still arrives.

One thing to know either way: a failed delivery of a **locked** payment leaves
the payer holding a token locked to a phone that has walked away, which the
payer cannot reclaim alone. `TapLink.swift` records a small payment stranded
that way. These changes remove the common cause and shorten the window; they
do not change that trade.

#### 22f. A shake presses TAP

`TAP-TO-PAY.md`, *Shake*. On the receive invoice screen with an amount,
shaking the receiver's phone — the same shake as shake to undo — presses TAP,
but only when nothing is on the air yet. With AUTO TAP TO PAY on, the default,
the screen has already armed itself and a shake does nothing, so switch it off
(MENU → SETTINGS) for steps 1 to 4. Read the `[foxy] tap: shaken` lines off the
field log.

1. Shake: expect `shaken; pressing TAP` and the phone on the air.
2. Set the phone down, pick it up, walk with it, wave it: expect no `shaken`
   line. A double bump between two phones should not shake it either.
3. Press TAP, then shake while the code card is up: the card stays and the
   log says `shake ignored — already on the air`.
4. With a payer connecting, shake: the link is kept.
5. With AUTO TAP TO PAY on, shake on a receive invoice screen: the log says
   `shake ignored — already on the air` and nothing else changes.
6. Shake on home, or on a send screen: `shaken, but shake to tap is off`.

#### 22g. Two mints: both online, or a card on both

Two phones on **different** mints.

1. **Payer in airplane mode**, receiver online, receiver asks for an amount,
   touch. **Pass:** both phones show OFFLINE & DIFFERENT MINT within a couple
   of seconds — the payer's says "Your receiver uses a different mint", the
   receiver's "Your payer uses a different mint", and each names its own mint
   first ("You use … while they use …"). Nothing is paid, no price screen, no
   fee screen, and the receiver is not offered YOU NEED TO SCAN.
2. **Receiver in airplane mode**, payer online. **Pass:** the same two cards.
   If the payer holds sats at the receiver's mint, its card has CHOOSE A MINT.
3. **Both online.** **Pass:** paid over Lightning as before.
4. **Same mint**, either phone offline. **Pass:** paid with ecash over the
   link as before; no card.
5. **A balance that is one mint's.** Offline, take a payment at mint A, then
   switch to mint B. **Pass:** B's home screen shows B's balance and nothing
   of the payment; back at A it shows.
6. **No card left over.** A phone holding a payment it could not bring home (it
   showed IT COSTS MORE TO BRING HOME or PAID, STILL AT THEIR MINT): open Foxy,
   wait half a minute with a connection. **Pass:** the card does not come
   again and again; it is said once.

#### 22h. Two versions of the tap

The wire has a version (TAP-TO-PAY.md, *Versions*). Two phones on the same
build first, then one of them on an older build.

1. **The same build on both.** Tap as usual, same mint, then two mints.
   **Pass:** the four digits match and the payment goes through, as before.
   This is the check that the version byte and the bound message kind broke
   nothing.
2. **Change, and a payer put away.** An offline payer pays over, so change
   comes back; and a payer put in the background straight after SEND, then
   brought back. **Pass:** the change is kept, and the payer hears the result
   again. Both use messages that are now bound to their kind.
3. **An older payer.** The receiver on this build, the payer on a build from
   before the version byte. Receiver asks, touch. **Pass:** the receiver shows
   UPDATE FOXY TO TAP, with "For now, they can scan the code on this screen".
   Nothing is paid. Scanning the code pays.
4. **An older receiver.** The other way round. **Pass:** nothing is paid and
   nothing is said on either phone (the older one cannot read the newer
   promise). The payer's connecting screen goes away by itself.

#### 22i. Two receivers side by side

Two phones each showing an invoice, a hand's width apart, and a third to pay.

1. Bring the payer near the first, then move it to the second without
   touching either. **Pass:** CONNECT TO PAY comes down on the first and goes
   up on the second within a couple of seconds. It does not stay on the first.
2. Touch the second. **Pass:** the four digits appear on the second and the
   payer, and the second is the one paid. The first is still on its invoice.
3. Hold the payer between the two, the same distance from each. **Pass:** the
   card stays on one of them and does not jump back and forth.
4. Pay the first as well. **Pass:** paid as usual.

#### 22j. What this build changed besides the tap

1. **The PIN pad.** Type a PIN quickly with two thumbs, and with taps that
   land between two keys. **Pass:** every tap registers once, and each key
   turns orange while it is down.
2. **The first invoice after coming back.** Put Foxy away for a minute, open
   it, RECEIVE, an amount, NEXT. **Pass:** the code is up in about two
   seconds. The diary says "a circuit to … is ready for what comes next"
   after the return, and the invoice's request leaves on that circuit.
3. **A slow circuit.** Hard to cause on purpose. In a diary where an invoice
   or a fee quote took more than five seconds: **Pass:** "has not answered in
   5s; asking again on another circuit" is there, and the screen did not wait
   a minute.
4. **Backing out early.** RECEIVE, an amount, NEXT, and BACK within a second.
   Then MENU, the mint list, pick another mint. **Pass:** it switches; it
   does not say to wait for a payment to finish.
5. **The mint list.** With more mints than fit, the list scrolls to ADD MINT
   BY URL and ADD MINT BY QR.
6. **A receipt.** Pay another Foxy by tap at the same mint (a locked
   payment). Open the payment in history a few seconds later. **Pass:**
   RECEIPT says it was taken by the key it was locked to; COPY RECEIPT copies
   it; DELETE removes it and it does not come back.
7. **Proof of payment.** Pay a Lightning invoice at another mint. **Pass:**
   the payment's screen has PROOF OF PAYMENT, 64 characters, and tapping it
   copies. Receive over Lightning: its screen has PAYMENT HASH.
8. **An invoice on screen.** RECEIVE, an amount, NEXT, and with the code up
   go to the mint list and pick another mint. **Pass:** it switches. Pay the
   invoice from another wallet afterwards: the sats arrive at the mint the
   invoice was made at.

#### 22k. Putting Foxy away while it is asking a mint

Tor leaves the network when Foxy has been put away for as long as iOS
allows (§22l), and nothing new is sent from the moment its work is over. A
request cut at that moment,
while Tor was still building its circuit, was counted against the entry relay,
and a phone whose relays had been marked down that way took many seconds for
an invoice. Debug build, diary pulled afterwards.

1. SEND, paste a Lightning invoice, and go to the home screen the moment the
   fee is being asked for. Come back after ten seconds. Do it five times.
   **Pass:** the diary has `staying on the network for … request(s) still
   out, 3s at most` and no `never left (the proxy refused the stream)`
   between a putting-away and the return after it.
2. In the same diary compare the entry relays `going to the background` with
   those at the next return. **Pass:** none goes from up to down across a
   trip.
3. Pay a tap and pocket the phone at once. **Pass:** as before: `staying on
   the network for … money request(s)`, and the payment is whole on return.
4. Put Foxy away and bring it straight back, ten times, quickly. **Pass:**
   every return connects; RECEIVE makes an invoice after each. Nothing says
   Foxy is not connected to Tor once the home screen is up.

### G. A card that holds ecash

This has run on one card and one phone, and not beyond that. The wallet, the
screens and the applet have also been driven together with no card in the loop
(tests/flashcard-*.js, and the simulator against the applet in a JavaCard
simulator); what is left is what only more cards, more phones, a radio and a
hand can show. Needs a card with the applet on it (the applet repository is
https://github.com/getfoxy/card, and its FORK.md says how to build the applet
and load it), a phone whose build carries the NFC entitlement
(tools/flashcard.entitlements), and a second phone at the same mint. How the card works, and what the app does with it, is in
[CARD.md](CARD.md).

#### 23a. A new card

1. MENU, FLASHCARD, and hold a new card to the top of the phone. There is no
   screen between the menu and the phone's own sheet. **Pass:** the sheet
   says to hold the card, then the FLASHCARD screen shows the card with NO
   PIN YET on its face, CARD BALANCE with one line saying the card is new,
   and SET UP THIS CARD. Note how long the read takes.
2. Hold a bank card to the phone instead. **Pass:** the sheet does not react
   to it at all, and times out.
3. SET UP THIS CARD, a PIN twice, tap. Nothing is asked about a lost card:
   cards are cash for now. **Pass:** THE CARD IS READY, saying it is cash and
   that a lost card, a forgotten PIN or three wrong PINs in a row lose what
   is on it. LATER, and the screen is home's shape: history and a cross at
   the top with FLASHCARD and "Verified Just Now" between them, the card,
   and CARD BALANCE with this phone's mint and a balance of 0 in the pill,
   over ADD FUNDS, WITHDRAW, CHANGE PIN and SET LIMIT.

#### 23b. Money on, and off

1. ADD FUNDS, an amount, the PIN, tap when asked. **Pass:** ON THE CARD with
   the new balance; the pill shows it; the phone's balance is down by the
   amount and what the mint charges; HISTORY has one entry, To card, and no
   second confirmation.
2. Tap the balance in the pill, then go back and tap the history button at
   the top left. **Pass:** both open CARD HISTORY with that one entry and no
   others; tapping the mint's tile in the pill does nothing.
3. Add again with a wrong PIN. **Pass:** WRONG PIN with the tries left; a line
   on the FLASHCARD screen says the money is waiting; TRY AGAIN with the right
   PIN puts it on.
4. With the card loaded, turn on airplane mode, wait a few minutes, and read
   it again. **Pass:** under the title it says when it was last verified
   ("Verified 5 Minutes Ago"), not "Just Now". Turn airplane mode off.
5. WITHDRAW, ALL OF IT, the PIN, tap. **Pass:** IN YOUR WALLET; the pill
   reads 0 on the next tap.
6. Load it again, WITHDRAW, ALL OF IT, and take the card away while the sheet
   is still counting pieces. **Pass:** TAP THE CARD AGAIN says how much came off
   into the phone and how much is left; HISTORY has an entry, From card, for
   what came off; TAP CARD asks no PIN and takes the rest; IN YOUR WALLET says
   the whole amount.
7. WITHDRAW part of it, an amount the card covers with a larger piece, so that
   the rest has to go back on it, the PIN, tap. **Pass:** one sheet from start
   to finish: it counts the piece it signs, says `Verifying. Keep this open: the
   rest goes back on the card.` while the mint is asked, asks for the card again
   (`Tap the card again for the rest`), and ends `Done. ₿… is back on the card.`;
   the phone buzzed three times while the sheet was still up; IN YOUR WALLET
   says the amount taken, and the card holds what it did less that. Do it again
   and take the card away when the sheet asks for it again. **Pass:** IN YOUR
   WALLET still says the amount, and TAP TO RECEIVE offers the tap for the rest,
   in a sheet of its own.

#### 23c. Paying another phone

1. On the second phone: RECEIVE, an amount, CARD, the card's PIN, tap.
   **Pass:** behind the sheet the screen is TAP TO VERIFY (light blue, a card's
   outline, arrows flying into its mark) over the amount; the sheet reads the
   card and counts the pieces it signs ("Signing piece 2 of 4"), and the moment
   the last is signed closes by itself, with the phone's tick and no words on it
   (the same whether change is coming or not), while the screen says VERIFYING
   CARD; then, where there is change, the phone buzzes three times as the sheet
   closes, the screen is TAP TO CONFIRM (orange) from the moment the change is
   made, and a second sheet comes up by itself about two and a half seconds
   later and asks for the card, until the change is back; and after that the
   ordinary paid screen. Time two things apart: from the first sheet opening to
   its closing (how long the card is held; the model says about 1.2 seconds for
   one piece, with the phone finding the card on top), and from there to the
   second sheet being asked for (the mint's part, over Tor, and the pause).
   These are the numbers that decide whether the card is usable at a till. Look
   at how much of the three screens the sheet's dimming leaves readable.
2. Load a card with 2,000 sats and pay it 600. **Pass:** two pieces are signed
   (512 and 128), and the card's part is done in under three seconds and its
   sheet closes; a second sheet then comes up by itself, asks for the card and
   puts the 40 of change back with no PIN, and PAYMENT RECEIVED goes up as that
   sheet ends, for 600. Time both taps. Pay it a price no two pieces cover.
   **Pass:** the fewest pieces that do are signed, and the second tap puts the
   change back.
2a. Close the second sheet (its Cancel) the moment it comes up for the change.
   **Pass:** the payment still stands; TAP TO CONFIRM was on the screen from the
   moment the change was made until now, and the home screen was not seen in
   between; now it says TAP TO RECEIVE, with TAP CARD and LATER. TAP CARD brings
   a sheet up for the card, and PAYMENT RECEIVED goes up when the change is back,
   for the right amount. Pay again, close the second sheet the same way, and
   press LATER. **Pass:** PAYMENT RECEIVED goes up for that payment. Then take a
   second payment straight away. **Pass:** its PAYMENT RECEIVED is its own
   amount, and the first's does not come up again.
2c. Lift the card away part way through the first tap. **Pass:** the screen
   turns to TAP AGAIN ("The last tap didn't finish...") on the light blue
   ground, the same sheet asks for the card, and the next tap finishes the
   payment. Pay again and lift the card away part way through the change, in the
   second sheet. **Pass:** the screen turns to TAP AGAIN on the orange ground and
   that sheet asks for the card again; the card has used up the one tap it allows
   without its PIN, so the sheet ends and the PIN pad comes up (`To put ₿… on the
   card`), and a third sheet, after the PIN, writes the rest: the change is all
   back.
2b. Pay from one card online several times (a few thousand sats each, from a
   card of forty thousand or so), then put the receiving phone in airplane mode
   and pay it three odd amounts. **Pass:** each offline payment is taken (HIGH
   RISK, then exactly), and none is refused with NO CHANGE WHILE OFFLINE: the
   online payments were made with pieces that left no gap. Note which pieces
   each online payment signed (the log says) and how many pieces of change went
   back.
3. The same, lifting the card away the moment the sheet first changes.
   **Pass:** one of two ends, and never a third: nothing was taken and the
   screen says so, or the card had signed and the payment stands (or is
   checked) with the sheet ended. Pulling it away between two signatures leaves
   nothing paid yet: the sheet comes up again by itself ("Hold the card here
   again to finish paying"), and the next tap signs only the rest and pays.
   **Pass:** HISTORY has one payment for the whole amount, and the card is down
   by exactly that (and its change). Pull it away again and let the sheet that
   comes up again time out: NOT PAID YET, with TAP CARD and CANCEL; CANCEL puts
   what it signed back on the card at a tap that comes up by itself.
4. Put Foxy away the moment the first sheet closes and wait. **Pass:** on return
   the payment is paid, or CHECKING says it is still being asked; the wallet asks
   again by itself. A mint that refuses a payment after the card has signed cannot
   be made on demand: PAYMENT FAILED with TAP CARD (the card's sheet had closed
   when it signed, so the put-back is a tap of its own), and the PUT BACK ON THE
   CARD that follows it, are driven in the simulated runs only.
5. Three wrong PINs at the till. **Pass:** CARD BLOCKED on the third, and the
   right PIN no longer opens it. On the holder's phone the card reads BLOCKED.

#### 23c-2. The limit on one tap

Needs a card with the software that waits (1.5: its screen offers PER TAP LIMIT
under CHANGE LIMIT, and a charge over the limit is not refused).

1. On the holder's phone: CHANGE LIMIT. **Pass:** a card asks which, PER TAP
   LIMIT or DAILY LIMIT, with CANCEL. PER TAP LIMIT, CONTINUE, an amount in
   dollars, CONFIRM, tap. **Pass:** no PIN is asked; `Per tap limit set.`; the
   card's screen says PER TAP LIMIT and the amount (or both limits on one line).
2. On the second phone, charge the card an amount at or under the limit.
   **Pass:** paid as fast as any payment. Charge it again straight away: the
   same. Nothing is remembered from the first. (Software 1.13: with a fresh tap
   each; two payments in one tap are the 23c-8 case.)
3. Charge it about twice the limit. **Pass:** the sheet and the screen say
   `Over the card's per tap limit. Keep holding:` with seconds that count
   up; then PAYMENT RECEIVED. Time it: about five seconds for the first limit's
   worth over the limit and two more for each after it (software 1.13; 1.12
   was about three for each limit).
4. Charge it about three times the limit and lift the card while it counts.
   **Pass:** nothing is taken (read the card on the holder's phone: the same
   balance). Tap again: it counts the whole wait again, and pays.
5. Charge it far more than the limit (a wait over forty seconds). **Pass:**
   refused before the PIN reaches the card, saying how long it would have to be
   held and what can be taken at a time.
6. On the holder's phone, WITHDRAW everything. **Pass:** it comes off with no
   wait, and afterwards the card's screen shows the same limits as before.
7. Dollars: set a per tap limit in dollars. Read the card again on the holder's
   phone on a day the price has moved by more than a fiftieth. **Pass:** the
   log says the card's limit was set to what its dollars are worth now, and the
   card's screen shows the same dollars as before.
8. Set the limit on one tap to NO LIMIT. **Pass:** `Per tap limit removed.`, and
   the daily limit, if there was one, is still there.
9. The longest wait a phone holds: with a small limit, charge an amount that
   waits thirty seconds or more. Note whether the sheet stays up to the end.

#### 23c-3. The card's own log

Needs the same card software as 23c-2.

1. Pay another phone from the card, then read the card on the holder's phone.
   **Pass:** under the balance, `Last tap:` with what the card signed for (the
   pieces, which may be more than the price) and the time. Press it. **Pass:**
   THIS CARD'S OWN LOG lists that tap and the ones before it, newest first, the
   totals, and `Since this phone last looked:` with the one tap. Read the card
   again. **Pass:** the tap is still listed, and nothing is said to be new.
2. Read the card on the second phone (not its owner). **Pass:** no log line.
3. A tamper cannot be made with Foxy itself, which never asks a card for more
   than its limit; it is driven in the simulated runs and in the card's own
   tests. With a desk reader and the card tools: set a limit on one tap, then
   send three spends of a piece larger than it, with the PIN. **Pass:** each is
   refused; the holder's phone then says `TAMPER: a terminal tried 3 times...`
   and TAMPER ON THIS CARD lists a tap of three refusals and nothing signed.

#### 23c-4. A card that signs once for a payment (software 1.4)

A card with the newer software, set up and loaded by this build. An older card
(1.3 and before) is still paid with as in 23a to 23c.

1. FLASHCARD reads it: its screen is as any card's. Load it: the money goes on
   in one tap, as before.
2. A till asks for an amount the card holds exact pieces for (most amounts,
   after a load): **one tap**, PAYMENT RECEIVED, and no TAP AGAIN for change.
   The sheet's line reads `Signing`, with no count of pieces. Time it from the
   PIN to the tick: it should not grow with the amount.
3. A larger amount, of many pieces: still one tap, and about as long. Note the
   time; how long the card takes over thirty-two pieces is not known yet.
4. An amount it cannot make exactly (empty the small pieces first by paying
   small amounts): one tap, then the change tap, as with an older card. Pay
   again with that change on the card: it is taken.
5. Take the card away the instant the sheet says `Signing`. NOT PAID YET. Tap
   again for the same amount: paid, and the card is out the amount once. Do it
   several times: each time it is either paid at the second tap with nothing
   more taken, or was never signed and is paid afresh.
6. The same, and at the second tap cancel and ask for another amount: the new
   amount is paid, and what was signed for the first goes back on the card at
   the change tap.
7. A per tap limit, then an amount over it: refused before the PIN. An amount
   under it made of many pieces: paid (the limit is on what they come to).
8. Top the card up a second time, then pay an amount larger than either load:
   one tap (both loads carry one date).
9. WITHDRAW the whole card to its holder's phone: one tap, however many pieces.
   With more than thirty-two pieces on it, still one tap.
10. With no connection, a till takes an exact amount on trust; back online it
    is swapped in and its entry settles.
11. The card's own log (23c-3) counts each payment once, with the number of
    pieces it was made of.

#### 23c-5. Software 1.6: speed, the hidden limit, receipts, a false time

1. **Speed.** Time a payment of many pieces from card found to the tick, and a
   whole card taken off. The log's `card: signed in` line says what each part
   took: note the milliseconds for the pieces (it was 79 a piece) and for the
   outputs. A load of thirty pieces: note the time (it was about 60 ms a piece).
2. **The limit is hidden.** Set a per tap limit on the holder's phone. Read
   the card on a second phone (FLASHCARD in its menu). **Pass:** it shows the
   daily limit or `NO DAILY LIMIT`, and no per tap limit.
3. Charge it over the limit on the second phone. **Pass:** `Over the card's per
   tap limit. Keep holding (N s)`, counting up, then PAYMENT RECEIVED.
4. Charge it far over the limit. **Pass:** after about forty seconds the till
   gives up and says to take it in smaller parts; nothing is taken.
5. **Receipts.** Pay with the card a few times, then read it on the holder's
   phone and open its log. **Pass:** `Receipts kept on this phone: N of N
   payments`, and COPY RECEIPTS copies one line a payment. On the second
   phone the card has no log line at all.
6. **What was put on.** The log's lines say `put on` for the loads.
7. **A false time.** Set a second phone's clock a day ahead by hand, and read
   the card on it. Then read the card on the holder's phone. **Pass:** `TAMPER:
   this card has been told a false time`, and the log says the card's clock is
   about a day ahead of this phone's. (Put the second phone's clock back.)

#### 23c-6. Software 1.8: 128 places and the deep drawer

A card with software 1.8 (the card's screen says its version nowhere; a card
that takes more than thirty-two pieces in a load is one).

1. **The load.** Put about fifteen dollars on an empty card. It takes
   noticeably longer than before (about a hundred pieces; note the seconds from
   the tap to `₿… went onto the card`). Lift the card half way through: the
   sheet asks for it again and the rest goes on.
2. **Eight in a row.** At a till, charge eight prices one after another, typed
   in dollars and none alike (50c, $1.50, 45c, ...), each under $1.65. Each is
   **one tap**: PAYMENT RECEIVED with no second tap for change. Note the time
   from card found to the tick in the log (`card: read in`, `card: signed in`):
   the read should be shorter than on a 1.6 card, not longer.
3. **When the drawer runs short.** Keep paying small odd amounts until a
   payment asks for the second tap. Its change should be worth going back for
   (a few hundred sats, not one or two), and the tap that writes it takes a
   second or two longer than a small change did. Then the next several
   payments are one tap again.
4. **With a per tap limit.** Set one (say $1) on the holder's phone. Pay small
   amounts until the drawer is short again. The payment that needs change must
   **not** say `Keep holding` unless what was charged is itself over the limit:
   the log says `card: it would wait for … sats; paid with … instead` where the
   till first asked for the larger set.
5. **Most of a small card.** Put five dollars on an empty card and charge
   $4.80. One tap. This is about fifty pieces in one signature, which is what
   1.8 is for and has only been run in the simulator: note whether it is
   paid, and how long the card was held. The card before it refused anything
   over a dozen pieces (`more pieces than the card signs for at once`); if
   this one does, say so.
6. **Taking it all off.** WITHDRAW a card with a full drawer to its holder's
   phone: one tap and one signature, about a hundred pieces. Note the seconds.
7. **Lifted as it signs.** Charge an amount of many pieces and lift the card
   the instant the sheet says `Signing`, several times. Each time it is either
   NOT PAID YET and paid at the next tap with nothing more taken, or was never
   signed and is paid afresh. Afterwards the card's balance and the phone's
   history agree to the sat: no piece is left on the card that was paid with.
8. **An older card.** A card still on software 1.6 or 1.7 pays, takes change
   and is topped up as before, with its thirty-two-piece drawer; WITHDRAW of
   more than eight pieces is several signatures in the one tap.

#### 23c-7. Software 1.9: the PIN is sealed

1. Set a new card up, put money on it, and pay at a till: everything is as
   before, and a payment takes a fraction of a second longer (one more command
   and the card's key agreement). The log's `card: signed in` line now begins
   after the PIN: note the time from card found to the tick against a 1.8 card.
2. A wrong PIN at a till: `Wrong PIN. 2 tries left.` Then the right one: paid,
   and the tries are back.
3. CHANGE PIN on the holder's phone: the old PIN is refused at a till and the
   new one pays.
4. A blocked card (three wrong PINs) is unblocked by its holder's CHANGE PIN,
   as before.
5. With a second phone that has an older build, if there is one: it cannot read
   this card at all (it does not know a card of 128 places). There is no way
   to make this build send a 1.9 card its PIN in the clear.

#### 23c-8. Software 1.13: the wait only over the limit, change in four pieces, three buzzes

Needs a card on software 1.13 (`01 0d` at SELECT), with a per tap limit, and a
second phone to be the till.

1. Charge the card an amount within its limit that it cannot make exactly (a
   card with one large piece, say 4,096 sats, charged 1,631). **Pass:** no
   `Keep holding` wait at all: the sheet says `Signing`, then `The card is making
   change · piece 1 of 4. Keep holding.` through piece 4 (the line changes a
   piece about every half second), and then the sheet closes with the phone's
   tick and no words on it.
2. **Three buzzes.** In the same payment, as the card has signed and the sheet
   closes, the till's phone buzzes three times, 0.15 seconds apart, hard enough
   to feel through the hand that holds the card, and a second sheet then comes up
   by itself for the change. **Pass:** three, and distinct from the single quiet
   tap of a payment with no change and from the success buzz at PAYMENT
   RECEIVED. Charge an amount the card makes exactly. **Pass:** the single quiet
   tap, no three, and the sheet closes the same way. (Core Haptics is not
   available while some sessions are open: if the three do not come while the
   NFC sheet is going down, say so.) Note how long the first tap took against one
   with no change: change may add about two seconds, four pieces at about half a
   second.
3. **Four at most.** Charge 1,739 from a card of one piece of 4,096 (the change
   is 2,357 sats, 2048 + 256 + 32 + 16 + 4 + 1). **Pass:** the card is asked for
   four pieces; the 5 sats that are left are made by the till and written with them
   at the second tap (the log says: `the card makes 2352 sats of the change itself,
   in 4 pieces (2048 + 256 + 32 + 16); 5 sats more are made here after the swap`).
   The second tap writes six pieces.
4. Over the limit by a sat or more: charge about twice the limit. **Pass:** the
   `Over the card's per tap limit` wait of about five seconds, counted up, after
   the change pieces if any.
5. **One payment a tap.** On the holder's own phone, WITHDRAW a card whose pieces
   are of two dates. **Pass:** both signatures with no wait: its grant is given
   first, and nothing takes it away between them. (A till makes one payment in a
   sheet and the card leaves the field when the sheet ends, so a till is never
   the second payment of a tap today; if a build ever makes one, the sheet says
   `A second payment in one tap. Keep holding` and the card waits about five
   seconds.)

#### 23d. What a card cannot be made to do

1. With the card blocked (23c), read it on the holder's phone. **Pass:** the
   card's face says BLOCKED and the line under the balance says what is on it
   cannot be got back; there are no buttons under it. Do this with a card
   holding a few sats and no more.
2. Put Foxy away in the middle of a tap. **Pass:** the sheet goes; on return
   nothing is half-done that the next tap does not finish.
3. On a build without the entitlement: MENU, FLASHCARD. **Pass:** NO CARD
   READER, and nothing else.

---

#### 22l. What two diaries of offline taps showed besides the money

*All of it needs phones: the radios, a real return from the background, and
two phones for the last.*

1. **No RESTART TOR with the radios off.** Airplane mode, open Foxy, PROCEED
   OFFLINE, leave it open a minute, put it away and bring it back, leave it
   another minute. **Pass:** wherever the diary says the phone has no
   network, it never says `RESTART TOR offered`.
2. **Payments waiting, said once.** Still offline, with two or more payments
   received and waiting, go to SEND and back several times. **Pass:** the
   diary says once how many payments wait to be swapped in, and again only
   when that number changes; there is no line for each payment at each
   screen.
3. **A look at another app.** Online, on the home screen: go to another app
   for ten seconds and come back, then SEND. **Pass:** no splash and no
   SECURING YOUR CONNECTION, and the camera is there at once. The diary says
   `tor: kept on the network while Foxy is away`, then `back after …s and
   the circuit is up; nothing to set up` and `back with the connection still
   up`. Then stay away a minute: `tor: off the network while Foxy is in the
   background` comes about twenty-four seconds after leaving, and the return
   shows the connection screen as in §5a. With a PIN set, look at how long
   the splash stays before the PIN pad on a return.
4. **Wi-Fi back while Foxy is away.** Working offline, put Foxy away, turn
   Wi-Fi on, and bring Foxy back within a few seconds. **Pass:** the
   connection screen stays until the home screen is there with its secure
   connection, and the diary says `the try from offline got through`, not
   `the person chose to work offline`.
5. **An over-payment's change.** An offline payer with no exact pieces pays
   an online receiver by tap. **Pass:** the receiver's balance goes up once,
   by what it asked, and never shows the larger piece; the payer's diary has
   no `Implicit numeric coercion` line as its change arrives.

#### 22m. Home first: the connection as a banner

*Needs phones. A wallet that has connected at least once; the first step needs
a fresh install.*

1. **A first launch.** Delete Foxy, install, open. **Pass:** the fox plays,
   then SECURING YOUR CONNECTION with its count, then the home screen. Close
   Foxy fully and open it again: no fox.
2. **Every launch after.** Close Foxy fully and open it. **Pass:** the splash,
   then the home screen within about a second, with the balance and the last
   price, and the banner SECURING YOUR CONNECTION at the foot. A few seconds
   later the banner turns to Secure Tor Connection by itself, with no screen
   in between and no toast. The diary says `tor gate: home first` and never
   `tor gate: connecting`.
3. **No network.** Airplane mode, open Foxy. **Pass:** the home screen at
   once, with OFFLINE - NO CONNECTION. Turn the radios on: the banner goes to
   SECURING YOUR CONNECTION and then to Secure, with no screen.
4. **The banner's tap.** While it says SECURING YOUR CONNECTION, tap it.
   **Pass:** the connection screen with its count, which comes down by itself
   when Tor is through. In airplane mode the tap shows NO CONNECTION with TRY
   AGAIN and PROCEED OFFLINE.
5. **Starting at once.** Open Foxy and go straight to RECEIVE, an amount,
   NEXT, before the banner has turned. **Pass:** a code is up at once; when
   the connection lands the app stays on that screen (it is not thrown back
   to the home screen), and the diary says `a route is up and this wallet
   came from storage`.
6. **A scan in the first seconds.** Open Foxy and at once scan a plain ecash
   token from another wallet. **Pass:** no HIGH RISK card; it waits a moment
   (`a connection is on its way; waiting for it`) and is taken as usual.
7. **A tap in the first seconds.** Two phones, the payer opened a moment ago.
   **Pass:** the payment is made locked (the diary says `locked to them`), not
   from pieces on hand with change to come back.
8. **A long return.** Put Foxy away for a minute and bring it back.
   **Pass:** the home screen at once with SECURING YOUR CONNECTION, then
   Secure; no connection screen, no splash held.
9. **Tor in trouble.** With a VPN that Tor cannot get through, or Orbot on
   and not allowing Foxy, open Foxy. **Pass:** the home screen, with CANNOT
   CONNECT on the banner (or SECURING while Tor still tries); the tap brings
   the screen that says what to do.
10. **The same payment twice.** Offline receiver. Pay it by showing a code,
    which it scans; then send the very same token over the tap from a payer
    that still holds it (a second phone restored from the same words will
    do). **Pass:** PAYMENT RECEIVED once; the balance counts it once.

## Getting a log off somebody else's phone

`tools/pull-device-log.sh` needs a Debug build and a cable. A person running a
shipped build has neither, and `DebugLog` is not compiled into one — so what
they can hand over is the **LOGS** screen: MENU → SETTINGS → LOGS → **SHARE**,
which puts the session into Files, Mail or AirDrop as one piece of text.

It is not the same record and it is worth knowing how it differs:

- **Memory only.** Nothing is written to a file and nothing leaves the phone
  until they tap SHARE. Foxy sends none of it anywhere on its own.
- **10,000 lines**, plus a 3,000-line connection diary that survives one
  relaunch — because a force-quit is what a person does after a problem, and
  the run that gets killed is the interesting one.
- **Redacted on the way in**: tokens, invoices, payment requests, onion
  addresses, nostr keys and long hex are replaced by their length. **Mint hosts
  and amounts stay**, because they are what makes a report answerable, and the
  screen says so above the button before anything is copied.
- The first line is the build: `Foxy 1.0 (1) on iOS <version>`. A report
  without it is a guess.

## Part 2 — Status

Which sections have been run on a device, and which have not. "Simulator only"
means the logic was proved there and the device behaviour was not. "Not run"
means no run is recorded against the checklist, whether or not the feature has
been used on a phone. Update the table when a section is run.

| Status | Sections |
|---|---|
| Run on a device, passed | §1, §5a, §5f, §5g, §5h, §5i, §14a, §14b, §21a (all traffic is Tor; the control run with CONTINUE UNPROTECTED is not done), §22b |
| Run on a device, in part | §4 (each transport connects; a payment through each is not run), §5b (long returns reconnect, including the recovery from a reclaimed control listener; the 30 minute return on cellular with the phone locked is not recorded), §14c (a pasted phrase stayed on the clipboard; fixed in code, not re-run), §17 (the card and the token work and three faults it found are fixed; run it again) |
| Simulator only | §8, §10, §11, §12 (the keychain test, not 12b to 12d), §16, §19 (steps 1, 3 and 4), §20 (steps 1 and 4), §21b (the mechanism; the 4-to-5-second claim is not tested), §21c, §21e (steps 1 and 2), §21f (step 1), §21g (steps 1 and 2) |
| Not run | §2, §3, §5d, §5e, §6, §7, §9, §12b, §12c, §12d, §13a to §13j, §14d, §14e, §15, §18, §21d, §21h, §22a, §22c, §22d, §22e, §22f, §22g, §22h, §22i, §22j, §22k |
