#!/bin/sh
# nutshell-pg.sh — one Nutshell mint on PostgreSQL, on this Mac, with fake
# Lightning and fake money, for load tests of the mint's own locking
# (tools/live/crowd.js --burst). The mint is reached the way local-mint.sh's
# is: https://127.0.0.1:8444 through tls-proxy.js, so crowd.js --local works
# unchanged with one mint.
#
#   sh tools/live/nutshell-pg.sh up          # postgres:16 + Nutshell on it
#   sh tools/live/nutshell-pg.sh down
#
#   NUT_IMAGE=cashubtc/nutshell:0.21.0       the mint (default)
#   NUT_PATCH=<dir>                          files to lay over the image's own:
#                                            <dir>/write.py -> cashu/mint/db/write.py
#                                            <dir>/db.py    -> cashu/core/db.py
#                                            (a patched copy of the mint's code,
#                                            to measure a fix before it is proposed)
#   NUT_LOCK_TIMEOUT_MS=30000                MINT_DATABASE_LOCK_TIMEOUT (Postgres lock_timeout)
#
# Nothing here touches local-mint.sh's or mint-pair.sh's containers; the
# TLS proxy's pid file is its own. Ports: 5433 (postgres), 3339 (mint), 8444 (TLS).
set -e
DIR=build/live-tls
NUT_IMAGE=${NUT_IMAGE:-cashubtc/nutshell:0.21.0}
PG_IMAGE=${PG_IMAGE:-postgres:16}
NET=foxy-pg-net

stop_proxy() { [ -f "$DIR/pg-proxy.pid" ] && kill "$(cat "$DIR/pg-proxy.pid")" 2>/dev/null; rm -f "$DIR/pg-proxy.pid"; }
wait_for() {
  url=$1; shift; i=0
  while [ $i -lt 120 ]; do curl -s -m 3 "$@" "$url" >/dev/null 2>&1 && return 0; i=$((i+1)); sleep 1; done
  echo "gave up waiting for $url"; return 1
}

case "$1" in
up)
  mkdir -p "$DIR"
  [ -f "$DIR/cert.pem" ] || { echo "no $DIR/cert.pem: run sh tools/live/local-mint.sh up once first (it makes the certificate)"; exit 1; }
  stop_proxy
  docker rm -f -v foxy-pg foxy-nutshell-pg >/dev/null 2>&1 || true
  docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
  docker run -d --name foxy-pg --network $NET -p 127.0.0.1:5433:5432 \
    -e POSTGRES_USER=cashu -e POSTGRES_PASSWORD=cashu -e POSTGRES_DB=cashu \
    "$PG_IMAGE" -c max_connections=300 >/dev/null
  i=0; until docker exec foxy-pg pg_isready -U cashu -q 2>/dev/null; do i=$((i+1)); [ $i -gt 60 ] && { echo "postgres did not come up"; exit 1; }; sleep 1; done
  set -- -d --name foxy-nutshell-pg --network $NET --platform linux/amd64 -p 127.0.0.1:3339:3338 \
    -e MINT_DATABASE=postgres://cashu:cashu@foxy-pg:5432/cashu \
    -e MINT_DATABASE_LOCK_TIMEOUT="${NUT_LOCK_TIMEOUT_MS:-30000}" \
    -e MINT_LIGHTNING_BACKEND=FakeWallet -e MINT_INPUT_FEE_PPK=0 \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY \
    -e FAKEWALLET_DELAY_PAYMENT=TRUE -e FAKEWALLET_DELAY_OUTGOING_PAYMENT=1 -e FAKEWALLET_DELAY_INCOMING_PAYMENT=1 \
    -e MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE=100000 -e MINT_GLOBAL_RATE_LIMIT_PER_MINUTE=100000
  if [ -n "$NUT_PATCH" ]; then
    P=$(cd "$NUT_PATCH" && pwd)
    [ -f "$P/write.py" ] && set -- "$@" -v "$P/write.py:/app/cashu/mint/db/write.py:ro"
    [ -f "$P/db.py" ] && set -- "$@" -v "$P/db.py:/app/cashu/core/db.py:ro"
    echo "patched with $P: $(ls "$P" | tr '\n' ' ')"
  fi
  docker run "$@" "$NUT_IMAGE" poetry run mint >/dev/null
  wait_for http://127.0.0.1:3339/v1/info || { docker logs foxy-nutshell-pg 2>&1 | tail -20; exit 1; }
  ( nohup node tools/live/tls-proxy.js 8444 3339 "$DIR" > "$DIR/pg-proxy.log" 2>&1 & echo $! > "$DIR/pg-proxy.pid" )
  wait_for https://127.0.0.1:8444/v1/info --cacert "$DIR/cert.pem"
  SHOW='import sys,json; d=json.load(sys.stdin); print(d.get("version"), "on postgres")'
  printf 'Nutshell  https://127.0.0.1:8444  %s\n' "$(curl -s --cacert "$DIR/cert.pem" https://127.0.0.1:8444/v1/info | python3 -c "$SHOW")"
  ;;
down)
  stop_proxy
  docker rm -f -v foxy-pg foxy-nutshell-pg >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  echo "stopped"
  ;;
*)
  echo "usage: sh tools/live/nutshell-pg.sh up|down"; exit 2
  ;;
esac
