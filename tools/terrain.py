"""Decode a Trespasser terrain (.wtd): a wavelet-transformed height field stored as
a zerotree-coded quadtree.

Ported from LordOfDragons/tresgoesde (converter/terrain/*.ds), itself translated
from the original WaveletQuadTree code. Produces the terrain as a triangle mesh in
world coordinates (metres, Z up).
"""
import struct

def _log2(v):
    """Index of the highest set bit (0 for 0), as the original's u4Log2."""
    return v.bit_length() - 1 if v > 0 else 0

def _lift(v): return (v + 4) >> 3
def _unlift(v): return v << 3
def _predict(v): return (v + 1) >> 1

def _coeff(v):
    """Sign-folded integer: the low bit is the sign."""
    mag = v >> 1
    return -mag if v & 1 else mag

class BitReader:
    """Bits are read from 32-bit little-endian words, most significant bit first."""
    def __init__(self, data):
        self.d = data
        self.pos = 0

    def read(self, n):
        out = 0
        while n > 0:
            byte = (self.pos // 32) * 4 + 3 - (self.pos % 32) // 8
            bit = self.pos % 8
            ready = 8 - bit
            v = self.d[byte] if byte < len(self.d) else 0
            take = min(ready, n)
            out = (out << take) | ((v >> (ready - take)) & (0xFF >> (8 - take)))
            n -= take
            self.pos += take
        return out

class Vertex:
    __slots__ = ('x', 'y', 'root', 'scaling', 'wavelet')

    def __init__(self, x, y, v1=None, v2=None):
        self.x, self.y = x, y
        self.wavelet = 0
        if v1 is None:
            self.root = 0
            self.scaling = [0]
        else:
            self.root = max(v1.root, v2.root) + 1
            self.scaling = [-_unlift(_predict(v1.get(self.root) + v2.get(self.root)))]

    def _index(self, level):
        i = level - self.root
        assert i >= 0
        while len(self.scaling) <= i:
            self.scaling.append(_unlift(_lift(self.scaling[-1])))
        return i

    def get(self, level=None):
        if level is None:
            return -_lift(self.scaling[-1])
        return -_lift(self.scaling[self._index(level)])

    def set(self, level, value):
        self.scaling[self._index(level)] = -_unlift(value)

    def set_root(self, v1, v2):
        predict = _predict(v1.get(self.root) + v2.get(self.root))
        old = self.scaling[0]
        new = -_unlift(predict + self.wavelet)
        self.scaling[0] = new
        diff = new - old
        if diff:
            for i in range(1, len(self.scaling)):
                self.scaling[i] += diff

    def add(self, level, value):
        i = self._index(level)
        old = self.scaling[i]
        new = old + value
        self.scaling[i] = new
        diff = _unlift(_lift(new) - _lift(old))
        if diff:
            for k in range(i + 1, len(self.scaling)):
                self.scaling[k] += diff

class Node:
    __slots__ = ('x1', 'y1', 'x2', 'y2', 'flip', 'verts', 'children', 'parent',
                 'bits', 'maxc', 'coeff', 'minx', 'maxx', 'miny', 'maxy')

    def __init__(self, t, x1, y1, x2, y2, flip):
        self.x1, self.y1, self.x2, self.y2, self.flip = x1, y1, x2, y2, flip
        self.verts, self.children, self.parent = [], [], None
        self.bits = self.maxc = 0
        self.coeff = [0, 0, 0]
        self.minx, self.maxx = x1 == t.x1, x2 == t.x2
        self.miny, self.maxy = y1 == t.y1, y2 == t.y2

    def wavelets(self):
        c0v, c1v, c2v = self.coeff
        c0, c1, c2, c3 = c0v + c2v, c0v, 0, c2v
        if self.flip:
            c1 += c1v; c3 += c1v
        else:
            c0 += c1v; c2 += c1v
        # The wavelets reflect at the borders of the terrain.
        if self.minx:
            c0 += c0v
            if self.flip: c3 += c1v
            else: c0 += c1v
        if self.miny:
            c0 += c2v
            if self.flip: c1 += c1v
            else: c0 += c1v
        if self.minx and self.miny:
            c0 += c1v
        return [c0, c1, c2, c3]

    def recalc(self):
        if not self.children:
            return
        level = self.children[0].verts[2].root
        v = self.verts
        if self.maxx:
            v[1].set(level, v[0].get(level)); v[2].set(level, v[3].get(level))
        if self.maxy:
            v[2].set(level, v[1].get(level)); v[3].set(level, v[0].get(level))
        for i in range(4):
            self.children[i].verts[(i + 1) % 4].set_root(v[i], v[(i + 1) % 4])
        if self.flip:
            self.children[0].verts[2].set_root(v[1], v[3])
        else:
            self.children[0].verts[2].set_root(v[0], v[2])

    def subdivide(self, t):
        if not self.children:
            return
        nv = []
        for i in range(4):
            a, b = self.verts[i], self.verts[(i + 1) % 4]
            key = ((a.x + b.x) // 2, (a.y + b.y) // 2)
            v = t.verts.get(key)
            if v is None:
                v = Vertex(key[0], key[1], a, b)
                t.verts[key] = v
            nv.append(v)
        a, b = (self.verts[1], self.verts[3]) if self.flip else (self.verts[0], self.verts[2])
        c = Vertex((a.x + b.x) // 2, (a.y + b.y) // 2, a, b)
        t.verts[(c.x, c.y)] = c
        nv.append(c)
        nv[0].wavelet, nv[4].wavelet, nv[3].wavelet = self.coeff
        v = self.verts
        self.children[0].verts = [v[0], nv[0], nv[4], nv[3]]
        self.children[1].verts = [nv[0], v[1], nv[1], nv[4]]
        self.children[2].verts = [nv[4], nv[1], v[2], nv[2]]
        self.children[3].verts = [nv[3], nv[4], nv[2], v[3]]
        level = self.children[0].verts[2].root
        for i, w in enumerate(self.wavelets()):
            self.verts[i].add(level, w)
        self.recalc()

class Terrain:
    def __init__(self, data):
        br = BitReader(data)
        version = br.read(16)
        assert version == 1001, version
        self.node_count = br.read(32)
        self.vertex_count = br.read(32)
        root_coeff = br.read(32)
        params = bytes(br.read(8) for _ in range(4 * 19))
        ints = struct.unpack_from('<4i', params, 0)
        f = struct.unpack_from('<15f', params, 16)
        self.x1, self.y1 = ints[0], ints[1]
        self.x2, self.y2 = ints[0] + ints[2], ints[1] + ints[3]
        # Quad units to world: x * scale + offset.
        self.sx, self.ox, self.sy, self.oy = f[4], f[5], f[6], f[7]
        self.height = f[13]   # rCoefToWorld: quantised height to metres
        self.verts = {}
        root = Node(self, self.x1, self.y1, self.x2, self.y2, False)
        corners = [(self.x1, self.y1), (self.x2, self.y1), (self.x2, self.y2), (self.x1, self.y2)]
        for (x, y) in corners:
            v = Vertex(x, y)
            v.set(0, root_coeff)
            self.verts[(x, y)] = v
            root.verts.append(v)
        self.root = root
        self.nodes = []
        self._read(br, root)
        for n in self.nodes:
            n.subdivide(self)
        for n in self.nodes:
            n.recalc()

    def _read(self, br, root):
        # Depth-first zerotree: one "significant" bit per node, then its data.
        stack = [(root, -1)]
        while stack:
            node, idx = stack.pop()
            if idx == -1:
                self.nodes.append(node)
                if br.read(1) == 0:
                    node.children = None
                    continue
                bits, maxbits = 30, 30
                if node.parent is not None:
                    bits = node.parent.bits
                    maxbits = _log2(node.parent.maxc) + 1
                node.bits = _log2(br.read(bits)) + 1
                node.maxc = br.read(maxbits)
                cb = _log2(node.maxc) + 2
                node.coeff = [_coeff(br.read(cb)) for _ in range(3)]
                idx = 0
            if idx < 4:
                mx, my = (node.x1 + node.x2) // 2, (node.y1 + node.y2) // 2
                box = [(node.x1, node.y1, mx, my, False), (mx, node.y1, node.x2, my, True),
                       (mx, my, node.x2, node.y2, False), (node.x1, my, mx, node.y2, True)][idx]
                child = Node(self, *box)
                child.parent = node
                node.children.append(child)
                stack.append((node, idx + 1))
                stack.append((child, -1))

    def mesh(self):
        """(positions, triangles): world-space vertices and index triples."""
        index, pos, tris = {}, [], []
        def vid(v):
            k = (v.x, v.y)
            if k not in index:
                index[k] = len(pos)
                pos.append((v.x * self.sx + self.ox, v.y * self.sy + self.oy, v.get() * self.height))
            return index[k]
        stack = [self.root]
        while stack:
            n = stack.pop()
            if n.children:
                stack.extend(n.children)
                continue
            v1, v2, v3, v4 = (vid(v) for v in n.verts)
            # tresgoesde builds in a mirrored (x, height, y) space; in Trespasser's own
            # Z-up axes the winding is reversed so the normals point up.
            if n.flip:
                tris += [(v1, v3, v4), (v1, v2, v3)]
            else:
                tris += [(v4, v2, v3), (v4, v1, v2)]
        return pos, tris
