// Trespasser, rebuilt for the browser: the original levels, meshes and textures
// (converted by tools/convert_level.py) rendered with three.js, playable with
// keyboard and mouse or with touch sticks on a phone.
import * as THREE from 'three';
import { loadLevel, textureUrl, gaitUniforms } from './level.js';
import { Input } from './input.js';
import { paintTerrain } from './terrainPaint.js';
import { buildCollider } from './collision.js';
import { createPhysics } from './physics.js';
import { HandControls } from './hand.js';
import { Game } from './game.js';
import { Triggers } from './triggers.js';
import { Audio } from './audio.js';
import { Atmosphere, setupRenderer } from './atmosphere.js';
import { createPost } from './post.js';

const LEVEL = new URLSearchParams(location.search).get('level') || 'be';
const EYE_HEIGHT = 1.6;       // metres
const CROUCH = 0.72;          // eye drop when crouching (PlayerSettings.fCrouchDist)
const WALK = 3.0, RUN = 6.5;  // metres per second
const GRAVITY = 9.8;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
setupRenderer(renderer);
const PHONE = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);

const scene = new THREE.Scene();

// Trespasser is Z-up; three.js is Y-up. Everything from the level lives under
// this root, turned once, so game coordinates are used everywhere else.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 4000);
scene.add(camera);
const atmosphere = new Atmosphere({ renderer, scene, camera, world, phone: PHONE });
const post = createPost({ renderer, scene, camera, phone: PHONE });

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const loading = document.getElementById('loading');
const hud = document.getElementById('hud');

const { group, info, terrain, decals, seaLevel, partGeoms, refs } = await loadLevel(`levels/${LEVEL}`, (s) => (loading.textContent = s));
world.add(group);

// The sky, as Trespasser draws it: a cloud texture tiled across a high flat plane
// that follows the player and fades into the fog towards the horizon.
const skyInst = info.instances.find((i) => i.cls === 'CSky');
const skyTex = skyInst && info.models[skyInst.model]?.parts[0]?.texture;
let skyPlane = null;
if (skyTex) {
  const tex = new THREE.TextureLoader().load(textureUrl(`levels/${LEVEL}`, skyTex));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.anisotropy = 8;
  // Drawn in the transparent pass so it lands over the sky dome (neither writes
  // depth); the haze takes over towards the horizon, where the dome shows below it.
  skyPlane = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: true, depthWrite: false, transparent: true }));
  skyPlane.renderOrder = -1;
  world.add(skyPlane);
}
// Water: terrain depth and sky reflection for every pond, and the open sea
// to the horizon where the level has one.
atmosphere.makeSea(world, info.sea, '.', { renderer, terrain });
// Every lit material takes the sun's cascaded shadows.
const lit = new Set();
group.traverse((o) => { if (o.material && o.material.isMeshStandardMaterial) lit.add(o.material); });
let painted = null;
if (terrain) {
  loading.textContent = 'Painting the terrain…';
  painted = paintTerrain(renderer, terrain, decals, { seaLevel: info.sea, water: group.children.filter((m) => m.userData.cls === 'CEntityWater') });
  painted.traverse((o) => { if (o.material) lit.add(o.material); });
  world.add(painted);
  terrain.visible = false;   // still used for ground height
}
for (const m of lit) atmosphere.setupMaterial(m);
loading.textContent = 'Building collision…';
const collider = buildCollider(terrain, info, partGeoms);   // for the game's line-of-fire tests
loading.textContent = 'Building physics…';
const physics = await createPhysics({ info, terrain, partGeoms, refs, level: LEVEL,
  onProgress: (f) => (loading.textContent = `Building physics… ${Math.round(f * 100)}%`) });
loading.remove();

// Player state, in game coordinates (x east, y north, z up).
const player = {
  pos: new THREE.Vector3(...(info.start ? info.start.pos : [0, 0, 20])),
  yaw: info.start ? info.start.heading : 0,
  pitch: 0,
  vz: 0,
};

// Ground height under a point: a ray straight down onto the terrain.
const ray = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);
const probe = new THREE.Vector3();
function groundAt(x, y) {
  if (!terrain) return 0;
  probe.set(x, y, 1000).applyMatrix4(world.matrixWorld);
  ray.set(probe, down);
  terrain.visible = true;
  const hit = ray.intersectObject(terrain, false)[0];
  terrain.visible = false;
  if (!hit) return 0;
  return world.worldToLocal(hit.point.clone()).z;
}

// Test hook: ?at=x,y[,yaw] starts somewhere else (ground height found on arrival).
const at = new URLSearchParams(location.search).get('at');
world.updateMatrixWorld(true);
if (at) {
  const [x, y, yaw] = at.split(',').map(Number);
  player.pos.set(x, y, groundAt(x, y) + 0.5);
  if (!Number.isNaN(yaw)) player.yaw = yaw;
}
window.__player = player; window.__scene = scene; window.__renderer = renderer; window.__camera = camera;   // for automated tests
const input = new Input(renderer.domElement);
const audio = new Audio(`levels/${LEVEL}`);
const game = new Game({ scene, world, camera, info, refs, collider, groundAt, hud, level: LEVEL, audio });
game.showHint(input.touch ? 'Left stick walks, right stick looks. GRAB picks up a gun, FIRE shoots.' : 'WASD walk · Shift run · Q jump · Z crouch · hold left mouse: move hand · right mouse grab · Space fire · F throw · E stow · Esc menu', 7);
window.__game = game;
game.physics = physics;
physics.attachGame(game);
new Triggers({ game, physics, player, audio, level: LEVEL, groundAt });   // the level's triggers (logic.json): game.logic
const handControls = new HandControls({ canvas: renderer.domElement, physics, input, touch: input.touch, camera, world });
const sfx = window.__sfx = new (await import('./sfx.js')).Sfx({ audio, game, physics, info, groundAt });   // collisions, footsteps, Anne's voice

const clock = new THREE.Clock();
const eye = new THREE.Vector3();
const lookEuler = new THREE.Euler(0, 0, 0, 'ZXY');

const frame = () => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const move = input.poll(dt);
  gaitUniforms.uTime.value = clock.elapsedTime;
  // The hand key raises Anne's hand before the game reads Grab / Use. In the modern
  // hand style the left button is look-and-click instead, the right button turns what
  // she holds, and on touch GRAB clicks on what is under the crosshair.
  const hc = handControls.poll(move);
  const modern = physics.handStyle === 'modern';
  if (modern) {
    if (move.touch && move.pickup) hc.click = true;
    move.pickup = false;
    // Left click fires the gun in her hand (held: automatics keep firing), unless the
    // crosshair is on something within reach to pick up, press or drag.
    if (hc.hand && physics.modern.wantsFire()) { move.fire = true; hc.click = false; }
  }
  physics.setArm(!modern && hc.hand, player);
  game.update(dt, player, move);

  let viewHeld = false;
  if (modern) viewHeld = physics.modern.update(player, { click: hc.click, down: hc.hand || (move.touch && move.pickup), rmb: hc.rmb, look: move.look, wheel: hc.wheel, dt });
  // With the hand raised the mouse (or right stick) moves Anne's hand, or with
  // Shift / Alt turns her wrist, instead of turning her head.
  if (viewHeld) {
    // Turning what she holds: the view stays put.
  } else if (physics.hand.aiming) {
    if (hc.rotate) physics.rotateWrist(move.look.x, move.look.y, hc.roll, hc.reset);
    else physics.moveHand(move.look.x, move.look.y, player);
  } else {
    player.yaw -= move.look.x;
    player.pitch = THREE.MathUtils.clamp(player.pitch - move.look.y, -1.45, 1.45);
  }
  // Crouch (the original's fCrouchDist) eases the eye down.
  player.crouch = THREE.MathUtils.lerp(player.crouch || 0, hc.crouch || physics.hand.autoCrouch ? CROUCH : 0, Math.min(1, dt * 10));

  // Walk relative to where Anne faces (yaw 0 looks along +Y).
  const speed = (move.run && (modern || !hc.rotate) ? RUN : WALK) * (hc.crouch ? 0.5 : 1);
  const fx = -Math.sin(player.yaw), fy = Math.cos(player.yaw);
  player.vz -= GRAVITY * dt;
  const delta = new THREE.Vector3(
    (fx * move.forward + fy * move.strafe) * speed * dt,
    (fy * move.forward - fx * move.strafe) * speed * dt,
    player.vz * dt,
  );
  // Anne's capsule slides along scenery and terrain, steps up and shoves loose objects.
  const onGround = physics.movePlayer(player, delta, dt);
  if (onGround) player.vz = move.jump ? 4.2 : 0;
  physics.playerVel = delta.divideScalar(Math.max(dt, 1e-3));
  physics.update(dt, player);
  sfx.update(dt, player);
  // Safety net: never fall through the world.
  if (player.pos.z < -50) player.pos.z = groundAt(player.pos.x, player.pos.y) + 1;

  // Camera: game-space eye position and orientation, mapped through the world root.
  eye.set(player.pos.x, player.pos.y, player.pos.z + EYE_HEIGHT - player.crouch).applyMatrix4(world.matrixWorld);
  camera.position.copy(eye);
  lookEuler.set(Math.PI / 2 + player.pitch, 0, player.yaw);
  camera.quaternion.setFromEuler(lookEuler);
  camera.quaternion.premultiply(world.quaternion);

  if (skyPlane) skyPlane.position.set(player.pos.x, player.pos.y, player.pos.z + 350);
  painted?.focus(player.pos.x, player.pos.y, player.pos.z);
  atmosphere.update(dt);
  audio.updateListener(new THREE.Vector3(player.pos.x, player.pos.y, player.pos.z + EYE_HEIGHT),
    new THREE.Vector3(-Math.sin(player.yaw), Math.cos(player.yaw), 0), new THREE.Vector3(0, 0, 1));
  post.render(dt);
};
// Compile every shader and upload every texture behind the loading screen, so the
// first frame doesn't freeze the page for seconds. On desktop the scene is drawn into
// the post-processing target, so compile for that target, not the canvas.
renderer.setRenderTarget(post.composer ? post.composer.readBuffer : null);
try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn('shader precompile:', e); }
renderer.setRenderTarget(null);
atmosphere.warm(renderer, scene);
frame();   // one frame here too: the shadow-map and post-pass shaders compileAsync can't reach
renderer.setAnimationLoop(frame);
window.__frame = frame;   // for automated tests: run one whole frame now
