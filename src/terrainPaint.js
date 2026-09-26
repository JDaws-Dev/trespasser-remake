// Terrain texturing, as Trespasser does it: the level's terrain objects are flat
// textured shapes, painted top-down into the terrain's texture in order of their
// "Height" (a layer number, not an elevation). Here they are painted once at load
// time into tiles with an orthographic camera, and each tile drapes over the part
// of the terrain mesh beneath it.
import * as THREE from 'three';
import { Grass } from './grass.js';
import { gaitUniforms } from './level.js';

const TILE_METRES = 256;
const PHONE = matchMedia('(pointer: coarse)').matches;
const TILE_PIXELS = PHONE ? 256 : 512;   // 1 or 2 pixels per metre

// Up close the baked colour (2 px/m, 8 near the player) would blur into mush,
// so tileable detail is laid over it in world space at two scales, chosen per
// ground type from the baked colour itself: soil, sand and grass each have their
// own grain (public/detail/terrain_d.png, one channel each). Steep slopes, where
// a top-down bake smears into streaks, take rock instead, projected from three
// sides (triplanar) with its own normal map, over a blurred copy of the bake that
// keeps the painted colour but loses the streaks. Phones get one flat projection.
const TRIPLANAR = !PHONE || new URLSearchParams(location.search).has('hd');
let detail = null;
function detailTextures(renderer) {
  if (detail) return detail;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const grainN = loader.load('detail/grain_n.png');
  const packed = loader.load('detail/terrain_d.png');
  const rockN = TRIPLANAR ? loader.load('detail/rock_n.png') : null;   // the phone has no triplanar rock
  for (const t of [grainN, packed, rockN].filter(Boolean)) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; }
  detail = { grainN, packed, rockN };
  return detail;
}

const FINE_METRES = 2.4, BROAD_METRES = 11.0, ROCK_METRES = 4.5;

function terrainMaterial(renderer, map) {
  const { grainN, packed, rockN } = detailTextures(renderer);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0 });
  if (!TRIPLANAR) {
    // The phone keeps three.js's own tangent-space normal map for the grain.
    mat.normalMap = grainN;
    mat.normalScale = new THREE.Vector2(0.35, 0.35);
    grainN.repeat.setScalar(TILE_METRES / FINE_METRES);
  } else {
    mat.defines = { TRIPLANAR: '' };
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uDetail: { value: packed }, uGrainN: { value: grainN }, uRockN: { value: rockN } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos; varying vec3 vGNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGPos = position; vGNrm = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDetail; uniform sampler2D uGrainN; uniform sampler2D uRockN;
        uniform mat4 modelMatrix;
        varying vec3 vGPos; varying vec3 vGNrm;
        // Mean-0.5 detail -> a multiplier around 1.
        float tMul(float d, float k) { return 1.0 + (d * 2.0 - 1.0) * k; }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float tDist = length(vViewPosition);
        vec3 tGN = normalize(vGNrm);
        float tSteep = smoothstep(0.86, 0.66, tGN.z);          // 0 flat .. 1 cliff
        float tFine = 1.0 - smoothstep(15.0, 70.0, tDist);
        float tBroad = 1.0 - smoothstep(35.0, 260.0, tDist);
        float tRockFade = 1.0 - smoothstep(25.0, 220.0, tDist);
        vec3 tBW = pow(abs(tGN), vec3(4.0)); tBW /= tBW.x + tBW.y + tBW.z;
        {
          vec3 base = diffuseColor.rgb;
          float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
          float wGrass = smoothstep(0.40, 0.47, base.g / (base.r + base.g + base.b + 1e-4));
          float wSand = smoothstep(0.22, 0.40, lum) * (1.0 - wGrass);
          vec3 w = vec3(1.0 - wGrass - wSand, wSand, wGrass);
          vec2 p = vGPos.xy;
          vec4 d1 = texture2D(uDetail, p / ${FINE_METRES.toFixed(2)});
          vec4 d2 = texture2D(uDetail, mat2(0.8, 0.6, -0.6, 0.8) * p / ${BROAD_METRES.toFixed(2)} + 0.37);
          vec3 flatCol = base * tMul(dot(d1.rgb, w), 0.9 * tFine) * tMul(dot(d2.rgb, w), 0.5 * tBroad);
          #ifdef TRIPLANAR
            // The painted cliff keeps its colour and markings (the beach rocks are
            // gold-marbled decals); a slightly softened copy takes the edge off the streaks.
            vec3 soft = mix(base, texture2D(map, vMapUv, 1.5).rgb, 0.5);
            float r1 = 0.0, r2 = 0.0;
            if (tBW.x > 0.01) { r1 += texture2D(uDetail, vGPos.yz / ${ROCK_METRES.toFixed(2)}).a * tBW.x; r2 += texture2D(uDetail, vGPos.yz / 17.0 + 0.5).a * tBW.x; }
            if (tBW.y > 0.01) { r1 += texture2D(uDetail, vGPos.xz / ${ROCK_METRES.toFixed(2)}).a * tBW.y; r2 += texture2D(uDetail, vGPos.xz / 17.0 + 0.5).a * tBW.y; }
            if (tBW.z > 0.01) { r1 += texture2D(uDetail, p / ${ROCK_METRES.toFixed(2)}).a * tBW.z; r2 += texture2D(uDetail, p / 17.0 + 0.5).a * tBW.z; }
            vec3 rockCol = soft * tMul(r1, 0.55 * tRockFade) * tMul(r2, 0.3);
          #else
            vec3 rockCol = base * tMul(d1.a, 0.6 * tFine);
          #endif
          diffuseColor.rgb = mix(flatCol, rockCol, tSteep);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.82, tSteep);`);
    // Desktop: the grain and the triplanar rock perturb the game-space normal
    // directly, without tangents.
    if (TRIPLANAR) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec2 g = texture2D(uGrainN, vGPos.xy / ${FINE_METRES.toFixed(2)}).xy * 2.0 - 1.0;
        vec3 flatP = vec3(g * 0.45 * tFine, 0.0);
        vec3 rockP = vec3(0.0);
        if (tSteep > 0.0) {
          if (tBW.x > 0.01) { vec2 t = texture2D(uRockN, vGPos.yz / ${ROCK_METRES.toFixed(2)}).xy * 2.0 - 1.0; rockP += vec3(0.0, t.x, t.y) * tBW.x; }
          if (tBW.y > 0.01) { vec2 t = texture2D(uRockN, vGPos.xz / ${ROCK_METRES.toFixed(2)}).xy * 2.0 - 1.0; rockP += vec3(t.x, 0.0, t.y) * tBW.y; }
          if (tBW.z > 0.01) { vec2 t = texture2D(uRockN, vGPos.xy / ${ROCK_METRES.toFixed(2)}).xy * 2.0 - 1.0; rockP += vec3(t.x, t.y, 0.0) * tBW.z; }
          rockP *= 0.7 * tRockFade;
        }
        vec3 gn = normalize(tGN + mix(flatP, rockP, tSteep));
        normal = normalize(mat3(viewMatrix) * (mat3(modelMatrix) * gn));
      }`);
  };
  return mat;
}

// The base bake is 2 px/m, coarser than the decal textures themselves (and far
// coarser than their AI upscales). The tiles around the player are re-baked at
// full detail into a small pool of targets that follows her.
const NEAR_PIXELS = matchMedia('(pointer: coarse)').matches ? 1024 : 2048;

export function paintTerrain(renderer, terrainMesh, decals, { seaLevel = null } = {}) {
  const geo = terrainMesh.geometry;
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const x0 = Math.floor(box.min.x / TILE_METRES) * TILE_METRES;
  const y0 = Math.floor(box.min.y / TILE_METRES) * TILE_METRES;
  const nx = Math.ceil((box.max.x - x0) / TILE_METRES);
  const ny = Math.ceil((box.max.y - y0) / TILE_METRES);

  // The decals, lowest layer first, flattened onto the ground plane.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8a7b5c);   // bare earth where nothing is painted
  const sorted = decals.slice().sort((a, b) => a.layer - b.layer);
  sorted.forEach((d, i) => {
    const mat = new THREE.MeshBasicMaterial({
      map: d.material.map || null, color: d.material.map ? 0xffffff : d.material.color,
      transparent: true, alphaTest: 0.02, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(d.geometry, mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(d.matrix);
    mesh.renderOrder = i;
    scene.add(mesh);
  });

  const cam = new THREE.OrthographicCamera(0, TILE_METRES, TILE_METRES, 0, -1000, 1000);
  cam.position.set(0, 0, 500);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);

  // Split the terrain's triangles among the tiles by their centres.
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex().array;
  const buckets = Array.from({ length: nx * ny }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const cx = (pos.getX(idx[t]) + pos.getX(idx[t + 1]) + pos.getX(idx[t + 2])) / 3;
    const cy = (pos.getY(idx[t]) + pos.getY(idx[t + 1]) + pos.getY(idx[t + 2])) / 3;
    const tx = Math.min(nx - 1, Math.max(0, Math.floor((cx - x0) / TILE_METRES)));
    const ty = Math.min(ny - 1, Math.max(0, Math.floor((cy - y0) / TILE_METRES)));
    buckets[ty * nx + tx].push(idx[t], idx[t + 1], idx[t + 2]);
  }

  const group = new THREE.Group();
  const tiles = new Map();   // "tx,ty" -> { mesh, base }
  const targetOptions = { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, colorSpace: THREE.SRGBColorSpace };
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const bake = (target, left, bottom, size = TILE_METRES) => {
    cam.left = left; cam.right = left + size; cam.bottom = bottom; cam.top = bottom + size;
    cam.position.set(0, 0, 500);
    cam.updateProjectionMatrix();
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
    target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
    target.texture.anisotropy = aniso;
  };
  const prevTarget = renderer.getRenderTarget();
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const tris = buckets[ty * nx + tx];
      if (!tris.length) continue;
      const left = x0 + tx * TILE_METRES, bottom = y0 + ty * TILE_METRES;
      const target = new THREE.WebGLRenderTarget(TILE_PIXELS, TILE_PIXELS, targetOptions);
      bake(target, left, bottom);

      // This tile's piece of terrain, with UVs from world position.
      const piece = new THREE.BufferGeometry();
      piece.setAttribute('position', pos);
      piece.setAttribute('normal', geo.getAttribute('normal'));
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = (pos.getX(i) - left) / TILE_METRES;
        uv[i * 2 + 1] = (pos.getY(i) - bottom) / TILE_METRES;
      }
      piece.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      piece.setIndex(tris);
      const mesh = new THREE.Mesh(piece, terrainMaterial(renderer, target.texture));
      mesh.receiveShadow = true;
      group.add(mesh);
      tiles.set(`${tx},${ty}`, { mesh, base: target.texture });
    }
  }
  renderer.setRenderTarget(prevTarget);

  // Nine full-detail targets, handed to whichever tiles surround the player.
  const pool = Array.from({ length: 9 }, () => new THREE.WebGLRenderTarget(NEAR_PIXELS, NEAR_PIXELS, targetOptions));
  let focused = null;
  const near = new Map();   // tile key -> pool target currently holding it
  // Desktop: blades of grass around the player where the ground is painted grass.
  const grass = TRIPLANAR && new URLSearchParams(location.search).get('grass') !== '0'
    ? new Grass({ renderer, bakeColour: bake, terrainGeometry: geo, time: gaitUniforms.uTime, seaLevel }) : null;
  if (grass) group.add(grass.mesh);

  group.focus = (x, y, z) => {
    if (grass && z !== undefined) grass.update(x, y, z);
    const tx = Math.floor((x - x0) / TILE_METRES), ty = Math.floor((y - y0) / TILE_METRES);
    const key = `${tx},${ty}`;
    if (key === focused) return;
    focused = key;
    const wanted = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${tx + dx},${ty + dy}`;
      if (tiles.has(k)) wanted.push(k);
    }
    // Tiles leaving the ring go back to their base bake and free their target.
    const free = [];
    for (const [k, target] of near) if (!wanted.includes(k)) { tiles.get(k).mesh.material.map = tiles.get(k).base; near.delete(k); free.push(target); }
    for (const t of pool) if (![...near.values()].includes(t) && !free.includes(t)) free.push(t);
    const prev = renderer.getRenderTarget();
    for (const k of wanted) {
      if (near.has(k)) continue;
      const target = free.pop();
      if (!target) break;
      const [kx, ky] = k.split(',').map(Number);
      bake(target, x0 + kx * TILE_METRES, y0 + ky * TILE_METRES);
      tiles.get(k).mesh.material.map = target.texture;
      near.set(k, target);
    }
    renderer.setRenderTarget(prev);
  };
  return group;
}
