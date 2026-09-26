// Anne's own body in first person, from the level's 'Anne' object (tools/export_anne.py):
// her right arm and hand (never her torso), which reaches out and grips whatever she
// holds.
//
// The original drove the arm with physics; here it is posed each frame the way the
// engine settled it (Player.cpp): a gun is turned so its shoulder-hold magnet lines up
// with the view (hand request space), the sight point on its barrel line sits on the
// line of sight, and her palm grips it at its hand-pickup magnet, the arm reaching
// out from the shoulder. The hand shape is the magnet's substitute mesh. With nothing
// held the arm hangs at her side, out of view unless she looks down. In arm mode the
// player moves the hand (palm target and wrist rotation from physics.hand) and the
// elbow follows; stowing lowers the arm and the gun with it.
//
// Everything here is in Anne's body frame (metres; x right, y forward, z up), under a
// group that the camera carries. It is drawn in front of the world (its depth squeezed
// towards the near plane) so it never sinks into a wall she stands against.
import * as THREE from 'three';
import { textureUrl } from './level.js';

const DEPTH_SQUEEZE = 0.02;   // fraction of the depth range the arm is drawn in
const ARM_REACH = 0.97;       // fraction of full arm length the wrist is held out at
const AIM_PITCH_MIN = -0.9, AIM_PITCH_MAX = 1.1;   // hand angle limits relative to the body (radians)
const RAISE_RATE = 3.5;
const EYE_HEIGHT = 1.6;
const SHADOW_LEVEL = 0.45;    // arm brightness in shade (sky and bounce light only)       // main.js: the camera above the player's feet       // arm raises in about 1 / RAISE_RATE seconds

// Drawn over the world: clip-space depth pulled towards the near plane, order kept.
function frontLayer(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
      `#include <project_vertex>
      gl_Position.z = mix(-gl_Position.w, gl_Position.z, ${DEPTH_SQUEEZE.toFixed(3)});`);
  };
  material.customProgramCacheKey = () => 'anneFront';
  material.fog = false;
  return material;
}
export { frontLayer };

const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4();

function mat3ToMatrix4(r, pos) {
  return new THREE.Matrix4().set(r[0][0], r[0][1], r[0][2], pos ? pos[0] : 0,
                                 r[1][0], r[1][1], r[1][2], pos ? pos[1] : 0,
                                 r[2][0], r[2][1], r[2][2], pos ? pos[2] : 0,
                                 0, 0, 0, 1);
}

// A bone frame whose +Y runs along `dir`, with +Z as near to `up` as it can be.
function boneBasis(dir, up) {
  const y = dir.clone().normalize();
  const z = up.clone().addScaledVector(y, -up.dot(y));
  if (z.lengthSq() < 1e-8) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Matrix4().makeBasis(x, y, z);
}

export class Anne {
  static async load(base) {
    const r = await fetch(`${base}/anne.json`).catch(() => null);
    if (!r || !r.ok) return null;
    const [data, bin] = await Promise.all([r.json(), fetch(`${base}/anne.bin`).then((b) => b.arrayBuffer())]);
    return new Anne(base, data, bin);
  }

  constructor(base, data, bin) {
    this.data = data;
    const n = data.points;
    this.rest = new Float32Array(bin, data.pointsOffset, n * 3);
    this.link = new Uint8Array(bin, data.pointsOffset + n * 12, n);
    this.points = new Float32Array(this.rest);          // rest points with the current hand shape
    this.posed = new Float32Array(n * 3);
    this.substitute = -1;

    // One geometry, a group per surface.
    const health = data.health;
    // Modesty (owner's rule): her torso is never drawn — no chest, shirt or chest
    // tattoo, only the arms and hands. Health stays on the HUD.
    const TORSO = /chest|shirt|health|leftarm/i;   // the left upper arm is part of the torso piece
    const drawn = data.parts.filter((p) => !TORSO.test(p.name || '') &&
      (!health || p.surface < health.surface || p.surface > health.surface + health.frames.length - 1));
    const total = drawn.reduce((s, p) => s + p.count, 0);
    const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), uv = new Float32Array(total * 2);
    this.cornerPoint = new Uint16Array(total);
    this.restNormal = new Float32Array(total * 3);
    const geo = new THREE.BufferGeometry();
    const materials = [];
    const loader = new THREE.TextureLoader();
    const tex = (id) => {
      const t = loader.load(textureUrl(base, id));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    let at = 0;
    for (const p of drawn) {
      const c = p.count;
      normal.set(new Float32Array(bin, p.offset + c * 12, c * 3), at * 3);
      uv.set(new Float32Array(bin, p.offset + c * 24, c * 2), at * 2);
      this.cornerPoint.set(new Uint16Array(bin, p.offset + c * 32, c), at);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      if (p.texture) mat.map = tex(p.texture);
      else if (p.colour) mat.color.setRGB(p.colour[0] / 255, p.colour[1] / 255, p.colour[2] / 255);
      geo.addGroup(at, c, materials.length);
      materials.push(frontLayer(mat));
      at += c;
    }
    this.restNormal.set(normal);
    this.posAttr = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('normal', this.nrmAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mesh = new THREE.Mesh(geo, materials);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;

    // Joints: rest placements, and their inverses for skinning.
    this.restJoint = data.joints.map((j) => mat3ToMatrix4(j.rot, j.pos));
    this.invRest = this.restJoint.map((m) => m.clone().invert());
    this.pose = this.restJoint.map((m) => m.clone());
    this.skin = this.restJoint.map(() => new THREE.Matrix4());
    const jp = (i) => new THREE.Vector3(...data.joints[i].pos);
    this.shoulder = jp(10);
    this.upperLen = jp(11).distanceTo(jp(10));
    this.foreLen = jp(12).distanceTo(jp(11));
    this.wristToKnuckle = jp(13).sub(jp(12));           // in the hand's rest frame (identity rotation)
    this.wristToPalm = new THREE.Vector3(...data.wristToPalm);

    // body: the frame everything is posed in; the camera carries `root`.
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;               // game axes (z up) to camera axes (y up)
    this.body = new THREE.Group();
    this.body.matrixAutoUpdate = false;
    this.root.add(this.body);
    this.body.add(this.mesh);
    this.held = new THREE.Group();                     // the gun, placed in the body frame
    this.held.matrixAutoUpdate = false;
    this.body.add(this.held);

    this.head = new THREE.Vector3(...data.headOffset);
    this.neck = new THREE.Vector3(...data.neckOffset);
  }

  // The magnets for a held object, by its name without the -NN suffix.
  gripFor(name) {
    const g = this.data.grips[name.replace(/-\d+$/, '')];
    return g && g.grip && g.hold ? g : null;
  }

  // A grip for a gun that has no magnets in the level (Jungle Road's Barrett, Browning
  // and .45): made from its model bounds (model units, scaled by `scale`), assuming the
  // barrel runs along +Y and the top is +Z as on every gun that does have magnets. The
  // palm takes the pistol grip a third of the way from the back, below the middle; the
  // sight (hold) runs along the top, 0.7 m (rifles) or 0.9 m (pistols) behind the grip.
  genericGrip(box, scale) {
    const min = box.min.clone().multiplyScalar(scale), max = box.max.clone().multiplyScalar(scale);
    const size = max.clone().sub(min), cx = (min.x + max.x) / 2;
    const pistol = size.y < 0.45;
    const gy = min.y + size.y * (pistol ? 0.3 : 0.35);
    return {
      grip: { pos: [cx, gy, min.z + size.z * (pistol ? 0.3 : 0.35)], rot: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
              substitute: this.poseIndex(pistol ? 'Anne_Gun1' : 'Anne_Barrett') },
      hold: { pos: [cx, gy - (pistol ? 0.9 : 0.7), max.z], rot: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
    };
  }

  // Shade: the arm is drawn outside the shadow maps, so test the sun from the hand and
  // darken it when scenery is in the way (towards the sky and ground light alone).
  updateShade(dt, collider, world, scene) {
    this.shadeT = (this.shadeT || 0) - dt;
    if (this.shadeT <= 0 && collider?.boundsTree) {
      this.shadeT = 0.15;
      const sun = scene.getObjectsByProperty('isDirectionalLight', true)[0];
      if (sun) {
        const to = sun.position.clone().sub(sun.target.position).normalize();          // three.js world
        const dir = to.applyQuaternion(world.quaternion.clone().invert());               // game space
        const hand = new THREE.Vector3().setFromMatrixPosition(this.pose[12]);
        this.body.updateWorldMatrix(true, false);
        const p = world.worldToLocal(this.body.localToWorld(hand));
        const hit = collider.boundsTree.raycastFirst(new THREE.Ray(p.addScaledVector(dir, 0.05), dir), THREE.DoubleSide, 0, 300);
        this.shadeWant = hit ? SHADOW_LEVEL : 1;
      }
    }
    const want = this.shadeWant ?? 1;
    this.shade = THREE.MathUtils.lerp(this.shade ?? 1, want, Math.min(1, dt * 5));
    const tint = (m) => {
      if (!m?.color) return;
      m.userData.baseColor ??= m.color.clone();
      m.color.copy(m.userData.baseColor).multiplyScalar(this.shade);
    };
    this.mesh.material.forEach(tint);
    this.held.traverse((o) => tint(o.material));
  }

  // A hand shape by name (Anne_Natural, Anne_Rock ...); 0 is her own open hand.
  poseIndex(name) {
    return Math.max(0, this.data.poses.findIndex((p) => p.name === name));
  }

  // Where her palm goes on an object she carries (game space): its hand-pickup magnet
  // if it has one, else on top of it with the fingers pointing away from her.
  reachFor(name, objMatrix, radius) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    objMatrix.decompose(pos, q, sc);
    const g = this.data.grips[name.replace(/-\d+$/, '')]?.grip;
    if (g) {
      const obj = new THREE.Matrix4().makeRotationFromQuaternion(q).setPosition(pos);
      const m = obj.multiply(mat3ToMatrix4(g.rot, g.pos));
      return { palm: new THREE.Vector3().setFromMatrixPosition(m), rot: m.setPosition(0, 0, 0), sub: g.substitute || this.poseIndex('Anne_Rock') };
    }
    return { palm: pos.add(new THREE.Vector3(0, 0, Math.min(radius, 0.4) * 0.6)), rot: null, sub: this.poseIndex('Anne_Rock') };
  }

  setSubstitute(i) {
    if (i === this.substitute) return;
    this.substitute = i;
    this.points.set(this.rest);
    const pose = this.data.poses[i];
    if (pose) for (const [k, p] of Object.entries(pose.points)) this.points.set(p, k * 3);
  }

  // dt: seconds since the last frame. player: { pos, yaw, pitch } (game space; the eye is
  // EYE_HEIGHT above pos). holding: a gun's magnets { grip, hold, scale }, or null.
  // reach: where the player puts her hand, overriding the gun-sighting pose:
  // { palm (game-space Vector3), viewRot (Quaternion in her view frame) or rot (game-space
  // Matrix4/Quaternion) or neither, stow (true: arm down, gun out of view) }, or null.
  update(dt, player, holding, recoil = 0, reach = null) {
    const pitch = player.pitch;
    // Eye in the body frame: the head turns about the neck.
    const eyeRot = new THREE.Matrix4().makeRotationX(pitch);
    const eye = this.head.clone().sub(this.neck).applyMatrix4(eyeRot).add(this.neck);
    const eyeM = eyeRot.clone().setPosition(eye);
    this.body.matrix.copy(eyeM).invert();
    this.body.matrixWorldNeedsUpdate = true;

    const P = this.pose;
    // Hanging at her side, hand turned in.
    let wrist = this.shoulder.clone().add(new THREE.Vector3(0.06, 0.1, -(this.upperLen + this.foreLen) * 0.98));
    let handRot = new THREE.Matrix4().makeRotationX(-Math.PI / 2 - 0.1).premultiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
    // She raises the arm when she takes something or reaches out, and lowers it when she
    // lets go or stows what she holds.
    const stowed = !!(reach && reach.stow);
    const up = !stowed && (holding || (reach && reach.palm));
    this.raise = THREE.MathUtils.clamp((this.raise || 0) + (up ? dt : -dt) * RAISE_RATE, 0, 1);
    const handToGun = new THREE.Matrix4();
    if (holding) {
      // The gun relative to the hand: its grip in the palm.
      const gripRot = mat3ToMatrix4(holding.grip.rot);
      const wristG = new THREE.Vector3(...holding.grip.pos).sub(this.wristToPalm.clone().applyMatrix4(gripRot));
      handToGun.copy(gripRot).setPosition(wristG).invert().scale(tmpV.setScalar(holding.scale));
    }
    if (stowed) {
      // Stowed: the arm goes down and stays there (keeping whatever pose it had to ease from).
    } else if (reach && reach.palm) {
      // The hand goes where the player puts it: palm at a game-space point, wrist turned by
      // a rotation in her view frame (x right, y ahead, z up of the view), or given in game
      // space, or by default fingers pointing away from her, palm down.
      const unYaw = new THREE.Matrix4().makeRotationZ(-player.yaw);
      const palm = reach.palm.clone().sub(tmpV.set(player.pos.x, player.pos.y, player.pos.z + EYE_HEIGHT - (player.crouch || 0))).applyMatrix4(unYaw).add(eye);
      let rot;
      if (reach.viewRot) {
        rot = new THREE.Matrix4().makeRotationFromQuaternion(reach.viewRot).premultiply(eyeRot);
        // Holding a gun, the wrist turns from the sighting grip (the gun pointing ahead).
        if (holding) rot.multiply(mat3ToMatrix4(holding.hold.rot).invert().multiply(mat3ToMatrix4(holding.grip.rot)));
      } else if (reach.rot) {
        rot = reach.rot.isQuaternion ? new THREE.Matrix4().makeRotationFromQuaternion(reach.rot) : new THREE.Matrix4().extractRotation(reach.rot);
        rot.premultiply(unYaw);
      } else {
        rot = boneBasis(palm.clone().sub(this.shoulder), new THREE.Vector3(0, 0, 1));
      }
      this.lastAim = { wrist: palm.sub(this.wristToPalm.clone().applyMatrix4(rot)), rot };
    } else if (holding) {
      const { grip, hold } = holding;
      // Hand request space: the view direction, within the arm's limits, kicked up by recoil.
      const aim = THREE.MathUtils.clamp(pitch, AIM_PITCH_MIN, AIM_PITCH_MAX) + recoil * 0.22;
      const req = new THREE.Matrix4().makeRotationX(aim);
      const holdRot = mat3ToMatrix4(hold.rot);
      const gunRot = req.clone().multiply(holdRot.clone().invert());
      const gripRot = mat3ToMatrix4(grip.rot);
      const aimRot = gunRot.clone().multiply(gripRot);
      // Gun-frame points: the sight point (the palm projected onto the barrel line through
      // the hold magnet) and the wrist.
      const sightG = new THREE.Vector3(hold.pos[0], grip.pos[1], hold.pos[2]);
      const wristG = new THREE.Vector3(...grip.pos).sub(this.wristToPalm.clone().applyMatrix4(gripRot));
      const c = wristG.clone().sub(sightG).applyMatrix4(gunRot);
      // Sight point on the line of sight at distance t, with the wrist at arm's reach:
      // |eye + c - shoulder + t f| = reach.
      const f = new THREE.Vector3(0, 1, 0).applyMatrix4(req);
      const e = eye.clone().add(c).sub(this.shoulder);
      const len = (this.upperLen + this.foreLen) * ARM_REACH;
      const b = e.dot(f), cc = e.lengthSq() - len * len;
      const t = -b + Math.sqrt(Math.max(0, b * b - cc)) - recoil * 0.07;
      this.lastAim = { wrist: eye.clone().addScaledVector(f, t).add(c), rot: aimRot };
    }
    if (this.lastAim && this.raise > 0) {
      // Ease between hanging and the raised pose (lowering again after letting go).
      const k = this.raise * this.raise * (3 - 2 * this.raise);
      wrist.lerp(this.lastAim.wrist, k);
      handRot = new THREE.Matrix4().makeRotationFromQuaternion(
        new THREE.Quaternion().setFromRotationMatrix(handRot).slerp(tmpQ.setFromRotationMatrix(this.lastAim.rot), k));
    }
    // A stowed gun goes out of view once the arm is down.
    this.held.visible = !!holding && !(stowed && this.raise < 0.25);

    // Two-bone reach: the elbow bends out to the right and down.
    const S = this.shoulder;
    const toW = wrist.clone().sub(S);
    const d = Math.min(toW.length(), this.upperLen + this.foreLen - 1e-4);
    const dir = toW.clone().normalize();
    const a = (this.upperLen * this.upperLen - this.foreLen * this.foreLen + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.upperLen * this.upperLen - a * a));
    const pole = new THREE.Vector3(1, -0.2, -1).addScaledVector(dir, -new THREE.Vector3(1, -0.2, -1).dot(dir)).normalize();
    const elbow = S.clone().addScaledVector(dir, a).addScaledVector(pole, h);
    wrist = S.clone().addScaledVector(dir, d);

    const handUp = new THREE.Vector3(0, 0, 1).applyMatrix4(handRot);
    const upper = boneBasis(elbow.clone().sub(S), new THREE.Vector3(0, 0, 1));
    const upperUp = new THREE.Vector3(0, 0, 1).applyMatrix4(upper);
    // The forearm takes half the wrist's roll.
    const fore = boneBasis(wrist.clone().sub(elbow), upperUp.clone().add(handUp).normalize());
    // The hand keeps its orientation but must stay on the forearm's end.
    P[10].copy(upper).setPosition(S);
    P[11].copy(fore).setPosition(elbow);
    P[21].copy(P[11]);
    P[12].copy(handRot).setPosition(wrist);
    P[13].copy(handRot).setPosition(this.wristToKnuckle.clone().applyMatrix4(handRot).add(wrist));
    // The wrist's own points turn part way from the forearm to the hand.
    P[20].makeRotationFromQuaternion(tmpQ.setFromRotationMatrix(fore).slerp(new THREE.Quaternion().setFromRotationMatrix(handRot), this.data.joints[20].rotRatio ?? 0.7)).setPosition(wrist);
    if (holding) {
      this.held.matrix.multiplyMatrices(P[12], handToGun);
      this.held.matrixWorldNeedsUpdate = true;
    }

    // Skin: every point rides its joint rigidly.
    for (let j = 0; j < P.length; j++) this.skin[j].multiplyMatrices(P[j], this.invRest[j]);
    const n = this.data.points, pts = this.points, out = this.posed, link = this.link;
    for (let i = 0; i < n; i++) {
      tmpV.fromArray(pts, i * 3).applyMatrix4(this.skin[link[i]]).toArray(out, i * 3);
    }
    const pos = this.posAttr.array, nrm = this.nrmAttr.array, rn = this.restNormal, cp = this.cornerPoint;
    const m3 = new THREE.Matrix3();
    let lastJ = -1;
    for (let k = 0; k < cp.length; k++) {
      const p = cp[k];
      pos[k * 3] = out[p * 3]; pos[k * 3 + 1] = out[p * 3 + 1]; pos[k * 3 + 2] = out[p * 3 + 2];
      const j = link[p];
      if (j !== lastJ) { m3.setFromMatrix4(this.skin[j]); lastJ = j; }
      tmpV.set(rn[k * 3], rn[k * 3 + 1], rn[k * 3 + 2]).applyMatrix3(m3).toArray(nrm, k * 3);
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }
}
