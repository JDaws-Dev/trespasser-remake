"""Procedural, tileable detail textures for the renderer: a fine grain that is
multiplied over the terrain up close (with its normal map), and a water
normal map for the animated sea. Written once to public/detail/."""
import numpy as np
from PIL import Image

N = 512
rng = np.random.default_rng(7)

def fbm(n, octaves=6, base=4, persistence=0.55):
    """Tileable fractal noise in [0,1] from summed periodic value-noise layers."""
    out = np.zeros((n, n))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = base * 2 ** o
        grid = rng.random((cells, cells))
        # Bilinear upsample with wrap-around so the tile repeats seamlessly.
        ys = np.linspace(0, cells, n, endpoint=False)
        y0 = np.floor(ys).astype(int); fy = (ys - y0)[:, None]; fy = fy * fy * (3 - 2 * fy)
        x0 = y0; fx = fy.T
        g = lambda a, b: grid[a % cells][:, b % cells]
        v = (g(y0, x0) * (1 - fy) + g(y0 + 1, x0) * fy) * (1 - fx) + (g(y0, x0 + 1) * (1 - fy) + g(y0 + 1, x0 + 1) * fy) * fx
        out += v * amp; total += amp; amp *= persistence
    return out / total

def normal_map(height, strength):
    dx = np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)
    dy = np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)
    n = np.dstack([-dx * strength, -dy * strength, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8), 'RGB')

# Terrain grain: mid-grey on average so it only modulates the baked colour.
h = fbm(N, octaves=7, base=8, persistence=0.6)
speck = rng.random((N, N)) * 0.08
grain = np.clip(0.5 + (h - h.mean()) * 1.1 + speck - 0.04, 0, 1)
Image.fromarray((grain * 255).astype(np.uint8), 'L').save('public/detail/grain.png')
normal_map(h + speck * 0.5, 6.0).save('public/detail/grain_n.png')

# Water: a few crossing wave trains plus ripples, as a normal map.
y, x = np.mgrid[0:N, 0:N] / N * 2 * np.pi
w = (np.sin(3 * x + 2 * y) + 0.7 * np.sin(5 * x - 4 * y + 1.0) + 0.5 * np.sin(-2 * x + 7 * y + 2.0)) / 2.2
w += (fbm(N, octaves=5, base=6) - 0.5) * 1.5
normal_map(w, 2.5).save('public/detail/water_n.png')
print('wrote public/detail/{grain,grain_n,water_n}.png')
