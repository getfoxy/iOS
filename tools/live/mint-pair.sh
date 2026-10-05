#!/bin/sh
# mint-pair.sh — two CDK mints on this Mac set up like the two the phones use,
# for tap-scenarios.js. Fake Lightning, fake money, nothing leaves the machine.
#
#   sh tools/live/mint-pair.sh up     # start both; prints their https URLs
#   sh tools/live/mint-pair.sh down   # stop both
#
# What they copy, read from the real mints' /v1/info and /v1/keysets over Tor:
#
#   mint.macadamia.cash          cdk-mintd 0.18.1, input_fee_ppk 150
#   mint.minibits.cash/Bitcoin   cdk-mintd 0.17.7, input_fee_ppk 0
#
# The fee is the point. local-mint.sh runs both of its mints at 100 ppk, which
# is neither: every bug found there lived in the difference between a mint
# that charges and one that does not, and showed at one and never at the other.
#
#   macadamia-like   https://127.0.0.1:8473   (container foxy-mac, port 3348)
#   minibits-like    https://127.0.0.1:8474   (container foxy-mb,  port 3349)
#
# Not 8453 and 8454: faults.js puts its fault proxies there, and with the pair
# on them it could not start.
#
# MAC_FEE_PPK / MB_FEE_PPK change the fees; MAC_IMAGE / MB_IMAGE the versions.
# Shares build/live-tls with local-mint.sh, whose up and down stop every proxy
# in that folder: run one script's mints at a time, or start this one second.
cd "$(dirname "$0")/../.." || exit 1
DIR=build/live-tls
MAC_IMAGE=${MAC_IMAGE:-cashubtc/mintd:0.18.1}
MB_IMAGE=${MB_IMAGE:-cashubtc/mintd:0.17.7}
MAC_FEE_PPK=${MAC_FEE_PPK:-150}
MB_FEE_PPK=${MB_FEE_PPK:-0}

wait_for() {   # url [curl options]
  url=$1; shift
  i=0
  while [ $i -lt 120 ]; do
    curl -s -m 3 "$@" "$url" >/dev/null 2>&1 && return 0
    sleep 1; i=$((i + 1))
  done
  echo "no answer from $url"; return 1
}
stop_pair() {
  for f in "$DIR"/pair-*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
  docker rm -f -v foxy-mac foxy-mb >/dev/null 2>&1
}

# one CDK mint: name, image, host port, fee, words
start_cdk() {
  name=$1; image=$2; port=$3; fee=$4; words=$5
  case "$image" in
  *:0.17*) START= ;;
  *)
    cat > "$DIR/$name.toml" <<TOML
[info]
url = "http://127.0.0.1:3338/"
listen_host = "0.0.0.0"
listen_port = 3338
mnemonic = "env:CDK_MINTD_MNEMONIC"
input_fee_ppk = $fee
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
    START="cdk-mintd config init --new-mint --file /cfg/$name.toml || echo 'cdk-mintd: config init did not apply, starting anyway'; exec cdk-mintd" ;;
  esac
  set -- -d --name "$name" --platform linux/amd64 -p "127.0.0.1:$port:3338" \
    -e CDK_MINTD_DATABASE=sqlite -e CDK_MINTD_LN_BACKEND=fakewallet \
    -e "CDK_MINTD_INPUT_FEE_PPK=$fee" -e CDK_MINTD_LISTEN_HOST=0.0.0.0 -e CDK_MINTD_LISTEN_PORT=3338 \
    -e CDK_MINTD_FAKE_WALLET_MIN_DELAY=1 -e CDK_MINTD_FAKE_WALLET_MAX_DELAY=1 \
    -e "CDK_MINTD_MNEMONIC=$words"
  if [ -n "$START" ]; then
    docker run "$@" -v "$(cd "$DIR" && pwd):/cfg:ro" "$image" sh -c "$START" >/dev/null || return 1
  else
    docker run "$@" "$image" >/dev/null || return 1
  fi
}

case "$1" in
up)
  mkdir -p "$DIR"
  if [ ! -f "$DIR/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=foxy-local-mint" \
      -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
      -keyout "$DIR/key.pem" -out "$DIR/cert.pem" >/dev/null 2>&1 || { echo "openssl failed"; exit 1; }
  fi
  stop_pair
  start_cdk foxy-mac "$MAC_IMAGE" 3348 "$MAC_FEE_PPK" \
    'legal winner thank year wave sausage worth useful legal winner thank yellow' || exit 1
  start_cdk foxy-mb "$MB_IMAGE" 3349 "$MB_FEE_PPK" \
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' || exit 1
  wait_for http://127.0.0.1:3348/v1/info || exit 1
  wait_for http://127.0.0.1:3349/v1/info || exit 1
  ( nohup node tools/live/tls-proxy.js 8473 3348 "$DIR" > "$DIR/pair-mac-proxy.log" 2>&1 & echo $! > "$DIR/pair-mac.pid" )
  ( nohup node tools/live/tls-proxy.js 8474 3349 "$DIR" > "$DIR/pair-mb-proxy.log" 2>&1 & echo $! > "$DIR/pair-mb.pid" )
  wait_for https://127.0.0.1:8473/v1/info --cacert "$DIR/cert.pem" || exit 1
  wait_for https://127.0.0.1:8474/v1/info --cacert "$DIR/cert.pem" || exit 1
  SHOW='import sys,json; d=json.load(sys.stdin); print(d.get("version"), "max_array_length:", d.get("max_array_length"))'
  FEE='import sys,json; d=json.load(sys.stdin); print("input_fee_ppk", [k.get("input_fee_ppk") for k in d.get("keysets",[]) if k.get("active")])'
  printf 'macadamia-like  https://127.0.0.1:8473  %s  %s\n' \
    "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8473/v1/info | python3 -c "$SHOW")" \
    "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8473/v1/keysets | python3 -c "$FEE")"
  printf 'minibits-like   https://127.0.0.1:8474  %s  %s\n' \
    "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8474/v1/info | python3 -c "$SHOW")" \
    "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8474/v1/keysets | python3 -c "$FEE")"
  echo "NODE_EXTRA_CA_CERTS=$DIR/cert.pem"
  ;;
down)
  stop_pair
  echo "stopped"
  ;;
*)
  echo "usage: sh tools/live/mint-pair.sh up|down"; exit 2
  ;;
esac
