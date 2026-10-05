#!/bin/sh
# local-mint.sh — a CDK mint and a Nutshell mint on this Mac, fake Lightning,
# behind HTTPS, for the live tests. Fake money only, nothing leaves the machine.
#
#   sh tools/live/local-mint.sh up     # start both; prints their https URLs
#   sh tools/live/local-mint.sh down   # stop both
#
# The settings are the ones cashu-ts's own integration tests use: fake wallet
# backend, input fee 100 ppk. CDK is what Minibits' mint runs.
#
# The IMAGES used to be cashu-ts's too — cashubtc/mintd:0.17.5 and
# cashubtc/nutshell:0.20.3, the pair its Makefile pins at v4.10.1. The pin has
# deliberately moved off that parity to mintd:0.18.1 and
# nutshell:0.21.0, because the two things Foxy most needs live coverage of exist
# only past it: NUT-06 `max_array_length` (CDK 0.18 and Nutshell 0.21 are the
# first to advertise it, and Foxy chunks /v1/checkstate and its restore walk by
# it), and CDK 0.17.6/0.17.7's changed melt saga recovery. cashu-ts is still
# tested against its own pair by its own suite; this is Foxy's.
#
#   CDK_IMAGE=cashubtc/mintd:0.17.5 NUT_IMAGE=cashubtc/nutshell:0.20.3 \
#     sh tools/live/local-mint.sh up          # the old pair, still supported
#   CDK_MAX_ARRAY=25 sh tools/live/local-mint.sh up   # CDK with a small NUT-06
#                                                     # cap, for array-cap.js
#
# Then, for example:
#   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
#     node tools/live/used-counters.js https://127.0.0.1:8443
cd "$(dirname "$0")/../.." || exit 1
DIR=build/live-tls
CDK_IMAGE=${CDK_IMAGE:-cashubtc/mintd:0.18.1}
NUT_IMAGE=${NUT_IMAGE:-cashubtc/nutshell:0.21.0}
# CDK_MAX_ARRAY: [limits] max_inputs/max_outputs, which CDK advertises as
# NUT-06 max_array_length = min(max_inputs, max_outputs). Unset means no cap.
CDK_MAX_ARRAY=${CDK_MAX_ARRAY:-}

stop_proxies() {
  for f in "$DIR"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
}

wait_for() {   # url [curl options]
  url=$1; shift
  i=0
  while [ $i -lt 120 ]; do
    curl -s -m 3 "$@" "$url" >/dev/null 2>&1 && return 0
    sleep 1; i=$((i + 1))
  done
  echo "no answer from $url"; return 1
}

case "$1" in
up)
  mkdir -p "$DIR"
  if [ ! -f "$DIR/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=foxy-local-mint" \
      -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
      -keyout "$DIR/key.pem" -out "$DIR/cert.pem" >/dev/null 2>&1 || { echo "openssl failed"; exit 1; }
  fi
  stop_proxies
  docker rm -f -v foxy-cdk foxy-nutshell >/dev/null 2>&1
  # cdk-mintd 0.18 no longer starts from the environment alone: its settings live
  # in its database, put there once by `cdk-mintd config init` from a TOML file.
  # The same settings as the 0.17 variables below; the words still come from the
  # environment (env:CDK_MINTD_MNEMONIC).
  case "$CDK_IMAGE" in
  *:0.17*) CDK_START= ;;
  *)
    cat > "$DIR/cdk-mintd.toml" <<'TOML'
[info]
url = "http://127.0.0.1:3338/"
listen_host = "0.0.0.0"
listen_port = 3338
mnemonic = "env:CDK_MINTD_MNEMONIC"
input_fee_ppk = 100
[database]
engine = "sqlite"
[payment_backend]
backend = "fakewallet"
[fake_wallet]
fee_percent = 0.02
reserve_fee_min = 1
min_delay_time = 1
max_delay_time = 1
TOML
    if [ -n "$CDK_MAX_ARRAY" ]; then
      # NUT-06 max_array_length is min(max_inputs, max_outputs) at CDK 0.18.
      printf '[limits]\nmax_inputs = %s\nmax_outputs = %s\n' "$CDK_MAX_ARRAY" "$CDK_MAX_ARRAY" >> "$DIR/cdk-mintd.toml"
    fi
    # `config init` initialises an UNCONFIGURED database, so it is right once and
    # wrong for ever after: a `docker restart foxy-cdk` (restart-melt.js does one
    # mid-melt) re-runs this command against a database that already holds a
    # mint. Chained with && the mint would never come back up. So: init if it
    # takes, and start the mint either way — an init that failed because the
    # database was already configured is exactly the restart case.
    CDK_START='cdk-mintd config init --new-mint --file /cfg/cdk-mintd.toml || echo "cdk-mintd: config init did not apply (already configured?), starting anyway"; exec cdk-mintd' ;;
  esac
  set -- -d --name foxy-cdk --platform linux/amd64 -p 127.0.0.1:3338:3338 \
    -e CDK_MINTD_DATABASE=sqlite -e CDK_MINTD_LN_BACKEND=fakewallet \
    -e CDK_MINTD_INPUT_FEE_PPK=100 -e CDK_MINTD_LISTEN_HOST=0.0.0.0 -e CDK_MINTD_LISTEN_PORT=3338 \
    -e CDK_MINTD_FAKE_WALLET_MIN_DELAY=1 -e CDK_MINTD_FAKE_WALLET_MAX_DELAY=1 \
    -e CDK_MINTD_MNEMONIC='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  if [ -n "$CDK_START" ]; then
    docker run "$@" -v "$(cd "$DIR" && pwd):/cfg:ro" "$CDK_IMAGE" sh -c "$CDK_START" >/dev/null || exit 1
  else
    docker run "$@" "$CDK_IMAGE" >/dev/null || exit 1
  fi
  docker run -d --name foxy-nutshell --platform linux/amd64 -p 127.0.0.1:3339:3338 \
    -e MINT_LIGHTNING_BACKEND=FakeWallet -e MINT_INPUT_FEE_PPK=100 \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY \
    -e FAKEWALLET_DELAY_PAYMENT=TRUE -e FAKEWALLET_DELAY_OUTGOING_PAYMENT=1 -e FAKEWALLET_DELAY_INCOMING_PAYMENT=1 \
    -e MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE=1000 \
    -e MINT_GLOBAL_RATE_LIMIT_PER_MINUTE=10000 \
    "$NUT_IMAGE" poetry run mint >/dev/null || exit 1
  # The global limit is 60 requests a minute by default. faults.js restores
  # counter ranges after each lost answer and from the words after, and at 60 a
  # minute Nutshell answered /v1/restore with 429: recoveries were left for
  # later and scans found 0, which read as wallet failures.
  wait_for http://127.0.0.1:3338/v1/info || exit 1
  wait_for http://127.0.0.1:3339/v1/info || exit 1
  ( nohup node tools/live/tls-proxy.js 8443 3338 "$DIR" > "$DIR/cdk-proxy.log" 2>&1 & echo $! > "$DIR/cdk-proxy.pid" )
  ( nohup node tools/live/tls-proxy.js 8444 3339 "$DIR" > "$DIR/nutshell-proxy.log" 2>&1 & echo $! > "$DIR/nutshell-proxy.pid" )
  wait_for https://127.0.0.1:8443/v1/info --cacert "$DIR/cert.pem" || exit 1
  wait_for https://127.0.0.1:8444/v1/info --cacert "$DIR/cert.pem" || exit 1
  SHOW='import sys,json; d=json.load(sys.stdin); print(d.get("version"), "nut20:", "20" in d.get("nuts",{}), "max_array_length:", d.get("max_array_length"))'
  printf 'CDK       https://127.0.0.1:8443  %s\n' "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8443/v1/info | python3 -c "$SHOW")"
  printf 'Nutshell  https://127.0.0.1:8444  %s\n' "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8444/v1/info | python3 -c "$SHOW")"
  echo "NODE_EXTRA_CA_CERTS=$DIR/cert.pem"
  ;;
down)
  stop_proxies
  docker rm -f -v foxy-cdk foxy-nutshell >/dev/null 2>&1
  echo "stopped"
  ;;
*)
  echo "usage: sh tools/live/local-mint.sh up|down"; exit 2
  ;;
esac
