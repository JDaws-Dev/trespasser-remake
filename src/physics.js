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
import { ModernHand } from './modernhand.js';

const STEP = 1 / 60;
const MAX_STEPS = 4;                  // per frame, so a slow frame never spirals
const LIFT_MAX = 100;                 // kg: PlayerSettings.fMaxMassPickup in the original
const REACH = 2.6;                    // metres from the eye
const PLAYER_R = 0.3, PLAYER_H = 1.7;
const ANNE_MASS = 55;                 // kg: what she presses on what she stands on
const DENSITY = 0.1, FRICTION = 5, ELASTICITY = 0.2;
const STATIC = 0x0002;                // collision group of the static world...
const TERRAIN = 0x0004;               // ...of which the terrain is also this

// Set-piece assists: where faithful physics cannot reproduce what the original did, a
// minimal nudge, per object (name, or a name prefix ending in '*'), and why:
const ASSISTS = {
  // as: the temple's falling walls are pushed (SET_PHYSICS Push 25 at mid-height) and
  // toppled in the original; in Rapier the 400 kg slabs only slide a few cm. The push
  // is applied high on the slab, hard enough to tip it over.
  'SFallingWall-*': { topple: 1.8 },
  // as2: the trailer on the cliff edge see-saws over under Anne and slides down with her;
  // its one big box barely tips under her 55 kg (a marginal balance even in the
  // original). Her weight counts four times on it.
  'Scontrailershore-00': { weight: 4 },
  // jr: the unfrozen monorail track sections fall onto the terrain in the original; here
  // they caught on the static track and pylons after 0.8-0.95 m. They pass through static
  // scenery (still landing on the terrain and hitting everything that moves).
  'SMonoRailTrack108-00': { throughScenery: true },
  'SMonoRailTrack200-00': { throughScenery: true },
};
function assistFor(name) {
  if (ASSISTS[name]) return ASSISTS[name];
  for (const [k, v] of Object.entries(ASSISTS)) if (k.endsWith('*') && name.startsWith(k.slice(0, -1))) return v;
  return null;
}
// The hand (PlayerSettings in Player.cpp): reach, angle limits, grab distance, throw.
const HAND_REACH = 0.8, HAND_REACH_MAX = 0.95, HAND_GRAB = 0.2;
const HAND_PITCH = 75 * Math.PI / 180, HAND_TURN = 35 * Math.PI / 180;
const HAND_THROW_J = 30, HAND_THROW_V = 10;
const HAND_MASS = 2, HAND_FORCE = 900;
// Swinging and collision damage (Player.cpp HandleSwing; Animate.cpp fCalculateHitPoints).
const SWING_MAX_MASS = 5, SWING_MUL = 2.75, SWING_PULL = 35 * Math.PI / 180, SWING_TIME = 0.5;
const COLLISION_DAMAGE = 0.22;   // hit points per joule of collision energy    // N: lifts ~90 kg slowly, knocks light things flying

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
  const t0 = performance.now();
  await RAPIER.init();
  const tInit = performance.now() - t0;
  const load = (f) => fetch(`levels/${opts.level}/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const t1 = performance.now();
  const [extra, colliders, logic] = await Promise.all([load('physics.json'), load('colliders.json'), load('logic.json')]);
  const tFetch = performance.now() - t1;
  const p = new Physics({ ...opts, extra: extra || { boxes: {}, magnets: [] }, colliders: colliders || { solids: [], markers: {} },
    logicTargets: logicTargets(logic), logic });
  await p.build(opts.onProgress);
  Object.assign(p.timings, { wasmInit: +tInit.toFixed(1), fetch: +tFetch.toFixed(1) });
  return p;
}

// Objects the level's triggers act on physically (SET_PHYSICS / MAGNET targets, collision
// trigger elements): the vault locks and hand reader, card readers, buttons. They need
// bodies even when the level has them static (then frozen until acted on).
function logicTargets(logic) {
  const out = new Set();
  const walk = (o, type) => {
    if (Array.isArray(o)) { for (const v of o) walk(v, type); return; }
    if (!o || typeof o !== 'object') return;
    const t = o.type || type;
    if (t === 'SET_PHYSICS' || t === 'MAGNET') for (const k of ['Target', 'MasterObject', 'SlaveObject']) if (typeof o[k] === 'string') out.add(o[k]);
    for (const k of ['Element1', 'Element2']) if (typeof o[k] === 'string') out.add(o[k]);
    for (const v of Object.values(o)) walk(v, t);
  };
  walk(logic?.triggers, null);
  return out;
}

export class Physics {
  constructor({ info, terrain, partGeoms, refs, extra, colliders, logicTargets = new Set(), logic = null }) {
    Object.assign(this, { info, refs, partGeoms, logic });
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
    this.args = { info, terrain, partGeoms, refs, extra, colliders, logicTargets };
  }

  // The build, in slices of about 25 ms that yield to the browser between them (a phone
  // must never freeze for long), reporting progress (0..1) as it goes.
  async build(onProgress = null) {
    const { info, terrain, partGeoms, refs, extra, colliders, logicTargets } = this.args;
    this.args = null;
    let sliceAt = performance.now();
    const total = info.instances.length * 2 + colliders.solids.length + (extra.magnets || []).length + 1;
    let done = 0;
    let longest = 0, slices = 0;
    const slice = async (n = 1, force = false) => {
      done += n;
      const ran = performance.now() - sliceAt;
      if (ran < 25 && !force) return;
      longest = Math.max(longest, ran); slices++;
      onProgress?.(Math.min(0.99, done / total));
      await new Promise((r) => setTimeout(r, 0));
      sliceAt = performance.now();
    };
    const t0 = performance.now();
    this.timings = {};
    let tm = t0;
    this.mark = (k) => { const n = performance.now(); this.timings[k] = +(n - tm).toFixed(1); tm = n; };

    // --- Static world: terrain and every solid, unmoving object.
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.ground = ground;
    if (terrain) {
      const g = terrain.geometry;
      this.terrainCol = this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(g.getAttribute('position').array),
        new Uint32Array(g.getIndex().array)).setFriction(0.9), ground);
    }
    const verts = [];
    let staticBoxes = 0;
    for (const inst of info.instances) {
      await slice();
      const p = inst.props || {};
      if (p.Tangible !== true || p.Moveable === true) continue;
      if (logicTargets.has(inst.name) && refs[inst.index]) continue;   // a (frozen) body instead
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

    this.mark('static');
    // --- Invisible solids (never drawn): the F* walls and floors and Baker* blockers
    // that keep Anne out of the sea and up on walkways. Boxes, as the original.
    for (const so of colliders.solids) {
      await slice();
      if (logicTargets.has(so.name)) {
        // An invisible target (a card reader's box, a keypad): a frozen body, never drawn.
        this.addBody({ name: so.name, pos: so.pos, rot: so.rot, scale: so.scale, props: { Frozen: true, Tangible: true }, index: `solid:${so.name}`,
          shapes: so.compound && this.boxes[so.name] ? null : [{ pos: so.c, rot: null, half: so.half }] });
        continue;
      }
      _m.set(so.rot[0][0], so.rot[0][1], so.rot[0][2], 0, so.rot[1][0], so.rot[1][1], so.rot[1][2], 0,
             so.rot[2][0], so.rot[2][1], so.rot[2][2], 0, 0, 0, 0, 1);
      const q = new THREE.Quaternion().setFromRotationMatrix(_m);
      const list = so.compound && this.boxes[so.name] ? this.boxes[so.name] : [{ pos: so.c, rot: null, half: so.half }];
      for (const b of list) {
        _v.fromArray(b.pos).multiplyScalar(so.scale).applyQuaternion(q).add(_v2.fromArray(so.pos));
        _q2.copy(q); if (b.rot) _q2.multiply(boxQuat(b));
        this.world.createCollider(RAPIER.ColliderDesc.cuboid(...b.half.map((h) => Math.max(0.02, h * so.scale)))
          .setTranslation(_v.x, _v.y, _v.z).setRotation(rq(_q2)).setFriction(0.7), ground);
        staticBoxes++;
      }
    }
    this.markers = colliders.markers || {};   // named helper placements (TeleportDest*, Emit*...)

    this.mark('invisible');
    // --- Dynamic objects: everything Moveable and Tangible that is drawn.
    for (const inst of info.instances) {
      await slice();
      const p = inst.props || {};
      const target = logicTargets.has(inst.name) && p.Tangible === true;
      if (!target && (p.Moveable !== true || p.Tangible !== true)) continue;
      if (!refs[inst.index]) continue;
      if (target && p.Moveable !== true) { this.addBody({ ...inst, props: { ...p, Frozen: true } }); continue; }
      if (inst.cls === 'CAnimal') continue;
      this.addBody(inst);
    }

    this.mark('dynamic');
    // --- Magnets: hinges and welds between objects, or to the world.
    this.joints = [];
    const byName = new Map(this.entries.map((e) => [e.inst.name, e]));
    for (const mg of extra.magnets || []) {
      await slice();
      const slave = byName.get(mg.slave);
      if (!slave) continue;
      const master = mg.master ? byName.get(mg.master) : null;
      if (mg.master && !master) continue;
      this.addMagnet(mg, slave, master);
    }

    this.mark('magnets');
    await slice(0, true);
    // Everything starts asleep, where the level put it: it wakes when touched.
    for (const e of this.entries) e.body.sleep();
    // The static world is its own collision group (hinged things can be let off it).
    for (let i = 0; i < ground.numColliders(); i++) ground.collider(i).setCollisionGroups((STATIC << 16) | 0xffff);
    if (this.terrainCol) this.terrainCol.setCollisionGroups(((STATIC | TERRAIN) << 16) | 0xffff);
    // One step before Anne's collider exists: a parentless collider added to a world
    // that has never stepped leaves Rapier 0.21's broad phase blind to everything.
    this.world.step();
    for (const e of this.entries) e.body.sleep();   // the step's new contacts woke them
    // Hinged and sliding things (gates, doors) that the level sets into the ground or a
    // wall would be jammed there: they swing free of the static world (their magnet
    // holds them in place anyway), still colliding with everything that moves.
    this.unjammed = [];
    for (const j of this.joints) {
      if (j.kind !== 'hinge' && j.kind !== 'slide') continue;
      const b = j.slave.body;
      let jammed = false;
      for (let i = 0; i < b.numColliders() && !jammed; i++) {
        const c = b.collider(i);
        this.world.contactPairsWith(c, (o) => {
          if (jammed || o.parent()?.handle !== ground.handle) return;
          this.world.contactPair(c, o, (m) => { for (let k = 0; k < m.numContacts(); k++) if (m.contactDist(k) < -0.02) jammed = true; });
        });
      }
      if (!jammed) continue;
      for (let i = 0; i < b.numColliders(); i++) b.collider(i).setCollisionGroups((0x0001 << 16) | (0xffff & ~(STATIC | TERRAIN)));
      this.unjammed.push(j.slave.inst.name);
    }

    // Assisted set pieces that fall through static scenery (onto the terrain).
    for (const e of this.entries) {
      if (!assistFor(e.inst.name)?.throughScenery) continue;
      for (let i = 0; i < e.body.numColliders(); i++) e.body.collider(i).setCollisionGroups((0x0001 << 16) | ((0xffff & ~STATIC) | TERRAIN));
    }

    this.mark('firstStep');
    // --- CEntityAttached (the lab vault's lock lights and hand reader): drawn riding on
    // their Target object, wherever its body goes.
    this.attached = [];
    const byName2 = new Map(this.entries.map((e) => [e.inst.name, e]));
    for (const inst of info.instances) {
      if (inst.cls !== 'CEntityAttached' || !refs[inst.index]) continue;
      const target = byName2.get(inst.props?.Target);
      if (!target) continue;
      const r = inst.rot, sc = inst.scale, t = inst.pos;
      const m = new THREE.Matrix4().set(r[0][0] * sc, r[0][1] * sc, r[0][2] * sc, t[0], r[1][0] * sc, r[1][1] * sc, r[1][2] * sc, t[1],
        r[2][0] * sc, r[2][1] * sc, r[2][2] * sc, t[2], 0, 0, 0, 1);
      const tm = new THREE.Matrix4().compose(target.curP, target.curQ, new THREE.Vector3(1, 1, 1));
      this.attached.push({ inst, target, rel: tm.invert().multiply(m) });
    }

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

    this.mark('player');
    this.buildMs = performance.now() - t0;
    this.timings.slices = slices + 1;
    this.timings.longestSliceMs = +Math.max(longest, performance.now() - sliceAt).toFixed(1);
    this.stats = { bodies: this.entries.length, staticBoxes, staticTris: verts.length / 9, joints: this.joints.length };
    this.makeHand();
    this.swing = { stage: 0, t: 0, ax: 0, side: 1 };
    this.pushScale = 4;           // SET_PHYSICS Push multiplier (see pushFrom)
    this.frame = 0;
    window.__physics = this;
    this.RayCtor = RAPIER.Ray; this.RAPIER = RAPIER;   // for tests
    onProgress?.(1);
    return this;
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
    // Frozen objects (doors, the monorail track, the elevator...) stay put until a
    // trigger releases them (unfreeze).
    const body = this.world.createRigidBody((p.Frozen ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(...inst.pos).setRotation(rq(q)).setCcdEnabled(true)
      .setLinearDamping(0.05).setAngularDamping(0.2));
    // Boxes in the body's frame: the compound's own, else the mesh extents.
    const boxes = inst.shapes || this.boxes[inst.name];
    let shapes = boxes?.map((b) => ({ c: _v.fromArray(b.pos).multiplyScalar(s).clone(), q: b.rot ? boxQuat(b) : new THREE.Quaternion(), h: b.half.map((h) => h * s) }));
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
      track: null, scale: s, frozen: !!p.Frozen,
    };
    this.entries.push(e);
    this.byIndex.set(e.index, e);
    this.byHandle.set(body.handle, e);
    return e;
  }

  // A magnet (Lib/Physics/Magnet.cpp): welds `slave` to `master`, or to the world when
  // only one object is named. XFree/YFree/ZFree make it a hinge about that axis of the
  // magnet's frame, X/Y/ZTFree a slide along it; Drive turns the hinge by motor,
  // Friction damps it, RestoreStrength springs it back, AngleMin/Max limit it;
  // Breakable ones let go when knocked harder than BreakStrength.
  addMagnet(mg, slave, master) {
    _m.set(mg.rot[0][0], mg.rot[0][1], mg.rot[0][2], 0, mg.rot[1][0], mg.rot[1][1], mg.rot[1][2], 0,
           mg.rot[2][0], mg.rot[2][1], mg.rot[2][2], 0, 0, 0, 0, 1);
    const qMag = new THREE.Quaternion().setFromRotationMatrix(_m);
    const pMag = new THREE.Vector3(...mg.pos);
    // Against the world, the other side is a fixed anchor body posed like the slave, so
    // both joint frames coincide (Rapier's hinge and slide take one local axis).
    let other = master?.body;
    if (!master) {
      other = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
        .setTranslation(slave.curP.x, slave.curP.y, slave.curP.z).setRotation(rq(slave.curQ)));
    }
    const oP = master ? master.curP : slave.curP, oQ = master ? master.curQ : slave.curQ;
    const local = (p, q) => pMag.clone().sub(p).applyQuaternion(q.clone().invert());
    const a1 = local(oP, oQ), a2 = local(slave.curP, slave.curQ);
    const axisOf = (f) => new THREE.Vector3(f[0] ? 1 : 0, f[1] ? 1 : 0, f[2] ? 1 : 0).applyQuaternion(qMag);
    const nFree = mg.free.filter(Boolean).length, nSlide = (mg.tfree || []).filter(Boolean).length;
    let data, kind;
    if (nFree === 1) {
      const w = axisOf(mg.free);
      data = RAPIER.JointData.revoluteWithAxes(a1, a2, w.clone().applyQuaternion(oQ.clone().invert()), w.clone().applyQuaternion(slave.curQ.clone().invert()));
      kind = 'hinge';
    } else if (nFree > 1) {
      data = RAPIER.JointData.spherical(a1, a2); kind = 'ball';
    } else if (nSlide >= 1 && !master) {
      const w = axisOf(mg.tfree).normalize().applyQuaternion(slave.curQ.clone().invert());
      data = RAPIER.JointData.prismatic(a1, a2, w); kind = 'slide';
    } else {
      data = RAPIER.JointData.fixed(a1, rq(oQ.clone().invert().multiply(qMag)), a2, rq(slave.curQ.clone().invert().multiply(qMag)));
      kind = 'weld';
    }
    const joint = this.world.createImpulseJoint(data, other, slave.body, false);
    joint.setContactsEnabled(false);   // welded parts overlap; they must not fight
    if (kind === 'hinge' || kind === 'slide') {
      if (mg.angleMin != null && mg.angleMax != null && kind === 'hinge') joint.setLimits(mg.angleMin, mg.angleMax);
      if (mg.drive) joint.configureMotorVelocity(mg.drive * 0.1, 50 * slave.mass);
      else if (mg.restore) joint.configureMotorPosition(0, mg.restore * slave.mass * 2, (mg.friction || 1) * slave.mass * 0.5);
      else if (mg.friction) joint.configureMotorVelocity(0, mg.friction * 0.1 * slave.mass);
    }
    const rec = { joint, slave, master, kind, anchor: master ? null : other, breakStrength: mg.breakStrength || 0, spec: mg };
    this.joints.push(rec);
    this.pinCheck(slave);
    return rec;
  }

  // Held fast to the world (no hinge or slide): Anne cannot pull it loose.
  pinCheck(e) {
    e.pinned = this.joints.some((j) => j.joint && j.slave === e && !j.master && j.kind === 'weld');
  }

  // Remove a magnet's joint (and its world anchor body); `forget` also drops the record.
  removeJoint(j, forget = false) {
    if (j.joint) {
      this.world.removeImpulseJoint(j.joint, true);
      if (j.anchor) this.world.removeRigidBody(j.anchor);
      j.joint = null; j.anchor = null;
    }
    if (forget) { const i = this.joints.indexOf(j); if (i >= 0) this.joints.splice(i, 1); }
    this.pinCheck(j.slave);
  }

  // ---------------------------------------------------------------- trigger actions
  // For the trigger system (GameActions.cpp: SET_PHYSICS, MAGNET): objects by name.
  body(name) {
    if (!this.byName) {
      this.byName = new Map(this.entries.map((e) => [e.inst.name, e]));
      // Something attached to a body is moved by moving that body.
      for (const a of this.attached) if (!this.byName.has(a.inst.name)) this.byName.set(a.inst.name, a.target);
    }
    return this.byName.get(name) || null;
  }

  // HIDESHOW: hide (not drawn, no collision, not simulated) or show a body again.
  setVisible(name, visible) {
    const e = this.body(name);
    if (!e) return false;
    if (!visible) {
      if (this.hand.holding === e) this.handRelease();
      if (this.held?.entry === e) this.release();
      e.body.setEnabled(false);
      this.live.delete(e);
      _m.makeScale(0, 0, 0);
    } else {
      e.body.setEnabled(true);
      e.body.wakeUp();
      this.live.add(e);
      _m.compose(e.curP, e.curQ, _s.setScalar(e.scale));
    }
    e.hidden = !visible;
    for (const { mesh, i } of this.refs[e.index] || []) { mesh.setMatrixAt(i, _m); mesh.instanceMatrix.needsUpdate = true; }
    return true;
  }

  // A named helper's placement ({pos:[x,y,z], rot:[[...]]}), e.g. an Emit* or TeleportDest*.
  marker(name) { return this.markers[name] || this.logic?.objects?.[name] || null; }   // colliders.json, else logic.json's placements

  // SET_PHYSICS Frozen:true: held still where it is (a fixed body) until unfrozen.
  freeze(name) {
    const e = this.body(name);
    if (!e || e.frozen) return !!e;
    if (this.hand.holding === e) this.handRelease();
    if (this.held?.entry === e) this.release();
    e.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    e.frozen = true;
    return true;
  }

  // SET_PHYSICS Frozen:false: simulated again (and woken).
  unfreeze(name) {
    const e = this.body(name);
    if (!e) return false;
    if (e.frozen) { e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true); e.frozen = false; }
    e.body.wakeUp();
    this.live.add(e);
    return true;
  }

  // SET_PHYSICS Impulse: an impulse (N·s, game space) at `point` (default: its centre).
  push(name, impulse, point = null) {
    const e = this.body(name);
    if (!e) return false;
    this.unfreeze(name);
    const t = e.body.translation();
    e.body.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, point || t, true);
    return true;
  }

  // SET_PHYSICS Impulse with an Emitter: `push` N·s along the emitter's +Y, from its position.
  pushFrom(name, emitterName, push) {
    const em = this.body(emitterName) || this.marker(emitterName);
    if (!em) return false;
    let pos, dir;
    if (em.body) { const t = em.body.translation(); pos = new THREE.Vector3(t.x, t.y, t.z); dir = new THREE.Vector3(0, 1, 0).applyQuaternion(em.curQ); }
    else { pos = new THREE.Vector3(...em.pos); dir = new THREE.Vector3(em.rot[0][1], em.rot[1][1], em.rot[2][1]); }
    // The original applied Push as momentum (CXob::ApplyImpulse: force for one 10 ms
    // step, so Δv = Push / mass), but its boxes slid and rolled far more freely than
    // Rapier's: at 1x the Ascent's rolling head stops 2.5 m short of the stairs it must
    // reach. Scripted pushes are scaled by pushScale (4: the head reaches the stairs).
    const a = assistFor(name), e = this.body(name);
    if (a?.topple && e) {
      // Pushed high on the slab (near its top), enough to tip it: a·mass N·s.
      this.unfreeze(name);
      const b = this.modelBounds(e.inst.model);
      const top = e.curP.clone().add(new THREE.Vector3(0, 0, b.max.z * e.scale * 0.9));
      dir.z = 0; dir.normalize();
      e.body.applyImpulseAtPoint(dir.multiplyScalar(a.topple * e.mass), top, true);
      return true;
    }
    return this.push(name, dir.multiplyScalar(push * this.pushScale), pos);
  }

  // SET_PHYSICS X/Y/Z: set its velocity (m/s), e.g. the as2 elevator.
  setVelocity(name, v) {
    const e = this.body(name);
    if (!e) return false;
    this.unfreeze(name);
    e.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    return true;
  }

  // Move it (and stop it) at pos, optionally turned to rot (a THREE.Quaternion).
  teleport(name, pos, rot = null) {
    const e = this.body(name);
    if (!e) return false;
    e.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    if (rot) e.body.setRotation(rq(rot), true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    e.curP.set(pos.x, pos.y, pos.z); e.prevP.copy(e.curP);
    if (rot) { e.curQ.copy(rot); e.prevQ.copy(rot); }
    this.live.add(e);
    return true;
  }

  // Locked doors: a weld to the world holds them. Unlocking removes the object's welds
  // (its hinge, if it has one, then swings free); locking welds it where it is now.
  setMagnetLocked(name, locked) {
    const e = this.body(name);
    if (!e) return false;
    const welds = this.joints.filter((j) => j.joint && j.slave === e && j.kind === 'weld' && !j.master);
    if (!locked) { welds.forEach((j) => this.removeJoint(j)); e.body.wakeUp(); this.live.add(e); return true; }
    if (!welds.length) this.addMagnet({ pos: e.curP.toArray(), rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], free: [false, false, false] }, e, null);
    return true;
  }

  // The MAGNET action: replace the object's world magnets with a new one (spec as in
  // physics.json: free, tfree, drive, friction, restore, angleMin/Max, breakStrength;
  // pos/rot default to the object's current pose), or with enable:false just remove them.
  setMagnet(name, spec = {}) {
    const e = this.body(name);
    if (!e) return false;
    if (this.hand.holding === e) this.handRelease();
    if (this.held?.entry === e) this.release();
    this.joints.filter((j) => j.joint && j.slave === e && !j.master).forEach((j) => this.removeJoint(j));
    if (e.frozen) { e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true); e.frozen = false; }
    if (spec.enable === false) { e.body.wakeUp(); this.live.add(e); return true; }
    const R = new THREE.Matrix4().makeRotationFromQuaternion(e.curQ).elements;
    this.addMagnet({
      pos: e.curP.toArray(), rot: [[R[0], R[4], R[8]], [R[1], R[5], R[9]], [R[2], R[6], R[10]]],
      free: [false, false, false], tfree: [false, false, false], ...spec,
    }, e, null);
    e.body.wakeUp(); this.live.add(e);
    return true;
  }

  // Hand style: 'modern' (look at a thing and click: Half-Life 2 / Amnesia style, the
  // default) or 'classic' (the original's hand, moved with the mouse). Kept per browser.
  get handStyle() {
    if (!this._handStyle) {
      let s = null;
      try { s = localStorage.getItem('trespasser.handStyle'); } catch (e) { /* storage blocked */ }
      this._handStyle = s === 'classic' ? 'classic' : 'modern';
      document.body.classList.toggle('modernhand', this._handStyle === 'modern');
    }
    return this._handStyle;
  }

  setHandStyle(style) {
    style = style === 'classic' ? 'classic' : 'modern';
    if (style === this.handStyle) return style;
    // Let go of everything the other style was doing.
    this.modern?.reset();
    if (this.hand.holding) this.handRelease();
    if (this.held) this.release();
    this.setArm(false);
    this._handStyle = style;
    try { localStorage.setItem('trespasser.handStyle', style); } catch (e) { /* storage blocked */ }
    document.body.classList.toggle('modernhand', style === 'modern');
    return style;
  }

  // Let the game know about its guns and dinosaurs.
  attachGame(game) {
    this.game = game;
    this.modern = new ModernHand(this, game);
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
      const rec = { d, body, c, half };
      this.dinos.push(rec);
      (this.dinoByHandle ||= new Map()).set(body.handle, rec);
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
    const grounded = this.cc.computedGrounded();
    // Her weight on what she stands on (a trailer she walks onto slides off under her).
    if (grounded) {
      const hit = this.world.castRay(new RAPIER.Ray({ x: player.pos.x, y: player.pos.y, z: player.pos.z + 0.1 }, { x: 0, y: 0, z: -1 }),
        0.4, true, undefined, undefined, col);
      const b = hit?.collider.parent();
      const e = b && this.byHandle.get(b.handle);
      if (e && b.isDynamic() && !e.pinned && e !== this.held?.entry) {
        const w = assistFor(e.inst.name)?.weight || 1;
        b.applyImpulseAtPoint({ x: 0, y: 0, z: -ANNE_MASS * w * 9.81 * dt }, { x: player.pos.x, y: player.pos.y, z: player.pos.z + 0.1 - hit.timeOfImpact }, true);
      }
    }
    return grounded;
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
    if (e.mass >= LIFT_MAX || e.pinned || e.frozen) { this.onHint?.(e.pinned || e.frozen ? 'It will not come loose' : 'Too heavy to lift', 1.5); return true; }
    this.holdEntry(e, player);
    return true;
  }

  // Take `e` into Anne's grip (carried in front of her). `grip`: the original's hand
  // magnet for it ({rot: Quaternion, pos: Vector3}, object frame), to hold it as the
  // original did (the modern hand snaps it to that).
  holdEntry(e, player, grip = null) {
    const r = e.body.rotation();
    const yawQ = _q.setFromAxisAngle(_v.set(0, 0, 1), player.yaw);
    this.held = {
      entry: e, grip,
      // How it sits relative to her heading: as picked up, or turned so her hand, palm
      // down and fingers ahead, holds it at its grip.
      qRel: grip ? grip.rot.clone().invert() : yawQ.clone().invert().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w)),
    };
    this.hand.rotation.identity();   // the wrist turns it from how it was picked up
    e.body.setGravityScale(0, true);
    e.body.wakeUp();
    this.live.add(e);
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
    if (this.swing.stage) dir.applyAxisAngle(_s.set(0, 0, 1), -this.swing.ax);   // swung across her
    const target = this.handStyle === 'modern' ? this.modern.holdPoint(player, h)
      : this.hand.aiming ? this.handTarget(player, new THREE.Vector3())
      : this.shoulder(player).addScaledVector(dir, Math.min(0.85, 0.4 + h.entry.radius * 0.6));
    const t = b.translation();
    _v.set(target.x - t.x, target.y - t.y, target.z - t.z);
    // Snagged on something, or left behind for a moment: it slips from her hand.
    h.stuck = _v.length() > 1.6 ? (h.stuck || 0) + STEP : 0;
    if (h.stuck > 0.4) { this.release(); return; }
    // Flies there smoothly and settles without overshoot (a damped spring on velocity).
    const vmax = 10 * Math.min(1, 30 / h.entry.mass);
    _v.multiplyScalar(this.handStyle === 'modern' ? 9 : 12);
    if (_v.length() > vmax) _v.setLength(vmax);
    b.setLinvel(_v, true);
    // Keep the grip orientation, turning with Anne and with her wrist (Shift / Alt + mouse).
    const want = _q.setFromAxisAngle(_s.set(0, 0, 1), player.yaw).multiply(this.hand.rotation).multiply(h.qRel);
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
      drag: null, press: null,   // modern hand: { point, normal } while dragging; { point, normal, time } per press
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
      if (this.held) {
        // Carrying something: the hand starts where it is, and moves it from there.
        const s = this.shoulder(player), p = this.held.entry.curP;
        _v.set(p.x - s.x, p.y - s.y, p.z - s.z);
        const c = Math.cos(player.yaw), sn = Math.sin(player.yaw);
        const bx = _v.x * c + _v.y * sn, by = -_v.x * sn + _v.y * c;
        h.ax = Math.atan2(bx, by);
        h.ay = THREE.MathUtils.clamp(Math.atan2(_v.z, Math.hypot(bx, by)), -HAND_PITCH, HAND_PITCH);
        h.reach = THREE.MathUtils.clamp(_v.length(), 0.3, HAND_REACH_MAX);
        return;
      }
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
    const ax = this.swing.stage && (h.holding || this.held) ? this.swing.ax : h.ax;
    const ca = Math.cos(h.ay), bx = Math.sin(ax) * ca, by = Math.cos(ax) * ca, bz = Math.sin(h.ay);
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
    if (this.held) {
      // An E-carried object is the hand's grip: the hand body stays out of its way, and
      // with the hand key held the object goes where the hand is moved and turned.
      if (h.active) { h.active = false; b.setEnabled(false); }
      h.autoCrouch = h.aiming && h.ay < -0.75;
      h.mode = h.aiming ? 'arm' : h.stowed ? 'stow' : 'look';
      if (h.aiming) { this.handTarget(player, h.target); h.pos.copy(this.held.entry.curP); }
      return;
    }
    if (!up) {
      h.autoCrouch = false;
      if (h.active) { h.active = false; b.setEnabled(false); }
      h.mode = h.stowed ? 'stow' : 'look';
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

  // Use / fire (held). With no gun in hand and a light object held (5 kg or less),
  // she swings it: pulled back 35° to one side, then across to the other, hitting 2.75
  // times as hard on the way across (HandleSwing). While the gun is stowed, nothing.
  // True when the press was used here.
  handFire() {
    if (this.hand.stowed && this.game?.gun) return true;
    const obj = this.hand.holding || this.held?.entry;
    if (!obj || this.game?.gun || obj.mass > SWING_MAX_MASS) return false;
    this.swingUse = this.frame;
    if (!this.swing.stage) Object.assign(this.swing, { stage: 1, t: 0, ax: SWING_PULL * this.swing.side });
    return true;
  }

  updateSwing() {
    const w = this.swing;
    if (!w.stage) return;
    if (!(this.hand.holding || this.held?.entry)) { w.stage = 0; return; }
    w.t += STEP;
    if (w.t < SWING_TIME) return;
    const using = this.frame - (this.swingUse || -9) <= 2;
    if (w.stage === 1) { Object.assign(w, { stage: 2, t: 0, ax: -w.ax }); return; }
    // A swing done: another the other way while Use is held, else back to rest.
    if (using) Object.assign(w, { stage: 1, t: 0 });
    else { w.stage = 0; w.side = -w.side; }
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
      if (jt.joint && jt.breakStrength > 0 && (jt.slave === e || jt.master === e) && push >= jt.breakStrength) this.removeJoint(jt);
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
      for (const e of this.live) {
        e.prevP.copy(e.curP); e.prevQ.copy(e.curQ);
        const v = e.body.linvel(); (e.vPre ||= new THREE.Vector3()).set(v.x, v.y, v.z);   // for impact energy
      }
      this.updateSwing();
      this.updateHeld(player);
      if (this.handStyle === 'modern') this.modern?.step(player);
      else this.updateHand(player);
      this.buoyancy();
      this.world.step(this.events);
      this.impacts();
      if ((this.stepCount = (this.stepCount || 0) + 1) % 3 === 0) this.scrapes();
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
    for (const a of this.attached) {
      if (!this.live.has(a.target)) continue;
      _m.compose(a.target.curP, a.target.curQ, _s.setScalar(1)).multiply(a.rel);
      for (const { mesh, i } of this.refs[a.inst.index] || []) { mesh.setMatrixAt(i, _m); mesh.instanceMatrix.needsUpdate = true; }
    }
    if (steps) this.stepMs = performance.now() - t0;
    this.steps = steps;
  }

  hitDino(rec, e, impulse) {
    const now = this.frame;
    if ((rec.lastHit?.get(e) ?? -99) > now - 20) return;   // one hit per object per third of a second
    const swung = this.swing.stage === 2 && (this.hand.holding === e || this.held?.entry === e);
    // The energy it brought in (its speed just before), at most what the knock took out.
    const v = e.vPre ? e.vPre.lengthSq() : Infinity;
    const energy = Math.min((impulse * impulse) / (2 * e.mass), 0.5 * e.mass * v);
    const dmg = COLLISION_DAMAGE * energy * (swung ? SWING_MUL : 1);
    if (dmg < 1) return;
    (rec.lastHit ||= new Map()).set(e, now);
    const ai = this.game?.ai;
    if (ai?.damage) ai.damage(rec.d, dmg, { from: this.player?.pos });
    this.onDinoHit?.({ dino: rec.d, entry: e, damage: dmg, swung, point: e.curP.clone() });
  }

  // Scraping: anything awake sliding along something, about 20 times a second, as
  // onImpact events with `slide` (J of sliding energy) and a stable pair `id`, so
  // sfx.js can hold a scrape loop while they keep coming.
  scrapes() {
    const cb = this.onImpact;
    if (!cb) return;
    let n = 0;
    for (const e of this.live) {
      if (n > 12 || !e.body.isEnabled() || e.body.isSleeping() || !e.body.isDynamic()) continue;
      const v = e.body.linvel();
      const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (sp2 < 0.09) continue;   // under 0.3 m/s
      for (let i = 0; i < e.body.numColliders(); i++) {
        const c = e.body.collider(i);
        this.world.contactPairsWith(c, (o) => {
          if (o.handle === this.handCol?.handle || o.handle === this.playerCol?.handle) return;
          this.world.contactPair(c, o, (m, flipped) => {
            if (m.numContacts() === 0) return;
            const nrm = m.normal();
            const vn = v.x * nrm.x + v.y * nrm.y + v.z * nrm.z;
            const vt2 = Math.max(0, sp2 - vn * vn);
            if (vt2 < 0.09) return;
            const ob = o.parent(), oe = ob && this.byHandle.get(ob.handle);
            n++;
            cb({
              bodyA: e.body, bodyB: ob, materialA: this.material.get(c.handle) ?? '',
              materialB: this.material.get(o.handle) ?? (oe ? '' : 'TERRAIN'),
              impulse: 0, energy: 0, slide: 0.5 * e.mass * vt2, speed: Math.sqrt(vt2), mass: e.mass,
              point: e.curP.clone(), id: `${Math.min(c.handle, o.handle)}:${Math.max(c.handle, o.handle)}`,
            });
          });
        });
      }
    }
  }

  // Collisions hard enough to hear, handed to onImpact (one per body pair per step).
  impacts() {
    const cb = this.onImpact;
    this.events.drainContactForceEvents((ev) => {
      const c1 = this.world.getCollider(ev.collider1()), c2 = this.world.getCollider(ev.collider2());
      const b1 = c1?.parent(), b2 = c2?.parent();
      const e1 = b1 && this.byHandle.get(b1.handle), e2 = b2 && this.byHandle.get(b2.handle);
      const e = e1 || e2;
      if (!e) return;
      const other = e === e1 ? e2 : e1;
      const mass = other ? Math.min(e.mass, other.mass) : e.mass;
      const impulse = ev.totalForceMagnitude() * STEP;
      // An object hitting a living dinosaur hurts it: 0.22 hit points per joule the
      // object loses (≈ J²/2m), 2.75 times that when swung by Anne.
      const rec = (b1 && this.dinoByHandle?.get(b1.handle)) || (b2 && this.dinoByHandle?.get(b2.handle));
      if (rec && !rec.dead && rec.d.alive) this.hitDino(rec, e, impulse);
      // A breakable magnet lets go under a hard enough knock.
      for (const j of this.joints) {
        if (j.joint && j.breakStrength > 0 && (j.slave === e1 || j.slave === e2) && impulse > j.breakStrength) this.removeJoint(j);
      }
      if (!cb) return;
      const v = e.body.linvel();
      cb({
        bodyA: b1, bodyB: b2,
        materialA: this.material.get(c1.handle) ?? (e1 ? '' : 'TERRAIN'),
        materialB: this.material.get(c2.handle) ?? (e2 ? '' : 'TERRAIN'),
        impulse, energy: 0.5 * mass * (v.x * v.x + v.y * v.y + v.z * v.z), mass,
        point: e.curP.clone(), id: `${Math.min(c1.handle, c2.handle)}:${Math.max(c1.handle, c2.handle)}`,
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
