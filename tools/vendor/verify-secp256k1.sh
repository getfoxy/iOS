#!/usr/bin/env bash
# verify-secp256k1.sh — Vendor/secp256k1 is libsecp256k1's signed tag v0.8.0,
# file for file.
#
#     bash tools/vendor/verify-secp256k1.sh
#
# Foxy compiles libsecp256k1 from source into every build, for the BIP-32 step
# of NUT-13 (Foxy/Keychain/NUT13.swift, Vendor/README.md). This checks it again
# from the public repository, the way the import and the review checked it by
# hand:
#   1. fetches tag v0.8.0 from github.com/bitcoin-core/secp256k1 into a new, empty
#      bare repository in a temporary folder (nothing else is fetched);
#   2. the tag object is 18f07c42… and points at commit 6e2c8bc4…;
#   3. `git verify-tag` against keys/secp256k1-thestack.gpg only, in a fresh
#      GNUPGHOME: a good signature whose primary key is Sebastian Falbesoner's
#      (theStack) 6A8F9C266528E25AEB1D7731C2371D91CB716EA7. The key file is
#      bitcoin-core/guix.sigs' builder-keys/theStack.gpg, as fetched
#      (sha256 below);
#   4. every file in Vendor/secp256k1 has the `git hash-object` of the file at
#      the same path in the tag's tree, and every one is there (52 files: the
#      library, its tables, their headers, and the ecdh, extrakeys and
#      schnorrsig modules Foxy/Nostr needs).
#
# Needs bash, git, gpg and shasum. Network: github.com. Writes only to a mktemp
# directory. Exits 0 only if every step passes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
URL="https://github.com/bitcoin-core/secp256k1.git"
TAG="v0.8.0"
TAG_OBJECT="18f07c42218765cd46148d74d9fe575795f56dce"
COMMIT="6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d"
SIGNER="6A8F9C266528E25AEB1D7731C2371D91CB716EA7"
KEY="$HERE/keys/secp256k1-thestack.gpg"
KEY_SHA256="ffd7e42d89dae3c30dc26e5b472f1eee8d887600c03c1bdc3bc2a98ad93fae06"
FILES=52

WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-secp256k1.XXXXXX")"
export GNUPGHOME="$WORK/gnupg"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }
step() { printf '\n==> %s\n' "$*"; }

REPO="$WORK/secp256k1.git"
g() { git --git-dir="$REPO" "$@"; }

step "1. fetch $TAG into an empty bare repository"
git init --quiet --bare "$REPO"
g fetch --quiet --no-tags --depth 1 "$URL" "refs/tags/$TAG:refs/tags/$TAG"
ok "fetched refs/tags/$TAG"

step "2. the tag and its commit are the pinned ones"
got_tag="$(g rev-parse "refs/tags/$TAG")"
got_commit="$(g rev-parse "refs/tags/$TAG^{commit}")"
if [ "$got_tag" = "$TAG_OBJECT" ]; then ok "tag object $got_tag"; else bad "tag object $got_tag, pinned $TAG_OBJECT"; fi
if [ "$got_commit" = "$COMMIT" ]; then ok "commit $got_commit"; else bad "commit $got_commit, pinned $COMMIT"; fi

step "3. the tag's signature, against the pinned key only"
key_sha="$(shasum -a 256 "$KEY" | cut -d' ' -f1)"
if [ "$key_sha" = "$KEY_SHA256" ]; then ok "key file is the one recorded"; else bad "key file sha256 $key_sha, recorded $KEY_SHA256"; fi
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import "$KEY" 2>/dev/null
if gpg --batch --with-colons --fingerprint 2>/dev/null | grep -q "^fpr:::::::::$SIGNER:"; then
  ok "the key file holds primary key $SIGNER"
else
  bad "the key file does not hold $SIGNER"
fi
status="$(g verify-tag --raw "refs/tags/$TAG" 2>&1 || true)"
# VALIDSIG <signing key fpr> ... <primary key fpr>: the last field is the primary key
validsig="$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $NF }' | head -1)"
if printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG ' && [ "$validsig" = "$SIGNER" ]; then
  ok "good signature, primary key $validsig"
else
  bad "no good signature by $SIGNER"
  printf '%s\n' "$status" | sed 's/^/        /'
fi

step "4. every vendored file is the tag's"
count=0
while IFS= read -r -d '' file; do
  rel="${file#"$ROOT/Vendor/secp256k1/"}"
  case "$rel" in .DS_Store|*/.DS_Store) continue ;; esac
  count=$((count + 1))
  want="$(g rev-parse --verify --quiet "refs/tags/$TAG^{tree}:$rel" || true)"
  have="$(git hash-object "$file")"
  if [ -z "$want" ]; then
    bad "$rel is not in the tag"
  elif [ "$want" != "$have" ]; then
    bad "$rel differs from the tag ($have, tag $want)"
  fi
done < <(find "$ROOT/Vendor/secp256k1" -type f -print0 | sort -z)
if [ "$count" -eq "$FILES" ]; then ok "$count files, each compared"; else bad "$count files, expected $FILES"; fi

echo
if [ "$fail" -eq 0 ]; then
  echo "VERIFIED: Vendor/secp256k1 is libsecp256k1 $TAG ($COMMIT), signed by $SIGNER"
else
  echo "NOT VERIFIED: $fail check(s) failed"
  exit 1
fi
