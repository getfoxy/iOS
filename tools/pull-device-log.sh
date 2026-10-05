#!/bin/sh
# pull-device-log.sh - copy Foxy's Debug log off a phone, and summarise it.
#
#   sh tools/pull-device-log.sh [name-or-udid] [output-dir]
#
# Foxy's Debug builds write every line `print` produces to a file inside the app
# container (Foxy/Debug/DebugLog.swift). This copies that file to the Mac. It
# needs no sudo, no cable and no libimobiledevice: devicectl talks to the phone
# over the same connection Xcode uses, which is why this works when
# `log collect` returns "Device not configured (6)" for a phone on the network.
#
# Run the test with NO DEBUGGER ATTACHED - Edit Scheme > Run > Info > untick
# "Debug executable" - or the results are void: a debugger stops iOS suspending
# the app, and suspension is what the background and resume tests are about. The
# log says which it was, on its first line, so the file cannot lie about it.
#
# Everything here is plain ASCII on purpose. A typographic apostrophe in an
# earlier runbook was read by zsh as an opening quote and hung the shell.
set -eu

BUNDLE=io.getfoxi.foxy
CONTAINER="Library/Application Support/foxy-logs"

DEVICE="${1:-}"
OUT="${2:-$HOME/Desktop/foxy-evidence}"

if [ -z "$DEVICE" ]; then
  # Match the UDID's shape, not a column position. Both the Name and the Model
  # column contain spaces ("Alice's iPhone", "iPhone 17 Pro (iPhone18,1)"), so
  # counting fields from either end picked the "17" out of the model name and
  # asked devicectl for a device called 17. Guard "connected" with spaces too,
  # or it also matches "disconnected".
  DEVICE=$(xcrun devicectl list devices 2>/dev/null \
    | grep -E '[[:space:]]connected[[:space:]]' \
    | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' \
    | head -1)
  if [ -z "$DEVICE" ]; then
    echo "no connected device. Plug the phone in or open Xcode once, then:" >&2
    echo "  xcrun devicectl list devices" >&2
    echo "  sh tools/pull-device-log.sh <udid>" >&2
    exit 1
  fi
  echo "device: $DEVICE (the only one connected)"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUT/$STAMP"
mkdir -p "$DEST"

echo "pulling $CONTAINER from $BUNDLE ..."
if ! xcrun devicectl device copy from \
      --device "$DEVICE" \
      --domain-type appDataContainer \
      --domain-identifier "$BUNDLE" \
      --source "$CONTAINER" \
      --destination "$DEST" \
      --quiet; then
  echo "" >&2
  echo "could not copy. The usual causes, in order:" >&2
  echo "  - Foxy is not installed on that phone, or is a Release build" >&2
  echo "    (a Release build writes no log file at all, by design - ask the" >&2
  echo "     person for the LOGS screen instead: menu > LOGS > SHARE)" >&2
  echo "  - the app has never been launched since installing" >&2
  echo "  - the phone is locked: unlock it and run this again" >&2
  exit 1
fi

LOG=$(find "$DEST" -name 'foxy.log' | head -1)
if [ -z "$LOG" ]; then
  echo "copied, but no foxy.log inside. What came back:" >&2
  find "$DEST" -type f >&2
  exit 1
fi

# oldest first, so one file reads in order
ROLLED=$(find "$DEST" -name 'foxy.log.1' | head -1)
ALL="$DEST/foxy-all.txt"
: > "$ALL"
[ -n "$ROLLED" ] && cat "$ROLLED" >> "$ALL"
cat "$LOG" >> "$ALL"

# The file on the phone keeps every launch, one after another, each starting
# with a banner. The summary below covers only the newest launch: with five runs
# in one file the new run was buried under the old ones, and "anything that went
# wrong" kept listing errors from an hour before. Line numbers stay those of
# foxy-all.txt, so any line quoted can be found there. A test that takes several
# launches (14b takes three) wants all of them and nothing older:
# FOXY_LAST=3 summarises the last three launches, FOXY_ALL_SESSIONS=1 all of them.
SESSIONS=$(grep -c '==== foxy launch ====' "$ALL" || true)
LAST="${FOXY_LAST:-1}"
[ "${FOXY_ALL_SESSIONS:-0}" = 1 ] && LAST=0
case "$LAST" in
  ''|*[!0-9]*) echo "FOXY_LAST must be a number of launches, not: $LAST" >&2; exit 1 ;;
esac
START=1
if [ "$LAST" -gt 0 ]; then
  START=$(grep -n '==== foxy launch ====' "$ALL" | tail -n "$LAST" | head -n 1 | cut -d: -f1)
  [ -z "$START" ] && START=1
fi
# keep only grep -n lines at or after START
newest() { awk -F: -v s="$START" '$1 + 0 >= s'; }

echo ""
echo "saved: $ALL"
echo "lines: $(wc -l < "$ALL" | tr -d ' '), launches: $SESSIONS"
if [ "$START" -gt 1 ]; then
  if [ "$LAST" = 1 ]; then shown="the newest launch"; else shown="the last $LAST launches"; fi
  echo "summary: $shown, from line $START ($(sed -n "${START}p" "$ALL" | cut -c1-12))"
  echo "         FOXY_LAST=N for the last N launches, FOXY_ALL_SESSIONS=1 for all"
fi
echo ""

# The verdict lines, so a result rests on a grep rather than on reading.
# Each section says so when it matched nothing.
#
# These used to end in `|| echo "none"`, which never once ran: a pipeline exits
# with the status of its LAST command, and every one of them ended in head or
# tail, which succeed whether or not grep found anything. So an empty section
# printed nothing, and "no self-test was asked for" looked exactly like "the
# check did not run". On a tool whose whole purpose is to replace someone's
# memory with a grep, those two must never look the same.
section() {
  echo "---- $1 ----"
  if [ -n "$2" ]; then printf '%s\n' "$2"; else echo "  $3"; fi
  echo ""
}

section "was this a valid run?" \
  "$(grep -n 'debugger attached' "$ALL" | newest | tail -3 || true)" \
  "NO LAUNCH BANNER - this log did not come from a build with DebugLog in it"

# PASS and FAIL standing alone, not inside PASSED or FAILED. A bare FAIL in this
# pattern matched "request through Tor - FAILED after 910ms" and filed a Tor
# hiccup under the app's own self-test verdicts. `\b` is not portable across the
# BSD and GNU greps this may meet; a trailing non-letter is.
section "what the app graded itself" \
  "$(grep -nE '\[seedscreentest\]|\[nativesecretstest\]|\[netblock\]|\[keychaintest\]|(PASS|FAIL)([^A-Za-z]|$)' "$ALL" | newest | head -40 || true)" \
  "none - no self-test launch argument was set for this run"

# Section 5's four lines, together and in order, because that is what decides a
# return. Two of them - `wake:` and the set-up line - were in no section at all,
# so the one test this tool was built for could not be judged from its own
# summary. The seconds on `wake:` are the test: a 5a run must read 300s or more,
# or iOS never suspended the app and nothing was proven.
section "background and return (section 5)" \
  "$(grep -nE 'off the network while Foxy|wake: [0-9]+s|setting up a private connection|circuit established|fail-closed' "$ALL" | newest | tail -40 || true)" \
  "none - Foxy was never backgrounded in this log"

# `control authentication did not answer` is the recovery from a lost reply
# (TorService.authenticationTimedOut). If it ever shows, keep the log: it is the
# only evidence of why the reply went missing.
section "tor" \
  "$(grep -nE 'tor: bootstrapped|circuit established|IsTor|control authentication|could not connect' "$ALL" | newest | tail -30 || true)" \
  "no tor lines"

# The self-test lines are left out: they are printed in full above, and a
# passing [seedscreentest] line always holds `error "Unknown action: ..."`,
# which is the refusal the test wants, not something that went wrong.
section "anything that went wrong" \
  "$(grep -niE 'refused|failed|error|stuck|no answer|did not answer' "$ALL" \
      | grep -vE 'fail-closed|\[seedscreentest\]|\[nativesecretstest\]|\[netblock\]|\[keychaintest\]' \
      | newest | head -30 || true)" \
  "nothing"
echo "The log is redacted for tokens, invoices and long hex, but it names mint"
echo "hosts and amounts. Treat it as sensitive and delete it when you are done."
