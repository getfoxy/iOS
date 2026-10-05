# Security policy

Foxy is a Cashu ecash wallet for iOS. It holds bearer tokens: a bug here can
lose someone's money or reveal what they paid for and from where. Reports are
welcome and taken seriously.

It is a personal project, not a company. There is no bug bounty, no support
team and no promised response time. Every report is read, and a confirmed one
is fixed before anything else.

## How to report

**Privately, through GitHub:** on this repository, open the **Security** tab
and choose **Report a vulnerability**. That creates a private advisory only
the maintainer can see.

Please do not open a public issue, pull request or discussion for a
vulnerability. Do not post it to Nostr or anywhere else before a fix ships.

A useful report says:

- what an attacker can do, and what they need first (a malicious mint, a
  scanned QR code, the unlocked phone, a network position)
- the commit or build it was found on
- the steps, a proof of concept, or the line of code
- what you expected instead

## Testing

- Use **test mints and throwaway seeds only**. `testnut.cashu.space`, or a
  local CDK or Nutshell mint (`tools/live/README.md` has the setup).
- Never test against someone else's wallet, funds or device.
- Do not attack a public mint's availability. A mint's own bugs belong to its
  operator and its software (CDK, Nutshell); Foxy's handling of a hostile or
  broken mint is in scope.

## In scope

- **Money:** anything that loses, duplicates, or wrongly spends ecash — proof
  handling, counters, melts, swaps, restore, backups (`MONEY.md`).
- **The seed and PIN:** keychain storage, anything that leaks or weakens the
  seed, anything that bypasses the app lock (`SEED-HANDLING.md`).
- **Network privacy:** any request that leaves the phone outside Foxy's Tor
  without the person choosing to continue unprotected, anything that links
  requests Tor isolation should keep apart, IP or DNS leaks (`NETWORK-TEST.md`).
- **The native bridge:** a page script, a scanned code, a mint response or a
  payment request that reaches a bridge action it should not, or makes one do
  more than it should (`THREAT-MODEL.md` §1).
- **Build and supply chain:** the vendored cashu-ts bundle, the renderer, the
  pluggable transports, and the scripts that verify them (`AUDIT.md`).
- **Tap to pay:** the Bluetooth link between two phones — anything that lets a
  third phone read a payment, stand in the middle of one, learn who is paying
  or being paid, or make a Foxy discoverable when it should not be (the
  payer never advertises; `TAP-TO-PAY.md` says when a receiver is on the air).
  Proximity is not claimed as a defence; the four digits are, and they are
  offered rather than enforced.

## Out of scope

- Bugs in upstream projects with no Foxy-specific impact. Report them to that
  project: cashu-ts, Tor, Tor.framework, IPtProxy, CDK, Nutshell.
- What the Cashu design itself allows: a mint can refuse to redeem the ecash it
  issued. `THREAT-MODEL.md` §5 covers what Foxy does about it.
- Attacks that need a jailbroken phone, or a phone already compromised.
- The documented limits in `THREAT-MODEL.md`: §9, §10 and, for the network,
  "What it does not promise" in §4.

## Where to start reading

`AUDIT.md` maps the code for a reviewer. `THREAT-MODEL.md` says what Foxy
defends against and what it does not, and what has and has not been tested on
a real phone.
