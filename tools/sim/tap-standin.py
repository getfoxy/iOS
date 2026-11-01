#!/usr/bin/env python3
"""tap-standin.py: stands in for one phone of a simulator tap, and moves no money.

    python3 tools/sim/tap-standin.py receiver --sats 21 --mint https://forge.flashapp.me --log /path/rx.log
    python3 tools/sim/tap-standin.py payer --device <udid> --log /path/tx.log
    python3 tools/sim/tap-standin.py selftest --log /path/self.log

A simulator build of Foxy carries a loopback stand-in for the Bluetooth link
(Foxy/Bluetooth/TapLink.swift, `SimTapReceiver` / `SimTapPayer`). This script
speaks the same wire, so it can be the other phone with nothing at stake:

  receiver  listens where SimTapPayer knocks, answers `near` with a `door`,
            `hello` with a `code` and an `offer` (a Cashu payment request,
            made here), and REFUSES everything that would complete a payment:
            an `intend` question is answered `go: false`, a `pay` is answered
            with a sealed 422 refusal. The payer keeps its ecash.
  payer     knocks on one receiver (named by --port, or by --device, which
            finds the port that simulator's Foxy listens on), says `near`,
            `hello`, logs the code and the offer, optionally asks the
            question-first (`intend`) and logs the answer, then says `gaveUp`
            and leaves. It never sends `pay`.
  selftest  both of the above against each other on a private port (47499,
            outside the range any Foxy knocks), to prove the wire.

Everything is printed as a timeline (clock, seconds since the last line,
seconds since the link was made) to stdout and to --log.

SAFETY. Simulators named in DENY are never answered or knocked: a connection
from one is closed before a byte is said, and a port one of them owns is
refused. --only <udid> narrows the receiver to one simulator's Foxy. Payment
bodies (bearer ecash) are never logged, only their length and a hash.

WHAT THE WIRE IS, as read in the code (HEAD 066e2f8):

  Foxy/Bluetooth/TapLink.swift
    2060  static let ports: [UInt16] = Array(47411...47418)
    2124  params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)   (the RECEIVER listens)
    2424  let w = SimWire(NWConnection(host: "127.0.0.1", port: port, using: .tcp)) (the PAYER connects)
    2031  o["t"] = kind / 2032 o["b"] = body / 2034 data.append(0x0a)              (one JSON line, t + b)
    2426  w.onReady = { [weak w] in w?.say("near", "left") }
    2157  w.say("door", "", ["byte": doorByte, "id": SimTap.me])
    2142  private var doorByte: Int { (turned ? 1 : 0) | (early ? 2 : 0) }
    2436  if (o["id"] as? String) == SimTap.me { wire?.close(); ... }               (own receiver skipped)
    2412  FileManager.default.fileExists(atPath: Self.touchFile)  -> take() -> 2517 w.say("hello")
    2175  w.say("code", code)  then 2250 push("offer", payload)
    2185  case "pay"  2195 case "again" (["from": n])  2200 case "kept"  2205 case "quote"
    2272  push("terms", text)  2278 push("asking", "")  2288 push("change", text)  2311 push("result", json)
    2306  ["v": 2, "ok": true, "code": 200] / ["v": 2, "ok": false, "code": code, "why": ...]
    2189  resultWait (25 s, line 237) armed on `pay`: sealResult(504, "Their wallet did not answer in time.")
    2280  askingWait (90 s, line 241) armed on `asking`: sealResult(504, "They did not answer in time.")
    2519  payer: Timer(withTimeInterval: 30): "nothing came after the handshake"
  Foxy/Bluetooth/TapProtocol.swift
    98    (o["v"] as? Int) == 2  ... inv / req      (the offer: {"v":2,"inv":"ln…","req":"creqA…"})
    80    "^creq[A-Za-z0-9_=+/-]{16,}$"
  build/app/26d-tap.js
    224   JSON.stringify({ v: 2, inv, req, up: !this.offlineNow(), till, ask: 1, sats4usd, rate, at })
    1444  W2.tapQuote(JSON.stringify({ gaveUp: 'The payer is changing mint; tap again in a moment.' }))
    1492  }, 900);   (the beat between the offer landing and the payer acting on it)
    2277  t = setTimeout(() => finish(''), 5000);   (an online receiver's late invoice, waited for)
  build/app/26l-pay-from.js
    597   W.tapQuote(JSON.stringify({ gaveUp: 'The payer cancelled.' }))
  build/wallet/21-native-bridges.js
    339   intent = { id, unit, amount, mint, locked } (+ sats, from, keyset); 382 tapQuote({ intend: intent })
    159   code === 200 && ok === true -> settled; 409 or 504 -> unconfirmed; other codes -> refused (foxyRefused)
  build/wallet/07-request-delivery.js
    1585  var no = function (why) { return { intent: id, go: false, why: why }; };   (answered as `terms`)

So the stand-in refuses a `pay` with code 422: a refusal the payer reads as
"they heard it and said no", takes its pieces back, and does not fall back.
"""

import argparse
import base64
import hashlib
import json
import os
import random
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid

PORTS = list(range(47411, 47419))
SELFTEST_PORT = 47499
DENY = ("64795DB7", "729DDA98")          # live money / not ours: never answered, never knocked
STOOD_IN = "standin-" + uuid.uuid4().hex[:12]   # our door id, never a Foxy's SimTap.me

# The clocks of a real receiver, as the code has them (seconds).
RESULT_WAIT = 25      # TapLink.swift:237   after `pay`
ASKING_WAIT = 90      # TapLink.swift:241   after `asking`
TALK_WAIT = 95        # 26d-tap.js:2755     receiver page, a person deciding
CARRY_HOME = 120      # 26d-tap.js:2921     receiver on the payer's mint, carry-home leg


# ---------------------------------------------------------------- timeline

class Timeline:
    def __init__(self, path):
        self.f = open(path, "a", buffering=1) if path else None
        self.last = None
        self.link = None
        self.lock = threading.Lock()

    def mark_link(self):
        self.link = time.time()

    def say(self, who, text):
        with self.lock:
            now = time.time()
            gap = 0.0 if self.last is None else now - self.last
            self.last = now
            since = "" if self.link is None else "link+%6.1fs" % (now - self.link)
            stamp = time.strftime("%H:%M:%S", time.localtime(now)) + ".%03d" % int((now % 1) * 1000)
            line = "%s  +%6.2fs  %-12s %-8s %s" % (stamp, gap, since, who, text)
            print(line, flush=True)
            if self.f:
                self.f.write(line + "\n")


# ---------------------------------------------------------------- CBOR (NUT-18 requests)

def cbor(o):
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        for ai, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
            if n < (1 << (8 * size)):
                return bytes([major << 5 | ai]) + n.to_bytes(size, "big")
        raise ValueError("too big")
    if o is True:
        return b"\xf5"
    if o is False:
        return b"\xf4"
    if o is None:
        return b"\xf6"
    if isinstance(o, int):
        return head(0, o) if o >= 0 else head(1, -1 - o)
    if isinstance(o, bytes):
        return head(2, len(o)) + o
    if isinstance(o, str):
        b = o.encode()
        return head(3, len(b)) + b
    if isinstance(o, (list, tuple)):
        return head(4, len(o)) + b"".join(cbor(x) for x in o)
    if isinstance(o, dict):
        return head(5, len(o)) + b"".join(cbor(k) + cbor(v) for k, v in o.items())
    raise TypeError(type(o))


def uncbor(b):
    def item(i):
        ib = b[i]; i += 1
        major, ai = ib >> 5, ib & 31
        if major == 7:
            if ai == 20: return False, i
            if ai == 21: return True, i
            if ai in (22, 23): return None, i
            if ai == 25: return int.from_bytes(b[i:i + 2], "big"), i + 2   # half float: not decoded
            if ai == 26:
                import struct; return struct.unpack(">f", b[i:i + 4])[0], i + 4
            if ai == 27:
                import struct; return struct.unpack(">d", b[i:i + 8])[0], i + 8
            raise ValueError("simple %d" % ai)
        if ai < 24: n = ai
        else:
            size = {24: 1, 25: 2, 26: 4, 27: 8}[ai]
            n = int.from_bytes(b[i:i + size], "big"); i += size
        if major == 0: return n, i
        if major == 1: return -1 - n, i
        if major == 2: return b[i:i + n], i + n
        if major == 3: return b[i:i + n].decode(), i + n
        if major == 4:
            out = []
            for _ in range(n):
                v, i = item(i); out.append(v)
            return out, i
        if major == 5:
            out = {}
            for _ in range(n):
                k, i = item(i); v, i = item(i); out[k] = v
            return out, i
        if major == 6:
            return item(i)
        raise ValueError("major %d" % major)
    return item(0)[0]


def encode_request(sats, mint, unit="sat", rid=None, desc="stand-in: no money moves", lock=None):
    # the order cashu-ts writes (t, i, a, u, m, d, s): no transports, the tap link is the delivery
    o = {"t": [], "i": rid or secrets.token_hex(8), "a": int(sats), "u": unit, "m": [mint.rstrip("/")], "d": desc, "s": True}
    if lock:
        o["nut10"] = {"k": "P2PK", "d": lock, "t": []}
    return "creqA" + base64.urlsafe_b64encode(cbor(o)).decode()


def decode_request(s):
    try:
        body = s[5:]
        body += "=" * (-len(body) % 4)
        return uncbor(base64.urlsafe_b64decode(body))
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------- a throwaway P2PK key (secp256k1)

P = 2 ** 256 - 2 ** 32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def _add(a, b):
    if a is None: return b
    if b is None: return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0: return None
    if a == b:
        m = 3 * a[0] * a[0] * pow(2 * a[1], -1, P)
    else:
        m = (b[1] - a[1]) * pow(b[0] - a[0], -1, P)
    x = (m * m - a[0] - b[0]) % P
    return (x, (m * (a[0] - x) - a[1]) % P)


def throwaway_pubkey():
    d = secrets.randbelow(N - 1) + 1
    q, r = None, G
    while d:
        if d & 1: q = _add(q, r)
        r = _add(r, r); d >>= 1
    return ("02" if q[1] % 2 == 0 else "03") + "%064x" % q[0]


# ---------------------------------------------------------------- which simulator is on the other end

_names = None


def sim_names():
    global _names
    if _names is None:
        _names = {}
        try:
            j = json.loads(subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                                          capture_output=True, text=True, timeout=10).stdout)
            for devs in j.get("devices", {}).values():
                for d in devs:
                    _names[d["udid"]] = d["name"]
        except Exception:
            pass
    return _names


def pid_udid(pid):
    try:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    except Exception:
        return ""
    m = re.search(r"/Devices/([0-9A-F-]{36})/", cmd)
    return m.group(1) if m else ""


def who_has(local_port, listen=False):
    """The simulator (udid, name) of the Foxy process whose own end is 127.0.0.1:<local_port>.
    Only processes named Foxy are looked at (`lsof -c Foxy`), which keeps this to ~40 ms."""
    try:
        out = subprocess.run(["lsof", "-nP", "-a", "-c", "Foxy", "-iTCP:%d" % local_port, "-Fpn"],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return "", ""
    pid, best = None, None
    for line in out.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid:
            name = line[1:]
            mine = name == "127.0.0.1:%d" % local_port if listen else name.startswith("127.0.0.1:%d->" % local_port)
            if mine:
                best = pid
    if not best:
        return "", ""
    u = pid_udid(best)
    return u, sim_names().get(u, "pid %d" % best)


def denied(udid):
    return any(udid.upper().startswith(d) for d in DENY)


# ---------------------------------------------------------------- the wire

class Wire:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.open = True
        self.wlock = threading.Lock()

    def say(self, kind, body="", **more):
        o = dict(more); o["t"] = kind; o["b"] = body
        data = json.dumps(o, separators=(",", ":")).encode() + b"\n"
        with self.wlock:
            if not self.open: return False
            try:
                self.sock.sendall(data); return True
            except OSError:
                self.open = False; return False

    def lines(self):
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                try:
                    o = json.loads(line)
                    if isinstance(o, dict): yield o
                except ValueError:
                    yield {"t": "?unreadable", "b": line[:80].decode(errors="replace")}
            try:
                got = self.sock.recv(1 << 20)
            except OSError:
                got = b""
            if not got:
                self.open = False
                return
            self.buf += got

    def close(self):
        self.open = False
        try: self.sock.shutdown(socket.SHUT_RDWR)
        except OSError: pass
        self.sock.close()


def later(sec, fn):
    t = threading.Timer(sec, fn)
    t.daemon = True
    t.start()
    return t


def brief(kind, body):
    if kind == "pay":
        return "%d bytes, sha256 %s (bearer ecash: not logged)" % (len(body), hashlib.sha256(body.encode()).hexdigest()[:16])
    if kind == "offer":
        try:
            o = json.loads(body)
        except ValueError:
            return body[:120]
        bits = []
        if o.get("req"):
            r = decode_request(o["req"])
            bits.append("req %s %s at %s, id %s%s" % (r.get("a"), r.get("u"), ",".join(r.get("m") or []), r.get("i"),
                                                       ", locked to %s…" % r["nut10"]["d"][:12] if r.get("nut10") else ""))
        if o.get("inv"): bits.append("inv %s…" % o["inv"][:24])
        for k in ("up", "ask", "till", "sats4usd", "rate", "at"):
            if k in o: bits.append("%s=%s" % (k, o[k]))
        return "{v:%s} " % o.get("v") + "; ".join(bits)
    return body if len(body) <= 240 else body[:240] + "…(%d)" % len(body)


# ---------------------------------------------------------------- receiver

class Receiver:
    def __init__(self, a, tl):
        self.a, self.tl = a, tl
        self.talking = None
        self.out = []            # what went after the code, for `again`
        self.turned = False
        self.early = bool(a.early)
        self.lock = threading.Lock()
        self.quiet = set()       # peers already reported as filtered
        self.timers = []
        self.done = threading.Event()
        lock = throwaway_pubkey() if a.lock else None
        self.req = a.req or encode_request(a.sats, a.mint, a.unit, lock=lock)
        offer = {"v": 2, "req": self.req, "up": not a.offline}
        if a.ask: offer["ask"] = 1
        self.offer = json.dumps(offer, separators=(",", ":"))
        if len(self.offer.encode()) > 4096:
            raise SystemExit("the offer is over TapProtocol.maxPayload (4096)")

    def door(self):
        return (1 if self.turned else 0) | (2 if self.early else 0)

    def bind(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        ports = [self.a.port] if self.a.port else PORTS
        for p in ports:
            try:
                s.bind(("127.0.0.1", p)); s.listen(8)
                return s, p
            except OSError:
                u, n = who_has(p, listen=True)
                self.tl.say("rx", "port %d is taken (%s); next" % (p, n or "another process"))
        raise SystemExit("no free port in %s" % ports)

    def clock(self, after, label):
        self.timers.append(later(after, lambda: self.tl.say("clock", label)))

    def run(self):
        if not self.a.no_lookup:
            sim_names()          # once, so the first knock is not kept waiting for simctl
        srv, port = self.bind()
        self.port = port
        r = decode_request(self.req)
        self.tl.say("rx", "on the air at 127.0.0.1:%d as %s; asking %s %s at %s; up=%s ask=%s%s" % (
            port, STOOD_IN, r.get("a"), r.get("u"), ",".join(r.get("m") or []), not self.a.offline, bool(self.a.ask),
            "; early (amount screen)" if self.early else ""))
        self.tl.say("rx", "request %s" % self.req)
        if self.a.ready_after and self.early:
            def ready():
                self.early = False
                self.tl.say("rx", "now on the invoice screen (door byte %d)" % self.door())
                if self.talking: self.talking.say("door", "", byte=self.door(), id=STOOD_IN)
            later(self.a.ready_after, ready)
        srv.settimeout(0.5)
        end = time.time() + self.a.hold if self.a.hold else None
        while not self.done.is_set() and (end is None or time.time() < end):
            try:
                c, addr = srv.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self.serve, args=(c, addr), daemon=True).start()
        self.tl.say("rx", "hold over; off the air")
        if self.talking: self.talking.close()
        srv.close()
        for t in self.timers: t.cancel()

    def serve(self, c, addr):
        udid, name = ("", "") if self.a.no_lookup else who_has(addr[1])
        tag = name or ("peer :%d" % addr[1])
        if udid and denied(udid):
            c.close()
            if udid not in self.quiet:
                self.quiet.add(udid); self.tl.say("rx", "REFUSED %s (%s): on the deny list; closed unanswered" % (name, udid))
            return
        if self.a.only and udid.upper() != self.a.only.upper():
            c.close()
            key = udid or "unknown"
            if key not in self.quiet:
                self.quiet.add(key); self.tl.say("rx", "ignored %s (%s): not --only; closed unanswered (said once)" % (tag, udid or "?"))
            return
        w = Wire(c)
        self.tl.say("rx", "a payer knocked: %s %s" % (tag, udid))
        for o in w.lines():
            self.heard(w, tag, o)
        with self.lock:
            was = self.talking is w
            if was: self.talking = None
        if was:
            for t in self.timers: t.cancel()
            self.timers = []
            self.tl.say("rx", "THE PAYER WENT AWAY: socket closed (%s); the link's clocks stop" % tag)
            if self.a.exit_on_close: self.done.set()
        else:
            self.tl.say("rx", "%s left (not linked)" % tag)

    def push(self, w, kind, body):
        self.out.append((kind, body))
        w.say(kind, body)
        self.tl.say("rx >", "%s %s" % (kind, brief(kind, body)))

    def heard(self, w, tag, o):
        kind, body = str(o.get("t", "")), str(o.get("b", ""))
        if kind == "near":
            w.say("door", "", byte=self.door(), id=STOOD_IN)
            self.tl.say("rx <", "near %s  -> door byte %d" % (body, self.door()))
            return
        if kind == "hello":
            if self.early:
                self.tl.say("rx <", "hello, refused: on the amount screen (as SimTapReceiver:2163)"); return
            with self.lock:
                if self.talking is not None and self.talking is not w:
                    self.tl.say("rx <", "hello from a second payer; ignored (as :2167)"); return
                if self.talking is w:
                    return
                self.talking = w
            self.tl.mark_link()
            code = "%04d" % random.randint(0, 9999)
            w.say("code", code)
            self.tl.say("rx <", "hello  -> code %s" % code)
            self.clock(RESULT_WAIT, "25 s since the link: TapReceiver.resultWait. A real B arms it only on `pay` (TapLink.swift:2189); no pay, no clock.")
            self.clock(ASKING_WAIT, "90 s since the link: TapReceiver.askingWait. A real B arms it only after sending `asking` (TapLink.swift:2280).")
            self.clock(TALK_WAIT, "95 s since the link: B's page lets a deciding link go (_tapTalkT, 26d-tap.js:2755), only while its person decides.")
            self.clock(CARRY_HOME, "120 s since the link: B's carry-home clock (_carryHomeT, 26d-tap.js:2921), only on the offline-payer carry leg.")
            if self.a.offer_after:
                later(self.a.offer_after, lambda: w.open and self.push(w, "offer", self.offer))
            else:
                self.push(w, "offer", self.offer)
            if self.a.asking_at is not None:
                def asking():
                    if not w.open: return
                    self.push(w, "asking", "")
                    self.tl.say("rx", "asking sent: a real B now seals 504 in %d s unless a result goes first" % ASKING_WAIT)
                    def seal():
                        if w.open and not any(k == "result" for k, _ in self.out):
                            self.push(w, "result", json.dumps({"v": 2, "ok": False, "code": 504, "why": "They did not answer in time."}))
                    self.timers.append(later(ASKING_WAIT, seal))
                later(self.a.asking_at, asking)
            return
        if w is not self.talking:
            self.tl.say("rx <", "%s from a phone that is not the payer; refused (as :2181)" % kind); return
        self.tl.say("rx <", "%s %s" % (kind, brief(kind, body)))
        if kind == "quote":
            try:
                said = json.loads(body)
            except ValueError:
                said = None
            if isinstance(said, dict) and isinstance(said.get("gaveUp"), str):
                self.tl.say("rx", "PAYER GAVE UP: \"%s\"" % said["gaveUp"])
            elif isinstance(said, dict) and isinstance(said.get("intend"), dict):
                it = said["intend"]
                ans = {"intent": str(it.get("id", "")), "go": False, "why": self.a.why}
                self.push(w, "terms", json.dumps(ans, separators=(",", ":")))
                self.tl.say("rx", "asked first about %s %s at %s (locked=%s): answered NO" % (
                    it.get("amount"), it.get("unit"), it.get("mint"), it.get("locked")))
            elif isinstance(said, dict) and said.get("paid"):
                self.tl.say("rx", "the payer says it paid an invoice: none was offered here")
            else:
                self.tl.say("rx", "a word with no answer from the stand-in (price talk, carry-home ask): the payer's own clock runs")
        elif kind == "pay":
            self.tl.say("rx", "a payment arrived. A real B would have %d s (resultWait) to answer; the stand-in refuses now" % RESULT_WAIT)
            self.push(w, "result", json.dumps({"v": 2, "ok": False, "code": 422, "why": self.a.why}, separators=(",", ":")))
        elif kind == "again":
            frm = max(0, int(o.get("from", 0) or 0))
            late = self.out[frm:]
            self.tl.say("rx", "the payer was away; saying %d message(s) again" % len(late))
            for k, b in late: w.say(k, b)
        elif kind == "kept":
            self.tl.say("rx", "the payer says it kept change (none was sent)")


# ---------------------------------------------------------------- payer

def payer(a, tl):
    port = a.port
    if a.device:
        if denied(a.device):
            raise SystemExit("refused: %s is on the deny list" % a.device)
        for p in PORTS:
            u, n = who_has(p, listen=True)
            if u and u.upper() == a.device.upper():
                port = p; break
        if not port:
            raise SystemExit("no Foxy of %s is listening on %d-%d (is it on a receive screen with an amount?)" % (a.device, PORTS[0], PORTS[-1]))
    if not port:
        raise SystemExit("payer needs --port or --device")
    if port != SELFTEST_PORT:
        u, n = who_has(port, listen=True)
        if u and denied(u):
            raise SystemExit("refused: port %d belongs to %s (%s), on the deny list" % (port, n, u))
        tl.say("tx", "knocking 127.0.0.1:%d (%s %s)" % (port, n or "?", u))
    else:
        tl.say("tx", "knocking 127.0.0.1:%d" % port)
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.settimeout(None)
    w = Wire(s)
    w.say("near", "left")
    tl.say("tx >", "near left")
    state = {"early": None, "helloed": False, "offer": None, "asked_at": None}

    def hello():
        if state["helloed"] or not w.open: return
        state["helloed"] = True
        w.say("hello")
        tl.say("tx >", "hello (the touch)")
        def nothing():
            if state["offer"] is None and w.open:
                tl.say("tx", "30 s and no offer: SimTapPayer gives up here (TapLink.swift:2519)")
        later(30, nothing)

    def leave():
        if not w.open: return
        if a.say:
            w.say("quote", json.dumps({"gaveUp": a.say}))
            tl.say("tx >", "quote {gaveUp: \"%s\"}" % a.say)
        time.sleep(0.5)
        tl.say("tx", "going away without paying")
        state["left"] = True
        w.close()

    def after_offer():
        if a.ask_first:
            r = decode_request(json.loads(state["offer"]).get("req", "")) if state["offer"] else {}
            intent = {"id": r.get("i", ""), "unit": r.get("u", "sat"), "amount": r.get("a", 0), "sats": r.get("a", 0),
                      "mint": ",".join(r.get("m") or []), "locked": False}
            state["asked_at"] = time.time()
            w.say("quote", json.dumps({"intend": intent}, separators=(",", ":")))
            tl.say("tx >", "quote {intend: %s %s at %s} (a question; nothing is made)" % (intent["amount"], intent["unit"], intent["mint"]))
        later(a.stay, leave)

    for o in w.lines():
        kind, body = str(o.get("t", "")), str(o.get("b", ""))
        if kind == "door":
            byte = int(o.get("byte", 0) or 0)
            early = bool(byte & 2)
            tl.say("tx <", "door byte %d (%s%s) id %s" % (byte, "amount screen, no card yet" if early else "invoice screen",
                                                        ", turned" if byte & 1 else "", o.get("id")))
            state["early"] = early
            if not early and not state["helloed"]:
                later(a.hello_after, hello)
            continue
        tl.say("tx <", "%s %s" % (kind, brief(kind, body)))
        if kind == "code":
            tl.mark_link()
        elif kind == "offer":
            state["offer"] = body
            after_offer()
        elif kind == "terms" and state["asked_at"]:
            tl.say("tx", "answered in %.2f s (the payer waits %s ms, 21-native-bridges.js:367)" % (time.time() - state["asked_at"], 6000))
        elif kind == "result":
            tl.say("tx", "a result with no payment sent (a receiver's clock sealed it)")
    tl.say("tx", "done" if state.get("left") else "THE RECEIVER CLOSED THE LINK")


# ---------------------------------------------------------------- selftest

def selftest(a, tl):
    ra = argparse.Namespace(**vars(a))
    ra.port, ra.hold, ra.only, ra.no_lookup, ra.exit_on_close = SELFTEST_PORT, 30, None, True, False
    rx = Receiver(ra, tl)
    t = threading.Thread(target=rx.run, daemon=True); t.start()
    time.sleep(0.4)
    pa = argparse.Namespace(**vars(a))
    pa.port, pa.device, pa.ask_first, pa.stay = SELFTEST_PORT, None, True, 2.0
    pa.say = "stand-in payer: going away, nothing sent"
    # a pay probe too, so the refusal is on the wire: a dummy body, not ecash
    s = socket.create_connection(("127.0.0.1", SELFTEST_PORT)); w = Wire(s)
    w.say("hello"); tl.say("probe", "a second connection says hello and a dummy pay (must be refused as not the payer, or answered 422)")
    time.sleep(0.3)
    w.say("pay", "selftest: not a token")
    time.sleep(0.5); w.close()
    payer(pa, tl)
    rx.done.set(); t.join(3)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("role", choices=["receiver", "payer", "selftest"])
    ap.add_argument("--log", required=True)
    ap.add_argument("--port", type=int, default=0, help="receiver: listen here (default: first free of 47411-47418); payer: knock here")
    # receiver
    ap.add_argument("--sats", type=int, default=21)
    ap.add_argument("--mint", default="https://forge.flashapp.me")
    ap.add_argument("--unit", default="sat")
    ap.add_argument("--req", default="", help="offer this creqA… instead of making one")
    ap.add_argument("--lock", action="store_true", help="lock the request to a throwaway P2PK key (nut10)")
    ap.add_argument("--offline", action="store_true", help="say up:false (a receiver with no route)")
    ap.add_argument("--no-ask", dest="ask", action="store_false", help="leave out ask:1")
    ap.add_argument("--early", action="store_true", help="start on the amount screen (door byte 2)")
    ap.add_argument("--ready-after", type=float, default=0)
    ap.add_argument("--offer-after", type=float, default=0, help="send the offer this long after the code")
    ap.add_argument("--asking-at", type=float, default=None, help="send `asking` this long after the code, and seal 504 at +90 s as B does")
    ap.add_argument("--hold", type=float, default=0, help="seconds on the air (default: until ^C)")
    ap.add_argument("--only", default="", help="answer only this simulator's Foxy (udid)")
    ap.add_argument("--exit-on-close", action="store_true")
    ap.add_argument("--no-lookup", action="store_true", help="do not ask lsof who knocked")
    ap.add_argument("--why", default="stand-in: no money moves")
    # payer
    ap.add_argument("--device", default="", help="payer: knock on this simulator's receiver")
    ap.add_argument("--hello-after", type=float, default=1.0)
    ap.add_argument("--ask-first", action="store_true", help="payer: send an intend question after the offer")
    ap.add_argument("--stay", type=float, default=3.0, help="payer: seconds after the offer before leaving")
    ap.add_argument("--say", default="stand-in payer: going away, nothing sent", help="payer: the gaveUp words ('' to leave silently)")
    a = ap.parse_args()
    if a.only and denied(a.only):
        raise SystemExit("refused: --only names a denied simulator")
    tl = Timeline(a.log)
    tl.say("start", "tap-standin %s, pid %d, %s" % (a.role, os.getpid(), time.strftime("%Y-%m-%d")))
    try:
        if a.role == "receiver":
            Receiver(a, tl).run()
        elif a.role == "payer":
            payer(a, tl)
        else:
            selftest(a, tl)
    except KeyboardInterrupt:
        tl.say("stop", "interrupted")


if __name__ == "__main__":
    main()
