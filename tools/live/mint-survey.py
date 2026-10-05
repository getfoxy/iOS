#!/usr/bin/env python3
"""mint-survey.py — how a mint behaves when Foxy talks to it.

    python3 tools/live/mint-survey.py --socks 56541 [--rounds 4] [mint ...]

Each round asks a mint two things, the two Foxy asks before it can do anything:

    GET  /v1/info                    who are you, and what do you support
    POST /v1/mint/quote/bolt11       make me an invoice for 100 sat

The quote is never paid. It expires on its own, costs nothing, and is the same
request Foxy makes the moment somebody taps RECEIVE — so a mint that answers
/v1/info and then cannot quote is a mint Foxy cannot actually receive on, which
is the distinction this is for.

**Over Tor, through a running Foxy's own SOCKS port.** Foxy never reaches a
mint any other way, so timings taken on the clearnet would not be the ones
anybody experiences. Find the port with:

    pid=$(pgrep -f "<simulator-udid>/.*Foxy.app/Foxy" | head -1)
    lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN

Latency over Tor is dominated by the circuit, not the mint, which is why this
reports the median of several rounds and the spread, never a single figure.
Two mints half a second apart are not meaningfully different; one that fails a
round is.
"""
import argparse
import json
import statistics
import subprocess
import sys
import time

MINTS = [
    "https://21mint.me",
    "https://mint.agorist.space",
    "https://cashu.cz",
    "https://cashu.21m.lol",
    "https://mint.lnpay.cz",
    "https://kashu.me",
    "https://mint.macadamia.cash",
    "https://mint.mineracks.com",
    "https://forge.flashapp.me",
]

# What Foxy needs from a mint, by NUT number.
NEEDS = {
    "4": "mint (receive over Lightning)",
    "5": "melt (send over Lightning)",
    "7": "checkstate (is this token spent)",
    "8": "blank outputs (overpaid fee change)",
    "9": "restore (recover from the twelve words)",
    "12": "DLEQ (proof the mint signed honestly)",
    "20": "signed quotes (a quote nobody else can claim)",
}


def ask(url, socks, timeout, method="GET", body=None):
    """One request through Tor. Returns (seconds, status, parsed-or-text, error)."""
    cmd = ["curl", "-s", "-o", "-", "-w", "\n%{http_code}", "-m", str(timeout),
           "--socks5-hostname", f"127.0.0.1:{socks}", url]
    if method == "POST":
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(body or {})]
    began = time.monotonic()
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    except subprocess.TimeoutExpired:
        return time.monotonic() - began, 0, None, "gave up"
    took = time.monotonic() - began
    text = out.stdout or ""
    if "\n" not in text:
        return took, 0, None, (out.stderr or "no answer").strip()[:60] or "no answer"
    payload, _, code = text.rpartition("\n")
    try:
        status = int(code.strip())
    except ValueError:
        status = 0
    if status == 0:
        return took, 0, None, "no answer"
    try:
        return took, status, json.loads(payload), None
    except json.JSONDecodeError:
        return took, status, payload[:200], "not JSON"


def survey(mint, socks, rounds, timeout):
    row = {"mint": mint, "info_ms": [], "quote_ms": [], "info_ok": 0, "quote_ok": 0,
           "name": None, "version": None, "nuts": None, "nutsRaw": None,
           "cap": None, "notes": []}
    for _ in range(rounds):
        took, status, data, err = ask(mint.rstrip("/") + "/v1/info", socks, timeout)
        if status == 200 and isinstance(data, dict):
            row["info_ok"] += 1
            row["info_ms"].append(took * 1000)
            row["name"] = data.get("name") or row["name"]
            row["version"] = data.get("version") or row["version"]
            if row["nuts"] is None and isinstance(data.get("nuts"), dict):
                row["nuts"] = sorted(data["nuts"].keys(), key=lambda k: (len(k), k))
                row["nutsRaw"] = data["nuts"]
            if data.get("max_array_length") is not None:
                row["cap"] = data["max_array_length"]
        else:
            row["notes"].append(f"info: {err or status}")

        took, status, data, err = ask(
            mint.rstrip("/") + "/v1/mint/quote/bolt11", socks, timeout,
            method="POST", body={"unit": "sat", "amount": 100})
        if status == 200 and isinstance(data, dict) and (data.get("request") or data.get("quote")):
            row["quote_ok"] += 1
            row["quote_ms"].append(took * 1000)
        else:
            detail = err or status
            if isinstance(data, dict) and data.get("detail"):
                detail = str(data["detail"])[:70]
            row["notes"].append(f"quote: {detail}")
    return row


def median(v):
    return statistics.median(v) if v else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--socks", required=True, help="a running Foxy's Tor SOCKS port")
    p.add_argument("--rounds", type=int, default=4)
    p.add_argument("--timeout", type=int, default=25)
    p.add_argument("mints", nargs="*", default=None)
    a = p.parse_args()
    mints = a.mints or MINTS

    check = subprocess.run(
        ["curl", "-s", "-m", "20", "--socks5-hostname", f"127.0.0.1:{a.socks}",
         "https://check.torproject.org/api/ip"], capture_output=True, text=True)
    if '"IsTor":true' not in (check.stdout or ""):
        print(f"port {a.socks} is not carrying Tor — refusing to survey over the clearnet")
        return 2
    print(f"over Tor via 127.0.0.1:{a.socks}, {a.rounds} rounds each, {len(mints)} mints\n")

    rows = []
    for m in mints:
        sys.stdout.write(f"  {m} … ")
        sys.stdout.flush()
        r = survey(m, a.socks, a.rounds, a.timeout)
        rows.append(r)
        print(f"info {r['info_ok']}/{a.rounds}, quote {r['quote_ok']}/{a.rounds}")

    print("\n" + "=" * 100)
    print(f"{'mint':30} {'info':>6} {'quote':>6} {'info ms':>9} {'quote ms':>9}  implementation")
    print("-" * 100)
    for r in sorted(rows, key=lambda x: (-x["quote_ok"], median(x["quote_ms"]) or 1e9)):
        im = median(r["info_ms"])
        qm = median(r["quote_ms"])
        who = (r["version"] or "—")
        print(f"{r['mint'].replace('https://',''):30} "
              f"{r['info_ok']}/{a.rounds:<4} {r['quote_ok']}/{a.rounds:<4} "
              f"{(f'{im:.0f}' if im else '—'):>9} {(f'{qm:.0f}' if qm else '—'):>9}  {who}")

    print("\nWhat Foxy needs, per mint")
    print("-" * 100)
    for r in rows:
        if not r["nuts"]:
            print(f"{r['mint'].replace('https://',''):30} — never answered /v1/info")
            continue
        # Listed is not the same as supported: NUT-7 onwards carry a
        # {"supported": bool}, while NUT-4 and NUT-5 carry their methods
        # instead and have no such flag. Absent, or present and false, both
        # count as missing.
        said = r.get("nutsRaw") or {}
        def has(n):
            if n not in said:
                return False
            v = said[n]
            return v.get("supported", True) if isinstance(v, dict) else True
        missing = [f"{n} ({why})" for n, why in NEEDS.items() if not has(n)]
        cap = f"max array {r['cap']}" if r["cap"] is not None else "no max_array_length"
        print(f"{r['mint'].replace('https://',''):30} {cap}")
        print(f"{'':30} {'all of them' if not missing else 'MISSING ' + ', '.join(missing)}")

    troubled = [r for r in rows if r["notes"]]
    if troubled:
        print("\nWhat went wrong")
        print("-" * 100)
        for r in troubled:
            seen = {}
            for n in r["notes"]:
                seen[n] = seen.get(n, 0) + 1
            for n, c in seen.items():
                print(f"{r['mint'].replace('https://',''):30} {c}x  {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
