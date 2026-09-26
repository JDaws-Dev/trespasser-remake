// Light and air: a physical sky dome that also lights the scene (as an
// environment map), a sun with cascaded shadow maps, haze, and the sea as a
// reflecting, rippling surface. All of this lives in three.js scene space
// (Y up); the level itself sits under the rotated world root.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Sea, setupWater, waterUniforms } from './water.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export function setupRenderer(renderer) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

export class Atmosphere {
  constructor({ renderer, scene, camera, world, phone }) {
    this.scene = scene;
    this.phone = phone;
    // Mid-morning sun, from the south-east, in scene space (Y up).
    const elevation = 38, azimuth = 135;
    const phi = THREE.MathUtils.degToRad(90 - elevation), theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);

    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(this.sunDir);
    // Below the horizon the shader turns violet; hold the horizon colour there
    // so ripples that reflect a little below the horizon show haze, not violet.
    sky.material.fragmentShader = sky.material.fragmentShader.replace(
      'vec3 direction = normalize( vWorldPosition - cameraPosition );',
      'vec3 direction = normalize( vWorldPosition - cameraPosition ); direction.y = max( direction.y, 0.002 ); direction = normalize( direction );');
    scene.add(sky);
    this.sky = sky;

    // The dome doubles as the image-based light: soft blue from above, warm
    // bounce from the sun's side, and something for shiny surfaces to reflect.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky);
    // Below the horizon the dome is a dark violet; give the reflections a
    // haze-grey there instead, which is what grazing reflections of far water and
    // wet rock really see.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1e5, 1e5), new THREE.MeshBasicMaterial({ color: 0x93a0a8 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    const env = pmrem.fromScene(envScene, 0.02);
    scene.add(sky);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.7;
    pmrem.dispose();

    // Haze: the horizon colour of the dome, thickening with distance.
    const haze = new THREE.Color(0xc4d3de);
    scene.background = null;
    scene.fog = new THREE.FogExp2(haze, phone ? 0.0016 : 0.0011);

    // Sun and shadows. The cascades follow the camera; the phone gets two
    // smaller ones so it keeps its frame rate.
    this.csm = new CSM({
      camera, parent: scene,
      cascades: phone ? 2 : 3,
      maxFar: phone ? 140 : 320,
      mode: 'practical',
      shadowMapSize: phone ? 1024 : 2048,
      lightDirection: this.sunDir.clone().negate(),
      lightIntensity: 2.6,
      lightMargin: 150,
      shadowBias: -0.0002,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) { l.color.set(0xfff0dc); l.shadow.normalBias = 0.05; }

    scene.add(new THREE.HemisphereLight(0xbfd4ea, 0x6b5a3e, 0.35));
  }

  // Cascaded shadows are injected into every lit material; materials that
  // already hook the shader (the dinosaur gait) keep their hook.
  setupMaterial(material) {
    const prev = material.onBeforeCompile;
    // three.js keys compiled programs by the hook's source text, which after
    // wrapping is the same for every material: keep the original hook's key, or
    // a gait/wind/terrain material would share a plain material's program.
    const prevKey = material.customProgramCacheKey();
    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    material.onBeforeCompile = (shader, r) => { csmHook(shader, r); if (prev) prev(shader, r); };
    material.customProgramCacheKey = () => `csm|${prevKey}`;
    material.needsUpdate = true;
  }

  // Behind the loading screen, after renderer.compileAsync: three checks each
  // program's link status on its first use, which waits for the driver to finish
  // compiling it, and uploads each texture on its first draw. Doing both here
  // leaves the first frame only drawing.
  warm(renderer, scene) {
    for (const p of renderer.info.programs) p.getUniforms();
    const seen = new Set();
    scene.traverse((o) => {
      for (const m of [].concat(o.material || [], o.customDepthMaterial || []))
        for (const v of Object.values(m))
          if (v && v.isTexture && !v.isRenderTargetTexture && v.image && !seen.has(v)) { seen.add(v); renderer.initTexture(v); }
    });
  }

  // Water: the shared inputs every water surface reads (terrain depth, sky
  // reflection, sun), then the open sea where the level has one (`level`, game z;
  // null for none). See water.js.
  makeSea(world, level, textureUrlBase, { renderer, terrain } = {}) {
    setupWater({ renderer, sky: this.sky, terrain, sunDir: this.sunDir, base: textureUrlBase });
    if (level == null) return null;
    this.sea = new Sea({ renderer, scene: this.scene, camera: this.csm.camera, level, sky: this.sky });
    return this.sea.mesh;
  }

  update(dt) {
    this.csm.update();
    waterUniforms.uTime.value += dt;
    this.sea?.update();
  }
}
