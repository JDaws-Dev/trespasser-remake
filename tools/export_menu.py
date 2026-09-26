#!/usr/bin/env python3
"""Export the original front end to public/menu/: menu art, menu sounds, cutscenes.

- Every data/menu/*.tga becomes a lower-case .png. Images the .ddf layouts draw
  "transparent" (buttons, and statics with the flag set) get the original's colour
  key applied: the top-left pixel's colour, compared at 16-bit 565 precision the way
  CUIStatic::GetTransColor / RasterBlt did, becomes alpha 0.
- The .ddf layouts are parsed (UICTRL records: type, visible, enabled, id, rect,
  then the type's own fields) into public/menu/layouts.json for src/frontend.js.
- Menu.tpa's samples (the menu loop, the T-rex footstep button click and the
  thirteen distant dinosaurs / birds played at random) become .mp3.
- The Smacker cutscenes become H.264 + AAC .mp4 (iOS Safari plays these inline;
  Chrome and Firefox play them too).
"""
import json, os, re, shlex, subprocess, sys, wave
from PIL import Image
import tpa

DATA = os.path.expanduser('~/Games/Trespasser/data')
MENU = os.path.join(DATA, 'menu')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'menu')

SOUNDS = ['OPTIONS - MAIN LOOP', 'DINO - TREX FOOT',
          'DINO - TREX DIST MISC', 'DINO - TREX DIST A', 'DINO - TREX DIST B',
          'DINO - RAPT DIST A', 'DINO - RAPT DIST B', 'DINO - RAPT DIST C',
          'BIRD 01', 'BIRD 02', 'BIRD 03', 'BIRD 04', 'BIRD 05', 'BIRD 06', 'BIRD 07']
VIDEOS = ['tpassintro', 'newgame', 'win', 'credits']


def img_name(path):
    return os.path.basename(path.replace('\\\\', '/').replace('\\', '/')).strip().lower().replace('.tga', '.png')


def tokens(text):
    """The .ddf token stream: quoted strings, numbers (dec or 0x), bare words; ';' starts a comment."""
    out = []
    for line in text.splitlines():
        s = line
        # Strip a comment that isn't inside a string.
        q = False
        for i, ch in enumerate(s):
            if ch == '"':
                q = not q
            elif ch == ';' and not q:
                s = s[:i]
                break
        for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|(\S+)', s):
            if m.group(1) is not None:
                out.append(m.group(1).replace('\\\\', '\\').replace('\\"', '"'))
            else:
                w = m.group(2)
                try:
                    out.append(int(w, 0))
                except ValueError:
                    out.append(w)
    return out


# Fields each control type reads after "type visible enabled id l t r b" (ctrls.cpp TokenLoad).
def parse_ddf(text):
    t = tokens(text)
    i = 0
    layout = {'background': None, 'controls': []}
    nxt = lambda: t[i]

    def take(n):
        nonlocal i
        v = t[i:i + n]
        i += n
        return v
    while i < len(t):
        w = take(1)[0]
        if w == 'BACKGROUND':
            x, y, r, b, img = take(5)
            layout['background'] = dict(rect=[x, y, r, b], image=img_name(img) if img else None)
        elif w == 'UICTRL':
            typ, vis, en, cid, l, tp, r, b = take(8)
            typ = typ.lower()
            c = dict(type=typ, visible=vis, enabled=en, id=cid, rect=[l, tp, r, b])
            if typ == 'button':
                # An invisible hot area (the main screen's direct-load corner) has no trans flag.
                c['trans'] = take(1)[0] if isinstance(nxt(), int) else 0
                c['images'] = [img_name(s) if s.strip() else None for s in take(4)]
            elif typ == 'static':
                trans, img = take(2)
                c['trans'] = trans
                c['image'] = img_name(img) if img else None
            elif typ == 'checkbox':
                c['images'] = [img_name(s) for s in take(4)]
            elif typ == 'slider':
                img, units, default, ticks = take(4)
                c.update(image=img_name(img), units=units, default=default)
            elif typ == 'hotspot':
                take(1)
            elif typ == 'progress':
                c['color'] = take(8)[5:]
            elif typ in ('textbox', 'listbox', 'editbox'):
                # Variable-length in the original (optional fields); read up to the next record.
                j = i
                while j < len(t) and t[j] != 'UICTRL' and t[j] != 'BACKGROUND':
                    j += 1
                fields = take(j - i)
                strs = [f for f in fields if isinstance(f, str)]
                if typ == 'textbox':
                    c['text'] = strs[0] if strs else ''
                    nums = [f for f in fields if isinstance(f, int)]
                    # Full form: trans, backlit, offset, rgb, text, size, weight, rgb, rgb, flags, border.
                    if len(nums) >= 16:
                        c['size'] = nums[6]
                        c['flags'] = nums[-2]
                        c['border'] = nums[-1]
            layout['controls'].append(c)
        else:
            # ngi.ddf is just a list of strings (the listbox text for the new-game intro).
            layout.setdefault('lines', []).append(w)
    return layout


def colour_key(im):
    im = im.convert('RGBA')
    px = im.load()
    k = px[0, 0]
    key = (k[0] >> 3, k[1] >> 2, k[2] >> 3)
    w, h = im.size
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if (p[0] >> 3, p[1] >> 2, p[2] >> 3) == key:
                px[x, y] = (p[0], p[1], p[2], 0)
    return im


def run(cmd):
    print('  $', ' '.join(shlex.quote(c) for c in cmd[:6]), '…')
    subprocess.run(cmd, check=True)


def main(args):
    os.makedirs(os.path.join(OUT, 'sfx'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'video'), exist_ok=True)

    layouts, keyed = {}, set()
    for fn in sorted(os.listdir(MENU)):
        if fn.lower().endswith('.ddf'):
            lay = parse_ddf(open(os.path.join(MENU, fn), encoding='latin-1').read())
            layouts[fn[:-4].lower()] = lay
            for c in lay['controls']:
                if c.get('trans') == 1:
                    keyed.update(x for x in c.get('images', []) + [c.get('image')] if x)
    json.dump(layouts, open(os.path.join(OUT, 'layouts.json'), 'w'), indent=1)
    print(f'{len(layouts)} layouts; colour-keyed images: {sorted(keyed)}')

    n = 0
    for fn in sorted(os.listdir(MENU)):
        if not fn.lower().endswith('.tga'):
            continue
        name = fn.lower()[:-4] + '.png'
        im = Image.open(os.path.join(MENU, fn))
        # A TGA's own alpha is not used by the original (16-bit blits); keyed ones get the key,
        # as do the unused main-menu art (ms_credits, ms_tpass) drawn on pure green.
        green = im.convert('RGB').getpixel((0, 0)) == (0, 255, 0)
        im = colour_key(im) if name in keyed or green else im.convert('RGB')
        im.save(os.path.join(OUT, name), optimize=True)
        n += 1
    print(f'{n} images')

    packs = tpa.load_all()
    sounds = {}
    for s in SOUNDS:
        p, h = tpa.find(packs, s)
        if not p:
            print('  missing sound', s)
            continue
        fn = 'sfx/' + re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_') + '.mp3'
        path = os.path.join(OUT, fn)
        pcm, freq, bits, chans = p.decode(h)
        tmp = path[:-4] + '.wav'
        with wave.open(tmp, 'wb') as w:
            w.setnchannels(chans); w.setsampwidth(bits // 8); w.setframerate(freq); w.writeframes(pcm)
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-c:a', 'libmp3lame', '-b:a', '96k', path], check=True)
        os.remove(tmp)
        sounds[s] = dict(file=fn, volume=p.samples[h]['vol'])
    json.dump(sounds, open(os.path.join(OUT, 'sounds.json'), 'w'), indent=1)
    print(f'{len(sounds)} sounds')

    if '--no-video' in args:
        return
    for v in VIDEOS:
        src = os.path.join(MENU, v + '.smk')
        mp4 = os.path.join(OUT, 'video', v + '.mp4')
        # newgame.smk is stored line-doubled (640x172; the Smacker SDK reports and shows it
        # 344 high); the others are 640x348 letterboxed frames. Height doubled where halved.
        h = int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height',
                                '-of', 'csv=p=0', src], capture_output=True, text=True).stdout.strip())
        vf = 'scale=640:%d:flags=lanczos,setsar=1' % (h * 2 if h < 240 else h)
        if not os.path.exists(mp4) or '--force' in args:
            run(['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-vf', vf, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                 '-preset', 'slow', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '5000k',
                 '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', mp4])
    print('videos done')


if __name__ == '__main__':
    main(sys.argv[1:])
