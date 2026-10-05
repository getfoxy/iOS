#!/usr/bin/env python3
"""
page-hash.py — the number the phone shows, computed from the tree.

    python3 tools/page-hash.py               # the hash of Web/ as it is here
    python3 tools/page-hash.py --list        # the lines it is the hash of
    python3 tools/page-hash.py <commit>      # the hash of Web/ at a commit
    python3 tools/page-hash.py --dir <path>  # the hash of a built Foxy.app/Web

Foxy's menu drawer shows the first twelve characters of this number. If they
match what this prints at the commit you reviewed, the page running on that
phone is the page in this repository.

WHY THIS EXISTS

tools/verify-shipped.sh proves the three generated files regenerate byte for
byte from their sources at a commit, and tools/verify-vendor.py pins every
vendored byte. Both look at the repository. Between a commit and a phone sit a
build machine, a signing step and a delivery, and a page swapped anywhere along
that road looks exactly like the reviewed one from inside the app. This is the
link the chain was missing: the app hashes the files it actually staged and
shows the result, and this prints the same string from the tree.

THE RULE, WHICH THE APP FOLLOWS TOO

The set is every regular file directly in Web/ — the folder project.yml bundles
whole, and the folder FoxyWebView.stageWebFiles copies into the app's web
directory at launch. Not recursive: Web/ has no subdirectories, and if it ever
grows one this tool and the app would have to be changed together. Files whose
name begins with a dot are left out, because .DS_Store and friends are the
machine's, not the page's, and a Finder window should not change the number.
Nothing else is filtered: VENDOR.md is staged with the rest and so it is hashed
with the rest.

For each file, one line:

    <sha256 of its bytes><space><space><name>\n

sorted by name compared as bytes, and the manifest hash is the SHA-256 of those
lines joined. That is exactly what `shasum -a 256` prints for those files in
that order, so anyone can recompute the whole thing with shasum alone:

    ( cd Web && ls | grep -v '^\\.' | LC_ALL=C sort | tr '\\n' '\\0' \\
        | xargs -0 shasum -a 256 ) | shasum -a 256

The name is hashed alongside the content so that a file added, removed or
renamed changes the number even when no file's content changed. A digest over
the contents alone would not notice an extra script dropped into the folder.

WHAT IT DOES AND DOES NOT PROVE

It covers the page: every byte of HTML, JavaScript, font and image the web view
loads. It says nothing about the native binary around it — Tor, the bridge, the
keychain and the seed screens are compiled Swift, and no number on this screen
covers them. A phone whose page hash matches is running the reviewed page
inside a native app that is still taken on trust.

Needs python3. With a commit argument it needs git and reads that commit
through `git show`, so nothing uncommitted takes part. No network.
"""

import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The one place the rule is written as code. The app's Swift copy is
# FoxyWebView.manifestHash; smoke check 41 holds the two together.
WEB = 'Web'


def names_at_commit(commit):
    out = subprocess.run(['git', '-C', HERE, 'ls-tree', '--name-only', commit, WEB + '/'],
                         capture_output=True, text=True, check=True).stdout
    return [p.split('/', 1)[1] for p in out.split('\n') if p.startswith(WEB + '/') and '/' not in p.split('/', 1)[1]]


def lines(commit=None, folder=None):
    """The manifest lines, in order: one per staged file, shasum's own format."""
    if commit:
        names = names_at_commit(commit)
        read = lambda n: subprocess.run(['git', '-C', HERE, 'show', '%s:%s/%s' % (commit, WEB, n)],
                                        capture_output=True, check=True).stdout
    else:
        # a built Foxy.app/Web when one is named, so a build can record the page
        # it actually carries rather than the page the tree happened to hold
        d = folder or os.path.join(HERE, WEB)
        names = [n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n))]
        read = lambda n: open(os.path.join(d, n), 'rb').read()
    names = [n for n in names if not n.startswith('.')]
    # sorted by name as bytes, which is what the app's sort does
    names.sort(key=lambda n: n.encode('utf-8'))
    return ['%s  %s\n' % (hashlib.sha256(read(n)).hexdigest(), n) for n in names]


def page_hash(commit=None, folder=None):
    ls = lines(commit, folder)
    if not ls:
        # an empty folder must not produce a real-looking number
        return '', ls
    return hashlib.sha256(''.join(ls).encode('utf-8')).hexdigest(), ls


def main(argv):
    show_list = '--list' in argv
    folder = None
    if '--dir' in argv:
        folder = argv[argv.index('--dir') + 1]
        argv = [a for i, a in enumerate(argv) if i not in (argv.index('--dir'), argv.index('--dir') + 1)]
    rest = [a for a in argv if not a.startswith('--')]
    commit = rest[0] if rest else None
    if folder and not os.path.isdir(folder):
        print('no folder at %s' % folder)
        return 1
    digest, ls = page_hash(commit, folder)
    if not digest:
        print('no files in %s — nothing to hash' % (folder or WEB + '/'))
        return 1
    if show_list:
        sys.stdout.write(''.join(ls))
        print()
    print('%d files' % len(ls))
    print(digest)
    # the shape the app's log prints. DebugLog hides runs of 64 hex characters,
    # because in this app's logs that shape is a key or a seed; grouping keeps
    # the one number a person needs readable there, and printing the same
    # grouping here means the log line and this line can be compared as they are.
    print('in the log:            %s' % ' '.join(digest[i:i + 16] for i in range(0, len(digest), 16)))
    print('the menu drawer shows: %s' % digest[:12])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
