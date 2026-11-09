# Card designs

A card's face is named by a design code of three digits. It is one code in three places: the shop lists a design by it, the card is
encoded with it (the chip's record carries the three characters after the mint, card software 1.10 and on), and the app draws the
face from it. Whatever code a design is added under, that is the code on the chip and the code in the app.

## The table

| Code | Name | Artwork | Since |
| --- | --- | --- | --- |
| 001 | Foxy, first design | `Web/img/card-fx1.png` (the face) and `Web/img/card-fx1-portrait.jpg` (standing up); CSS block `[data-card-design="001"]` in `build/markup.html` | card software 1.10, the first that writes a design |
| 002 | Beaker, first design | drawn in CSS and SVG, animated: the `[data-card-design="002"]` block in `build/markup.html` (and `FC_EL1_FACE`) | card software 1.10 |

`FL1`, the first Flash design (black, a bolt in a circle), is no shop design and has no digit code. It is what the app draws for a card
that names no design, or one it cannot draw (`FC_DESIGN`).

## Aliases

Cards encoded before the digit codes name their design as `FX1` or `EL1`. The app reads them as 001 and 002 (`FC_DESIGN_ALIASES` in
`build/app/26f-flashcard.js`), so such a card is drawn as it always was and its chip is never rewritten. No new design is given a
letter code, and the aliases are not extended.

## How the app reads a code

`fcDesignOf` takes what the chip answered, reads an alias as its digits, and returns the code only if `FC_DESIGNS` holds it; any other
answer (`ZZZ`, `999`, nothing) is drawn as `FC_DESIGN`. A phone sets up the cards it sets up in `FC_SETUP_DESIGN`, which is `001`, and
a card that already names a design keeps it through set-up.

## Adding a design

1. One row in the table above, with the next free code.
2. One artwork: the face as a picture under `Web/img/`, or drawn in CSS in `build/markup.html` under `[data-card-design="NNN"]`.
3. One row in `FC_DESIGNS` in `build/app/26f-flashcard.js`, keyed by the code, and a test line for it in `tests/flashcard-screens.js`.
4. One line in the shop's `products.json`, listing the product by the same code.
5. Encode the cards with the same code: `DESIGN=NNN` is the only form the encoder takes, and its manifest and print folders are keyed by it.
