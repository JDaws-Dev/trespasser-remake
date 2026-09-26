// A field of grass blades around the player, desktop only. The blades are one
// instanced mesh laid out once over a square that wraps around the player in the
// vertex shader, so walking never rebuilds anything. Each blade reads the ground
// under it from two small top-down maps of the terrain around the player (its
// painted colour, and its height), grows only where that colour is grass, takes
// its colour from it, and bends in the same wind as the plants (foliage.js).
import * as THREE from 'three';

const FIELD = 44;          // metres: the wrapping square (blades live within FIELD / 2)
const RADIUS = 21;         // blades shrink away towards this distance
const BLADES = 140000;
const MAP_METRES = 72, MAP_PIXELS = 256;   // the ground maps; redrawn when she strays 10 m
const RECENTRE = 10;

export class Grass {
  // bakeColour(target, left, bottom, size): paints the terrain's colour for that
  // square into target. terrainGeometry: the whole terrain, in game space.
  // water: the level's pond surfaces (instanced meshes, game space); no grass under them.
  constructor({ renderer, bakeColour, terrainGeometry, time, seaLevel = null, water = [] }) {
    this.renderer = renderer;
    this.bakeColour = bakeColour;
    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false };
    this.colour = new THREE.WebGLRenderTarget(MAP_PIXELS, MAP_PIXELS, { ...opts, colorSpace: THREE.SRGBColorSpace });
    // Heights relative to the player's, in half floats (centimetre steps within ±60 m).
    this.height = new THREE.WebGLRenderTarget(MAP_PIXELS, MAP_PIXELS, { ...opts, type: THREE.HalfFloatType, depthBuffer: true });
    this.heightScene = new THREE.Scene();
    this.heightMat = new THREE.ShaderMaterial({
      uniforms: { uBase: { value: 0 } },
      vertexShader: 'varying float vZ; void main() { vZ = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uBase; varying float vZ; void main() { gl_FragColor = vec4(vZ - uBase, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    this.heightScene.add(new THREE.Mesh(terrainGeometry, this.heightMat));
    // The highest pond surface over each point, relative to the player like the heights;
    // green marks where there is one.
    this.water = new THREE.WebGLRenderTarget(MAP_PIXELS, MAP_PIXELS, { ...opts, type: THREE.HalfFloatType, depthBuffer: true });
    this.waterScene = new THREE.Scene();
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { uBase: { value: 0 } },
      vertexShader: 'varying float vZ; void main() { vec4 p = modelMatrix * instanceMatrix * vec4(position, 1.0); vZ = p.z; gl_Position = projectionMatrix * viewMatrix * p; }',
      fragmentShader: 'uniform float uBase; varying float vZ; void main() { gl_FragColor = vec4(vZ - uBase, 1.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    for (const m of water) {
      const proxy = new THREE.InstancedMesh(m.geometry, this.waterMat, m.count);
      proxy.instanceMatrix = m.instanceMatrix;
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(m.matrix);
      proxy.frustumCulled = false;
      this.waterScene.add(proxy);
    }
    this.cam = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 2000);
    this.cam.position.set(0, 0, 1000);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(0, 0, 0);

    this.uniforms = {
      uTime: time,
      uCenter: { value: new THREE.Vector2() },
      uMap: { value: new THREE.Vector3(0, 0, MAP_METRES) },
      uBase: { value: 0 },
      uSea: { value: seaLevel ?? -1e5 },
      uColMap: { value: this.colour.texture },
      uHgtMap: { value: this.height.texture },
      uWaterMap: { value: this.water.texture },
    };

    // One blade: a tapering strip of three segments, x across (-0.5..0.5), y up (0..1).
    const g = new THREE.InstancedBufferGeometry();
    const ys = [0, 0.35, 0.7, 1];
    const pos = [], idx = [];
    ys.forEach((y, i) => {
      const w = 1 - y * 0.85;
      if (i < 3) pos.push(-0.5 * w, y, 0, 0.5 * w, y, 0);
      else pos.push(0, y, 0);
    });
    for (let i = 0; i < 2; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    idx.push(4, 5, 6);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    g.setIndex(idx);
    const blade = new Float32Array(BLADES * 4);
    for (let i = 0; i < BLADES; i++) blade.set([Math.random() * FIELD, Math.random() * FIELD, Math.random(), Math.random()], i * 4);
    g.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade, 4));
    g.instanceCount = BLADES;

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform vec2 uCenter; uniform vec3 uMap; uniform float uBase; uniform float uSea;
          uniform sampler2D uColMap; uniform sampler2D uHgtMap; uniform sampler2D uWaterMap;
          attribute vec4 aBlade;
          varying vec3 vGrassCol;`)
        .replace('#include <beginnormal_vertex>', `
          vec2 rel = mod(aBlade.xy - uCenter + ${(FIELD / 2).toFixed(1)}, ${FIELD.toFixed(1)}) - ${(FIELD / 2).toFixed(1)};
          vec2 wp = uCenter + rel;
          vec2 muv = (wp - uMap.xy) / uMap.z;
          vec3 gc = textureLod(uColMap, muv, 0.0).rgb;
          float gz = textureLod(uHgtMap, muv, 0.0).r + uBase;
          // Where the ground is painted grass, and how thickly.
          // (Not teal: the lagoon floor under the water is painted green-blue.)
          float grassy = smoothstep(0.37, 0.46, gc.g / (gc.r + gc.g + gc.b + 1e-4)) * smoothstep(0.012, 0.03, gc.g)
                       * (1.0 - smoothstep(0.4, 0.55, gc.b / (gc.g + 1e-4)));
          // Not under the sea or a pond (with a margin for the shore), nor on banks too steep to hold soil.
          vec2 pond = textureLod(uWaterMap, muv, 0.0).rg;
          const float px = 1.0 / ${MAP_PIXELS.toFixed(1)};
          vec2 slope = vec2(textureLod(uHgtMap, muv + vec2(px, 0.0), 0.0).r - textureLod(uHgtMap, muv - vec2(px, 0.0), 0.0).r,
                            textureLod(uHgtMap, muv + vec2(0.0, px), 0.0).r - textureLod(uHgtMap, muv - vec2(0.0, px), 0.0).r) / (2.0 * px * uMap.z);
          grassy *= step(uSea + 0.3, gz) * (1.0 - step(0.5, pond.g) * step(gz, pond.r + uBase + 0.3)) * (1.0 - smoothstep(0.7, 1.1, length(slope)));
          float d = length(rel);
          float keep = step(aBlade.w, grassy) * (1.0 - smoothstep(${(RADIUS * 0.4).toFixed(1)}, ${RADIUS.toFixed(1)}, d));
          float hgt = (0.18 + 0.38 * aBlade.z * aBlade.z) * keep;
          float ang = fract(aBlade.w * 91.7 + aBlade.z * 13.1) * 6.2831;
          vec2 side = vec2(cos(ang), sin(ang));
          float t = position.y;
          // Lean: each blade its own way, plus the wind with gusts (as foliage.js).
          vec2 lean = vec2(cos(ang * 3.1), sin(ang * 3.1)) * (0.15 + 0.25 * aBlade.z);
          vec2 wdir = normalize(vec2(0.8, 0.6));
          float along = dot(wp, wdir);
          float gust = 0.5 + 0.5 * sin(along * 0.035 - uTime * 0.9) * sin(along * 0.011 + uTime * 0.37 + 1.3);
          float sway = sin(uTime * 2.2 + along * 0.6 + aBlade.z * 5.0) * 0.5 + 0.5;
          lean += wdir * (0.1 + 0.45 * gust) * (0.5 + 0.5 * sway);
          vec3 grassPos = vec3(wp + side * position.x * 0.05 + lean * t * t * hgt, gz + t * hgt * (1.0 - 0.25 * dot(lean, lean)));
          vec3 objectNormal = normalize(vec3(vec2(-side.y, side.x) * 0.35 + lean * 0.3, 1.0));
          // Darker at the root, lighter and yellower towards the tip, as each blade varies.
          vec3 base = max(mix(vec3(dot(gc, vec3(0.2126, 0.7152, 0.0722))), gc, 1.15), 0.0) * (0.75 + 0.5 * aBlade.z);
          vGrassCol = mix(base * 0.75, base * 1.3, t);`)
        .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGrassCol;')
        // Both faces of a blade take the same, mostly upward normal: lit like the ground it grows from.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    };
    mat.customProgramCacheKey = () => 'grass';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'grass';
    this.centre = null;
    window.__grass = this;   // for automated tests
  }

  // x, y, z: the player, in game space.
  update(x, y, z) {
    this.uniforms.uCenter.value.set(x, y);
    if (this.centre && Math.hypot(x - this.centre.x, y - this.centre.y) < RECENTRE && Math.abs(z - this.centre.z) < 20) return;
    this.centre = { x, y, z };
    const left = x - MAP_METRES / 2, bottom = y - MAP_METRES / 2;
    this.uniforms.uMap.value.set(left, bottom, MAP_METRES);
    this.uniforms.uBase.value = z;
    const r = this.renderer, prev = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    this.bakeColour(this.colour, left, bottom, MAP_METRES);
    const c = this.cam;
    c.left = left; c.right = left + MAP_METRES; c.bottom = bottom; c.top = bottom + MAP_METRES;
    c.updateProjectionMatrix();
    this.heightMat.uniforms.uBase.value = z;
    r.setRenderTarget(this.height);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.heightScene, c);
    this.waterMat.uniforms.uBase.value = z;
    r.setRenderTarget(this.water);
    r.setClearColor(0x000000, 1);
    r.clear();
    if (this.waterScene.children.length) r.render(this.waterScene, c);
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prev);
  }
}
