#!/usr/bin/env python3
"""Convert one Trespasser level into files a browser can load directly.

    convert_level.py be            -> public/levels/be/{level.json, meshes.bin, tex/*.png}

Reads the level's .grf (objects, meshes, materials), .pid (texture directory) and
.spz (texture pixels). Formats are from the engine source (jp2_pc/Source/Lib/Groff,
Lib/Loader/ImageLoader) and cross-checked against LordOfDragons/tresgoesde.

Everything stays in Trespasser's own coordinates (metres, Z up); the viewer turns
the whole world to Y-up once.
"""
import json, math, os, struct, sys, zlib
from groff import Groff, expand_spz, read_value_table, properties
from terrain import Terrain

DATA = os.path.expanduser('~/Games/Trespasser/data')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'levels')

# ------------------------------------------------------------------------------------------
# Texture directory (.pid) and pixels (.spz)

class Textures:
    def __init__(self, level):
        pid = open(os.path.join(DATA, f'{level}-130.pid'), 'rb').read()
        (self.version, self.bump_bits, raster_off, raster_count,
         pal_off, pal_count, self.pageable, self.nonpageable) = struct.unpack_from('<8I', pid, 0)
        self.palettes = []
        off = pal_off
        for _ in range(pal_count):
            size, count, h = struct.unpack_from('<3I', pid, off)
            cols = [struct.unpack_from('<4B', pid, off + 12 + 4 * i) for i in range(count)]
            # CColour is stored B, G, R, flags.
            self.palettes.append([(c[2], c[1], c[0]) for c in cols])
            off += size
        self.entries = {}
        off = raster_off
        for _ in range(raster_count):
            # 56 bytes: the 64-bit hash is 8-aligned, so 4 bytes of padding precede it.
            f = struct.unpack_from('<6I4B3iII2I', pid, off)
            size, vmoff, w, h, stride, bits = f[:6]
            e = dict(vm=vmoff, w=w, h=h, stride=stride, bits=bits, const=(f[8], f[7], f[6]),
                     transparent=f[10], kind=f[11], occlusion=f[12], palette=f[13], id=f[15], mip=f[16])
            # Keep the largest mip level of each texture.
            prev = self.entries.get(e['id'])
            if prev is None or e['w'] * e['h'] > prev['w'] * prev['h']:
                self.entries[e['id']] = e
            off += size
        spz = open(os.path.join(DATA, f'{level}-130.spz'), 'rb').read()
        self.swp, _ = expand_spz(spz)

    @staticmethod
    def texture_id(name, diffuse=1.0):
        # CRC-32 of the lower-case name followed by the material's first four bytes
        # (its diffuse reflectance, 1.0 unless the level overrides it).
        key = name.lower().replace('\\', '/').encode('latin-1') + struct.pack('<f', diffuse)
        return zlib.crc32(key) & 0xFFFFFFFF

    def rgba(self, e):
        """The texture as bottom-up rows of RGBA, flipped to top-down."""
        w, h, stride = e['w'], e['h'], e['stride']
        pal = self.palettes[e['palette']] if e['palette'] != 0xFFFFFFFF and e['palette'] < len(self.palettes) else None
        out = bytearray(w * h * 4)
        for y in range(h):
            row = e['vm'] + y * stride
            dst = (h - 1 - y) * w * 4
            for x in range(w):
                if e['bits'] == 8:
                    v = self.swp[row + x]
                    r, g, b = pal[v] if pal and v < len(pal) else (v, v, v)
                    a = 0 if (e['transparent'] and v == 0) else 255
                else:
                    v = self.swp[row + 2 * x] | (self.swp[row + 2 * x + 1] << 8)
                    if e['kind'] in (1, 16) and pal:
                        # Bump maps: bits 10-15 index the palette; the rest are angles.
                        idx = (v >> 10) & 0x3F
                        r, g, b = pal[idx] if idx < len(pal) else (255, 0, 255)
                        a = 0 if (e['transparent'] and idx == 0) else 255
                    else:
                        r = ((v >> 11) & 31) * 255 // 31
                        g = ((v >> 5) & 63) * 255 // 63
                        b = (v & 31) * 255 // 31
                        a = 255
                out[dst + x * 4: dst + x * 4 + 4] = bytes((r, g, b, a))
        # Transparent pixels carry the palette's key colour (often magenta), which
        # texture filtering would blend into the edges. Give them the average visible
        # colour instead.
        opaque = [i for i in range(0, len(out), 4) if out[i + 3]]
        if opaque and len(opaque) * 4 < len(out):
            n = len(opaque)
            avg = bytes(sum(out[i + c] for i in opaque) // n for c in range(3))
            for i in range(0, len(out), 4):
                if not out[i + 3]:
                    out[i:i + 3] = avg
        return bytes(out)

def write_png(path, w, h, rgba):
    raw = b''.join(b'\x00' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

# ------------------------------------------------------------------------------------------
# Level geometry (.grf)

def read_material(g, h):
    """Texture names for each sub-material of a material section."""
    if h not in g.by_handle:
        return []
    d = g.by_handle[h][2]
    n = struct.unpack_from('<I', d, 0)[0]
    words = struct.unpack_from('<%dI' % (1 + 6 * n), d, 0)
    tex = words[1:1 + n]
    bump = words[1 + 2 * n:1 + 3 * n]
    colours = list(zip(words[1 + 3 * n:1 + 4 * n], words[1 + 4 * n:1 + 5 * n], words[1 + 5 * n:1 + 6 * n]))
    return [(g.symbols.get(t, ''), g.symbols.get(b, ''), colours[i]) for i, (t, b) in enumerate(zip(tex, bump))]

def read_mesh(g, h):
    """An optimised mesh heap (GroffIO.cpp bGroffLoadMeshHeap) as triangles grouped by surface."""
    d = g.by_handle[h][2]
    seh_material, need_default, default_col = struct.unpack_from('<3I', d, 0)
    pivot = struct.unpack_from('<3f', d, 12)
    npts, nverts, nvptrs, nwrap, npolys = struct.unpack_from('<5I', d, 24)
    off = 44
    if off + npts * 12 + nverts * 32 + nvptrs * 4 + npolys * 40 + nwrap * 12 != len(d):
        return None
    pts = [struct.unpack_from('<3f', d, off + 12 * i) for i in range(npts)]; off += npts * 12
    verts = []
    for i in range(nverts):
        p, nx, ny, nz, u, v = struct.unpack_from('<I5f', d, off + 32 * i)
        verts.append((p, (nx, ny, nz), (u, v)))
    off += nverts * 32
    vptrs = struct.unpack_from('<%dI' % nvptrs, d, off); off += nvptrs * 4
    groups = {}
    for i in range(npolys):
        length, first, px, py, pz, pd, surf, flags, _m, _a = struct.unpack_from('<2I4f2I2I', d, off + 40 * i)
        if flags & 1:
            continue   # occlusion-only polygon
        idx = [vptrs[first + k] for k in range(length)]
        tri = groups.setdefault(surf, [])
        for k in range(1, length - 1):   # fan
            tri.append((idx[0], idx[k], idx[k + 1]))
    return dict(material=seh_material, pts=pts, verts=verts, groups=groups,
                default=default_col if need_default else None, pivot=pivot)

def euler_matrix(rx, ry, rz):
    """Engine rotation v * Rx * Ry * Rz (row vectors) as a column-major 3x3."""
    def rot(axis, a):
        c, s = math.cos(a), math.sin(a)
        if axis == 0: return [[1, 0, 0], [0, c, -s], [0, s, c]]
        if axis == 1: return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    def mul(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mul(rot(2, rz), mul(rot(1, ry), rot(0, rx)))

def convert(level):
    out = os.path.join(OUT, level)
    os.makedirs(os.path.join(out, 'tex'), exist_ok=True)
    g = Groff(open(os.path.join(DATA, f'{level}.grf' if os.path.exists(os.path.join(DATA, f'{level}.grf')) else f'{level}.GRF'), 'rb').read())
    tx = Textures(level)
    print(f'{level}: {len(g.by_handle)} sections, {len(tx.entries)} textures in the pack')

    reg = g.sections['.region'][0][2]
    count = struct.unpack_from('<I', reg, 0)[0]
    models, instances, used_tex = {}, [], {}
    player_start = None
    values = read_value_table(g)
    # Objects that exist for game logic only are never drawn.
    LOGIC = {'AI Command', 'CLocationTrigger', 'CMagnet', 'CStartTrigger', 'Player Settings', 'CObjectTrigger',
             'Teleport', 'CTimerTrigger', 'CCollisionTrigger', 'TerrainPlacement', 'CMuzzleFlash', 'CParticles'}
    blob = bytearray()
    missing = 0
    for i in range(count):
        seh_obj, name_h, px, py, pz, rx, ry, rz, scale, attr, _one = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        name = g.symbols.get(name_h, '')
        props = properties(values, attr)
        props = props if isinstance(props, dict) else {}
        klass = props.get('Class')
        if name == 'Anne':
            player_start = dict(pos=[px, py, pz], heading=rz)
        if seh_obj not in g.by_handle:
            continue
        obj = g.by_handle[seh_obj][2]
        _oname, seh_geo, seh_map = struct.unpack_from('<3I', obj, 0)
        if seh_geo not in g.by_handle:
            continue
        if klass in LOGIC or props.get('Visible') is False:
            continue
        diffuse = props.get('Diffuse', 1.0)
        model_key = (seh_geo, diffuse)
        if model_key not in models:
            mesh = read_mesh(g, seh_geo)
            if mesh is None:
                models[model_key] = None
                continue
            mat = read_material(g, mesh['material'])
            parts = []
            for surf, tris in mesh['groups'].items():
                tex_id = None
                if surf < len(mat) and mat[surf][0]:
                    tid = Textures.texture_id(mat[surf][0] + mat[surf][1], diffuse)
                    if tid not in tx.entries:
                        tid = Textures.texture_id(mat[surf][0] + mat[surf][1])
                    if tid in tx.entries:
                        tex_id = tid
                        used_tex[tid] = mat[surf][0]
                    else:
                        missing += 1
                colour = mat[surf][2] if surf < len(mat) else (200, 200, 200)
                # De-index into flat arrays (positions, normals, uvs) for this surface.
                pos, nrm, uv = [], [], []
                for tri in tris:
                    for vi in tri:
                        p, n, t = mesh['verts'][vi]
                        pos += mesh['pts'][p]; nrm += n; uv += t
                start = len(blob)
                blob += struct.pack('<%df' % len(pos), *pos)
                blob += struct.pack('<%df' % len(nrm), *nrm)
                blob += struct.pack('<%df' % len(uv), *uv)
                parts.append(dict(offset=start, count=len(pos) // 3, texture=('%08x' % tex_id) if tex_id is not None else None,
                                  colour=colour))
            models[model_key] = dict(parts=parts)
        if models.get(model_key):
            m = euler_matrix(rx, ry, rz)
            keep = {k: v for k, v in props.items() if isinstance(v, (bool, int, float, str))}
            instances.append(dict(name=name, model='%x_%g' % model_key, pos=[px, py, pz], rot=m, scale=scale,
                                  cls=klass, props=keep))

    print(f'  {len(instances)} placed objects, {sum(1 for m in models.values() if m)} meshes, '
          f'{len(used_tex)} textures used, {missing} surface textures not found')
    for tid, name in used_tex.items():
        e = tx.entries[tid]
        path = os.path.join(out, 'tex', '%08x.png' % tid)
        if True:
            write_png(path, e['w'], e['h'], tx.rgba(e))
    open(os.path.join(out, 'meshes.bin'), 'wb').write(blob)

    # Terrain: world-space vertices (float32 xyz) then triangles (uint32).
    terrain_info = None
    wtd = os.path.join(DATA, f'{level}.wtd')
    if os.path.exists(wtd):
        ter = Terrain(open(wtd, 'rb').read())
        pos, tris = ter.mesh()
        tb = struct.pack('<%df' % (3 * len(pos)), *[c for p in pos for c in p])
        tb += struct.pack('<%dI' % (3 * len(tris)), *[i for tri in tris for i in tri])
        open(os.path.join(out, 'terrain.bin'), 'wb').write(tb)
        terrain_info = dict(vertices=len(pos), triangles=len(tris))
        print(f'  terrain: {len(pos)} vertices, {len(tris)} triangles')

    level_json = dict(level=level, start=player_start, terrain=terrain_info,
                      models={'%x_%g' % k: v for k, v in models.items() if v}, instances=instances)
    json.dump(level_json, open(os.path.join(out, 'level.json'), 'w'))
    print(f'  wrote {out} ({len(blob) // 1024} KB of geometry)')

if __name__ == '__main__':
    convert(sys.argv[1] if len(sys.argv) > 1 else 'be')
