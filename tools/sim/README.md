# tools/sim — simulator tests

Each script builds what it needs (a locally signed Debug build via
`tools/sim-build.sh`, unless `FOXY_APP` names one), picks a booted simulator (or
`FOXY_SIM_UDID`), and writes logs to `build/sim-out` (or `FOXY_SIM_OUT`). Run
`xcodegen generate`, `bash tools/build-tor.sh` (once) and then `pod install` first.

| Script | What it checks | Time |
|---|---|---|
| `keychain.sh` | seed made, kept across a relaunch, removed on reinstall; `-FoxyKeychainTest` rules | 2 min |
| `keychain-unavailable.sh` | an unsigned build, whose keychain never answers: no seed made, connect refuses | 3 min |
| `first-launch.sh` | new installs, one after another: time to a first circuit, and how often the stall watch nudged Tor | 4–8 min |
| `resume.sh` | coming back from the background, normal and with Tor broken on return | about 4 min, 8 with a bridge |
| `release-silence.sh` | a Release build prints nothing, ignores Debug flags, and still reaches Tor | 3 min |
| `bridges.sh` | Snowflake, obfs4 and the fallback; every remote address Foxy opens, classified | 15 min |
| `trials.sh` | Tor carrying requests after "ready", for any launch arguments | varies |
| `orbot.sh` | a fake Orbot on the Mac (`fake-orbot.py`, `socks-log.py`); needs no VPN on the Mac to show the fake ignored | 6 min |
| `log-invariants.sh` | sections 16 and 21c of `DEVICE-TESTS.md` graded instead of grepped (one circuit per job, nothing identifying at launch, and which source the price came from), and 21b (the Tor directory pre-seed) reported, not graded. Reads logs only. Insists on `FOXY_SIM_UDID`; `FOXY_LOG=file` grades a phone log from `tools/pull-device-log.sh` instead | 5 min |

These talk to the Tor network, and `trials.sh` and `release-silence.sh` fetch
`check.torproject.org` through Foxy's Tor. The fast checks that need neither are
`sh tools/check-all.sh`.

## Two simulators paying each other

The simulator has no Bluetooth, so a tap could only be driven on two phones.
A simulator build now carries two stand-ins, neither compiled for a phone:

- **The link.** `SimTapReceiver` and `SimTapPayer` (end of
  `Foxy/Bluetooth/TapLink.swift`) carry the tap conversation over a socket on
  the Mac's loopback, ports 47411–47418, which every simulator shares. The page
  and the bridge cannot tell: same stages, same offer, payment, answer, change,
  asking, price and terms. The payer's CONNECT TO PAY card is not a button,
  so on a phone only the touch takes the link; here the touch is a file named
  `sim-touch` in the payer's Documents folder, used up by the link it makes.
  What it does not test is the radio: range, RSSI, edges, a link dropped by
  walking away, the sealing in `TapSession`.
- **Pretend airplane mode.** While a file named `sim-offline` exists in the
  app's Documents folder, the network reads "none" through the same door a real
  change comes through (`Foxy/Network/Route.swift`), so Tor comes off the network and the
  page shows NO CONNECTION and PROCEED OFFLINE as on a phone.

      touch "$(xcrun simctl get_app_container <device> <bundle id> data)/Documents/sim-offline"
      rm    "$(xcrun simctl get_app_container <device> <bundle id> data)/Documents/sim-offline"
      touch "$(xcrun simctl get_app_container <device> <bundle id> data)/Documents/sim-touch"

Each simulator's diary is in its data container, under
`Library/Application Support/foxy-logs/foxy.log`. The mints are real ones over
Tor: a simulator cannot reach the Docker mints on localhost through Tor.
