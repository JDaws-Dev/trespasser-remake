// Trespasser, rebuilt for the browser: the original levels, meshes and textures
// (converted by tools/convert_level.py) rendered with three.js, playable with
// keyboard and mouse or with touch sticks on a phone.
import * as THREE from 'three';
import { loadLevel } from './level.js';
import { Input } from './input.js';
import { paintTerrain } from './terrainPaint.js';
import { buildCollider, moveCapsule } from './collision.js';

const LEVEL = new URLSearchParams(location.search).get('level') || 'be';
const EYE_HEIGHT = 1.6;       // metres
const WALK = 3.0, RUN = 6.5;  // metres per second
const GRAVITY = 9.8;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const skyColour = new THREE.Color(0xc9d6de);
scene.background = skyColour;
scene.fog = new THREE.Fog(skyColour, 60, 700);

// Trespasser is Z-up; three.js is Y-up. Everything from the level lives under
// this root, turned once, so game coordinates are used everywhere else.
const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);

scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5040, 1.4));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
sun.position.set(-0.4, 0.8, 0.3);
scene.add(sun);

// The sea: a flat plane at sea level stretching past the fog.
const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshLambertMaterial({ color: 0x2e6f78, transparent: true, opacity: 0.72, depthWrite: false }),
);
sea.renderOrder = 9;
world.add(sea);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 2000);
scene.add(camera);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const loading = document.getElementById('loading');
const hud = document.getElementById('hud');

const { group, info, terrain, decals, seaLevel, partGeoms } = await loadLevel(`levels/${LEVEL}`, (s) => (loading.textContent = s));
world.add(group);
// The open sea reaches the horizon at the level of the largest water surface.
sea.position.z = (seaLevel ?? 0) - 0.05;
if (terrain) {
  loading.textContent = 'Painting the terrain…';
  world.add(paintTerrain(renderer, terrain, decals));
  terrain.visible = false;   // still used for ground height
}
loading.textContent = 'Building collision…';
const collider = buildCollider(terrain, info, partGeoms);
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

window.__player = player;   // for automated tests
const input = new Input(renderer.domElement);
hud.textContent = input.touch ? 'Left stick to walk · right stick to look' : 'Click to look around · WASD to walk · Shift to run · Space to jump';
setTimeout(() => (hud.textContent = ''), 6000);

const clock = new THREE.Clock();
const eye = new THREE.Vector3();
const lookEuler = new THREE.Euler(0, 0, 0, 'ZXY');

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const move = input.poll(dt);

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
  // Short steps are taken whole; the capsule resolves against scenery and terrain.
  const { onGround } = moveCapsule(collider, player.pos, delta);
  if (onGround) player.vz = move.jump ? 4.2 : Math.max(player.vz, 0) * 0;
  // Safety net: never fall through the world.
  if (player.pos.z < -50) player.pos.z = groundAt(player.pos.x, player.pos.y) + 1;

  // Camera: game-space eye position and orientation, mapped through the world root.
  eye.set(player.pos.x, player.pos.y, player.pos.z + EYE_HEIGHT).applyMatrix4(world.matrixWorld);
  camera.position.copy(eye);
  lookEuler.set(Math.PI / 2 + player.pitch, 0, player.yaw);
  camera.quaternion.setFromEuler(lookEuler);
  camera.quaternion.premultiply(world.quaternion);

  renderer.render(scene, camera);
});
