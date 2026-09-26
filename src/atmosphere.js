// Light and air: a physical sky dome that also lights the scene (as an
// environment map), a sun with cascaded shadow maps, haze, and the sea as a
// reflecting, rippling surface. All of this lives in three.js scene space
// (Y up); the level itself sits under the rotated world root.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
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
    scene.environmentIntensity = 0.55;
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

    scene.add(new THREE.HemisphereLight(0xbfd4ea, 0x6b5a3e, 0.45));
  }

  // Cascaded shadows are injected into every lit material; materials that
  // already hook the shader (the dinosaur gait) keep their hook.
  setupMaterial(material) {
    const prev = material.onBeforeCompile;
    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    material.onBeforeCompile = (shader, r) => { csmHook(shader, r); if (prev) prev(shader, r); };
    material.needsUpdate = true;
  }

  // The open sea: a reflecting plane with animated ripples, in game space (under
  // the world root, Z up).
  makeSea(world, level, textureUrlBase) {
    // A reflecting sea draws the whole scene a second time every frame; phones
    // get a plain translucent surface instead.
    if (this.phone && !new URLSearchParams(location.search).has('hd')) {
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000),
        new THREE.MeshStandardMaterial({ color: 0x2b8a8c, transparent: true, opacity: 0.8, roughness: 0.1, metalness: 0, depthWrite: false }));
      sea.position.z = level - 0.05;
      sea.renderOrder = 9;
      this.setupMaterial(sea.material);
      world.add(sea);
      return sea;
    }
    const normals = new THREE.TextureLoader().load(`${textureUrlBase}/detail/water_n.png`);
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    const water = new Water(new THREE.PlaneGeometry(20000, 20000), {
      textureWidth: this.phone ? 256 : 512,
      textureHeight: this.phone ? 256 : 512,
      waterNormals: normals,
      sunDirection: this.sunDir.clone(),
      sunColor: 0xfff0dc,
      waterColor: 0x2b8a8c,
      distortionScale: 1.6,
      fog: true,
      alpha: 0.8,
    });
    // Translucent, so the sandy lagoon floor shows through in the shallows.
    water.material.transparent = true;
    water.material.depthWrite = false;
    water.material.uniforms.size.value = 5.0;
    // Water reflects about 2% head-on, not the shader's 30%: the sea keeps its colour.
    water.material.fragmentShader = water.material.fragmentShader.replace('float rf0 = 0.3;', 'float rf0 = 0.04;');
    water.position.z = level - 0.05;
    water.renderOrder = 9;
    world.add(water);
    // Under the sea, a haze-coloured floor: where a ripple's reflection dips below
    // the horizon it sees this instead of the dark underside of the sky dome.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000),
      new THREE.MeshBasicMaterial({ color: this.scene.fog.color, fog: true }));
    floor.position.z = level - 3;
    world.add(floor);
    this.water = water;
    return water;
  }

  update(dt) {
    this.csm.update();
    if (this.water) this.water.material.uniforms.time.value += dt * 0.6;
  }
}
