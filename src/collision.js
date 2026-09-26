// Static collision: the terrain plus every solid, unmoving object, merged into one
// mesh with a bounding-volume hierarchy. Anne is a capsule pushed out of whatever
// she overlaps each frame (the approach from three-mesh-bvh's character example).
// All in game coordinates (metres, Z up).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export function buildCollider(terrain, info, partGeoms) {
  const chunks = [];
  const pushGeometry = (geo, matrix) => {
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const v = new THREE.Vector3();
    const n = idx ? idx.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
      if (matrix) v.applyMatrix4(matrix);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out);
  };

  if (terrain) pushGeometry(terrain.geometry, null);

  const m = new THREE.Matrix4();
  for (const inst of info.instances) {
    const p = inst.props || {};
    // Solid scenery only: tangible, not movable, not a terrain decal or water.
    if (p.Tangible !== true || p.Moveable === true) continue;
    if (inst.cls === 'CTerrainObj' || inst.cls === 'CEntityWater') continue;
    const r = inst.rot, s = inst.scale, t = inst.pos;
    m.set(r[0][0] * s, r[0][1] * s, r[0][2] * s, t[0],
          r[1][0] * s, r[1][1] * s, r[1][2] * s, t[1],
          r[2][0] * s, r[2][1] * s, r[2][2] * s, t[2],
          0, 0, 0, 1);
    for (const { geo } of partGeoms.get(inst.model) || []) pushGeometry(geo, m);
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
  geo.boundsTree = new MeshBVH(geo);
  return geo;
}

const tmpBox = new THREE.Box3();
const tmpSeg = new THREE.Line3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const push = new THREE.Vector3();

// Move the capsule standing at `feet` by `delta`; returns whether it rests on ground.
export function moveCapsule(collider, feet, delta, radius = 0.3, height = 1.7) {
  // A move longer than the capsule is thin would pass through walls and floors:
  // take it in pieces.
  const len = delta.length();
  if (len > radius * 0.8) {
    const steps = Math.min(64, Math.ceil(len / (radius * 0.8)));
    const piece = delta.clone().divideScalar(steps);
    const start = feet.clone();
    let onGround = false;
    for (let i = 0; i < steps; i++) onGround = moveCapsule(collider, feet, piece, radius, height).onGround || onGround;
    return { onGround, moved: feet.clone().sub(start) };
  }
  const bvh = collider.boundsTree;
  const start = feet.clone();
  feet.add(delta);
  tmpSeg.start.set(feet.x, feet.y, feet.z + radius);
  tmpSeg.end.set(feet.x, feet.y, feet.z + height - radius);

  tmpBox.makeEmpty();
  tmpBox.expandByPoint(tmpSeg.start);
  tmpBox.expandByPoint(tmpSeg.end);
  tmpBox.min.addScalar(-radius);
  tmpBox.max.addScalar(radius);

  bvh.shapecast({
    intersectsBounds: (box) => box.intersectsBox(tmpBox),
    intersectsTriangle: (tri) => {
      const d = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
      if (d < radius) {
        push.subVectors(capPoint, triPoint).normalize().multiplyScalar(radius - d);
        tmpSeg.start.add(push);
        tmpSeg.end.add(push);
      }
    },
  });

  const resolved = new THREE.Vector3(tmpSeg.start.x, tmpSeg.start.y, tmpSeg.start.z - radius);
  const correction = resolved.clone().sub(feet);
  feet.copy(resolved);
  // Pushed up more than sideways, while trying to go down: standing on something.
  const onGround = correction.z > Math.abs(delta.z) * 0.25 && correction.z > 1e-4;
  return { onGround, moved: feet.clone().sub(start) };
}
