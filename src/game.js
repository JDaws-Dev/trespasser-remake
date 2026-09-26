// Gameplay: guns you can pick up and fire (with the original level's stats),
// dinosaurs with health, raptors that hunt Anne, and Anne's own health.
// Game coordinates throughout (metres, Z up).
import * as THREE from 'three';
import { UI } from './ui.js';
import { Blood } from './blood.js';
import { Anne, frontLayer } from './anne.js';

const RAPTOR_SPEED = 7.5, RAPTOR_TURN = 3.0, RAPTOR_SIGHT = 70, RAPTOR_BITE = 2.6;
const RAPTOR_DAMAGE = 12, RAPTOR_BITE_COOLDOWN = 1.1;
const PLAYER_HP = 100;

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
        ammo: inst.props.MaxAmmo ?? 6,
        name: inst.name.replace(/^P/, '').replace(/-\d+$/, '').replace(/Frame\d*$/, ''),
      }));

    // Dinosaurs: raptors hunt, the big ones wander.
    this.dinos = info.instances
      .map((inst, i) => ({ inst, i }))
      .filter(({ inst }) => inst.cls === 'CAnimal')
      .map(({ inst, i }) => ({
        inst, index: i,
        pos: new THREE.Vector3(...inst.pos),
        yaw: Math.atan2(inst.rot[1][0], inst.rot[0][0]),
        hp: inst.props.HitPoints ?? 50,
        raptor: /raptor/i.test(inst.props.Type || inst.name),
        alive: true, bite: 0, wander: Math.random() * 6.28, wanderT: 0,
        radius: /raptor/i.test(inst.props.Type || inst.name) ? 1.2 : 5,
        scale: inst.scale, awake: false, callT: 5 + Math.random() * 20,
        vocal: /raptor/i.test(inst.name) ? 'Raptor' : /brachi/i.test(inst.name) ? 'Brachiosaur' : /trex|rex/i.test(inst.name) ? 'Trex'
             : /alberto/i.test(inst.name) ? 'Albertosaur' : /para/i.test(inst.name) ? 'Parasaurolophus' : /trike|tricer/i.test(inst.name) ? 'Triceratops'
             : /steg/i.test(inst.name) ? 'Stegosaur' : null,
      }));

    // Animal models are centred on the body: lift each by its model's lowest point so
    // it stands on its feet, and never frustum-cull them (their instances roam far
    // from the spawn points the meshes' bounding spheres were computed from).
    for (const d of this.dinos) {
      let minZ = 0;
      for (const { mesh } of this.refs[d.index] || []) {
        mesh.frustumCulled = false;
        mesh.geometry.computeBoundingBox();
        minZ = Math.min(minZ, mesh.geometry.boundingBox.min.z);
      }
      d.foot = -minZ * d.scale;
    }

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
    if (this.physics?.hand.aiming && this.physics.handGrab(player) === true) return true;   // the raised hand grabs / lets go
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

  fire(player) {
    if (this.physics?.handFire(player)) return;   // hand up: grab / let go; carrying: throw; gun stowed: nothing
    const g = this.gun;
    if (!g || this.cooldown > 0) return;
    const rof = g.inst.props.ROF || 2;
    this.cooldown = 1 / rof;
    if (g.ammo <= 0) { this.showHint('Empty', 0.8); this.audio?.play(g.inst.props.EmptyClipSample); return; }
    g.ammo--;
    this.recoil = 1;
    this.audio?.play(g.inst.props.Sample, { volume: 0.8 });
    // A ray along the view: the nearest dinosaur within range, unless scenery is closer.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const origin = this.camera.position.clone();
    const dirGame = this.world.worldToLocal(origin.clone().add(dir)).sub(this.world.worldToLocal(origin.clone())).normalize();
    const originGame = this.world.worldToLocal(origin.clone());
    const range = g.inst.props.Range || 300;
    const ray = new THREE.Ray(originGame, dirGame);
    let sceneryDist = range;
    const hit = this.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, range);
    if (hit) sceneryDist = hit.distance;
    let target = null, targetDist = sceneryDist;
    const sphere = new THREE.Sphere();
    for (const d of this.dinos) {
      if (!d.alive) continue;
      sphere.set(d.pos.clone().add(new THREE.Vector3(0, 0, d.radius)), d.radius * 1.6);
      const p = ray.intersectSphere(sphere, new THREE.Vector3());
      if (p) { const dist = p.distanceTo(originGame); if (dist < targetDist) { target = d; targetDist = dist; } }
    }
    // A loose object in the way takes the bullet (and is knocked by it).
    if (this.physics?.shot(originGame, dirGame, targetDist, g.inst.props.Push)) target = null;
    if (target) {
      this.blood?.shot(target, ray, targetDist, g);
      target.hp -= (g.inst.props.Damage || 10) * (g.inst.props.DamageMultiplier || 1);
      const wasAwake = target.awake;
      target.awake = true;
      if (target.hp <= 0) this.kill(target);
      else this.audio?.vocal(target.vocal, wasAwake ? 'Pain' : 'Snarl', target.pos);
    }
  }

  kill(d) {
    d.alive = false;
    this.audio?.vocal(d.vocal, 'Dying', d.pos);
    this.blood?.kill(d);
    if (this.physics?.ragdoll(d)) return;   // tumbles as a body, knocked by the shot
    // Down on its side.
    const side = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    d.pos.z = this.groundAt(d.pos.x, d.pos.y) + d.radius * 0.6;
    this.setInstanceMatrix(d.index, this.matrixFor(d.inst, d.pos, d.yaw, side));
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
    if (input.fire) this.fire(player);

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
      } else if (hand && hand.mode === 'arm' && hand.target) {
        const r = hand.rotation || null;
        reach = { palm: hand.pos || hand.target, viewRot: r?.isQuaternion ? r : null, rot: r && !r.isQuaternion ? r : null };
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

    for (const d of this.dinos) {
      if (!d.alive) continue;
      const toPlayer = player.pos.clone().sub(d.pos);
      const dist = toPlayer.length();
      if (d.raptor) {
        if (dist < RAPTOR_SIGHT && !d.awake) { d.awake = true; this.audio?.vocal(d.vocal, 'Roar', d.pos); }
        if (d.awake && dist > 1.5) {
          const want = Math.atan2(toPlayer.y, toPlayer.x) - Math.PI / 2;   // models face +Y
          let diff = ((want - d.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
          d.yaw += THREE.MathUtils.clamp(diff, -RAPTOR_TURN * dt, RAPTOR_TURN * dt);
          if (dist > RAPTOR_BITE) {
            d.pos.x += -Math.sin(d.yaw) * RAPTOR_SPEED * dt;
            d.pos.y += Math.cos(d.yaw) * RAPTOR_SPEED * dt;
          }
        }
        d.bite = Math.max(0, d.bite - dt);
        if (d.awake && dist < RAPTOR_BITE && d.bite === 0) {
          d.bite = RAPTOR_BITE_COOLDOWN;
          this.audio?.vocal(d.vocal, Math.random() < 0.5 ? 'Bite' : 'Attack', d.pos);
          this.blood?.bite(d, player);
          this.hurt(RAPTOR_DAMAGE);
        }
      } else {
        // The big herbivores amble about slowly.
        d.wanderT -= dt;
        if (d.wanderT <= 0) { d.wanderT = 4 + Math.random() * 6; d.wander = d.yaw + (Math.random() - 0.5) * 1.5; }
        let diff = ((d.wander - d.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        d.yaw += THREE.MathUtils.clamp(diff, -0.3 * dt, 0.3 * dt);
        d.pos.x += -Math.sin(d.yaw) * 0.8 * dt;
        d.pos.y += Math.cos(d.yaw) * 0.8 * dt;
      }
      // Now and then a call, so you hear what is out there.
      d.callT -= dt;
      if (d.callT <= 0 && dist < 250) { d.callT = 12 + Math.random() * 25; this.audio?.vocal(d.vocal, d.raptor ? (d.awake ? 'Snarl' : 'Call') : 'Call', d.pos, 0.8); }
      d.pos.z = this.groundAt(d.pos.x, d.pos.y) + d.foot;
      this.setInstanceMatrix(d.index, this.matrixFor(d.inst, d.pos, d.yaw));
      // Gait amount for the walk shader: eases in as the animal moves.
      const moving = d.raptor ? (d.awake && dist > RAPTOR_BITE) : true;
      d.gait = THREE.MathUtils.lerp(d.gait || 0, moving ? 1 : 0, Math.min(1, dt * 4));
      for (const { mesh, i } of this.refs[d.index] || []) {
        const a = mesh.geometry.getAttribute('aGait');
        if (a) { a.setX(i, d.gait); a.needsUpdate = true; }
      }
    }

    this.ui.update({ hp: this.hp, maxHp: PLAYER_HP, gun: this.gun, hint: this.hint });
  }

  hurt(amount) {
    if (this.dead) return;
    this.hp -= amount;
    this.blood?.hurt(amount);
    this.ui.update({ hp: this.hp, maxHp: PLAYER_HP, gun: this.gun, hint: this.hint });
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
