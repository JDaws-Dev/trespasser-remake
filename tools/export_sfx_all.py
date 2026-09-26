#!/usr/bin/env python3
"""Export a level's whole sound-effects layer: collision sounds, footsteps, Anne's voice.

Runs export_sounds.py first (guns, dinosaur vocals, trigger sounds), then extends its
sfx.json. Where the data comes from:

  * Effects.tpa carries the original collision table (header u4Collisions at
    u4CollisionFileOffset, AudioLoader.hpp SFileCollision): 152-byte records keyed by
    the pair of sound-material hashes (low 32 bits the smaller hash, AudioDaemon.hpp
    u8CollisionHash), each with up to two hit samples and a slide loop, a minimum
    re-trigger delay and a velocity -> volume/pitch transfer (SSoundTransfer).
  * Material names are the objects' SoundMaterial properties; footsteps are just the
    collision of Anne's foot box ("ANNE-FOOT", InfoSkeleton.cpp) with the material of
    the top terrain object under it (WorldDBase.cpp ptobjGetTopTerrainObjAt: highest
    Height wins). Those terrain objects are the level's CTerrainObj decals, many of
    them invisible sound-only regions (TrnObj_OceanSound...), exported here as XY
    triangles.
  * Anne's voice lines come from the "Player Settings" objects VocalAnneOuch/Fall/Jump/
    AmmoPickup/AmmoCount (Player.cpp parses them the same way).

Sample names are hashes (CRC-32 of the lower-cased name) in the pack; names found in
the level data or the engine source are used, others are listed as '#xxxxxxxx'.

sfx.json gains:
  collisions  {"A|B" (names sorted): {d: min delay s, hit: [T, T?], slide: T|null}}
              T = [sample, volMax, volMin, volSlope, volInt, pitchMax, pitchMin,
                   pitchSlope, pitchInt, attenuation dB/m, minVelocity]
  materials   {material: {impact: [...], impactHard: [...], slide: name|null}} (a
              convenience summary of the pairs)
  footsteps   {terrainMaterial: [names]} (Anne's feet)
  regions     {mats: [names], list: [[matIndex, height, x0,y0,x1,y1,x2,y2, ...]]}
  water       [{z, box: [x0, y0, x1, y1]}] water entities; plus sea (metres) or null
  anne        {ouch: {sets: [{damage, samples}], default: [...]}, fall: {...},
               jump: [...], ammo: {...}, pickup: {...}}
  dinoFeet    {vocal dinosaur name: foot material}
"""
import json, math, os, re, struct, subprocess, sys, wave
import groff, tpa, export_sounds
from convert_level import read_mesh, euler_matrix

DATA = os.path.expanduser('~/Games/Trespasser/data')
SRC = os.path.expanduser('~/Games/Trespasser/src/jp2_pc')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'levels')
LEVELS = ['be', 'jr', 'ij', 'it', 'lab', 'as', 'as2', 'sum']

# Materials the engine gives its own boxes (not in the level data).
FIXED = ['ANNE-FOOT', 'ANNE-HAND', 'ANNE-BODY', 'BULLET', 'Terrain - Water', 'Terrain - Water2',
         'RAPTOR-FOOT', 'TREX-FOOT', 'BRACHI-FOOT', 'PARA-FOOT', 'TRIC-FOOT',
         'RAPTOR-BODY', 'RAPTOR-HEAD', 'RAPTOR-TAIL', 'TRIC-BODY', 'TRIC-HEAD']
DINO_FEET = {'Raptor': 'RAPTOR-FOOT', 'Trex': 'TREX-FOOT', 'Brachiosaur': 'BRACHI-FOOT',
             'Parasaurolophus': 'PARA-FOOT', 'Triceratops': 'TRIC-FOOT', 'Stegosaur': 'TRIC-FOOT',
             'Albertosaur': 'TREX-FOOT'}

_names = None
def known_names():
    """Every string the game data and engine source contain, by its sample hash."""
    global _names
    if _names is not None:
        return _names
    strings = set()
    for f in os.listdir(DATA):
        if f.lower().endswith('.grf'):
            g = groff.Groff(open(os.path.join(DATA, f), 'rb').read())
            for n, t, d in groff.read_value_table(g).values():
                strings.add(n)
                if t == 'string':
                    strings.add(d)
    for dp, _dn, fn in os.walk(SRC):
        for f in fn:
            if f.lower().endswith(('.cpp', '.hpp', '.h', '.ms')):
                strings.update(re.findall(r'"([^"\n]{2,80})"', open(os.path.join(dp, f), 'rb').read().decode('latin-1')))
    _names = {}
    for s in sorted(strings):
        _names.setdefault(tpa.name_hash(s), s)
    return _names

def collisions(pack):
    ver, _ns, _to, nc, co, _ni = struct.unpack_from('<6I', pack.d, 0)
    for i in range(nc):
        o = co + 152 * i
        key, flags, delay, _last = struct.unpack_from('<QIff', pack.d, o)
        snd = struct.unpack_from('<3I', pack.d, o + 20)
        tr = [struct.unpack_from('<10f', pack.d, o + 32 + 40 * k) for k in range(3)]
        yield key & 0xffffffff, key >> 32, flags, delay, snd, tr

def level_objects(level):
    f = os.path.join(DATA, f'{level}.grf')
    g = groff.Groff(open(f if os.path.exists(f) else os.path.join(DATA, f'{level}.GRF'), 'rb').read())
    values = groff.read_value_table(g)
    reg = g.sections['.region'][0][2]
    n = struct.unpack_from('<I', reg, 0)[0]
    for i in range(n):
        seh_obj, name_h, px, py, pz, rx, ry, rz, scale, attr, _one = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        props = groff.properties(values, attr)
        yield g, g.symbols.get(name_h, ''), seh_obj, (px, py, pz), (rx, ry, rz), scale, props if isinstance(props, dict) else {}

def world_points(g, seh_obj, pos, rot, scale):
    """The object's mesh as (points in world space, triangles) or None."""
    if seh_obj not in g.by_handle:
        return None
    _o, seh_geo, _m = struct.unpack_from('<3I', g.by_handle[seh_obj][2], 0)
    if seh_geo not in g.by_handle:
        return None
    mesh = read_mesh(g, seh_geo)
    if not mesh:
        return None
    r = euler_matrix(*rot)
    pts = [tuple(sum(r[i][j] * p[j] * scale for j in range(3)) + pos[i] for i in range(3)) for p in mesh['pts']]
    tris = [tuple(mesh['verts'][k][0] for k in t) for ts in mesh['groups'].values() for t in ts]
    return pts, tris

def sample_set(d):
    """A00..Ann string values of a property group, in order."""
    return [v for k, v in sorted(d.items()) if re.match(r'A\d\d$', k) and isinstance(v, str)] if isinstance(d, dict) else []

def leveled_sets(d):
    """Ouch/Fall groups: A00.. subgroups, each with an optional Damage level."""
    out = dict(sets=[], default=[])
    for k, sub in sorted((d or {}).items()):
        if not re.match(r'A\d\d$', k) or not isinstance(sub, dict):
            continue
        s = sample_set(sub)
        if 'Damage' in sub:
            out['sets'].append(dict(damage=sub['Damage'], samples=s))
        else:
            out['default'] += s
    return out

def encode(pack, h, path):
    pcm, freq, bits, chans = pack.decode(h)
    tmp = path[:-4] + '.wav'
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(chans); w.setsampwidth(bits // 8); w.setframerate(freq); w.writeframes(pcm)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', '64k', path], check=True)
    os.remove(tmp)

def main(level):
    export_sounds.main(level)
    out = os.path.join(OUT, level)
    index = json.load(open(os.path.join(out, 'sfx.json')))
    packs = tpa.load_all()
    names = known_names()
    by_hash = {}
    for p in packs:
        for h in p.samples:
            by_hash.setdefault(h, p)
    effects = next(p for p in packs if os.path.basename(p.path).lower() == 'effects.tpa')

    # --- The level's materials, sound regions, water and Anne's voice settings.
    mats = set(FIXED)
    regions, region_mats = [], []
    water, anne = [], {}
    for g, name, seh_obj, pos, rot, scale, props in level_objects(level):
        sm = props.get('SoundMaterial')
        if isinstance(sm, str) and sm:
            mats.add(sm)
        cls = props.get('Class')
        if cls == 'CTerrainObj' and isinstance(sm, str) and sm and sm != 'Blood':
            geo = world_points(g, seh_obj, pos, rot, scale)
            if not geo:
                continue
            pts, tris = geo
            if sm not in region_mats:
                region_mats.append(sm)
            flat = [region_mats.index(sm), int(props.get('Height', 0))]
            for t in tris:
                for k in t:
                    flat += [round(pts[k][0], 2), round(pts[k][1], 2)]
            regions.append(flat)
        elif cls == 'CEntityWater':
            geo = world_points(g, seh_obj, pos, rot, scale)
            if geo and geo[0]:
                xs, ys, zs = zip(*geo[0])
                water.append(dict(z=round(max(zs), 3), box=[round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)]))
        elif cls == 'Player Settings':
            if 'Ouch' in props: anne['ouch'] = leveled_sets(props['Ouch'])
            if 'Fall' in props: anne['fall'] = leveled_sets(props['Fall'])
            if 'JumpUp' in props: anne['jump'] = sample_set(props['JumpUp'])
            if 'Ammo' in props: anne['ammo'] = {k: sample_set(v) for k, v in props['Ammo'].items() if isinstance(v, dict)}
            if 'AmmoPickup' in props: anne['pickup'] = {k: sample_set(v) for k, v in props['AmmoPickup'].items() if isinstance(v, dict)}
    mat_hash = {tpa.name_hash(m): m for m in mats}

    # --- The collision pairs between them.
    wanted = {}   # sample name -> hash
    def sname(h):
        n = names.get(h) or '#%08x' % h
        wanted[n] = h
        return n
    table, summary, footsteps = {}, {}, {}
    for a, b, flags, delay, snd, tr in collisions(effects):
        if a not in mat_hash or b not in mat_hash:
            continue
        ma, mb = mat_hash[a], mat_hash[b]
        t = lambda k: [sname(snd[k])] + [round(x, 3) for x in tr[k]]
        entry = dict(d=round(delay, 3), hit=[t(k) for k in range(flags & 3) if snd[k] and snd[k] in by_hash],
                     slide=t(2) if flags & 0x80 and snd[2] in by_hash else None)
        if not entry['hit'] and not entry['slide']:
            continue
        table['|'.join(sorted([ma, mb]))] = entry
        for m in {ma, mb}:
            s = summary.setdefault(m, dict(impact=[], impactHard=[], slide=None))
            if entry['hit'] and entry['hit'][0][0] not in s['impact']: s['impact'].append(entry['hit'][0][0])
            if len(entry['hit']) > 1 and entry['hit'][1][0] not in s['impactHard']: s['impactHard'].append(entry['hit'][1][0])
            if entry['slide'] and not s['slide']: s['slide'] = entry['slide'][0]
        if 'ANNE-FOOT' in (ma, mb):
            other = mb if ma == 'ANNE-FOOT' else ma
            footsteps[other] = [h[0] for h in entry['hit']]

    # Anne's voice samples too.
    def walk(v):
        if isinstance(v, str): wanted.setdefault(v, tpa.name_hash(v))
        elif isinstance(v, dict): [walk(x) for x in v.values()]
        elif isinstance(v, list): [walk(x) for x in v]
    walk(anne)

    # --- Encode whatever is new.
    samples = index['samples']
    missing = []
    for n, h in sorted(wanted.items()):
        if n in samples:
            continue
        p = by_hash.get(h)
        if not p:
            missing.append(n)
            continue
        fn = f'sfx/{h:08x}.mp3'
        path = os.path.join(out, fn)
        if not os.path.exists(path):
            encode(p, h, path)
        samples[n] = dict(file=fn, volume=p.samples[h]['vol'], atten=p.samples[h]['atten'])
    index.update(collisions=table, materials=summary, footsteps=footsteps,
                 regions=dict(mats=region_mats, list=regions), water=water,
                 sea=json.load(open(os.path.join(out, 'level.json'))).get('sea'),
                 anne=anne, dinoFeet=DINO_FEET)
    json.dump(index, open(os.path.join(out, 'sfx.json'), 'w'), separators=(',', ':'))
    total = sum(os.path.getsize(os.path.join(out, v['file'])) for v in samples.values())
    print(f'{level}: {len(samples)} samples ({total // 1024} KB), {len(table)} collision pairs, '
          f'{len(footsteps)} footstep surfaces, {len(regions)} sound regions ({len(region_mats)} materials), '
          f'{len(water)} water bodies; missing {missing[:8]}')


if __name__ == '__main__':
    for lv in sys.argv[1:] or LEVELS:
        main(lv)
