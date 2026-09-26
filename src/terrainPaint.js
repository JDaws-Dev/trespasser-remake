// Terrain texturing, as Trespasser does it: the level's terrain objects are flat
// textured shapes, painted top-down into the terrain's texture in order of their
// "Height" (a layer number, not an elevation). Here they are painted once at load
// time into tiles with an orthographic camera, and each tile drapes over the part
// of the terrain mesh beneath it.
import * as THREE from 'three';

const TILE_METRES = 256;
const TILE_PIXELS = 512;   // 2 pixels per metre

// Up close the baked colour (2 px/m) would blur into mush, so a fine tileable
// grain and its normal map are laid over it at 0.4 m intervals; they fade out
// with distance so the horizon keeps the painted colour.
const DETAIL_METRES = 0.4;
let detail = null;
function detailTextures(renderer) {
  if (detail) return detail;
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const grain = loader.load('detail/grain.png');
  const normal = loader.load('detail/grain_n.png');
  for (const t of [grain, normal]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso; }
  normal.repeat.setScalar(TILE_METRES / DETAIL_METRES);
  detail = { grain, normal };
  return detail;
}

function terrainMaterial(renderer, map) {
  const { grain, normal } = detailTextures(renderer);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0, normalMap: normal, normalScale: new THREE.Vector2(0.35, 0.35) });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrain = { value: grain };
    shader.uniforms.uGrainRepeat = { value: TILE_METRES / DETAIL_METRES };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGrain; uniform float uGrainRepeat;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float g = texture2D(uGrain, vMapUv * uGrainRepeat).r * 2.0;
          float g2 = texture2D(uGrain, vMapUv * uGrainRepeat * 0.13 + 0.37).r * 2.0;   // a broader mottle
          float fade = 1.0 - smoothstep(30.0, 140.0, length(vViewPosition));
          diffuseColor.rgb *= mix(1.0, g * 0.85 + g2 * 0.15, 0.55 * fade);
        }`);
  };
  return mat;
}

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
      target.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

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
    }
  }
  renderer.setRenderTarget(prevTarget);
  return group;
}
