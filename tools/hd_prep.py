#!/usr/bin/env python3
"""Pad a non-square texture to a square (mirroring it) so the image model keeps
its layout, writing /tmp/hd_prep/<id>.png. install_hd.py --padded crops it back."""
import os, sys
from PIL import Image, ImageOps
level, tid = sys.argv[1], sys.argv[2]
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'levels', level, 'tex')
im = Image.open(os.path.join(base, tid + '.png')).convert('RGB')
w, h = im.size
s = max(w, h)
out = Image.new('RGB', (s, s))
# The original sits at the top-left; mirrored copies fill the rest so nothing looks cut off.
x = 0
while x < s:
    y = 0
    flip_x = (x // w) % 2 == 1
    while y < s:
        tile = im
        if flip_x: tile = ImageOps.mirror(tile)
        if (y // h) % 2 == 1: tile = ImageOps.flip(tile)
        out.paste(tile, (x, y))
        y += h
    x += w
os.makedirs('/tmp/hd_prep', exist_ok=True)
out.save(f'/tmp/hd_prep/{tid}.png')
print(f'/tmp/hd_prep/{tid}.png {w}x{h} -> {s}x{s}')
