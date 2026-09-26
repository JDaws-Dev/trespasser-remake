#!/usr/bin/env python3
"""Export what the physics needs that level.json leaves out:
   public/levels/<lvl>/physics.json = {
     boxes:   { objectName: [ {pos, rot, half} ... ] }   # compound objects' '$' sub-boxes, world space
     magnets: [ {slave, master, pos, rot, free:[x,y,z], tfree:[x,y,z], breakStrength,
                 drive, friction, restore, angleMin, angleMax} ]   # joints (CMagnet, Lib/Physics/Magnet.cpp)
   }
   public/levels/<lvl>/colliders.json = {
     solids:  [ {name, pos, rot, scale, c, half, compound} ]   # invisible tangible objects (F* walls and
                                                              # floors, Baker* blockers): static, never drawn
     markers: { name: {pos, rot} }                             # invisible logic helpers (TeleportDest*,
                                                              # Anchor*, Emit*...) that actions find by name
   }
Reads the level's .grf with the converter's own parsers."""
import json, os, struct, sys
sys.path.insert(0, os.path.expanduser('~/Games/Trespasser/remake/tools'))
from groff import Groff, read_value_table, properties
from convert_level import read_mesh, read_raw_mesh, euler_matrix, DATA, OUT

def export(level):
    path = os.path.join(DATA, f'{level}.grf')
    if not os.path.exists(path): path = os.path.join(DATA, f'{level}.GRF')
    g = Groff(open(path, 'rb').read())
    reg = g.sections['.region'][0][2]
    count = struct.unpack_from('<I', reg, 0)[0]
    values = read_value_table(g)
    placed, compounds, magnets, objs = {}, {}, [], {}
    solids, markers = [], {}
    LOGIC = {'AI Command', 'CLocationTrigger', 'CMagnet', 'CStartTrigger', 'Player Settings', 'CObjectTrigger',
             'Teleport', 'CTimerTrigger', 'CCollisionTrigger', 'TerrainPlacement', 'CMuzzleFlash', 'CParticles', 'CAnimal'}

    def mesh_box(seh_obj):
        """(centre, half extents) of an object's mesh, model space, or None."""
        if seh_obj not in g.by_handle: return None
        _o, seh_geo, _m = struct.unpack_from('<3I', g.by_handle[seh_obj][2], 0)
        if seh_geo not in g.by_handle: return None
        # Invisible blockers are often raw (untextured) meshes.
        mesh = read_mesh(g, seh_geo) or read_raw_mesh(g, seh_geo, _m)
        if not mesh or not mesh['pts']: return None
        pts = mesh['pts']
        lo = [min(p[k] for p in pts) for k in range(3)]
        hi = [max(p[k] for p in pts) for k in range(3)]
        return [(hi[k] + lo[k]) / 2 for k in range(3)], [(hi[k] - lo[k]) / 2 for k in range(3)]
    for i in range(count):
        seh_obj, name_h, px, py, pz, rx, ry, rz, scale, attr, _ = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        name = g.symbols.get(name_h, '')
        pr = properties(values, attr); pr = pr if isinstance(pr, dict) else {}
        rot = euler_matrix(rx, ry, rz)
        objs[name] = (px, py, pz, rot, scale)
        half = None
        if name.startswith('$') and seh_obj in g.by_handle:
            _o, seh_geo, _m = struct.unpack_from('<3I', g.by_handle[seh_obj][2], 0)
            mesh = read_mesh(g, seh_geo) if seh_geo in g.by_handle else None
            if mesh and mesh['pts']:
                pts = mesh['pts']
                lo = [min(p[k] for p in pts) for k in range(3)]
                hi = [max(p[k] for p in pts) for k in range(3)]
                half = [(hi[k] - lo[k]) / 2 * scale for k in range(3)]
                c = [(hi[k] + lo[k]) / 2 * scale for k in range(3)]
                # Box centre in world space (mesh offset turned by the placement).
                off = [sum(rot[r][k] * c[k] for k in range(3)) for r in range(3)]
                placed[name] = dict(pos=[px + off[0], py + off[1], pz + off[2]], rot=rot, half=half)
        if pr.get('Type') == 'Compound':
            compounds[name] = [pr[k] for k in sorted(pr) if k.startswith('Model') and isinstance(pr[k], str)]
        if (pr.get('Class') == 'CMagnet' and ('SlaveObject' in pr or 'MasterObject' in pr)
                and not pr.get('HandPickup') and not pr.get('ShoulderHold')):
            # One object named (either key): it is magnetted to the world (Magnet.cpp).
            slave, master = pr.get('SlaveObject'), pr.get('MasterObject')
            if not slave: slave, master = master, None
            m = dict(slave=slave, master=master, pos=[px, py, pz], rot=rot,
                     free=[bool(pr.get('XFree')), bool(pr.get('YFree')), bool(pr.get('ZFree'))],
                     tfree=[bool(pr.get('XTFree')), bool(pr.get('YTFree')), bool(pr.get('ZTFree'))],
                     breakStrength=pr.get('BreakStrength', 0) if pr.get('Breakable') else 0)
            for k, key in (('drive', 'Drive'), ('friction', 'Friction'), ('restore', 'RestoreStrength'),
                           ('angleMin', 'AngleMin'), ('angleMax', 'AngleMax')):
                if isinstance(pr.get(key), (int, float)): m[k] = pr[key]
            magnets.append(m)
        # Invisible solids and helpers: the converter draws neither.
        if pr.get('Visible') is False and not name.startswith('$') and pr.get('Class') not in LOGIC and name != 'Anne':
            if pr.get('Tangible') is True and pr.get('Moveable') is not True:
                box = mesh_box(seh_obj)
                if box or pr.get('Type') == 'Compound':
                    e = dict(name=name, pos=[px, py, pz], rot=rot, scale=scale, compound=pr.get('Type') == 'Compound')
                    if box: e['c'], e['half'] = [round(v, 5) for v in box[0]], [round(v, 5) for v in box[1]]
                    solids.append(e)
            else:
                markers[name] = dict(pos=[round(v, 4) for v in (px, py, pz)], rot=[[round(v, 5) for v in r] for r in rot])
    # Copies of a compound share one set of '$' boxes, placed with whichever copy the
    # artist built them on (the one nearest them): store the boxes in that copy's frame
    # (unscaled), so every copy can carry them.
    boxes = {}
    by_set = {}
    for n, subs in compounds.items():
        by_set.setdefault(tuple(subs), []).append(n)
    for subs, names in by_set.items():
        sub = [placed[m] for m in subs if m in placed]
        if not sub: continue
        cx = [sum(b['pos'][k] for b in sub) / len(sub) for k in range(3)]
        ref = min(names, key=lambda n: sum((objs[n][k] - cx[k]) ** 2 for k in range(3)))
        px, py, pz, R, s = objs[ref]
        local = []
        for b in sub:
            d = [b['pos'][0] - px, b['pos'][1] - py, b['pos'][2] - pz]
            pos = [sum(R[k][r] * d[k] for k in range(3)) / s for r in range(3)]        # R^T d / s
            rot = [[sum(R[k][r] * b['rot'][k][c] for k in range(3)) for c in range(3)] for r in range(3)]   # R^T Rb
            local.append(dict(pos=[round(v, 5) for v in pos], rot=[[round(v, 6) for v in row] for row in rot],
                              half=[round(v / s, 5) for v in b['half']]))
        for n in names: boxes[n] = local
    out = os.path.join(OUT, level, 'physics.json')
    json.dump(dict(boxes=boxes, magnets=magnets), open(out, 'w'), separators=(',', ':'))
    print(f'{level}: {len(boxes)} compound objects, {sum(map(len, boxes.values()))} boxes, {len(magnets)} magnets -> {out}')
    for e in solids:
        if e['compound'] and e['name'] not in boxes and 'half' not in e: e['compound'] = False
    solids = [e for e in solids if e['compound'] or 'half' in e]
    out = os.path.join(OUT, level, 'colliders.json')
    json.dump(dict(solids=solids, markers=markers), open(out, 'w'), separators=(',', ':'))
    print(f'{level}: {len(solids)} invisible solids, {len(markers)} markers -> {out}')

for lvl in sys.argv[1:] or ['be']:
    export(lvl)
