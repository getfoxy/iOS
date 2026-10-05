#!/bin/sh
# pending-mint.sh — a third local mint, a Nutshell whose fake Lightning
# never finishes an outgoing payment: every melt stays PENDING. For the
# pending-melt step of tools/live/flows.js. Fake money only.
#
#   sh tools/live/pending-mint.sh up     # http 127.0.0.1:3340, https 127.0.0.1:8445
#   sh tools/live/pending-mint.sh down
#
# Nutshell's FakeWallet takes the outcome from settings for every payment
# (FAKEWALLET_PAY_INVOICE_STATE, FAKEWALLET_PAYMENT_STATE); incoming invoices
# are still paid, so a wallet can be funded. CDK's fake wallet needs no extra
# mint: it reads the outcome from the paid invoice's description (see flows.js).
# Needs the certificate tools/live/local-mint.sh up made.
cd "$(dirname "$0")/../.." || exit 1
DIR=build/live-tls
# the same pin as local-mint.sh, so flows.js step 5 runs against
# the Nutshell the rest of the run names
NUT_IMAGE=${NUT_IMAGE:-cashubtc/nutshell:0.21.0}
case "$1" in
up)
  [ -f "$DIR/cert.pem" ] || { echo "run sh tools/live/local-mint.sh up first"; exit 1; }
  [ -f "$DIR/pending-proxy.pid" ] && kill "$(cat "$DIR/pending-proxy.pid")" 2>/dev/null
  docker rm -f -v foxy-nutshell-pending >/dev/null 2>&1
  docker run -d --name foxy-nutshell-pending --platform linux/amd64 -p 127.0.0.1:3340:3338 \
    -e MINT_LIGHTNING_BACKEND=FakeWallet -e MINT_INPUT_FEE_PPK=100 \
    -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST_PRIVATE_KEY_PENDING \
    -e FAKEWALLET_DELAY_PAYMENT=TRUE -e FAKEWALLET_DELAY_OUTGOING_PAYMENT=1 -e FAKEWALLET_DELAY_INCOMING_PAYMENT=1 \
    -e FAKEWALLET_PAY_INVOICE_STATE=PENDING -e FAKEWALLET_PAYMENT_STATE=PENDING \
    -e MINT_TRANSACTION_RATE_LIMIT_PER_MINUTE=1000 \
    "$NUT_IMAGE" poetry run mint >/dev/null || exit 1
  i=0; until curl -s -m 3 http://127.0.0.1:3340/v1/info >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -gt 120 ] && { echo "no answer from :3340"; exit 1; }; sleep 1; done
  ( nohup node tools/live/tls-proxy.js 8445 3340 "$DIR" > "$DIR/pending-proxy.log" 2>&1 & echo $! > "$DIR/pending-proxy.pid" )
  i=0; until curl -s -m 3 --cacert "$DIR/cert.pem" https://127.0.0.1:8445/v1/info >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -gt 30 ] && { echo "no answer from :8445"; exit 1; }; sleep 1; done
  echo "Nutshell (melts stay PENDING)  https://127.0.0.1:8445"
  ;;
down)
  [ -f "$DIR/pending-proxy.pid" ] && kill "$(cat "$DIR/pending-proxy.pid")" 2>/dev/null
  rm -f "$DIR/pending-proxy.pid"
  docker rm -f -v foxy-nutshell-pending >/dev/null 2>&1
  echo "stopped"
  ;;
*) echo "usage: sh tools/live/pending-mint.sh up|down"; exit 2 ;;
esac
