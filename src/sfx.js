// Sound effects, driven the way Trespasser drove them: every sound comes from the
// original collision table (tools/export_sfx_all.py -> sfx.json). A collision
// between two sound materials looks up their pair; its transfer turns the impact
// energy into volume and pitch (Lib/Audio/AudioDaemon.cpp Process(CMessageCollision),
// SoundDefs.hpp SSoundTransfer, Sample.cpp SetTransfer). Footsteps are the pair
// "ANNE-FOOT" x the top terrain object under her; dinosaur footsteps their foot
// material x the ground. Anne's voice (ouch, falls, jump, counting her ammo) follows
// Player.cpp. Game coordinates throughout (metres, Z up).
import * as THREE from 'three';

const LOG_HIT = Math.log(1000), LOG_SLIDE = Math.log(10000);   // MessageTypes.cpp
const CULL = 70;                  // metres: collisions farther than this are not heard
const HITS_PER_SEC = 18;          // a collapsing pile shouldn't machine-gun
const PER_BODY = 0.07;            // seconds between sounds from one spot
const WATER = 'terrain - water2';
const _v = new THREE.Vector3();

// Log-scaled collision energy (joules) to the 0..1 the transfers expect.
export const normHit = (e) => (e > 0 ? THREE.MathUtils.clamp(Math.log(e / 0.1) / LOG_HIT, 0, 1) : 0);
export const normSlide = (e) => (e > 0 ? THREE.MathUtils.clamp(Math.log(e / 0.1) / LOG_SLIDE, 0, 1) : 0);

// A transfer T = [sample, volMax, volMin, volSlope, volInt, pMax, pMin, pSlope, pInt, atten, minVel]
// at normalised velocity v: linear gain, playback rate, reference distance.
function transfer(t, v) {
  const vol = THREE.MathUtils.clamp(t[3] * v + t[4], t[2], t[1]);
  let p = THREE.MathUtils.clamp(t[7] * v + t[8], t[6], t[5]);
  p = p < 0 ? 1 + p * 0.75 : 1 + p * 3;
  return {
    gain: Math.pow(10, (-40 + vol * 40) / 20),
    rate: p * (1 + (Math.random() * 2 - 1) * 0.08),
    // DirectSound's minimum distance for a dB-per-metre roll-off (Sample.cpp).
    refDistance: t[9] > 0 ? 3.0103 / t[9] : 1000,
  };
}

const pick = (list) => (list && list.length ? list[Math.floor(Math.random() * list.length)] : null);
const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : '');

export class Sfx {
  constructor({ audio, game, physics, info, groundAt }) {
    Object.assign(this, { audio, game, physics, info, groundAt });
    this.data = null;
    this.log = [];               // recent sounds, for tests: { t, name, kind }
    this.lastPair = new Map();   // pair key -> time last used (the original's fMinTimeDelay)
    this.lastSpot = new Map();   // coarse position key -> time
    this.bucket = HITS_PER_SEC;
    this.loops = new Map();      // slide id -> { h, seen }
    this.time = 0;
    this.talkUntil = 0;
    this.prev = null;            // Anne's last frame
    this.stepAcc = 0;
    this.foot = 0;
    this.dinoSteps = new Map();
    this.splash = new Map();     // body entry -> was under water
    this.handler = (ev) => this.impact(ev);
    this.chained = null;
    audio.ready.then(() => this.load(audio.index));
  }

  load(j) {
    if (!j || !j.collisions) return;
    // Material names differ in case between levels ('Wood Hard 2', 'WOOD HARD 2'): the
    // engine hashed them case-blind, so key everything lower-case.
    const pairs = new Map();
    for (const [k, v] of Object.entries(j.collisions)) pairs.set(this.key(...k.split('|')), v);
    // Sound regions: triangles on a 16 m grid.
    const cell = 16, grid = new Map();
    const regions = (j.regions?.list || []).map((r) => {
      const t = r.slice(2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < t.length; i += 2) {
        x0 = Math.min(x0, t[i]); x1 = Math.max(x1, t[i]); y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]);
      }
      return { mat: lc(j.regions.mats[r[0]]), h: r[1], t, x0, y0, x1, y1 };
    });
    regions.forEach((r, i) => {
      for (let cx = Math.floor(r.x0 / cell); cx <= Math.floor(r.x1 / cell); cx++)
        for (let cy = Math.floor(r.y0 / cell); cy <= Math.floor(r.y1 / cell); cy++) {
          const k = cx * 100003 + cy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
    });
    // Solid scenery that carries a sound material, for what Anne or a bullet meets off the terrain.
    const scenery = (this.info.instances || []).filter((i) => i.props?.Tangible && !i.props?.Moveable && i.props?.SoundMaterial
      && i.cls !== 'CTerrainObj' && i.cls !== 'CAnimal').map((i) => ({ pos: new THREE.Vector3(...i.pos), mat: lc(i.props.SoundMaterial), r: 2 * (i.scale || 1) }));
    this.data = { ...j, pairs, regions, grid, cell, scenery };
  }

  key(a, b) {
    a = lc(a); b = lc(b);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  // ------------------------------------------------------------------ where things are
  // The sound material of the top terrain object at (x, y) (highest Height wins).
  regionAt(x, y) {
    const d = this.data;
    if (!d) return null;
    const list = d.grid.get(Math.floor(x / d.cell) * 100003 + Math.floor(y / d.cell));
    let best = null, bh = -1;
    for (const i of list || []) {
      const r = d.regions[i];
      if (r.h <= bh || x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      const t = r.t;
      for (let k = 0; k < t.length; k += 6) {
        const d1 = (x - t[k + 2]) * (t[k + 1] - t[k + 3]) - (t[k] - t[k + 2]) * (y - t[k + 3]);
        const d2 = (x - t[k + 4]) * (t[k + 3] - t[k + 5]) - (t[k + 2] - t[k + 4]) * (y - t[k + 5]);
        const d3 = (x - t[k]) * (t[k + 5] - t[k + 1]) - (t[k + 4] - t[k]) * (y - t[k + 1]);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { best = r.mat; bh = r.h; break; }
      }
    }
    return best;
  }

  // Height of the water surface at (x, y), or null: the level's ponds, then the sea.
  // `z`, when given, skips the sea test for points above it (saves a terrain ray).
  waterAt(x, y, ground, z) {
    const d = this.data;
    if (!d) return null;
    if (z === undefined) z = -Infinity;
    let w = null;
    for (const b of d.water || []) {
      const bx = b.box;
      if (x >= bx[0] && x <= bx[2] && y >= bx[1] && y <= bx[3] && (w === null || b.z > w)) w = b.z;
    }
    if (w === null && d.sea != null && z < d.sea && (ground ?? this.groundAt(x, y)) < d.sea) w = d.sea;
    return w;
  }

  // What a point on the ground is made of: water, a terrain region, else a guess from
  // the height (sand by the sea, grass above), as the remake paints it.
  groundMaterial(x, y, z) {
    const g = this.groundAt(x, y);
    const w = this.waterAt(x, y, g);
    if (w !== null && z < w + 0.02 && w > g) return WATER;
    const r = this.regionAt(x, y);
    if (r) return r;
    const sea = this.data?.sea;
    return sea != null && g < sea + 2 ? 'terrain - sand' : 'terrain - grass';
  }

  // Scenery material near a point (the nearest solid object that names one).
  sceneryMaterial(p) {
    let best = null, bd = 12;
    for (const s of this.data?.scenery || []) {
      const dd = s.pos.distanceTo(p) - s.r;
      if (dd < bd) { bd = dd; best = s.mat; }
    }
    return best;
  }

  // ------------------------------------------------------------------ playing
  play(name, opts, kind) {
    this.log.push({ t: this.time, name, kind, gain: opts.gain, loop: !!opts.loop });
    if (this.log.length > 200) this.log.shift();
    return this.audio.playFx(name, opts);
  }

  near(p, range = CULL) {
    return !this.listener || this.listener.distanceToSquared(p) < range * range;
  }

  // A collision between materials a and b at point p with normalised velocity v:
  // the pair's hit samples (both of them, as the engine did), rate-limited.
  collide(a, b, v, p, kind = 'impact', force = false) {
    const d = this.data;
    if (!d || !a || !b || !this.near(p)) return false;
    const k = this.key(a, b);
    const c = d.pairs.get(k);
    if (!c || !c.hit.length) return false;
    const last = this.lastPair.get(k) ?? -1e9;
    if (!force && this.time < last + c.d) return false;
    const spot = `${Math.round(p.x * 2)},${Math.round(p.y * 2)},${Math.round(p.z * 2)}`;
    if (!force && this.time < (this.lastSpot.get(spot) ?? -1e9) + PER_BODY) return false;
    if (!force && this.bucket < 1) return false;
    let played = false;
    for (const t of c.hit) {
      if (v <= t[10]) continue;
      const tr = transfer(t, v);
      this.play(t[0], { pos: p.clone(), ...tr }, kind);
      played = true;
    }
    if (played) {
      this.lastPair.set(k, this.time);
      this.lastSpot.set(spot, this.time);
      if (!force) this.bucket -= 1;
    }
    return played;
  }

  // physics.onImpact: { materialA, materialB, impulse, point, energy, mass, id, slide? }.
  impact(ev) {
    if (!this.data || !ev) return;
    const p = ev.point instanceof THREE.Vector3 ? ev.point : _v.set(ev.point.x, ev.point.y, ev.point.z).clone();
    // '' is Anne's hand; 'TERRAIN' the ground or static scenery with no material of its
    // own: the terrain region there, or the nearest scenery that names one.
    let ground = null;
    const res = (m) => {
      if (m === '' || m == null) return 'ANNE-HAND';
      if (!/^terrain$/i.test(m)) return m;
      ground ??= this.groundAt(p.x, p.y);
      return p.z - ground > 0.4 ? this.sceneryMaterial(p) || 'terrain - wood' : this.groundMaterial(p.x, p.y, p.z);
    };
    const a = res(ev.materialA), b = res(ev.materialB);
    // Anne's body and feet make no collision sounds here (the engine's "brutal evil
    // hack"); her feet are handled by the walk cycle.
    if (/^anne-(body|foot)/i.test(a) || /^anne-(body|foot)/i.test(b)) return;
    const energy = ev.energy ?? (ev.impulse ? (ev.impulse * ev.impulse) / (2 * (ev.mass || 10)) : 0);
    this.collide(a, b, normHit(energy), p);
    if (ev.slide > 0) this.slide(a, b, normSlide(ev.slide), p, ev.id ?? this.key(a, b));
  }

  slide(a, b, v, p, id) {
    const c = this.data.pairs.get(this.key(a, b));
    if (!c?.slide || v <= c.slide[10] || !this.near(p)) return;
    const tr = transfer(c.slide, v);
    let l = this.loops.get(id);
    if (!l) {
      l = { h: null, seen: this.time, starting: true };
      this.loops.set(id, l);
      this.play(c.slide[0], { pos: p.clone(), ...tr, loop: true }, 'slide').then((h) => {
        l.h = h;
        if (h && this.loops.get(id) !== l) h.src.stop();
      });
    } else if (l.h) {
      const t = this.audio.ctx.currentTime;
      l.h.gain.gain.setTargetAtTime(tr.gain, t, 0.05);
      if (l.h.pan) {
        const w = this.audio.toListenerSpace(p);
        l.h.pan.positionX.setTargetAtTime(w.x, t, 0.05); l.h.pan.positionY.setTargetAtTime(w.y, t, 0.05); l.h.pan.positionZ.setTargetAtTime(w.z, t, 0.05);
      }
    }
    l.seen = this.time;
  }

  // Anne says something, one line at a time (Player.cpp bCanTalk / Say).
  say(list) {
    const name = pick(list);
    if (!name || this.time < this.talkUntil) return;
    this.talkUntil = this.time + 1.5;
    this.play(name, {}, 'voice').then((h) => { if (h) this.talkUntil = this.time + h.duration; });
  }

  ouch(hp) {
    // Normalised hit points after the blow: the set with the lowest Damage level still
    // above them, else the default ouch.
    const o = this.data?.anne?.ouch;
    if (!o) return;
    if (hp <= 0) this.talkUntil = 0;   // the killing blow interrupts
    let best = null, lo = 2;
    for (const s of o.sets) if (hp < s.damage && s.damage < lo) { best = s.samples; lo = s.damage; }
    this.say(best || o.default);
  }

  // ------------------------------------------------------------------ ammo talk
  ammoPickup(g) {
    const a = this.data?.anne?.pickup, n = Math.max(0, g.ammo), max = g.inst.props.MaxAmmo || n || 1;
    if (!a) return;
    if (g.inst.props.AltAmmoCount && n) {
      this.say(n < max * 0.3 ? a.AmmoAlmostEmpty : n < max * 0.75 ? a.AmmoHalfFull : n < max ? a.AmmoFull : a.AmmoReallyFull);
    } else {
      const k = n <= 10 ? n : n <= 13 ? 12 : n <= 17 ? 15 : n <= 25 ? 20 : n <= 35 ? 30 : null;
      if (k !== null) this.say(a['A' + String(k).padStart(2, '0')]);
    }
  }

  ammoFired(g, before) {
    const a = this.data?.anne?.ammo, n = Math.max(0, g.ammo), max = g.inst.props.MaxAmmo || 1;
    if (!a) return;
    if (g.inst.props.AltAmmoCount) {
      if (n <= max * 0.5 && before > max * 0.5) this.say(a.AmmoHalfFull);
      else if (n <= max * 0.1 && before > max * 0.1) this.say(a.AmmoAlmostEmpty);
    } else if (Math.random() < 2 / 3) {
      const set = a['A' + String(n).padStart(2, '0')];
      if (set && (n < 18 || n === 20 || n === 30)) this.say(set);
    }
  }

  // ------------------------------------------------------------------ bullets
  // Wraps physics.shot: whatever the round meets plays BULLET x its material.
  hookShots() {
    const ph = this.physics;
    if (!ph?.shot || ph.shot.__sfx) return;
    const orig = ph.shot.bind(ph);
    const self = this;
    const wrapped = function (origin, dir, maxDist, push) {
      const r = orig(origin, dir, maxDist, push);
      try { self.bullet(origin, dir, maxDist); } catch (e) { /* sound is never worth a crash */ }
      return r;
    };
    wrapped.__sfx = true;
    ph.shot = wrapped;
  }

  bullet(origin, dir, maxDist) {
    const ph = this.physics;
    if (!ph.world || !this.data) return;
    const hit = ph.world.castRay({ origin, dir }, maxDist + 0.5, true, undefined, undefined, ph.playerCol);
    if (!hit) return;
    const p = origin.clone().addScaledVector(dir, hit.timeOfImpact ?? hit.toi);
    const b = hit.collider.parent();
    if (ph.dinos?.some((r) => r.body === b && !r.dead)) return;   // flesh: blood.js
    const e = b && ph.byHandle?.get(b.handle);
    let mat = e?.inst?.props?.SoundMaterial;
    if (!mat) mat = Math.abs(p.z - this.groundAt(p.x, p.y)) < 0.4 ? this.groundMaterial(p.x, p.y, p.z) : this.sceneryMaterial(p);
    this.lastBullet = { mat, p };
    this.collide('BULLET', mat, 1, p, 'bullet', true);
  }

  // ------------------------------------------------------------------ each frame
  update(dt, player) {
    if (!this.data || !this.audio.ctx || this.audio.ctx.state !== 'running' || this.game?.ui?.paused) {
      this.prev = null;
      return;
    }
    this.time += dt;
    this.bucket = Math.min(HITS_PER_SEC, this.bucket + dt * HITS_PER_SEC);
    const ph = this.physics;
    if (ph && ph.onImpact !== this.handler) {
      // Keep whatever else listens: chain it.
      const other = ph.onImpact;
      if (other && other !== this.handler) this.chained = other;
      const self = this;
      this.handler = function (ev) { try { self.chained?.(ev); } finally { self.impact(ev); } };
      ph.onImpact = this.handler;
    }
    this.hookShots();
    this.listener = new THREE.Vector3(player.pos.x, player.pos.y, player.pos.z + 1.6);

    this.anne(dt, player);
    this.dinos(dt);
    this.splashes();

    // Scrapes that stopped being reported fade out.
    for (const [id, l] of this.loops) {
      if (this.time - l.seen > 0.15) {
        if (l.h) {
          const t = this.audio.ctx.currentTime;
          l.h.gain.gain.setTargetAtTime(0, t, 0.06);
          l.h.src.stop(t + 0.3);
        }
        this.loops.delete(id);
      }
    }
  }

  anne(dt, player) {
    const g = this.game;
    const pos = player.pos;
    const grounded = player.vz === 0;
    const prev = this.prev;
    this.prev = { x: pos.x, y: pos.y, z: pos.z, vz: player.vz, grounded, hp: g?.hp, gun: g?.gun, ammo: g?.gun?.ammo, held: this.physics?.held?.entry };
    if (!prev) return;

    // Hurt: an ouch for the damage level she's at.
    if (g && g.hp < prev.hp) this.ouch(g.hp / 100);

    // Jump and landing.
    if (!grounded && prev.grounded && player.vz > 1) this.say(this.data.anne?.jump);
    const feet = new THREE.Vector3(pos.x, pos.y, pos.z);
    if (grounded && !prev.grounded && prev.vz < -2.5 && this.time > 1) {   // not the drop onto the level at spawn
      const speed = -prev.vz;
      const mat = this.underfoot(feet);
      this.collide('ANNE-FOOT', mat, THREE.MathUtils.clamp(0.7 + (speed - 2.5) / 12, 0.7, 1), feet, 'land', true);
      this.stepAcc = 0;
      // A long drop hurts: her fall cry (the game itself deals no fall damage yet).
      if (speed > 11 && this.data.anne?.fall) {
        const f = this.data.anne.fall;
        this.say(speed > 17 && f.sets.length ? f.sets.reduce((a, s) => (s.damage < a.damage ? s : a)).samples
          : f.sets.length ? f.sets.reduce((a, s) => (s.damage > a.damage ? s : a)).samples : f.default);
      }
    }

    // Footsteps: one per stride while she walks on something.
    const moved = Math.hypot(pos.x - prev.x, pos.y - prev.y);
    const speed = moved / Math.max(dt, 1e-3);
    if (grounded && speed > 0.6 && speed < 20) {
      this.stepAcc += moved;
      const stride = speed > 4.5 ? 1.7 : 1.25;
      if (this.stepAcc >= stride) {
        this.stepAcc = 0;
        this.foot ^= 1;
        const side = this.foot ? 0.15 : -0.15;
        const p = new THREE.Vector3(pos.x + Math.cos(player.yaw) * side, pos.y + Math.sin(player.yaw) * side, pos.z);
        const mat = this.underfoot(p);
        if (mat) this.collide('ANNE-FOOT', mat, speed > 4.5 ? 1 : 0.85, p, 'step', true);
      }
    } else if (!grounded || speed < 0.1) {
      this.stepAcc = Math.min(this.stepAcc, 0.9);   // the first step comes quickly
    }

    // Guns: the hand closing on it, then Anne sizing up the ammo.
    if (g?.gun && g.gun !== prev.gun) {
      this.collide('ANNE-HAND', g.gun.inst.props.SoundMaterial, 0.6, feet.clone().setZ(pos.z + 1.2), 'hand', true);
      this.ammoPickup(g.gun);
    } else if (g?.gun && g.gun === prev.gun && g.gun.ammo < prev.ammo) {
      this.ammoFired(g.gun, prev.ammo);
    }
    // Picking up anything else by hand.
    const held = this.physics?.held?.entry;
    if (held && held !== prev.held) this.collide('ANNE-HAND', held.inst?.props?.SoundMaterial, 0.6, held.curP?.clone() || feet, 'hand', true);
  }

  // What Anne stands on: water, the object under her, or the terrain's region.
  underfoot(p) {
    const ground = this.groundAt(p.x, p.y);
    const w = this.waterAt(p.x, p.y, ground);
    if (w !== null && p.z < w + 0.05 && w > ground) return p.z < w - 1.2 ? null : WATER;   // swimming: silent
    if (p.z - ground > 0.25) {
      const ph = this.physics;
      if (ph?.world) {
        const hit = ph.world.castRay({ origin: { x: p.x, y: p.y, z: p.z + 0.2 }, dir: { x: 0, y: 0, z: -1 } }, 0.8, true,
          undefined, undefined, ph.playerCol);
        const b = hit?.collider.parent();
        const e = b && ph.byHandle?.get(b.handle);
        if (e?.inst?.props?.SoundMaterial) return e.inst.props.SoundMaterial;
      }
      return this.sceneryMaterial(p) || 'terrain - wood';
    }
    return this.groundMaterial(p.x, p.y, p.z);
  }

  // Dinosaur footsteps: their foot material on the ground under them, louder for the big ones.
  dinos(dt) {
    const feet = this.data.dinoFeet || {};
    for (const d of this.game?.dinos || []) {
      if (!d.alive || !feet[d.vocal]) continue;
      let s = this.dinoSteps.get(d);
      if (!s) { this.dinoSteps.set(d, (s = { x: d.pos.x, y: d.pos.y, acc: Math.random() })); continue; }
      const moved = Math.hypot(d.pos.x - s.x, d.pos.y - s.y);
      s.x = d.pos.x; s.y = d.pos.y;
      if (moved / Math.max(dt, 1e-3) < 0.3 || moved > 5) continue;
      s.acc += moved;
      const big = !d.raptor;
      const stride = (big ? 1.8 : 1.6) * Math.max(0.6, Math.min(1.6, d.scale || 1));
      if (s.acc < stride) continue;
      s.acc = 0;
      if (!this.near(d.pos, big ? 150 : 60)) continue;
      const p = d.pos.clone();
      const mat = this.groundMaterial(p.x, p.y, p.z);
      this.collide(feet[d.vocal], mat, big ? 1 : 0.8, p, 'dinostep', true);
    }
  }

  // Objects falling into water: a splash, by how hard they hit the surface.
  splashes() {
    const ph = this.physics;
    if (!ph?.live) return;
    for (const e of ph.live) {
      if (!e.body || e.body.isSleeping?.()) { this.splash.delete(e); continue; }
      const p = e.curP;
      if (!p || !this.near(p)) continue;
      const w = this.waterAt(p.x, p.y, undefined, p.z);
      const under = w !== null && p.z < w;
      const was = this.splash.get(e);
      this.splash.set(e, under);
      if (under && was === false) {
        const vz = e.body.linvel().z;
        if (vz > -1) continue;
        const energy = 0.5 * (e.mass || 10) * vz * vz;
        const mat = e.inst?.props?.SoundMaterial || 'WOOD HARD 1';
        const at = new THREE.Vector3(p.x, p.y, w);
        if (!this.collide(mat, WATER, normHit(energy), at, 'splash', true))
          this.collide('ANNE-FOOT', WATER, normHit(energy), at, 'splash', true);
      }
    }
  }
}
