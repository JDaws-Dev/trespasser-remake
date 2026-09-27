// Controls for Anne's physical hand (physics.js), with the original's default bindings
// (the key map in controls.js):
//   hold left mouse    Move Hand: the mouse moves her hand instead of the view
//   right mouse        Grab / Drop (input.js: `pickup`)
//   Space              Use / fire (input.js: `fire`)
//   Shift + mouse      Rotate Wrist (yaw, pitch); Alt + mouse rolls it (Rotate Arm; the
//                      original's Ctrl); Shift+Alt resets it
//   F                  Throw          E  Stow / Retrieve          Z  Crouch (held)
//   wheel              reach in / out
// On touch, buttons made here: HAND (toggle: the right stick moves the hand), ROTATE
// (hold: the right stick turns the wrist), THROW, STOW, CROUCH (toggle). GRAB and FIRE
// grab / let go while the hand is up.
// In the modern style (modernhand.js, the default) the left button is look-and-click
// instead, the wheel and right button turn what she holds, and touch taps on the view.
import * as THREE from 'three';
import { has, codesFor } from './controls.js';

export class HandControls {
  constructor({ canvas, physics, input, touch, camera, world }) {
    Object.assign(this, { canvas, physics, input, touch, camera, world });
    this.wheel = 0;
    this.prevHand = false;
    this.keys = input.keys;   // the same held keys Input reads (and its test hook injects)
    this.touchHand = false;
    this.touchRotate = false;
    this.touchCrouch = false;
    const locked = () => document.pointerLockElement === canvas;
    const playing = () => document.body.classList.contains('playing');

    addEventListener('wheel', (e) => {
      if (!locked()) return;
      if (physics.handStyle === 'modern') this.wheel += -Math.sign(e.deltaY);
      else if (physics.hand.aiming) physics.handReach(-Math.sign(e.deltaY) * 0.05);
    }, { passive: true });
    // Throw and Stow act on the press.
    addEventListener('keydown', (e) => {
      if (!playing() || e.repeat) return;
      if (codesFor('throw').includes(e.code)) physics.handThrow(physics.player);
      if (codesFor('stow').includes(e.code)) physics.stow();
    });

    // While the mouse turns the wrist or the arm, say so.
    const tag = document.createElement('div');
    tag.id = 'handmode';
    tag.style.cssText = 'position:fixed;left:50%;top:58%;transform:translateX(-50%);padding:3px 10px;border-radius:10px;' +
      'background:rgba(0,0,0,.45);color:#ffd88a;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.12em;pointer-events:none;display:none;z-index:20';
    document.body.append(tag);
    this.tag = tag;
    // The modern hand's hint (what a click does to the thing under the crosshair).
    const hint = document.createElement('div');
    hint.id = 'handhint';
    hint.style.cssText = 'position:fixed;left:50%;top:calc(50% + 22px);transform:translateX(-50%);padding:2px 9px;border-radius:9px;' +
      'background:rgba(0,0,0,.4);color:#f4ead2;font:500 12px/1.4 system-ui,sans-serif;letter-spacing:.06em;pointer-events:none;display:none;z-index:20';
    document.body.append(hint);
    this.hintEl = hint;
    if (touch) this.touchView();

    if (touch) this.buttons();
  }

  buttons() {
    // Placement and look live with the rest of the touch layout (index.html, #handpad).
    const pad = document.createElement('div');
    pad.id = 'handpad';
    const make = (label, down, up, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(b); }, { passive: false });
      if (up) {
        const off = (e) => { e.preventDefault(); up(b); };
        b.addEventListener('touchend', off); b.addEventListener('touchcancel', off);
      }
      pad.append(b);
      return b;
    };
    const ph = this.physics;
    make('HAND', (b) => { this.touchHand = !this.touchHand; b.classList.toggle('on', this.touchHand); }, null, 'classic');
    make('ROTATE', (b) => { this.touchRotate = true; b.classList.add('on'); }, (b) => { this.touchRotate = false; b.classList.remove('on'); }, 'classic');
    make('THROW', () => ph.handThrow(ph.player), null, 'throw');
    make('STOW', (b) => { b.classList.toggle('on', ph.stow()); }, null, 'stow');
    make('CROUCH', (b) => { this.touchCrouch = !this.touchCrouch; b.classList.toggle('on', this.touchCrouch); }, null, 'crouch');
    document.body.append(pad);
  }

  // Touch, modern hand: tap the view to act on what is there (or drop what she holds);
  // one finger dragging while she holds something moves it; two fingers twisting turn it.
  touchView() {
    const c = this.canvas, ph = this.physics;
    let start = null, twist = null;
    const angle = (ts) => Math.atan2(ts[1].clientY - ts[0].clientY, ts[1].clientX - ts[0].clientX);
    c.addEventListener('touchstart', (e) => {
      if (ph.handStyle !== 'modern') return;
      if (e.touches.length === 2) { twist = angle(e.touches); start = null; return; }
      const t = e.changedTouches[0];
      start = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, time: performance.now(), id: t.identifier, dragging: false };
      // Held still for a moment on a door, gate, lever or heavy thing: grab it there.
      const s0 = start;
      setTimeout(() => {
        if (start !== s0 || ph.held || Math.hypot(s0.lx - s0.x, s0.ly - s0.y) > 12) return;
        const ray = this.rayAt(s0.x, s0.y);
        if (ph.modern?.touchGrab(ray.o, ray.d)) s0.dragging = true;
      }, 220);
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (ph.handStyle !== 'modern') return;
      if (twist !== null && e.touches.length === 2) { const a = angle(e.touches); ph.modern?.twist(a - twist); twist = a; return; }
      const t = [...e.changedTouches].find((t) => start && t.identifier === start.id);
      if (!t) return;
      if (start.dragging) ph.modern?.touchDrag(t.clientX - start.lx, t.clientY - start.ly, ph.player);
      else if (ph.held) ph.modern?.nudge((t.clientX - start.lx) * 0.004, -(t.clientY - start.ly) * 0.004);
      start.lx = t.clientX; start.ly = t.clientY;
    }, { passive: true });
    c.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) twist = null;
      if (ph.handStyle !== 'modern' || !start) return;
      const t = [...e.changedTouches].find((t) => t.identifier === start.id);
      if (!t) return;
      const moved = Math.hypot(t.clientX - start.x, t.clientY - start.y), quick = performance.now() - start.time < 350;
      const dragging = start.dragging;
      start = null;
      if (dragging) { ph.modern?.touchRelease(); return; }
      if (moved < 12 && quick) this.tapAt(t.clientX, t.clientY);
    });
  }

  // The game-space ray through a point on the screen.
  rayAt(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.world.updateMatrixWorld();
    const o = this.world.worldToLocal(ray.ray.origin.clone());
    const d = this.world.worldToLocal(ray.ray.origin.clone().add(ray.ray.direction)).sub(o).normalize();
    return { o, d };
  }

  tapAt(x, y) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.world.updateMatrixWorld();
    const o = this.world.worldToLocal(ray.ray.origin.clone());
    const d = this.world.worldToLocal(ray.ray.origin.clone().add(ray.ray.direction)).sub(o).normalize();
    return this.physics.modern?.tap(o, d, this.physics.player);
  }

  // This frame's hand state: whether the hand is raised (the hand key, or HAND on
  // touch), and the wrist / arm / crouch modifiers (keys held in Input).
  poll(move) {
    const k = this.keys;
    const wrist = has(k, 'wrist') || this.touchRotate, arm = has(k, 'arm');
    const hand = !!move.hand || this.touchHand;
    const r = { hand, rotate: wrist || arm, roll: arm && !wrist, reset: wrist && arm, crouch: has(k, 'crouch') || this.touchCrouch,
                click: !!move.hand && !this.prevHand, rmb: has(k, 'grab'), wheel: this.wheel };
    this.prevHand = !!move.hand;
    this.wheel = 0;
    const hintText = this.physics.handStyle === 'modern' ? this.physics.modern?.hint || '' : '';
    if (hintText !== this.hintShown) { this.hintShown = hintText; this.hintEl.textContent = hintText; this.hintEl.style.display = hintText ? 'block' : 'none'; }
    const modern = this.physics.handStyle === 'modern';
    const label = modern ? (r.rmb && this.physics.held ? 'ROTATE' : '')
      : hand && r.rotate ? (r.reset ? 'RESET WRIST' : r.roll ? 'ARM' : 'WRIST') : '';
    if (label !== this.label) { this.label = label; this.tag.textContent = label; this.tag.style.display = label ? 'block' : 'none'; }
    return r;
  }
}
