// The modern hand (Half-Life 2 / Amnesia style), the default; physics.handStyle picks it
// or the original's mouse-moved hand. Same physics underneath (physics.js):
//   look at a thing within 2.5 m: it glows faintly and a hint says what a click does
//   click     pick it up: it flies into her hand (a damped spring, still colliding),
//             turned to the original's hand magnet if it has one; click again drops it
//   wheel     turn what she holds about the vertical; hold right mouse + mouse: turn it
//             freely (the view holds still meanwhile); F throws it (harder when lighter)
//   hinged, sliding or heavy things (doors, gates, levers, crates too heavy to lift):
//             press and hold, then move the view: the point grabbed is dragged along
//   keypads and buttons: click and her hand reaches out and presses there
//   guns: click picks them up as guns
// Touch: tap a thing to do the same (tap again to drop); drag while holding moves it;
// a two-finger twist turns it; the THROW button throws.
import * as THREE from 'three';

const REACH = 2.5;
const HOLD_AHEAD = 0.7, HOLD_RIGHT = 0.16, HOLD_DOWN = 0.2;
const DRAG_FORCE = 900;          // N at the grab point (as the classic hand)
const PRESS_TIME = 0.75;         // s: reach out, hold, draw back
const STEP = 1 / 60;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

export class ModernHand {
  constructor(physics, game) {
    this.ph = physics;
    this.game = game;
    this.target = null;      // what the crosshair is on: { kind, entry?, volume?, point, dist, hint }
    this.hint = '';
    this.drag = null;        // { entry, local, dist }
    this.press = null;       // { point, dir, t, entry? }
    this.offset = new THREE.Vector2();   // touch drag: where on screen she holds it
    this.volumes = handVolumes(physics.logic);
    this.buttons = collisionElements(physics.logic);
    // The highlight: a thin bright rim (an inverted hull: the object's parts drawn back
    // faces only, grown about its middle by a few millimetres per metre of distance, so
    // only an outline shows around it) and a faint warm tint over it. Two extra draws
    // per part, cheap on phones.
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.rimMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, side: THREE.BackSide, fog: false });
    this.glow = new THREE.Group();
    this.glow.renderOrder = 5;
    game.world.add(this.glow);
    this.glowFor = null;
  }

  reset() {
    this.endDrag();
    this.ph.hand.press = null;
    this.press = null;
    this.setGlow(null);
    this.target = null;
    this.hint = '';
  }

  // Where the held thing's centre goes: 0.7 m ahead of her eye, a little right and below
  // the crosshair (so her palm is at its grip, if it has one).
  holdPoint(player, held) {
    const { origin, dir } = this.ph.eyeRay(player);
    const right = _v2.set(Math.cos(player.yaw), Math.sin(player.yaw), 0);
    const up = new THREE.Vector3().crossVectors(right, dir);
    const e = held.entry;
    const ahead = HOLD_AHEAD + Math.min(0.6, e.radius * 0.5);
    const p = origin.addScaledVector(dir, ahead).addScaledVector(right, HOLD_RIGHT + this.offset.x).addScaledVector(up, -HOLD_DOWN + this.offset.y);
    if (held.grip) {
      // The palm is at p: the object sits so its grip magnet is there.
      const want = _q.setFromAxisAngle(_v.set(0, 0, 1), player.yaw).multiply(this.ph.hand.rotation).multiply(held.qRel);
      p.sub(held.grip.pos.clone().applyQuaternion(want));
    }
    return p;
  }

  // What is under the crosshair (or along a tapped ray), and what a click would do.
  pick(origin, dir) {
    const ph = this.ph, R = ph.RAPIER;
    let best = null;
    const hit = ph.world.castRayAndGetNormal(new R.Ray(origin, dir), REACH, true, undefined, undefined, ph.playerCol, ph.handBody);
    if (hit) {
      const b = hit.collider.parent();
      const e = b && ph.byHandle.get(b.handle);
      const point = origin.clone().addScaledVector(dir, hit.timeOfImpact);
      const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      if (normal.dot(dir) > 0) normal.negate();   // out of the surface, toward her
      if (e && !e.dino && !e.hidden) best = { kind: 'body', entry: e, point, normal, dist: hit.timeOfImpact };
      else best = { kind: 'wall', point, dist: hit.timeOfImpact };
    }
    // Keypads and hand readers: the trigger boxes a hand has to enter.
    for (const v of this.volumes) {
      const d = rayBox(origin, dir, v);
      if (d !== null && d <= REACH && (!best || d < best.dist + 0.05)) best = { kind: 'volume', volume: v, point: origin.clone().addScaledVector(dir, d), normal: dir.clone().negate(), dist: d };
    }
    if (!best || best.kind === 'wall') return null;
    best.hint = this.hintFor(best);
    return best.hint ? best : null;
  }

  hintFor(t) {
    if (t.kind === 'volume') return 'Press';
    const e = t.entry, ph = this.ph;
    if (this.buttons.has(e.inst.name)) return 'Press';
    if (e.gun) return 'Pick up';
    if (e.frozen) return '';
    const joints = ph.joints.filter((j) => j.joint && j.slave === e);
    if (e.pinned) return joints.some((j) => j.kind === 'hinge' || j.kind === 'slide') ? 'Locked' : '';
    if (joints.some((j) => j.kind === 'hinge' || j.kind === 'slide' || j.kind === 'ball')) return 'Open';
    if (joints.length) return 'Pull';
    if (e.mass >= 100) return 'Push';
    return 'Pick up';
  }

  // Each frame. m: { click, down (button held), rmb (held), look {x,y}, wheel, dt }.
  // Returns true when the view should hold still (turning what she holds).
  update(player, m) {
    const ph = this.ph;
    if (this.press) {
      // Held on (the button or finger still down): the hand stays pressed on it, as the
      // as2 elevator's buttons want (it moves only while the hand is in their box).
      this.press.held = !!(m.down || this.touchHeld);
      if (this.ph.hand.press) this.ph.hand.press.held = this.press.held;
      this.hint = ''; this.setGlow(null); return false;
    }
    if (this.drag) {
      if (!m.down && !this.touchHeld) this.endDrag();
      else {
        // The view holds still; the mouse moves the grabbed point: across with the
        // mouse's sideways motion, toward or away from her with its forward motion
        // (so a door swings open as she pulls the mouse back or pushes it forward).
        const right = _v.set(Math.cos(player.yaw), Math.sin(player.yaw), 0);
        const ahead = _v2.set(-Math.sin(player.yaw), Math.cos(player.yaw), 0);
        this.drag.goal.addScaledVector(right, m.look.x * 1.5).addScaledVector(ahead, -m.look.y * 1.5);
        const { origin } = ph.eyeRay(player);
        const off = this.drag.goal.clone().sub(origin);
        if (off.length() > REACH) this.drag.goal.copy(origin.add(off.setLength(REACH)));
        this.hint = '';
        return true;
      }
    }
    if (ph.held) {
      this.setGlow(null);
      this.hint = '';
      if (m.wheel) ph.hand.rotation.premultiply(_q.setFromAxisAngle(_v.set(0, 0, 1), m.wheel * 0.26));
      if (m.rmb) {
        // Turn it freely: across about the vertical, up/down about her right.
        const q1 = new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1), -m.look.x * 1.5);
        const q2 = new THREE.Quaternion().setFromAxisAngle(_v.set(1, 0, 0), m.look.y * 1.5);
        ph.hand.rotation.premultiply(q2).premultiply(q1).normalize();
      }
      if (m.click) this.drop();
      return !!m.rmb;
    }
    const { origin, dir } = ph.eyeRay(player);
    this.target = this.pick(origin, dir);
    this.hint = this.target?.hint || '';
    this.setGlow(this.target?.kind === 'body' ? this.target.entry : null);
    if (m.click && this.target) this.act(this.target, player, origin);
    return false;
  }

  // Whether a left click now means "fire": a gun in hand (not stowed), nothing carried,
  // dragged or being pressed, and nothing to use under the crosshair.
  wantsFire() {
    const ph = this.ph;
    return !!(this.game.gun && !ph.hand.stowed && !ph.held && !this.drag && !this.press && !this.target);
  }

  // Do what the hint says.
  act(t, player, origin) {
    const ph = this.ph;
    const hint = t.hint;
    if (hint === 'Press') { this.startPress(t, player); return true; }
    const e = t.entry;
    if (!e) return false;
    if (hint === 'Pick up') {
      if (e.gun) return this.game.tryPickup(player);
      ph.holdEntry(e, player, this.gripOf(e));
      this.offset.set(0, 0);
      this.setGlow(null);
      return true;
    }
    if (hint === 'Open' || hint === 'Push' || hint === 'Pull') return this.startDrag(t);
    return false;
  }

  // Grab that point of it: while the button (or finger) is held, the mouse (or finger)
  // moves the point and the thing follows it along whatever holds it.
  startDrag(t) {
    const ph = this.ph, e = t.entry;
    const bt = e.body.translation(), br = e.body.rotation();
    const inv = new THREE.Quaternion(br.x, br.y, br.z, br.w).invert();
    const normal = t.normal || new THREE.Vector3(0, 0, 1);
    this.drag = { entry: e, local: t.point.clone().sub(_v.set(bt.x, bt.y, bt.z)).applyQuaternion(inv),
                  localN: normal.clone().applyQuaternion(inv), goal: t.point.clone() };
    ph.hand.drag = { point: t.point.clone(), normal: normal.clone() };
    e.body.wakeUp();
    ph.live.add(e);
    return true;
  }

  drop() { this.ph.release(); }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.ph.hand.drag = null;
    const h = this.ph.hand;
    h.mode = h.stowed ? 'stow' : 'look';
  }

  // The original's hand magnet for this object (anne.js has them), as a grip.
  gripOf(e) {
    const g = this.game.anne?.data?.grips?.[e.inst.name.replace(/-\d+$/, '')]?.grip;
    if (!g) return null;
    const r = g.rot;
    _m.set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1);
    return { rot: new THREE.Quaternion().setFromRotationMatrix(_m), pos: new THREE.Vector3(...g.pos) };
  }

  startPress(t, player) {
    const { origin } = this.ph.eyeRay(player);
    const dir = t.point.clone().sub(origin).normalize();
    this.press = { point: t.point.clone(), dir, t: 0, entry: t.entry || null, from: this.ph.shoulder(player) };
    // For the arm (anne.js plays the reach, finger press and return from this).
    this.ph.hand.press = { point: t.point.clone(), normal: (t.normal || dir.clone().negate()).clone(), time: performance.now(), held: true };
  }

  // Each physics step: drag the grabbed point, or move the pressing hand.
  step(player) {
    const ph = this.ph, h = ph.hand, b = ph.handBody;
    if (this.drag) {
      const e = this.drag.entry;
      if (!e.body.isEnabled() || e.frozen) { this.endDrag(); return; }
      const goal = this.drag.goal;
      const bt = e.body.translation(), br = e.body.rotation();
      const q = _q.set(br.x, br.y, br.z, br.w);
      const p = this.drag.local.clone().applyQuaternion(q).add(_v.set(bt.x, bt.y, bt.z));
      // The point's velocity: v + w x r.
      const lv = e.body.linvel(), av = e.body.angvel();
      const r = p.clone().sub(_v.set(bt.x, bt.y, bt.z));
      const vp = new THREE.Vector3(av.x, av.y, av.z).cross(r).add(_v.set(lv.x, lv.y, lv.z));
      const want = goal.clone().sub(p).multiplyScalar(8);
      if (want.length() > 4) want.setLength(4);
      const imp = want.sub(vp).multiplyScalar(Math.min(e.mass, 80));
      const max = DRAG_FORCE * STEP;
      if (imp.length() > max) imp.setLength(max);
      e.body.applyImpulseAtPoint(imp, p, true);
      // Too far from where she holds it (it stuck): she lets go.
      if (p.distanceTo(goal) > 1.2) {
        // It will not go that far (a stop, or too heavy): the goal stays within reach of it.
        goal.sub(p).setLength(1.2).add(p);
      }
      h.mode = 'arm'; h.target.copy(p); h.pos.copy(p); h.rotation.identity();
      if (h.drag) { h.drag.point.copy(p); h.drag.normal.copy(this.drag.localN).applyQuaternion(q); }
      if (h.active) { h.active = false; b.setEnabled(false); }
      return;
    }
    if (this.press) {
      const pr = this.press;
      pr.t += STEP;
      if (pr.held && pr.t > 0.3) pr.t = 0.3;   // kept against it while held
      // Out (0.25 s), held against it (0.25 s), back (0.25 s).
      const out = Math.min(1, pr.t / 0.25), back = Math.max(0, (pr.t - 0.5) / 0.25);
      const k = THREE.MathUtils.smoothstep(out - back, 0, 1);
      // Fingertips (8 cm ahead of the palm) just into the button.
      const tip = pr.point.clone().addScaledVector(pr.dir, 0.02);
      const palm = tip.addScaledVector(pr.dir, -0.08);
      const p = pr.from.clone().lerp(palm, k);
      _q.setFromUnitVectors(_v.set(0, 1, 0), pr.dir);
      if (!h.active) { h.active = true; b.setEnabled(true); }
      b.setTranslation(p, true);
      b.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      h.mode = 'arm'; h.target.copy(p); h.pos.copy(p);
      h.rotation.identity();
      if (pr.t >= PRESS_TIME) {
        this.press = null;
        h.active = false; b.setEnabled(false);
        h.mode = h.stowed ? 'stow' : 'look';
      }
      return;
    }
    if (h.active && !h.holding) { h.active = false; b.setEnabled(false); }
    if (!ph.held) h.mode = h.stowed ? 'stow' : 'look';
  }

  // Touch: a tap along a game-space ray does what a click on that thing would.
  tap(origin, dir, player) {
    const ph = this.ph;
    if (ph.held) { this.drop(); return true; }
    const t = this.pick(origin, dir);
    if (!t) return false;
    if (t.hint === 'Open' || t.hint === 'Push' || t.hint === 'Pull') {
      // No held button to drag with: a firm shove at the tapped point, away from her.
      const e = t.entry;
      const j = dir.clone().multiplyScalar(Math.min(e.mass, 80) * 2.5);
      e.body.applyImpulseAtPoint(j, t.point, true);
      ph.live.add(e);
      return true;
    }
    return this.act(t, player, origin);
  }

  // Touch: a finger held on a door, gate, lever or heavy thing grabs it there.
  touchGrab(origin, dir) {
    if (this.ph.held || this.drag || this.press) return false;
    const t = this.pick(origin, dir);
    if (t?.hint === 'Press') { this.touchHeld = true; this.startPress(t, this.ph.player); return true; }   // held on a button
    if (!t || !(t.hint === 'Open' || t.hint === 'Push' || t.hint === 'Pull')) return false;
    this.touchHeld = true;
    return this.startDrag(t);
  }

  // The finger moved (pixels on screen) while dragging: across, and up = push away.
  touchDrag(dx, dy, player) {
    if (!this.drag) return;
    const right = _v.set(Math.cos(player.yaw), Math.sin(player.yaw), 0);
    const ahead = _v2.set(-Math.sin(player.yaw), Math.cos(player.yaw), 0);
    this.drag.goal.addScaledVector(right, dx * 0.006).addScaledVector(ahead, -dy * 0.006);
  }

  touchRelease() { this.touchHeld = false; this.endDrag(); }

  // Touch drag while holding: move it about the screen (metres, clamped).
  nudge(dx, dy) {
    this.offset.x = THREE.MathUtils.clamp(this.offset.x + dx, -0.45, 0.45);
    this.offset.y = THREE.MathUtils.clamp(this.offset.y + dy, -0.35, 0.35);
  }

  twist(angle) { this.ph.hand.rotation.premultiply(_q.setFromAxisAngle(_v.set(0, 1, 0), angle)); }

  setGlow(e) {
    if (e === this.glowFor) { if (e) this.placeGlow(); return; }
    this.glow.clear();
    this.glowFor = e;
    if (!e) return;
    for (const { mesh } of this.ph.refs[e.index] || []) {
      for (const mat of [this.rimMat, this.glowMat]) {
        const g = new THREE.Mesh(mesh.geometry, mat);
        g.matrixAutoUpdate = false;
        g.frustumCulled = false;
        this.glow.add(g);
      }
    }
    // The model's middle and half size (model space), to grow the rim about.
    const b = this.ph.modelBounds(e.inst.model);
    this.glowC = b.getCenter(new THREE.Vector3());
    this.glowH = b.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.01, 0.01, 0.01));
    this.placeGlow();
  }

  placeGlow() {
    const e = this.glowFor, parts = this.ph.refs[e.index] || [];
    // Rim width in metres: 6 mm, plus 3 mm for every metre away, and never under 2
    // pixels on screen (so a small rock shows it too).
    const dist = this.target?.dist ?? 1;
    const cam = this.game.camera;
    const px = cam ? (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * dist) / Math.max(1, innerHeight) : 0;
    const w = Math.max(0.006 + 0.003 * dist, 2 * px), sc = e.scale || 1, c = this.glowC, h = this.glowH;
    const grow = _m.makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeScale(1 + w / (h.x * sc), 1 + w / (h.y * sc), 1 + w / (h.z * sc)))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    // The rim is also brought toward her eye (along her line of sight, which leaves it
    // where it is on screen) by most of the object's thinnest half, so it is not lost in
    // the ground a half-buried rock sits in; its back faces stay behind the object's front.
    const eye = this.ph.eyeRay(this.ph.player || { pos: new THREE.Vector3(), yaw: 0, pitch: 0 }).origin;
    const shift = Math.min(0.6 * Math.min(h.x, h.y, h.z) * sc, 0.02);
    parts.forEach(({ mesh, i }, k) => {
      const rim = this.glow.children[2 * k], tint = this.glow.children[2 * k + 1];
      if (!rim) return;
      mesh.getMatrixAt(i, tint.matrix);
      rim.matrix.copy(tint.matrix).multiply(grow);
      const at = new THREE.Vector3().setFromMatrixPosition(rim.matrix);
      const toEye = eye.clone().sub(at).setLength(shift);
      rim.matrix.premultiply(_m2.makeTranslation(toEye.x, toEye.y, toEye.z));
    });
  }
}

// Location triggers a hand sets off ($AnneHand): keypad keys, hand readers.
function handVolumes(logic) {
  const out = [];
  for (const t of logic?.triggers || []) {
    if (t.kind !== 'location') continue;
    // The hand's own (TriggerActivate $AnneHand), or small boxes any object may enter
    // (the as2 elevator's buttons: "ObjectInTrigger" with no activator named).
    const act = String(t.cond?.TriggerActivate || '');
    const anyObject = !act && (t.cond?.ObjectInTrigger || t.cond?.ObjectEnterTrigger);
    if (!act.includes('AnneHand') && !anyObject) continue;
    // Not the big "point the finger" zones around a keypad: only things to press.
    if ((t.actions || []).every((a) => a.type === 'SUBSTITUTE_MESH')) continue;
    const half = (t.scale || 1) * Math.max(...(t.shape?.box?.[1] || [1]).map(Math.abs));
    if (half > 0.3) continue;
    const r = t.rot;
    const m = new THREE.Matrix4().set(r[0][0], r[0][1], r[0][2], 0, r[1][0], r[1][1], r[1][2], 0, r[2][0], r[2][1], r[2][2], 0, 0, 0, 0, 1);
    const box = t.shape?.type === 'box' ? t.shape.box : [[-1, -1, -1], [1, 1, 1]];
    out.push({ name: t.name, pos: new THREE.Vector3(...t.pos), inv: m.clone().transpose(), scale: t.scale || 1, box });
  }
  return out;
}

// Objects a collision trigger watches for a touch: buttons, card readers.
function collisionElements(logic) {
  const out = new Set();
  for (const t of logic?.triggers || []) if (t.kind === 'collision') for (const k of ['Element1', 'Element2']) if (t.cond?.[k]) out.add(t.cond[k]);
  // Card readers want the card, not a hand.
  for (const n of [...out]) if (/CrdRder/i.test(n)) out.delete(n);
  return out;
}

// Distance along a ray (unit dir) to a trigger box, or null.
function rayBox(origin, dir, v) {
  const o = origin.clone().sub(v.pos).applyMatrix4(v.inv).divideScalar(v.scale);
  const d = dir.clone().applyMatrix4(v.inv).divideScalar(v.scale);
  let t0 = 0, t1 = Infinity;
  const pad = 0.015 / v.scale;   // keypad keys are 4 cm: a little slack for aiming
  for (let k = 0; k < 3; k++) {
    const oc = o.getComponent(k), dc = d.getComponent(k), lo = v.box[0][k] - pad, hi = v.box[1][k] + pad;
    if (Math.abs(dc) < 1e-9) { if (oc < lo || oc > hi) return null; continue; }
    let a = (lo - oc) / dc, b = (hi - oc) / dc;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;   // in scaled units: d was divided by scale, so t is in metres along `dir`
}
