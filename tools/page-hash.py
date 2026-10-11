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

The set is every regular file under Web/, at any depth — the folder project.yml
bundles whole, and the folder FoxyWebView.stageWebFiles copies, subfolders and
all, into the app's web directory at launch. A file is named by its path from
Web/, with a slash between the parts: index.html, img/card-fx1.png. A file whose
name begins with a dot is left out, and so is everything inside a folder whose
name does, because .DS_Store and friends are the machine's, not the page's, and
a Finder window should not change the number. Nothing else is filtered:
VENDOR.md is staged with the rest and so it is hashed with the rest.

Anything that is neither a regular file nor a folder — a symbolic link, a
submodule — gets no number at all. The web view would follow a link, and a
number that covered less than the page loads would be worse than none.

For each file, one line:

    <sha256 of its bytes><space><space><path from Web/>\n

sorted by that path compared as bytes, and the manifest hash is the SHA-256 of
those lines joined. That is exactly what `shasum -a 256` prints for those files
in that order, so anyone can recompute the whole thing with shasum alone:

    ( cd Web && find . -type f -not -path '*/.*' | sed 's|^\\./||' | LC_ALL=C sort \\
        | tr '\\n' '\\0' | xargs -0 shasum -a 256 ) | shasum -a 256

A tree with no subfolders gives the number it gave when the rule looked only at
the top of Web/: the lines are the same lines.

The name is hashed alongside the content so that a file added, removed or
renamed changes the number even when no file's content changed. A digest over
the contents alone would not notice an extra script dropped into the folder.

WHAT IT DOES AND DOES NOT PROVE

It covers the page: every byte of HTML, JavaScript, font and image the web view
loads. It says nothing about the native binary around it — Tor, the bridge, the
keychain and the seed screens are compiled Swift, and no number on this screen
covers them. A phone whose page hash matches is running the reviewed page
inside a native app that is still taken on trust.

Needs python3. With a commit argument it needs git and reads that commit's
tree, each file by its object id, so nothing uncommitted takes part and the
number does not depend on how the commit was spelled. No network.
"""

import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The one place the rule is written as code. The app's Swift copy is
# FoxyWebView.manifestHash; smoke check 41 holds the two together, and each is
# run over the same small folder with one number expected of both (smoke 41
# here, FoxyTests/PageHashTests there).
WEB = 'Web'


class NoNumber(Exception):
    """Something under Web/ the rule cannot cover: say so instead of hashing less."""


def hidden(path):
    return any(part.startswith('.') for part in path.split('/'))


def files_at_commit(commit):
    """{path from Web/: bytes} for every regular file under Web/ at a commit."""
    git = lambda *a: subprocess.run(('git', '-C', HERE) + a, capture_output=True, check=True).stdout
    found = {}
    # -r walks the folders and lists only what is in them; -z keeps a path with
    # odd characters as it is instead of quoted
    for entry in git('ls-tree', '-r', '-z', commit, '--', WEB + '/').split(b'\0'):
        if not entry:
            continue
        meta, path = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        path = path.decode('utf-8')[len(WEB) + 1:]
        if hidden(path):
            continue
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise NoNumber('%s/%s is not a regular file at %s' % (WEB, path, commit))
        # by object id, not by "<commit>:<path>": the bytes are the file's and
        # nothing about the way the commit was named can reach them
        found[path] = git('cat-file', 'blob', oid)
    return found


def files_in_folder(d):
    """{path from the folder: bytes} for every regular file under it."""
    found = {}
    for here, folders, names in os.walk(d):
        rel = os.path.relpath(here, d).replace(os.sep, '/')
        rel = '' if rel == '.' else rel + '/'
        # os.walk lists a link to a folder among the folders and does not enter it
        for n in folders + names:
            full = os.path.join(here, n)
            if n.startswith('.'):
                continue
            if os.path.islink(full) or not (os.path.isdir(full) or os.path.isfile(full)):
                raise NoNumber('%s%s is neither a regular file nor a folder' % (rel, n))
        folders[:] = [f for f in folders if not f.startswith('.')]
        for n in names:
            if not n.startswith('.'):
                found[rel + n] = open(os.path.join(here, n), 'rb').read()
    return found


def lines(commit=None, folder=None):
    """The manifest lines, in order: one per staged file, shasum's own format."""
    if commit:
        files = files_at_commit(commit)
    else:
        # a built Foxy.app/Web when one is named, so a build can record the page
        # it actually carries rather than the page the tree happened to hold
        files = files_in_folder(folder or os.path.join(HERE, WEB))
    # sorted by path as bytes, which is what the app's sort does
    return ['%s  %s\n' % (hashlib.sha256(files[n]).hexdigest(), n)
            for n in sorted(files, key=lambda n: n.encode('utf-8'))]


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
    try:
        digest, ls = page_hash(commit, folder)
    except NoNumber as e:
        print('no number: %s' % e)
        return 1
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
