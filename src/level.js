// Loads a level converted by tools/convert_level.py into a three.js scene graph.
// Everything is built in Trespasser's own coordinates (metres, Z up); the caller
// puts the returned group under a Y-up root.
import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();
const pending = [];

function loadTexture(url) {
  let done;
  pending.push(new Promise((resolve) => (done = resolve)));
  const tex = textureLoader.load(url, done, undefined, done);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export async function loadLevel(base, onProgress = () => {}) {
  const [info, meshes, terrainBytes] = await Promise.all([
    fetch(`${base}/level.json`).then((r) => r.json()),
    fetch(`${base}/meshes.bin`).then((r) => r.arrayBuffer()),
    fetch(`${base}/terrain.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)),
  ]);
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
        tex = loadTexture(`${base}/tex/${part.texture}.png`);
        textures.set(part.texture, tex);
      }
      // alphaTest keeps foliage cut-outs crisp without sorting transparent geometry.
      mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
    } else {
      const [r, g, b] = part.colour;
      mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255) });
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
  for (const inst of info.instances) {
    if (only && !only.includes(inst.cls)) continue;
    if (hide && hide.includes(inst.cls)) continue;
    // Prototype objects are parked far outside the playable area; leave them out.
    if (inst.name.startsWith('P') && Math.hypot(inst.pos[0], inst.pos[1] + 700) < 200) continue;
    if (!byModel.has(inst.model)) byModel.set(inst.model, []);
    byModel.get(inst.model).push(inst);
  }

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

  // Water surfaces: translucent, lit only a little, drawn after solid geometry.
  const waterMat = new THREE.MeshLambertMaterial({
    color: 0x2e6f78, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
  });
  let seaLevel = null, seaScale = 0;
  for (const [key, list] of byModel) {
    const isWater = list[0].cls === 'CEntityWater';
    // The sea is the largest water surface; ponds sit higher inland.
    if (isWater) for (const inst of list) if (inst.scale > seaScale) { seaScale = inst.scale; seaLevel = inst.pos[2]; }
    for (const { geo, mat } of partGeoms.get(key) || []) {
      const mesh = new THREE.InstancedMesh(geo, isWater ? waterMat : mat, list.length);
      if (isWater) mesh.renderOrder = 10;
      list.forEach((inst, i) => {
        const r = inst.rot, s = inst.scale, p = inst.pos;
        m4.set(r[0][0] * s, r[0][1] * s, r[0][2] * s, p[0],
               r[1][0] * s, r[1][1] * s, r[1][2] * s, p[1],
               r[2][0] * s, r[2][1] * s, r[2][2] * s, p[2],
               0, 0, 0, 1);
        mesh.setMatrixAt(i, m4);
      });
      mesh.computeBoundingSphere();
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
    terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    group.add(terrain);
  }

  await Promise.all(pending);
  return { group, info, terrain, decals, seaLevel, partGeoms };
}
