// Loads a level converted by tools/convert_level.py into a three.js scene graph.
// Everything is built in Trespasser's own coordinates (metres, Z up); the caller
// puts the returned group under a Y-up root.
import * as THREE from 'three';
import { createWaterMaterial } from './water.js';
import { isPlant, addWindAttributes, windMaterial, windDepthMaterial } from './foliage.js';

const textureLoader = new THREE.TextureLoader();
const pending = [];

function loadTexture(url, colour = true) {
  let done;
  pending.push(new Promise((resolve) => (done = resolve)));
  const tex = textureLoader.load(url, done, undefined, done);
  if (colour) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = PHONE ? 2 : 8;
  return tex;
}

// AI-upscaled versions of the original textures, where one has been made
// (tools/install_hd.py). The original is the fallback.
let hd = {};
// iOS Safari kills a tab that holds a few hundred MB of GPU memory; phones keep
// the original textures (the upscales alone are ~110 MB decoded).
export const PHONE = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);
export function textureUrl(base, id) {
  if (PHONE && !new URLSearchParams(location.search).has('hd')) return `${base}/tex_m/${id}.png`;   // half size (tools/phone_textures.py)
  return hd[id] ? `${base}/hd/${id}.png` : `${base}/tex/${id}.png`;
}

// Trespasser shipped no keyframe animation (its dinosaurs were physics-driven), so
// the remake walks them procedurally in the vertex shader: legs swing about the
// hips in alternation, the tail sways, the head bobs. Per-instance attributes:
// aGait (0 still .. 1 walking), aPhase, aSpeed (steps per second-ish).
export const gaitUniforms = { uTime: { value: 0 } };

function gaitMaterial(base, bounds) {
  const mat = base.clone();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = gaitUniforms.uTime;
    shader.uniforms.uMin = { value: bounds.min.clone() };
    shader.uniforms.uMax = { value: bounds.max.clone() };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform vec3 uMin; uniform vec3 uMax;
        attribute float aGait; attribute float aPhase; attribute float aSpeed;`)
      .replace('#include <begin_vertex>', `
        vec3 p = position;
        {
          float gait = aGait;
          float ph = uTime * aSpeed + aPhase;
          vec3 ext = uMax - uMin;
          float ny = (p.y - uMin.y) / ext.y;   // 0 tail tip .. 1 nose
          float nz = (p.z - uMin.z) / ext.z;   // 0 feet .. 1 top
          // Legs: the lower half under the hips, left and right out of phase.
          if (nz < 0.5 && ny > 0.3 && ny < 0.7) {
            float side = p.x < 0.0 ? 0.0 : 3.14159;
            float w = 1.0 - nz / 0.5;
            float ang = sin(ph + side) * 0.6 * gait * w;
            vec2 hip = vec2(uMin.y + 0.5 * ext.y, uMin.z + 0.5 * ext.z);
            vec2 rel = p.yz - hip;
            float c = cos(ang), s = sin(ang);
            p.yz = hip + vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
          }
          // Tail sways side to side, more towards the tip.
          if (ny < 0.35) { float tt = (0.35 - ny) / 0.35; p.x += sin(ph * 0.5 + tt * 2.0) * 0.08 * ext.y * tt * (0.35 + 0.65 * gait); }
          // Head bobs with each step.
          if (ny > 0.7) { float tt = (ny - 0.7) / 0.3; p.z += sin(ph * 2.0) * 0.03 * ext.z * tt * gait; }
          // The whole body rises a little at each step.
          p.z += abs(sin(ph)) * 0.02 * ext.z * gait;
        }
        vec3 transformed = p;`);
  };
  return mat;
}

// Rock, bark, wood and concrete get a normal map whose alpha is a roughness:
// crevices rough, raised faces a little smoother (tools/derive_normals.py).
function addReliefMaps(mat, normalMap) {
  mat.normalMap = normalMap;
  mat.normalScale = new THREE.Vector2(0.9, 0.9);
  mat.roughness = 1;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n  roughnessFactor *= texture2D(normalMap, vNormalMapUv).a;');
  };
}

export async function loadLevel(base, onProgress = () => {}) {
  const [info, meshes, terrainBytes, hdList, nrmList] = await Promise.all([
    fetch(`${base}/level.json`).then((r) => r.json()),
    fetch(`${base}/meshes.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/terrain.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
    fetch(`${base}/hd.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    // Normal maps derived from the solid surfaces' own shading (tools/derive_normals.py);
    // desktop only, for the memory.
    (PHONE && !new URLSearchParams(location.search).has('hd')) || new URLSearchParams(location.search).get('nrm') === '0' ? [] : fetch(`${base}/nrm.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  const withNormals = new Set(nrmList);
  hd = hdList;
  onProgress('Building world…');

  const group = new THREE.Group();
  const textures = new Map();
  const materials = new Map();

  function materialFor(part) {
    const key = part.texture || `c${part.colour.join(',')}`;
    if (materials.has(key)) return materials.get(key);
    let mat;
    if (part.texture) {
      let tex = textures.get(part.texture);
      if (!tex) {
        tex = loadTexture(textureUrl(base, part.texture));
        textures.set(part.texture, tex);
      }
      // alphaTest keeps foliage cut-outs crisp without sorting transparent geometry.
      mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
      if (withNormals.has(part.texture)) addReliefMaps(mat, loadTexture(`${base}/nrm/${part.texture}.png`, false));
    } else {
      const [r, g, b] = part.colour;
      mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255), roughness: 0.8, metalness: 0 });
    }
    materials.set(key, mat);
    return mat;
  }

  // One geometry per model part; every placed copy becomes an instance of it.
  const partGeoms = new Map();
  for (const [key, model] of Object.entries(info.models)) {
    partGeoms.set(key, model.parts.map((p) => {
      const n = p.count;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(meshes, p.offset, n * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(meshes, p.offset + n * 12, n * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(meshes, p.offset + n * 24, n * 2), 2));
      geo.computeBoundingSphere();
      return { geo, mat: materialFor(p) };
    }));
  }

  // Debug switches: ?only=CTerrainObj or ?hide=CInstance,CTerrainObj
  const q = new URLSearchParams(location.search);
  const only = q.get('only')?.split(','), hide = q.get('hide')?.split(',');
  const byModel = new Map();
  info.instances.forEach((inst, idx) => (inst.index = idx));
  for (const inst of info.instances) {
    if (only && !only.includes(inst.cls)) continue;
    if (hide && hide.includes(inst.cls)) continue;
    // The original's far-sea sheets (scrolling water textures at sea level) are
    // replaced by the reflecting sea in main.js.
    if (info.sea != null && Math.abs(inst.pos[2] - info.sea) < 0.05 && inst.props && ('DeltaX' in inst.props || 'Anim00' in inst.props)) continue;
    // Prototype objects are parked far outside the playable area; leave them out.
    if (inst.name.startsWith('P') && Math.hypot(inst.pos[0], inst.pos[1] + 700) < 200) continue;
    if (!byModel.has(inst.model)) byModel.set(inst.model, []);
    byModel.get(inst.model).push(inst);
  }

  const refs = {};   // instance index -> [{ mesh, i }]
  const m4 = new THREE.Matrix4();
  const matrixOf = (inst) => {
    const r = inst.rot, s = inst.scale, p = inst.pos;
    return new THREE.Matrix4().set(r[0][0] * s, r[0][1] * s, r[0][2] * s, p[0],
                                   r[1][0] * s, r[1][1] * s, r[1][2] * s, p[1],
                                   r[2][0] * s, r[2][1] * s, r[2][2] * s, p[2],
                                   0, 0, 0, 1);
  };

  // Terrain objects are not drawn as geometry: they paint the terrain's texture.
  const decals = [];
  for (const [key, list] of byModel) {
    if (list[0].cls !== 'CTerrainObj') continue;
    for (const inst of list)
      for (const { geo, mat } of partGeoms.get(key) || [])
        decals.push({ geometry: geo, material: mat, matrix: matrixOf(inst), layer: inst.props.Height || 0 });
    byModel.delete(key);
  }

  // Water surfaces: the shared water shader, still (water.js).
  const waterMat = createWaterMaterial({ kind: 'pond' });
  let seaLevel = null, seaScale = 0;
  const animalMaterials = new Map();
  const windMaterials = new Map();   // base material uuid -> { mat, depth }
  const wind = new URLSearchParams(location.search).get('wind') !== '0';
  for (const [key, list] of byModel) {
    const isWater = list[0].cls === 'CEntityWater';
    // The level's own horizon-sea sheet is replaced by the reflecting sea (main.js).
    if (isWater && info.sea != null && list.every((i) => Math.abs(i.pos[2] - info.sea) < 0.01)) continue;
    const isAnimal = list[0].cls === 'CAnimal';
    // Model-space bounds of the whole animal, for the gait shader.
    let bounds = null;
    if (isAnimal) {
      bounds = new THREE.Box3();
      for (const { geo } of partGeoms.get(key) || []) { geo.computeBoundingBox(); bounds.union(geo.boundingBox); }
    }
    // The sea is the largest water surface; ponds sit higher inland.
    if (isWater) for (const inst of list) if (inst.scale > seaScale) { seaScale = inst.scale; seaLevel = inst.pos[2]; }
    // Plants sway in the wind (foliage.js); their parts carry a height-above-base attribute.
    const isPlantModel = wind && list[0].cls === 'CInstance' && isPlant(list[0].name);
    const parts = isPlantModel ? addWindAttributes(partGeoms.get(key) || []) : partGeoms.get(key) || [];
    for (const { geo, mat } of parts) {
      let material = isWater ? waterMat : mat;
      let depthMaterial = null;
      if (isPlantModel && mat.map) {
        if (!windMaterials.has(mat.uuid)) windMaterials.set(mat.uuid, { mat: windMaterial(mat, gaitUniforms.uTime), depth: windDepthMaterial(mat, gaitUniforms.uTime) });
        ({ mat: material, depth: depthMaterial } = windMaterials.get(mat.uuid));
      }
      if (isAnimal) {
        // Animals get their own copy of the material with the gait shader in it.
        // Keyed per animal as well: two species can share a skin texture but not
        // a body size, and the shader's bounds are the body's.
        const gk = `${key}|${mat.uuid}`;
        if (!animalMaterials.has(gk)) animalMaterials.set(gk, gaitMaterial(mat, bounds));
        material = animalMaterials.get(gk);
      }
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
      if (isAnimal) {
        mesh.geometry = geo.clone();
        mesh.geometry.setAttribute('aGait', new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1));
        mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(list.map(() => Math.random() * 6.28)), 1));
        mesh.geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(new Float32Array(list.map((i) => (/raptor/i.test(i.name) ? 9 : 2.2))), 1));
      }
      if (isWater) mesh.renderOrder = 10;
      else if (list[0].cls !== 'CSky') { mesh.castShadow = true; mesh.receiveShadow = true; }
      list.forEach((inst, i) => {
        (refs[inst.index] ||= []).push({ mesh, i });
        const r = inst.rot, s = inst.scale, p = inst.pos;
        m4.set(r[0][0] * s, r[0][1] * s, r[0][2] * s, p[0],
               r[1][0] * s, r[1][1] * s, r[1][2] * s, p[1],
               r[2][0] * s, r[2][1] * s, r[2][2] * s, p[2],
               0, 0, 0, 1);
        mesh.setMatrixAt(i, m4);
      });
      mesh.computeBoundingSphere();
      mesh.name = list[0].name;
      mesh.userData.cls = list[0].cls;
      group.add(mesh);
    }
  }

  let terrain = null;
  if (terrainBytes && info.terrain) {
    const nv = info.terrain.vertices, nt = info.terrain.triangles;
    const pos = new Float32Array(terrainBytes, 0, nv * 3);
    const idx = new Uint32Array(terrainBytes, nv * 12, nt * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    // Until terrain texturing is converted: colour by height and slope.
    const colours = new Float32Array(nv * 3);
    const nrm = geo.getAttribute('normal');
    const sand = new THREE.Color(0xc8b48a), grass = new THREE.Color(0x5d6b34), rock = new THREE.Color(0x6f675c);
    const c = new THREE.Color();
    for (let i = 0; i < nv; i++) {
      const z = pos[i * 3 + 2], up = nrm.getZ(i);
      c.copy(z < 6 ? sand : grass);
      if (z >= 6 && z < 9) c.lerpColors(sand, grass, (z - 6) / 3);
      if (up < 0.8) c.lerp(rock, Math.min(1, (0.8 - up) * 3));
      colours.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    terrain.receiveShadow = true;
    group.add(terrain);
  }

  await Promise.all(pending);
  return { group, info, terrain, decals, seaLevel, partGeoms, refs };
}
