#!/bin/bash
# build-tor.sh — Tor, and the three libraries it is built with, from signed sources.
#
#     bash tools/build-tor.sh             build Vendor/TorPod/tor.xcframework; record it in Vendor/Tor.sha256
#     bash tools/build-tor.sh --check     build twice and say IDENTICAL or DIFFERENT; changes nothing
#     bash tools/build-tor.sh --sources   fetch and verify the sources only
#
# Tor runs in the wallet's process, next to the seed. It used to arrive as the
# Tor.framework maintainer's prebuilt binary, which nothing here could check
# against its source. Now it is built here, and what ships is what this made:
#
#   - Each source is the commit its tag names, pinned below. A moved tag stops
#     the build.
#   - Each tag's signature is checked against a key in Vendor/TorPod/keys, taken
#     from the project that signs it (Vendor/README.md says where). A bad
#     signature, or one from a key other than the pinned one, stops the build.
#   - Nothing about the moment reaches the library: no bitcode (its embedded
#     command lines carried the build folder), no debug info, install prefixes
#     that never change (staged with DESTDIR), zeroed archive dates and uids
#     (libtool -D, ZERO_AR_DATE) and SOURCE_DATE_EPOCH=0.
#   - The build runs in one fixed folder. OpenSSL writes its compiler command
#     line into the library, so a build folder that changed would change it.
#   - Xcode is reached through $WORK/xcode, a link to wherever it is installed.
#     OpenSSL records its compiler's path and Tor its configure line, so an
#     Xcode at another path made different bytes.
#   - The autotools that generate the build scripts (autoconf, automake,
#     libtool, gettext's autopoint, m4) are built by tools/build-autotools.sh
#     from GNU's signed release tarballs, into a fixed prefix, not taken from
#     Homebrew.
#   - Configure and make run with only /usr/bin:/bin:/usr/sbin:/sbin on PATH, so
#     a pkg-config or other tool installed on one machine changes nothing.
#   - Every configure, make and autogen step, and the header fixer and libtool,
#     runs under env -i with the few variables sysenv names. CONFIG_SITE,
#     CPPFLAGS, PERL5OPT, MAKEFLAGS and whatever else the caller's shell holds
#     never reach them (audit finding T5).
#   - git reads no system or user config and runs no hooks: an insteadOf in
#     ~/.gitconfig cannot point a clone elsewhere, and a hook cannot run in one.
#   - gpg is the one tool taken from the caller's PATH (Homebrew's, on a
#     developer's Mac and on GitHub's). It runs with a fresh, empty GNUPGHOME and
#     only decides whether a signature verifies; the commits it vouches for are
#     pinned by hash as well, and nothing it does reaches the bytes.
#   - The xcframework's Info.plist is written here. xcodebuild lists the two
#     slices in whatever order it likes, a different file from run to run.
#
# So two builds of these sources with the same Xcode and the same autotools
# make the same bytes; --check shows it. The toolchain is recorded in
# Vendor/Tor.sha256 beside the hashes.
#
# The steps follow Tor.framework's build-xcframework.sh at v409.11.2 (commit
# 727f628a, MIT), with the differences above, and only what Foxy uses: iOS arm64
# and the arm64 simulator, with LZMA. No macOS, no x86_64 simulator, no
# no-LZMA variant, no Arti. Tor.framework's patch (mmap-cache.patch, upstream
# tor#40832) and header fixer (fix_includes.pl) are kept in Vendor/TorPod and
# pinned by SHA-256 below.
#
# Needs Xcode's command line tools, git, gpg, perl and curl. The autotools are GNU's
# own releases, built from their signed tarballs by tools/build-autotools.sh;
# Homebrew is not used.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POD="$ROOT/Vendor/TorPod"
OUT="$POD/tor.xcframework"
SUMS="$ROOT/Vendor/Tor.sha256"
WORK=/private/tmp/foxy-tor-build        # fixed on purpose: see above

# name      url                                             tag                    commit                                     primary key of the tag's signer
SOURCES="
xz          https://github.com/tukaani-project/xz.git       v5.8.4                 d3e650e63c110e830fd5391e7f8b45df0b91d3da   3690C240CE51B4670D30AD1C38EE757D69184620
openssl     https://github.com/openssl/openssl.git          openssl-3.6.4          d3c1b1169b3569ff3069e5b399f47b2b28e03d79   B146647E45A7B33947AB226B2A2C87D161692D40
libevent    https://github.com/libevent/libevent.git        release-2.1.13-stable  79ddfb460847999b807cba76d04e73891f29c6ee   2133BC600AB133E1D826D173FE43009C4607B1FB
tor         https://gitlab.torproject.org/tpo/core/tor.git  tor-0.4.9.12           78923280eed3eff6a77910bba59ecc1fa2244e02   B74417EDDF22AC9F9E90F49142E86A2A11F48D36
"
TOR_VERSION=0.4.9.12
MIN_IOS=15.0
PATCH_SHA256=338f0b32031b0dd1c5c71454d2d5fe28e1f62584c257fd52f9ea4d8d81768c79
FIXINC_SHA256=78b92bc2736fe455e5e7fbe6d46370d6c9306c57a3296819fc8835ceb1e10a1a

# gpg is the one tool taken from wherever it is installed, to check signatures;
# nothing it does reaches the build
GPG=$(command -v gpg || true)
AUTOTOOLS=$(bash "$ROOT/tools/build-autotools.sh" --prefix)
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"   # Apple's libtool and perl; no Homebrew
# Configuring and compiling see only the system's tools. The autotools from
# tools/build-autotools.sh generate the build scripts (build_into); after that nothing on the machine's
# PATH may change what gets built. A GitHub runner with pkgconf installed
# found pkg-config, which a Mac without it did not (it changed no setting, but
# nothing installed should get the chance).
SYSPATH="/usr/bin:/bin:/usr/sbin:/sbin"
# Sources are copied with their times (cp -Rp). A plain copy made configure.ac
# look newer than Makefile.in, and make quietly ran automake again mid-build.
export LC_ALL=C TZ=UTC ZERO_AR_DATE=1 SOURCE_DATE_EPOCH=0

# git: no system or user config, no hooks, and no GIT_* variable from the caller
# (GIT_CONFIG_PARAMETERS could carry an insteadOf too). The pinned commit and the
# tag's signature would catch a clone from somewhere else; this keeps the
# caller's settings out of the build altogether.
unset $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p')
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git() { command git -c core.hooksPath=/dev/null "$@"; }

# sysenv [VAR=value ...] command ... — run a build step with nothing of the
# caller's environment: only what is named here, then the step's own VAR=value
# (a later PATH= replaces this one; env sets them in order). HOME and TMPDIR are
# empty folders in the build folder. DEVELOPER_DIR is kept when set, because it
# chooses the Xcode that xcrun, clang and /usr/bin/libtool resolve to, and that
# Xcode is recorded in Vendor/Tor.sha256.
sysenv() {
  local keep=()
  [ -n "${DEVELOPER_DIR:-}" ] && keep+=("DEVELOPER_DIR=$DEVELOPER_DIR")
  env -i ${keep[@]+"${keep[@]}"} PATH="$SYSPATH" HOME="$WORK/home" TMPDIR="$WORK/tmp" SHELL=/bin/sh \
    LC_ALL=C TZ=UTC ZERO_AR_DATE=1 SOURCE_DATE_EPOCH=0 \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "$@"
}
GITSYS="git -c core.hooksPath=/dev/null"   # git inside sysenv, where the function above is not seen

MAP="-g0 -ffile-prefix-map=$WORK=/foxy-tor -fdebug-prefix-map=$WORK=/foxy-tor -fmacro-prefix-map=$WORK=/foxy-tor"

die() { echo "--- $*" >&2; exit 1; }
for tool in git perl xcrun xcodebuild shasum rsync curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required (Xcode's command line tools)"
done
[ -n "$GPG" ] || die "gpg is required, to check the sources' signatures"
[ "$(shasum -a 256 "$POD/mmap-cache.patch" | cut -d' ' -f1)" = "$PATCH_SHA256" ] || die "Vendor/TorPod/mmap-cache.patch is not the pinned one"
[ "$(shasum -a 256 "$POD/fix_includes.pl" | cut -d' ' -f1)" = "$FIXINC_SHA256" ] || die "Vendor/TorPod/fix_includes.pl is not the pinned one"

# ---- sources: the pinned commit, signed by the pinned key ------------------------
fetch_sources() {   # fetch_sources <dir>
  local dir=$1 gnupg name url tag commit key head status valid primary when subkey expires
  gnupg=$(mktemp -d "${TMPDIR:-/tmp}/foxy-tor-gnupg.XXXXXX")
  chmod 700 "$gnupg"
  GNUPGHOME="$gnupg" "$GPG" --batch --quiet --import "$POD"/keys/*.asc 2>/dev/null
  mkdir -p "$dir"
  while read -r name url tag commit key; do
    [ -n "$name" ] || continue
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "$url" "$dir/$name"
    head=$(git -C "$dir/$name" rev-parse HEAD)
    [ "$head" = "$commit" ] || die "$name: $tag is commit $head, pinned $commit"
    [ "$(git -C "$dir/$name" cat-file -t "refs/tags/$tag")" = tag ] || die "$name: $tag is not an annotated, signed tag"
    status=$(GNUPGHOME="$gnupg" git -c gpg.program="$GPG" -C "$dir/$name" verify-tag --raw "$tag" 2>&1 >/dev/null || true)
    if printf '%s\n' "$status" | grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|REVKEYSIG|NO_PUBKEY)'; then
      die "$name: the signature on $tag does not verify: $(printf '%s' "$status" | grep -E 'BADSIG|ERRSIG|REVKEYSIG|NO_PUBKEY')"
    fi
    valid=$(printf '%s\n' "$status" | awk '$2 == "VALIDSIG" { print $12, $5, $3 }')
    [ -n "$valid" ] || die "$name: no valid signature on $tag"
    read -r primary when subkey <<<"$valid"
    [ "$primary" = "$key" ] || die "$name: $tag is signed by $primary, pinned $key"
    if printf '%s\n' "$status" | grep -q '^\[GNUPG:\] EXPKEYSIG'; then
      # a key that has expired since is fine, if it was valid when it signed
      expires=$(GNUPGHOME="$gnupg" "$GPG" --batch --with-colons --list-keys "$primary" 2>/dev/null |
        awk -F: -v k="$subkey" '/^(pub|sub):/ { e = $7 } /^fpr:/ && $10 == k { print e; exit }')
      [ -n "$expires" ] && [ "$when" -lt "$expires" ] || die "$name: $tag was signed after its key expired"
      echo "  ok    $name $tag  ${commit:0:12}  signed by ${primary:0:16}… (its key has expired since; valid when it signed)"
    else
      printf '%s\n' "$status" | grep -q '^\[GNUPG:\] GOODSIG' || die "$name: no good signature on $tag"
      echo "  ok    $name $tag  ${commit:0:12}  signed by ${primary:0:16}…"
    fi
  done <<<"$SOURCES"
  # gpg 2.4 and later start keyboxd or an agent for a new home: stop them before removing it
  GNUPGHOME="$gnupg" "$(dirname "$GPG")/gpgconf" --kill all 2>/dev/null || true
  rm -rf "$gnupg"
}

# ---- the pod's other files: podspec, licence, patch, header fixer, signing keys ---
# Recorded in Vendor/Tor.sha256 beside the build (audit finding T6): the
# podspec decides what CocoaPods compiles and links into Foxy, so a
# script_phase, an extra library or a linker flag there must show as a change.
pod_files() {   # relative to Vendor/TorPod, sorted
  ( cd "$POD" && { printf '%s\n' LICENSE Tor.podspec fix_includes.pl mmap-cache.patch; find keys -type f -name '*.asc'; } | LC_ALL=C sort )
}
pod_sums() {
  pod_files | ( cd "$POD" && xargs shasum -a 256 )
}
check_pod_files() {   # the files in Vendor/TorPod against Vendor/Tor.sha256
  local want got
  want=$(awk '/^# the pod.s other files/ { on = 1; next } /^#/ { on = 0 } on && NF == 2' "$SUMS")
  [ -n "$want" ] || die "Vendor/Tor.sha256 records none of the pod's other files (podspec, licence, patch, header fixer, keys)"
  got=$(pod_sums)
  [ "$got" = "$want" ] || die "Vendor/TorPod is not what Vendor/Tor.sha256 records: $(diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | grep '^[<>]' | tr '\n' ' ')"
  echo "  ok    Vendor/TorPod's podspec, licence, patch, header fixer and $(printf '%s\n' "$got" | grep -c ' keys/') keys are the ones Vendor/Tor.sha256 records"
}

# ---- one platform ---------------------------------------------------------------
build_slice() {   # build_slice <sdk> <arch> <openssl target>
  local sdk=$1 arch=$2 target=$3 sdkpath clang stage obj log jobs
  sdkpath=$(xcrun --sdk "$sdk" --show-sdk-path)
  clang=$(xcrun --sdk "$sdk" --find clang)
  # Xcode through one fixed path, wherever it is installed: OpenSSL writes its
  # compiler's path into the library and Tor its configure line into orconfig.h.
  # A runner with Xcode at Xcode_26.3.app made a different tor for that alone.
  local dev=${clang%/Toolchains/*}
  ln -sfn "$dev" "$WORK/xcode"
  clang="$WORK/xcode/${clang#"$dev"/}"
  sdkpath="$WORK/xcode/${sdkpath#"$dev"/}"
  [ -x "$clang" ] && [ -d "$sdkpath" ] || die "Xcode is not reachable through $WORK/xcode ($dev)"
  stage="$WORK/stage/$sdk"
  obj="$WORK/obj/$sdk"
  log="$WORK/log-$sdk.txt"
  # half the cores by default: every core per library made the Mac unusable while it built
  # (load in the hundreds). The job count does not change the bytes.
  jobs=${FOXY_TOR_JOBS:-$(( $(sysctl -n hw.physicalcpu) / 2 ))}
  mkdir -p "$stage" "$obj"

  echo "- liblzma ($sdk $arch)"
  cp -Rp "$WORK/src/xz" "$obj/xz"
  ( cd "$obj/xz" &&
    sysenv ./configure --disable-shared --enable-static --disable-doc --disable-scripts \
      --disable-xz --disable-xzdec --disable-lzmadec --disable-lzmainfo --disable-lzma-links \
      --prefix=/foxy-tor/liblzma \
      CC="$clang -arch $arch" CPP="$clang -E -arch $arch" \
      CFLAGS="-isysroot $sdkpath -m$sdk-version-min=$MIN_IOS -O2 $MAP -Wno-unknown-warning-option" \
      LDFLAGS="-isysroot $sdkpath" cross_compiling=yes ac_cv_func_clock_gettime=no &&
    sysenv make -j"$jobs" && sysenv make install DESTDIR="$stage" ) >>"$log" 2>&1 || die "liblzma failed ($sdk): see $log"

  echo "- OpenSSL ($sdk $arch)"
  cp -Rp "$WORK/src/openssl" "$obj/openssl"
  ( cd "$obj/openssl" &&
    sysenv ./Configure no-shared no-async zlib-dynamic enable-ec_nistp_64_gcc_128 \
      --prefix=/foxy-tor/libssl --openssldir=/foxy-tor/ssl "$target" \
      CC="$clang -isysroot $sdkpath -arch $arch -m$sdk-version-min=$MIN_IOS $MAP" &&
    sysenv make depend && sysenv make -j"$jobs" build_libs && sysenv make install_dev DESTDIR="$stage" ) >>"$log" 2>&1 || die "OpenSSL failed ($sdk): see $log"

  echo "- libevent ($sdk $arch)"
  cp -Rp "$WORK/src/libevent" "$obj/libevent"
  ( cd "$obj/libevent" &&
    sysenv ./configure --disable-shared --disable-openssl --disable-libevent-regress --disable-samples \
      --disable-doxygen-html --enable-static --enable-gcc-hardening --disable-debug-mode \
      --prefix=/foxy-tor/libevent \
      CC="$clang -arch $arch" CPP="$clang -E -arch $arch" \
      CFLAGS="-isysroot $sdkpath -m$sdk-version-min=$MIN_IOS -O2 $MAP" \
      LDFLAGS="-isysroot $sdkpath" cross_compiling=yes ac_cv_func_clock_gettime=no ac_cv_func_pipe2=no &&
    sysenv make -j"$jobs" && sysenv make install DESTDIR="$stage" ) >>"$log" 2>&1 || die "libevent failed ($sdk): see $log"

  echo "- Tor ($sdk $arch)"
  cp -Rp "$WORK/src/tor" "$obj/tor"
  ( cd "$obj/tor" &&
    sysenv ./configure --enable-silent-rules --enable-pic --disable-module-relay --disable-module-dirauth \
      --disable-tool-name-check --disable-unittests --enable-static-openssl --enable-static-libevent \
      --disable-asciidoc --disable-system-torrc --disable-linker-hardening --disable-dependency-tracking \
      --disable-manpage --disable-html-manual --disable-gcc-warnings-advisory --enable-lzma=yes --disable-zstd \
      --with-libevent-dir="$stage/foxy-tor/libevent" --with-openssl-dir="$stage/foxy-tor/libssl" \
      --prefix=/foxy-tor/libtor \
      CC="$clang -arch $arch -isysroot $sdkpath" CPP="$clang -E -arch $arch -isysroot $sdkpath" \
      CPPFLAGS="-Isrc/core -I$stage/foxy-tor/libssl/include -I$stage/foxy-tor/libevent/include -m$sdk-version-min=$MIN_IOS" \
      CFLAGS="-O2 $MAP" LDFLAGS="-lz" \
      LZMA_CFLAGS="-I$stage/foxy-tor/liblzma/include" LZMA_LIBS="$stage/foxy-tor/liblzma/lib/liblzma.a" \
      cross_compiling=yes ac_cv_func__NSGetEnviron=no ac_cv_func_clock_gettime=no \
      ac_cv_func_getentropy=no ac_cv_func_pipe2=no &&
    sleep 2 && rm -f src/lib/cc/orconfig.h && cp orconfig.h src/lib/cc/ &&
    sysenv make libtor.a -j"$jobs" V=1 &&
    mkdir -p "$stage/foxy-tor/libtor/include" &&
    rsync --archive --include='*.h' -f 'hide,! */' --prune-empty-dirs src/ "$stage/foxy-tor/libtor/include/" &&
    cp orconfig.h "$stage/foxy-tor/libtor/include/" ) >>"$log" 2>&1 || die "Tor failed ($sdk): see $log"
}

# ---- the framework for one platform ----------------------------------------------
make_framework() {   # make_framework <sdk>
  local sdk=$1 stage="$WORK/stage/$1" fw="$WORK/fw/$1/tor.framework"
  mkdir -p "$fw/Versions/A/Headers" "$fw/Versions/A/Modules" "$fw/Versions/A/Resources"
  ln -s A "$fw/Versions/Current"
  ln -s Versions/Current/Headers "$fw/Headers"
  ln -s Versions/Current/Modules "$fw/Modules"
  ln -s Versions/Current/Resources "$fw/Resources"
  ln -s Versions/Current/tor "$fw/tor"
  sysenv libtool -static -D -o "$fw/Versions/A/tor" \
    "$stage/foxy-tor/libssl/lib/libssl.a" "$stage/foxy-tor/libssl/lib/libcrypto.a" \
    "$stage/foxy-tor/libevent/lib/libevent.a" "$stage/foxy-tor/liblzma/lib/liblzma.a" \
    "$WORK/obj/$sdk/tor/libtor.a"
  cp -R "$stage/foxy-tor/libssl/include/." "$stage/foxy-tor/libevent/include/." \
    "$stage/foxy-tor/libtor/include/." "$fw/Versions/A/Headers/"
  sysenv perl "$POD/fix_includes.pl" "$fw/Versions/A/Headers" >>"$WORK/log-$sdk.txt" 2>&1
  cat > "$fw/Versions/A/Headers/tor_umbrella.h" <<'EOF'
#ifndef Tor_Umbrella_h
#define Tor_Umbrella_h

#import "event2/event.h"
#import "lib/log/log.h"
#import "feature/api/tor_api.h"
#import "lib/malloc/malloc.h"
#import "lib/crypt_ops/crypto_curve25519.h"
#import "lib/encoding/binascii.h"

#endif
EOF
  cat > "$fw/Versions/A/Modules/module.modulemap" <<'EOF'
framework module tor {
    umbrella header "tor_umbrella.h"
    export *
}
EOF
  cat > "$fw/Versions/A/Resources/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>tor</string>
  <key>CFBundleIdentifier</key>
  <string>org.torproject.tor</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>tor</string>
  <key>CFBundlePackageType</key>
  <string>FMWK</string>
  <key>CFBundleShortVersionString</key>
  <string>$TOR_VERSION</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>$sdk</string>
  </array>
  <key>CFBundleVersion</key>
  <string>$TOR_VERSION</string>
</dict>
</plist>
EOF
}

# ---- everything, into one xcframework ---------------------------------------------
build_into() {   # build_into <xcframework path>
  local dest=$1
  # /private/tmp is shared: a folder another account creates between the rm
  # and a mkdir -p would have been used as it was (audit finding T2)
  rm -rf "$WORK"
  mkdir -m 700 "$WORK" || die "$WORK already exists and could not be replaced: another account may own it"
  { [ -O "$WORK" ] && [ ! -L "$WORK" ]; } || die "$WORK is not this user's own folder"
  mkdir -m 700 "$WORK/home" "$WORK/tmp"   # sysenv's HOME and TMPDIR
  echo "sources:"
  fetch_sources "$WORK/src"

  FOXY_GPG="$GPG" bash "$ROOT/tools/build-autotools.sh" || die "the autotools did not build (tools/build-autotools.sh)"
  echo "generating build scripts"
  AUTOPATH="PATH=$AUTOTOOLS/bin:$SYSPATH"
  ( cd "$WORK/src/xz" && sysenv "$AUTOPATH" LIBTOOLIZE=glibtoolize ./autogen.sh --no-po4a --no-doxygen ) >>"$WORK/log-src.txt" 2>&1 || die "xz autogen failed: see $WORK/log-src.txt"
  ( cd "$WORK/src/libevent" && sysenv "$AUTOPATH" LIBTOOLIZE=glibtoolize ./autogen.sh ) >>"$WORK/log-src.txt" 2>&1 || die "libevent autogen failed: see $WORK/log-src.txt"
  ( cd "$WORK/src/tor" && sysenv $GITSYS apply "$POD/mmap-cache.patch" &&
    sed -i '' -e 's/all,error/no-obsolete,error/' autogen.sh &&     # as Tor.framework does, undone below
    sysenv "$AUTOPATH" ./autogen.sh && sysenv $GITSYS checkout -- autogen.sh ) >>"$WORK/log-src.txt" 2>&1 || die "tor autogen failed: see $WORK/log-src.txt"

  build_slice iphoneos arm64 ios64-xcrun
  build_slice iphonesimulator arm64 iossimulator-xcrun
  make_framework iphoneos
  make_framework iphonesimulator

  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  xcodebuild -create-xcframework \
    -framework "$WORK/fw/iphoneos/tor.framework" \
    -framework "$WORK/fw/iphonesimulator/tor.framework" \
    -output "$dest" >>"$WORK/log-fw.txt" 2>&1 || die "xcodebuild -create-xcframework failed: see $WORK/log-fw.txt"
  xcframework_plist > "$dest/Info.plist"
  # what each configure found, kept for comparing two machines' builds
  mkdir -p "$ROOT/build/tor-logs"
  for s in iphoneos iphonesimulator; do cp "$WORK/obj/$s/tor/config.log" "$ROOT/build/tor-logs/tor-config-$s.log" 2>/dev/null || true; done
  cp "$WORK"/log-*.txt "$ROOT/build/tor-logs/" 2>/dev/null || true
  rm -rf "$WORK"
}

xcframework_plist() {   # the Info.plist xcodebuild writes, with the slices always in this order
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0">' '<dict>' '	<key>AvailableLibraries</key>' '	<array>'
  for id in ios-arm64 ios-arm64-simulator; do
    printf '%s\n' '		<dict>' '			<key>BinaryPath</key>' '			<string>tor.framework/Versions/A/tor</string>' \
      '			<key>LibraryIdentifier</key>' "			<string>$id</string>" \
      '			<key>LibraryPath</key>' '			<string>tor.framework</string>' \
      '			<key>SupportedArchitectures</key>' '			<array>' '				<string>arm64</string>' '			</array>' \
      '			<key>SupportedPlatform</key>' '			<string>ios</string>'
    [ "$id" = ios-arm64-simulator ] && printf '%s\n' '			<key>SupportedPlatformVariant</key>' '			<string>simulator</string>'
    printf '%s\n' '		</dict>'
  done
  printf '%s\n' '	</array>' '	<key>CFBundlePackageType</key>' '	<string>XFWK</string>' \
    '	<key>XCFrameworkFormatVersion</key>' '	<string>1.0</string>' '</dict>' '</plist>'
}

# every file's SHA-256 and every link's target, in a fixed order
listing() {   # listing <xcframework>
  ( cd "$1" && find . \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then printf 'link %s -> %s\n' "${f#./}" "$(readlink "$f")"
      else printf '%s %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#./}"; fi
    done )
}

toolchain() {
  local xc; xc=$(xcodebuild -version)       # read whole: a pipe closed early crashed xcodebuild
  printf '# toolchain: %s (%s), %s, iOS SDK %s\n' "$(printf '%s\n' "$xc" | sed -n 1p)" \
    "$(printf '%s\n' "$xc" | sed -n 2p)" "$(clang --version | sed -n 1p)" "$(xcrun --sdk iphoneos --show-sdk-version)"
  printf '#            %s; %s; %s; %s; perl %s\n' "$("$AUTOTOOLS/bin/autoconf" --version | head -1)" \
    "$("$AUTOTOOLS/bin/automake" --version | head -1)" "$("$AUTOTOOLS/bin/glibtool" --version | head -1)" "$("$AUTOTOOLS/bin/autopoint" --version | head -1)" \
    "$(perl -e 'print substr($^V, 1)')"
}

case "${1:-}" in
  --verify)
    # the check anyone can run: rebuild, and compare with what Vendor/Tor.sha256 records
    [ -f "$SUMS" ] || die "Vendor/Tor.sha256 is missing"
    check_pod_files
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/foxy-tor-verify.XXXXXX")
    build_into "$tmp/tor.xcframework"
    listing "$tmp/tor.xcframework" > "$tmp/listing.txt"
    got=$(shasum -a 256 < "$tmp/listing.txt" | cut -d' ' -f1)
    want=$(awk '$2 == "tor.xcframework" { print $1 }' "$SUMS")
    toolchain | sed 's/^# //'
    grep '^# toolchain\|^#   *auto' "$SUMS" | sed 's/^# /recorded /'
    if [ -n "$want" ] && [ "$got" = "$want" ]; then
      echo "VERIFIED: this rebuild is byte for byte the tor.xcframework Vendor/Tor.sha256 records ($got)"
    else
      echo "DIFFERENT: rebuilt $got, recorded ${want:-nothing}"
      grep -E ' (ios-arm64|ios-arm64-simulator)/tor.framework/Versions/A/tor$' "$tmp/listing.txt"
      mkdir -p "$ROOT/build/tor-rebuilt" && cp "$tmp/listing.txt" "$ROOT/build/tor-rebuilt-listing.txt"
      # the text files that differ, to read rather than only hash (binaries are too big to keep)
      diff <(listing "$OUT" 2>/dev/null) "$tmp/listing.txt" | awk '/^>/ { print $3 }' | grep -v '/tor$' |
        while IFS= read -r f; do mkdir -p "$ROOT/build/tor-rebuilt/$(dirname "$f")" && cp "$tmp/tor.xcframework/$f" "$ROOT/build/tor-rebuilt/$f"; done || true
      echo "the rebuilt listing is in build/tor-rebuilt-listing.txt, and differing text files in build/tor-rebuilt"
      rm -rf "$tmp"
      exit 1
    fi
    rm -rf "$tmp"
    ;;
  --sources)
    [ -f "$SUMS" ] || die "Vendor/Tor.sha256 is missing"
    check_pod_files
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/foxy-tor-sources.XXXXXX")
    fetch_sources "$tmp"
    rm -rf "$tmp"
    echo "VERIFIED: every source is its pinned commit, signed by its pinned key"
    ;;
  --check)
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/foxy-tor-check.XXXXXX")
    echo "=== first build"
    build_into "$tmp/a/tor.xcframework"
    echo "=== second build"
    build_into "$tmp/b/tor.xcframework"
    listing "$tmp/a/tor.xcframework" > "$tmp/a.txt"
    listing "$tmp/b/tor.xcframework" > "$tmp/b.txt"
    grep -E ' (ios-arm64|ios-arm64-simulator)/tor.framework/Versions/A/tor$' "$tmp/a.txt"
    echo "files and links: $(wc -l < "$tmp/a.txt" | tr -d ' ')"
    if cmp -s "$tmp/a.txt" "$tmp/b.txt"; then
      echo "IDENTICAL"
    else
      echo "DIFFERENT"
      diff "$tmp/a.txt" "$tmp/b.txt" | head -40 || true
      rm -rf "$tmp"
      exit 1
    fi
    rm -rf "$tmp"
    ;;
  "")
    build_into "$OUT"
    listed=$(mktemp "${TMPDIR:-/tmp}/foxy-tor-listing.XXXXXX")   # not a guessable path in /private/tmp
    listing "$OUT" > "$listed"
    {
      echo "# Tor for Foxy, built by tools/build-tor.sh from signed sources. Not edited by hand:"
      echo "# rebuild, and this file is rewritten. Smoke check 18 compares Vendor/TorPod against it."
      echo "#"
      echo "# Tor $TOR_VERSION with OpenSSL 3.6.4, libevent 2.1.13 and xz 5.8.4, for iOS arm64 and the arm64 simulator."
      echo "# sources (name, tag, commit, primary key of the tag's signer):"
      printf '%s\n' "$SOURCES" | awk 'NF { printf "#   %-9s %-22s %s %s\n", $1, $3, $4, $5 }'
      toolchain
      echo "# A rebuild with this toolchain makes these bytes: bash tools/build-tor.sh --verify"
      echo "#"
      echo "# tor.xcframework: the SHA-256 of its listing (every file's hash and every link, sorted)"
      echo "$(shasum -a 256 < "$listed" | cut -d' ' -f1)  tor.xcframework"
      grep -E ' (ios-arm64|ios-arm64-simulator)/tor.framework/Versions/A/tor$' "$listed" |
        awk '{ print $1 "  tor.xcframework/" $2 }'
      echo "# the Objective-C wrapper, Tor.framework 727f628a (v409.11.2), compiled into Foxy by CocoaPods"
      ( cd "$POD" && find Tor -type f | LC_ALL=C sort | xargs shasum -a 256 )
      echo "# the pod's other files: its podspec and licence, Tor.framework's patch and header fixer, and the signing keys"
      pod_sums
    } > "$SUMS"
    rm -f "$listed"
    echo "--- built $OUT"
    cat "$SUMS"
    ;;
  *)
    die "usage: bash tools/build-tor.sh [--verify | --check | --sources]"
    ;;
esac
