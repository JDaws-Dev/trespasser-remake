# Trespasser Remake

A from-scratch fan remake of **Jurassic Park: Trespasser** (DreamWorks Interactive, 1998) that runs in a web browser and on iPhone. It is built with three.js and uses Rapier for physics.

This is a non-commercial fan project made for nostalgia. It is not affiliated with or endorsed by Electronic Arts, DreamWorks, Universal or Amblin. *Jurassic Park*, *The Lost World* and *Trespasser* are their trademarks. The original game's levels, textures, sounds, videos and menu art belong to their owners. They are not part of this repository and must be converted from your own copy of the game. If you are a rights holder and want something taken down, open an issue and it will be removed.

## What it does

- Loads the original levels (`.grf`, `.pid`, `.spz`, `.wtd`, `.tpa`) through converters written from scratch in `tools/`.
- Keeps the original look and feel for the menus, cutscenes and level layouts.
- Improves rendering with a physical sky, sun shadows, reflective water, PBR materials and optional AI-upscaled textures.
- Brings back the physics sandbox the original was known for: objects have weight, and Anne's hand can knock them over, pick them up and throw them.
- Plays with a keyboard and mouse, or with touch controls on a phone.

## Build

```sh
npm install
# Convert your own copy of the game: the tools read its data/ folder from ~/Games/Trespasser/data
for l in be jr ij it lab as as2 sum; do python3 tools/convert_level.py $l; python3 tools/export_sounds.py $l; python3 tools/export_anne.py $l; done
python3 tools/export_menu.py
python3 tools/detail_textures.py
npx vite            # dev server
npx vite build      # static site in dist/
```

## Credits

- The terrain (`.wtd`) decoder in `tools/terrain.py` is ported from [TresGoesDE](https://github.com/LordOfDragons/tresgoesde) by LordOfDragons (GPL-3.0). This repository is therefore GPL-3.0 as well.
- [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) and [Rapier](https://rapier.rs).
