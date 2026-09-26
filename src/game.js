// Gameplay: guns you can pick up and fire (with the original level's stats),
// dinosaurs with health, raptors that hunt Anne, and Anne's own health.
// Game coordinates throughout (metres, Z up).
import * as THREE from 'three';

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

    // The held gun is drawn from the same geometry as the pickup, parented to the camera.
    this.hand = new THREE.Group();
    camera.add(this.hand);
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
    let best = null, bestD = 3.0;
    for (const p of this.pickups) {
      if (p.taken) continue;
      const d = Math.hypot(p.pos.x - player.pos.x, p.pos.y - player.pos.y) + Math.max(0, Math.abs(p.pos.z - player.pos.z) - 1.5);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) return false;
    if (this.gun) this.drop(player);
    best.taken = true;
    this.setInstanceMatrix(best.index, new THREE.Matrix4().makeScale(0, 0, 0));
    this.gun = best;
    this.hand.clear();
    for (const { mesh } of this.refs[best.index] || []) {
      const held = new THREE.Mesh(mesh.geometry, mesh.material);
      held.frustumCulled = false;
      this.hand.add(held);
    }
    // Game axes to camera axes (+Y forward becomes -Z, +Z up becomes +Y), held low-right.
    this.hand.rotation.set(-Math.PI / 2, 0, 0);
    this.hand.scale.setScalar(best.inst.scale);
    this.hand.position.set(0.28, -0.22, -0.55);
    const name = best.inst.name.replace(/^P/, '').replace(/-\d+$/, '').replace(/Frame\d*$/, '');
    this.showHint(`${name}: ${best.ammo} rounds`, 2.5);
    return true;
  }

  drop(player) {
    const g = this.gun;
    if (!g) return;
    g.taken = false;
    g.pos.set(player.pos.x, player.pos.y, this.groundAt(player.pos.x, player.pos.y) + 0.1);
    this.setInstanceMatrix(g.index, this.matrixFor(g.inst, g.pos, player.yaw));
    this.gun = null;
    this.hand.clear();
  }

  fire(player) {
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
    if (target) {
      target.hp -= (g.inst.props.Damage || 10) * (g.inst.props.DamageMultiplier || 1);
      const wasAwake = target.awake;
      target.awake = true;
      if (target.hp <= 0) this.kill(target);
      else this.audio?.vocal(target.vocal, wasAwake ? 'Pain' : 'Snarl', target.pos);
    }
    this.showHint(`${g.ammo} rounds`, 1);
  }

  kill(d) {
    d.alive = false;
    this.audio?.vocal(d.vocal, 'Dying', d.pos);
    // Down on its side.
    const side = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    d.pos.z = this.groundAt(d.pos.x, d.pos.y) + d.radius * 0.6;
    this.setInstanceMatrix(d.index, this.matrixFor(d.inst, d.pos, d.yaw, side));
  }

  update(dt, player, input) {
    if (this.dead) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (input.pickup) this.tryPickup(player);
    if (input.drop) this.drop(player);
    if (input.fire) this.fire(player);

    // Recoil: the held gun kicks back and settles.
    this.recoil = Math.max(0, (this.recoil || 0) - dt * 6);
    this.hand.position.z = -0.55 + this.recoil * 0.08;
    this.hand.rotation.x = -Math.PI / 2 + this.recoil * 0.25;

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
      d.pos.z = this.groundAt(d.pos.x, d.pos.y);
      // A little gait: bob while moving.
      const bob = d.raptor && d.awake ? new THREE.Matrix4().makeRotationX(Math.sin(now / 90) * 0.05) : null;
      this.setInstanceMatrix(d.index, this.matrixFor(d.inst, d.pos, d.yaw, bob));
    }

    const alive = this.dinos.filter((d) => d.alive && d.raptor).length;
    this.hud.textContent = [
      `Health ${Math.max(0, Math.round(this.hp))}`,
      this.gun ? `${this.gun.ammo} rounds` : 'No weapon',
      this.hint,
    ].filter(Boolean).join('   ·   ');
    void alive;
  }

  hurt(amount) {
    this.hp -= amount;
    this.flash = 1;
    if (this.hp <= 0 && !this.dead) {
      this.dead = true;
      this.hud.textContent = 'Anne is dead.  Tap or press any key to try again.';
      const again = () => location.reload();
      addEventListener('keydown', again, { once: true });
      addEventListener('touchstart', again, { once: true });
      addEventListener('mousedown', again, { once: true });
    }
  }
}
