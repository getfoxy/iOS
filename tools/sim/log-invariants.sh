#!/bin/sh
# log-invariants.sh — three log tests, read by a script instead of by eye.
#
# Sections 16, 21b and 21c of DEVICE-TESTS are pure log analysis: they are done
# today by grepping a pulled log and counting by hand, which is exactly the kind
# of verdict that ends up resting on someone's memory. This launches Foxy,
# touches nothing, waits for a circuit, and then grades the app's own Debug log
# (`Library/Application Support/foxy-logs/foxy.log` inside the app container,
# NOT the syslog — the syslog has none of these lines once a run is left alone).
#
#   1. one circuit per job        (section 16, first half)
#   2. nothing identifying at launch  (section 16, second half)
#   3. where the price came from  (section 21c)
#   4. the Tor directory pre-seed (section 21b) — reported, never graded
#
# Checks 1 and 3 read the whole file, every launch it holds, because that is
# where the jobs already exercised by hand are. Check 2 reads only the newest
# launch, the one this script started and nobody touched — "before any user
# action" is a claim only an untouched launch can make. Handed someone else's
# log (FOXY_LOG), it cannot know when the tester started tapping, so it grades
# only the first seconds after the circuit and says which seconds those were.
#
# expect: PASS on 1 and 2; PASS on 3 with the onion counted, and a WARN beside
#         it when the onion is the minority source
#
# Needs a Debug build: `mint … on circuit …` is written inside #if DEBUG.
# Reads logs only. It spends nothing, sends nothing and touches no balance.
#
# FOXY_SIM_UDID  required — `booted` picks one of several silently
# FOXY_LOG=file  grade this log instead (a phone log pulled by
#                tools/pull-device-log.sh); launches no simulator at all
# FOXY_FRESH=1   delete and reinstall first. THIS WIPES THE WALLET on that
#                simulator; it is the only run that plants the pre-seed (21b)
# FOXY_WATCH=N   seconds to watch after the circuit (default 180)
# FOXY_LAUNCH_WINDOW=N  with FOXY_LOG only: how many seconds after the circuit
#                count as "at launch" in check 2 (default 20)
# About 5 minutes, or seconds with FOXY_LOG.
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE=io.getfoxi.foxy
W=${FOXY_WATCH:-180}

# Answered by the direct probe during the watch: yes, no, or empty for "never
# got to ask" (a log handed in with FOXY_LOG, or no live Tor).
ONION_ALIVE=""
ONION_HOST="mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion"
if [ -n "$FOXY_LOG" ]; then
  # No simulator is wanted, so common.sh (which boots one) is not sourced.
  ROOT="$(cd "$HERE/../.." && pwd)"
  OUT="${FOXY_SIM_OUT:-$ROOT/build/sim-out}"
  mkdir -p "$OUT"
  [ -f "$FOXY_LOG" ] || { echo "no such log: $FOXY_LOG"; exit 1; }
  ALL="$FOXY_LOG"
  WIN=${FOXY_LAUNCH_WINDOW:-20}
  WHOSE="a log this script did not drive"
  echo "reading $ALL (no simulator launched)"
else
  if [ -z "$FOXY_SIM_UDID" ]; then
    echo "set FOXY_SIM_UDID. A bare 'booted' takes the first of several and says"
    echo "nothing about which, and the wrong simulator can hold real money."
    echo "Booted now:"
    xcrun simctl list devices booted | grep -E '\(Booted\)' | sed 's/^/  /'
    exit 1
  fi
  . "$HERE/common.sh"
  WIN=$(( W + 300 ))     # the whole launch: this script touches nothing
  WHOSE="the launch this script started and left alone"

  if [ "$FOXY_FRESH" = 1 ]; then
    echo "FOXY_FRESH=1: deleting Foxy from $UDID — any wallet on it goes with it"
    need_app
    xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
    while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
    xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null
    xcrun simctl install "$UDID" "$APP" && echo "installed fresh"
  elif ! xcrun simctl get_app_container "$UDID" "$BUNDLE" data >/dev/null 2>&1; then
    need_app
    xcrun simctl install "$UDID" "$APP" && echo installed
  else
    echo "Foxy is already installed on $UDID; left alone (FOXY_FRESH=1 reinstalls)"
  fi

  C="$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)"
  D="$C/Library/Application Support/foxy-logs"

  L="$OUT/log-invariants-console.log"; : > "$L"
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
  while pgrep -f "$UDID/.*Foxy.app/Foxy" >/dev/null; do sleep 0.5; done
  ( xcrun simctl launch --console-pty "$UDID" "$BUNDLE" > "$L" 2>&1 & )
  t0=$(date +%s); up=""
  while [ $(( $(date +%s) - t0 )) -lt 240 ]; do
    grep -aq "circuit established" "$L" && { up=$(( $(date +%s) - t0 )); break; }
    sleep 1
  done
  if [ -z "$up" ]; then
    pkill -9 -f "simctl launch --console-pty" 2>/dev/null
    xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
    echo "no circuit in 240s: nothing to read. See $L"
    exit 1
  fi
  echo "circuit after ${up}s; watching ${W}s, touching nothing"

  # Ask the mempool onion whether it is alive, NOW, while this Foxy still has a
  # Tor to ask through. Check 3 needs it: no price from the onion can mean it
  # is down or merely that it lost every race, and the log cannot tell those
  # apart. It has to happen here rather than beside the verdicts, because the
  # app — and with it the SOCKS port — is terminated a few lines below.
  _pid=$(pgrep -f "$UDID/.*Foxy.app/Foxy" 2>/dev/null | head -1)
  if [ -n "$_pid" ]; then
    for _p in $(lsof -nP -a -p "$_pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {split($9,a,":"); print a[2]}'); do
      if curl -s -m 15 --socks5-hostname "127.0.0.1:$_p" https://check.torproject.org/api/ip 2>/dev/null | grep -q '"IsTor":true'; then
        case "$(curl -s -m 40 --socks5-hostname "127.0.0.1:$_p" "http://$ONION_HOST/api/v1/prices" 2>/dev/null)" in
          *'"USD"'*) ONION_ALIVE=yes ;;
          *)         ONION_ALIVE=no ;;
        esac
        break
      fi
    done
  fi
  sleep "$W"
  pkill -9 -f "simctl launch --console-pty" 2>/dev/null
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null

  # oldest first, so one file reads in order — the same shape pull-device-log.sh
  # hands a tester, so FOXY_LOG can point this at a phone log unchanged.
  ALL="$OUT/log-invariants-foxy.log"; : > "$ALL"
  [ -f "$D/foxy.log.1" ] && cat "$D/foxy.log.1" >> "$ALL"
  if [ -f "$D/foxy.log" ]; then
    cat "$D/foxy.log" >> "$ALL"
  else
    echo "no foxy.log in the container: is this a Release build?"
    exit 1
  fi
  echo "log: $ALL ($(wc -l < "$ALL" | tr -d ' ') lines)"
fi

# Every verdict below is one pass over that file. The rules, in full:
#
#  - A job is one piece of work at a mint (one invoice, one token, one payment).
#    The page labels it and Tor keeps different labels on different circuits.
#    Labels are 16 random bytes, so two sessions never collide; the grouping is
#    still per launch, because a quote left unpaid and polled again after a
#    relaunch is a new job and rightly gets a new circuit.
#  - Which paths may share one label is not "one path each": section 16 has a
#    payment whose melt quote, swap and melt all ride together, and a send whose
#    checkstate and swap do. So a label passes when every path on it fits inside
#    ONE job of the shapes below, and fails the moment it spans two.
awk -v win="$WIN" -v whose="$WHOSE" -v onionalive="$ONION_ALIVE" '
function ts(s,   p) { split(s, p, ":"); return p[1] * 3600 + p[2] * 60 + p[3] }
function pass(m) { print "PASS " m; np++ }
function fail(m) { print "FAIL " m; nf++ }
function warn(m) { print "WARN " m; nw++ }
function dunno(m) { print "could not tell: " m; nu++ }

BEGIN {
  # the job shapes, and the paths each one may put on a single circuit
  allow["mint setup",   "setup"] = 1
  allow["a new quote",  "mintquote-new"] = 1
  allow["a receive",    "mintquote-poll"] = 1
  allow["a receive",    "mint"] = 1
  allow["a receive",    "swap"] = 1
  allow["a payment",    "meltquote-new"] = 1
  allow["a payment",    "meltquote-poll"] = 1
  allow["a payment",    "melt"] = 1
  allow["a payment",    "swap"] = 1
  allow["a send",       "checkstate"] = 1
  allow["a send",       "swap"] = 1
  allow["a restore",    "restore"] = 1
  allow["a restore",    "setup"] = 1
  njobs = split("mint setup,a new quote,a receive,a payment,a send,a restore", jobs, ",")
}

/==== foxy launch ====/ { sess++; launchat[sess] = $1; next }
/tor: circuit established/ { if (circat[sess] == "") circat[sess] = $1; next }
/tor: directory seed laid down/ { laid[sess] = $0; next }
/tor: the directory seed got through/ { got[sess] = $0; next }

# mint GET /Bitcoin/v1/info on circuit a54ee4
$2 == "mint" && $5 == "on" && $6 == "circuit" {
  path = $4; label = $7
  k = index(path, "/v1/")            # the mint may live under a prefix
  p = (k > 0) ? substr(path, k) : path
  id = ""
  if (p == "/v1/info" || p == "/v1/keys" || p == "/v1/keysets" || p ~ "^/v1/keys/") kind = "setup"
  else if (p == "/v1/checkstate") kind = "checkstate"
  else if (p == "/v1/swap") kind = "swap"
  else if (p == "/v1/restore") kind = "restore"
  else if (p == "/v1/mint/bolt11") kind = "mint"
  else if (p == "/v1/melt/bolt11") kind = "melt"
  else if (p == "/v1/mint/quote/bolt11") kind = "mintquote-new"
  else if (p == "/v1/melt/quote/bolt11") kind = "meltquote-new"
  else if (p ~ "^/v1/mint/quote/bolt11/.") { kind = "mintquote-poll"; id = substr(p, 23) }
  else if (p ~ "^/v1/melt/quote/bolt11/.") { kind = "meltquote-poll"; id = substr(p, 23) }
  else kind = p

  lines++
  lab = sess SUBSEP label
  if (!(lab SUBSEP kind in kseen)) { kseen[lab SUBSEP kind] = 1; kn[lab]++; ks[lab] = ks[lab] " " kind }
  if (!(lab in labseen)) { labseen[lab] = 1; nlabels++ }

  if (id != "") {
    q = sess SUBSEP id
    if (!(q SUBSEP label in qseen)) { qseen[q SUBSEP label] = 1; qn[q]++; qs[q] = qs[q] " " label }
    if (!(q in qidseen)) { qidseen[q] = 1; nquotes++ }
    if (!(lab SUBSEP id in lqseen)) { lqseen[lab SUBSEP id] = 1; lqn[lab]++ }
  }

  # check 2 wants only what was asked after the circuit came up, this launch,
  # inside the window that can honestly be called "before any user action"
  if (circat[sess] != "") {
    since = ts($1) - ts(circat[sess]); if (since < 0) since += 86400
    if (since <= win && !(sess SUBSEP p in sp)) { sp[sess SUBSEP p] = 1; splist[sess] = splist[sess] " " p }
  }
  next
}

# [foxy] price 86447.0 from http://…onion/api/v1/prices in 1.0s
/\[foxy\] price [0-9]/ && / from / {
  n = split($0, f, " ")
  for (i = 1; i <= n; i++) {
    if (f[i] == "from" && f[i - 1] ~ /^[0-9.]+$/ && f[i + 1] ~ /^https?:/) {
      h = f[i + 1]
      sub(/^https?:\/\//, "", h)
      k = index(h, "/"); if (k > 0) h = substr(h, 1, k - 1)
      if (!(h in phost)) plist = plist " " h
      phost[h]++; ptotal++
      if (h ~ /\.onion$/) ponion++
      break
    }
  }
  next
}

END {
  print ""
  print "=== 1. one circuit per job (DEVICE-TESTS section 16)"
  print "    " lines " mint request(s) on " nlabels " circuit label(s), over " sess " launch(es)"

  if (nquotes == 0) {
    dunno("no quote polls anywhere in this log, so no invoice job to follow. " \
          "Run section 16 steps 1-3 on a phone, pull the log, and point FOXY_LOG at it.")
  } else {
    bad = 0; badlist = ""
    for (q in qn) if (qn[q] != 1) { bad++; split(q, a, SUBSEP); badlist = badlist "\n      launch " a[1] " quote " a[2] " on" qs[q] }
    if (bad == 0) pass(nquotes " quote id(s), each polled on exactly one circuit")
    else fail(bad " of " nquotes " quote id(s) polled on more than one circuit:" badlist)

    sh = 0; shlist = ""
    for (l in lqn) if (lqn[l] > 1) { sh++; split(l, a, SUBSEP); shlist = shlist " " a[2] }
    if (sh == 0) pass("no circuit label carries two different quote ids")
    else fail(sh " circuit label(s) carry more than one quote id:" shlist)
  }

  if (nlabels == 0) {
    dunno("no \"mint ... on circuit\" lines at all. A Release build writes none; nor does a run that never reached a mint.")
  } else {
    mixed = 0; mixlist = ""; shared = 0
    for (l in kn) {
      if (kn[l] < 2) continue
      shared++
      fits = 0
      for (j = 1; j <= njobs; j++) {
        ok = 1
        m = split(ks[l], kk, " ")
        for (i = 1; i <= m; i++) if (kk[i] != "" && !(jobs[j] SUBSEP kk[i] in allow)) { ok = 0; break }
        if (ok) { fits = jobs[j]; break }
      }
      split(l, a, SUBSEP)
      if (fits == 0) { mixed++; mixlist = mixlist "\n      launch " a[1] " label " a[2] ":" ks[l] }
      else evidence = evidence "\n      launch " a[1] " label " a[2] ":" ks[l] "  (" fits ")"
    }
    if (mixed == 0) pass("no circuit label spans two job kinds (" shared " label(s) carry more than one path, each inside one job)")
    else fail(mixed " circuit label(s) span two job kinds:" mixlist)
    if (evidence != "") print "    shared labels, and the job each one fits:" evidence
  }

  print ""
  print "=== 2. nothing identifying asked at launch (DEVICE-TESTS section 16)"
  printf "    launch %d only — %s — and only the first %ds after its circuit\n", sess, whose, win
  if (sess == 0) dunno("no launch banner in this log")
  else if (circat[sess] == "") dunno("the newest launch never reached a circuit")
  else {
    n = split(splist[sess], arr, " "); extra = ""; ne = 0; nall = 0; asked = ""
    for (i = 1; i <= n; i++) {
      p = arr[i]; if (p == "") continue
      nall++; asked = asked " " p
      if (p == "/v1/info" || p == "/v1/keys" || p == "/v1/keysets" || p ~ "^/v1/keys/") continue
      ne++; extra = extra " " p
    }
    if (nall == 0) dunno("the newest launch asked the mint for nothing at all after the circuit came up")
    else if (ne == 0) pass("after the circuit, only" asked)
    else {
      fail(ne " path(s) beyond info/keys/keysets before any user action:" extra "\n      (asked in full:" asked ")")
      # The two that turn up honestly, so a reader is not left guessing which
      # kind of failure this is. Named, not forgiven: both are a mint request
      # nobody asked for, and both belong in front of whoever reads this log.
      if (extra ~ /\/v1\/mint\/quote\/bolt11( |$)/) {
        print "      /v1/mint/quote/bolt11 with no id is the node probe: a quote Foxy never pays,"
        print "      asked to learn the mint lightning node (section 17 step 1). First run on a mint only."
      }
      if (extra ~ /\/v1\/mint\/quote\/bolt11\//) {
        print "      a quote id with no user action is an invoice left unpaid from an earlier run,"
        print "      picked back up at launch. Which invoice it is, is a fact about this wallet."
      }
    }
  }

  print ""
  print "=== 3. where the price came from (DEVICE-TESTS section 21c)"
  if (ptotal == 0) dunno("no \"[foxy] price N from ...\" lines in this log")
  else {
    n = split(plist, hs, " ")
    for (i = 1; i <= n; i++) if (hs[i] != "") printf "    %4d  %s\n", phost[hs[i]], hs[i]
    # The onion loses plenty of races it is perfectly able to win, so a handful
    # of prices that all came from Kraken is not evidence the onion is down.
    # Below a real sample this says so rather than failing on noise.
    if (ponion == 0 && ptotal < 5)
      dunno("only " ptotal " price(s) in this log, all clearnet. Too few to say whether the onion is reachable: it loses races it can win. Watch longer, or read a log with more in it.")
    else if (ponion == 0) {
      # Losing every race is not the same as being unreachable, and the log
      # cannot tell them apart. So ask the onion directly, through the same
      # Tor this Foxy is using, before deciding which it was. Measured:
      # the onion answers in 1.8-1.9s warm and 4.2s cold while
      # Kraken answers in 0.85s, so losing 9 of 9 is an ordinary afternoon and
      # not a defect.
      if (onionalive == "yes")
        warn("no price came from the mempool onion in " ptotal " tries, but it answered when asked directly during this run — reachable and losing the races, not down")
      else if (onionalive == "no")
        fail("no price came from the mempool onion in " ptotal " tries, and it did not answer when asked directly either: the onion source is down and every price is quietly coming from a clearnet fallback")
      else
        dunno("no price came from the mempool onion in " ptotal " tries, and there was no live Tor to ask it directly, so down and losing-every-race cannot be told apart here")
    }
    else {
      pass(ponion " of " ptotal " price(s) came from the mempool onion, so it is reachable")
      if (ponion * 2 <= ptotal)
        warn("the onion is the minority source: " ponion " of " ptotal ". It is racing the clearnet fallbacks and losing more often than it wins.")
    }
  }

  print ""
  print "=== 4. the Tor directory pre-seed (DEVICE-TESTS section 21b) — reported, not graded"
  if (sess == 0) dunno("no launch banner in this log")
  else if (laid[sess] == "")
    dunno("nothing was planted this launch. Only a delete-and-reinstall plants it (FOXY_FRESH=1); on a relaunch, nothing planted is the pass.")
  else {
    print "    " laid[sess]
    if (got[sess] != "") pass("planted, and it got through: " got[sess])
    else fail("planted, but never \"the directory seed got through\" — the circuit did not prove it")
  }
  if (sess > 0 && circat[sess] != "" && launchat[sess] != "") {
    d = ts(circat[sess]) - ts(launchat[sess]); if (d < 0) d += 86400
    printf "    launch to circuit: %.1fs. NOT a verdict: a simulator runs on the Mac network,\n", d
    print  "    and its timings say nothing about what a phone on a cell network will do."
  }

  print ""
  printf "PASS %d, FAIL %d, WARN %d, could not tell %d\n", np, nf, nw, nu
  exit (nf > 0 ? 1 : 0)
}
' "$ALL"
