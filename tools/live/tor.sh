#!/bin/sh
# tor.sh — a Tor of its own for the crowd harness, on this Mac, with one SOCKS port (9150) that puts
# every SOCKS user name on its own circuit (IsolateSOCKSAuth), so a hundred people are a hundred
# circuits without a phone's Tor in the way. Homebrew's tor; its files live outside the repository.
#
#   sh tools/live/tor.sh start     # starts it in the background and waits for the bootstrap
#   sh tools/live/tor.sh status    # is it up, and which exit does a fresh circuit get
#   sh tools/live/tor.sh stop
#
# Then: node tools/live/crowd.js ... --socks 9150 ...
# The configuration is ~/.foxy-live/tor/torrc (made once by the owner's helper; copy the lines in
# this file's comment if it is missing): DataDirectory under ~/.foxy-live/tor, SocksPort 9150 with
# IsolateSOCKSAuth, no control port, MaxClientCircuitsPending 64.
DIR="$HOME/.foxy-live/tor"
PID="$DIR/tor.pid"
TOR=$(command -v tor || echo /opt/homebrew/bin/tor)
case "$1" in
start)
  [ -f "$DIR/torrc" ] || { echo "no $DIR/torrc"; exit 1; }
  if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo "already running (pid $(cat "$PID"))"; exit 0; fi
  mkdir -p "$DIR/data"; chmod 700 "$DIR/data"
  nohup "$TOR" -f "$DIR/torrc" > "$DIR/stdout.log" 2>&1 &
  echo $! > "$PID"
  i=0
  while [ $i -lt 90 ]; do
    grep -q "Bootstrapped 100%" "$DIR/notice.log" 2>/dev/null && { echo "tor up on 127.0.0.1:9150 (pid $(cat "$PID"))"; exit 0; }
    kill -0 "$(cat "$PID")" 2>/dev/null || { echo "tor exited; see $DIR/stdout.log"; exit 1; }
    i=$((i+1)); sleep 1
  done
  echo "tor did not bootstrap in 90 s; see $DIR/notice.log"; exit 1 ;;
status)
  if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    echo "running (pid $(cat "$PID"))"
    curl -s -m 20 --proxy-user "a-$$:x" --socks5-hostname 127.0.0.1:9150 https://check.torproject.org/api/ip || echo "SOCKS did not answer"
    echo
  else echo "not running"; fi ;;
stop)
  [ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null && rm -f "$PID" && echo "stopped" || echo "not running" ;;
*) echo "usage: sh tools/live/tor.sh start|status|stop"; exit 2 ;;
esac
