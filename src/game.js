// Gameplay: guns you can pick up and fire (with the original level's stats),
// dinosaurs (dinos.js) and Anne's own health.
// Game coordinates throughout (metres, Z up).
import * as THREE from 'three';
import { UI } from './ui.js';
import { Blood } from './blood.js';
import { Anne, frontLayer } from './anne.js';
import { DinoAI } from './dinos.js';

// Anne (Animate.cpp:326 defaults; the Player object overrides none of them): 100 HP,
// 1 HP a second back while alive, no delay.
const PLAYER_HP = 100, PLAYER_REGEN = 1;
// Falling (Animate.cpp:81, 283, 991): her 100 kg foot box's landing energy x 0.08
// (fBIOMODEL_ADJUST_HACK) x 0.22 HP per joule, less a buffer as big as her maximum HP
// (fCOLLISION_BUFFER 1) that soaks bumps: nothing below ~6 m, dead from ~12 m.
const FOOT_MASS = 100, BIOBOX = 0.08, COLLISION_DAMAGE = 0.22;
// Clubbing with an empty gun (Gun.cpp:376; Player.cpp:131 sSwingTime 1 s, swing damage
// x 2.75 for anything under 5 kg): collision energy at the swing speed below.
const SWING_TIME = 1.0, SWING_SPEED = 6, SWING_MUL = 2.75, SWING_REACH = 1.7;

export class Game {
  constructor({ scene, world, camera, info, refs, collider, groundAt, hud, level, audio }) {
    Object.assign(this, { scene, world, camera, info, refs, collider, groundAt, hud, level, audio });
    this.hp = PLAYER_HP;
    this.gun = null;            // the gun in hand
    this.cooldown = 0;
    this.hint = '';
    this.hintUntil = 0;
    this.dead = false;

    // Everything that can be picked up: guns, by their placed instance.
    this.pickups = info.instances
      .map((inst, i) => ({ inst, i }))
      .filter(({ inst }) => inst.cls === 'CGun')
      .map(({ inst, i }) => ({
        inst, index: i, taken: false, pos: new THREE.Vector3(...inst.pos),
        ammo: Math.min(inst.props.Ammo ?? inst.props.MaxAmmo ?? 100, inst.props.MaxAmmo ?? 100),   // Gun.cpp:114
        name: inst.name.replace(/^P/, '').replace(/-\d+$/, '').replace(/Frame\d*$/, ''),
      }));

    // Dinosaurs: species, feelings and steering in dinos.js.
    this.ai = new DinoAI(this);
    this.dinos = this.ai.list;
    this.regeneration = PLAYER_REGEN;
    this.muzzle = this.makeMuzzleFlash();
    this.mouseHeld = false;
    addEventListener('mousedown', (e) => { if (e.button === 0) this.mouseHeld = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseHeld = false; });

    // The level's triggers (triggers.js, from logic.json) are set as this.logic by main.js.
    this.logic = null;
    this.maxHp = PLAYER_HP;

    // The held gun is drawn from the same geometry as the pickup, parented to the camera.
    this.hand = new THREE.Group();
    camera.add(this.hand);
    // Anne's own chest and arm (tools/export_anne.py), when the level has them: she
    // then holds the gun in her hand instead.
    this.anne = null;
    Anne.load(`levels/${level}`).then((a) => {
      if (!a) return;
      this.anne = a;
      camera.add(a.root);
      window.__anne = a;   // for automated tests
      if (this.gun) this.holdGun(this.gun);
    }).catch((e) => console.warn('Anne:', e));

    this.blood = new Blood(this);
    this.ui = new UI({ game: this, touch: matchMedia('(pointer: coarse)').matches, level });
  }

  showHint(text, seconds = 2) {
    this.hint = text;
    this.hintUntil = performance.now() + seconds * 1000;
  }

  // Move one placed instance (every InstancedMesh part it belongs to).
  setInstanceMatrix(index, matrix) {
    for (const { mesh, i } of this.refs[index] || []) {
      mesh.setMatrixAt(i, matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  matrixFor(inst, pos, yaw, extra = null) {
    const m = new THREE.Matrix4().makeRotationZ(yaw);
    if (extra) m.multiply(extra);
    m.scale(new THREE.Vector3(inst.scale, inst.scale, inst.scale));
    m.setPosition(pos.x, pos.y, pos.z);
    return m;
  }

  tryPickup(player) {
    if (this.physics?.held) return this.physics.release();   // E again lets go of a held object
    if ((this.physics?.hand.aiming || this.physics?.hand.holding) && this.physics.handGrab(player) === true) return true;   // the hand grabs / lets go
    let best = null, bestD = 3.0;
    for (const p of this.pickups) {
      if (p.taken) continue;
      const d = Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) + Math.max(0, Math.abs(p.pos.z - player.pos.z) - 1.5);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) return this.physics?.grab(player) ?? false;   // no gun: any light object ahead
    if (this.gun) this.drop(player);
    best.taken = true;
    this.physics?.take(best.index);
    this.setInstanceMatrix(best.index, new THREE.Matrix4().makeScale(0, 0, 0));
    this.gun = best;
    this.holdGun(best);
    this.showHint(`Picked up the ${best.name}`, 2.5);
    return true;
  }

  // Put the gun's meshes in Anne's hand, gripped by its magnets (or, for a gun the level
  // gives none, a grip made from its shape); without her, float it low-right in front
  // of the camera.
  holdGun(g) {
    this.hand.clear();
    this.anne?.held.clear();
    this.holding = this.anne && this.anne.gripFor(g.inst.name);
    if (this.anne && !this.holding && (this.refs[g.index] || []).length) {
      const box = new THREE.Box3();
      for (const { mesh } of this.refs[g.index]) { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox); }
      this.holding = this.anne.genericGrip(box, g.inst.scale);
    }
    const into = this.holding ? this.anne.held : this.hand;
    for (const { mesh } of this.refs[g.index] || []) {
      // Anne's hand is drawn in front of the world, and the gun with it.
      const held = new THREE.Mesh(mesh.geometry, this.holding ? frontLayer(mesh.material.clone()) : mesh.material);
      held.frustumCulled = false;
      held.renderOrder = 11;
      into.add(held);
    }
    if (this.holding) {
      this.holding = { ...this.holding, scale: g.inst.scale };
      this.anne.setSubstitute(this.holding.grip.substitute);
      return;
    }
    // Game axes to camera axes (+Y forward becomes -Z, +Z up becomes +Y), held low-right.
    this.hand.rotation.set(-Math.PI / 2, 0, 0);
    this.hand.scale.setScalar(g.inst.scale);
    this.hand.position.set(0.28, -0.22, -0.55);
  }

  drop(player) {
    if (this.physics?.release()) return;   // a held object goes first
    const g = this.gun;
    if (!g) return;
    g.taken = false;
    if (this.physics) {
      // Let go of it in front of her, falling with her motion.
      const f = new THREE.Vector3(-Math.sin(player.yaw), Math.cos(player.yaw), 0);
      g.pos.set(player.pos.x + f.x * 0.6, player.pos.y + f.y * 0.6, player.pos.z + 1.1);
      this.physics.releaseGun(g.index, g.pos, player.yaw, this.physics.playerVel);
    } else {
      g.pos.set(player.pos.x, player.pos.y, this.groundAt(player.pos.x, player.pos.y) + 0.1);
      this.setInstanceMatrix(g.index, this.matrixFor(g.inst, g.pos, player.yaw));
    }
    this.gun = null;
    this.holding = null;
    this.hand.clear();
    this.anne?.held.clear();
  }

  // The trigger (Gun.cpp CGun::bUse). `fresh` is a new press: only automatics
  // (AutoFire) keep firing while it is held. A shot: the nearest dinosaur along the
  // view takes the gun's Damage x the Armour of the box it hits (head x2, body x1,
  // tail x0.5; Animate.cpp fCalculateHitPoints); a dart (TranqDamage) sedates instead.
  // It kicks the view (RecoilForce), flashes at the muzzle, knocks what it hits (Push)
  // and alerts every animal within WakeUp. At 0 rounds the gun clicks dry once and is
  // then swung as a club.
  fire(player, fresh = true) {
    if (this.physics?.handFire(player)) return;   // the gun is stowed: nothing
    const g = this.gun;
    if (!g || this.cooldown > 0) return;
    const p = g.inst.props;
    if (!fresh && !(p.AutoFire && g.ammo > 0)) return;
    if (g.club) return this.swing(player);
    if (g.ammo <= 0) {
      this.showHint('Empty', 0.8);
      this.audio?.play(p.EmptyClipSample);
      g.club = true;
      this.cooldown = 1;   // Gun.cpp:558: no swinging for a second after the click
      return;
    }
    g.ammo--;
    this.cooldown = 1 / (p.ROF || 1);
    this.audio?.play(p.Sample, { volume: 0.8 });
    const { ray, originGame, dirGame } = this.viewRay();
    const range = p.Range || 50;   // GunData::fExtension default
    const scenery = this.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, range);
    const sceneryDist = scenery ? scenery.distance : range;
    let hit = this.ai.hitTest(ray, sceneryDist);
    // A loose object in the way takes the bullet (and is knocked by it).
    if (this.physics?.shot(originGame, dirGame, hit ? hit.dist : sceneryDist, p.Push)) hit = null;
    if (hit) {
      const dmg = (p.Damage ?? 25) * hit.d.boxes[hit.part][0];
      this.lastHit = { name: hit.d.name, part: hit.part, damage: dmg, tranq: p.TranqDamage || 0 };
      if (dmg > 0) this.blood?.shot(hit.d, ray, hit.dist, g);
      this.ai.damage(hit.d, dmg, { tranq: p.TranqDamage || 0, from: player.pos });
    }
    this.ai.alert(player.pos, p.WakeUp ?? 100);
    this.kick(player, p.RecoilForce || 0);
    if (p.MFlashObject0) this.flash(p);
  }

  // Swing the empty gun (or anything held as a club): a short reach along the view.
  swing(player) {
    const g = this.gun, p = g.inst.props;
    this.cooldown = SWING_TIME;
    this.recoil = 1.5;
    const { ray, originGame, dirGame } = this.viewRay();
    const scenery = this.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, SWING_REACH);
    const far = scenery ? scenery.distance : SWING_REACH;
    const mass = p.Mass ?? 1;
    const energy = 0.5 * mass * SWING_SPEED * SWING_SPEED;
    const base = COLLISION_DAMAGE * energy * (p.DamageMultiplier ?? 1) * (mass < 5 ? SWING_MUL : 1);
    let hit = this.ai.hitTest(ray, far);
    if (this.physics?.shot(originGame, dirGame, hit ? hit.dist : far, (mass * SWING_SPEED) / 0.075)) hit = null;
    if (hit) {
      const dmg = base * hit.d.boxes[hit.part][0];
      this.lastHit = { name: hit.d.name, part: hit.part, damage: dmg, club: true };
      this.blood?.shot(hit.d, ray, hit.dist, { inst: { props: { Damage: dmg } } });
      this.ai.damage(hit.d, dmg, { from: player.pos });
    }
  }

  // The view as a ray in game space.
  viewRay() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const origin = this.camera.position.clone();
    const dirGame = this.world.worldToLocal(origin.clone().add(dir)).sub(this.world.worldToLocal(origin.clone())).normalize();
    const originGame = this.world.worldToLocal(origin.clone());
    return { ray: new THREE.Ray(originGame, dirGame), originGame, dirGame };
  }

  // Recoil (Gun.cpp:435, RecoilForce x 0.1 on the held gun): the muzzle climbs and the
  // view with it, most of the way back over a moment.
  kick(player, force) {
    this.recoil = Math.min(1.5, 0.6 + force / 60);
    const k = force * 0.0012 * (0.8 + Math.random() * 0.4);
    player.pitch = Math.min(1.45, player.pitch + k);
    player.yaw += force * 0.0004 * (Math.random() - 0.5);
    this.kickBack = (this.kickBack || 0) + k * 0.7;
  }

  // The muzzle flash (the gun's MFlashObject meshes, Gun.cpp:452): a star of light at
  // the end of the barrel for a frame or two, turned at random (RandomRotate).
  makeMuzzleFlash() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,235,1)');
    grad.addColorStop(0.2, 'rgba(255,220,130,0.95)');
    grad.addColorStop(0.5, 'rgba(255,150,40,0.35)');
    grad.addColorStop(1, 'rgba(255,120,20,0)');
    x.fillStyle = grad;
    x.fillRect(0, 0, 128, 128);
    x.globalCompositeOperation = 'lighter';
    x.fillStyle = 'rgba(255,230,160,0.9)';
    for (let i = 0; i < 6; i++) {
      x.save(); x.translate(64, 64); x.rotate((i / 6) * Math.PI * 2 + Math.random() * 0.4);
      x.beginPath(); x.moveTo(0, -5); x.lineTo(60, 0); x.lineTo(0, 5); x.fill(); x.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, fog: false,
    }));
    sprite.renderOrder = 12;
    sprite.visible = false;
    const light = new THREE.PointLight(0xffc27a, 0, 14, 2);
    this.scene.add(sprite, light);
    return { sprite, light, until: 0 };
  }

  flash(p) {
    const m = this.muzzle, held = this.holding ? this.anne?.held : this.hand;
    if (!held) return;
    // The end of the barrel: the far end of the held gun along the view.
    const box = new THREE.Box3().setFromObject(held);
    if (box.isEmpty()) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const half = (Math.abs(fwd.x) * size.x + Math.abs(fwd.y) * size.y + Math.abs(fwd.z) * size.z) / 2;
    m.sprite.position.copy(c).addScaledVector(fwd, half + 0.03);
    m.light.position.copy(m.sprite.position).addScaledVector(fwd, 0.2);
    const s = 0.28 + Math.min(0.3, (p.Damage || 20) / 120);
    m.sprite.scale.set(s, s, s);
    m.sprite.material.rotation = p.RandomRotate ? Math.random() * Math.PI * 2 : 0;
    m.sprite.visible = true;
    m.light.intensity = 40;
    m.until = performance.now() + 1000 * Math.max(0.05, p.MFlashDuration || 0);
  }

  // Dinosaur d dies (triggers.js calls this too).
  kill(d) {
    this.ai.kill(d);
  }

  // The script API for triggers.js: find an animal, bring one in from its pen, and
  // steer one to stay near something.
  dinoByName(name) { return this.ai.byNameOf(name); }
  activateDino(name, pos = null, yaw = null) {
    const d = this.ai.byNameOf(name);
    if (d) this.ai.activate(d, pos, yaw);
    return d;
  }
  steerDino(name, target, ok = 5, max = 15) {
    const d = this.ai.byNameOf(name);
    if (d) this.ai.stayNear(d, target, ok, max);
    return d;
  }

  // Anne lands at `speed` m/s (Animate.cpp:991: only her foot takes falling damage,
  // from its own energy). Water breaks the fall.
  land(speed, player) {
    if (this.inWater(player.pos)) return 0;
    const energy = 0.5 * FOOT_MASS * speed * speed * BIOBOX;
    const dmg = COLLISION_DAMAGE * energy - this.maxHp;   // what gets past the buffer
    if (dmg > 0) this.hurt(dmg);
    return Math.max(0, dmg);
  }

  inWater(p) {
    if (this.info.sea !== null && this.info.sea !== undefined && p.z < this.info.sea + 0.3) return true;
    if (!this.ponds) {
      this.ponds = [];
      for (const [i, inst] of this.info.instances.entries()) {
        if (inst.cls !== 'CEntityWater') continue;
        const box = new THREE.Box3();
        for (const { mesh } of this.refs[i] || []) { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox); }
        if (box.isEmpty()) continue;
        const r = inst.rot, s = inst.scale;
        const m = new THREE.Matrix4().set(r[0][0] * s, r[0][1] * s, r[0][2] * s, inst.pos[0], r[1][0] * s, r[1][1] * s, r[1][2] * s, inst.pos[1],
          r[2][0] * s, r[2][1] * s, r[2][2] * s, inst.pos[2], 0, 0, 0, 1);
        this.ponds.push(box.applyMatrix4(m));
      }
    }
    return this.ponds.some((b) => p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z < b.max.z + 0.3);
  }

  // The original's trigger system: narration, ambient sets, tutorial text, hints,
  // scripted physics, level changes (triggers.js).
  updateTriggers(dt, player) {
    this.logic?.update(dt, player);
  }

  update(dt, player, input) {
    if (this.dead || this.ui.paused) return;
    this.updateTriggers(dt, player);
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (input.pickup) this.tryPickup(player);
    if (input.drop) this.drop(player);
    // The trigger: a new press fires; automatics keep firing while it (or the mouse) is held.
    const trigger = input.fire || (!!this.gun?.inst.props.AutoFire && this.mouseHeld);
    if (trigger) this.fire(player, !this.triggerWas);
    this.triggerWas = trigger;

    // Recoil: the held gun kicks back and settles.
    this.recoil = Math.max(0, (this.recoil || 0) - dt * 6);
    this.hand.position.z = -0.55 + this.recoil * 0.08;
    this.hand.rotation.x = -Math.PI / 2 + this.recoil * 0.25;
    if (this.anne) {
      // Her hand: at rest it hangs relaxed (the Natural shape) or sights the gun. In arm
      // mode it follows the physical hand (physics.hand: palm target, wrist rotation in
      // her view frame), open when empty, in the held object's grip shape when holding;
      // stowing lowers the arm. With no gun, it holds what she carries (E-grab).
      let reach = null;
      const ph = this.physics, a = this.anne, hand = ph?.hand;
      const gripOf = (e) => (e?.inst ? a.reachFor(e.inst.name, ph.heldMatrix?.(new THREE.Matrix4()) || new THREE.Matrix4(), e.radius || 0.3).sub : a.poseIndex('Anne_Rock'));
      if (hand && (hand.stowed || hand.mode === 'stow')) {
        reach = { stow: true };
      } else if (hand && hand.mode === 'arm') {
        // Drawn on the physical hand body itself (where it stopped against what it pushes,
        // turned as the physics turned it), else on its target.
        const hb = ph.handBody?.isEnabled() ? ph.handBody : null;
        const t = hb?.translation(), q = hb?.rotation();
        reach = hb ? { palm: new THREE.Vector3(t.x, t.y, t.z), rot: new THREE.Quaternion(q.x, q.y, q.z, q.w), gunTurn: true }
                   : { palm: hand.target, viewRot: hand.rotation };
        if (!this.holding) {
          const held = hand.holding && (hand.holding.inst ? hand.holding : ph.byHandle?.get(hand.holding.handle) || ph.held?.entry);
          a.setSubstitute(hand.holding ? gripOf(held) : 0);   // gripping, else open
        }
      } else if (!this.holding && ph?.held) {
        const e = ph.held.entry;
        reach = a.reachFor(e.inst.name, ph.heldMatrix(new THREE.Matrix4()), e.radius);
        a.setSubstitute(reach.sub);
      }
      if (!this.holding && !reach?.palm) a.setSubstitute(a.poseIndex('Anne_Natural'));
      if (this.holding) a.setSubstitute(this.holding.grip.substitute);
      this.anne.update(dt, player, this.holding, this.recoil, reach);
      this.anne.updateShade(dt, this.collider, this.world, this.scene);
    }

    // Any gun within reach?
    let near = null;
    for (const p of this.pickups) if (!p.taken && Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) < 3.0) near = p;
    const now = performance.now();
    if (near && now > this.hintUntil) this.hint = input.touch ? 'Tap GRAB to pick up' : 'Press E to pick up';
    else if (now > this.hintUntil) this.hint = '';

    this.ai.update(dt, player);

    // Anne heals 1 HP a second while alive (Animate.cpp:512 CAnimate::Process).
    if (this.hp > 0) this.hp = Math.min(this.maxHp, this.hp + (this.regeneration ?? PLAYER_REGEN) * dt);
    // Landing: the speed she was falling at when the ground stopped her (main.js zeroes
    // player.vz on the ground). A teleport is not a landing.
    if (this.fallVz < -8 && player.vz >= 0 && this.fallPos && this.fallPos.distanceTo(player.pos) < 5) this.land(-this.fallVz, player);
    this.fallVz = player.vz;
    (this.fallPos ||= new THREE.Vector3()).copy(player.pos);
    // The view drifts back down after a kick; the muzzle flash goes out.
    if (this.kickBack > 0) { const r = Math.min(this.kickBack, dt * 1.2); this.kickBack -= r; player.pitch -= r; }
    if (this.muzzle.sprite.visible && performance.now() > this.muzzle.until) { this.muzzle.sprite.visible = false; this.muzzle.light.intensity = 0; }

    this.ui.update({ hp: this.hp, maxHp: this.maxHp, gun: this.gun, hint: this.hint });
  }

  hurt(amount) {
    if (this.dead) return;
    this.hp -= amount;
    this.blood?.hurt(amount);
    this.ui.update({ hp: this.hp, maxHp: this.maxHp, gun: this.gun, hint: this.hint });
    if (this.hp <= 0) {
      this.dead = true;
      this.ui.died();
    } else {
      this.ui.flash(amount / 25);
    }
  }

  // Hit points back (a trigger's heal, the splash-down in Industrial Jungle), up to the maximum.
  heal(amount) {
    if (this.dead) return;
    this.hp = Math.min(this.maxHp || PLAYER_HP, this.hp + amount);
    this.ui.update({ hp: this.hp, maxHp: this.maxHp || PLAYER_HP, gun: this.gun, hint: this.hint });
  }

  // Killed outright (a trigger's death zone).
  killAnne() {
    if (!this.dead) this.hurt(Math.max(this.hp, 1) + 1);
  }
}
