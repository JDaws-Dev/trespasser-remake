"""Readers for Trespasser's container formats.

SZDD: Microsoft compress.exe (the .grf files).
GROFF: the engine's object file format (.grf geometry, .scn scenes), described
in jp2_pc/Source/Lib/Groff/FileIO.hpp.
"""
import struct

def expand_szdd(data):
    if data[:8] != b'SZDD\x88\xf0\x27\x33':
        return data
    size = struct.unpack_from('<I', data, 10)[0]
    out = bytearray()
    win = bytearray(b' ' * 4096)
    pos = 4096 - 16
    i = 14
    n = len(data)
    while i < n and len(out) < size:
        flags = data[i]; i += 1
        for bit in range(8):
            if i >= n or len(out) >= size:
                break
            if flags & (1 << bit):
                c = data[i]; i += 1
                out.append(c); win[pos] = c; pos = (pos + 1) & 4095
            else:
                if i + 1 >= n:
                    break
                b1, b2 = data[i], data[i + 1]; i += 2
                src = b1 | ((b2 & 0xF0) << 4)
                for k in range((b2 & 0x0F) + 3):
                    c = win[(src + k) & 4095]
                    out.append(c); win[pos] = c; pos = (pos + 1) & 4095
    return bytes(out)

class Groff:
    """Sections by name, with their raw bytes."""
    def __init__(self, data):
        data = expand_szdd(data)
        self.data = data
        (magic, fsize, nsec, nsym, symsize, symoff, ts, flags, ver) = struct.unpack_from('<9I', data, 0)
        assert magic == 0xACEBABE, hex(magic)
        self.version = ver
        # Symbol table: handle, name length, refcount, (pointer), then names.
        self.symbols = {}
        self.sections = {}
        self._parse(nsec, nsym, symsize, symoff)

    def _parse(self, nsec, nsym, symsize, symoff):
        d = self.data
        # Section headers follow the 48-byte file header.
        hdr = []
        off = 48
        for _ in range(nsec):
            hdr.append(struct.unpack_from('<8I', d, off)); off += 32
        self.raw_headers = hdr
        self.symoff, self.nsym, self.symsize = symoff, nsym, symsize
        # Symbol table: entries of (handle, name length incl. NUL, refcount, name).
        off = symoff
        for _ in range(nsym):
            h, ln, ref = struct.unpack_from('<3I', d, off); off += 12
            self.symbols[h] = d[off:off + ln - 1].decode('latin-1'); off += ln
        self.by_handle = {}
        for (name_h, sflags, soff, ssize, roff, rcount, uflags, handle) in hdr:
            name = self.symbols.get(name_h, '?%x' % name_h)
            sec = (name, uflags, d[soff:soff + ssize])
            self.by_handle[handle] = sec
            self.sections.setdefault(name, []).append(sec)

def expand_spz(data):
    """.spz texture packs: a 4-byte expanded size, then Okumura LZSS (N=4096, F=18,
    THRESHOLD=2, window zero-filled, writing from N-F). See ImageLoader.cpp."""
    size = struct.unpack_from('<I', data, 0)[0]
    out = bytearray()
    win = bytearray(4096)
    r = 4096 - 18
    i, n = 4, len(data)
    while i < n and len(out) < size:
        flags = data[i]; i += 1
        for bit in range(8):
            if i >= n or len(out) >= size:
                break
            if flags & (1 << bit):
                c = data[i]; i += 1
                out.append(c); win[r] = c; r = (r + 1) & 4095
            else:
                if i + 1 >= n:
                    break
                c1, c2 = data[i], data[i + 1]; i += 2
                src = c1 | ((c2 & 0xF0) << 4)
                for k in range((c2 & 0x0F) + 3):
                    c = win[(src + k) & 4095]
                    out.append(c); win[r] = c; r = (r + 1) & 4095
    return bytes(out), size

VALUE_TYPES = {0x101: 'bool', 0x102: 'char', 0x103: 'int', 0x104: 'float', 0x105: 'string', 0x106: 'group'}

def read_value_table(g):
    """Object properties: {value id: (name, type, data)}. Groups hold lists of value ids.
    Layout from tresgoesde GroffLoader.readValueTables."""
    names, values = {}, {}
    for name, uflags, d in g.by_handle.values():
        if uflags != 0x2000:
            continue
        off = 6
        count = struct.unpack_from('<I', d, off)[0]; off += 4 + 6 + 4
        for _ in range(count):
            end = d.index(b'\0', off)
            s = d[off:end].decode('latin-1'); off = end + 1
            vid, _use = struct.unpack_from('<2I', d, off); off += 8
            names[vid] = s
        off += 5
        count = struct.unpack_from('<I', d, off)[0]; off += 4 + 5 + 4
        for _ in range(count):
            typ = struct.unpack_from('<H', d, off)[0]; off += 3
            vid = struct.unpack_from('<I', d, off)[0]; off += 8
            nid = struct.unpack_from('<I', d, off)[0]; off += 4 + 12
            t = VALUE_TYPES.get(typ, '?')
            if t == 'bool': data = d[off] == 1; off += 1
            elif t == 'char': data = d[off]; off += 1
            elif t == 'int': data = struct.unpack_from('<i', d, off)[0]; off += 4
            elif t == 'float': data = struct.unpack_from('<f', d, off)[0]; off += 4
            elif t == 'string':
                end = d.index(b'\0', off); data = d[off:end].decode('latin-1'); off = end + 1
            elif t == 'group':
                n = struct.unpack_from('<I', d, off)[0]; off += 4
                data = [struct.unpack_from('<I', d, off + 8 * k)[0] for k in range(n)]; off += 8 * n
            else:
                raise ValueError('value type %x at %d' % (typ, off))
            off += 8
            values[vid] = (names.get(nid, '?'), t, data)
    return values

def properties(values, vid, depth=0):
    """A value group as a nested dict of property name -> value."""
    if vid not in values or depth > 8:
        return None
    name, t, data = values[vid]
    if t != 'group':
        return data
    return {values[c][0]: properties(values, c, depth + 1) for c in data if c in values}
