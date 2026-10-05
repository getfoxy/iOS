#!/bin/sh
# install-hooks.sh — put this repository's git hooks in .git/hooks.
#
#   sh tools/install-hooks.sh
#
# .git/hooks is not part of a clone, so a hook committed here does nothing until
# it is installed. This copies rather than symlinks: a symlink into the working
# tree would run whatever a branch happened to contain.
set -e
cd "$(dirname "$0")/.."
for hook in tools/hooks/*; do
    name=$(basename "$hook")
    cp "$hook" ".git/hooks/$name"
    chmod +x ".git/hooks/$name"
    echo "installed .git/hooks/$name"
done
echo
echo "pre-push runs tools/check-all.sh and refuses the push if it fails."
echo "Skip once, deliberately: git push --no-verify"
