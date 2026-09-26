"""Trespasser audio packs (.tpa): find samples by name and decode them to WAV.

Layout from jp2_pc/Source/Lib/Audio/AudioLoader.hpp: a packed header, then a table
of SSampleFile entries (name hash, offset, length, attenuation, volume, CAU header).
Sample names hash as CRC-32 of the lower-cased name (Sample.cpp). CAU data is PCM
or IMA ADPCM (4-byte header per channel per block, low nibble first).
"""
import glob, os, struct, sys, wave, zlib

DATA = os.path.expanduser('~/Games/Trespasser/data')
STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
        107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724,
        796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
        4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
        20350, 22385, 24623, 27086, 29794, 32767]
NEXT = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

def name_hash(name):
    return zlib.crc32(name.lower().replace('\\', '/').encode('latin-1')) & 0xFFFFFFFF

class Pack:
    def __init__(self, path):
        self.path = path
        self.d = open(path, 'rb').read()
        ver, nsamp, table, ncoll, colloff, nident = struct.unpack_from('<6I', self.d, 0)
        assert ver == 0x150, hex(ver)
        self.samples = {}
        off = table
        for _ in range(nident):
            (h, start, length, atten, vol) = struct.unpack_from('<3I2f', self.d, off)
            cau = struct.unpack_from('<7I4BI', self.d, off + 20)
            self.samples[h] = dict(start=start, length=length, atten=atten, vol=vol, cau=cau)
            off += 20 + 36

    def decode(self, h):
        s = self.samples[h]
        magic, ver, data_off, block, size, decomp, freq, bits, chans, comp, flags, sub = s['cau']
        base = s['start'] + data_off
        raw = self.d[base:base + size]
        if comp == 0:
            return raw, freq, bits, chans
        if comp == 1:
            return ima_decode(raw, block, chans), freq, 16, chans
        raise ValueError(f'compression {comp} (VOICE) not supported')

def ima_decode(raw, block, chans):
    out = bytearray()
    for b in range(0, len(raw), block):
        blk = raw[b:b + block]
        if len(blk) < 4 * chans:
            break
        pred, idx = [], []
        for c in range(chans):
            p = struct.unpack_from('<h', blk, 4 * c)[0]
            pred.append(p); idx.append(min(88, blk[4 * c + 2]))
            out += struct.pack('<h', p)
        pos = 4 * chans
        # Mono: two samples per byte. Stereo: 4 bytes of left nibbles then 4 of right.
        if chans == 1:
            for byte in blk[pos:]:
                for nib in (byte & 15, byte >> 4):
                    step = STEP[idx[0]]
                    diff = step >> 3
                    if nib & 4: diff += step
                    if nib & 2: diff += step >> 1
                    if nib & 1: diff += step >> 2
                    if nib & 8: diff = -diff
                    pred[0] = max(-32768, min(32767, pred[0] + diff))
                    idx[0] = max(0, min(88, idx[0] + NEXT[nib]))
                    out += struct.pack('<h', pred[0])
        else:
            while pos + 8 <= len(blk):
                l = struct.unpack_from('<I', blk, pos)[0]; r = struct.unpack_from('<I', blk, pos + 4)[0]; pos += 8
                for k in range(8):
                    for c, word in ((0, l), (1, r)):
                        nib = (word >> (4 * k)) & 15
                        step = STEP[idx[c]]
                        diff = step >> 3
                        if nib & 4: diff += step
                        if nib & 2: diff += step >> 1
                        if nib & 1: diff += step >> 2
                        if nib & 8: diff = -diff
                        pred[c] = max(-32768, min(32767, pred[c] + diff))
                        idx[c] = max(0, min(88, idx[c] + NEXT[nib]))
                        out += struct.pack('<h', pred[c])
    return bytes(out)

def load_all():
    return [Pack(p) for p in sorted(glob.glob(os.path.join(DATA, '*.tpa')))]

def find(packs, name):
    h = name_hash(name)
    for p in packs:
        if h in p.samples:
            return p, h
    return None, h

def export(packs, name, out_path):
    p, h = find(packs, name)
    if not p:
        return False
    pcm, freq, bits, chans = p.decode(h)
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(chans); w.setsampwidth(bits // 8); w.setframerate(freq); w.writeframes(pcm)
    return True

if __name__ == '__main__':
    packs = load_all()
    for p in packs:
        print(os.path.basename(p.path), len(p.samples), 'samples')
    for name in sys.argv[1:]:
        p, h = find(packs, name)
        print(name, '->', os.path.basename(p.path) if p else 'NOT FOUND', p and p.samples[h]['cau'][6:10])
