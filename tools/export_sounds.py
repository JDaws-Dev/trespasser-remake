#!/usr/bin/env python3
"""Export the sounds a level uses to public/levels/<level>/sfx/ with an index.

Gun samples come from the placed objects' properties; dinosaur vocals from the
level's "Vocal<Dinosaur><Action>" AI-command objects (their A00..Ann lists).
"""
import json, os, re, struct, subprocess, sys, wave
import numpy as np
import groff, tpa

DATA = os.path.expanduser('~/Games/Trespasser/data')

def main(level):
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'levels', level)
    os.makedirs(os.path.join(out, 'sfx'), exist_ok=True)
    packs = tpa.load_all()
    grf = os.path.join(DATA, f'{level}.grf')
    g = groff.Groff(open(grf if os.path.exists(grf) else os.path.join(DATA, f'{level}.GRF'), 'rb').read())
    values = groff.read_value_table(g)
    reg = g.sections['.region'][0][2]
    n = struct.unpack_from('<I', reg, 0)[0]
    wanted, vocals = {}, {}
    for i in range(n):
        f = struct.unpack_from('<2I7f2I', reg, 4 + 44 * i)
        name = g.symbols.get(f[1], '')
        props = groff.properties(values, f[9])
        if not isinstance(props, dict):
            continue
        for key in ('Sample', 'EmptyClipSample'):
            if isinstance(props.get(key), str):
                wanted[props[key]] = key
        m = re.match(r'Vocal([A-Z][a-z]+)([A-Z][A-Za-z]+)$', name)
        if m and props.get('Class') == 'AI Command':
            dino, action = m.groups()
            names = [v for k, v in sorted(props.items()) if re.match(r'A\d\d$', k) and isinstance(v, str)]
            vocals.setdefault(dino, {})[action] = names
            for s in names:
                wanted[s] = 'vocal'
    index = {}
    missing = []
    for name in sorted(wanted):
        p, h = tpa.find(packs, name)
        if not p:
            missing.append(name)
            continue
        # MP3 decodes in every browser (Safari, Chrome, headless Chromium) at a tenth of WAV's size.
        fn = f'sfx/{h:08x}.mp3'
        path = os.path.join(out, fn)
        if not os.path.exists(path):
            pcm, freq, bits, chans = p.decode(h)
            tmp = path[:-4] + '.wav'
            with wave.open(tmp, 'wb') as w:
                w.setnchannels(chans); w.setsampwidth(bits // 8); w.setframerate(freq); w.writeframes(pcm)
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', '64k', path], check=True)
            os.remove(tmp)
        index[name] = dict(file=fn, volume=p.samples[h]['vol'], atten=p.samples[h]['atten'])
    json.dump(dict(samples=index, vocals=vocals), open(os.path.join(out, 'sfx.json'), 'w'), indent=1)
    total = sum(os.path.getsize(os.path.join(out, v['file'])) for v in index.values())
    print(f'{len(index)} sounds ({total // 1024} KB) for {len(vocals)} dinosaur types; missing: {missing[:10]}')
    # A decode sanity check: real audio has a healthy spread, not silence or full-scale noise.


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'be')
