// Terrain texturing, as Trespasser does it: the level's terrain objects are flat
// textured shapes, painted top-down into the terrain's texture in order of their
// "Height" (a layer number, not an elevation). Here they are painted once at load
// time into tiles with an orthographic camera, and each tile drapes over the part
// of the terrain mesh beneath it.
import * as THREE from 'three';

const TILE_METRES = 256;
const TILE_PIXELS = 512;   // 2 pixels per metre

export function paintTerrain(renderer, terrainMesh, decals) {
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
  const prevTarget = renderer.getRenderTarget();
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const tris = buckets[ty * nx + tx];
      if (!tris.length) continue;
      const left = x0 + tx * TILE_METRES, bottom = y0 + ty * TILE_METRES;
      const target = new THREE.WebGLRenderTarget(TILE_PIXELS, TILE_PIXELS, {
        generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, colorSpace: THREE.SRGBColorSpace,
      });
      cam.left = left; cam.right = left + TILE_METRES; cam.bottom = bottom; cam.top = bottom + TILE_METRES;
      cam.position.set(0, 0, 500);
      cam.updateProjectionMatrix();
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;

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
      const mesh = new THREE.Mesh(piece, new THREE.MeshLambertMaterial({ map: target.texture }));
      group.add(mesh);
    }
  }
  renderer.setRenderTarget(prevTarget);
  return group;
}
