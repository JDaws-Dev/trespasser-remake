// Water: the open sea and the inland ponds, drawn with one shader.
//
// The sea is a grid centred on the player — fine near the feet, stretching to
// the horizon — displaced by a sum of Gerstner waves. Every pixel gets the
// waves' own normal plus two layers of drifting ripples, a Fresnel blend
// between the water body and the reflected sky (a planar mirror on desktop, a
// cube of the sky dome on phones and ponds), a sun glint, and colour absorbed
// with depth: turquoise over sand in the shallows, dark blue-green offshore.
// Depth comes from a top-down height map of the terrain, rasterised once at
// load; it also calms the waves in the shallows and draws the foam at the shore.
//
// All of it works in three.js scene space (Y up): game (x, y, z) is scene
// (x, z, -y).
import * as THREE from 'three';

const q = new URLSearchParams(location.search);
export const WATER_PHONE = !q.has('hd') &&
  (matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent));

// Shared by every water material: the sea and all ponds read the same clock,
// sun, terrain height map and sky.
export const waterUniforms = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(0xfff0dc).multiplyScalar(2.6) },
  uHeight: { value: null },
  uHeightRect: { value: new THREE.Vector4(0, 0, 1, 1) },   // game minX, minY, 1/width, 1/height
  uEnv: { value: null },
  uNormals: { value: null },
};

// Waves: direction (scene xz), wavelength (m), amplitude (m). A lagoon swell
// from the south-east with shorter chop across it.
function waveSet(count) {
  const base = [
    [0.0, 23, 0.14], [0.55, 14.3, 0.085], [-0.45, 9.7, 0.06], [0.9, 6.6, 0.04],
    [-0.8, 4.4, 0.028], [0.3, 3.1, 0.018], [-0.25, 2.1, 0.012], [1.2, 1.45, 0.008],
  ];
  const main = 2.3;   // radians, in scene xz
  return base.slice(0, count).map(([a, l, amp]) => new THREE.Vector4(Math.cos(main + a), Math.sin(main + a), l, amp));
}

const common = /* glsl */`
  uniform float uTime;
  uniform sampler2D uHeight;
  uniform vec4 uHeightRect;
  uniform vec4 uWaves[NWAVES];
  uniform float uWaveScale;

  // Terrain height (scene y) under a scene-space xz point: exact, and smoothed
  // over a few metres (the original's seabed is coarse, terraced polygons). The
  // seabed falls away to deep water near the map's edge and beyond it.
  vec2 terrainHeight(vec2 xz) {
    vec2 uv = (vec2(xz.x, -xz.y) - uHeightRect.xy) * uHeightRect.zw;
    vec2 edge = min(uv, 1.0 - uv) / uHeightRect.zw;
    float fall = smoothstep(0.0, 250.0, min(edge.x, edge.y));
    return mix(vec2(-60.0), texture2D(uHeight, clamp(uv, 0.0, 1.0)).rg, fall);
  }

  float wavePhase(int i, vec4 w, vec2 p, out float k) {
    k = 6.2831853 / w.z;
    return k * (dot(w.xy, p) - sqrt(9.8 / k) * uTime) + float(i) * 1.93;
  }
`;

const vertexShader = /* glsl */`
  ${common}
  uniform mat4 uMirrorMatrix;
  uniform float uWaveFar;
  varying vec3 vWorld;
  varying vec2 vFlat;
  varying float vLevel;
  varying vec4 vMirror;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>

  void main() {
    #ifdef USE_INSTANCING
      vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 wp = modelMatrix * vec4(position, 1.0);
    #endif
    vFlat = wp.xz;
    vLevel = wp.y;
    #if VWAVES > 0
      // Waves shrink to nothing in the shallows and far off (where the grid is coarse).
      float depth = wp.y - terrainHeight(wp.xz).y;
      float damp = smoothstep(0.05, 3.0, depth) * (1.0 - smoothstep(uWaveFar * 0.6, uWaveFar, distance(wp.xz, cameraPosition.xz))) * uWaveScale;
      vec3 d = vec3(0.0);
      for (int i = 0; i < VWAVES; i++) {
        vec4 w = uWaves[i];
        float k; float f = wavePhase(i, w, wp.xz, k);
        float a = w.w * damp;
        float qa = 0.55 / (k * float(VWAVES)) * damp;   // Gerstner steepness, never looping
        d.xz += w.xy * (qa * cos(f));
        d.y += a * sin(f);
      }
      wp.xyz += d;
    #endif
    vWorld = wp.xyz;
    vMirror = uMirrorMatrix * wp;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */`
  ${common}
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform samplerCube uEnv;
  uniform sampler2D uNormals;
  uniform sampler2D uMirror;
  uniform vec3 uAbsorb;
  uniform vec3 uScatter;
  uniform vec3 uFloor;
  uniform float uRipple;
  uniform float uSkyVis;
  varying vec3 vWorld;
  varying vec2 vFlat;
  varying float vLevel;
  varying vec4 vMirror;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>

  vec3 ripple(vec2 uv) { return texture2D(uNormals, uv).rgb * 2.0 - 1.0; }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
  }
  float fbm(vec2 p) {
    #ifdef DETAIL2
      return vnoise(p) * 0.55 + vnoise(p * 2.1 + 7.3) * 0.3 + vnoise(p * 4.3 - 3.1) * 0.15;
    #else
      return vnoise(p) * 0.65 + vnoise(p * 2.3 + 7.3) * 0.35;
    #endif
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    vec2 ground = terrainHeight(vFlat);
    float depth = vLevel - ground.x;
    // Colour follows the smoothed seabed except right at the shore.
    float body = mix(depth, vLevel - ground.y, smoothstep(0.4, 2.5, depth));
    float calm = smoothstep(0.05, 3.0, vLevel - ground.y) * uWaveScale;

    // Wave slopes, each wave fading out once it is too small to resolve.
    vec2 slope = vec2(0.0);
    float crest = 0.0;
    for (int i = 0; i < NWAVES; i++) {
      vec4 w = uWaves[i];
      float k; float f = wavePhase(i, w, vFlat, k);
      float a = w.w * calm * (1.0 - smoothstep(w.z * 25.0, w.z * 90.0, dist));
      slope += w.xy * (k * a * cos(f));
      crest += a * sin(f);
    }
    // Ripples: two drifting layers of the normal map, softened with distance.
    vec2 t = vec2(uTime);
    vec3 r1 = ripple(mat2(0.8, 0.6, -0.6, 0.8) * vFlat / 4.7 + t * vec2(0.021, 0.013));
    #ifdef DETAIL2
      vec3 r2 = ripple(mat2(0.28, -0.96, 0.96, 0.28) * vFlat / 13.1 - t * vec2(0.009, -0.017));
      vec3 r3 = ripple(vFlat / 1.9 + t * vec2(-0.03, 0.041));
      vec2 rip = r1.xy * 0.55 + r2.xy * 0.6 + r3.xy * 0.3 * (1.0 - smoothstep(10.0, 40.0, dist));
    #else
      vec2 rip = r1.xy * 0.8;
    #endif
    rip *= uRipple * mix(1.0, 0.45, smoothstep(30.0, 600.0, dist)) * (0.35 + 0.65 * smoothstep(0.0, 1.0, depth));
    vec3 N = normalize(vec3(-slope.x + rip.x, 1.0, -slope.y - rip.y));

    #ifdef SEA
      bool below = !gl_FrontFacing;
    #else
      bool below = false;
    #endif
    if (below) N = -N;
    float cosV = max(dot(N, V), 0.0);
    // Schlick, water's 2% head-on.
    float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);

    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.01;                  // never below the horizon
    vec3 refl = textureCube(uEnv, vec3(-R.x, R.y, R.z)).rgb * uSkyVis;
    #ifdef MIRROR
      // The mirror holds the scene without the sky dome (alpha 0 where empty);
      // the sky comes from the cube. Far off, where the mirror goes dark
      // towards its own horizon, the cube takes over entirely.
      vec4 m = texture2D(uMirror, vMirror.xy / vMirror.w + N.xz * (0.004 + 1.4 / dist) * 1.2);
      m *= 1.0 - smoothstep(110.0, 240.0, dist);
      refl = m.rgb + refl * (1.0 - m.a);
    #endif

    // Light in the water: sun plus sky, scattered back by the water body.
    float sunUp = max(uSunDir.y, 0.0);
    vec3 light = uSunColor * sunUp * 0.45 + vec3(0.33, 0.42, 0.5);
    // Absorption along the view path through the water, down and back up.
    float path = body * (1.0 + 1.0 / max(V.y, 0.12));
    vec3 T = exp(-uAbsorb * max(path, 0.0));
    float Tavg = dot(T, vec3(1.0 / 3.0));
    vec3 inscatter = uScatter * light * (1.0 - T);
    // Blending can only dim what lies below by one number, so the colour tint
    // of absorption is folded in against the sandy floor the shallows lie on.
    inscatter += uFloor * light * (T - Tavg);
    // Sunlit wave crests glow a little where the light passes through them.
    inscatter += uScatter * uSunColor * 2.0 * max(crest, 0.0) * pow(max(dot(V, -uSunDir) * 0.5 + 0.5, 0.0), 3.0) * (1.0 - Tavg);

    float gloss = mix(1400.0, 300.0, smoothstep(50.0, 1500.0, dist));
    float RL = max(dot(R, uSunDir), 0.0);
    vec3 spec = uSunColor * (pow(RL, gloss) * gloss * 0.045 + pow(RL, 70.0) * 0.25) * mix(0.25, 1.0, F);

    vec3 col = max(inscatter, 0.0) * (1.0 - F) + refl * F + spec;
    float alpha = 1.0 - Tavg * (1.0 - F);

    // Foam: a lacy rim where the water thins to nothing, and a faint line
    // washing in and out just behind it.
    vec2 fp = vFlat * 1.7;
    float lace = fbm(fp + t * vec2(0.11, 0.07)) * 0.65 + fbm(fp * 2.7 - t * vec2(0.05, -0.13)) * 0.35;
    float rim = (1.0 - smoothstep(0.0, 0.1, depth)) * smoothstep(0.38, 0.6, lace);
    float wash = 0.12 + 0.1 * sin(uTime * 0.9 + lace * 2.0);
    float line = (1.0 - smoothstep(0.0, 0.05, abs(depth - wash))) * (1.0 - smoothstep(0.1, 0.4, depth));
    float foam = max(rim * 0.8, line * smoothstep(0.45, 0.65, lace) * 0.6);
    #ifndef SEA
      foam = rim * 0.25;   // still water: no surf, only a little scum at the edge
    #endif
    vec3 foamCol = vec3(0.92, 0.95, 0.95) * (uSunColor * sunUp * 0.45 + vec3(0.3, 0.36, 0.42));
    col = mix(col, foamCol, foam);
    alpha = mix(alpha, 1.0, foam);

    if (below) {
      // Seen from underneath: the dark body of the sea, with the bright window of
      // sky overhead.
      float window = smoothstep(0.62, 0.75, cosV);
      col = mix(uScatter * light * 0.8, refl * 0.6 + uScatter * light, window);
      alpha = 1.0;
    }

    // The water fades out as it thins to nothing at the edge.
    float edge = smoothstep(0.0, 0.03, depth);
    col *= edge; alpha *= edge;

    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      // Premultiplied: what shows through is already fogged at about this depth.
      col = col * (1.0 - fogF) + fogColor * fogF * alpha;
    #endif
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// kind: 'sea' (waves, mirror on desktop) or 'pond' (still, ripples only).
export function createWaterMaterial({ kind = 'pond', mirror = null } = {}) {
  const phone = WATER_PHONE, sea = kind === 'sea';
  const nWaves = phone ? 4 : 8;
  const defines = { NWAVES: nWaves, VWAVES: sea ? (phone ? 3 : 6) : 0 };
  if (!phone) defines.DETAIL2 = '';
  if (mirror) defines.MIRROR = '';
  if (sea) defines.SEA = '';
  const material = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      ...THREE.UniformsLib.fog,
      ...waterUniforms,
      uWaves: { value: waveSet(nWaves) },
      uWaveScale: { value: sea ? 1 : 0.06 },
      uWaveFar: { value: phone ? 60 : 90 },
      uRipple: { value: sea ? 0.14 : 0.07 },
      // Ponds sit among trees, which hide much of the sky they would reflect.
      uSkyVis: { value: sea ? 1 : 0.45 },
      uMirror: { value: mirror ? mirror.texture : null },
      uMirrorMatrix: { value: mirror ? mirror.matrix : new THREE.Matrix4() },
      // Per metre: red goes first, then green; clear tropical water.
      uAbsorb: { value: sea ? new THREE.Vector3(0.42, 0.075, 0.065) : new THREE.Vector3(0.38, 0.2, 0.26) },
      uScatter: { value: sea ? new THREE.Color(0.012, 0.075, 0.085) : new THREE.Color(0.02, 0.05, 0.035) },
      uFloor: { value: new THREE.Color(0.32, 0.27, 0.18) },
    },
    vertexShader, fragmentShader,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Premultiplied: the shader dims what lies beneath by alpha and adds its own light.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return material;
}

// The terrain's height (game z) on a regular grid over its footprint, by
// rasterising its triangles on the CPU: deterministic and needs no float render
// targets (which phones may lack). Stored as half floats, which filter everywhere.
export function bakeHeightMap(terrain, res = 2048) {
  const geo = terrain.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const minX = bb.min.x, minY = bb.min.y, w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y;
  const heights = new Float32Array(res * res).fill(-200);
  const pos = geo.getAttribute('position').array, idx = geo.index.array;
  const sx = res / w, sy = res / h;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    // Texel space, texel centres at integer + 0.5.
    const ax = (pos[a] - minX) * sx, ay = (pos[a + 1] - minY) * sy, az = pos[a + 2];
    const bx = (pos[b] - minX) * sx, by = (pos[b + 1] - minY) * sy, bz = pos[b + 2];
    const cx = (pos[c] - minX) * sx, cy = (pos[c + 1] - minY) * sy, cz = pos[c + 2];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    for (let j = y0; j <= y1; j++) {
      const py = j + 0.5;
      for (let i = x0; i <= x1; i++) {
        const px = i + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const k = j * res + i;
        if (z > heights[k]) heights[k] = z;
      }
    }
  }
  const smooth = blur(blur(heights, res, 6), res, 6);
  const half = new Uint16Array(res * res * 2);
  for (let k = 0; k < res * res; k++) {
    half[k * 2] = THREE.DataUtils.toHalfFloat(heights[k]);
    half[k * 2 + 1] = THREE.DataUtils.toHalfFloat(smooth[k]);
  }
  const tex = new THREE.DataTexture(half, res, res, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  waterUniforms.uHeight.value = tex;
  waterUniforms.uHeightRect.value.set(minX, minY, 1 / w, 1 / h);
  return tex;
}

// Separable box blur of a square height grid, `r` texels each way.
function blur(src, res, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pass = (a, b, stride, step) => {
    for (let line = 0; line < res; line++) {
      const base = line * stride;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[base + Math.min(res - 1, Math.max(0, i)) * step];
      for (let i = 0; i < res; i++) {
        b[base + i * step] = sum / (2 * r + 1);
        sum += a[base + Math.min(res - 1, i + r + 1) * step] - a[base + Math.max(0, i - r) * step];
      }
    }
  };
  pass(src, tmp, res, 1);    // rows
  pass(tmp, out, 1, res);    // columns
  return out;
}

// A flat, far-off sea when there is no terrain to measure.
function flatHeightMap() {
  const h = THREE.DataUtils.toHalfFloat(-200);
  const tex = new THREE.DataTexture(new Uint16Array([h, h]), 1, 1, THREE.RGFormat, THREE.HalfFloatType);
  tex.needsUpdate = true;
  waterUniforms.uHeight.value = tex;
  return tex;
}

// The sky dome, captured once into a cube for reflections.
export function captureSky(renderer, sky) {
  const target = new THREE.WebGLCubeRenderTarget(WATER_PHONE ? 128 : 256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cam = new THREE.CubeCamera(1, 40000, target);
  const parent = sky.parent;
  const tmp = new THREE.Scene();
  tmp.add(sky);
  cam.update(renderer, tmp);
  if (parent) parent.add(sky);
  waterUniforms.uEnv.value = target.texture;
  return target;
}

export function loadWaterNormals(base = '.') {
  if (waterUniforms.uNormals.value) return waterUniforms.uNormals.value;
  const tex = new THREE.TextureLoader().load(`${base}/detail/water_n.png`);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  waterUniforms.uNormals.value = tex;
  return tex;
}

// Ponds are built while the level loads, before the sky and terrain are ready;
// their material is made now and its shared inputs filled in by setupWater.
export function setupWater({ renderer, sky, terrain, sunDir, base = '.' }) {
  loadWaterNormals(base);
  waterUniforms.uSunDir.value.copy(sunDir);
  if (terrain) bakeHeightMap(terrain, 2048); else flatHeightMap();
  captureSky(renderer, sky);
}

// A grid axis: even steps near the centre, then each step a little longer, out to `reach`.
function gridAxis(step, even, grow, reach) {
  const v = [0];
  let x = 0, s = step;
  for (let i = 1; x < reach; i++) {
    if (i > even) s *= grow;
    x = Math.min(reach, x + s);
    v.push(x);
  }
  return [...v.slice(1).map((a) => -a).reverse(), ...v];
}

function gridGeometry(step, even, grow, reach) {
  const ax = gridAxis(step, even, grow, reach), n = ax.length;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.set([ax[i], 0, ax[j]], (j * n + i) * 3);
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + n, c = a + 1, d = b + 1;   // wound to face +Y
    idx.set([a, b, c, c, b, d], k); k += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// A planar mirror of the scene about the sea surface (desktop only).
function makeMirror(renderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(Math.ceil(size.x / 2), Math.ceil(size.y / 2), { type: THREE.HalfFloatType });
  return { target, texture: target.texture, matrix: new THREE.Matrix4(), camera: new THREE.PerspectiveCamera() };
}

const _v = new THREE.Vector3(), _look = new THREE.Vector3(), _target = new THREE.Vector3(), _rot = new THREE.Matrix4();
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q = new THREE.Vector4(), _n = new THREE.Vector3(0, 1, 0);

function renderMirror(renderer, scene, camera, mirror, level, hide) {
  const mc = mirror.camera;
  const mirrorPos = _v.set(camera.position.x, level, camera.position.z);
  const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  if (camPos.y < level) return false;
  const view = new THREE.Vector3().copy(mirrorPos).sub(camPos).reflect(_n).negate().add(mirrorPos);
  _rot.extractRotation(camera.matrixWorld);
  _look.set(0, 0, -1).applyMatrix4(_rot).add(camPos);
  _target.copy(mirrorPos).sub(_look).reflect(_n).negate().add(mirrorPos);
  mc.position.copy(view);
  mc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
  mc.lookAt(_target);
  mc.far = camera.far;
  mc.updateMatrixWorld();
  mc.projectionMatrix.copy(camera.projectionMatrix);
  mirror.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  mirror.matrix.multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
  // Oblique near plane at the water, so nothing below it is reflected.
  _plane.setFromNormalAndCoplanarPoint(_n, _look.set(mirrorPos.x, level + 0.1, mirrorPos.z)).applyMatrix4(mc.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const p = mc.projectionMatrix.elements;
  _q.set((Math.sign(_clip.x) + p[8]) / p[0], (Math.sign(_clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
  _clip.multiplyScalar(2 / _clip.dot(_q));
  p[2] = _clip.x; p[6] = _clip.y; p[10] = _clip.z + 1 - 0.003; p[14] = _clip.w;

  const prevTarget = renderer.getRenderTarget(), prevShadow = renderer.shadowMap.autoUpdate;
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  for (const o of hide) o.visible = false;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(mirror.target);
  renderer.state.buffers.depth.setMask(true);
  renderer.clear();
  renderer.render(scene, mc);
  for (const o of hide) o.visible = true;
  renderer.shadowMap.autoUpdate = prevShadow;
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.setRenderTarget(prevTarget);
  return true;
}

// The open sea at `level` (game z), following `camera`.
export class Sea {
  constructor({ renderer, scene, camera, level, sky }) {
    this.scene = scene; this.camera = camera; this.level = level;
    const phone = WATER_PHONE;
    this.step = phone ? 1.0 : 0.6;
    const geo = phone ? gridGeometry(1.0, 32, 1.12, 4000) : gridGeometry(0.6, 64, 1.08, 4000);
    this.mirror = phone ? null : makeMirror(renderer);
    this.mesh = new THREE.Mesh(geo, createWaterMaterial({ kind: 'sea', mirror: this.mirror }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.position.y = level;
    this.mesh.name = 'sea';
    scene.add(this.mesh);
    if (this.mirror) {
      this.mesh.onBeforeRender = (r, s, cam) => {
        if (cam !== this.camera) return;
        const size = r.getDrawingBufferSize(_v);
        const w = Math.ceil(size.x / 2), h = Math.ceil(size.y / 2);
        if (this.mirror.target.width !== w || this.mirror.target.height !== h) this.mirror.target.setSize(w, h);
        renderMirror(r, s, cam, this.mirror, this.level, [this.mesh, this.overlay, sky].filter(Boolean));
      };
    }

    // Underwater: a murky tint in front of the eye and a thick blue-green fog.
    this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0x0b4a50, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, fog: false }));
    this.overlay.position.z = -0.06;
    this.overlay.renderOrder = 1000;
    this.overlay.visible = false;
    camera.add(this.overlay);
    this.underFog = new THREE.Color(0x0e4f58);
    this.savedFog = null;
  }

  update() {
    const cam = this.camera;
    this.mesh.position.x = Math.round(cam.position.x / this.step) * this.step;
    this.mesh.position.z = Math.round(cam.position.z / this.step) * this.step;
    const under = cam.position.y < this.level - 0.08;
    const fog = this.scene.fog;
    if (under && !this.savedFog && fog) {
      this.savedFog = { color: fog.color.clone(), density: fog.density };
      fog.color.copy(this.underFog); fog.density = 0.09;
    } else if (!under && this.savedFog) {
      fog.color.copy(this.savedFog.color); fog.density = this.savedFog.density;
      this.savedFog = null;
    }
    this.overlay.visible = under;
  }
}
