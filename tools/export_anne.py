#!/usr/bin/env python3
"""Export Anne's first-person body (her chest and right arm) from a level.

    export_anne.py be   -> public/levels/be/{anne.json, anne.bin} (+ her textures in tex/, tex_m/)

The level's 'Anne' object (class Player) is a jointed mesh: 302 points, each tied
to one of 20 joints ($JAnne00..19) or 2 "double" joints (20, 21) whose rotation is
blended from two others. The joints' text props list the points they carry (PVA -2).
Her hand shapes are substitute meshes ($Anne_Gun1-00, $Anne_Benelli-00 ...): the
same 302 points posed differently; a pickup magnet's 'Substitute' number picks one
(0 = her own mesh, n = the n-th of A00, A01 ... on Anne). GroffIO.cpp loads all this.

A gun is held by two magnets: the hand-pickup magnet ('HandPickup', 'Substitute')
is where her palm grips it, and the shoulder-hold magnet ('ShoulderHold') gives the
gun's orientation relative to her head (Player.cpp SetHandRotate, v3Sight).

The chest's health tattoo is an animated texture: Anne's Anim00..Anim10 frames on
surface AnimSubMaterial - 1, frame = (frames - 1) * (1 - health) (Player.cpp Process).

Everything is written in Anne's own frame (metres; x right, y forward, z up; origin
at her pelvis joint), with a separate position/normal/uv per triangle corner and a
point index per corner so the viewer can pose the points and rebuild the corners.
"""
import json, math, os, struct, sys
from groff import Groff, read_value_table, properties
from convert_level import DATA, OUT, Textures, read_raw_mesh, read_material, euler_matrix, write_png

def load(level):
    for name in (f'{level}.GRF', f'{level}.grf'):
        p = os.path.join(DATA, name)
        if os.path.exists(p):
            return Groff(open(p, 'rb').read())
    raise FileNotFoundError(level)

def mat_t(a):
    return [[a[j][i] for j in range(3)] for i in range(3)]

def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

def mat_vec(a, v):
    return [sum(a[i][k] * v[k] for k in range(3)) for i in range(3)]

def export(level):
    g = load(level)
    values = read_value_table(g)
    reg = g.sections['.region'][0][2]
    count = struct.unpack_from('<I', reg, 0)[0]
    objs = {}
    for i in range(count):
        rec = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        name = g.symbols.get(rec[1], '')
        pr = properties(values, rec[9])
        objs[name] = dict(seh=rec[0], pos=rec[2:5], rot=euler_matrix(*rec[5:8]), scale=rec[8],
                          props=pr if isinstance(pr, dict) else {})
    anne = objs.get('Anne')
    if not anne or anne['props'].get('Class') != 'Player':
        print(f'{level}: no Anne')
        return False
    ap = anne['props']
    pos, R = anne['pos'], anne['rot']
    Rt = mat_t(R)

    def local_pt(p):
        return mat_vec(Rt, [p[k] - pos[k] for k in range(3)])

    def geometry(obj):
        _o, sg, sm = struct.unpack_from('<3I', g.by_handle[obj['seh']][2], 0)
        return read_raw_mesh(g, sg, sm)

    mesh = geometry(anne)
    npts = len(mesh['pts'])
    points = [[c * anne['scale'] for c in p] for p in mesh['pts']]

    # Joints: rest placement in Anne's frame, and the points each carries.
    nj = ap.get('NumJoints', 20) + ap.get('NumDoubleJoints', 0)
    joints, link = [], [-1] * npts
    for j in range(nj):
        o = objs['$JAnne%02d' % j]
        jr = dict(pos=[round(c, 5) for c in local_pt(o['pos'])], rot=mat_mul(Rt, o['rot']))
        if j >= ap.get('NumJoints', 20):
            # Double joint: placed between two joints, rotation blended between them.
            jr.update(first=o['props']['Anim00'], second=o['props']['Anim01'],
                      ratio=o['props'].get('Ratio', 1.0),
                      rotRatio=o['props'].get('RotationRatio', o['props'].get('Ratio', 1.0)))
        k = 0
        while 'A%02d' % k in o['props']:
            link[o['props']['A%02d' % k]] = j
            k += 1
        joints.append(jr)
    assert all(l >= 0 for l in link), 'unassigned points'

    # Hand shapes: substitute n (1-based) is the n-th A00.. object; 0 is her own mesh.
    poses = [dict(name='Anne', points={})]
    k = 0
    while 'A%02d' % k in ap:
        sub = objs[ap['A%02d' % k]]
        sp = geometry(sub)['pts']
        assert len(sp) == npts
        changed = {}
        for i, p in enumerate(sp):
            q = [c * sub['scale'] for c in p]
            if max(abs(q[c] - points[i][c]) for c in range(3)) > 1e-4:
                changed[i] = [round(c, 5) for c in q]
        poses.append(dict(name=ap['A%02d' % k].lstrip('$').replace('-00', ''), points=changed))
        k += 1

    # Surfaces and their textures.
    tx = Textures(level)
    mat = read_material(g, mesh['material'])
    out = os.path.join(OUT, level)
    os.makedirs(os.path.join(out, 'tex'), exist_ok=True)
    os.makedirs(os.path.join(out, 'tex_m'), exist_ok=True)

    def texture(name, bump=''):
        for d in (ap.get('Diffuse', 1.0), 1.0):
            tid = Textures.texture_id(name + bump, d)
            if tid in tx.entries:
                break
        else:
            return None
        hexid = '%08x' % tid
        path = os.path.join(out, 'tex', hexid + '.png')
        if not os.path.exists(path):
            e = tx.entries[tid]
            write_png(path, e['w'], e['h'], tx.rgba(e))
        mpath = os.path.join(out, 'tex_m', hexid + '.png')
        if not os.path.exists(mpath):
            from PIL import Image   # the tools/phone_textures.py rule
            im = Image.open(path)
            if max(im.size) > 64:
                im = im.resize((max(1, im.width // 2), max(1, im.height // 2)), Image.LANCZOS)
            im.save(mpath, optimize=True)
        return hexid

    blob = bytearray()
    parts = []
    for surf, tris in sorted(mesh['groups'].items()):
        name = mat[surf][0] if surf < len(mat) else ''
        pos_, nrm, uv, idx = [], [], [], []
        for tri in tris:
            for vi in tri:
                p, n, t = mesh['verts'][vi]
                pos_ += points[p]; nrm += n; uv += t; idx.append(p)
        offset = len(blob)
        blob += struct.pack('<%df' % len(pos_), *pos_)
        blob += struct.pack('<%df' % len(nrm), *nrm)
        blob += struct.pack('<%df' % len(uv), *uv)
        blob += struct.pack('<%dH' % len(idx), *idx)
        blob += b'\0' * (-len(blob) % 4)
        parts.append(dict(offset=offset, count=len(idx), surface=surf,
                          name=os.path.basename(name.replace('\\', '/')),
                          texture=texture(name, mat[surf][1]) if name else None,
                          colour=mat[surf][2] if surf < len(mat) else None))
    # Rest points and their joints.
    points_off = len(blob)
    blob += struct.pack('<%df' % (3 * npts), *[c for p in points for c in p])
    blob += struct.pack('<%dB' % npts, *link)
    blob += b'\0' * (-len(blob) % 4)

    # Health tattoo frames, on the chest surface they animate.
    health = None
    if 'AnimSubMaterial' in ap:
        frames, k = [], 0
        while 'Anim%02d' % k in ap:
            f = ap['Anim%02d' % k]
            frames.append(texture('Map\\%s\\%s' % (level, f)) or texture(next(
                (m[0] for m in mat if os.path.basename(m[0].replace('\\', '/')).lower() == f.lower()), f)))
            k += 1
        health = dict(surface=ap['AnimSubMaterial'] - 1, frames=frames)

    # Grip and hold magnets, per held object (by name without the -NN suffix).
    def stem(n):
        return n.rsplit('-', 1)[0] if '-' in n else n
    grips = {}
    for name, o in objs.items():
        pr = o['props']
        if pr.get('Class') != 'CMagnet' or pr.get('MasterObject') not in objs:
            continue
        master = objs[pr['MasterObject']]
        if not (pr.get('HandPickup') or pr.get('ShoulderHold')):
            continue
        Gt = mat_t(master['rot'])
        rel = dict(pos=[round(c, 5) for c in mat_vec(Gt, [o['pos'][k] - master['pos'][k] for k in range(3)])],
                   rot=[[round(c, 6) for c in row] for row in mat_mul(Gt, o['rot'])])
        entry = grips.setdefault(stem(pr['MasterObject']), {})
        if pr.get('HandPickup'):
            rel['substitute'] = pr.get('Substitute', 0)
            entry['grip'] = rel
        else:
            entry['hold'] = rel

    rest = [dict(pos=j['pos'], rot=[[round(c, 6) for c in row] for row in j['rot']],
                 **{k: j[k] for k in ('first', 'second', 'ratio', 'rotRatio') if k in j}) for j in joints]
    doc = dict(level=level, points=npts, pointsOffset=points_off, parts=parts, joints=rest,
               poses=poses, health=health, grips=grips,
               # PlayerSettings (Player.cpp): head relative to the body, the point it turns
               # about, and the palm relative to the physics wrist when gripping by a magnet.
               headOffset=[0, 0.13, 0.60], neckOffset=[0, 0.10, 0.56], wristToPalm=[0, 0.09, -0.01],
               handDistMin=0.80)
    open(os.path.join(out, 'anne.bin'), 'wb').write(blob)
    json.dump(doc, open(os.path.join(out, 'anne.json'), 'w'))
    print(f'{level}: Anne {npts} points, {sum(p["count"] for p in parts) // 3} triangles, {len(parts)} surfaces, '
          f'{len(poses) - 1} hand shapes, {len(grips)} held objects with magnets, '
          f'textures {[p["texture"] for p in parts].count(None)} missing')
    return True

if __name__ == '__main__':
    for lvl in sys.argv[1:] or ['be']:
        export(lvl)
