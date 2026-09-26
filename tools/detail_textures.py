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

# Per-material terrain detail, packed in one RGBA texture so the terrain shader
# samples it once per projection: R bare soil, G sand, B grass, A rock. Each is
# mid-grey on average (it multiplies the baked colour). Rock also gets its own
# normal map, laid triplanar on cliffs.
def norm(a):
    a = a - a.mean()
    return np.clip(0.5 + a / (a.std() * 4.0 + 1e-6) * 0.5, 0, 1)

def tile_voronoi(n, cells):
    """F1 and F2 distances to a jittered point per cell, wrapping at the edges."""
    pts = (np.stack(np.mgrid[0:cells, 0:cells], -1) + rng.random((cells, cells, 2))) / cells
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n
    f1 = np.full((n, n), 9.0); f2 = np.full((n, n), 9.0)
    for p in pts.reshape(-1, 2):
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                d = np.hypot(y - p[0] - oy, x - p[1] - ox)
                f2 = np.where(d < f1, f1, np.minimum(f2, d)); f1 = np.minimum(f1, d)
    return f1, f2

soil = norm(fbm(N, octaves=7, base=8, persistence=0.62) + rng.random((N, N)) * 0.12)

sand = norm(rng.random((N, N)) * 0.5 + np.roll(rng.random((N, N)), 1, 0) * 0.3 + fbm(N, octaves=4, base=4) * 0.6)

# Grass seen from above: a clumpy field of short strokes, lighter at the tips.
acc = np.zeros((N, N))
clump = fbm(N, octaves=4, base=6)
for _ in range(60000):
    y0, x0 = rng.integers(0, N, 2)
    if rng.random() > clump[y0, x0] * 1.4: continue
    a = rng.random() * np.pi * 2; ln = rng.integers(4, 11)
    for t in range(ln):
        acc[int(y0 + np.sin(a) * t) % N, int(x0 + np.cos(a) * t) % N] += 0.4 + 0.6 * t / ln
grass = norm(np.minimum(acc, 3.0) * 0.8 + clump * 1.5)

# Rock: ridged fractal weathering broken by thin fractures at two scales.
ridged = 1 - np.abs(fbm(N, octaves=7, base=4, persistence=0.6) * 2 - 1)
crack = np.zeros((N, N))
for cells, w in ((5, 0.6), (13, 0.4)):
    f1, f2 = tile_voronoi(N, cells)
    e = (f2 - f1) * cells
    crack += w * np.clip(e / 0.08, 0, 1) ** 0.7        # 0 in the fracture, 1 on the face
rh = ridged * 0.9 + fbm(N, octaves=5, base=12, persistence=0.5) * 0.4 + crack * 0.35 + rng.random((N, N)) * 0.05
rock = norm(rh - crack * 0.2)            # the fractures read in the normals more than the colour
Image.fromarray((np.dstack([soil, sand, grass, rock]) * 255).astype(np.uint8), 'RGBA').save('public/detail/terrain_d.png')
normal_map(rh - crack * 0.2, 9.0).save('public/detail/rock_n.png')
print('wrote public/detail/{terrain_d,rock_n}.png')
