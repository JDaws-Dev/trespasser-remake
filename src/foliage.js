// Wind in the vegetation. Every plant model bends away from the wind by the
// square of its height above its own base (a palm's trunk stays planted, its
// crown sways), each placed copy on its own phase (from where it stands), with
// gusts that roll across the island; leaves also flutter along their normals.
// All of it is in the vertex shader of the plant's material, and in its shadow
// caster, so the shadows on the ground sway with the plants.
import * as THREE from 'three';

// Plants, by the original's naming: V (vegetation) models, less the dead wood,
// logs, stumps and the big terrain-block pieces that share the prefix.
const STILL = /tablk|stump|log|bolder|boulder|rock|fallen|ded|dead|broken|stick/i;
export function isPlant(name) { return /^v/i.test(name) && !STILL.test(name); }

// Wind blows from the sea; game space, Z up.
const WIND_DIR = new THREE.Vector2(0.8, 0.6).normalize();

// Per-vertex height above the model's base (0..1) and the model's height in
// model units, from the bounds of all of its parts.
export function addWindAttributes(parts) {
  const box = new THREE.Box3();
  for (const { geo } of parts) { geo.computeBoundingBox(); box.union(geo.boundingBox); }
  const height = Math.max(0.01, box.max.z - box.min.z);
  return parts.map(({ geo, mat }) => {
    // A new geometry over the same vertex buffers (the collider keeps the original).
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, geo.getAttribute(k));
    g.boundingSphere = geo.boundingSphere;
    const pos = g.getAttribute('position');
    const a = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { a[i * 2] = (pos.getZ(i) - box.min.z) / height; a[i * 2 + 1] = height; }
    g.setAttribute('aWind', new THREE.BufferAttribute(a, 2));
    return { geo: g, mat };
  });
}

const VERTEX_DECL = `
  uniform float uTime; uniform vec2 uWindDir;
  attribute vec2 aWind;`;

// transformed (model space) is displaced by an offset worked out in game space
// and taken back through the instance's rotation and scale.
const VERTEX_WIND = `
  #ifdef USE_INSTANCING
  {
    mat3 im = mat3(instanceMatrix);
    float s = length(im[0]);
    vec2 at = instanceMatrix[3].xy;
    float h = aWind.x, hm = aWind.y * s;                    // metres tall
    float ph = fract(sin(dot(at, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
    // Gusts roll across the island downwind; the plant leans more as they pass.
    float along = dot(at, uWindDir);
    float gust = 0.5 + 0.5 * sin(along * 0.035 - uTime * 0.9) * sin(along * 0.011 + uTime * 0.37 + 1.3);
    float freq = 3.2 / sqrt(hm + 1.0);                       // tall trees sway slower
    float sway = 0.55 + 0.45 * sin(uTime * freq + ph) + 0.15 * sin(uTime * freq * 2.3 + ph * 1.7);
    float bend = hm * (0.014 + 0.04 * gust) * sway * h * h;   // metres at this height
    vec3 off = vec3(uWindDir * bend, 0.0);
    // The crossways wobble that real crowns have.
    off.xy += vec2(-uWindDir.y, uWindDir.x) * hm * 0.006 * sin(uTime * freq * 1.3 + ph * 2.1) * h * h;
    off.z -= bend * bend / max(hm, 0.5) * 0.5;              // bending shortens the stem
    // Leaves flutter: fast, small, out of step across the crown.
    float fl = sin(uTime * (7.0 + 3.0 * gust) + dot(position, vec3(2.3, 1.7, 3.1)) / max(s, 0.01) + ph) * (0.02 + 0.05 * gust) * h;
    transformed += (transpose(im) * off) / (s * s) + normal * fl / s;
  }
  #endif`;

function hook(shader, time) {
  shader.uniforms.uTime = time;
  shader.uniforms.uWindDir = { value: WIND_DIR };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${VERTEX_DECL}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_WIND}`);
}

// A copy of a plant material that sways, and the matching shadow caster.
// customProgramCacheKey keeps three.js from sharing a program with the
// ordinary, still copy of the same material.
export function windMaterial(base, time) {
  const mat = base.clone();
  const baseHook = base.onBeforeCompile, baseKey = base.customProgramCacheKey();
  mat.onBeforeCompile = (shader, r) => { baseHook.call(mat, shader, r); hook(shader, time); };
  mat.customProgramCacheKey = () => `wind|${baseKey}`;
  return mat;
}

export function windDepthMaterial(base, time) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: base.map, alphaTest: base.alphaTest, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => hook(shader, time);
  mat.customProgramCacheKey = () => 'wind-depth';
  return mat;
}
