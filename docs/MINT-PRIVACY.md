# MINT-PRIVACY.md — what a mint can learn, and what ties it together

Written from an inventory of every request Foxy makes to a mint
(build/wallet, build/app, cashu-ts 4.11.0). THREAT-MODEL.md §4 describes Tor;
MONEY.md describes what each operation writes. This file is about one question:
**how could a mint tie many of one person's operations together, and what does
Foxy do about each way?**

## What a mint never learns

- **Who you are.** Foxy has no account, email or phone number, and neither do
  the mints it lists.
- **Your IP address.** Every request goes through Tor; the mint sees an exit.
- **Which ecash it issued is being spent.** Blind signatures (NUT-00): the mint
  signs outputs it cannot see, so the proofs it later receives do not match
  anything it signed.

That leaves pseudonymous linking: the mint cannot name you, but it may be able
to say "these operations were one wallet". That matters because one operation
that *does* point at a person (an invoice from an exchange that knows you, a
payer who knows who they paid, a Lightning address with a name in it) then
names everything linked to it.

## What each operation shows

| Operation | Requests | What the mint sees |
|---|---|---|
| Connect | GET info, keysets, keys | that someone uses the mint |
| Receive by Lightning | quote, polls, mint | the amount, the invoice it made, a one-time NUT-20 key, new blinded outputs |
| Receive a token | checkstate, swap | the token's proofs (amounts, secrets), new blinded outputs |
| Send a token | swap | inputs taken from the pile, blinded outputs for the token and the change |
| Pay an invoice | melt quote, swap, melt | the invoice (amount, destination, description), the inputs, blank change outputs |
| Send a token from pieces held | nothing | nothing: no swap, no request |
| Keep small change | one swap, only once Foxy is put away; a payment's own swap fills the pool too | a piece swapped for small ones |
| Watch a sent token | checkstate after 2–4 s (no swap, or after a return) or 15–45 s (after a swap), then every 3–5 s, 15–30 s after two minutes, 1–2 min after ten | the token's fingerprints (Ys) |
| Tell a mint's own invoices | once, if unknown: a 1-sat quote, never paid | that someone asked for an invoice |
| Check the keys | GET keysets again, 30 s–2 min after a connect | that someone uses the mint |
| Move between mints | quotes and a melt at each | both halves of one Lightning payment |
| Restore from seed | restore ×100 per batch, checkstate | every blinded message this seed ever had signed there |

## The ways operations get tied together

Each is **fixed** (with the test that fails without it),
**inherent** (Cashu or Lightning works this way; the note says what limits it),
or **open** (a change is possible and not made; proposals below).

### Network

**N1. One circuit for everything at a mint — fixed.** `IsolateDestAddr` put
every request to one mint on one Tor circuit for up to ten minutes, so a launch,
a payment and a receive in that window arrived from one exit. Each job now logs
in to Tor's SOCKS port with its own label and gets its own circuit
(THREAT-MODEL.md §4, "One circuit per job at a mint"). Requests that are linked
anyway share one: an invoice's polls and its claim (the quote id), one
payment's quote, swap and melt (the inputs). Test: "each job at a mint leaves
on its own circuit, and connecting asks the mint about no proof and no sent
token".

**N1a. A question asked twice — a small, chosen cost.** A circuit sometimes
goes nowhere, and a request on it sits until its clock runs out: a minute for
an invoice, on a phone standing beside one the same mint answered in two
seconds. An invoice and a fee quote are asked again on a second circuit after
five seconds of nothing, and the first answer is used (`askedTwice`); a proof
check has done the same after six. What the mint can join by it: the two fee
quotes name the same Lightning invoice, so they are plainly one payment's, as
that payment's quote, swap and melt already were. The two invoice requests
share nothing but their amount and their second: each carries a one-time
NUT-20 key of its own. A payment whose quote came by the second circuit goes
on by it, so it is still one circuit for the money. A swap or a melt is never
asked twice. Tests: "an invoice the mint is slow to give is asked for again,
and the first to answer is the invoice" and the four after it.

**N1b. A circuit kept ready — a small, chosen cost.** A circuit takes a second
or three to build after Foxy comes to the front, and one that goes nowhere
costs a minute. One is opened ahead of time, by asking the mint for its
keysets on it, and kept only once the mint has answered (`warmSpare`). The
next job a person is waiting for takes it: an invoice, a fee quote, a payment,
a token's swap (`needNow`). It is handed out once and is then that job's
alone, so it is still one circuit to a job; what the mint sees on it is a
question about its keysets and then the job, which is how a job's first
connect looks anyway. Sweeps, checks and top-ups do not take it. It is let go
after five minutes, when the mint changes, and when Foxy has been away. The
cost is one more public question to the mint each time Foxy is opened. Tests:
"a circuit is made ready ahead of time, and the next invoice leaves on it" and
the three after it.

**N2. TLS session resumption — not a vector.** Checked locally: a new
URLSession offers no session from another (TLS 1.2 and 1.3), and Foxy makes a
new session for every request (Route.startOnce).

**N3. How the requests look — inherent, narrowed.** The User-Agent is Tor
Browser's and there are no cookies. The TLS handshake is still Apple's, so a
mint can tell "an iOS app over Tor" apart from Tor Browser. That sorts Foxy
users (and other iOS wallets) into a group; it does not tell one from another.

**N4. Timing — fixed where Foxy chooses the moment.** Jobs that start in the
same second can be matched whatever their circuits. On a connect or return the
sweeps asked about each outstanding invoice, each held melt and each lost-swap
record straight after one another. Each invoice check (and each split row's)
now waits a random 1.5 to 5 seconds, and the melt and swap sweeps wait between
them (`sweepPause`), never inside the proof lock where a payment would wait too.
Test: "a sweep checks each outstanding invoice after a pause, each on its own
circuit". What a person does (pay, receive, open a token) still happens when
they do it.

### What the requests carry

**C1. Every proof's fingerprint at every launch — fixed.** `reconcile()` sent
the Y of every proof held in one request at boot, on every return from the
background and on pull to refresh. The same list each time was a name the
wallet gave itself: the mint could recognise it over any exit, and as those
proofs were later spent (revealing their amounts) rebuild its balance over
time. Now a proof is asked about only when a payment carrying it is refused as
spent, and only the proofs that payment sent (MONEY.md §5). Tests: the connect
test above, and "a payment that picks ecash spent elsewhere asks about only
what it sent".

**C2. Asking about sent tokens at every connect — fixed.** An earlier version
asked about each sent token still on file, from the sender's wallet, on every
connect. When the receiver redeemed it, the mint had the sender asking about
exactly what the receiver redeemed: who paid whom. A token is now asked about
only by its own watch (C6), which runs while its screen is open and for a day
after, on a circuit used for nothing else, and never as a sweep at connect.
Test: "a sent token is asked about on a circuit of its own, the same one each
time".
*What remains:* if the receiver redeems while the sender watches, the check
that first reads SPENT follows the redemption within seconds; that ties
nothing new to the sender, whose check carries only the token.

**C3. "Foxy" on every invoice and Lightning-address payment — fixed.** An
invoice with no note carried the description "Foxy", which the mint and the
payer both read, and every Lightning-address payment sent the comment "Foxy" to
the address server. The wallet already said there should be no default
description (15-receiving.js); the app layer still supplied one. Both now send
the person's note or nothing.

**C4. Inputs spent together are one wallet's — inherent.** A swap's inputs
arrive in one request. When a send combines proofs from two earlier receives,
the mint learns those receives were one wallet's (the same reasoning as
Bitcoin's common-input heuristic). cashu-ts picks inputs by amount, not by where
they came from (`selectProofsRotating`). Every swap also produces the change
that the next one spends, so a wallet's history is a chain of swaps a mint
could try to follow by amount and time — but blind signatures mean it cannot
see which outputs became which inputs. Limits it: the mint cannot tell whose
proofs arrive, only that they arrive together.

**C5. Amounts — inherent.** A token made for 5,000 sats and redeemed for
5,000 sats can be matched by amount and time. Each proof's amount is a power of
two, so round figures blend in better than unusual ones.

**C6. Lightning between two people on the same mint — inherent; a token is
offered.** The mint makes the receiver's invoice and is asked to pay it; both
halves carry one payment hash, so it knows which wallet paid which. A token
handed over directly leaves it amount and timing. When a scanned or pasted
invoice was signed by the mint's own Lightning node, Foxy shows PAYING ANOTHER
<MINT> USER with USE CASHU and CONTINUE OVER LIGHTNING. USE CASHU makes a token
for the invoice's amount, and its screen says "Share this with who you are
trying to pay"; the receiver takes it with SCAN on their invoice screen.

- **Knowing the mint's node.** Each invoice a mint makes for this wallet names
  its signer, recovered from the BOLT11 signature (05-paying-this-mint.js,
  tested against BOLT11's example and a Nutshell mint's invoice, and fuzzed).
  A mint that has made none is asked for a 1-sat invoice on a circuit of its
  own, never paid: once a session 10 to 40 seconds after connecting, at once
  on a mint this wallet has never been on, and at once if an invoice is scanned
  before that. (It first waited up to 3 minutes
  and never asked at scan time, so invoices from Minibits and cashu.me went by
  Lightning with no card until Foxy had made an invoice itself.) A
  node a mint shares with another service (coinos's wallet) can make that
  service's invoice look like the mint's; the card still offers Lightning.
- **Hearing that the token was redeemed, within seconds.** The
  watch sends the mint the token's fingerprints alone, on one circuit used for
  nothing else, for a day. How soon it first asks depends on what the mint saw
  when the token was made. A token made with a swap waits 15 to 45 seconds, so
  the question does not follow that swap by the moment. A token made from
  pieces already held asks the mint nothing when it is made, so there is no
  moment to tie a question to: it asks in 2 to 4 seconds, and every 3 to 5
  seconds for two minutes. Foxy keeps a pool of small pieces on hand for that:
  twelve of each of 1, 2, 4 ... 128 sats and eight of each larger power of two
  up to 65,536 (MONEY.md §13). A payment's own swap fills the pool, and a
  top-up swap (`tidyChange`) runs only once Foxy is put away, never in the
  foreground, on its own circuit. After a return from the background every watch asks within 2 to 4 seconds:
  the swap that made the token was long before. A token redeemed while its
  ECASH TOKEN screen is open gets the payment confirmation; anywhere else, a
  note. iOS runs nothing while Foxy is in the background, so a token redeemed
  then is heard about after the return. Tests: "a token the pile can make
  exactly needs no swap…", "small change: …", "a token made to pay someone is
  watched by its fingerprints alone…", tests/pay-this-mint.js.

**C7. The invoice a payment carries — inherent to Lightning.** A melt shows the
destination node, the amount and the invoice's description. Paying a merchant or
exchange tells the mint who was paid.

**C8. Lost-answer recovery asked about the whole pile — fixed.** A send's swap
record kept the whole pile the swap was handed, because cashu-ts picks the
inputs inside `send`, and recovery (`swapExpectation`, `pruneSpent`) asked the
mint about all of them: C1's list again. The wallet view now tells the record
which proofs the swap carries as the request goes out, and recovery asks about
those alone. A record written by an older build still holds the whole pile.
Test: "a lost send swap records the proofs it sent…".

**C9. A seed restore re-sends the whole history — inherent; no longer started
on a mint already used — fixed.** NUT-09 restore sends the blinded messages the
seed would have made; the mint matches each to what it signed and so learns
every operation this seed ever did there, in one scan. Switching to a mint where
nothing is filed scanned it, so switching back to a mint this wallet had used
and emptied handed over its history each time. A switch now scans only a mint
this device has never connected to (`mintUsedBefore`, kept in
`foxy.cashu.mints.used`, which removing a mint from the list does not prune).
The RESTORE screen still scans what the person picks. Test (switch-guard.js):
"switching back to a mint used before scans no seed there".

**C10. A mint that gives one wallet its own keys — checked.** A mint could
publish a keyset to one visitor only and recognise that wallet's ecash wherever
it turns up. The DLEQ check (NUT-12) proves a signature matches the keys the
mint published to this wallet, not that anyone else got them. 30 seconds to 2
minutes after a connect, the mint's keyset list is asked for again on a circuit
nothing else uses; keyset ids are derived from their keys (cashu-ts drops keys
that do not match), so an id this wallet holds that the list leaves out was
shown to this wallet alone. A miss is asked once more on another circuit, then
THIS MINT MAY BE MARKING THIS WALLET is shown. It warns and blocks nothing: the
ecash is still worth what it was. Test: "a keyset shown to this wallet alone is
reported…".

**Not vectors:** NUT-20 quote keys are new for every invoice. A payment request
carries a P2PK key, fresh for that request and never reused, so the lock ties a
payment to that request and to nothing else; an ordinary send carries no lock.
Foxy uses the mint's cheapest active keyset, as other wallets do. Secrets are
standard NUT-13, except a locked proof's, which is the NUT-10 condition.

## What is left open

What is left open is what Cashu and Lightning are: amounts and timing (C5),
inputs spent together (C4), what an invoice says (C7), and a restore the person
asks for (C9).

## Checking it on a phone

In a Debug build every mint request writes `mint <method> <path> on circuit
<first six characters of its label>` to the debug log
(`sh tools/pull-device-log.sh`). A launch shows the keys fetches on different
labels, each invoice in a sweep on its own, and no `/v1/checkstate` unless a
token screen is open or a payment was refused. A payment's quote, swap and melt
share one label; the next payment has another.
