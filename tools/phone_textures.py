"""Half-resolution copies of a level's textures for phones (tex_m/), so the
level fits in iOS Safari's GPU memory. Textures of 64 px or less are copied as is."""
import os, sys
from PIL import Image

lvl = sys.argv[1]
src = f'public/levels/{lvl}/tex'
dst = f'public/levels/{lvl}/tex_m'
os.makedirs(dst, exist_ok=True)
n = 0
for f in os.listdir(src):
    im = Image.open(os.path.join(src, f))
    if max(im.size) > 64:
        im = im.resize((max(1, im.width // 2), max(1, im.height // 2)), Image.LANCZOS)
    im.save(os.path.join(dst, f), optimize=True)
    n += 1
print(f'{lvl}: {n} phone textures')
