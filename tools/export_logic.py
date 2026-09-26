#!/usr/bin/env python3
"""Export a level's game logic: every trigger, its volume, conditions and actions.

    export_logic.py be            -> public/levels/be/logic.json
    export_logic.py all

The engine's trigger classes (jp2_pc/Source/Lib/Trigger) are read from the level's
object properties the way their constructors read them:

- CTrigger (TriggerBase.cpp): FireCount (default -1 = for ever), Prob, ProcessStyle,
  FireDelay, RepeatPeriod, FireZero/ResetFire, BoundVol (0 sphere = the unit sphere
  scaled by the placement, 1 cube = the trigger mesh's box), SequenceDelayMin/Max,
  FireExpression, and the actions Action00..Action15 - or, with none, the trigger's
  own properties as its one action (the "un-nested" form).
- CAmbientAction with an A00..Ann list adds one action per sample to the trigger
  (Action.cpp), so the list is expanded here, in place.
- Location / object / creature / collision / timer / boolean / sequence / variable /
  start triggers keep their own condition properties.

Also written: every object the actions or conditions name (placement, rotation, scale
and mesh box), the Teleport checkpoints (for the cheat console), the level the level
loads next, the F1 hint strings (Trespass/res/USA_hints.rc2) and every sample named.
"""
import json, os, re, struct, sys
from groff import Groff, read_value_table, properties
from convert_level import read_mesh, read_raw_mesh, euler_matrix, DATA, OUT

HINTS = os.path.expanduser('~/Games/Trespasser/src-dev/jp2_pc/Source/Trespass/res/USA_hints.rc2')
LEVELS = ['be', 'jr', 'ij', 'it', 'lab', 'as', 'as2', 'sum']

TRIGGERS = {'CLocationTrigger': 'location', 'CStartTrigger': 'start', 'CObjectTrigger': 'object',
            'CTimerTrigger': 'timer', 'CCollisionTrigger': 'collision', 'CBooleanTrigger': 'boolean',
            'CSequenceTrigger': 'sequence', 'CVariableTrigger': 'variable', 'CCreatureTrigger': 'creature',
            'CMagnetTrigger': 'magnet', 'CMoreMassTrigger': 'moremass'}

# Action.hpp EActionType.
ACTIONS = ['VOICEOVER', 'AMBIENT', 'MUSIC', 'FADE_MUSIC', 'SHOW_OVERLAY', 'SET_FOG', 'SET_RENDERER', 'SET_TERRAIN',
           'SET_IMAGECACHE', 'SET_AI', 'SET_PHYSICS', 'SUBSTITUTE_MESH', 'SET_DEPTHSORT', 'SET_SKY', 'SET_ALPHA_WATER',
           'ENABLE_WATER', 'LOAD_LEVEL', 'SET_ANIMATE_PROPERTIES', 'TELEPORT', 'SAVE_LEVEL', 'MAGNET',
           'SET_ANIMATE_TEXTURE', 'HIDESHOW', 'SOUND_EFFECT', 'WAKE_AI', 'DELAY', 'SCRIPTED_ANIMATION',
           'SET_VARIABLE_TRIGGER', 'SET_HINT', 'AUDIO_ENVIRONMENT', 'SUBSTITUTE_AI', 'END_GAME', 'CONTROL_PLAYER',
           'AI_SYSTEM', 'TEXT', 'WATER_DISTURBANCE']

# Properties that belong to the trigger, not to its un-nested action.
TRIGGER_KEYS = {'Class', 'FireCount', 'Prob', 'ProcessStyle', 'FireDelay', 'RepeatPeriod', 'FireZero', 'ResetFire',
                'BoundVol', 'SequenceDelayMin', 'SequenceDelayMax', 'FireExpression',
                'PlayerEnterTrigger', 'PlayerLeaveTrigger', 'PlayerInTrigger', 'ObjectEnterTrigger',
                'ObjectLeaveTrigger', 'ObjectInTrigger', 'CreatureEnterTrigger', 'CreatureLeaveTrigger',
                'CreatureInTrigger', 'TriggerActivate', 'PointTrigger', 'EnterCount', 'LeaveCount',
                'PickUpObject', 'PutDownObject', 'UseObject', 'Element1', 'Element2', 'SoundMaterial1',
                'SoundMaterial2', 'MinVelocity', 'MaxVelocity', 'MinLowTime', 'MaxLowTime', 'MinHighTime',
                'MaxHighTime', 'InitialState', 'SequenceOrderNames', 'SequenceListenNames', 'SequenceEvalNowNames',
                'SequenceFalseTriggerName', 'CreatureDie', 'CreatureSleep', 'CreatureWake', 'CreatureDamagePoints',
                'CreatureCriticalDamage', 'EvaluateAll', 'Visible', 'Split', 'Merge', 'Wrap', 'AlphaChannel'}
# Condition-object lists (A00..A03) of object and creature triggers.
LISTS = {'object', 'creature'}
# Action properties that name other objects.
NAMED = ('Target', 'Emitter', 'ObjectName', 'TeleportDestObjectName', 'MasterObject', 'SlaveObject', 'Query',
         'StayNearTarget', 'StayAwayTarget', 'Location', 'TriggerName', 'Substitute')

def a_list(p):
    return [p[k] for k in sorted(p) if re.fullmatch(r'A\d\d', k) and isinstance(p[k], str)]

def load_hints():
    hints = {}
    if os.path.exists(HINTS):
        for m in re.finditer(r'IDS_STR_HINTS\s*\+\s*(\d+)\s+"((?:[^"]|"")*)"', open(HINTS, encoding='latin-1').read()):
            hints[int(m.group(1))] = m.group(2).replace('""', '"').strip()
    return hints

def clean(v):
    if isinstance(v, float):
        return round(v, 5)
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    return v

def make_actions(p, klass):
    """The trigger's action list, as its constructor builds it."""
    raw = [p[k] for k in sorted(p) if re.fullmatch(r'Action\d\d', k) and isinstance(p[k], dict)]
    if not raw:
        # The un-nested form: the trigger's own properties are its action.
        own = {k: v for k, v in p.items() if k not in TRIGGER_KEYS and not isinstance(v, dict)
               and not (klass in LISTS and re.fullmatch(r'A\d\d', k))}
        raw = [own] if 'ActionType' in own else []
    out, bad = [], []
    for a in raw:
        t = a.get('ActionType')
        if not isinstance(t, int) or not 0 <= t < len(ACTIONS):
            bad.append(a)
            continue
        a = {k: clean(v) for k, v in a.items() if k not in ('Split', 'Merge', 'Wrap', 'AlphaChannel')}
        a['type'] = ACTIONS[t]
        del a['ActionType']
        if a['type'] == 'AMBIENT' and not isinstance(a.get('Sample'), str):
            # One ambient action per listed sample (CAmbientAction's constructor).
            names = a_list(a)
            base = {k: v for k, v in a.items() if not re.fullmatch(r'A\d\d', k)}
            out += [dict(base, Sample=s) for s in names]
            if not names:
                bad.append(a)
            continue
        out.append(a)
    return out, bad

def export(level):
    fn = next(f for f in os.listdir(DATA) if f.lower() == level + '.grf')
    g = Groff(open(os.path.join(DATA, fn), 'rb').read())
    values = read_value_table(g)
    reg = g.sections['.region'][0][2]
    count = struct.unpack_from('<I', reg, 0)[0]

    placed = {}     # name -> placement record
    triggers, teleports, undecoded = [], [], []
    start = None
    box_cache = {}

    def mesh_box(seh_obj):
        if seh_obj in box_cache:
            return box_cache[seh_obj]
        box = None
        if seh_obj in g.by_handle:
            _o, sg, sm = struct.unpack_from('<3I', g.by_handle[seh_obj][2], 0)
            if sg in g.by_handle:
                m = read_mesh(g, sg) or read_raw_mesh(g, sg, sm)
                if m and m['pts']:
                    box = [[round(min(q[k] for q in m['pts']), 4) for k in range(3)],
                           [round(max(q[k] for q in m['pts']), 4) for k in range(3)]]
        box_cache[seh_obj] = box
        return box

    for i in range(count):
        seh_obj, name_h, px, py, pz, rx, ry, rz, scale, attr, _one = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        name = g.symbols.get(name_h, '')
        p = properties(values, attr)
        p = p if isinstance(p, dict) else {}
        klass = p.get('Class')
        rec = dict(pos=[round(px, 4), round(py, 4), round(pz, 4)],
                   rot=[[round(c, 6) for c in row] for row in euler_matrix(rx, ry, rz)],
                   scale=round(scale, 5), cls=klass, seh=seh_obj)
        placed.setdefault(name, rec)
        if name == 'Anne':
            start = dict(pos=rec['pos'], heading=rz)
        if klass == 'Teleport':
            teleports.append(dict(name=name, pos=rec['pos'], heading=round(rz, 4)))
        kind = TRIGGERS.get(klass)
        if not kind:
            continue
        actions, bad = make_actions(p, kind)
        undecoded += [dict(trigger=name, action=clean(b)) for b in bad]
        cond = {k: clean(v) for k, v in p.items() if k in TRIGGER_KEYS and k not in
                ('Class', 'Split', 'Merge', 'Wrap', 'AlphaChannel')}
        for k in ('SequenceOrderNames', 'SequenceListenNames', 'SequenceEvalNowNames'):
            if isinstance(cond.get(k), dict):
                cond[k] = a_list(cond[k])
        if kind in LISTS:
            cond['objects'] = a_list(p)
        t = dict(name=name, kind=kind, pos=rec['pos'], rot=rec['rot'], scale=rec['scale'], cond=cond, actions=actions)
        if kind == 'location':
            if p.get('BoundVol', 0) == 1:
                t['shape'] = dict(type='box', box=mesh_box(seh_obj) or [[-1, -1, -1], [1, 1, 1]])
            else:
                t['shape'] = dict(type='sphere')
        triggers.append(t)

    # Every object the logic names, with its placement and mesh box.
    wanted = set()
    for t in triggers:
        c = t['cond']
        for k in ('TriggerActivate', 'Element1', 'Element2'):
            if isinstance(c.get(k), str) and not c.get('SoundMaterial' + k[-1]):
                wanted.add(c[k])
        wanted.update(c.get('objects', []))
        for a in t['actions']:
            for k in NAMED:
                if isinstance(a.get(k), str):
                    wanted.add(a[k])
            if a['type'] == 'MAGNET':
                pass
    objects = {}
    missing = []
    for n in sorted(wanted):
        r = placed.get(n)
        if not r:
            if not n.startswith('$AnneHand'):
                missing.append(n)
            continue
        objects[n] = dict(pos=r['pos'], rot=r['rot'], scale=r['scale'], cls=r['cls'], box=mesh_box(r['seh']))

    nxt = None
    for t in triggers:
        for a in t['actions']:
            if a['type'] == 'LOAD_LEVEL' and isinstance(a.get('LevelName'), str) and 'test' not in a['LevelName'].lower():
                nxt = a['LevelName'].lower().replace('.scn', '')
    samples = sorted({a['Sample'] for t in triggers for a in t['actions'] if isinstance(a.get('Sample'), str)})
    hints = load_hints()
    hint_ids = {a.get('HintID') for t in triggers for a in t['actions'] if a['type'] == 'SET_HINT'}
    stats = dict(triggers={}, actions={})
    for t in triggers:
        stats['triggers'][t['kind']] = stats['triggers'].get(t['kind'], 0) + 1
        for a in t['actions']:
            stats['actions'][a['type']] = stats['actions'].get(a['type'], 0) + 1
    logic = dict(level=level, next=nxt, start=start, triggers=triggers, objects=objects,
                 teleports=teleports, hints={str(k): v for k, v in hints.items() if k in hint_ids or k // 100 == LEVELS.index(level) + 1},
                 samples=samples, stats=stats, undecoded=undecoded, missingObjects=missing)
    out = os.path.join(OUT, level)
    os.makedirs(out, exist_ok=True)
    json.dump(logic, open(os.path.join(out, 'logic.json'), 'w'), separators=(',', ':'))
    print(f"{level}: {len(triggers)} triggers {stats['triggers']}")
    print(f"   actions {dict(sorted(stats['actions'].items(), key=lambda kv: -kv[1]))}")
    print(f"   next={nxt} objects={len(objects)} teleports={len(teleports)} samples={len(samples)} "
          f"undecoded={len(undecoded)} missing={missing[:8]}{'...' if len(missing) > 8 else ''}")

if __name__ == '__main__':
    arg = sys.argv[1] if len(sys.argv) > 1 else 'be'
    for lv in (LEVELS if arg == 'all' else [arg]):
        export(lv)
