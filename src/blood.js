// Blood: sprays of droplets and mist when a bullet or a bite lands, splats where
// they fall (on the ground and on whatever is behind the animal), wounds that stay
// on the animal and bleed, a pool that spreads under the dead, and splatter across
// Anne's view when she is bitten. Everything is pooled and capped: the oldest
// droplet or splat is recycled when the pool is full. Game coordinates (metres,
// Z up) under the world root; the textures are drawn here in code.
import * as THREE from 'three';

const PHONE = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);
const CAP = PHONE
  ? { drops: 400, mist: 40, decals: 60, wounds: 30, pools: 6, splatsPerBurst: 3, tex: 256 }
  : { drops: 2000, mist: 160, decals: 200, wounds: 120, pools: 16, splatsPerBurst: 7, tex: 512 };
const GRAVITY = 9.8;
const DECAL_LIFE = PHONE ? 60 : 120, DECAL_FADE = 25;   // seconds on the ground, then fading
const BLEED_TIME = 25;                                  // a wound drips this long

// Blood colours (sRGB): thin films are a brighter red, thick blood nearly black-red.
const THIN = [128, 12, 6], THICK = [58, 4, 3];

const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _fp = new THREE.Vector3(), _fq = new THREE.Quaternion(), _fs = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- Textures ----------

// An irregular blob: a circle whose radius wobbles with a few harmonics.
function blob(ctx, x, y, r, wobble = 0.25, seed = Math.random() * 100) {
  ctx.beginPath();
  const a = seed, b = seed * 1.7, c = seed * 2.3;
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const k = 1 + wobble * (0.55 * Math.sin(3 * t + a) + 0.3 * Math.sin(5 * t + b) + 0.2 * Math.sin(9 * t + c));
    const px = x + Math.cos(t) * r * k, py = y + Math.sin(t) * r * k;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.fill();
}

function ellipse(ctx, x, y, rx, ry, rot) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

// Splat shapes, drawn white on transparent into a square of side s at (x0, y0).
function drawSplat(ctx, x0, y0, s, kind) {
  ctx.save();
  ctx.translate(x0 + s / 2, y0 + s / 2);
  ctx.fillStyle = '#fff';
  if (kind === 'spray') {
    // A central splash with droplets thrown out all round.
    for (let i = 0; i < 8; i++) blob(ctx, rand(-0.08, 0.08) * s, rand(-0.08, 0.08) * s, rand(0.09, 0.18) * s, 0.35);
    for (let i = 0; i < 34; i++) {
      const t = Math.random() * Math.PI * 2, d = Math.pow(Math.random(), 0.8) * 0.4 * s;
      const r = Math.max(1, (0.04 - d / s * 0.07) * s * rand(0.5, 1.2));
      ellipse(ctx, Math.cos(t) * d, Math.sin(t) * d, r * rand(1, 2.4), r, t);
    }
    for (let i = 0; i < 9; i++) {   // streaks flung outward from the centre
      const t = Math.random() * Math.PI * 2, d = rand(0.12, 0.26) * s;
      ellipse(ctx, Math.cos(t) * d, Math.sin(t) * d, rand(0.06, 0.12) * s, rand(0.012, 0.025) * s, t);
    }
  } else if (kind === 'splash') {
    // Blood that hit at a glancing angle: a head and a tail of streaks along +X.
    blob(ctx, -0.18 * s, 0, 0.12 * s, 0.3);
    for (let i = 0; i < 40; i++) {
      const d = rand(-0.1, 0.44) * s, spread = (0.02 + Math.max(0, d / s) * 0.35) * s;
      const y = rand(-1, 1) * spread, r = rand(0.006, 0.022) * s * (1 - Math.max(0, d / s));
      ellipse(ctx, d, y, r * rand(1.5, 4), r, Math.atan2(y, d + 0.2 * s) * 0.6);
    }
    for (let i = 0; i < 6; i++) ellipse(ctx, rand(-0.05, 0.2) * s, rand(-0.06, 0.06) * s, rand(0.08, 0.16) * s, rand(0.015, 0.03) * s, rand(-0.2, 0.2));
  } else if (kind === 'drops') {
    // A scatter of separate drops, as blood dripping or raining down leaves.
    for (let i = 0; i < 22; i++) {
      const t = Math.random() * Math.PI * 2, d = Math.pow(Math.random(), 0.8) * 0.38 * s;
      blob(ctx, Math.cos(t) * d, Math.sin(t) * d, rand(0.012, 0.05) * s, 0.2);
    }
    blob(ctx, 0, 0, 0.09 * s, 0.3);
  } else if (kind === 'wound') {
    // An entry wound: a dark torn centre, blood smeared round it and running down (-Y).
    for (let i = 0; i < 5; i++) blob(ctx, rand(-0.04, 0.04) * s, rand(-0.04, 0.04) * s, rand(0.08, 0.14) * s, 0.4);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    for (let i = 0; i < 4; i++) {
      const x = rand(-0.1, 0.1) * s, len = rand(0.15, 0.36) * s;
      ctx.lineWidth = rand(0.018, 0.04) * s;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.quadraticCurveTo(x + rand(-0.03, 0.03) * s, len / 2, x + rand(-0.03, 0.03) * s, len); ctx.stroke();
      blob(ctx, x, len, ctx.lineWidth * 0.9, 0.15);
    }
    for (let i = 0; i < 18; i++) {
      const t = Math.random() * Math.PI * 2, d = rand(0.14, 0.3) * s;
      blob(ctx, Math.cos(t) * d, Math.sin(t) * d, rand(0.008, 0.022) * s, 0.2);
    }
  } else if (kind === 'pool') {
    // A spreading pool: a lobed disc with a ragged rim.
    for (let i = 0; i < 14; i++) {
      const t = Math.random() * Math.PI * 2, d = rand(0, 0.16) * s;
      blob(ctx, Math.cos(t) * d, Math.sin(t) * d, rand(0.16, 0.26) * s, 0.25);
    }
    for (let i = 0; i < 30; i++) {
      const t = Math.random() * Math.PI * 2, d = rand(0.36, 0.47) * s;
      blob(ctx, Math.cos(t) * d, Math.sin(t) * d, rand(0.006, 0.02) * s, 0.2);
    }
  }
  ctx.restore();
}

// Run jobs a slice at a time when the page is idle, so building the textures never
// holds up a frame (a slice is a few milliseconds at most).
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(fn, 16));
function runSliced(steps) {
  const next = () => {
    const t0 = performance.now();
    while (steps.length && performance.now() - t0 < 6) steps.shift()();
    if (steps.length) idle(next);
  };
  idle(next);
}

// A blood texture pair (colour with alpha, and a height map for the bump), made
// empty now so the materials are complete from the start, and painted later.
function bloodTextures(size) {
  const make = (srgb) => {
    const tex = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };
  return { size, map: make(true), bump: make(false) };
}

// Steps that paint a pair: draw the white-on-transparent mask (`draws`, one step
// each), then turn it into blood colour (alpha = mask) and a height map (the
// blurred mask: thick where the blood pooled), a band of rows per step.
function paintSteps(tex, draws, dark = 0) {
  const w = tex.size, h = tex.size;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  let mask, thick;
  const color = tex.map.image.data, height = tex.bump.image.data;
  const steps = draws.map((draw) => () => draw(ctx));
  steps.push(() => {
    mask = ctx.getImageData(0, 0, w, h).data;
    // Blur by shrinking and growing again (canvas filters are missing on older Safari).
    const small = document.createElement('canvas');
    small.width = w / 8; small.height = h / 8;
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    const big = document.createElement('canvas');
    big.width = w; big.height = h;
    const bc = big.getContext('2d');
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(small, 0, 0, w, h);
    thick = bc.getImageData(0, 0, w, h).data;
  });
  const band = 32;
  for (let y0 = 0; y0 < h; y0 += band) {
    steps.push(() => {
      for (let i = y0 * w, end = Math.min(h, y0 + band) * w; i < end; i++) {
        const a = mask[i * 4 + 3], t = Math.min(1, thick[i * 4 + 3] / 255 * 1.4 + dark);
        const n = 0.9 + Math.random() * 0.1;
        for (let c = 0; c < 3; c++) color[i * 4 + c] = (THIN[c] + (THICK[c] - THIN[c]) * t) * n;
        color[i * 4 + 3] = a;
        const hgt = Math.min(255, (a / 255) * (90 + t * 165));
        height[i * 4] = height[i * 4 + 1] = height[i * 4 + 2] = hgt; height[i * 4 + 3] = 255;
      }
    });
  }
  steps.push(() => { tex.map.needsUpdate = true; tex.bump.needsUpdate = true; });
  return steps;
}

// A 2x2 atlas: 0 spray, 1 splash (streaks along +X), 2 drops, 3 wound.
function atlasSteps(tex) {
  const s = tex.size / 2, pad = s * 0.04;
  return paintSteps(tex, ['spray', 'splash', 'drops', 'wound'].map((k, i) =>
    (ctx) => drawSplat(ctx, (i % 2) * s + pad, Math.floor(i / 2) * s + pad, s - 2 * pad, k)));
}

function poolSteps(tex) {
  const size = tex.size;
  return paintSteps(tex, [(ctx) => drawSplat(ctx, size * 0.02, size * 0.02, size * 0.96, 'pool')], 0.35);
}

// Soft, lumpy puff for the mist.
function makeMistTexture() {
  const n = 64, data = new Uint8Array(n * n * 4);
  const lumps = Array.from({ length: 6 }, () => [rand(-0.2, 0.2), rand(-0.2, 0.2), rand(0.15, 0.3)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n - 0.5, v = y / n - 0.5;
    let a = 0;
    for (const [cx, cy, r] of lumps) a = Math.max(a, 1 - Math.hypot(u - cx, v - cy) / r);
    a *= Math.max(0, 1 - Math.hypot(u, v) * 2);
    const i = (y * n + x) * 4;
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = Math.max(0, Math.min(255, a * 520));
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Blood on the lens: splashes around the edges with droplets flung inward and
// runs dripping down, the middle left clear. Hands `done` a CSS url().
function paintScreenSplatter(ctx, w, h) {
  const paint = (x, y, r) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.3);
    g.addColorStop(0, 'rgba(30,0,2,0.97)');
    g.addColorStop(0.6, 'rgba(62,2,4,0.95)');
    g.addColorStop(1, 'rgba(98,5,6,0.9)');
    ctx.fillStyle = g;
  };
  const splashes = 5 + Math.floor(Math.random() * 3);
  for (let k = 0; k < splashes; k++) {
    // A point on the border, more often in the corners and along the top.
    const side = Math.random();
    let x, y;
    if (side < 0.35) { x = rand(0, w); y = rand(-0.05, 0.08) * h; }
    else if (side < 0.55) { x = rand(-0.05, 0.08) * w; y = rand(0, h); }
    else if (side < 0.75) { x = rand(0.92, 1.05) * w; y = rand(0, h); }
    else { x = rand(0, w); y = rand(0.92, 1.05) * h; }
    const R = rand(0.05, 0.13) * h;
    paint(x, y, R);
    for (let i = 0; i < 3; i++) blob(ctx, x + rand(-0.5, 0.5) * R, y + rand(-0.5, 0.5) * R, R * rand(0.5, 0.9), 0.4);
    for (let i = 0; i < 10; i++) { const t = Math.random() * Math.PI * 2, d = R * rand(0.6, 1.1); blob(ctx, x + Math.cos(t) * d, y + Math.sin(t) * d, R * rand(0.08, 0.25), 0.4); }
    // Droplets flung toward the middle, stretched along their flight.
    const toC = Math.atan2(h / 2 - y, w / 2 - x);
    for (let i = 0; i < 26; i++) {
      const t = toC + rand(-0.9, 0.9), d = R * rand(0.9, 3.2), r = rand(1.2, 5) * (1.3 - d / (R * 3.2)) * (h / 540);
      paint(x + Math.cos(t) * d, y + Math.sin(t) * d, r * 2);
      ellipse(ctx, x + Math.cos(t) * d, y + Math.sin(t) * d, r * rand(1.2, 3), r, t);
    }
    // Runs: blood sliding down the glass, ending in a bead.
    const runs = y < h * 0.6 ? 2 + Math.floor(Math.random() * 3) : 0;
    for (let i = 0; i < runs; i++) {
      const rx = x + rand(-0.7, 0.7) * R, len = rand(0.08, 0.3) * h, lw = rand(3, 8) * (h / 540);
      ctx.strokeStyle = 'rgba(58,2,4,0.92)';
      ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(rx, y); ctx.lineTo(rx + rand(-4, 4), y + len); ctx.stroke();
      paint(rx, y + len, lw);
      blob(ctx, rx, y + len, lw * 0.9, 0.1);
    }
    // A wet highlight on the bigger splashes.
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,225,225,0.12)';
    ctx.shadowColor = 'rgba(255,220,220,0.3)'; ctx.shadowBlur = 6;
    ellipse(ctx, x - R * 0.25, y - R * 0.3, R * 0.25, R * 0.08, -0.5);
    ctx.restore();
  }
}

// The three lens-splatter images, handed to done(i, cssUrl) as they are ready: drawn
// in a worker where the browser can draw off the main thread, otherwise one per idle
// moment on it.
function makeScreenSplatters(w, h, done) {
  const onMain = () => runSliced([0, 1, 2].map((i) => () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    paintScreenSplatter(c.getContext('2d'), w, h);
    c.toBlob((b) => b && done(i, `url(${URL.createObjectURL(b)})`));
  }));
  if (typeof OffscreenCanvas === 'undefined' || !window.Worker) return onMain();
  try {
    // The worker gets the drawing functions' own source (names as bundled).
    const src = `const ${rand.name} = ${rand};\n${blob}\n${ellipse}\n${paintScreenSplatter}\n` +
      `onmessage = async ({ data: { w, h } }) => { for (let i = 0; i < 3; i++) {
        const c = new OffscreenCanvas(w, h); ${paintScreenSplatter.name}(c.getContext('2d'), w, h);
        postMessage({ i, blob: await c.convertToBlob() }); } };`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let got = 0;
    worker.onmessage = ({ data }) => {
      done(data.i, `url(${URL.createObjectURL(data.blob)})`);
      if (++got === 3) { worker.terminate(); URL.revokeObjectURL(url); }
    };
    worker.onerror = (e) => { e.preventDefault?.(); worker.terminate(); onMain(); };
    worker.postMessage({ w, h });
  } catch (e) {
    onMain();
  }
}

// Instanced materials read a per-instance attribute aFx: x = atlas tile (0..3),
// y = opacity. Direct sunlight is shared out over the shadow cascades' lights,
// since these materials are not wired into the cascades themselves.
function fxMaterial(mat, atlas) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aFx;\nvarying float vFxA;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vFxA = aFx.y;
        ${atlas ? `vec2 fxT = vec2(mod(aFx.x, 2.0), floor(aFx.x / 2.0 + 0.01)) * 0.5;
        #ifdef USE_MAP
          vMapUv = vMapUv * 0.5 + fxT;
        #endif
        #ifdef USE_BUMPMAP
          vBumpMapUv = vBumpMapUv * 0.5 + fxT;
        #endif` : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFxA;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= vFxA;')
      .replace('light.color = directionalLight.color;', 'light.color = directionalLight.color / float( NUM_DIR_LIGHTS );');
  };
  mat.customProgramCacheKey = () => `blood-fx-${atlas ? 1 : 0}`;
  return mat;
}

function instanced(geo, mat, count, world, renderOrder = 0) {
  const g = geo.clone();
  const fx = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
  fx.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aFx', fx);
  const mesh = new THREE.InstancedMesh(g, mat, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, ZERO);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  world.add(mesh);
  return mesh;
}

// A decal's orientation: facing along the surface normal n, its texture +X
// turned toward `along` (projected onto the surface), or spun at random.
function decalQuat(n, along, out) {
  out.setFromUnitVectors(Z, n);
  let angle;
  if (along) {
    _v.copy(along).addScaledVector(n, -along.dot(n));
    if (_v.lengthSq() > 1e-6) {
      _v.normalize();
      _v2.copy(X).applyQuaternion(out);
      angle = Math.atan2(_v2.clone().cross(_v).dot(n), _v2.dot(_v));
    }
  }
  if (angle === undefined) angle = Math.random() * Math.PI * 2;
  _q2.setFromAxisAngle(n, angle);
  return out.premultiply(_q2);
}

export class Blood {
  constructor(game) {
    this.game = game;
    const { world } = game;
    this.world = world;
    this.time = 0;
    this.last = 0;
    this.timeScale = 1;   // tests slow it down to look at a spray mid-flight

    // The splat textures are painted in idle moments after start (a splat made
    // before then appears once they are ready).
    const atlas = bloodTextures(CAP.tex), pool = bloodTextures(CAP.tex / 2);
    runSliced([...atlasSteps(atlas), ...poolSteps(pool)]);
    // Wet, but with a weaker sheen than a plain glossy surface: at full strength the
    // sky's reflection washes the red out to lilac.
    const SHEEN = { specularIntensity: 0.45, specularColor: new THREE.Color(1, 0.75, 0.72) };
    const wet = (map, bump, extra = {}) => fxMaterial(new THREE.MeshPhysicalMaterial({
      map, bumpMap: bump, bumpScale: 3, roughness: 0.3, metalness: 0, envMapIntensity: 0.35, ...SHEEN,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...extra,
    }), true);
    const quad = new THREE.PlaneGeometry(1, 1);

    // Flying droplets: small glossy drops stretched along their flight.
    const dropMat = fxMaterial(new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.07, 0.002, 0.0015), roughness: 0.15, metalness: 0, ...SHEEN }), false);
    this.drops = instanced(new THREE.SphereGeometry(1, PHONE ? 5 : 7, PHONE ? 3 : 5), dropMat, CAP.drops, world);
    const n = CAP.drops;
    this.dPos = new Float32Array(n * 3); this.dVel = new Float32Array(n * 3);
    this.dLife = new Float32Array(n); this.dSize = new Float32Array(n); this.dFloor = new Float32Array(n);
    this.dBurst = new Array(n).fill(null);
    this.dNext = 0;
    for (let i = 0; i < n; i++) this.drops.geometry.attributes.aFx.setXY(i, 0, 1);

    // Mist: a fine red haze that puffs out and thins.
    const mistMat = fxMaterial(new THREE.MeshBasicMaterial({ map: makeMistTexture(), color: new THREE.Color().setRGB(0.11, 0.004, 0.003),
      transparent: true, depthWrite: false }), false);
    this.mist = instanced(quad, mistMat, CAP.mist, world, 3);
    this.mist.userData = { pos: new Float32Array(CAP.mist * 3), vel: new Float32Array(CAP.mist * 3), age: new Float32Array(CAP.mist),
      life: new Float32Array(CAP.mist), size: new Float32Array(CAP.mist), grow: new Float32Array(CAP.mist), a: new Float32Array(CAP.mist),
      roll: new Float32Array(CAP.mist), next: 0 };

    // Splats on the ground and on scenery.
    this.decals = instanced(quad, wet(atlas.map, atlas.bump), CAP.decals, world, 2);
    this.decalRec = Array.from({ length: CAP.decals }, () => ({ on: false, pos: new THREE.Vector3(), q: new THREE.Quaternion(), size: 0, born: 0, tile: 0 }));
    this.decalNext = 0;

    // Wounds, carried on the animal.
    this.wounds = instanced(quad, wet(atlas.map, atlas.bump, { polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), CAP.wounds, world, 4);
    this.woundRec = Array.from({ length: CAP.wounds }, () => ({ on: false, dino: null, local: new THREE.Matrix4(), clot: new THREE.Matrix4(), size: 0, born: 0, drip: 0, trail: 0 }));
    this.woundNext = 0;
    // ...and a thin glossy bead of blood in each, so the wound catches the light from
    // the side as well as face on.
    this.clots = instanced(new THREE.SphereGeometry(1, 8, 6), dropMat, CAP.wounds, world);
    for (let i = 0; i < CAP.wounds; i++) this.clots.geometry.attributes.aFx.setXY(i, 0, 1);

    // Pools spreading under the dead.
    // (The pool texture is a single image, not the atlas.)
    this.pools = instanced(quad, fxMaterial(new THREE.MeshPhysicalMaterial({ ...SHEEN,
      map: pool.map, bumpMap: pool.bump, bumpScale: 2, roughness: 0.22, metalness: 0, envMapIntensity: 0.4,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }), false), CAP.pools, world, 1);
    this.poolRec = Array.from({ length: CAP.pools }, () => ({ on: false, pos: new THREE.Vector3(), q: new THREE.Quaternion(), r: 0, born: 0 }));
    this.poolNext = 0;

    // A drawable that draws nothing, so the effects advance every frame without a
    // hook in the main loop. It sorts first so the spray moves before it is drawn.
    const tickGeo = new THREE.BufferGeometry();
    tickGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const ticker = new THREE.Mesh(tickGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    ticker.frustumCulled = false;
    ticker.renderOrder = -1e6;
    ticker.onBeforeRender = () => this.tick();
    world.add(ticker);

    this.raycaster = new THREE.Raycaster();
    this.initScreen();
    window.__blood = this;   // for automated tests
  }

  // ---------- Hooks called by the game ----------

  // A bullet hit dinosaur d; `ray` is the shot (game space), `dist` how far along
  // it the hit sphere was met, `gun` the gun (its damage sizes the spray).
  shot(d, ray, dist, gun) {
    this.screenImagesSoon();
    const p = gun?.inst?.props || {};
    const power = THREE.MathUtils.clamp(((p.Damage || 10) * (p.DamageMultiplier || 1)) / 20, 0.5, 3);
    const hit = this.surfaceHit(d, ray, dist);
    const dir = ray.direction;
    // Exit spray along the bullet, a back-splash toward the shooter.
    this.spray(hit.point, dir, 0.55, rand(4, 8) * Math.sqrt(power), Math.round(70 * power), 0.024 * Math.sqrt(power));
    this.spray(hit.point, hit.normal, 0.8, rand(2, 4), Math.round(36 * power), 0.02);
    this.puff(hit.point, dir, Math.round(5 + 4 * power), 0.5 + 0.3 * power);
    this.addWound(d, hit.point, hit.normal, 0.26 + 0.08 * power);
    // A splash on the ground below and beyond the hit.
    this.splatAt(_v.copy(hit.point).addScaledVector(dir, rand(0.5, 1.5)).setZ(hit.point.z + 1), 0.8 + 0.4 * power, 1, dir);
    // What the exit spray hits behind the animal gets painted.
    this.paintAlong(hit.point, dir, 7, 0.5 + 0.25 * power, Math.ceil(power * 1.5));
  }

  // Dinosaur d has just died (already laid on its side).
  // The middle of the animal's body, wherever it is drawn (standing, laid down or
  // tumbling): the dinosaur AI's own answer if it has one, else its instance origin,
  // which is the body's centre (the models are body-centred).
  bodyCentre(d) {
    const c = this.game.ai?.bodyCentre?.(d);
    return c ? c.clone() : new THREE.Vector3().setFromMatrixPosition(this.dinoFrame(d, _m2));
  }

  kill(d) {
    const c = this.bodyCentre(d);
    const big = Math.min(3, d.radius / 1.2);
    for (let i = 0; i < 5; i++) {
      const dir = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(0.3, 1.2)).normalize();
      this.spray(c, dir, 0.7, rand(3, 7), Math.round(40 * big), 0.025 * Math.sqrt(big));
    }
    this.puff(c, Z, Math.round(8 * big), 0.8 * big);
    for (let i = 0; i < 4; i++) {
      const t = Math.random() * Math.PI * 2, r = rand(0.5, 2) * big;
      this.splatAt(new THREE.Vector3(c.x + Math.cos(t) * r, c.y + Math.sin(t) * r, c.z + 2), rand(0.9, 1.8) * big, Math.random() < 0.5 ? 0 : 2, null);
    }
    this.addPool(d);
  }

  // Raptor d bites Anne: blood bursts from its jaws and splashes the ground at her feet.
  bite(d, player) {
    this.screenImagesSoon();
    // The snout: d.jaw ahead of the body's centre (the models face +Y), up at head height.
    const k = d.scale / 2.478;
    const fx = -Math.sin(d.yaw), fy = Math.cos(d.yaw);
    const jaw = d.jaw ?? 1.3 * k, up = d.bounds ? d.bounds.max.z * d.scale * 0.75 : 0.3 * k;
    const mouth = new THREE.Vector3(d.pos.x + fx * jaw, d.pos.y + fy * jaw, d.pos.z + up);
    const toAnne = new THREE.Vector3(player.pos.x - mouth.x, player.pos.y - mouth.y, player.pos.z + 1.1 - mouth.z).normalize();
    const at = mouth.clone().addScaledVector(toAnne, 0.4);
    this.spray(at, toAnne.clone().negate().setZ(0.6).normalize(), 0.9, rand(2.5, 5), 70, 0.009);
    this.spray(at, new THREE.Vector3(0, 0, -1), 0.8, rand(1, 2.5), 30, 0.008);
    this.puff(at, toAnne.clone().negate(), 7, 0.45);
    for (let i = 0; i < 2; i++) {
      this.splatAt(new THREE.Vector3(player.pos.x + rand(-0.6, 0.6), player.pos.y + rand(-0.6, 0.6), player.pos.z + 2), rand(0.6, 1.1), i ? 2 : 0, null);
    }
  }

  // Anne takes `amount` damage: blood across the view.
  hurt(amount) {
    this.splatterScreen(Math.min(1, 0.45 + amount / 20));
  }

  // ---------- Spawning ----------

  // Where the shot really meets the animal's body: a ray against its mesh, or
  // failing that the point of the ray nearest the body's middle.
  surfaceHit(d, ray, dist) {
    // The game's hit test is a generous sphere: a shot can count without touching
    // the body. Then aim again from the gun at the body's middle, so the wound and
    // the spray land on the animal rather than in the air beside it.
    const centre = _v.setFromMatrixPosition(this.dinoFrame(d, _m2)).clone();
    return this.meshHit(d, ray.origin, ray.direction, dist + d.radius * 4)
      || this.meshHit(d, ray.origin, centre.clone().sub(ray.origin).normalize(), dist + d.radius * 4)
      || { point: centre, normal: ray.direction.clone().negate() };
  }

  // The nearest point where a ray (game space) meets the animal's own mesh.
  meshHit(d, origin, dir, far) {
    const w = this.world;
    w.updateMatrixWorld();
    const rc = this.raycaster;
    rc.ray.origin.copy(origin).applyMatrix4(w.matrixWorld);
    rc.ray.direction.copy(dir).transformDirection(w.matrixWorld);
    rc.near = 0; rc.far = far;
    let best = null, bestMesh = null, bestI = 0;
    for (const { mesh, i } of this.game.refs[d.index] || []) {
      mesh.computeBoundingSphere();   // the instances move about
      for (const h of rc.intersectObject(mesh, false)) {
        if (h.instanceId === i && (!best || h.distance < best.distance)) { best = h; bestMesh = mesh; bestI = i; }
      }
    }
    if (!best) return null;
    const point = w.worldToLocal(best.point.clone());
    const normal = dir.clone().negate();
    if (best.face) {
      normal.copy(best.face.normal);
      bestMesh.getMatrixAt(bestI, _m);
      _m.premultiply(bestMesh.matrixWorld);
      normal.transformDirection(_m).applyQuaternion(w.quaternion.clone().invert());
      if (normal.dot(dir) > 0) normal.negate();
    }
    return { point, normal };
  }


  // The surface under a point (terrain or scenery), from the collision mesh.
  below(p, far = 30) {
    const bvh = this.game.collider?.boundsTree;
    if (!bvh) { const z = this.game.groundAt(p.x, p.y); return { point: new THREE.Vector3(p.x, p.y, z), normal: Z.clone() }; }
    const hit = bvh.raycastFirst(new THREE.Ray(p.clone(), new THREE.Vector3(0, 0, -1)), THREE.DoubleSide, 0, far);
    if (!hit) return null;
    const n = hit.face ? hit.face.normal.clone() : Z.clone();
    if (n.z < 0) n.negate();
    return { point: hit.point.clone(), normal: n };
  }

  // A cone of droplets from p around dir (spread 0..1), at about `speed` m/s.
  spray(p, dir, spread, speed, count, size, splats = CAP.splatsPerBurst) {
    const floor = this.below(_v.copy(p).setZ(p.z + 0.5));
    const floorZ = floor ? floor.point.z : p.z - 50;
    const burst = { splats };
    if (PHONE) count = Math.ceil(count * 0.35);
    const n = CAP.drops;
    for (let k = 0; k < count; k++) {
      const i = this.dNext; this.dNext = (this.dNext + 1) % n;
      _v.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(spread).add(dir).normalize();
      const s = speed * rand(0.35, 1.25);
      this.dPos[i * 3] = p.x + rand(-0.04, 0.04); this.dPos[i * 3 + 1] = p.y + rand(-0.04, 0.04); this.dPos[i * 3 + 2] = p.z + rand(-0.04, 0.04);
      this.dVel[i * 3] = _v.x * s; this.dVel[i * 3 + 1] = _v.y * s; this.dVel[i * 3 + 2] = _v.z * s + rand(0, 1.2);
      this.dLife[i] = rand(1.2, 2.6);
      this.dSize[i] = size * rand(0.3, 1.1) * (PHONE ? 1.5 : 1);
      this.dFloor[i] = floorZ;
      this.dBurst[i] = burst;
    }
  }

  puff(p, dir, count, size) {
    const m = this.mist.userData;
    if (PHONE) count = Math.ceil(count * 0.5);
    for (let k = 0; k < count; k++) {
      const i = m.next; m.next = (m.next + 1) % CAP.mist;
      const s = rand(0.3, 1.6);
      m.pos[i * 3] = p.x; m.pos[i * 3 + 1] = p.y; m.pos[i * 3 + 2] = p.z;
      m.vel[i * 3] = (dir.x + rand(-0.6, 0.6)) * s; m.vel[i * 3 + 1] = (dir.y + rand(-0.6, 0.6)) * s; m.vel[i * 3 + 2] = (dir.z + rand(-0.3, 0.6)) * s;
      m.age[i] = 0; m.life[i] = rand(0.5, 1.1);
      m.size[i] = size * rand(0.4, 0.9); m.grow[i] = size * rand(1.2, 2.4);
      m.a[i] = rand(0.7, 1); m.roll[i] = Math.random() * Math.PI * 2;
    }
  }

  // A splat on the surface found straight down from p.
  splatAt(p, size, tile, along) {
    const s = this.below(p, 6);
    if (s) this.addDecal(s.point, s.normal, size, tile, along);
  }

  // Paint whatever the ray from p along dir meets within `far` (a tree, a wall).
  paintAlong(p, dir, far, size, count) {
    const bvh = this.game.collider?.boundsTree;
    if (!bvh) return;
    const hit = bvh.raycastFirst(new THREE.Ray(p.clone(), dir.clone()), THREE.DoubleSide, 0, far);
    if (!hit || !hit.face) return;
    const n = hit.face.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    const q = hit.point.clone();
    for (let k = 0; k < count; k++) {
      this.addDecal(q.clone().add(_v2.set(rand(-0.3, 0.3), rand(-0.3, 0.3), rand(-0.3, 0.3)).addScaledVector(n, -_v2.dot(n))),
        n, size * rand(0.7, 1.3), k === 0 ? 1 : 0, dir);
    }
  }

  addDecal(point, normal, size, tile, along) {
    const i = this.decalNext; this.decalNext = (this.decalNext + 1) % CAP.decals;
    const r = this.decalRec[i];
    r.on = true; r.size = size; r.born = this.time; r.tile = tile;
    r.pos.copy(point).addScaledVector(normal, 0.015);
    decalQuat(normal, along, r.q);
    this.decals.geometry.attributes.aFx.setXY(i, tile, 1);
    this.decals.geometry.attributes.aFx.needsUpdate = true;
    this.placeDecal(i, 0.4);
  }

  placeDecal(i, grow) {
    const r = this.decalRec[i];
    _s.setScalar(r.size * grow);
    this.decals.setMatrixAt(i, _m.compose(r.pos, r.q, _s));
    this.decals.instanceMatrix.needsUpdate = true;
  }

  // The frame an animal's wounds ride in: wherever its instance is drawn (walking,
  // laid on its side, or tumbling as a body), without its scale.
  dinoFrame(d, out) {
    const ref = this.game.refs[d.index]?.[0];
    if (!ref) return out.makeRotationZ(d.yaw).setPosition(d.pos.x, d.pos.y, d.pos.z);
    ref.mesh.getMatrixAt(ref.i, out);
    out.decompose(_fp, _fq, _fs);
    return out.compose(_fp, _fq, _fs.set(1, 1, 1));
  }

  addWound(d, point, normal, size) {
    const i = this.woundNext; this.woundNext = (this.woundNext + 1) % CAP.wounds;
    const r = this.woundRec[i];
    r.on = true; r.dino = d; r.size = size; r.born = this.time; r.drip = rand(0.1, 0.4); r.trail = 0;
    // Oriented so the texture's runs (-Y) point down the animal's side.
    _q.setFromUnitVectors(Z, normal);
    _v.set(0, -1, 0).applyQuaternion(_q);
    _v2.set(0, 0, -1).addScaledVector(normal, normal.z);
    if (_v2.lengthSq() > 1e-4) {
      _v2.normalize();
      const a = Math.atan2(_v.clone().cross(_v2).dot(normal), _v.dot(_v2));
      _q.premultiply(_q2.setFromAxisAngle(normal, a));
    }
    _m.compose(_v.copy(point).addScaledVector(normal, 0.03), _q, _s.setScalar(size));
    r.local.copy(this.dinoFrame(d, _m2.clone()).invert()).multiply(_m);
    // The bead: centred on the skin (the smear floats 3 cm off it), under a centimetre proud.
    r.clot.copy(r.local).multiply(_m2.makeTranslation(0, 0, -0.03 / size)).multiply(_m.makeScale(0.2, 0.2, 0.008 / size));
    this.wounds.geometry.attributes.aFx.setXY(i, 3, 1);
    this.wounds.geometry.attributes.aFx.needsUpdate = true;
  }

  addPool(d) {
    const c = this.bodyCentre(d), s = this.below(c.setZ(c.z + 2), 10 + (d.foot || 0));
    if (!s) return;
    const i = this.poolNext; this.poolNext = (this.poolNext + 1) % CAP.pools;
    const r = this.poolRec[i];
    r.on = true; r.born = this.time; r.r = Math.min(9, d.radius * 2.2); r.dino = d;
    r.pos.copy(s.point).addScaledVector(s.normal, 0.01);
    decalQuat(s.normal, null, r.q);
    this.pools.geometry.attributes.aFx.setXY(i, 0, 1);
    this.pools.geometry.attributes.aFx.needsUpdate = true;
  }

  // ---------- Per frame ----------

  tick() {
    const now = performance.now();
    let dt = Math.min(0.05, (now - this.last) / 1000);
    if (dt < 0.002) return;   // drawn more than once this frame
    dt *= this.timeScale;
    this.last = now;
    if (this.game.ui?.paused && !this.game.dead) return;
    this.time += dt;
    this.stepDrops(dt);
    this.stepMist(dt);
    this.stepDecals();
    this.stepWounds(dt);
    this.stepPools();
    this.stepScreen();
    // A few seconds into play, make the lens splatter (in a worker) so the first bite has it.
    if (this.time > 3) this.screenImagesSoon();
  }

  stepDrops(dt) {
    const { dPos: P, dVel: V, dLife: L, dSize: S } = this;
    const drag = Math.exp(-1.2 * dt);
    // Drops right at the lens would fill the view as big beads: those are left to
    // the screen splatter.
    const eye = this.world.worldToLocal(_v2.copy(this.game.camera.position));
    const ex = eye.x, ey = eye.y, ez = eye.z;
    let live = false;
    for (let i = 0; i < CAP.drops; i++) {
      if (L[i] <= 0) continue;
      live = true;
      L[i] -= dt;
      V[i * 3 + 2] -= GRAVITY * dt;
      V[i * 3] *= drag; V[i * 3 + 1] *= drag; V[i * 3 + 2] *= drag;
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      if (P[i * 3 + 2] < this.dFloor[i]) { this.land(i); L[i] = 0; }
      if (L[i] <= 0) { this.drops.setMatrixAt(i, ZERO); continue; }
      const cx = P[i * 3] - ex, cy = P[i * 3 + 1] - ey, cz = P[i * 3 + 2] - ez;
      if (cx * cx + cy * cy + cz * cz < 0.36) { this.drops.setMatrixAt(i, ZERO); continue; }
      _v.set(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
      const speed = _v.length();
      _q.setFromUnitVectors(Y, speed > 1e-4 ? _v.divideScalar(speed) : Z);
      const r = S[i];
      _s.set(r, r * Math.min(4, 1 + speed * 0.35), r);
      this.drops.setMatrixAt(i, _m.compose(_v2.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), _q, _s));
    }
    if (live || this.dropsWereLive) this.drops.instanceMatrix.needsUpdate = true;
    this.dropsWereLive = live;
  }

  // A droplet hits the ground: some leave a splat, sized by the droplet.
  land(i) {
    const b = this.dBurst[i];
    if (!b || b.splats <= 0 || Math.random() > 0.35) return;
    b.splats--;
    const P = this.dPos, V = this.dVel;
    _v.set(V[i * 3], V[i * 3 + 1], 0);
    const along = _v.lengthSq() > 1 ? _v.clone() : null;
    const size = THREE.MathUtils.clamp(this.dSize[i] * rand(12, 26), 0.12, 0.9);
    this.splatAt(new THREE.Vector3(P[i * 3], P[i * 3 + 1], this.dFloor[i] + 1.5), size, along ? (Math.random() < 0.6 ? 1 : 0) : 2, along);
  }

  stepMist(dt) {
    const m = this.mist.userData, fx = this.mist.geometry.attributes.aFx;
    // Mist faces the camera: its orientation, brought into game space.
    _q2.copy(this.world.quaternion).invert().multiply(this.game.camera.quaternion);
    let live = false;
    for (let i = 0; i < CAP.mist; i++) {
      if (m.age[i] >= m.life[i]) continue;
      live = true;
      m.age[i] += dt;
      const t = m.age[i] / m.life[i];
      if (t >= 1) { this.mist.setMatrixAt(i, ZERO); continue; }
      const drag = Math.exp(-3 * dt);
      for (let c = 0; c < 3; c++) { m.vel[i * 3 + c] *= drag; m.pos[i * 3 + c] += m.vel[i * 3 + c] * dt; }
      m.pos[i * 3 + 2] -= 0.3 * dt;
      _q.setFromAxisAngle(Z, m.roll[i]).premultiply(_q2);
      _s.setScalar(m.size[i] + m.grow[i] * (1 - (1 - t) * (1 - t)));
      this.mist.setMatrixAt(i, _m.compose(_v.set(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]), _q, _s));
      fx.setXY(i, 0, m.a[i] * Math.pow(1 - t, 1.6));
    }
    if (live || this.mistWasLive) { this.mist.instanceMatrix.needsUpdate = true; fx.needsUpdate = true; }
    this.mistWasLive = live;
  }

  stepDecals() {
    const fx = this.decals.geometry.attributes.aFx;
    for (let i = 0; i < CAP.decals; i++) {
      const r = this.decalRec[i];
      if (!r.on) continue;
      const age = this.time - r.born;
      // Splats spread out as they land, then lie there drying.
      if (age < 0.3) this.placeDecal(i, 0.4 + 0.6 * Math.sqrt(age / 0.3));
      else if (age < 0.4) this.placeDecal(i, 1);
      if (age > DECAL_LIFE) {
        const a = 1 - (age - DECAL_LIFE) / DECAL_FADE;
        if (a <= 0) { r.on = false; this.decals.setMatrixAt(i, ZERO); this.decals.instanceMatrix.needsUpdate = true; }
        fx.setXY(i, r.tile, Math.max(0, a));
        fx.needsUpdate = true;
      }
    }
  }

  stepWounds(dt) {
    let moved = false;
    for (let i = 0; i < CAP.wounds; i++) {
      const r = this.woundRec[i];
      if (!r.on) continue;
      const d = r.dino;
      this.dinoFrame(d, _m).multiply(r.local);
      this.wounds.setMatrixAt(i, _m);
      this.clots.setMatrixAt(i, _m2.multiplyMatrices(this.dinoFrame(d, _m2), r.clot));
      moved = true;
      // Fresh wounds bleed: drops run off and fall, leaving a trail behind the animal.
      const age = this.time - r.born;
      if (age < BLEED_TIME) {
        r.drip -= dt;
        if (r.drip <= 0) {
          r.drip = rand(0.15, 0.5) * (1 + age / 8);
          _v.setFromMatrixPosition(_m);
          this.spray(_v.clone(), _v2.set(0, 0, -1), 0.3, 0.4, PHONE ? 3 : 2, 0.012, 0);
          r.trail -= 1;
          if (r.trail <= 0) {
            r.trail = d.alive ? 3 : 6;
            this.splatAt(_v.clone().setZ(_v.z + 0.5), rand(0.2, 0.4), 2, null);
          }
        }
      }
    }
    if (moved) { this.wounds.instanceMatrix.needsUpdate = true; this.clots.instanceMatrix.needsUpdate = true; }
  }

  stepPools() {
    for (let i = 0; i < CAP.pools; i++) {
      const r = this.poolRec[i];
      if (!r.on) continue;
      const age = this.time - r.born - 0.6;
      if (age > 40) continue;   // spread as far as it goes
      // While a tumbling body settles, the pool gathers under where it comes to rest.
      if (age < 3 && r.dino) {
        const c = this.bodyCentre(r.dino), s = this.below(c.setZ(c.z + 2), 10 + (r.dino.foot || 0));
        if (s) r.pos.copy(s.point).addScaledVector(s.normal, 0.01);
      }
      const k = age <= 0 ? 0.001 : 1 - Math.exp(-age / 9);
      _s.setScalar(r.r * 2 * k);
      this.pools.setMatrixAt(i, _m.compose(r.pos, r.q, _s));
      this.pools.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- Blood on the view ----------

  initScreen() {
    const layer = () => {
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'fixed', left: '0', top: '-2%', width: '100%', height: '104%', pointerEvents: 'none', opacity: '0',
        backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat', willChange: 'opacity, transform',
      });
      el.className = 'blood-screen';
      // Just above the game view, beneath the HUD and the menus.
      const canvas = document.querySelector('body > canvas');
      if (canvas) canvas.after(el); else document.body.appendChild(el);
      return el;
    };
    this.screen = [layer(), layer()];
    this.screenLow = layer();
    this.screenNext = 0;
    this.lowShown = -1;
    // The images are made a few seconds into play (see screenImagesSoon).
    this.screenImages = [];
  }

  // Start making the lens-splatter images (a few seconds into play, or at the first
  // blood if that comes sooner): small
  // (the browser scales them up; the edges are soft anyway) and off the main thread.
  screenImagesSoon() {
    if (this.screenStarted) return;
    this.screenStarted = true;
    makeScreenSplatters(PHONE ? 480 : 640, PHONE ? 270 : 360, (i, url) => {
      this.screenImages[i] = url;
      if (i === 2) this.screenLow.style.backgroundImage = url;
    });
  }

  splatterScreen(strength) {
    this.screenImagesSoon();
    if (!this.screenImages[0] || !this.screenImages[1]) return;
    const el = this.screen[this.screenNext];
    this.screenNext = (this.screenNext + 1) % this.screen.length;
    el.style.backgroundImage = this.screenImages[Math.floor(Math.random() * 2)];
    el.style.transform = `scaleX(${Math.random() < 0.5 ? -1 : 1}) translateY(0)`;
    el.style.transition = 'none';
    el.style.opacity = String(strength);
    void el.offsetWidth;
    // Holds a moment, then runs down the glass and fades.
    el.style.transition = 'opacity 2.6s ease-in 0.6s, transform 3.2s ease-in 0.2s';
    el.style.opacity = '0';
    el.style.transform = el.style.transform.replace('translateY(0)', 'translateY(1.8%)');
  }

  // Badly hurt, some of it stays.
  stepScreen() {
    const hp = this.game.hp;
    const low = hp > 0 && hp < 40 ? Math.round((1 - hp / 40) * 50) / 100 : hp <= 0 ? 0.8 : 0;
    if (low !== this.lowShown) {
      this.lowShown = low;
      this.screenLow.style.transition = 'opacity 1.2s';
      this.screenLow.style.opacity = String(low);
    }
  }
}
