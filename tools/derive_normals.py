"""Normal maps for the level's solid surfaces - rock, bark, wood, concrete, metal -
derived from each texture's own shading, so they catch the sun at a grazing
angle instead of lying flat. Trespasser's textures were painted with their
relief already lit in, so the brightness is a fair height field once the broad
lighting gradients are taken out.

The alpha channel carries a roughness: crevices (darker than their
surroundings) are rough, raised faces a little smoother.

Only opaque textures on rock (T*), structure (S*) and vegetation (V*: trunks,
stumps, logs) models are done - cut-out leaves are left alone - and only where
there is relief worth having. Writes public/levels/<lvl>/nrm/<id>.png and
nrm.json (the list); the renderer loads them on desktop only.

    python3 tools/derive_normals.py [level ...]
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'levels')
MAX_SIZE = 256          # normal maps need less resolution than colour
MIN_RELIEF = 0.025      # std of the high-passed brightness below which a texture is left flat


def blur(a, radius):
    """Gaussian blur that wraps at the edges, as the texture tiles (via the FFT)."""
    h, w = a.shape
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(w)[None, :]
    k = np.exp(-2 * (np.pi * radius) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * k))


def derive(src):
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    scale = min(1.0, MAX_SIZE / max(w, h))
    if scale < 1:
        im = im.resize((max(4, round(w * scale)), max(4, round(h * scale))), Image.LANCZOS)
    rgb = np.asarray(im)[..., :3].astype(np.float32) / 255
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    size = max(lum.shape)
    # Height: brightness less its broad lighting, lightly smoothed against noise.
    high = lum - blur(lum, size / 12)
    relief = float(high.std())
    if relief < MIN_RELIEF:
        return None, relief
    height = blur(high, 0.6) / (relief * 4)
    fine = blur(high, 0.6) - blur(high, 3.0)
    height = height + fine / (relief * 4)       # a little extra crispness
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    strength = 2.2 * size / 256                 # similar slopes whatever the size
    # Image rows run down, texture v runs up: green points up the texture.
    n = np.dstack([-dx * strength, dy * strength, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    rough = np.clip(0.86 - np.clip(high / (relief * 3), -1, 1) * 0.14, 0, 1)
    out = np.dstack([n * 0.5 + 0.5, rough])
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA'), relief


def level(lv):
    base = os.path.join(ROOT, lv)
    info = json.load(open(os.path.join(base, 'level.json')))
    hd = {}
    if os.path.exists(os.path.join(base, 'hd.json')):
        hd = json.load(open(os.path.join(base, 'hd.json')))
    names = {}
    for inst in info['instances']:
        names.setdefault(inst['model'], inst['name'])
    wanted = set()
    for key, model in info['models'].items():
        n = names.get(key, '')
        if not n or n.startswith('TrnObj') or n[0].upper() not in 'TSV':
            continue
        for p in model['parts']:
            if p.get('texture'):
                wanted.add(p['texture'])
    os.makedirs(os.path.join(base, 'nrm'), exist_ok=True)
    done = []
    for t in sorted(wanted):
        tex = os.path.join(base, 'tex', f'{t}.png')
        alpha = np.asarray(Image.open(tex).convert('RGBA'))[..., 3]
        if (alpha < 128).mean() > 0.01:          # a cut-out: leaves, fronds, fences
            continue
        src = os.path.join(base, 'hd', f'{t}.png') if t in hd else tex
        img, relief = derive(src)
        if img is None:
            continue
        img.save(os.path.join(base, 'nrm', f'{t}.png'), optimize=True)
        done.append(t)
    json.dump(done, open(os.path.join(base, 'nrm.json'), 'w'))
    print(f'{lv}: {len(done)} normal maps of {len(wanted)} candidate textures')


if __name__ == '__main__':
    levels = sys.argv[1:] or sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, 'level.json')))
    for lv in levels:
        level(lv)
