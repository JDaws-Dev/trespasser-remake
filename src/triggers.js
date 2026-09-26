// The original's trigger system (jp2_pc/Source/Lib/Trigger), run on the level's
// logic.json (tools/export_logic.py): location, start, timer, object, creature,
// collision, boolean, sequence and variable triggers with their fire counts, delays,
// repeat periods, probabilities and FireExpressions, and their action lists processed
// by ProcessStyle, dispatched to the rest of the game: voice-overs, music, ambient
// sets and sound effects (audio.js), tutorial text and F1 hints, damage / heal / kill,
// teleports, SET_PHYSICS freeze / impulse / velocity and MAGNET (Rapier, physics.js),
// hide / show, AI wake-ups, level loads and the end of the game (frontend.js).
// Game coordinates throughout (metres, Z up).
import * as THREE from 'three';
import { front, LEVELS } from './frontend.js';
import { Cheats } from './cheats.js';

const TICK = 1 / 30;                 // trigger evaluation rate (the original ran them per frame)
const ANNE_CENTRE = 0.9;             // Anne's origin above her feet, for point triggers
const MUSIC_DUCK_DB = 10;            // AudioDaemon.hpp MUSIC_VOLUME_ADJUST
const MAX_DELAYED_VOICEOVER = 12;
const TOUCH = matchMedia('(pointer: coarse)').matches;

// Action processing styles (Trigger.hpp EActionProcess).
const ALL = 0, STEP_ORDER = 1, STEP_RANDOM = 2, SEQ_ORDER = 3, SEQ_RANDOM = 4, SEQ_ORDER_LOOP = 5, SEQ_RANDOM_LOOP = 6;

const db = (v) => Math.pow(10, v / 20);
const rand = (a, b) => a + Math.random() * (b - a);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();

// The tutorial's key names, for this port's controls (input.js / hand.js).
const REWRITE = TOUCH ? [
  [/press 'Q' to jump up\.?/i, 'Tap JUMP to jump up.'],
  [/To move forward, press and hold 'W'\./i, 'To move forward, push the left stick.'],
  [/To look around, move your mouse\./i, 'To look around, drag the right stick.'],
  [/Press 'A' and 'D' to step left and right\./i, 'Push the left stick sideways to step left and right.'],
  [/And press 'Z' to crouch\./i, 'And tap CROUCH to crouch.'],
  [/press the space bar/i, 'tap FIRE'],
  [/Press 'F' to throw an object you are holding\./i, 'Tap THROW to throw an object you are holding.'],
  [/Press the right button to drop it\./i, 'Tap GRAB to drop it.'],
  [/Try pressing and holding the left mouse button\./i, 'Tap HAND to raise your hand.'],
  [/Now, moving the mouse moves your hand\./i, 'Now the right stick moves your hand.'],
  [/Then click the right mouse button\./i, 'Then tap GRAB.'],
  [/Hold the left mouse button and move the mouse to wield/i, 'Raise your hand with HAND and move the right stick to wield'],
  [/press F1/i, 'tap ?'],
] : [
  [/press 'Q' to jump up\.?/i, 'Press Space to jump up.'],
  [/press the space bar/i, 'click the left mouse button'],
  [/Press 'F' to throw/i, "Press 'Q' to throw"],
  [/Press the right button to drop it\./i, 'Left-click with your hand up to let go of it.'],
  [/Try pressing and holding the left mouse button\./i, 'Try pressing and holding the right mouse button.'],
  [/Then click the right mouse button\./i, 'Then click the left mouse button.'],
  [/Hold the left mouse button and move the mouse to wield/i, 'Hold the right mouse button and move the mouse to wield'],
  [/And press 'Z' to crouch\./i, "And hold 'C' to crouch."],
  [/holding control \+ the left mouse button/i, 'holding Ctrl and the right mouse button'],
  [/press shift \+\s+left mouse button/i, 'hold Shift and the right mouse button'],
];
const rewrite = (s) => REWRITE.reduce((t, [re, to]) => t.replace(re, to), s);

// ------------------------------------------------------------------ FireExpression
// ExpressionEvaluate.cpp: operands are trigger names (latched "has fired"), '@name'
// asks the trigger for its state now (bEvaluateNow); '!' negates the next operand or
// bracket; & | ^ = are evaluated strictly left to right, without precedence.
function parseExpression(src) {
  const s = src.replace(/\s+/g, '');
  let i = 0;
  const operand = () => {
    let neg = 0;
    while (s[i] === '!') { neg++; i++; }
    let node;
    if (s[i] === '(') { i++; node = sequence(); if (s[i] === ')') i++; }
    else {
      let j = i;
      while (j < s.length && !'&|^=()!'.includes(s[j])) j++;
      const name = s.slice(i, j); i = j;
      node = name[0] === '@' ? { query: name.slice(1) } : { name };
    }
    return neg % 2 ? { not: node } : node;
  };
  const sequence = () => {
    let left = operand();
    while (i < s.length && '&|^='.includes(s[i])) { const op = s[i++]; left = { op, a: left, b: operand() }; }
    return left;
  };
  return sequence();
}

export class Triggers {
  constructor({ game, physics, player, audio, level, groundAt }) {
    Object.assign(this, { game, physics, player, audio, level, groundAt });
    this.t = 0;
    this.acc = 0;
    this.ready = false;
    this.list = [];
    this.byName = new Map();
    this.log = [];                  // [{ t, trigger, actions }] for tests and the console
    this.voice = { playing: null, queue: [] };
    this.music = null;
    this.ambients = new Set();
    this.hintId = null;
    this.hidden = new Map();
    this.dispatched = {};           // action type -> count
    this.unhandled = {};            // action type -> count (no effect in the remake yet)
    this.leaving = false;
    game.logic = this;
    window.__triggers = this;
    this.makeOverlay();
    this.loaded = fetch(`levels/${level}/logic.json`).then((r) => (r.ok ? r.json() : null)).then((j) => j && this.init(j))
      .catch((e) => console.warn('logic.json:', e));
  }

  // ---------------------------------------------------------------- setup

  init(logic) {
    this.logic = logic;
    this.objects = logic.objects || {};
    this.hints = logic.hints || {};
    this.instByName = new Map(this.game.info.instances.map((inst) => [inst.name, inst]));
    for (const d of this.game.dinos) this.dinoByName ||= new Map(), this.dinoByName.set(d.inst.name, d);
    this.dinoByName ||= new Map();
    const P = this.physics;
    // Physics bodies by name (physics.body also resolves attached parts to what they ride on).
    this.bodyByName = { get: (n) => (n && P?.body ? P.body(n) : null) };
    for (const src of logic.triggers) {
      const c = src.cond;
      const life = c.FireCount === undefined || c.FireCount < 0 ? Infinity : c.FireCount;
      const rot = new THREE.Matrix4().set(...src.rot[0], 0, ...src.rot[1], 0, ...src.rot[2], 0, 0, 0, 0, 1);
      const t = {
        ...src, c, life, resetLife: c.FireZero && c.ResetFire ? life : 0,
        prob: c.Prob === undefined ? 1 : c.Prob / 100, dead: false,
        delay: c.FireDelay || 0, repeat: c.RepeatPeriod || 0, style: c.ProcessStyle || 0,
        fireTime: -1, nextFireTime: 0, seq: false, nextAction: 0, nextActionTime: 0, fired: false,
        expr: c.FireExpression ? parseExpression(c.FireExpression) : null,
        inv: rot.clone().transpose(), origin: new THREE.Vector3(...src.pos),
        contained: new Set(), enterCount: 0, leaveCount: 0,
      };
      // Location conditions (LocationTrigger.cpp); with none, the player walking in.
      if (t.kind === 'location') {
        const any = ['PlayerEnterTrigger', 'PlayerLeaveTrigger', 'PlayerInTrigger', 'ObjectEnterTrigger', 'ObjectLeaveTrigger',
          'ObjectInTrigger', 'CreatureEnterTrigger', 'CreatureLeaveTrigger', 'CreatureInTrigger'].some((k) => c[k]) || c.EnterCount > 0 || c.LeaveCount > 0;
        t.want = {
          player: !any || c.PlayerEnterTrigger || c.PlayerLeaveTrigger || c.PlayerInTrigger,
          object: c.ObjectEnterTrigger || c.ObjectLeaveTrigger || c.ObjectInTrigger,
          creature: c.CreatureEnterTrigger || c.CreatureLeaveTrigger || c.CreatureInTrigger || c.EnterCount > 0 || c.LeaveCount > 0,
        };
        t.enter = { player: !any || !!c.PlayerEnterTrigger, object: !!c.ObjectEnterTrigger, creature: !!c.CreatureEnterTrigger };
        t.leave = { player: !!c.PlayerLeaveTrigger, object: !!c.ObjectLeaveTrigger, creature: !!c.CreatureLeaveTrigger };
        t.always = { player: !!c.PlayerInTrigger, object: !!c.ObjectInTrigger, creature: !!c.CreatureInTrigger };
        t.point = c.PointTrigger !== false;
      }
      if (t.kind === 'timer') {
        t.state = false;
        t.remain = c.InitialState ? 0 : rand(c.MinLowTime ?? 1, c.MaxLowTime ?? 1);
      }
      if (t.kind === 'variable') t.value = !!c.Value;
      this.list.push(t);
      this.byName.set(t.name, t);
    }
    this.sequences = this.list.filter((t) => t.kind === 'sequence').map((t) => ({ t, order: [] }));
    // (Frozen objects are created fixed by physics.js; SET_PHYSICS lets them go.)
    // Pickup / creature state, for object and creature triggers.
    this.lastHeld = new Set();
    this.dinoState = new Map(this.game.dinos.map((d) => [d, { alive: d.alive, awake: d.awake, hp: d.hp }]));
    this.wrapGameEvents();
    this.makeAnimated(logic.anim || {});
    this.cheats = new Cheats(this);
    this.ready = true;
  }

  // Object triggers hear "use" when a held gun fires (CMessageUse).
  wrapGameEvents() {
    const g = this.game, fire = g.fire.bind(g), hurt = g.hurt.bind(g);
    // Anne's death is a creature event too: Industrial Jungle's splash-down trigger
    // (CreatureDie on "Player") catches a fatal landing in the pond and heals her.
    g.hurt = (amount) => {
      if (!g.dead && g.hp - amount <= 0 && this.anneDies()) return;   // the trigger has set her hit points
      hurt(amount);
    };
    g.fire = (player) => {
      const gun = g.gun, ammo = gun?.ammo;
      fire(player);
      if (gun && gun.ammo !== ammo) this.objectEvent('use', gun.inst.name);
    };
  }

  anneDies() {
    let saved = false;
    for (const t of this.list) {
      if (t.kind === 'creature' && t.c.CreatureDie && t.c.objects?.includes('Player') && this.attempt(t)) saved = true;
    }
    return saved;
  }

  // ---------------------------------------------------------------- where things are

  anneCentre(out = new THREE.Vector3()) {
    const p = this.player.pos;
    return out.set(p.x, p.y, p.z + ANNE_CENTRE - (this.player.crouch || 0) * 0.5);
  }

  // The current position of a named object: Anne and her parts, a dinosaur, a physics
  // body, a placed instance, or a logic helper (emitter, teleport destination...).
  locate(name, out = new THREE.Vector3()) {
    if (!name) return null;
    if (name === 'Anne' || name === 'Player' || name === '$AnneBody+Anne') return this.anneCentre(out);
    if (name === '$AnneFoot+Anne') return out.copy(this.player.pos);
    if (name === '$AnneHand+Anne') {
      // The palm where it really is (physics.js drives it toward where she reaches).
      const h = this.physics?.hand;
      if (!h || h.mode !== 'arm' || !h.active) return null;
      // The fingertips: 8 cm along the palm's +Y (keypads are pressed with them).
      const r = this.physics.handBody?.rotation();
      if (r) return out.set(0, 0.08, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(h.pos);
      return out.copy(h.pos);
    }
    const d = this.dinoByName.get(name);
    if (d) return out.copy(d.pos);
    const e = this.bodyByName.get(name);
    if (e) return out.copy(e.curP);
    const moved = this.movedObjects?.get(name);
    if (moved) return out.copy(moved.pos);
    const o = this.objects[name] || this.instByName.get(name);
    return o ? out.fromArray(o.pos) : null;
  }

  // Roughly how far an object reaches from its origin (for non-point triggers).
  radiusOf(name) {
    const e = this.bodyByName.get(name);
    if (e) return e.radius;
    if (/Anne$|^Player$/.test(name)) return 0.3;
    const o = this.objects[name];
    if (o?.box) return (o.scale || 1) * Math.max(...o.box[0].map(Math.abs), ...o.box[1].map(Math.abs));
    return 0.3;
  }

  // An object's placement matrix (rotation and position, no scale).
  placement(name) {
    const e = this.bodyByName.get(name);
    if (e) return new THREE.Matrix4().compose(e.curP, e.curQ, _v2.set(1, 1, 1));
    const moved = this.movedObjects?.get(name);
    if (moved) return new THREE.Matrix4().compose(moved.pos, moved.quat, _v2.set(1, 1, 1));
    const o = this.objects[name] || this.instByName.get(name) || this.physics?.marker?.(name);
    if (!o) return null;
    const r = o.rot;
    return new THREE.Matrix4().set(r[0][0], r[0][1], r[0][2], o.pos[0], r[1][0], r[1][1], r[1][2], o.pos[1],
      r[2][0], r[2][1], r[2][2], o.pos[2], 0, 0, 0, 1);
  }

  // Is a point in the trigger's volume? Non-point triggers test the object's bounds
  // (bIntersects): approximated by a sphere of radius `r` about the point.
  inside(t, p, r = 0) {
    const s = t.scale || 1, m = t.point ? 0 : r / s;
    _v.copy(p).sub(t.origin).applyMatrix4(t.inv).divideScalar(s);
    if (t.shape?.type === 'box') {
      const [lo, hi] = t.shape.box;
      return _v.x >= lo[0] - m && _v.x <= hi[0] + m && _v.y >= lo[1] - m && _v.y <= hi[1] + m && _v.z >= lo[2] - m && _v.z <= hi[2] + m;
    }
    return _v.length() <= 1 + m;
  }

  // ---------------------------------------------------------------- the step

  update(dt, player) {
    if (!this.ready) return;
    this.player = player || this.player;
    this.updateAudio();
    this.showText(dt);
    this.updateAnimated();
    if (this.game.dead || this.game.ui?.paused || this.leaving) return;
    this.cheats?.update(dt);
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.step();
    }
  }

  step() {
    const now = this.t += TICK;
    this.pollObjects();
    this.pollCreatures();
    for (const t of this.list) {
      switch (t.kind) {
        case 'start': if (!t.started) { t.started = true; if (!t.dead) this.fire(t); } break;
        case 'location': this.stepLocation(t); break;
        case 'timer': this.stepTimer(t); break;
        case 'boolean': this.attempt(t); break;
        case 'collision': this.stepCollision(t); break;
        default: break;
      }
      // Delayed fires and sequenced actions (CTrigger::Process).
      if (t.fireTime > 0 && now > t.fireTime) { t.fireTime = -1; this.fire(t); }
      if (t.seq && now > t.nextActionTime) this.stepSequence(t);
    }
  }

  stepLocation(t) {
    const act = t.c.TriggerActivate;
    const check = (id, p, type, r = 0.3) => {
      if (!p) { if (t.contained.has(id)) this.moved(t, id, type, false); return; }
      const e = !t.point && typeof id !== 'string' ? id : !t.point && typeof id === 'string' ? this.bodyByName.get(id) : null;
      const inn = e?.inst && e.body ? this.overlapsBody(t, e) : this.inside(t, p, r);
      if (inn !== t.contained.has(id)) this.moved(t, id, type, inn);
    };
    if (act) {
      // Anne's hand, foot and body boxes are objects to a trigger; only Anne is the player.
      const type = /^Anne$|^Player$/.test(act) ? 'player' : this.dinoByName.has(act) ? 'creature' : 'object';
      const r = act === '$AnneHand+Anne' ? 0.02 : this.radiusOf(act);
      check(act, this.locate(act, _v2), type, r);
      if ((t.always.player || t.always.object || t.always.creature) && t.contained.has(act)) this.attempt(t);
      return;
    }
    if (t.want.player) check('Anne', this.anneCentre(_v2), 'player');
    if (t.want.creature) for (const d of this.game.dinos) check(d, d.pos, 'creature');
    if (t.want.object && this.physics) {
      // Anne's hand is a tangible, moveable box too (the as2 elevator's call buttons).
      check('$AnneHand+Anne', this.locate('$AnneHand+Anne', _v2), 'object', 0.02);
      // Tangible moveable objects: those moving now, and those already inside.
      for (const e of this.physics.live) check(e, e.curP, 'object', e.radius);
      for (const e of t.contained) if (e.curP && !this.physics.live.has(e)) check(e, e.curP, 'object', e.radius);
    }
    if (t.always.player || t.always.object || t.always.creature) {
      for (const id of t.contained) {
        const type = id === 'Anne' ? 'player' : this.game.dinos.includes(id) ? 'creature' : 'object';
        if (t.always[type]) { this.attempt(t); break; }
      }
    }
  }

  // A non-point trigger against a body (bIntersects): its box's corners and centre
  // tested against the volume, and the volume's centre against its box.
  overlapsBody(t, e) {
    const s = e.scale || 1, q = e.curQ, c = e.curP;
    if (this.inside(t, c)) return true;   // its origin (a lever's pivot, a card's middle)
    // Its physics boxes (the compound's, as the original collides it), else its mesh box.
    const boxes = this.physics.boxes?.[e.inst.name]?.map((b) => ({ c: new THREE.Vector3().fromArray(b.pos), h: new THREE.Vector3().fromArray(b.half), r: b.rot }))
      || [(() => { const bb = this.physics.modelBounds(e.inst.model); return { c: bb.getCenter(new THREE.Vector3()), h: bb.getSize(new THREE.Vector3()).multiplyScalar(0.5), r: null }; })()];
    for (const b of boxes) {
      // The volume's centre in the box's frame, clamped to the box, and back.
      const bq = b.r ? new THREE.Quaternion().setFromRotationMatrix(_m.set(b.r[0][0], b.r[0][1], b.r[0][2], 0, b.r[1][0], b.r[1][1], b.r[1][2], 0, b.r[2][0], b.r[2][1], b.r[2][2], 0, 0, 0, 0, 1)) : new THREE.Quaternion();
      const wq = _q2.copy(q).multiply(bq);
      const centre = _v3.copy(b.c).multiplyScalar(s).applyQuaternion(q).add(c);
      const local = t.origin.clone().sub(centre).applyQuaternion(wq.clone().invert());
      const hs = b.h.clone().multiplyScalar(s);
      local.clamp(hs.clone().negate(), hs);
      if (this.inside(t, local.applyQuaternion(wq).add(centre))) return true;
    }
    return false;
  }

  // CLocationTrigger::Evaluate: something crossed the volume's boundary.
  moved(t, id, type, entered) {
    let fire = false;
    if (entered) {
      t.contained.add(id);
      if (type === 'creature' && t.c.EnterCount > 0 && ++t.enterCount >= t.c.EnterCount) { t.enterCount = 0; fire = true; }
      if (t.enter[type]) fire = true;
    } else {
      t.contained.delete(id);
      if (type === 'creature' && t.c.LeaveCount > 0 && ++t.leaveCount >= t.c.LeaveCount) { t.leaveCount = 0; fire = true; }
      if (t.leave[type]) fire = true;
      if (t.style === SEQ_ORDER_LOOP || t.style === SEQ_RANDOM_LOOP) t.seq = false;
    }
    if (fire) this.attempt(t);
  }

  stepTimer(t) {
    t.remain -= TICK;
    if (t.remain > 0 || t.dead) return;
    const c = t.c;
    if (t.state) { t.state = false; t.remain = rand(c.MinLowTime ?? 1, c.MaxLowTime ?? 1); }
    else { t.state = true; t.remain = rand(c.MinHighTime ?? 1, c.MaxHighTime ?? 1); this.attempt(t); }
  }

  // CCollisionTrigger: Element1 (and Element2, if named) touching. Elements are
  // physics bodies (contacts from Rapier), Anne's foot, body or hand, or objects the
  // remake keeps static (their box, placed, against the other's position).
  stepCollision(t) {
    if (t.dead) return;
    const c = t.c;
    const touching = c.SoundMaterial1 || c.SoundMaterial2 ? this.touchingMaterial(c) : this.touching(c.Element1, c.Element2);
    // Contact keeps sending collisions: with a RepeatPeriod (the fences: every 0.15 s)
    // it fires again while held there; without one, once per touch.
    if (touching && (!t.touch || t.repeat > 0)) this.attempt(t);
    t.touch = touching;
  }

  touching(n1, n2) {
    const P = this.physics;
    const e1 = this.bodyByName.get(n1), e2 = n2 ? this.bodyByName.get(n2) : null;
    const handCol = P?.handCol && P.hand?.mode === 'arm' ? P.handCol : null;
    const collidersOf = (e) => { const out = []; for (let i = 0; i < e.body.numColliders(); i++) out.push(e.body.collider(i)); return out; };
    const contact = (ca, cb) => {
      let hit = false;
      P.world.contactPair(ca, cb, (m) => { if (m.numContacts() > 0) hit = true; });
      return hit;
    };
    // One element: anything bumping it. Anne counts by her feet (the temple's floor
    // plates, a chair she walks into), as her body collides in the original.
    if (!n2 && this.nearBox(n1, this.player.pos, 0.15)) return true;
    if (e1 && !n2) {
      // A button: anything touching it that moves it or is the hand.
      for (const ca of collidersOf(e1)) {
        if (handCol && contact(ca, handCol)) return true;
        let hit = false;
        P.world.contactPairsWith(ca, (other) => {
          if (hit || other.parent()?.handle === P.ground.handle) return;
          if (contact(ca, other)) hit = true;
        });
        if (hit) return true;
      }
      const held = P.hand?.holding || P.held?.entry;
      return held && held !== e1 && held.curP.distanceTo(e1.curP) < held.radius + e1.radius * 0.6;
    }
    if (e1 && e2) {
      for (const ca of collidersOf(e1)) for (const cb of collidersOf(e2)) if (contact(ca, cb)) return true;
      return false;
    }
    // One side static (or Anne): the other's position against its placed box.
    const [dyn, stat] = e1 ? [n1, n2] : [n2, n1];
    const p = this.locate(dyn, new THREE.Vector3());
    if (!p) return false;
    const e = this.bodyByName.get(dyn);
    return this.nearBox(stat, p, (e?.radius || 0.3) * 0.7 + 0.05);
  }

  // An element against a sound material (the lab's electric fences): its position
  // against every object of that material nearby.
  touchingMaterial(c) {
    const [mat, other] = c.SoundMaterial2 ? [c.Element2, c.Element1] : [c.Element1, c.Element2];
    const list = this.logic.materials?.[mat];
    if (!list || !other) return false;
    const p = this.locate(other, new THREE.Vector3());
    if (!p) return false;
    const margin = other === '$AnneFoot+Anne' ? 0.35 : other === '$AnneHand+Anne' ? 0.03 : other === '$AnneBody+Anne' ? 0.3 : this.radiusOf(other);
    for (const o of list) {
      const dx = p.x - o.pos[0], dy = p.y - o.pos[1];
      if (dx * dx + dy * dy > 100) continue;
      if (this.nearBox(o, p, margin)) return true;
    }
    return false;
  }

  nearBox(name, p, margin) {
    const o = typeof name === 'string' ? this.objects[name] || this.instByName.get(name) : name;
    if (!o) return false;
    let box = o.box;
    if (!box && this.physics && o.model) {
      const b = this.physics.modelBounds(o.model);
      box = [b.min.toArray(), b.max.toArray()];
    }
    if (!box) return false;
    const r = o.rot;
    _m.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1).transpose();
    _v.copy(p).sub(_v2.fromArray(o.pos)).applyMatrix4(_m).divideScalar(o.scale || 1);
    const m = margin / (o.scale || 1);
    return [0, 1, 2].every((k) => _v.getComponent(k) >= box[0][k] - m && _v.getComponent(k) <= box[1][k] + m);
  }

  // Pick up / put down (CMessagePickUp): guns in hand, objects carried or gripped.
  pollObjects() {
    const now = new Set();
    if (this.game.gun) now.add(this.game.gun.inst.name);
    const P = this.physics;
    if (P?.held?.entry) now.add(P.held.entry.inst.name);
    if (P?.hand?.holding?.inst) now.add(P.hand.holding.inst.name);
    for (const n of now) if (!this.lastHeld.has(n)) this.objectEvent('pickup', n);
    for (const n of this.lastHeld) if (!now.has(n)) this.objectEvent('putdown', n);
    this.lastHeld = now;
  }

  objectEvent(what, name) {
    const key = { pickup: 'PickUpObject', putdown: 'PutDownObject', use: 'UseObject' }[what];
    for (const t of this.list) if (t.kind === 'object' && t.c[key] && t.c.objects?.includes(name)) this.attempt(t);
  }

  // Creature deaths, wake-ups and damage (CMessageDeath / Move / Damage).
  pollCreatures() {
    for (const d of this.game.dinos) {
      const s = this.dinoState.get(d);
      if (!s) continue;
      const events = [];
      if (s.alive && !d.alive) events.push('die');
      if (!s.awake && d.awake) events.push('wake');
      if (s.awake && !d.awake) events.push('sleep');
      const dmg = s.hp - d.hp;
      s.alive = d.alive; s.awake = d.awake; s.hp = d.hp;
      if (!events.length && dmg <= 0) continue;
      for (const t of this.list) {
        if (t.kind !== 'creature' || !t.c.objects?.includes(d.inst.name)) continue;
        const c = t.c;
        // Deviation from CreatureTrigger.cpp (which fires on any listed death and reads
        // EvaluateAll only for '@' queries): with EvaluateAll, wait until all are dead,
        // as the designers meant (ij's second raptor wave).
        if (events.includes('die') && c.CreatureDie && c.EvaluateAll && !this.now(t)) continue;
        if ((events.includes('die') && c.CreatureDie) || (events.includes('wake') && c.CreatureWake) ||
            (events.includes('sleep') && c.CreatureSleep) ||
            (dmg > 0 && (c.CreatureDamagePoints !== undefined || c.CreatureCriticalDamage) && dmg > (c.CreatureDamagePoints || 0))) this.attempt(t);
      }
    }
  }

  // bEvaluateNow: a trigger's state at this moment (for '@' in expressions).
  now(t) {
    switch (t.kind) {
      case 'location': {
        const act = t.c.TriggerActivate;
        if (act) return t.contained.has(act);
        for (const id of t.contained) {
          const type = id === 'Anne' ? 'player' : this.game.dinos.includes(id) ? 'creature' : 'object';
          if (t.want[type]) return true;
        }
        return false;
      }
      case 'boolean': return t.expr ? this.evaluate(t.expr) : true;
      case 'variable': return t.value;
      case 'timer': return t.state;
      case 'creature': {
        let any = false;
        for (const n of t.c.objects || []) {
          const d = this.dinoByName.get(n);
          if (d && !d.alive) any = true; else if (t.c.EvaluateAll) return false;
        }
        return any;
      }
      default: return false;
    }
  }

  evaluate(node) {
    if (node.not) return !this.evaluate(node.not);
    if (node.op) {
      const a = this.evaluate(node.a), b = this.evaluate(node.b);
      return node.op === '&' ? a && b : node.op === '|' ? a || b : node.op === '^' ? a !== b : a === b;
    }
    const t = this.byName.get(node.name ?? node.query);
    if (!t) return false;
    return node.query !== undefined ? this.now(t) : t.fired;
  }

  // CTrigger::AttemptTriggerFire.
  attempt(t) {
    if (t.dead || this.t < t.nextFireTime || t.seq) return false;
    if (t.expr && !this.evaluate(t.expr)) return false;
    if (t.prob < 1 && Math.random() > t.prob) return false;
    if (t.delay > 0) { if (t.fireTime < 0) t.fireTime = this.t + t.delay; }
    else this.fire(t);
    return true;
  }

  // CTrigger::Trigger.
  fire(t) {
    if (!t.c.FireZero || t.life === 1) {
      this.process(t);
      t.fired = true;
      t.count = (t.count || 0) + 1;
      t.nextFireTime = this.t + t.repeat;
      this.log.push({ t: +this.t.toFixed(2), trigger: t.name, actions: t.actions.map((a) => a.type) });
      if (this.log.length > 500) this.log.shift();
      if (this.debug) console.log(`[trigger] ${t.name} -> ${t.actions.map((a) => a.type).join(', ')}`);
      for (const s of this.sequences) this.heard(s, t);
    }
    if (t.life === Infinity) return;
    if (--t.life <= 0) {
      if (t.c.FireZero) { if (t.resetLife) t.life = t.resetLife; }
      else t.dead = true;
    }
  }

  // CSequenceTrigger: listened-to triggers firing in (or out of) the right order.
  heard(s, fired) {
    const c = s.t.c;
    if (!c.SequenceListenNames?.includes(fired.name)) return;
    s.order.push(fired.name);
    const order = c.SequenceOrderNames || [];
    if (c.SequenceEvalNowNames?.includes(fired.name) || s.order.length === order.length) {
      // As SequenceTrigger.cpp compares: matching up to the length of the order is enough.
      let i = 0;
      while (i < s.order.length && s.order[i] === order[i]) i++;
      const right = i === order.length;
      s.order = [];
      if (right) this.attempt(s.t);
      else if (c.SequenceFalseTriggerName) { const f = this.byName.get(c.SequenceFalseTriggerName); if (f) this.attempt(f); }
    }
  }

  // CTrigger::ProcessActionList.
  process(t) {
    const n = t.actions.length;
    if (!n) return;
    switch (t.style) {
      case ALL: for (const a of t.actions) this.start(a, t); break;
      case STEP_ORDER: this.start(t.actions[t.nextAction], t); t.nextAction = (t.nextAction + 1) % n; break;
      case STEP_RANDOM: this.start(t.actions[Math.floor(Math.random() * n)], t); break;
      case SEQ_ORDER: case SEQ_ORDER_LOOP: t.seq = true; this.sequenced(t, 0); t.nextAction = 1; break;
      case SEQ_RANDOM: case SEQ_RANDOM_LOOP: t.seq = true; this.sequenced(t, Math.floor(Math.random() * n)); t.nextAction = 1; break;
      default: break;
    }
  }

  // Start one action of a sequence; the next waits for its length plus the random gap.
  sequenced(t, i) {
    const gap = rand(t.c.SequenceDelayMin || 0, t.c.SequenceDelayMax || 0);
    const len = this.start(t.actions[i], t);
    if (len && typeof len.then === 'function') {
      t.nextActionTime = Infinity;
      const at = this.t;
      len.then((d) => { if (t.nextActionTime === Infinity) t.nextActionTime = at + (d || 0) + gap; });
    } else t.nextActionTime = this.t + (len || 0) + gap;
  }

  stepSequence(t) {
    const n = t.actions.length;
    switch (t.style) {
      case SEQ_ORDER:
        if (t.nextAction < n) this.sequenced(t, t.nextAction++);
        else t.seq = false;
        break;
      case SEQ_ORDER_LOOP:
        if (t.nextAction >= n) t.nextAction = 0;
        this.sequenced(t, t.nextAction++);
        break;
      case SEQ_RANDOM:
        if (t.nextAction < n) { this.sequenced(t, Math.floor(Math.random() * n)); t.nextAction++; }
        else t.seq = false;
        break;
      case SEQ_RANDOM_LOOP: this.sequenced(t, Math.floor(Math.random() * n)); break;
      default: t.seq = false;
    }
  }

  // ---------------------------------------------------------------- actions
  // Each returns its length in seconds (DELAY, TEXT, an ambient sample) for sequences.

  start(a, t) {
    this.dispatched[a.type] = (this.dispatched[a.type] || 0) + 1;
    const fn = this['do_' + a.type];
    if (!fn) { this.unhandled[a.type] = (this.unhandled[a.type] || 0) + 1; return 0; }
    try { return fn.call(this, a, t); } catch (e) { console.warn(`trigger ${t.name}: ${a.type}`, e); return 0; }
  }

  do_DELAY(a) { return a.Delay || 0; }

  // Voice-overs play one at a time; later ones wait their turn (up to twelve), and
  // music drops 10 dB under them (AudioDaemon.cpp CreateVoiceover).
  do_VOICEOVER(a, t) {
    if (this.game.dead) return 0;
    if (this.voice.queue.length < MAX_DELAYED_VOICEOVER) this.voice.queue.push({ sample: a.Sample, gain: db(a.Volume || 0), from: t.name });
    this.pumpVoice();
    return 0;
  }

  async pumpVoice() {
    const v = this.voice;
    if (v.playing || !v.queue.length || !this.audioOn()) return;
    const next = v.queue.shift();
    v.playing = next;
    this.duck(true);
    const s = await this.audio.playFx(next.sample, { gain: next.gain }).catch(() => null);
    const done = () => { if (v.playing === next) { v.playing = null; this.duck(false); this.pumpVoice(); } };
    if (!s) { done(); return; }
    next.src = s.src;
    s.src.onended = done;
  }

  duck(on) {
    const m = this.music;
    if (m?.gain) m.gain.gain.setTargetAtTime(m.base * (on ? db(-MUSIC_DUCK_DB) : 1), this.audio.ctx.currentTime, 0.3);
  }

  audioOn() { return this.audio?.ctx && this.audio.ctx.state === 'running'; }

  // One piece of music at a time; a second waits for nothing (CreateMusic ignores it).
  do_MUSIC(a) {
    if (this.music || !this.audioOn()) return 0;
    const m = this.music = { sample: a.Sample, base: db(a.Volume || 0) * (this.voice.playing ? db(-MUSIC_DUCK_DB) : 1) };
    this.audio.playFx(a.Sample, { gain: m.base }).then((s) => {
      if (!s) { this.music = null; return; }
      Object.assign(m, s);
      m.base = db(a.Volume || 0);
      s.src.onended = () => { if (this.music === m) this.music = null; };
    });
    return 0;
  }

  do_FADE_MUSIC(a) {
    const m = this.music;
    if (!m?.gain) return 0;
    const to = m.base * db(a.VolumeFader ?? -100);
    m.gain.gain.setTargetAtTime(Math.max(1e-4, to), this.audio.ctx.currentTime, 1.0);
    if (a.StopAfterFade !== false) setTimeout(() => { try { m.src.stop(); } catch (e) { /* ended */ } if (this.music === m) this.music = null; }, 4000);
    return 0;
  }

  do_SOUND_EFFECT(a, t) {
    if (!this.audioOn()) return 0;
    const pos = this.locate(a.Emitter, new THREE.Vector3()) || t.origin.clone();
    this.audio.playFx(a.Sample, { pos, gain: db(a.Volume || 0), refDistance: 20 / Math.max(0.2, a.Attenuation ?? 1), loop: !!a.Looped });
    return 0;
  }

  // Ambient sounds (CAmbientAction): positioned at the trigger (or an emitter), louder
  // towards the middle, falling off by Atten dB a metre past MaxVolDistance, and cut
  // beyond MaxDistance (the trigger's radius) unless unmuted. With an A00.. list each
  // sample is an action of its own, so style 5 / 6 cycles or shuffles through them.
  do_AMBIENT(a, t) {
    if (!this.audioOn()) return 0;
    const emitter = a.Emitter && this.locate(a.Emitter, new THREE.Vector3());
    const pos = emitter || t.origin.clone();
    const scale = emitter ? (this.objects[a.Emitter]?.scale || 1) : (t.scale || 1);
    const maxVol = (a.MaxVolDistance || 0) * scale;
    const atten = a.Attenuation ?? -(a.BoundaryVolume ?? -40) / Math.max(0.05, (1 - (a.MaxVolDistance || 0)) * scale);
    const maxDist = a.MaximumDistance ?? scale * 1.05;
    const master = a.MasterVolumeMin === a.MasterVolumeMax ? (a.MasterVolumeMin || 0) : rand(a.MasterVolumeMin || 0, a.MasterVolumeMax || 0);
    const amb = { sample: a.Sample, pos, maxVol, atten, maxDist, master, mute: a.Mute !== false, loop: !!a.Looped, trigger: t.name };
    const p = this.audio.playFx(a.Sample, { gain: this.ambientGain(amb), loop: amb.loop }).then((s) => {
      if (!s) return 0;
      Object.assign(amb, s);
      this.ambients.add(amb);
      s.src.addEventListener('ended', () => this.ambients.delete(amb));
      return s.duration;
    });
    return p;
  }

  ambientGain(amb) {
    const d = this.anneCentre(_v).distanceTo(amb.pos);
    if (amb.mute && d > amb.maxDist) return 0;
    return db(amb.master - amb.atten * Math.max(0, d - amb.maxVol));
  }

  updateAudio() {
    if (!this.audioOn()) return;
    for (const amb of this.ambients) {
      const g = this.ambientGain(amb);
      if (g === 0 && amb.loop) { try { amb.src.stop(); } catch (e) { /* ended */ } this.ambients.delete(amb); continue; }
      amb.gain.gain.setTargetAtTime(g, this.audio.ctx.currentTime, 0.2);
    }
    if (this.voice.queue.length && !this.voice.playing) this.pumpVoice();
  }

  // Tutorial text (CTextAction): each line waits for the one before; the action's
  // length is its display time (3 s unless TextDisplayTime says otherwise).
  do_TEXT(a) {
    const text = a.OverlayText ?? (a.ResourceID ? this.hints[a.ResourceID] : '');
    const time = a.TextDisplayTime ?? 3;
    if (text) this.textQueue.push({ text: rewrite(String(text)), time, colour: [a.R ?? 1, a.G ?? 1, a.B ?? 1] });
    return time;
  }

  // ---------------------------------------------------------------- animated textures
  // CMeshAnimating: an object cycling through its Anim00.. textures every Interval
  // seconds (keypad digits lighting, the Town's map, the Cray's screens and lights).
  // The level draws objects as shared InstancedMeshes, so each animated object is
  // taken out into meshes of its own, with its own materials to swap textures on.
  makeAnimated(anim) {
    this.animated = new Map();
    const targets = new Set(this.list.flatMap((t) => t.actions.filter((a) => a.type === 'SET_ANIMATE_TEXTURE').map((a) => a.Target)));
    const loader = new THREE.TextureLoader();
    for (const [name, spec] of Object.entries(anim)) {
      if (!targets.has(name)) continue;
      // The animating mesh is shared by every copy of the object (its -00 prototype is
      // often parked off the map, and the copies -01.. are what is seen).
      const base = name.replace(/-\d+$/, '');
      const copies = this.game.info.instances.filter((i) => i.name.replace(/-\d+$/, '') === base && this.game.refs[i.index]?.length);
      if (!copies.length) { this.miss('ANIM_TEX object not drawn', name); continue; }
      const first = spec.frames[0];
      const meshes = [];
      for (const inst of copies) {
      const parts = this.game.info.models[inst.model]?.parts || [];
      this.game.refs[inst.index].forEach(({ mesh, i }, k) => {
        // The animated surface: AnimSubMaterial, else those drawn with frame 0's
        // texture, else all of them.
        const tex = parts[k]?.texture;
        const animate = spec.surface >= 0 ? k === spec.surface : !first || !parts.some((p) => p.texture === first) || tex === first;
        const m = new THREE.Mesh(mesh.geometry, animate ? mesh.material.clone() : mesh.material);
        m.matrixAutoUpdate = false;
        mesh.getMatrixAt(i, m.matrix);
        m.castShadow = mesh.castShadow; m.receiveShadow = mesh.receiveShadow;
        m.frustumCulled = false;
        mesh.parent.add(m);
        meshes.push({ m, mesh, i, animate });
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); mesh.instanceMatrix.needsUpdate = true;
      });
      }
      const baseMap = meshes.find((x) => x.animate)?.m.material.map;
      const frames = spec.frames.map((id) => {
        if (!id) return null;
        const t = loader.load(`levels/${this.level}/tex/${id}.png`);
        if (baseMap) { t.wrapS = baseMap.wrapS; t.wrapT = baseMap.wrapT; t.flipY = baseMap.flipY; t.colorSpace = baseMap.colorSpace; t.anisotropy = baseMap.anisotropy; }
        else t.colorSpace = THREE.SRGBColorSpace;
        return t;
      });
      const a = { name, spec, meshes, frames, frame: -1, step: spec.interval > 0 ? spec.interval : Infinity, next: 0, track2: spec.trackTwo || 0, freeze: spec.freeze ?? -1 };
      a.next = this.t + a.step;
      this.animated.set(name, a);
      this.setFrame(a, 0);
    }
  }

  setFrame(a, f) {
    if (f === a.frame || f < 0 || f >= a.frames.length) return;
    a.frame = f;
    const tex = a.frames[f];
    if (!tex) return;
    for (const { m, animate } of a.meshes) if (animate) { m.material.map = tex; m.material.needsUpdate = true; }
  }

  // CMeshAnimating::Render: step through the frames at the interval (to TrackTwo after
  // the last), stopping at the freeze frame; the meshes follow the object if it moves.
  updateAnimated() {
    for (const a of this.animated?.values() || []) {
      for (const x of a.meshes) {
        x.mesh.getMatrixAt(x.i, _m);
        if (_m.elements[0] || _m.elements[1] || _m.elements[2]) {   // the object moved (physics wrote it)
          x.m.matrix.copy(_m);
          x.mesh.setMatrixAt(x.i, _m.makeScale(0, 0, 0)); x.mesh.instanceMatrix.needsUpdate = true;
        }
      }
      if (a.step === Infinity || this.t < a.next) continue;
      let f = a.frame;
      while (a.next <= this.t) {
        a.next += a.step;
        if (++f >= a.frames.length) f = a.track2;
        else if (f === a.track2 && a.track2 > 0) f = 0;
        if (a.next + a.step * 30 < this.t) a.next = this.t + a.step;
      }
      this.setFrame(a, f);
      if (f === a.freeze) a.step = Infinity;
    }
  }

  // CAnimateTextureAction: FreezeFrame, TrackTwo, Frame, Interval (<0: hold).
  do_SET_ANIMATE_TEXTURE(a) {
    const an = this.animated?.get(a.Target);
    if (!an) { this.miss('SET_ANIMATE_TEXTURE', a.Target); return 0; }
    if (a.FreezeFrame !== undefined && a.FreezeFrame > -2) an.freeze = a.FreezeFrame;
    if (a.TrackTwo !== undefined && a.TrackTwo > -1) an.track2 = a.TrackTwo;
    if (a.Frame !== undefined && a.Frame >= 0) this.setFrame(an, a.Frame);
    if (a.Interval !== undefined) { an.step = a.Interval < 0 ? Infinity : a.Interval > 0 ? a.Interval : an.step; an.next = this.t + an.step; }
    return 0;
  }

  do_SET_HINT(a) { this.hintId = a.HintID; return 0; }

  do_LOAD_LEVEL(a) {
    const next = String(a.LevelName || '').toLowerCase().replace(/\.scn$/, '');
    if (!LEVELS.some(([id]) => id === next)) { this.unhandled.LOAD_LEVEL_UNKNOWN = (this.unhandled.LOAD_LEVEL_UNKNOWN || 0) + 1; return 0; }
    this.loadLevel(next);
    return 0;
  }

  loadLevel(next) {
    if (this.leaving) return;
    this.leaving = true;
    this.nextLevel = next;
    if (window.__noLevelChange) return;   // tests
    if (document.pointerLockElement) document.exitPointerLock();
    setTimeout(() => front.startLevel(next), 300);
  }

  do_END_GAME() {
    if (this.leaving) return 0;
    this.leaving = true;
    this.ended = true;
    if (!window.__noLevelChange) front.won();
    return 0;
  }

  // Hit points (CSetAnimatePropertiesAction): on Anne or a dinosaur.
  do_SET_ANIMATE_PROPERTIES(a) {
    const name = a.ObjectName;
    const g = this.game;
    if (name === 'Player' || name === 'Anne') {
      if (a.MaxHitPoints !== undefined) g.maxHp = a.MaxHitPoints;
      if (a.Regeneration !== undefined) g.regeneration = a.Regeneration;
      if (a.HitPoints !== undefined) {
        const diff = g.hp - a.HitPoints;
        if (diff > 0) g.hurt(diff); else if (diff < 0) g.heal(-diff);
      }
      if (a.Damage !== undefined) g.hurt(a.Damage);
      return 0;
    }
    const d = this.dinoByName.get(name);
    if (!d) { this.miss('SET_ANIMATE_PROPERTIES', name); return 0; }
    if (a.MaxHitPoints !== undefined) d.maxHp = a.MaxHitPoints;
    if (a.Regeneration !== undefined) d.regeneration = a.Regeneration;
    let hp = d.hp;
    if (a.HitPoints !== undefined) hp = a.HitPoints;
    if (a.Damage !== undefined) hp -= a.Damage;
    d.hp = hp;
    if (d.alive && hp <= 0) g.kill(d);
    return 0;
  }

  // CTeleportAction: move an object (Anne, a dinosaur, a body) to a destination's
  // placement, set on the ground by its lowest point if HeightRelative.
  do_TELEPORT(a) {
    const name = a.ObjectName;
    const dest = this.placement(a.TeleportDestObjectName);
    if (!dest) { this.miss('TELEPORT dest', a.TeleportDestObjectName); return 0; }
    const pos = new THREE.Vector3().setFromMatrixPosition(dest);
    const quat = new THREE.Quaternion().setFromRotationMatrix(dest);
    const setPos = a.SetPosition !== false, setRot = a.SetOrientation !== false, rel = a.HeightRelative !== false;
    const onGround = (below) => { if (rel && a.OnTerrain !== false) pos.z = this.groundAt(pos.x, pos.y) + below + 0.1; };
    if (name === 'Player' || name === 'Anne') {
      onGround(0);
      if (setPos) { this.player.pos.copy(pos); this.player.vz = 0; }
      if (setRot) this.player.yaw = new THREE.Euler().setFromQuaternion(quat, 'ZXY').z;
      return 0;
    }
    const d = this.dinoByName.get(name);
    if (d) {
      if (setPos) { d.pos.set(pos.x, pos.y, this.groundAt(pos.x, pos.y) + (d.foot || 0)); }
      if (setRot) d.yaw = new THREE.Euler().setFromQuaternion(quat, 'ZXY').z;
      d.teleported = true;
      return 0;
    }
    const tt = this.byName.get(name);
    if (tt) {
      // A trigger moved (CMessageMoveTriggerTo): its volume goes with it.
      if (setPos) tt.origin.copy(pos);
      if (setRot) tt.inv.makeRotationFromQuaternion(quat).transpose();
      return 0;
    }
    const e = this.bodyByName.get(name);
    if (e) {
      if (this.physics.held?.entry === e) this.physics.release();
      const b = this.physics.modelBounds(e.inst.model);
      onGround(-b.min.z * e.scale);
      this.moveBody(e, setPos ? pos : e.curP, setRot ? quat : e.curQ);
      return 0;
    }
    // Anything else (the invisible latch boxes the Town's console moves about): where
    // it now is, for the triggers that watch it.
    const o = this.objects[name] || this.instByName.get(name);
    if (o) {
      const cur = this.placement(name);
      const q = new THREE.Quaternion().setFromRotationMatrix(cur), p0 = new THREE.Vector3().setFromMatrixPosition(cur);
      (this.movedObjects ||= new Map()).set(name, { pos: setPos ? pos : p0, quat: setRot ? quat : q });
      return 0;
    }
    this.miss('TELEPORT', name);
    return 0;
  }

  moveBody(e, pos, quat) {
    this.physics.teleport(e.inst.name, pos, quat);
    _m.compose(pos, quat, _v.setScalar(e.scale));
    for (const { mesh, i } of this.physics.refs[e.index] || []) { mesh.setMatrixAt(i, _m); mesh.instanceMatrix.needsUpdate = true; }
    if (e.track) e.track.copy(pos);
  }

  // Frozen: held where it is (a fixed body) until unfrozen (NMagnetSystem::SetFrozen).
  freeze(e, on) {
    if (on) this.physics.freeze(e.inst.name); else this.physics.unfreeze(e.inst.name);
  }

  // CSetPhysicsAction: freeze / unfreeze, then an impulse along the emitter's +Y
  // from its position, or a set velocity (physics.js does the work).
  do_SET_PHYSICS(a) {
    const P = this.physics;
    if (!P.body(a.Target)) { this.miss('SET_PHYSICS', a.Target); return 0; }
    if (a.Frozen) { P.freeze(a.Target); return 0; }
    P.unfreeze(a.Target);
    if (a.Impulse && !P.pushFrom(a.Target, a.Emitter, a.Push || 0)) {
      // An emitter physics.js doesn't know ($FenceGateShove...): its placement from logic.json.
      const m = this.placement(a.Emitter);
      if (!m) this.miss('SET_PHYSICS emitter', a.Emitter);
      else {
        const dir = new THREE.Vector3(m.elements[4], m.elements[5], m.elements[6]).normalize().multiplyScalar(a.Push || 0);
        P.push(a.Target, dir, new THREE.Vector3().setFromMatrixPosition(m));
      }
    }
    else if (a.X !== undefined || a.Y !== undefined || a.Z !== undefined) P.setVelocity(a.Target, { x: a.X || 0, y: a.Y || 0, z: a.Z || 0 });
    return 0;
  }

  // CMagnetAction: take the object off its magnet, or put it on a new one (a hinge on
  // the free axis, driven by Drive, limited by AngleMin/Max); Merge / Delta change
  // only the values given. The magnet sits at the master's placement, and with one
  // object named it holds it to the world.
  do_MAGNET(a) {
    const P = this.physics;
    const master = this.bodyByName.get(a.MasterObject), slave = a.SlaveObject ? this.bodyByName.get(a.SlaveObject) : null;
    if (!master) { this.miss('MAGNET', a.MasterObject); return 0; }
    for (const e of [master, slave]) if (e && (P.held?.entry === e || P.hand?.holding === e)) P.release?.();
    const old = P.joints.filter((j) => j.joint && ((j.slave === master && j.master === (slave || null)) || (j.slave === slave && j.master === master) ||
      (!slave && j.slave === master && !j.master)));
    const sp = old[0]?.params || old[0]?.spec;
    const prev = old[0]?.params || { free: sp?.free || [false, false, false], drive: sp?.drive || 0, friction: sp?.friction || 0,
      min: sp?.angleMin || 0, max: sp?.angleMax || 0, breakStrength: sp?.breakStrength || 0 };
    for (const j of old) P.removeJoint(j, true);
    master.body.wakeUp(); slave?.body.wakeUp();
    if (a.Enable === false) { this.freeze(master, false); if (slave) this.freeze(slave, false); return 0; }
    const given = { free: [a.XFree, a.YFree, a.ZFree], drive: a.Drive, friction: a.Friction, min: a.AngleMin, max: a.AngleMax, breakStrength: a.BreakStrength };
    let params;
    if (a.Delta) {
      params = { ...prev, drive: prev.drive + (given.drive || 0), friction: prev.friction + (given.friction || 0),
        min: prev.min + (given.min || 0), max: prev.max + (given.max || 0), breakStrength: prev.breakStrength + (given.breakStrength || 0) };
    } else if (a.Merge) {
      params = { ...prev };
      for (const k of ['drive', 'friction', 'min', 'max', 'breakStrength']) if (given[k]) params[k] = given[k];
      if (given.free.some((f) => f !== undefined)) params.free = given.free.map(Boolean);
    } else {
      params = { free: given.free.map(Boolean), drive: given.drive || 0, friction: given.friction || 0, min: given.min || 0, max: given.max || 0, breakStrength: given.breakStrength || 0 };
    }
    const spec = { free: params.free, drive: params.drive, friction: params.friction, angleMin: params.min, angleMax: params.max, breakStrength: params.breakStrength };
    this.freeze(master, false); if (slave) this.freeze(slave, false);
    if (!slave) {
      // One object: magnetted to the world (a lock, or a motor-driven hinge).
      P.setMagnet(master.inst.name, spec);
    } else {
      // Two: the slave hangs off the master, at the master's placement.
      const r = new THREE.Matrix4().makeRotationFromQuaternion(master.curQ).elements;
      P.addMagnet({ pos: master.curP.toArray(), rot: [[r[0], r[4], r[8]], [r[1], r[5], r[9]], [r[2], r[6], r[10]]], free: params.free,
        tfree: [false, false, false], drive: params.drive, friction: params.friction, angleMin: params.min, angleMax: params.max,
        breakStrength: params.breakStrength }, slave, master);
    }
    const nj = P.joints[P.joints.length - 1];
    if (nj) nj.params = params;
    return 0;
  }

  do_HIDESHOW(a) {
    const P = this.physics;
    if (P?.setVisible && P.body(a.ObjectName)) {
      // A physics object: physics.js hides it and takes it out of the simulation.
      const hidden = this.hidden.has(a.ObjectName);
      const show = a.Toggle ? hidden : a.Visible !== false;
      P.setVisible(a.ObjectName, show);
      if (show) this.hidden.delete(a.ObjectName); else this.hidden.set(a.ObjectName, []);
      return 0;
    }
    const inst = this.instByName.get(a.ObjectName);
    if (!inst) {
      // Never drawn and not solid (ij's HideMe-00, an invisible marker): only its state changes.
      if (!this.objects[a.ObjectName]) { this.miss('HIDESHOW', a.ObjectName); return 0; }
      const hidden = this.hidden.has(a.ObjectName), show = a.Toggle ? hidden : a.Visible !== false;
      if (show) this.hidden.delete(a.ObjectName); else this.hidden.set(a.ObjectName, []);
      return 0;
    }
    const refs = this.game.refs[inst.index] || [];
    const hidden = this.hidden.has(inst.name);
    const show = a.Toggle ? hidden : a.Visible !== false;
    if (show && hidden) {
      for (const [k, r] of this.hidden.get(inst.name).entries()) { r.mesh.setMatrixAt(r.i, r.m); r.mesh.instanceMatrix.needsUpdate = true; void k; }
      this.hidden.delete(inst.name);
      const e = this.bodyByName.get(inst.name); if (e) e.body.setEnabled(true);
    } else if (!show && !hidden) {
      const saved = refs.map(({ mesh, i }) => { const m = new THREE.Matrix4(); mesh.getMatrixAt(i, m); mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); mesh.instanceMatrix.needsUpdate = true; return { mesh, i, m }; });
      this.hidden.set(inst.name, saved);
      const e = this.bodyByName.get(inst.name); if (e && a.Volume !== false) e.body.setEnabled(false);
    }
    return 0;
  }

  do_SET_VARIABLE_TRIGGER(a) {
    const v = this.byName.get(a.TriggerName);
    if (!v) { this.miss('SET_VARIABLE_TRIGGER', a.TriggerName); return 0; }
    v.value = a.Toggle ? !v.value : a.Value !== false;
    return 0;
  }

  // AI: wake animals near a point (or a named one); SET_AI's stay-near / stay-away
  // targets are kept on the dinosaur for the AI to read.
  do_WAKE_AI(a) {
    const at = a.Location ? this.locate(a.Location, new THREE.Vector3()) : new THREE.Vector3(a.X || 0, a.Y || 0, a.Z || 0);
    for (const d of this.game.dinos) {
      if (!d.alive) continue;
      if ((a.Target && d.inst.name === a.Target) || (!a.Target && at && d.pos.distanceTo(at) <= (a.Radius || 10))) d.awake = a.WakeUp !== false;
    }
    return 0;
  }

  do_SET_AI(a) {
    const d = this.dinoByName.get(a.Target);
    if (!d) { this.miss('SET_AI', a.Target); return 0; }
    d.script = { ...(d.script || {}), ...a };
    if (a.StayNearTarget || a.StayAwayTarget) d.awake = true;
    return 0;
  }

  miss(what, name) {
    const k = `${what}: ${name}`;
    (this.missing ||= {})[k] = (this.missing[k] || 0) + 1;
  }

  // ---------------------------------------------------------------- text and hints

  makeOverlay() {
    const box = document.createElement('div');
    box.id = 'trigger-text';
    Object.assign(box.style, {
      position: 'fixed', left: '50%', top: '14%', transform: 'translateX(-50%)', maxWidth: 'min(90vw, 720px)',
      padding: '6px 14px', font: '600 clamp(14px, 2.2vw, 20px)/1.35 Georgia, "Times New Roman", serif',
      color: '#fff', textAlign: 'center', textShadow: '0 1px 3px #000, 0 0 8px #000', pointerEvents: 'none',
      zIndex: 30, opacity: 0, transition: 'opacity .35s',
    });
    document.body.appendChild(box);
    this.textEl = box;
    this.textQueue = [];
    this.textLeft = 0;
    // F1 (or the ? button on touch) shows the current hint (uidlgs.cpp).
    addEventListener('keydown', (e) => { if (e.code === 'F1') { e.preventDefault(); this.showHint(); } });
    if (TOUCH) {
      const b = document.createElement('button');
      b.textContent = '?';
      Object.assign(b.style, {
        position: 'fixed', right: '12px', top: 'calc(env(safe-area-inset-top, 0px) + 56px)', width: '40px', height: '40px',
        borderRadius: '50%', border: '1px solid rgba(255,255,255,.5)', background: 'rgba(0,0,0,.35)', color: '#fff',
        font: '700 20px Georgia, serif', zIndex: 31, display: 'none',
      });
      b.addEventListener('touchstart', (e) => { e.preventDefault(); this.showHint(); }, { passive: false });
      document.body.appendChild(b);
      this.hintButton = b;
    }
  }

  showHint() {
    const text = this.hintId != null && this.hints[this.hintId];
    this.textQueue.unshift({ text: text || 'No hint here.', time: 5, hint: true });
    this.textLeft = 0;
  }

  showText(dt) {
    if (this.hintButton) this.hintButton.style.display = document.body.classList.contains('playing') ? '' : 'none';
    if (!this.textEl) return;
    if (!this.game.ui?.paused) this.textLeft -= dt;
    if (this.textLeft <= 0) {
      const next = this.textQueue.shift();
      if (next) {
        this.textEl.textContent = next.text;
        const [r, g, b] = next.colour || [1, 1, 1];
        this.textEl.style.color = next.hint ? '#ffe9a8' : `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
        this.textEl.style.opacity = 1;
        this.textLeft = next.time;
        this.shownText = next.text;
      } else if (this.textEl.style.opacity !== '0') {
        this.textEl.style.opacity = 0;
        this.shownText = '';
      }
    }
  }

  // ---------------------------------------------------------------- testing and cheats

  // Fire a trigger by name as if its condition were met (the console's TRIG).
  force(name) {
    const t = this.byName.get(name);
    if (!t) return false;
    this.fire(t);
    return true;
  }

  summary() {
    return {
      level: this.level, t: +this.t.toFixed(1), triggers: this.list.length,
      fired: this.list.filter((t) => t.fired).map((t) => t.name), dispatched: this.dispatched, unhandled: this.unhandled,
      missing: this.missing || {}, next: this.nextLevel || null, ended: !!this.ended,
    };
  }
}
