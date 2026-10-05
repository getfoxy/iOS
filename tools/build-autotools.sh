#!/usr/bin/env bash
# build-autotools.sh — GNU m4, autoconf, automake, libtool and gettext, built from
# their signed release tarballs, for tools/build-tor.sh.
#
#     bash tools/build-autotools.sh           # build into the prefix below, or reuse it
#     bash tools/build-autotools.sh --prefix  # print the prefix
#
# build-tor.sh generates the build scripts of Tor, libevent and xz with these
# tools. They used to come from Homebrew, so Homebrew's packaging, and
# anything else it had installed, sat between the signed sources and the bytes.
# Now:
#
#   - Each tarball's SHA-256 is pinned below, and its GNU signature must verify
#     against the maintainer's key in Vendor/TorPod/keys (taken from
#     https://ftp.gnu.org/gnu/gnu-keyring.gpg) and be made by that key. A key
#     that has expired since is accepted only if it signed before it expired.
#   - One exception, by hash. libtool 2.6.2 (released 2026-07-16) is signed by
#     Ileana Dumitrescu's key, which by GNU's keyring, keys.openpgp.org and
#     keyserver.ubuntu.com expired on 2026-03-07 and was never renewed in public.
#     The signature is valid, but it postdates the expiry. The tarball is accepted
#     only at its pinned SHA-256, the same hash Homebrew pins for it
#     independently; anything else signed after its key expired stops the build.
#   - /private/tmp is shared by every account on the Mac. A prefix is reused only
#     if this user made it and nothing in it is owned by anyone else or writable
#     by group or others, and only if its stamp names this script's own hash as
#     well as the pins. A folder another account planted there, with the public
#     stamp text, would otherwise have put its tools into Tor's build (audit
#     finding T1).
#   - They build with only the system's tools on PATH, into one fixed prefix, so
#     any path they write into what they generate is the same on every machine.
#   - Each configure and make runs under env -i with the few variables cleanenv
#     names, so CONFIG_SITE, CFLAGS, PERL5OPT, MAKEFLAGS and the rest of the
#     caller's environment never reach them (audit finding T5). curl reads
#     no ~/.curlrc (-q), and gpg runs with a fresh GNUPGHOME for each tarball.
#     gpg itself comes from the caller's PATH (or FOXY_GPG); Vendor/README.md says so.
#   - Homebrew's two changes that matter are kept: libtool is installed as
#     glibtool and glibtoolize (macOS has its own, different libtool), and
#     autoreconf calls glibtoolize. gettext is configured as Homebrew does, with
#     its included libraries and without Java, C# or Emacs.
#
# The versions are the ones Vendor/Tor.sha256 recorded when Homebrew supplied
# them. A finished prefix carries a stamp naming exactly these pins and is reused
# only when the stamp matches; anything else is removed and built again.
#
# Needs Xcode's command line tools (clang, make, perl), curl and gpg. Network:
# ftp.gnu.org. A few minutes, most of it gettext.
set -euo pipefail
umask 022

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEYS="$ROOT/Vendor/TorPod/keys"
PREFIX=/private/tmp/foxy-autotools     # fixed on purpose: see above
[ "${1:-}" = "--prefix" ] && { echo "$PREFIX"; exit 0; }

# name      version  tarball sha256                                                    signer's primary key                      key file
# tarballs whose signature postdates their key's public expiry, accepted by hash alone (see above)
SIGNED_AFTER_EXPIRY_OK="2ef1067c16c97db930fd740cc9bc3d3ba9a583804ae5ac42cc3e8719e49e191e"

PINS="m4        1.4.21   f25c6ab51548a73a75558742fb031e0625d6485fe5f9155949d6486a2408ab66  71C2CC22B1C4602927D2F3AAA7A16B4A2527436A  gnu-m4-eric-blake.asc
autoconf  2.73     9fd672b1c8425fac2fa67fa0477b990987268b90ff36d5f016dae57be0d6b52e  82F854F3CE73174B8B63174091FCC32B6769AA64  gnu-autoconf-zack-weinberg.asc
automake  1.19     e3e2c2e3abf37898138db5b6c1d1dc35c9160c5978be7947d2c741705251d445  6C222EA6B2BD216AA406516AC868F0B6DE38409D  gnu-automake-kamila-szewczyk.asc
libtool   2.6.2    2ef1067c16c97db930fd740cc9bc3d3ba9a583804ae5ac42cc3e8719e49e191e  FA26CA784BE188927F22B99F6570EA01146F7354  gnu-libtool-ileana-dumitrescu.asc
gettext   1.0      71132a3fb71e68245b8f2ac4e9e97137d3e5c02f415636eb508ae607bc01add7  E0FFBD975397F77A32AB76ECB6301D9E1BBEAC08  gnu-gettext-bruno-haible.asc"

die() { echo "--- $*" >&2; exit 1; }
# build-tor.sh narrows PATH to the system's tools before calling this, and passes
# the gpg it found first
GPG=${FOXY_GPG:-$(command -v gpg || true)}
[ -n "$GPG" ] && [ -x "$GPG" ] || die "gpg is required"
GPGCONF="$(dirname "$GPG")/gpgconf"
command -v curl >/dev/null || die "curl is required"

STAMP="$PREFIX/.foxy-autotools"
STAMP_WANT="$PINS
recipe $(shasum -a 256 "$0" | cut -d' ' -f1)"
UID_SELF=$(id -u)
# this user's, a real directory, and nothing inside owned by another or writable by group or others
owned_and_closed() {
  [ -d "$PREFIX" ] && [ ! -L "$PREFIX" ] && [ -O "$PREFIX" ] &&
    [ -z "$(find "$PREFIX" \( ! -user "$UID_SELF" -o \( ! -type l \( -perm -g+w -o -perm -o+w \) \) \) -print -quit 2>/dev/null)" ]
}
if owned_and_closed && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_WANT" ] &&
   [ -x "$PREFIX/bin/autoreconf" ] && [ -x "$PREFIX/bin/autopoint" ]; then
  echo "autotools: reusing $PREFIX (built from the pinned, signed tarballs)"
  exit 0
fi

rm -rf "$PREFIX" 2>/dev/null || true
[ ! -e "$PREFIX" ] || die "$PREFIX is there and cannot be removed: another account may own it"
mkdir -m 755 "$PREFIX" || die "could not create $PREFIX"
SRC=$(mktemp -d /tmp/foxy-autotools-src.XXXXXX)
mkdir -m 700 "$SRC/home" "$SRC/tmp"
export PATH="$PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin" LC_ALL=C PERL=/usr/bin/perl
jobs=${FOXY_TOR_JOBS:-$(( $(sysctl -n hw.physicalcpu) / 2 ))}

# cleanenv [VAR=value ...] command ... — a configure or make with nothing of the
# caller's environment but what is named here, then the step's own VAR=value.
# DEVELOPER_DIR is kept when set: it chooses the Xcode whose clang builds these.
cleanenv() {
  local keep=()
  [ -n "${DEVELOPER_DIR:-}" ] && keep+=("DEVELOPER_DIR=$DEVELOPER_DIR")
  env -i ${keep[@]+"${keep[@]}"} PATH="$PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    HOME="$SRC/home" TMPDIR="$SRC/tmp" SHELL=/bin/sh LC_ALL=C PERL=/usr/bin/perl "$@"
}

echo "autotools: building into $PREFIX"
while read -r name version sha primary keyfile; do
  [ -n "$name" ] || continue
  tarball="$name-$version.tar.xz"
  url="https://ftp.gnu.org/gnu/$name/$tarball"
  curl -q -fsSL -o "$SRC/$tarball" "$url"
  curl -q -fsSL -o "$SRC/$tarball.sig" "$url.sig"
  [ "$(shasum -a 256 "$SRC/$tarball" | cut -d' ' -f1)" = "$sha" ] || die "$tarball is not the pinned one"

  # a short gpg home: gpg-agent's socket lives there, and macOS caps socket paths
  home=$(mktemp -d /tmp/foxy-gpg.XXXXXX)
  GNUPGHOME="$home" "$GPG" --batch --quiet --import "$KEYS/$keyfile" 2>/dev/null || true
  status=$(GNUPGHOME="$home" "$GPG" --batch --status-fd 1 --verify "$SRC/$tarball.sig" "$SRC/$tarball" 2>/dev/null || true)
  signer=$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $12 }')
  expired_ok=yes
  if printf '%s\n' "$status" | grep -q '^\[GNUPG:\] EXPKEYSIG '; then
    # expired since: fine only if the signing key was still valid when it signed
    when=$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $5 }')
    subkey=$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $3 }')
    expires=$(GNUPGHOME="$home" "$GPG" --batch --with-colons --list-keys "$primary" 2>/dev/null |
      awk -F: -v k="$subkey" '/^(pub|sub):/ { e = $7 } /^fpr:/ && $10 == k { print e; exit }')
    { [ -n "$when" ] && [ -n "$expires" ] && [ "$when" -lt "$expires" ]; } || expired_ok=no
  fi
  GNUPGHOME="$home" "$GPGCONF" --kill gpg-agent 2>/dev/null || true
  rm -rf "$home"
  [ "$signer" = "$primary" ] || die "$tarball: not signed by the pinned key $primary"
  printf '%s\n' "$status" | grep -qE '^\[GNUPG:\] (GOODSIG|EXPKEYSIG) ' || die "$tarball: no good signature"
  if [ "$expired_ok" != yes ]; then
    case " $SIGNED_AFTER_EXPIRY_OK " in
      *" $sha "*) echo "  note  $tarball: signed after its key's public expiry; accepted for this pinned hash only" ;;
      *) die "$tarball: signed by a key that had already expired" ;;
    esac
  fi
  echo "  ok    $tarball  ${sha:0:12}  signed by ${primary:0:16}…"

  tar -xJf "$SRC/$tarball" -C "$SRC"
  log="$SRC/$name.log"
  (
    cd "$SRC/$name-$version"
    case "$name" in
      m4)
        cleanenv ./configure --prefix="$PREFIX" --disable-dependency-tracking
        cleanenv make -j"$jobs" && cleanenv make install ;;
      autoconf)
        # as Homebrew does, in the script and then its manual page, so the page stays
        # newer than the script and make does not try to regenerate it (help2man)
        sed -i '' -e 's/libtoolize/glibtoolize/g' bin/autoreconf.in
        sed -i '' -e 's/libtoolize/glibtoolize/g' man/autoreconf.1
        cleanenv M4="$PREFIX/bin/m4" ./configure --prefix="$PREFIX"
        cleanenv make -j"$jobs" && cleanenv make install ;;
      automake)
        cleanenv ./configure --prefix="$PREFIX"
        cleanenv make -j"$jobs" && cleanenv make install ;;
      libtool)
        cleanenv M4="$PREFIX/bin/m4" ./configure --prefix="$PREFIX" --disable-dependency-tracking \
          --disable-silent-rules --enable-ltdl-install --program-prefix=g
        cleanenv make -j"$jobs" && cleanenv make install ;;
      gettext)
        # macOS's iconv fails gettext's check since Sonoma; Homebrew answers it the same way
        cleanenv am_cv_func_iconv_works=yes CFLAGS="-O2 -Wno-incompatible-function-pointer-types" \
          ./configure --prefix="$PREFIX" --disable-dependency-tracking --disable-silent-rules \
          --with-included-glib --with-included-libcroco --with-included-libunistring \
          --with-included-libxml --with-included-gettext --without-emacs \
          --disable-java --disable-csharp --without-git --without-cvs --without-xz
        cleanenv make -j"$jobs" && cleanenv make install ;;
    esac
  ) > "$log" 2>&1 || { tail -20 "$log"; die "$name $version failed to build: see $log"; }
  echo "        built $name $version"
done <<<"$PINS"

echo "$STAMP_WANT" > "$STAMP"
rm -rf "$SRC"
for t in m4 autoconf automake glibtool autopoint; do
  printf '  %-9s %s\n' "$t" "$("$PREFIX/bin/$t" --version | head -1)"
done
