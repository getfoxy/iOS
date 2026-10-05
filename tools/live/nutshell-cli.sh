#!/bin/sh
# nutshell-cli.sh — Nutshell's `cashu` wallet CLI, from the cashubtc/nutshell
# image the local mint uses, against a mint on this Mac. Fake money only.
#
#   sh tools/live/nutshell-cli.sh <wallet-dir> <mint-url> <cashu args...>
#
# <wallet-dir> is mounted as CASHU_DIR, so the wallet (its sqlite and mnemonic)
# persists between calls. <mint-url> is the mint's plain http port as the
# container sees it, e.g. http://host.docker.internal:3338 (CDK) or :3339
# (Nutshell). stdin is passed through, so a mnemonic can be piped to `restore`:
#
#   echo "$WORDS" | sh tools/live/nutshell-cli.sh build/live-cli/cdk \
#       http://host.docker.internal:3338 restore --to 3 --batch 100
IMAGE=${NUT_IMAGE:-cashubtc/nutshell:0.20.3}
DIR=$1; URL=$2; shift 2
case "$URL" in
  http://host.docker.internal:*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "local mints only: $URL"; exit 2 ;;
esac
mkdir -p "$DIR"
DIR=$(cd "$DIR" && pwd)
# -y (answer yes to prompts) arrived after 0.18; the 0.18 CLI refuses the option
case "$IMAGE" in *:0.18*|*:0.17*|*:0.16*) YES= ;; *) YES=-y ;; esac
exec docker run --rm -i --platform linux/amd64 \
  -v "$DIR":/data -e CASHU_DIR=/data -e MINT_URL="$URL" -e TOR=false -e DEBUG=false \
  "$IMAGE" poetry run cashu $YES "$@" 2>&1 \
  | grep -v "is an entry point defined in pyproject\|support to run uninstalled\|poetry install\|Skipping virtualenv\|^$"
