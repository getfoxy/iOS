# build/

Artifacts for the unpack / pack cycle. `Web/index.html` is still what ships and
what Xcode stages; these exist so the app can be read and diffed.

    python3 tools/unpack-index.py     index.html  ->  foxy-app.js + markup.html
    python3 tools/pack-index.py       those       ->  index.html

`foxy-app.js` and `markup.html` live here rather than in `Web/` because
project.yml bundles all of `Web/` into the app. A copy there shipped to the
phone — about 900 KB nothing loads, since pack has already baked the class into
index.html — and left two copies of the app logic in one bundle.

`markup.html` is the screens, with `<!--FOXY_APP_SCRIPT-->` marking where the
app class goes back in. `shell/` is everything else in index.html, as source:

    shell/head.html       the page policy, the loader and the bundler's data blocks;
                          pack fills in the manifest and the loader's hash
    shell/manifest.json   the nine embedded assets, in order, each naming its file
                          (the renderer, `build/foxy-render.js`, is the one outside assets/)
    shell/assets/         React, ReactDOM, two icons and four fonts
    shell/page.json       the app script's tag, its marker, the page's last line

Edit those, not index.html. Pack makes the same page from the same files every
time, and `tools/verify-shipped.sh` checks that from a clean export of a commit:

    sh tools/verify-shipped.sh

To change the page, edit the parts: `build/app/*.js` for the app class,
`build/wallet/*.js` for the wallet, `build/markup.html` for the screens,
`build/shell/` for the head and assets. Then run `python3 tools/pack-index.py`,
which joins the parts (`tools/join-sources.py`) into `build/foxy-app.js` and
`Web/foxy-wallet.js` and writes index.html. Never edit a joined file.

`pack-index.py` writes those files, running `join-sources.py` for the joined
files and for the part tables `build/app/README.md` and `build/wallet/README.md`
that it generates; `unpack-index.py` writes `foxy-app.js` and `markup.html` back
out of a page. The checks write nothing:

    python3 tools/join-sources.py --check   the joined files and both part READMEs match their parts
    python3 tools/smoke.py                  check 1 packs into a temporary folder and compares
                                            index.html, the joined files and the READMEs with the tree

So `sh tools/check-all.sh` fails, rather than repacking, when a part was edited
and pack was not run.

A re-export from Design would overwrite index.html. Unpack still takes the app
class and the markup back out of it, but no longer writes a shell: copy any
change to the head or the assets into `shell/` by hand.

## Where a screen's bindings come from

`foxy-render.js` compiles the template in `markup.html` and, on every render,
calls the app's `renderVals()`: every `{{ binding }}` in the markup is a key of
what it returns. `app/21-render-values.js` gathers them. `renderValsBase()`
spreads one function per screen, `renderContext()` holds what more than one of
them reads, and `renderVals()` adds the home menu on top.

    22-render-shell-and-dialogs.js     renderShell, renderNote
    23-render-home-and-amount.js       renderHome, renderAmount
    24-render-receive-and-send.js      renderReceive, renderPaid, renderSend,
                                       renderSent, renderToken
    25-render-confirm-and-blocked.js   renderConfirmShell, renderBlocked
    26-render-history-and-contacts.js  renderHistory, renderTxDetail, renderContacts
    27-render-mints-restore-backup.js  renderMints, renderNewMint, renderRestore,
                                       renderBackup

A scanned payment request (`reqOffer`) has no render function of its own: it
goes through the confirmation shell, filled in by `requestSpec()`. The
split-bill screens are `splitVals()` in `app/20-split-values.js`. A key
belongs to the function of the screen whose markup binds it, and no key is
defined twice. The cards, the PIN pad and the seed screens are not template
screens: they are plain DOM, built by `blockedCard`, `pinOverlay`, `showSeed`
and the rest (`app/README.md` says which part holds each).

`tests/render-snapshots.js` records what every screen, card and dialog draws,
byte for byte, and `tests/types/tsconfig.app.json` type-checks the app class and
these functions.
