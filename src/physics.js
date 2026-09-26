// Rigid-body physics, as Trespasser had it: nearly every crate, barrel, plank, rock and
// gun is a body you can push, pick up with Anne's hand, stack, throw and shoot about.
// Rapier (WASM) does the simulation. Game coordinates throughout (metres, Z up).
//
// Shapes follow the original engine (Lib/Physics/InfoBox.cpp): an object's physics
// box is its mesh's extents, unless it is a compound, whose '$' sub-boxes are in
// levels/<lvl>/physics.json along with the level's magnets (joints). Mass is the
// `Mass` property, else box volume x `Density` (g/cm³, default 0.1); friction is the
// 0-10 `Friction` (default 5); bounce is `Elasticity` (default 0.2).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const STEP = 1 / 60;
const MAX_STEPS = 4;                  // per frame, so a slow frame never spirals
const LIFT_MAX = 100;                 // kg: PlayerSettings.fMaxMassPickup in the original
const REACH = 2.6;                    // metres from the eye
const PLAYER_R = 0.3, PLAYER_H = 1.7;
const DENSITY = 0.1, FRICTION = 5, ELASTICITY = 0.2;
// The hand (PlayerSettings in Player.cpp): reach, angle limits, grab distance, throw.
const HAND_REACH = 0.8, HAND_REACH_MAX = 0.95, HAND_GRAB = 0.2;
const HAND_PITCH = 75 * Math.PI / 180, HAND_TURN = 35 * Math.PI / 180;
const HAND_THROW_J = 30, HAND_THROW_V = 10;
const HAND_MASS = 2, HAND_FORCE = 900;    // N: lifts ~90 kg slowly, knocks light things flying

const PHONE = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);
// Bodies farther than this from Anne are put to sleep (and stay asleep until touched).
const AWAKE_RADIUS = PHONE ? 60 : 120;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3();

// A level instance's rotation (rows of r, as level.js builds its matrix) as a quaternion.
function instQuat(inst, out = new THREE.Quaternion()) {
  const r = inst.rot;
  _m.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1);
  return out.setFromRotationMatrix(_m);
}
const rq = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });

export async function createPhysics(opts) {
  await RAPIER.init();
  const extra = await fetch(`levels/${opts.level}/physics.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return new Physics({ ...opts, extra: extra || { boxes: {}, magnets: [] } });
}

export class Physics {
  constructor({ info, terrain, partGeoms, refs, extra }) {
    Object.assign(this, { info, refs, partGeoms });
    this.world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
    this.world.timestep = STEP;
    this.boxes = extra.boxes;
    this.acc = 0;
    this.stepMs = 0;              // last frame's simulation time, for the phone budget
    this.entries = [];            // every dynamic object
    this.byIndex = new Map();     // instance index -> entry
    this.byHandle = new Map();    // rigid-body handle -> entry
    this.live = new Set();        // entries whose instance matrix is being driven
    this.held = null;             // { entry, dist, qRel }
    this.dinos = [];
    this.onHint = null;
    this.onImpact = null;         // (ev) => {} for collision sounds (sfx.js)
    this.material = new Map();    // collider handle -> the original's SoundMaterial
    this.events = new RAPIER.EventQueue(true);
    this.player = null;
    this.bounds = new Map();      // model key -> Box3 (model space)
    const t0 = performance.now();

    // --- Static world: terrain and every solid, unmoving object.
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.ground = ground;
    if (terrain) {
      const g = terrain.geometry;
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(g.getAttribute('position').array),
        new Uint32Array(g.getIndex().array)).setFriction(0.9), ground);
    }
    const verts = [];
    let staticBoxes = 0;
    for (const inst of info.instances) {
      const p = inst.props || {};
      if (p.Tangible !== true || p.Moveable === true) continue;
      if (inst.cls === 'CTerrainObj' || inst.cls === 'CEntityWater' || inst.cls === 'CAnimal') continue;
      const sub = this.boxes[inst.name];
      if (sub) {
        // The original collides compounds (trees, fences, huts) by their boxes only.
        const q = instQuat(inst);
        for (const b of sub) {
          _v.fromArray(b.pos).multiplyScalar(inst.scale).applyQuaternion(q).add(_v2.fromArray(inst.pos));
          _q2.copy(q).multiply(boxQuat(b));
          const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(...b.half.map((h) => Math.max(0.02, h * inst.scale)))
            .setTranslation(_v.x, _v.y, _v.z).setRotation(rq(_q2)).setFriction(0.7), ground);
          if (p.SoundMaterial) this.material.set(c.handle, p.SoundMaterial);
          staticBoxes++;
        }
        continue;
      }
      const r = inst.rot, s = inst.scale, t = inst.pos;
      _m.set(r[0][0] * s, r[0][1] * s, r[0][2] * s, t[0], r[1][0] * s, r[1][1] * s, r[1][2] * s, t[1],
             r[2][0] * s, r[2][1] * s, r[2][2] * s, t[2], 0, 0, 0, 1);
      for (const { geo } of partGeoms.get(inst.model) || []) {
        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i++) { _v.fromBufferAttribute(pos, i).applyMatrix4(_m); verts.push(_v.x, _v.y, _v.z); }
      }
    }
    if (verts.length) {
      const idx = new Uint32Array(verts.length / 3);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(verts), idx).setFriction(0.7), ground);
    }

    // --- Dynamic objects: everything Moveable and Tangible that is drawn.
    for (const inst of info.instances) {
      const p = inst.props || {};
      if (p.Moveable !== true || p.Tangible !== true || !refs[inst.index]) continue;
      if (inst.cls === 'CAnimal') continue;
      this.addBody(inst);
    }

    // --- Magnets: hinges and welds between objects, or to the world.
    this.joints = [];
    const byName = new Map(this.entries.map((e) => [e.inst.name, e]));
    for (const mg of extra.magnets || []) {
      const slave = byName.get(mg.slave);
      if (!slave) continue;
      const master = mg.master ? byName.get(mg.master) : null;
      if (mg.master && !master) continue;
      this.addMagnet(mg, slave, master);
    }

    // Everything starts asleep, where the level put it: it wakes when touched.
    for (const e of this.entries) e.body.sleep();
    // One step before Anne's collider exists: a parentless collider added to a world
    // that has never stepped leaves Rapier 0.21's broad phase blind to everything.
    this.world.step();
    for (const e of this.entries) e.body.sleep();   // the step's new contacts woke them

    // --- Anne: a capsule moved by the character controller. It is a parentless
    // collider that takes no part in contacts itself (she pushes with impulses).
    this.cc = this.world.createCharacterController(0.02);
    this.cc.setUp({ x: 0, y: 0, z: 1 });
    this.cc.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.cc.setMinSlopeSlideAngle(35 * Math.PI / 180);
    this.cc.enableAutostep(0.4, 0.15, false);
    this.cc.enableSnapToGround(0.35);
    this.cc.setApplyImpulsesToDynamicBodies(false);
    this.playerCol = this.world.createCollider(RAPIER.ColliderDesc.capsule((PLAYER_H - 2 * PLAYER_R) / 2, PLAYER_R)
      .setRotation(rq(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)))
      .setSolverGroups(0).setCollisionGroups(0x00010000));
    this.ccFilter = (c) => {
      const b = c.parent();
      return !(this.held && b && b.handle === this.held.entry.body.handle);
    };

    this.buildMs = performance.now() - t0;
    this.stats = { bodies: this.entries.length, staticBoxes, staticTris: verts.length / 9, joints: this.joints.length };
    this.makeHand();
    this.frame = 0;
    window.__physics = this;
    this.RayCtor = RAPIER.Ray; this.RAPIER = RAPIER;   // for tests
  }

  modelBounds(model) {
    let b = this.bounds.get(model);
    if (!b) {
      b = new THREE.Box3();
      for (const { geo } of this.partGeoms.get(model) || []) { geo.computeBoundingBox(); b.union(geo.boundingBox); }
      this.bounds.set(model, b);
    }
    return b;
  }

  addBody(inst) {
    const p = inst.props, s = inst.scale;
    const q = instQuat(inst);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(...inst.pos).setRotation(rq(q)).setCcdEnabled(true)
      .setLinearDamping(0.05).setAngularDamping(0.2));
    // Boxes in the body's frame: the compound's own, else the mesh extents.
    let shapes = this.boxes[inst.name]?.map((b) => ({ c: _v.fromArray(b.pos).multiplyScalar(s).clone(), q: boxQuat(b), h: b.half.map((h) => h * s) }));
    if (!shapes) {
      const bb = this.modelBounds(inst.model);
      shapes = [{ c: bb.getCenter(new THREE.Vector3()).multiplyScalar(s), q: new THREE.Quaternion(),
                  h: bb.getSize(_s).multiplyScalar(s / 2).toArray() }];
    }
    for (const sh of shapes) sh.h = sh.h.map((h) => Math.max(0.025, h));
    const volume = shapes.reduce((a, sh) => a + 8 * sh.h[0] * sh.h[1] * sh.h[2], 0);
    let mass = p.Mass > 0 ? p.Mass : volume * (p.Density ?? DENSITY) * 1000;
    mass = THREE.MathUtils.clamp(mass, 0.2, 5000);
    const friction = (p.Friction ?? FRICTION) / 10 * 1.1;
    const bounce = Math.min(0.5, p.Elasticity ?? p.Bounce ?? ELASTICITY);
    for (const sh of shapes) {
      // Hard knocks (over ~3 g) are reported for their sounds.
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(...sh.h).setTranslation(sh.c.x, sh.c.y, sh.c.z).setRotation(rq(sh.q))
        .setDensity(mass / volume).setFriction(friction).setRestitution(bounce)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(mass * 30), body);
      if (p.SoundMaterial) this.material.set(c.handle, p.SoundMaterial);
    }
    const radius = Math.max(...shapes.map((sh) => sh.c.length() + Math.hypot(...sh.h)));
    const e = {
      inst, index: inst.index, body, mass, radius, floats: p.Floats === true, gun: inst.cls === 'CGun',
      prevP: new THREE.Vector3(...inst.pos), prevQ: q.clone(), curP: new THREE.Vector3(...inst.pos), curQ: q.clone(),
      track: null, scale: s,
    };
    this.entries.push(e);
    this.byIndex.set(e.index, e);
    this.byHandle.set(body.handle, e);
    return e;
  }

  addMagnet(mg, slave, master) {
    // The magnet's own frame, in the slave's and the master's (or the world's) frames.
    _m.set(mg.rot[0][0], mg.rot[0][1], mg.rot[0][2], 0, mg.rot[1][0], mg.rot[1][1], mg.rot[1][2], 0,
           mg.rot[2][0], mg.rot[2][1], mg.rot[2][2], 0, 0, 0, 0, 1);
    const qMag = new THREE.Quaternion().setFromRotationMatrix(_m);
    const pMag = new THREE.Vector3(...mg.pos);
    const local = (e) => {
      if (!e) return { p: pMag.clone(), q: qMag.clone() };
      const qi = e.curQ.clone().invert();
      return { p: pMag.clone().sub(e.curP).applyQuaternion(qi), q: qi.multiply(qMag) };
    };
    const a = local(master), b = local(slave);
    const nFree = mg.free.filter(Boolean).length;
    let data;
    if (nFree === 1) {
      // A hinge about the magnet's free axis, expressed in each body's frame.
      const axis = new THREE.Vector3(mg.free[0] ? 1 : 0, mg.free[1] ? 1 : 0, mg.free[2] ? 1 : 0);
      data = RAPIER.JointData.revoluteWithAxes(a.p, b.p, axis.clone().applyQuaternion(a.q), axis.clone().applyQuaternion(b.q));
    } else if (nFree > 1) {
      data = RAPIER.JointData.spherical(a.p, b.p);
    } else {
      data = RAPIER.JointData.fixed(a.p, rq(a.q), b.p, rq(b.q));
    }
    const joint = this.world.createImpulseJoint(data, master ? master.body : this.ground, slave.body, false);
    joint.setContactsEnabled(false);   // welded parts overlap; they must not fight
    this.joints.push({ joint, slave, master, breakStrength: mg.breakStrength || 0 });
    if (!master && nFree === 0) slave.pinned = true;
  }

  // Let the game know about its guns and dinosaurs.
  attachGame(game) {
    this.game = game;
    this.onHint = (t, s) => game.showHint(t, s);
    for (const p of game.pickups || []) {
      const e = this.byIndex.get(p.index);
      if (e) e.track = p.pos;
    }
    for (const d of game.dinos || []) {
      const bb = this.modelBounds(d.inst.model);
      const s = d.inst.scale;
      const half = bb.getSize(new THREE.Vector3()).multiplyScalar(s / 2);
      const c = bb.getCenter(new THREE.Vector3()).multiplyScalar(s);
      // The body carries only the torso (the model's middle), so legs and tails do not
      // snag: its length and height trimmed a little.
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(d.pos.x, d.pos.y, d.pos.z).setRotation(rq(_q.setFromAxisAngle(_v.set(0, 0, 1), d.yaw))));
      const hx = Math.max(0.15, half.x * 0.7), hy = Math.max(0.3, half.y * 0.6), hz = Math.max(0.3, half.z * 0.45);
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(c.x, c.y, c.z + half.z * 0.1)
        .setDensity(300).setFriction(0.8), body);
      this.dinos.push({ d, body, c, half });
    }
  }

  // ---------------------------------------------------------------- player
  // Move Anne's feet by `delta` (game space), sliding along and stepping up whatever
  // is in the way; light objects in the way get shoved. Returns whether she stands.
  movePlayer(player, delta, dt) {
    const col = this.playerCol;
    const cz = PLAYER_H / 2;
    col.setTranslation({ x: player.pos.x, y: player.pos.y, z: player.pos.z + cz });
    this.cc.computeColliderMovement(col, delta, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.ccFilter);
    const m = this.cc.computedMovement();
    // Push what she walks into: the harder the lighter it is.
    for (let i = 0, n = this.cc.numComputedCollisions(); i < n; i++) {
      const c = this.cc.computedCollision(i);
      const b = c?.collider?.parent();
      const e = b && this.byHandle.get(b.handle);
      if (!e || e.pinned || !b.isDynamic()) continue;
      const nx = -c.normal1.x, ny = -c.normal1.y;
      const into = (delta.x * nx + delta.y * ny) / Math.max(dt, 1e-3);
      if (into <= 0.05 || Math.abs(c.normal1.z) > 0.7) continue;
      const v = b.linvel();
      const want = into - (v.x * nx + v.y * ny);
      if (want <= 0) continue;
      const k = Math.min(1, 50 / e.mass);            // Anne weighs about 55 kg
      b.applyImpulseAtPoint({ x: nx * want * e.mass * k, y: ny * want * e.mass * k, z: 0 }, c.witness1, true);
    }
    player.pos.x += m.x; player.pos.y += m.y; player.pos.z += m.z;
    col.setTranslation({ x: player.pos.x, y: player.pos.y, z: player.pos.z + cz });
    return this.cc.computedGrounded();
  }

  // ---------------------------------------------------------------- hand
  eyeRay(player) {
    const origin = new THREE.Vector3(player.pos.x, player.pos.y, player.pos.z + 1.6 - (player.crouch || 0));
    const cp = Math.cos(player.pitch);
    const dir = new THREE.Vector3(-Math.sin(player.yaw) * cp, Math.cos(player.yaw) * cp, Math.sin(player.pitch));
    return { origin, dir };
  }

  // What is in front of Anne's hand: the body the view ray hits, else the nearest one
  // in a cone ahead.
  bodyAhead(player) {
    const { origin, dir } = this.eyeRay(player);
    const hit = this.world.castRay(new RAPIER.Ray(origin, dir), REACH, true, undefined, undefined, this.playerCol);
    if (hit) {
      const e = hit.collider.parent() && this.byHandle.get(hit.collider.parent().handle);
      if (e && !e.gun) return e;
    }
    let best = null, bestScore = Infinity;
    for (const e of this.entries) {
      if (e.gun || !e.body.isEnabled()) continue;
      const t = e.body.translation();
      _v.set(t.x, t.y, t.z).sub(origin);
      const d = _v.length() - Math.min(e.radius, 0.8);
      if (d > REACH) continue;
      const cos = _v.normalize().dot(dir);
      if (cos < 0.75) continue;
      const score = d * (2 - cos);
      if (score < bestScore) { best = e; bestScore = score; }
    }
    return best;
  }

  // E / GRAB: pick up the light object ahead. True if something was taken.
  grab(player) {
    if (this.held) { this.release(); return true; }
    const e = this.bodyAhead(player);
    if (!e) return false;
    if (e.mass >= LIFT_MAX || e.pinned) { this.onHint?.(e.pinned ? 'It will not come loose' : 'Too heavy to lift', 1.5); return true; }
    const t = e.body.translation(), r = e.body.rotation();
    const { origin } = this.eyeRay(player);
    const yawQ = _q.setFromAxisAngle(_v.set(0, 0, 1), player.yaw);
    this.held = {
      entry: e, dist: THREE.MathUtils.clamp(_v2.set(t.x, t.y, t.z).distanceTo(origin), 0.7 + e.radius * 0.6, 1.2 + e.radius),
      qRel: yawQ.clone().invert().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w)),
    };
    e.body.setGravityScale(0, true);
    e.body.wakeUp();
    return true;
  }

  // Let go, with a velocity (a throw) or without (a drop).
  release(vel = null) {
    const h = this.held;
    if (!h) return false;
    this.held = null;
    const b = h.entry.body;
    b.setGravityScale(1, true);
    if (vel) {
      const k = Math.sqrt(Math.min(1, 8 / h.entry.mass));   // heavy things do not fly far
      b.setLinvel({ x: vel.x * k, y: vel.y * k, z: vel.z * k }, true);
    }
    return true;
  }

  // Fire while holding something: throw it along the view.
  throw(player) {
    if (!this.held) return false;
    const { dir } = this.eyeRay(player);
    const pv = this.playerVel || _v2.set(0, 0, 0);
    this.release(dir.multiplyScalar(11).add(_v.set(0, 0, 1.5)).add(pv));
    return true;
  }

  updateHeld(player) {
    const h = this.held;
    if (!h) return;
    const b = h.entry.body;
    // Within arm's reach of her right shoulder (about 0.85 m), along her view.
    const { dir } = this.eyeRay(player);
    const target = this.shoulder(player).addScaledVector(dir, Math.min(0.85, 0.4 + h.entry.radius * 0.6));
    const t = b.translation();
    _v.set(target.x - t.x, target.y - t.y, target.z - t.z);
    // Snagged on something, or left behind for a moment: it slips from her hand.
    h.stuck = _v.length() > 1.6 ? (h.stuck || 0) + STEP : 0;
    if (h.stuck > 0.4) { this.release(); return; }
    const vmax = 14 * Math.min(1, 30 / h.entry.mass);
    _v.multiplyScalar(12);
    if (_v.length() > vmax) _v.setLength(vmax);
    b.setLinvel(_v, true);
    // Keep the grip orientation, turning with Anne.
    const want = _q.setFromAxisAngle(_s.set(0, 0, 1), player.yaw).multiply(h.qRel);
    const r = b.rotation();
    _q2.set(r.x, r.y, r.z, r.w).invert().premultiply(want);   // want * cur^-1
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    const ang = 2 * Math.acos(Math.min(1, _q2.w));
    const sn = Math.sqrt(Math.max(1e-9, 1 - _q2.w * _q2.w));
    const w = Math.min(ang * 10, 12);
    b.setAngvel({ x: _q2.x / sn * w, y: _q2.y / sn * w, z: _q2.z / sn * w }, true);
  }

  // The held object's matrix (game space), for drawing Anne's hand on it.
  heldMatrix(out = new THREE.Matrix4()) {
    const e = this.held?.entry;
    if (!e) return null;
    return out.compose(e.curP, e.curQ, _s.setScalar(e.scale));
  }

  // ---------------------------------------------------------------- the physical hand
  // Trespasser's hand (Game/DesignDaemon/Player.cpp): while the hand key is held the
  // mouse moves Anne's hand about her right shoulder instead of turning her head
  // (±65° across, ±75° up/down; past 35° across her body turns to follow), at 0.8 m
  // reach (0.95 reaching for something). The hand is a body of its own: it knocks
  // things over, and grabbing welds what is within 20 cm of the palm to it, so a held
  // object swings, collides and is flung with the hand. Shift+mouse turns the wrist,
  // Ctrl+mouse rolls it, both together reset it. Throw hurls what she holds at 30 N·s
  // (at most 10 m/s); Stow puts the gun away or brings it back.
  //
  // physics.hand, read each frame by the arm renderer (anne.js via game.js):
  //   mode      'arm' while the hand is raised (hand key held, or holding something), else 'look'
  //   target    THREE.Vector3, the palm, game space
  //   rotation  THREE.Quaternion, the wrist in her view frame (x right, y ahead, z up);
  //             identity = palm down, fingers ahead
  //   holding   the held entry ({inst, index, body, mass, ...}) or null
  //   stowed    true while the gun is put away
  //   aiming    true while the hand key is held (the mouse drives the hand)
  makeHand() {
    this.hand = {
      mode: 'look', target: new THREE.Vector3(), rotation: new THREE.Quaternion(), holding: null, stowed: false, aiming: false,
      ax: 0, ay: 0, reach: HAND_REACH, joint: null, active: false, cock: 0, pos: new THREE.Vector3(),
    };
    this.onHand = null;   // ({ type: 'grab' | 'release' | 'throw' | 'stow' | 'retrieve', entry }) => {}
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setGravityScale(0).setCcdEnabled(true)
      .setLinearDamping(2).setAngularDamping(2).setTranslation(0, 0, -1000));
    // The palm: fingers along +Y, back of the hand up (+Z).
    this.handCol = this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.05, 0.09, 0.025).setMass(HAND_MASS)
      .setFriction(1.0).setRestitution(0), body);
    this.material.set(this.handCol.handle, '');
    body.setEnabled(false);
    this.handBody = body;
  }

  shoulder(player, out = new THREE.Vector3()) {
    const c = Math.cos(player.yaw), s = Math.sin(player.yaw), dz = player.crouch || 0;
    return out.set(player.pos.x + 0.20 * c + 0.13 * s, player.pos.y + 0.20 * s - 0.13 * c, player.pos.z + 1.46 - dz);
  }

  // Hand key down/up (right mouse; the HAND button on touch).
  setArm(on, player = this.player) {
    const h = this.hand;
    if (on === h.aiming) return;
    h.aiming = on;
    if (on && !h.active && player) {
      // Raised to the middle of her view (ang2HandView in the original: 12.5° right, level).
      h.ax = 12.5 * Math.PI / 180;
      h.ay = THREE.MathUtils.clamp(player.pitch, -HAND_PITCH, HAND_PITCH);
      this.activateHand(player);
    }
  }

  activateHand(player) {
    const h = this.hand;
    h.active = true;
    this.handTarget(player, h.target);
    const b = this.handBody;
    b.setTranslation(h.target, true);
    b.setRotation(rq(this.handWorldQuat(player, _q)), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.setEnabled(true);
  }

  // Mouse motion while the hand key is held (radians, as the view would have turned).
  moveHand(dx, dy, player) {
    const h = this.hand;
    h.ax += dx;
    h.ay = THREE.MathUtils.clamp(h.ay - dy, -HAND_PITCH, HAND_PITCH);
    // Swung too far across: her body turns after the hand.
    if (Math.abs(h.ax) > HAND_TURN) {
      const over = h.ax - Math.sign(h.ax) * HAND_TURN;
      player.yaw -= over;
      h.ax -= over;
    }
  }

  // Shift+mouse turns the wrist (yaw, pitch), Ctrl+mouse rolls it, both reset it.
  rotateWrist(dx, dy, roll = false, reset = false) {
    const r = this.hand.rotation;
    if (reset) { r.identity(); return; }
    dx = THREE.MathUtils.clamp(dx, -0.52, 0.52); dy = THREE.MathUtils.clamp(dy, -1, 1);
    if (roll) r.multiply(_q.setFromAxisAngle(_v.set(0, 1, 0), dx));
    else r.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), -dy)).multiply(_q2.setFromAxisAngle(_v.set(0, 0, -1), dx));
    r.normalize();
  }

  // Mouse wheel: reach in or out.
  handReach(d) { this.hand.reach = THREE.MathUtils.clamp(this.hand.reach + d, 0.3, HAND_REACH_MAX); }

  handTarget(player, out) {
    const h = this.hand;
    const ca = Math.cos(h.ay), bx = Math.sin(h.ax) * ca, by = Math.cos(h.ax) * ca, bz = Math.sin(h.ay);
    const c = Math.cos(player.yaw), s = Math.sin(player.yaw);
    // Body frame (x right, y ahead) to game space.
    let r = h.reach;
    if (h.cock > 0) r *= 0.6;   // drawn back to throw
    return this.shoulder(player, out).add(_v.set(bx * c - by * s, bx * s + by * c, bz).multiplyScalar(r));
  }

  // The wrist's rotation in game space: her view (yaw, then the hand's pitch) times hand.rotation.
  handWorldQuat(player, out) {
    const h = this.hand;
    out.setFromAxisAngle(_v2.set(0, 0, 1), player.yaw + (h.active ? -h.ax * 0.5 : 0));
    return out.multiply(_q2.setFromAxisAngle(_v2.set(1, 0, 0), h.ay * 0.5)).multiply(h.rotation);
  }

  // Drive the hand body toward its target with a limited force, so light things are
  // knocked flying and heavy ones barely shift (and a heavy held one is only dragged).
  updateHand(player) {
    const h = this.hand, b = this.handBody;
    const up = h.aiming || !!h.holding || h.cock > 0;
    if (!up) {
      h.autoCrouch = false;
      if (h.active) { h.active = false; b.setEnabled(false); }
      h.mode = 'look';
      return;
    }
    if (!h.active) this.activateHand(player);
    h.mode = 'arm';
    // Reaching well below her waist she crouches (the original's auto-crouch).
    h.autoCrouch = h.aiming && h.ay < -0.75;
    if (h.cock > 0 && (h.cock -= STEP) <= 0) { h.cock = 0; this.throwHeld(player); }
    this.handTarget(player, h.target);
    const t = b.translation();
    _v.set(h.target.x - t.x, h.target.y - t.y, h.target.z - t.z);
    const far = _v.length();
    if (far > 0.7) {
      // Snagged behind something: the hand comes back (and lets go).
      if (h.holding && far > 1.2) this.handRelease();
      b.setTranslation(h.target, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    const held = h.holding;
    const liftable = held && held.mass < LIFT_MAX;
    const m = HAND_MASS + (held ? held.mass : 0);
    // Wanted velocity: close the gap within a few steps.
    _v.multiplyScalar(1 / (STEP * 4));
    if (_v.length() > 6) _v.setLength(6);
    const v = b.linvel();
    _v2.set(_v.x - v.x, _v.y - v.y, _v.z - v.z).multiplyScalar(m);
    const maxJ = HAND_FORCE * STEP;
    if (_v2.length() > maxJ) _v2.setLength(maxJ);
    // She carries the weight of what she can lift; a heavier one sags and drags.
    if (liftable) _v2.z += held.mass * 9.81 * STEP;
    b.applyImpulse(_v2, true);
    // The wrist: turned toward the wanted orientation.
    const want = this.handWorldQuat(player, _q);
    const r = b.rotation();
    _q2.set(r.x, r.y, r.z, r.w).invert().premultiply(want);
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    const ang = 2 * Math.acos(Math.min(1, _q2.w)), sn = Math.sqrt(Math.max(1e-9, 1 - _q2.w * _q2.w));
    const w = Math.min(ang * 12, held && !liftable ? 2 : 14);
    const av = { x: _q2.x / sn * w, y: _q2.y / sn * w, z: _q2.z / sn * w };
    b.setAngvel(av, true);
    // A light held object turns with the wrist (it is welded to it).
    if (liftable) held.body.setAngvel(av, true);
    const p = b.translation();
    h.pos.set(p.x, p.y, p.z);
  }

  // Grab/Drop with the hand (left click while the hand is up; GRAB on touch). Returns
  // true if it did something, 'gun' when the hand is on a gun (the game picks it up).
  handGrab(player) {
    const h = this.hand;
    if (!h.active) return false;
    if (h.holding) { this.handRelease(); return true; }
    const b = this.handBody, t = b.translation();
    const hit = this.world.projectPoint(t, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
      undefined, this.handCol, b, (c) => { const p = c.parent(); return !!(p && this.byHandle.has(p.handle)); });
    if (!hit) return false;
    const d = Math.hypot(hit.point.x - t.x, hit.point.y - t.y, hit.point.z - t.z);
    if (!hit.isInside && d > HAND_GRAB) return false;
    const e = this.byHandle.get(hit.collider.parent().handle);
    if (e.pinned) { this.onHint?.('It will not come loose', 1.5); return true; }
    if (e.gun) return 'gun';   // a gun goes into her hand as a gun (the game's pickup)
    if (this.held?.entry === e) this.release();
    // Weld it to the palm where it is (a ball joint for what she cannot lift: dragged).
    const ot = e.body.translation(), or = e.body.rotation();
    const oq = new THREE.Quaternion(or.x, or.y, or.z, or.w), hq = new THREE.Quaternion().copy(b.rotation());
    const a2 = new THREE.Vector3(t.x - ot.x, t.y - ot.y, t.z - ot.z).applyQuaternion(oq.clone().invert());
    const data = e.mass < LIFT_MAX
      ? RAPIER.JointData.fixed({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, a2, rq(oq.invert().multiply(hq)))
      : RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, a2);
    h.joint = this.world.createImpulseJoint(data, b, e.body, true);
    h.joint.setContactsEnabled(false);
    h.holding = e;
    e.body.wakeUp();
    this.live.add(e);
    this.onHand?.({ type: 'grab', entry: e });
    if (e.mass >= LIFT_MAX) this.onHint?.('Too heavy to lift', 1.5);
    return true;
  }

  handRelease(vel = null) {
    const h = this.hand;
    if (!h.holding) return false;
    const e = h.holding;
    if (h.joint) this.world.removeImpulseJoint(h.joint, true);
    h.joint = null;
    h.holding = null;
    e.body.wakeUp();
    // What she lets go of keeps the hand's motion: a quick flick throws it.
    if (vel) e.body.setLinvel(vel, true);
    this.onHand?.({ type: vel ? 'throw' : 'release', entry: e });
    return true;
  }

  // Throw (F): the hand draws back for 0.3 s, then hurls what it holds ahead and up.
  handThrow(player) {
    const h = this.hand;
    if (h.holding) { if (!(h.cock > 0)) h.cock = 0.3; return true; }
    if (this.held) return this.throw(player);
    return false;
  }

  throwHeld(player) {
    const h = this.hand, e = h.holding;
    if (!e) return;
    const { dir } = this.eyeRay(player);
    dir.z += 0.5; dir.normalize();
    const speed = Math.min(HAND_THROW_V, HAND_THROW_J / e.mass);
    const pv = this.playerVel || _v2.set(0, 0, 0);
    this.handRelease(new THREE.Vector3(dir.x * speed + pv.x, dir.y * speed + pv.y, dir.z * speed));
  }

  // Stow/Retrieve: the gun goes away (and comes back); an object in the hand is dropped.
  stow() {
    const h = this.hand;
    if (h.holding) this.handRelease();
    h.stowed = !h.stowed;
    this.onHand?.({ type: h.stowed ? 'stow' : 'retrieve', entry: null });
    return h.stowed;
  }

  // Fire pressed (left click / FIRE). With the hand up it grabs or lets go; with an
  // E-carried object it throws; while the gun is stowed it does nothing. True when the
  // press was used here (the gun does not fire). Acts on the press, not while held.
  handFire(player) {
    const pressed = this.fireFrame !== this.frame - 1 && this.fireFrame !== this.frame;
    this.fireFrame = this.frame;
    const h = this.hand;
    if (h.active && h.aiming && !(this.game?.gun && !h.stowed && !h.holding)) {
      if (pressed && this.handGrab(player) === 'gun') this.game?.tryPickup(player);
      return true;
    }
    if (this.held) return pressed ? this.throw(player) : true;
    if (h.stowed && this.game?.gun) return true;
    return false;
  }

  // ---------------------------------------------------------------- guns
  // A gun taken into Anne's hands leaves the simulation...
  take(index) {
    const e = this.byIndex.get(index);
    if (!e) return;
    if (this.held?.entry === e) this.held = null;
    if (this.hand.holding === e) this.handRelease();
    e.body.setEnabled(false);
    this.live.delete(e);
  }

  // ...and comes back when dropped, at `pos` facing `yaw`, moving at `vel`.
  releaseGun(index, pos, yaw = 0, vel = null) {
    const e = this.byIndex.get(index);
    if (!e) return;
    _q.setFromAxisAngle(_v.set(0, 0, 1), yaw);
    e.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    e.body.setRotation(rq(_q), true);
    e.body.setLinvel(vel || { x: 0, y: 0, z: 0 }, true);
    e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    e.body.setEnabled(true);
    e.body.wakeUp();
    e.prevP.copy(pos); e.curP.copy(pos); e.prevQ.copy(_q); e.curQ.copy(_q);
    this.live.add(e);
  }

  // ---------------------------------------------------------------- bullets
  // A shot along `dir` from `origin`: the first object within `maxDist` takes an
  // impulse at the hit point. Returns true if an object stopped the bullet.
  shot(origin, dir, maxDist, push = 100) {
    this.lastShotDir = dir.clone();
    const hit = this.world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, this.playerCol,
      this.held?.entry.body);
    if (!hit) return false;
    const b = hit.collider.parent();
    const e = b && this.byHandle.get(b.handle);
    if (!e || !b.isEnabled()) return false;
    const p = _v.copy(origin).addScaledVector(dir, hit.timeOfImpact);
    // As Gun.cpp: the Push property times 5-10 % is the bullet's momentum (N·s).
    const j = (push || 100) * (0.05 + Math.random() * 0.05);
    // Downward shots would only press the object into the ground: keep the push level.
    b.applyImpulseAtPoint({ x: dir.x * j, y: dir.y * j, z: Math.max(0, dir.z) * j + j * 0.1 }, p, true);
    // A breakable magnet lets go when shot hard enough.
    for (const jt of this.joints) {
      if (jt.joint && jt.breakStrength > 0 && (jt.slave === e || jt.master === e) && push >= jt.breakStrength) {
        this.world.removeImpulseJoint(jt.joint, true);
        jt.joint = null;
        jt.slave.pinned = false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- dinosaurs
  // A dead animal becomes a dynamic body of its size, knocked over by the shot.
  ragdoll(d) {
    const rec = this.dinos.find((r) => r.d === d);
    if (!rec) return false;
    const b = rec.body;
    b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.setAngularDamping(0.8);
    b.setLinearDamping(0.1);
    b.enableCcd(true);
    const mass = b.mass();
    const dir = this.lastShotDir ? this.lastShotDir.clone() : new THREE.Vector3(Math.cos(d.yaw), Math.sin(d.yaw), 0);
    dir.z = 0; dir.normalize();
    // Knocked along the shot and rolled over onto its side (about its own length:
    // the models face +Y).
    const fwd = new THREE.Vector3(-Math.sin(d.yaw), Math.cos(d.yaw), 0);
    const side = Math.sign(fwd.y * dir.x - fwd.x * dir.y) || 1;   // its top falls away from the shot
    b.setLinvel({ x: dir.x * 2.5, y: dir.y * 2.5, z: 1.2 }, true);
    b.setAngvel({ x: fwd.x * 4 * side, y: fwd.y * 4 * side, z: 0 }, true);
    const t = b.translation();
    const r = b.rotation();
    rec.dead = true;
    rec.entry = {
      inst: d.inst, index: d.index, body: b, mass, radius: rec.half.length(), scale: d.inst.scale, dino: true,
      prevP: new THREE.Vector3(t.x, t.y, t.z), curP: new THREE.Vector3(t.x, t.y, t.z),
      prevQ: new THREE.Quaternion(r.x, r.y, r.z, r.w), curQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    };
    this.byHandle.set(b.handle, rec.entry);
    this.live.add(rec.entry);
    return true;
  }

  // ---------------------------------------------------------------- the step
  update(dt, player) {
    this.player = player;
    this.frame++;
    const t0 = performance.now();
    // Living dinosaurs: kinematic bodies following the AI, shoving what they walk into.
    for (const r of this.dinos) {
      if (r.dead) continue;
      r.body.setNextKinematicTranslation({ x: r.d.pos.x, y: r.d.pos.y, z: r.d.pos.z });
      r.body.setNextKinematicRotation(rq(_q.setFromAxisAngle(_v.set(0, 0, 1), r.d.yaw)));
    }
    this.acc = Math.min(this.acc + dt, STEP * MAX_STEPS);
    let steps = 0;
    while (this.acc >= STEP) {
      for (const e of this.live) { e.prevP.copy(e.curP); e.prevQ.copy(e.curQ); }
      this.updateHeld(player);
      this.updateHand(player);
      this.buoyancy();
      this.world.step(this.events);
      this.impacts();
      this.acc -= STEP;
      steps++;
      this.world.forEachActiveRigidBody((b) => {
        const e = this.byHandle.get(b.handle);
        if (!e) return;
        const t = b.translation(), r = b.rotation();
        if (!this.live.has(e)) { this.live.add(e); e.prevP.copy(e.curP); e.prevQ.copy(e.curQ); }
        e.curP.set(t.x, t.y, t.z); e.curQ.set(r.x, r.y, r.z, r.w);
      });
    }
    // Far from Anne, nothing needs simulating: put it to sleep.
    if ((this.cull = (this.cull || 0) + 1) % 30 === 0) {
      for (const e of this.live) {
        if (e === this.held?.entry || e.body.isSleeping()) continue;
        if (Math.hypot(e.curP.x - player.pos.x, e.curP.y - player.pos.y) > AWAKE_RADIUS) e.body.sleep();
      }
    }
    // Draw: between the last two steps.
    const a = this.acc / STEP;
    for (const e of this.live) {
      _v.lerpVectors(e.prevP, e.curP, a);
      _q.slerpQuaternions(e.prevQ, e.curQ, a);
      _m.compose(_v, _q, _s.setScalar(e.scale));
      for (const { mesh, i } of this.refs[e.index] || []) { mesh.setMatrixAt(i, _m); mesh.instanceMatrix.needsUpdate = true; }
      if (e.track) e.track.copy(e.curP);
      // Fell out of the world (off the terrain's edge): take it out of the simulation.
      if (e.curP.z < -200) { e.body.setEnabled(false); this.live.delete(e); continue; }
      if (e.body.isSleeping() || !e.body.isEnabled()) { if (e.prevP.equals(e.curP)) this.live.delete(e); }
    }
    if (steps) this.stepMs = performance.now() - t0;
    this.steps = steps;
  }

  // Collisions hard enough to hear, handed to onImpact (one per body pair per step).
  impacts() {
    const cb = this.onImpact;
    this.events.drainContactForceEvents((ev) => {
      if (!cb) return;
      const c1 = this.world.getCollider(ev.collider1()), c2 = this.world.getCollider(ev.collider2());
      const b1 = c1?.parent(), b2 = c2?.parent();
      const e1 = b1 && this.byHandle.get(b1.handle), e2 = b2 && this.byHandle.get(b2.handle);
      const e = e1 || e2;
      if (!e) return;
      const other = e === e1 ? e2 : e1;
      const mass = other ? Math.min(e.mass, other.mass) : e.mass;
      const impulse = ev.totalForceMagnitude() * STEP;
      const v = e.body.linvel();
      cb({
        bodyA: b1, bodyB: b2,
        materialA: this.material.get(c1.handle) ?? (e1 ? '' : 'TERRAIN'),
        materialB: this.material.get(c2.handle) ?? (e2 ? '' : 'TERRAIN'),
        impulse, energy: 0.5 * mass * (v.x * v.x + v.y * v.y + v.z * v.z), mass,
        point: e.curP.clone(), id: `${c1.handle}:${c2.handle}`,
      });
    });
  }

  // Objects that float (Floats) bob up in water below sea level.
  buoyancy() {
    const sea = this.info.sea;
    if (sea == null) return;
    for (const e of this.live) {
      if (!e.floats || e.body.isSleeping()) continue;
      const depth = sea - e.curP.z;
      if (depth <= -0.05) continue;
      const sub = THREE.MathUtils.clamp((depth + 0.05) / 0.3, 0, 1);
      const v = e.body.linvel();
      e.body.applyImpulse({ x: -v.x * 0.02 * e.mass, y: -v.y * 0.02 * e.mass, z: (9.81 * 1.6 * sub - v.z * 1.5) * e.mass * STEP }, true);
    }
  }

  awakeCount() {
    let n = 0;
    this.world.forEachActiveRigidBody((b) => { if (this.byHandle.has(b.handle) && b.isDynamic()) n++; });
    return n;
  }
}

function boxQuat(b) {
  const r = b.rot;
  _m.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(_m);
}
