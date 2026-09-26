// Post-processing: ambient occlusion in the creases, a faint bloom on the
// brightest highlights, then tone mapping and anti-aliasing. Desktop only by
// default — a phone renders straight to the screen with the canvas's own MSAA.
// ?fx=0 bypasses the chain everywhere, ?fx=1 forces it on a phone.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

// AO only means something up close: past this range (metres) the depth buffer
// is too coarse to reconstruct normals from, and haze covers it anyway.
const AO_FADE_NEAR = 35, AO_FADE_FAR = 70;

export function createPost({ renderer, scene, camera, phone }) {
  const fx = new URLSearchParams(location.search).get('fx');
  const enabled = fx === '1' || (fx !== '0' && !phone);
  if (!enabled) {
    return { enabled, render() { renderer.render(scene, camera); }, setSize() {} };
  }

  // The scene is drawn once, into a half-float target whose depth the AO reads
  // back, so alpha-tested leaves and the animated dinosaurs occlude exactly as
  // drawn (GTAOPass's own normal pass would redraw everything, leaves as solid cards).
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
  });
  const composer = new EffectComposer(renderer, target);   // clones the target, depth texture included

  composer.addPass(new RenderPass(scene, camera));

  // Ground-truth AO at half resolution, normals rebuilt from depth.
  const gtao = new GTAOPass(scene, camera, size.x / 2, size.y / 2);
  gtao.setGBuffer(target.depthTexture);   // not via the constructor: it assumes its own normal target exists
  gtao.updateGtaoMaterial({ radius: 0.8, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.85;
  gtao.gtaoMaterial.fragmentShader = gtao.gtaoMaterial.fragmentShader.replace(
    'ao = pow(ao, scale);',
    `ao = pow(ao, scale); ao = mix(ao, 1., smoothstep(${AO_FADE_NEAR.toFixed(1)}, ${AO_FADE_FAR.toFixed(1)}, -viewPos.z));`);
  const gtaoSetSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => gtaoSetSize(Math.ceil(w / 2), Math.ceil(h / 2));
  // The composer ping-pongs its two targets, so read depth from whichever one the scene went into.
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (r, writeBuffer, readBuffer, dt, mask) => {
    gtao.gtaoMaterial.uniforms.tDepth.value = readBuffer.depthTexture;
    gtao.pdMaterial.uniforms.tDepth.value = readBuffer.depthTexture;
    gtaoRender(r, writeBuffer, readBuffer, dt, mask);
  };
  composer.addPass(gtao);

  // Bloom works on the linear, un-tone-mapped light, so only true highlights
  // (sun glints on water and metal) pass the threshold.
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.12, 0.4, 0.9));

  // Tone mapping and sRGB happen here, once (the scene pass into a render target
  // gets neither). SMAA follows because its edge detection is tuned for
  // display-referred colour; it writes the result to the screen unchanged.
  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass(size.x, size.y));

  const post = {
    enabled,
    composer,
    gtao,
    render(dt) { composer.render(dt); },
    setSize(w, h) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
  };
  window.__post = post;   // for automated tests (gtao.output = 5 shows the denoised AO)
  return post;
}
