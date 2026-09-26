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
import { has, codesFor } from './controls.js';

export class HandControls {
  constructor({ canvas, physics, input, touch }) {
    Object.assign(this, { canvas, physics, input, touch });
    this.keys = input.keys;   // the same held keys Input reads (and its test hook injects)
    this.touchHand = false;
    this.touchRotate = false;
    this.touchCrouch = false;
    const locked = () => document.pointerLockElement === canvas;
    const playing = () => document.body.classList.contains('playing');

    addEventListener('wheel', (e) => { if (locked() && physics.hand.aiming) physics.handReach(-Math.sign(e.deltaY) * 0.05); }, { passive: true });
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

    if (touch) this.buttons();
  }

  buttons() {
    const style = document.createElement('style');
    style.textContent = `
      #handpad { position: fixed; right: 12px; top: 22%; display: none; flex-direction: column; gap: 8px; z-index: 20; }
      body.touch.playing #handpad { display: flex; }
      #handpad button { width: 64px; height: 40px; border-radius: 20px; border: 1px solid rgba(255,255,255,.45);
        background: rgba(0,0,0,.35); color: #fff; font: 600 11px/1 system-ui, sans-serif; letter-spacing: .06em;
        -webkit-user-select: none; user-select: none; touch-action: none; }
      #handpad button.on { background: rgba(255,210,120,.55); color: #000; }`;
    document.head.append(style);
    const pad = document.createElement('div');
    pad.id = 'handpad';
    const make = (label, down, up) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(b); }, { passive: false });
      if (up) {
        const off = (e) => { e.preventDefault(); up(b); };
        b.addEventListener('touchend', off); b.addEventListener('touchcancel', off);
      }
      pad.append(b);
      return b;
    };
    const ph = this.physics;
    make('HAND', (b) => { this.touchHand = !this.touchHand; b.classList.toggle('on', this.touchHand); });
    make('ROTATE', (b) => { this.touchRotate = true; b.classList.add('on'); }, (b) => { this.touchRotate = false; b.classList.remove('on'); });
    make('THROW', () => ph.handThrow(ph.player));
    make('STOW', (b) => { b.classList.toggle('on', ph.stow()); });
    make('CROUCH', (b) => { this.touchCrouch = !this.touchCrouch; b.classList.toggle('on', this.touchCrouch); });
    document.body.append(pad);
  }

  // This frame's hand state: whether the hand is raised (the hand key, or HAND on
  // touch), and the wrist / arm / crouch modifiers (keys held in Input).
  poll(move) {
    const k = this.keys;
    const wrist = has(k, 'wrist') || this.touchRotate, arm = has(k, 'arm');
    const hand = !!move.hand || this.touchHand;
    const r = { hand, rotate: wrist || arm, roll: arm && !wrist, reset: wrist && arm, crouch: has(k, 'crouch') || this.touchCrouch };
    const label = hand && r.rotate ? (r.reset ? 'RESET WRIST' : r.roll ? 'ARM' : 'WRIST') : '';
    if (label !== this.label) { this.label = label; this.tag.textContent = label; this.tag.style.display = label ? 'block' : 'none'; }
    return r;
  }
}
