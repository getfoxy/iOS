#!/usr/bin/env python3
"""Draw Foxy's card standing up: Web/img/card-fx1-portrait.jpg, from Web/img/card-fx1.png.

    python3 tools/make-card-portrait.py Web/img/card-fx1.png Web/img/card-fx1-portrait.jpg

The card screen and the tap sheets show the card upright, 54 by 85.6 (build/markup.html, `data-card-portrait`;
build/app/26h-tap-screen.js). FX1, Foxy's own design, was drawn lying down. This lays its parts out again standing up,
every one of them taken from that picture and nothing from anywhere else: its fur, from the part of the picture that
has nothing on it, for the ground; the thin frame round the edge, drawn again at the new size; the chip at the top
left; the fox in its dark circle, in the middle; and the bitcoin sign and BEARER at the bottom right, their dark ink
alone, with the fur under them left behind. 1080 by 1712 (54:85.6), as a JPEG: the screen rounds the corners itself.

Needs Pillow. The output is checked in; this is how it was made, so that it can be made again.
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

src = Image.open(sys.argv[1]).convert('RGBA')
out = sys.argv[2]
W, H = 1080, 1712

# the fur: the right-hand part of the landscape picture, inside its frame, where there is nothing on it
card = src.crop((1465, 75, 1465 + 505, 75 + 800)).convert('RGB').resize((W, H), Image.LANCZOS).convert('RGBA')

# the thin frame that runs round the picture's edge, as on the landscape card
frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
inset = 46
ImageDraw.Draw(frame).rounded_rectangle((inset, inset, W - 1 - inset, H - 1 - inset), radius=44, outline=(70, 26, 8, 105), width=4)
card = Image.alpha_composite(card, frame)

# the chip, at the top left, its own rounded corners and none of the fur round it
chip = src.crop((161, 161, 433, 375))
cm = Image.new('L', chip.size, 0)
ImageDraw.Draw(cm).rounded_rectangle((4, 4, chip.size[0] - 5, chip.size[1] - 5), radius=44, fill=255)
chip.putalpha(cm.filter(ImageFilter.GaussianBlur(1)))
cw = 210
chip = chip.resize((cw, round(chip.size[1] * cw / chip.size[0])), Image.LANCZOS)
card.alpha_composite(chip, (122, 122))

# the fox in its dark circle, in the middle, with the shadow the landscape picture gives it
cx, cy, r = 1040, 655, 378
circ = src.crop((cx - r, cy - r, cx + r, cy + r))
mask = Image.new('L', circ.size, 0)
ImageDraw.Draw(mask).ellipse((2, 2, circ.size[0] - 3, circ.size[1] - 3), fill=255)
circ.putalpha(mask.filter(ImageFilter.GaussianBlur(1.2)))
D, Y = 640, 780
circ = circ.resize((D, D), Image.LANCZOS)
sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(sh).ellipse(((W - D) // 2, Y - D // 2 + 14, (W + D) // 2, Y + D // 2 + 14), fill=(60, 18, 4, 90))
card = Image.alpha_composite(card, sh.filter(ImageFilter.GaussianBlur(18)))
card.alpha_composite(circ, ((W - D) // 2, Y - D // 2))

# the bitcoin sign and BEARER, at the bottom right: the lettering alone, its dark ink, the fur under it left out
b = src.crop((1590, 925, 1935, 1205))
b.putalpha(b.convert('L').point(lambda v: 255 if v < 70 else (0 if v > 120 else int((120 - v) * 255 / 50))))
bw = 380
b = b.resize((bw, round(b.size[1] * bw / b.size[0])), Image.LANCZOS)
card.alpha_composite(b, (W - bw - 70, H - b.size[1] - 70))

card.convert('RGB').save(out, quality=86, optimize=True, progressive=True)
print(out)
