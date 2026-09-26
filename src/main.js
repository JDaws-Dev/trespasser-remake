// Trespasser, rebuilt for the browser: the original levels, meshes and textures
// (converted by tools/convert_level.py) rendered with three.js, playable with
// keyboard and mouse or with touch sticks on a phone.
import * as THREE from 'three';
import { loadLevel, textureUrl, gaitUniforms } from './level.js';
import { Input } from './input.js';
import { paintTerrain } from './terrainPaint.js';
import { buildCollider } from './collision.js';
import { createPhysics } from './physics.js';
import { Game } from './game.js';
import { Audio } from './audio.js';
import { Atmosphere, setupRenderer } from './atmosphere.js';
import { createPost } from './post.js';

const LEVEL = new URLSearchParams(location.search).get('level') || 'be';
const EYE_HEIGHT = 1.6;       // metres
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
const physics = await createPhysics({ info, terrain, partGeoms, refs, level: LEVEL });
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
game.showHint(input.touch ? 'Left stick walks, right stick looks. GRAB picks up a gun, FIRE shoots.' : 'WASD walk · Shift run · Space jump · E pick up · click to fire · G drop · Esc menu', 7);
window.__game = game;
game.physics = physics;
physics.attachGame(game);
const sfx = window.__sfx = new (await import('./sfx.js')).Sfx({ audio, game, physics, info, groundAt });   // collisions, footsteps, Anne's voice

const clock = new THREE.Clock();
const eye = new THREE.Vector3();
const lookEuler = new THREE.Euler(0, 0, 0, 'ZXY');

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const move = input.poll(dt);
  gaitUniforms.uTime.value = clock.elapsedTime;
  game.update(dt, player, move);

  player.yaw -= move.look.x;
  player.pitch = THREE.MathUtils.clamp(player.pitch - move.look.y, -1.45, 1.45);

  // Walk relative to where Anne faces (yaw 0 looks along +Y).
  const speed = move.run ? RUN : WALK;
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
  eye.set(player.pos.x, player.pos.y, player.pos.z + EYE_HEIGHT).applyMatrix4(world.matrixWorld);
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
});
