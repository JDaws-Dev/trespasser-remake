#!/usr/bin/env python3
"""Install an AI-upscaled texture as the HD version of an original.

    install_hd.py <level> <texture id> <upscaled png> [--tile]

Verifies the upscale still lines up with the original (UV maps must not move),
resizes to a power of two, blends the borders for tiling textures, keeps the
original's alpha (cut-outs), and records it in public/levels/<level>/hd.json.
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

def main():
    level, tid, src = sys.argv[1], sys.argv[2], sys.argv[3]
    tile = '--tile' in sys.argv
    padded = '--padded' in sys.argv   # made square by hd_prep.py; the original is the top-left
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'levels', level)
    orig = Image.open(os.path.join(base, 'tex', tid + '.png')).convert('RGBA')
    up = Image.open(src).convert('RGB')
    ow, oh = orig.size
    if padded:
        s = max(ow, oh)
        up = up.crop((0, 0, round(up.width * ow / s), round(up.height * oh / s)))
    # Keep the original's aspect and up to 4x its size, on powers of two.
    scale = min(4, max(1, up.width // ow))
    w, h = ow * scale, oh * scale
    up = up.resize((w, h), Image.LANCZOS)

    # Alignment check against the original (luminance correlation at 1:1). Both are
    # blurred by one texel first: new sub-texel detail (grass blades, grit) is the
    # point of the upscale, and only a shifted or redrawn layout should fail.
    soft = ImageFilter.GaussianBlur(1)
    a = np.asarray(orig.convert('L').resize((ow, oh)).filter(soft), float)
    b = np.asarray(up.convert('L').resize((ow, oh), Image.LANCZOS).filter(soft), float)
    a -= a.mean(); b -= b.mean()
    corr = float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum() + 1e-9))
    if corr < 0.85:
        print(f'REJECTED {tid}: correlation with original only {corr:.3f}')
        return 1

    arr = np.asarray(up, float)
    if tile:
        # Cross-fade a margin so left/right and top/bottom continue seamlessly.
        m = max(4, w // 32)
        for i in range(m):
            t = (i + 0.5) / m * 0.5   # 0 at the edge, 0.5 at the margin's inner side
            arr[:, i] = arr[:, i] * (0.5 + t) + arr[:, w - 1 - i] * (0.5 - t)
            arr[:, w - 1 - i] = arr[:, w - 1 - i] * (0.5 + t) + arr[:, i] * (0.5 - t)
        for i in range(m):
            t = (i + 0.5) / m * 0.5
            arr[i, :] = arr[i, :] * (0.5 + t) + arr[h - 1 - i, :] * (0.5 - t)
            arr[h - 1 - i, :] = arr[h - 1 - i, :] * (0.5 + t) + arr[i, :] * (0.5 - t)
    out = Image.fromarray(arr.clip(0, 255).astype('uint8'), 'RGB').convert('RGBA')
    # The original's alpha, upscaled with nearest so cut-outs stay crisp.
    alpha = orig.split()[3].resize((w, h), Image.NEAREST)
    out.putalpha(alpha)

    os.makedirs(os.path.join(base, 'hd'), exist_ok=True)
    out.save(os.path.join(base, 'hd', tid + '.png'), optimize=True)
    manifest_path = os.path.join(base, 'hd.json')
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    manifest[tid] = dict(size=[w, h], corr=round(corr, 3), tile=tile)
    json.dump(manifest, open(manifest_path, 'w'), indent=0)
    print(f'installed {tid}: {ow}x{oh} -> {w}x{h}, correlation {corr:.3f}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
