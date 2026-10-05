#!/bin/sh
# cdk-cli-restore.sh — CDK's own wallet CLI restores a seed at a local mint.
# Fake money only. Used by cross-wallet-restore.js as its CDK_CLI_RESTORE_CMD:
#
#   CDK_CLI_RESTORE_CMD="sh tools/live/cdk-cli-restore.sh" node tools/live/cross-wallet-restore.js all
#
# Gets WORDS, MINT (http, as seen from this Mac) and DIR in its environment and
# prints "<n> sat", the unspent amount cdk-cli's restore found.
#
# There is no official cdk-cli image. Build one from CDK's v0.18.0 tag, checked
# against the tag's commit (d3dec24c), with the Dockerfile in tools/live/cdk-cli/:
#
#   docker build -t foxy-cdk-cli:0.18.0 tools/live/cdk-cli
#
# cdk-cli keeps its words in <work dir>/seed and creates random ones when that
# file is missing, so the words are written there first. It is built without
# its tor feature, so it has no --tor flag and connects directly.
IMAGE=${CDK_CLI_IMAGE:-foxy-cdk-cli:0.18.0}
: "${WORDS:?WORDS is required}" "${MINT:?MINT is required}" "${DIR:?DIR is required}"
mkdir -p "$DIR" || exit 1
printf '%s' "$WORDS" > "$DIR/seed" || exit 1
# the container reaches this Mac's ports at host.docker.internal
URL=$(printf '%s' "$MINT" | sed -e 's#//127\.0\.0\.1#//host.docker.internal#' -e 's#//localhost#//host.docker.internal#')
out=$(docker run --rm -v "$DIR:/w" "$IMAGE" --work-dir /w restore "$URL" 2>&1) || { printf '%s\n' "$out" >&2; exit 1; }
printf '%s\n' "$out" >&2
n=$(printf '%s\n' "$out" | sed -n 's/^Restored: *\([0-9][0-9]*\).*/\1/p' | tail -1)
[ -n "$n" ] || { echo "cdk-cli printed no 'Restored:' line" >&2; exit 1; }
echo "$n sat"
