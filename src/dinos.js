// Dinosaurs: the original brain (jp2_pc/Source/Game/AI) reduced to steering. Each
// animal has the engine's emotions and its opinion of Anne; every think (4 a second)
// the activities its level props switch on (ActBite, ActApproach, ActFlee...) are
// rated from those feelings with the engine's own weights, and the best one moves it.
// No A* here: a fan of feeler rays against the static world (game.collider) steers
// round walls, rocks and the sea. Game coordinates (metres, Z up); models face +Y.
import * as THREE from 'three';

// Brain.cpp:374 `Dinosaur` (EDinoType): 1 T-Rex, 2 Parasaur, 3 Trike, 4 Stego,
// 5 Brachi, 6 Albertosaur; raptors have none. Speeds are the remake's (the original's
// came out of its physics pelvis), multiplied by the level's `Speed` prop as
// InfoSkeleton.cpp:423 does. head/tail: where along the model's length (0 tail tip ..
// 1 nose) the head and tail boxes start, for hit locations.
const SPECIES = {
  0: { vocal: 'Raptor', run: 7.5, walk: 1.6, turn: 3.2, head: 0.78, tail: 0.40 },
  1: { vocal: 'Trex', run: 6.0, walk: 1.8, turn: 1.1, head: 0.76, tail: 0.42 },
  2: { vocal: 'Parasaurolophus', run: 6.5, walk: 1.3, turn: 1.8, head: 0.80, tail: 0.40 },
  3: { vocal: 'Triceratops', run: 5.0, walk: 1.1, turn: 1.2, head: 0.72, tail: 0.28 },
  4: { vocal: 'Stegosaur', run: 6.0, walk: 1.5, turn: 1.0, head: 0.82, tail: 0.36 },
  5: { vocal: 'Brachiosaur', run: 2.0, walk: 1.0, turn: 0.35, head: 0.72, tail: 0.30 },
  6: { vocal: 'Albertosaur', run: 6.5, walk: 1.8, turn: 1.4, head: 0.76, tail: 0.42 },
};

// The animals' body boxes (their `Head`/`Body`/`Tail` props name them): [Armour,
// Damage] from the level GRFs (research/dump). A bullet does the gun's Damage times
// the Armour of the box it hits (Animate.cpp fCalculateHitPoints); a bite does the
// head's Damage x 10 per second of contact (Animate.cpp:1302 fDamagePerSecond).
const BOX = {
  RaptorAHead: [2, 10], RaptorABody: [1, 1], RaptorATail: [0.5, 0],
  RaptorBHead: [2, 15], RaptorBBody: [1, 1], RaptorBTail: [0.5, 0],
  RaptorCHead: [2, 20], RaptorCBody: [1, 1], RaptorCTail: [0.5, 0],
  RaptorCBossHead: [2, 26], RaptorCBossBody: [1, 1], RaptorCBossTail: [0.5, 0],
  TRexXHead: [2, 50], TRexXBody: [1, 1], TRexXTail: [0.5, 10],
  TRex_f_AHead: [2, 50], TRex_f_ABody: [1, 1], TRex_f_ATail: [0.5, 10],
  Trex_Alpha_Head: [2, 50], Trex_Alpha_Body: [1, 1], Trex_Alpha_Tail: [0.5, 10],
  AlbertasaurHead: [2, 30], AlbertasaurBody: [1, 1], AlbertasaurTail: [0.5, 10],
  ParaHead: [2, 1], ParaBody: [1, 1], ParaTail: [0.5, 10],
  Trike_Head: [0.2, 20], Trike_Body: [1, 1], Trike_Tail: [0.5, 1.5],
  Steg_Head: [2, 1], Steg_Body: [1, 1], Steg_Tail: [0.5, 20],
};
const boxOf = (name) => BOX[(name || '').replace(/^\$/, '').replace(/-\d+$/, '')];

// A bite is a chomp: the head's damage-per-second for this long (the original ran it
// for as long as the jaws touched Anne, a few physics frames).
const CHOMP = 0.15;

// Feelings (Feeling.hpp EParameterType), in this order.
const FEAR = 0, LOVE = 1, ANGER = 2, CURIOSITY = 3, HUNGER = 4, THIRST = 5, FATIGUE = 6, PAIN = 7;
const NAMES = ['Fear', 'Love', 'Anger', 'Curiosity', 'Hunger', 'Thirst', 'Fatigue', 'Pain', 'Solidity'];
// Each activity's rating weights (feelRatingFeeling in its constructor).
const W = {
  bite:     [0, -4, 5, 0, 5, 0, -3, 0, 0],              // ActivityAttack.cpp:102
  ram:      [-2, -1, 3, 0, 0, 0, 0, -0.5, -0.2],        // ActivityAttack.cpp:485
  approach: [-1, -1, 4.5, 0, 4, 0, -4, -4, 0],          // MoveActivities.cpp:1762
  moveBy:   [-2, -1, 3, 0, 4, 0, -3, -3, 0],            // MoveActivities.cpp:1890
  flee:     [8, -8, -8, 0, 0, 0, 8, 8, 0],              // MoveActivities.cpp:1271
  toward:   [-3, 0, 0, 4, 2, 2, -3, -4, 0],             // MoveActivities.cpp:184
  wander:   [0, 0, 0, 0.005, 0.005, 0.005, 0, 0, 0],   // MoveActivities.cpp:554
};
const SIGHT = 40;          // Brain.cpp rAnimateSensoryRange: a sphere 0.75 x this ahead of the head
const FORGET = 6;          // seconds a lost Anne stays in mind
const THINK = 0.25;        // seconds between thoughts

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _ray = new THREE.Ray(), _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, 0, -1);
const wrap = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const rand = (a, b) => a + Math.random() * (b - a);

export class DinoAI {
  constructor(game) {
    this.game = game;
    this.time = 0;
    const byName = new Map();
    this.list = game.info.instances
      .map((inst, i) => ({ inst, i }))
      .filter(({ inst }) => inst.cls === 'CAnimal')
      .map(({ inst, i }) => this.make(inst, i));
    for (const d of this.list) byName.set(d.inst.name, d);
    this.byName = byName;
  }

  make(inst, index) {
    const p = inst.props, game = this.game;
    const kind = p.Dinosaur || 0;
    const sp = SPECIES[kind] || SPECIES[0];
    const hp = p.HitPoints ?? 100;
    const carnivore = (p.Archetype ?? 0) === 0;   // Brain.cpp:362, default earCARNIVORE
    const d = {
      inst, index, name: inst.name, kind, sp, carnivore,
      pos: new THREE.Vector3(...inst.pos),
      yaw: Math.atan2(inst.rot[1][0], inst.rot[0][0]),
      scale: inst.scale,
      // Animate.cpp ParseProps: hit points, regeneration, dying.
      hp, maxHp: p.MaxHitPoints ?? hp, regeneration: p.Regeneration ?? 1, dieRate: p.DieRate ?? 1,
      reallyDie: p.ReallyDie ?? -0.2 * hp, critical: p.CriticalHit ?? hp * 0.3,
      tranq: hp, sedated: false,
      alive: true, awake: false, hidden: !!inst.offMap,
      raptor: kind === 0,
      vocal: sp.vocal,
      // Brain.cpp ParseProps: body sense and reach.
      headReach: p.HeadReach ?? 2, tailReach: p.TailReach ?? 4, width: p.Width ?? 1,
      lock: p.BiteTargetDistance ?? 1, bravery: p.Bravery ?? 0.5, team: p.Team ?? 0,
      wakeDist: p.WakeUp ?? p.Wakeup ?? 30, sleepDist: p.Sleep ?? 30,
      minNormalZ: Math.cos(((p.UpAngle ?? 33) * Math.PI) / 180),
      speedMul: p.Speed ?? 1,
      acts: {},
      // Emotions (MentalState.cpp:77): defaults, then the level's Fear/Anger/Hunger...
      emo: [0.2, 0.2, 0.2, 0.2, 0.5, 0.5, 0, 0, 1],
      dmgFeel: [0, 0, 0, 0, 0, 0, 0, 2, 0],   // Brain.cpp:591 feelDamageFeeling, then DamageFear...
      stay: null, away: null,
      // Runtime.
      act: 'idle', actT: 0, think: Math.random() * THINK, speed: 0, moveDir: null, turnTo: null,
      seen: -1e9, known: new THREE.Vector3(), cine: 0, cineT: 0, moveBy: null,
      biteT: 0, biteCool: 0, callT: 5 + Math.random() * 20, wanderYaw: 0, wanderT: 0, avoidSide: 1,
      flinch: 0, gait: 0, home: new THREE.Vector3(...inst.pos),
    };
    for (const [k, v] of Object.entries(p)) if (k.startsWith('Act')) d.acts[k.slice(3).replace(/Towards$/, 'Toward')] = !!v;
    NAMES.forEach((n, i) => {
      if (typeof p[n] === 'number') d.emo[i] = p[n];
      if (typeof p['Damage' + n] === 'number') d.dmgFeel[i] = p['Damage' + n];
    });
    // Anne as the animal sees her (AIMain.cpp:686 default opinions): Anne's `Danger`
    // is 0.5 ($AnneBody), scaling fear and pain; its Bravery scales anger; herbivores
    // have no hunger for her.
    const danger = 0.5;
    d.opinion = [danger, 0, d.bravery, 1, carnivore ? 1 : 0, 0, 1, danger, 0.5];
    if (p.StayNearTarget && d.acts.StayNear !== false) d.stay = { target: p.StayNearTarget, ok: p.StayNearOK ?? 15, max: p.StayNearMax ?? 30 };
    if (p.StayAwayTarget) d.away = { target: p.StayAwayTarget, min: p.StayAwayMin ?? 15, ok: p.StayAwayOK ?? 25 };

    // Animal models are centred on the body: lift each by its model's lowest point so
    // it stands on its feet, and never frustum-cull them (their instances roam far
    // from the spawn points the meshes' bounding spheres were computed from).
    const box = new THREE.Box3();
    let minZ = 0;
    for (const { mesh } of game.refs[index] || []) {
      mesh.frustumCulled = false;
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
      minZ = Math.min(minZ, mesh.geometry.boundingBox.min.z);
    }
    d.foot = -minZ * d.scale;
    d.bounds = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -2, -1), new THREE.Vector3(1, 2, 1)) : box;
    const size = d.bounds.getSize(new THREE.Vector3()).multiplyScalar(d.scale);
    d.length = Math.max(size.x, size.y);
    d.radius = d.raptor ? 1.2 : Math.max(1.5, size.z / 2);   // blood.js sizes its sprays by this
    d.reach = Math.max(size.x, size.y, size.z) / 2;           // broad-phase sphere for shots
    d.jaw = Math.max(d.headReach, d.bounds.max.y * d.scale);   // body centre to the tip of the snout
    d.boxes = { head: boxOf(p.Head) || [1, 0], body: boxOf(p.Body) || [1, 0], tail: boxOf(p.Tail) || [1, 0] };
    if (d.hidden) this.game.setInstanceMatrix(index, _m.makeScale(0, 0, 0));
    return d;
  }

  // ---------------------------------------------------------------- script API
  // (triggers.js: TELEPORT, SET_AI, WAKE_AI)

  byNameOf(name) { return this.byName.get(name) || null; }

  // Bring an animal into play: out of its pen (shown), at `pos` facing `yaw` if given,
  // and awake.
  activate(d, pos = null, yaw = null) {
    if (!d || !d.alive) return;
    if (pos) d.pos.set(pos.x, pos.y, (pos.z ?? 0));
    if (yaw !== null && yaw !== undefined) d.yaw = yaw;
    if (pos || d.hidden) {
      // Onto whatever floor is there (the summit helipad is a floor above the terrain),
      // looking from a little above where the teleport left it.
      const terrain = this.game.groundAt(d.pos.x, d.pos.y);
      const from = Math.max(terrain, d.pos.z - d.foot) + 4;
      d.pos.z = (this.groundUnder(d.pos.x, d.pos.y, from) ?? terrain) + d.foot;
    }
    d.hidden = false;
    d.home.copy(d.pos);
    d.awake = true;
    // Sent in to ambush: it knows where she is.
    if (this.player) { d.seen = this.time; d.known.copy(this.player.pos); }
  }

  // Stay near a named object (or a point), as SET_AI StayNear: come back when further
  // than `max`, settle once within `ok`.
  stayNear(d, target, ok = 5, max = 15) {
    if (!d) return;
    d.stay = target ? { target, ok, max } : null;
    d.acts.StayNear = !!target;
    d.awake = d.awake || !!target;
  }

  // A named target's position: a point, another animal, or whatever triggers.js can find.
  locate(target, out) {
    if (!target) return null;
    if (target.isVector3) return out.copy(target);
    if (Array.isArray(target)) return out.fromArray(target);
    if (target === 'Player' || target === 'Anne') return out.copy(this.player.pos);
    const d = this.byName.get(target);
    if (d) return out.copy(d.pos);
    return this.game.logic?.locate?.(target, out) || null;
  }

  // SET_AI (triggers.js keeps its props on d.script): stay near / away and Act* switches.
  applyScript(d) {
    const s = d.script;
    if (!s || s === d.scriptSeen) return;
    d.scriptSeen = s;
    for (const [k, v] of Object.entries(s)) if (k.startsWith('Act')) d.acts[k.slice(3).replace(/Towards$/, 'Toward')] = !!v;
    if (s.StayNearTarget) d.stay = { target: s.StayNearTarget, ok: s.StayNearOK ?? 15, max: s.StayNearMax ?? 30 };
    else if (s.ActStayNear === false) d.stay = null;
    if (s.StayAwayTarget) d.away = { target: s.StayAwayTarget, min: s.StayAwayMin ?? 15, ok: s.StayAwayOK ?? 25 };
    NAMES.forEach((n, i) => { if (typeof s[n] === 'number') d.emo[i] = s[n]; });
    if (!s.StayNearTarget && !s.StayAwayTarget && !Object.keys(s).some((k) => k.startsWith('Act'))) {
      // A bare SET_AI (ij's T-rex after the rampage): back to its own devices.
      d.stay = null; d.away = null;
    }
  }

  // ---------------------------------------------------------------- damage

  // Where along the animal a point is: 'head', 'body' or 'tail'.
  partAt(d, p) {
    const rx = p.x - d.pos.x, ry = p.y - d.pos.y;
    const ly = (-rx * Math.sin(d.yaw) + ry * Math.cos(d.yaw)) / d.scale;
    const t = (ly - d.bounds.min.y) / Math.max(1e-3, d.bounds.max.y - d.bounds.min.y);
    return t >= d.sp.head ? 'head' : t <= d.sp.tail ? 'tail' : 'body';
  }

  // The nearest animal a ray (game space) meets within `far`: { d, dist, point, part }.
  hitTest(ray, far) {
    let best = null;
    for (const d of this.list) {
      if (!d.alive || d.hidden) continue;
      const c = _v.set(d.pos.x, d.pos.y, d.pos.z + (d.bounds.min.z + d.bounds.max.z) * 0.5 * d.scale);
      const r = d.reach;
      const toC = _v2.copy(c).sub(ray.origin);
      const along = toC.dot(ray.direction);
      if (along < -r || along > far + r) continue;
      if (toC.lengthSq() - along * along > r * r) continue;
      // The animal's own mesh, where blood.js can test it; otherwise the sphere.
      let point = null;
      const h = this.game.blood?.meshHit?.(d, ray.origin, ray.direction, far + r);
      if (h) point = h.point;
      else if (!this.game.blood?.meshHit) point = ray.intersectSphere(new THREE.Sphere(c.clone(), r * 0.6), new THREE.Vector3());
      if (!point) continue;
      const dist = point.distanceTo(ray.origin);
      if (dist <= far && (!best || dist < best.dist)) best = { d, dist, point: point.clone(), part: null };
    }
    if (best) best.part = this.partAt(best.d, best.point);
    return best;
  }

  // Hurt an animal (Animate.cpp:690): `amount` is already scaled by armour. The brain
  // feels it (Brain.cpp:1526 HandleDamage) and wakes; tranquilliser darts drain its
  // tranq points instead, and below zero it goes limp (EmotionActivities.cpp:614).
  damage(d, amount, { tranq = 0, from = null } = {}) {
    if (!d.alive) return;
    const wasAwake = d.awake;
    this.wake(d);
    d.hidden = false;
    if (tranq > 0) {
      d.tranq -= tranq;
      if (d.tranq < 0 && !d.sedated) { d.sedated = true; this.game.audio?.vocal(d.vocal, 'Whimper', d.pos); }
    }
    if (amount <= 0) return;
    d.hp -= amount;
    const k = amount / d.maxHp;
    for (let i = 0; i < 9; i++) {
      d.emo[i] = THREE.MathUtils.clamp(d.emo[i] + d.dmgFeel[i] * k, 0, 1);
      d.opinion[i] += d.dmgFeel[i] * k;   // and it blames Anne
    }
    if (from) { d.seen = this.time; d.known.copy(from); }
    if (d.hp <= 0) { this.kill(d); return; }
    if (amount > d.critical) d.flinch = 0.6;   // CMessageDamage's critical flag: a stagger
    this.game.audio?.vocal(d.vocal, wasAwake ? 'Pain' : 'Snarl', d.pos);
  }

  kill(d) {
    if (!d.alive) return;
    d.alive = false;
    d.hp = Math.min(d.hp, 0);
    d.gait = 0;
    this.setGait(d);
    const game = this.game;
    game.audio?.vocal(d.vocal, 'Dying', d.pos);
    game.blood?.kill(d);
    if (game.physics?.ragdoll(d)) return;   // tumbles as a body, knocked by the shot
    // Down on its side.
    const side = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    d.pos.z = this.floorUnder(d) + this.sideHalf(d);
    game.setInstanceMatrix(d.index, game.matrixFor(d.inst, d.pos, d.yaw, side));
  }

  // Lying on its side (rotated about its length) its lowest point is half its width
  // below the centre.
  sideHalf(d) { return Math.max(Math.abs(d.bounds.min.x), Math.abs(d.bounds.max.x)) * d.scale; }

  // The floor or terrain under a standing animal.
  floorUnder(d) {
    const terrain = this.game.groundAt(d.pos.x, d.pos.y);
    return this.groundUnder(d.pos.x, d.pos.y, Math.max(terrain, d.pos.z - d.foot) + 0.5) ?? terrain;
  }

  // Where the body's middle is now: walking, lying down or tumbling as a physics body
  // (the drawn instance's origin; the models are centred on the body).
  bodyCentre(d, out = new THREE.Vector3()) {
    const ref = this.game.refs[d.index]?.[0];
    if (!ref) return out.copy(d.pos);
    ref.mesh.getMatrixAt(ref.i, _m);
    return out.setFromMatrixPosition(_m);
  }

  // A gunshot (Gun.cpp:446 AlertAnimals): everything within `radius` of Anne notices her.
  alert(at, radius) {
    for (const d of this.list) {
      if (!d.alive || d.hidden) continue;
      if (d.pos.distanceTo(at) > radius) continue;
      this.wake(d);
      d.seen = this.time;
      d.known.copy(at);
    }
  }

  wake(d) {
    if (!d.awake) d.awake = true;
  }

  // ---------------------------------------------------------------- the step

  update(dt, player) {
    this.player = player;
    this.time += dt;
    const boring = window.__cheats?.dinos;
    for (const d of this.list) {
      if (d.hidden) {
        if (d.teleported) this.activate(d);   // triggers.js TELEPORT moved it in
        else continue;
      }
      if (!d.alive) {
        // Dead animals bleed out to ReallyDie (Animate.cpp:521).
        d.hp = Math.max(d.reallyDie, d.hp - d.dieRate * dt);
        continue;
      }
      this.applyScript(d);
      // Regeneration (Animate.cpp:512): hit points and tranq points refill.
      d.hp = Math.min(d.maxHp, d.hp + d.regeneration * dt);
      d.tranq = Math.min(d.maxHp, d.tranq + d.regeneration * dt);
      if (d.sedated && d.tranq >= 0) d.sedated = false;
      // Pain fades in 2 s (MentalState.cpp:107); fatigue is how hurt it is (Brain.cpp).
      d.emo[PAIN] = Math.max(0, d.emo[PAIN] - dt * 0.5);
      d.emo[FATIGUE] = Math.max(0, 1 - d.hp / d.maxHp);

      const dist = d.pos.distanceTo(player.pos);
      // Sleep and wake (AIMain.cpp:787-872): active within WakeUp of Anne, dormant past
      // Sleep. Whatever woke it (a shot, a trigger) pushes the sleep distance out.
      if (boring) { d.awake = false; d.wasAwake = false; }
      else {
        if (!d.awake && dist < d.wakeDist) d.awake = true;
        if (d.awake && !d.wasAwake) d.sleepDist = Math.max(d.sleepDist, Math.max(dist, d.wakeDist) + 10);
        if (d.awake && dist > d.sleepDist && !d.stay?.forced) d.awake = false;
        d.wasAwake = d.awake;
      }
      if (!d.awake || d.sedated) {
        d.speed = 0;
        if (d.sedated) this.lieDown(d);
        this.animate(d, dt, player, dist);
        continue;
      }
      d.think -= dt;
      if (d.think <= 0) { d.think = THINK * rand(0.8, 1.2); this.decide(d, player, dist); }
      this.act(d, dt, player, dist);
      this.animate(d, dt, player, dist);
    }
    this.separate();
  }

  // ---------------------------------------------------------------- thinking

  rate(d, w) {
    let r = 0;
    for (let i = 0; i < 9; i++) r += d.emo[i] * d.opinion[i] * w[i];
    return r;
  }

  // CActivityDistance::rtRate (Activity.cpp:1036): moves toward or away from a target
  // matter less the further off it is.
  falloff(dist) { return dist > 3 ? 1 / (1 + 0.5 * (dist - 3)) : 1; }

  canSee(d, player) {
    // Brain.cpp:1016: the vision sphere is centred 0.75 x range ahead of its head.
    const fx = -Math.sin(d.yaw), fy = Math.cos(d.yaw);
    const cx = d.pos.x + fx * SIGHT * 0.75, cy = d.pos.y + fy * SIGHT * 0.75;
    return Math.hypot(player.pos.x - cx, player.pos.y - cy) < SIGHT || d.pos.distanceTo(player.pos) < 6;
  }

  decide(d, player, dist) {
    const a = d.acts;
    if (this.canSee(d, player)) {
      if (this.time - d.seen > FORGET) this.noticed(d, dist);
      d.seen = this.time;
      d.known.copy(player.pos);
    }
    const knows = this.time - d.seen < FORGET;
    const tDist = knows ? d.pos.distanceTo(d.known) : 1e9;
    const f = this.falloff(tDist);
    const options = [];
    if (knows) {
      if (a.Approach) options.push(['approach', this.rate(d, W.approach) * f]);
      if (a.MoveBy) options.push(['moveBy', this.rate(d, W.moveBy) * f * (this.anneFacingAway(d, player) ? 0.2 : 1)]);
      if (a.Flee) options.push(['flee', this.rate(d, W.flee) * f]);
      if (a.Pursue) options.push(['approach', this.rate(d, W.approach) * f]);
      if (a.MoveToward) options.push(['toward', this.rate(d, W.toward) * f]);
    }
    // StayNear (MoveActivities.cpp:926): 1 when too far from its anchor, and it keeps
    // going until close enough.
    if (d.stay && a.StayNear !== false) {
      const at = this.locate(d.stay.target, _v2) || d.home;
      const r = Math.hypot(at.x - d.pos.x, at.y - d.pos.y);
      d.anchor = at.clone ? at.clone() : at;
      if (r > d.stay.max || (d.act === 'stayNear' && r > d.stay.ok)) options.push(['stayNear', 1]);
    }
    if (d.away) {
      const at = this.locate(d.away.target, _v2);
      if (at) {
        const r = Math.hypot(at.x - d.pos.x, at.y - d.pos.y);
        d.awayFrom = at.clone();
        if (r < d.away.min || (d.act === 'stayAway' && r < d.away.ok)) options.push(['stayAway', 1]);
      }
    }
    if (a.Wander) options.push(['wander', this.rate(d, W.wander)]);
    // Pick the best; what it is already doing gets a little extra (TryToContinue).
    let best = 'idle', bestR = 0;
    for (const [name, r0] of options) {
      const r = r0 * (name === d.act ? 1.25 : 1) * rand(0.9, 1.1);
      if (r > bestR) { best = name; bestR = r; }
    }
    if (best !== d.act) this.begin(d, best, tDist);
    // The attack sub-brain runs alongside the movement one: bite (or ram) when Anne is
    // within reach of the head (ActivityAttack.cpp:245 rtRate: 2 x HeadReach + lock).
    d.attack = null;
    if (knows && tDist < 2 * d.headReach + d.lock + 1) {
      if (a.Bite && this.rate(d, W.bite) > 0) d.attack = 'bite';
      else if (a.Ram && this.rate(d, W.ram) > 0) d.attack = 'ram';
    }
    this.steer(d, player);
  }

  noticed(d, dist) {
    if (!d.carnivore) { if (d.acts.Flee) this.game.audio?.vocal(d.vocal, 'Call', d.pos); return; }
    this.game.audio?.vocal(d.vocal, dist < 25 ? 'Snarl' : 'Roar', d.pos);
  }

  anneFacingAway(d, player) {
    const fx = -Math.sin(player.yaw), fy = Math.cos(player.yaw);
    return (d.pos.x - player.pos.x) * fx + (d.pos.y - player.pos.y) * fy < 0;
  }

  begin(d, act, tDist) {
    d.act = act;
    d.actT = 0;
    if (act === 'approach') d.cineT = 0;
    if (act === 'moveBy') {
      // MoveActivities.cpp:1925: pass by at a random side offset.
      const near = d.width < 5 ? rand(d.width + 0.5, 5) : d.width + 0.5;
      d.moveBy = { near: Math.random() < 0.5 ? -near : near, start: d.pos.clone(), giveUp: 15 };
    }
    if (act === 'flee' && Math.random() < 0.5) this.game.audio?.vocal(d.vocal, d.carnivore ? 'Whimper' : 'Call', d.pos);
    if (act === 'approach' && tDist > 12 && Math.random() < 0.4) this.game.audio?.vocal(d.vocal, 'Stalk', d.pos);
  }

  // Where it wants to go this thought, and how fast: d.want (unit x,y), d.speed.
  steer(d, player) {
    const sp = d.sp, run = sp.run * d.speedMul, walk = sp.walk * d.speedMul;
    const to = _v.copy(d.known).sub(d.pos).setZ(0);
    const tDist = to.length();
    to.normalize();
    let want = null, speed = 0;
    switch (d.act) {
      case 'approach': {
        // CActivityApproach::Act (MoveActivities.cpp:1790): run at the target from a
        // "cinematic" angle re-rolled every 1-6 s, straight in when close or when
        // Anne has her back to it. Pack mates on one team take opposite sides.
        if (d.cineT <= 0) {
          d.cineT = rand(1, 6);
          const mate = this.list.find((o) => o !== d && o.alive && o.awake && o.team === d.team && o.act === 'approach' && o.cine && o.pos.distanceTo(d.pos) < 25);
          d.cine = rand(0.2, 0.8) * (mate ? -Math.sign(mate.cine) : Math.random() < 0.5 ? -1 : 1);
        }
        const straight = tDist < 5 || this.anneFacingAway(d, player);
        want = rotate2(to, straight ? 0 : d.cine);
        // Stand off with its jaws at her rather than climbing onto her.
        const stand = d.jaw + 0.3;
        speed = tDist > stand ? run : 0;
        if (tDist < stand * 3 && tDist > stand) speed = Math.min(run, walk + (tDist - stand) * 2);
        break;
      }
      case 'moveBy': {
        const m = d.moveBy;
        if (Math.abs(m.near) < tDist && m.start.distanceToSquared(d.known) > m.start.distanceToSquared(d.pos)) {
          want = rotate2(to, Math.asin(m.near / tDist));
        } else {
          want = { x: -Math.sin(d.yaw), y: Math.cos(d.yaw) };
          m.giveUp = Math.min(m.giveUp, d.actT + 1);
          if (tDist > 7 || d.actT > m.giveUp) d.act = 'idle';
        }
        speed = run;
        break;
      }
      case 'flee': {
        // CActivityFlee::Act: away from the threat, blended with its own heading x 2
        // once that heading already leads away (so it turns first, then runs on).
        const hx = -Math.sin(d.yaw), hy = Math.cos(d.yaw), k = 2 * Math.max(0, -(hx * to.x + hy * to.y));
        const fx = hx * k - to.x, fy = hy * k - to.y;
        const l = Math.hypot(fx, fy) || 1;
        want = { x: fx / l, y: fy / l };
        speed = run;
        break;
      }
      case 'toward':
        want = { x: to.x, y: to.y };
        speed = tDist > d.headReach + 1 ? walk * 1.5 : 0;
        break;
      case 'stayNear': {
        const a = d.anchor || d.home;
        const dx = a.x - d.pos.x, dy = a.y - d.pos.y, l = Math.hypot(dx, dy) || 1;
        want = { x: dx / l, y: dy / l };
        speed = l > (d.stay?.max ?? 30) * 1.5 ? run * 0.8 : Math.max(walk, run * 0.45);
        break;
      }
      case 'stayAway': {
        const a = d.awayFrom;
        const dx = d.pos.x - a.x, dy = d.pos.y - a.y, l = Math.hypot(dx, dy) || 1;
        want = { x: dx / l, y: dy / l };
        speed = run * 0.6;
        break;
      }
      case 'wander': {
        // Wander (MoveActivities.cpp:567): drift, pulled back toward its anchor.
        d.wanderT -= THINK;
        if (d.wanderT <= 0) { d.wanderT = rand(4, 10); d.wanderYaw = d.yaw + rand(-0.9, 0.9); }
        let wx = -Math.sin(d.wanderYaw), wy = Math.cos(d.wanderYaw);
        const a = d.stay ? (d.anchor || d.home) : null;
        if (a) {
          const dx = a.x - d.pos.x, dy = a.y - d.pos.y, l = Math.hypot(dx, dy) || 1;
          const pull = THREE.MathUtils.clamp(l / (d.stay.max || 30), 0, 1);
          wx += (dx / l) * pull * 1.5; wy += (dy / l) * pull * 1.5;
          const n = Math.hypot(wx, wy) || 1; wx /= n; wy /= n;
        }
        want = { x: wx, y: wy };
        speed = walk;
        break;
      }
      default:
        // Nothing / look around: stand, and turn to face Anne if it knows of her.
        speed = 0;
        d.turnTo = this.time - d.seen < FORGET ? Math.atan2(to.y, to.x) - Math.PI / 2 : null;
    }
    if (d.attack && tDist < d.jaw + 1.5) {
      // Biting: face her, only shuffling in.
      want = { x: to.x, y: to.y };
      speed = Math.min(speed, tDist > d.jaw + 0.3 ? walk : 0);
    }
    if (d.flinch > 0) speed *= 0.2;
    if (want) {
      const free = this.clearPath(d, want, speed);
      d.moveDir = free;
      if (!free) speed = 0;
      d.turnTo = free ? Math.atan2(free.y, free.x) - Math.PI / 2 : d.turnTo;
    } else d.moveDir = null;
    d.speed = speed;
  }

  // Feelers: the first free heading nearest `want` (unit x,y), trying either side;
  // null when boxed in. A hit counts as a wall where it is steeper than the animal can
  // climb (UpAngle); the sea counts as a wall too.
  clearPath(d, want, speed) {
    const bvh = this.game.collider?.boundsTree;
    const look = THREE.MathUtils.clamp(speed * 0.9, 1.5, 8) + d.width * 0.5;
    const base = Math.atan2(want.y, want.x);
    const offs = [0, 0.35, 0.7, 1.1, 1.6, 2.2, 2.9];
    for (const o of offs) {
      for (const s of o ? [d.avoidSide, -d.avoidSide] : [1]) {
        const ang = base + o * s;
        const dir = { x: Math.cos(ang), y: Math.sin(ang) };
        if (!bvh || this.free(d, dir, look)) {
          if (o) d.avoidSide = s;
          return dir;
        }
      }
    }
    return null;
  }

  free(d, dir, look) {
    const bvh = this.game.collider.boundsTree;
    const ground = d.pos.z - d.foot;
    const h = THREE.MathUtils.clamp(d.foot * 0.5, 0.35, 2.5);
    _ray.origin.set(d.pos.x, d.pos.y, ground + h);
    _ray.direction.set(dir.x, dir.y, 0);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, look);
    if (hit && Math.abs(hit.face?.normal?.z ?? 0) < d.minNormalZ) return false;
    // Water: no wading out to sea.
    const sea = this.game.info.sea;
    if (sea !== null && sea !== undefined) {
      const g = this.groundUnder(d.pos.x + dir.x * look, d.pos.y + dir.y * look, ground + 3);
      if (g !== null && g < sea - 0.3) return false;
    }
    return true;
  }

  // The first surface below (x, y, from): terrain, floors, rocks, bridges.
  groundUnder(x, y, from) {
    const bvh = this.game.collider?.boundsTree;
    if (!bvh) return null;
    _ray.origin.set(x, y, from);
    _ray.direction.copy(DOWN);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 80);
    return hit ? hit.point.z : null;
  }

  // ---------------------------------------------------------------- acting

  act(d, dt, player, dist) {
    d.actT += dt;
    d.cineT -= dt;
    d.flinch = Math.max(0, d.flinch - dt);
    // Turn toward where it is heading.
    if (d.turnTo !== null && d.turnTo !== undefined) {
      const diff = wrap(d.turnTo - d.yaw);
      const turn = d.sp.turn * (d.speed > 0 ? 1 : 0.7);
      d.yaw += THREE.MathUtils.clamp(diff, -turn * dt, turn * dt);
    }
    // Move along its heading (it turns before it runs: slower while facing away).
    if (d.speed > 0 && d.moveDir) {
      const fx = -Math.sin(d.yaw), fy = Math.cos(d.yaw);
      const facing = Math.max(0.15, fx * d.moveDir.x + fy * d.moveDir.y);
      const step = d.speed * facing * dt;
      const sx = fx * step, sy = fy * step;
      // A last short feeler along the actual step: never into a wall.
      if (!this.game.collider || this.free(d, { x: fx, y: fy }, step + d.width * 0.4)) {
        d.pos.x += sx; d.pos.y += sy;
        const g = this.groundUnder(d.pos.x, d.pos.y, d.pos.z - d.foot + 1.2);
        const ground = g ?? this.game.groundAt(d.pos.x, d.pos.y);
        d.pos.z = ground + d.foot;
      } else d.think = Math.min(d.think, 0.05);
    }
    // The attack: wind up, chomp, recover (ActivityAttack.cpp:120, 1.3 s TryToContinue).
    d.biteCool = Math.max(0, d.biteCool - dt);
    if (d.attack && d.biteT <= 0 && d.biteCool === 0 && this.inReach(d, player, dist)) {
      d.biteT = 0.35;
      this.game.audio?.vocal(d.vocal, 'Attack', d.pos);
    }
    if (d.biteT > 0) {
      d.biteT -= dt;
      if (d.biteT <= 0) {
        d.biteCool = 1.0;
        if (this.inReach(d, player, d.pos.distanceTo(player.pos))) {
          const dmg = d.boxes.head[1] * 10 * CHOMP;   // a ram hits with the head box too
          if (dmg > 0) {
            this.game.audio?.vocal(d.vocal, 'Bite', d.pos);
            this.game.blood?.bite(d, player);
            this.game.hurt(dmg);
            this.lastBite = { name: d.name, dmg, t: this.time };
          }
        }
      }
    }
    // Now and then a call, so you hear what is out there.
    d.callT -= dt;
    if (d.callT <= 0) {
      d.callT = 12 + Math.random() * 25;
      if (dist < 250) {
        const knows = this.time - d.seen < FORGET;
        this.game.audio?.vocal(d.vocal, knows && d.carnivore ? (dist < 20 ? 'Snarl' : 'Stalk') : 'Call', d.pos, 0.8);
      }
    }
  }

  // Anne within the head's reach, in front of it.
  inReach(d, player, dist) {
    if (Math.abs(player.pos.z + 1 - (d.pos.z)) > d.headReach + 2) return false;
    const dx = player.pos.x - d.pos.x, dy = player.pos.y - d.pos.y;
    const flat = Math.hypot(dx, dy);
    if (flat > d.jaw + 0.9) return false;
    const fx = -Math.sin(d.yaw), fy = Math.cos(d.yaw);
    if ((dx * fx + dy * fy) / (flat || 1) <= 0.45) return false;
    // Not through a wall, a crate or a fence.
    const bvh = this.game.collider?.boundsTree;
    if (!bvh) return true;
    _ray.origin.set(d.pos.x, d.pos.y, d.pos.z);
    _ray.direction.set(dx, dy, player.pos.z + 1.2 - d.pos.z);
    const len = _ray.direction.length();
    _ray.direction.divideScalar(len || 1);
    const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, len);
    return !hit || Math.abs(hit.face?.normal?.z ?? 0) >= d.minNormalZ;
  }

  // Sedated: limp on its side where it stands.
  lieDown(d) {
    const side = _m.makeRotationY(Math.PI / 2);
    d.gait = 0;
    const z = d.pos.z;
    d.pos.z = this.floorUnder(d) + this.sideHalf(d);
    this.game.setInstanceMatrix(d.index, this.game.matrixFor(d.inst, d.pos, d.yaw, side));
    d.pos.z = z;
    d.lying = true;
  }

  animate(d, dt, player, dist) {
    if (!d.sedated) {
      if (d.lying) d.lying = false;
      this.game.setInstanceMatrix(d.index, this.game.matrixFor(d.inst, d.pos, d.yaw));
    }
    // Gait amount for the walk shader: eases in as the animal moves.
    const moving = d.awake && !d.sedated && d.speed > 0.2;
    d.gait = THREE.MathUtils.lerp(d.gait || 0, moving ? Math.min(1, 0.4 + d.speed / (d.sp.run * d.speedMul)) : 0, Math.min(1, dt * 4));
    this.setGait(d);
  }

  setGait(d) {
    for (const { mesh, i } of this.game.refs[d.index] || []) {
      const a = mesh.geometry.getAttribute('aGait');
      if (a) { a.setX(i, d.gait); a.needsUpdate = true; }
    }
  }

  // Awake animals do not walk through each other.
  separate() {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (!a.alive || !a.awake || a.hidden) continue;
      for (let j = 0; j < L.length; j++) {
        const b = L[j];
        if (j === i || !b.alive || b.hidden) continue;
        const dx = a.pos.x - b.pos.x, dy = a.pos.y - b.pos.y;
        const r = (a.width + b.width) * 0.6 + 0.3;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r || d2 < 1e-6) continue;
        const l = Math.sqrt(d2), push = (r - l) * 0.5;
        a.pos.x += (dx / l) * push; a.pos.y += (dy / l) * push;
      }
    }
  }

  // For tests and the debug console.
  describe() {
    return this.list.filter((d) => !d.hidden && d.alive).map((d) => ({
      name: d.name, act: d.act, attack: d.attack, awake: d.awake, hp: +d.hp.toFixed(1), tranq: +d.tranq.toFixed(1),
      sedated: d.sedated, speed: +d.speed.toFixed(2), pos: [d.pos.x, d.pos.y, d.pos.z].map((v) => +v.toFixed(1)),
    }));
  }
}

function rotate2(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
