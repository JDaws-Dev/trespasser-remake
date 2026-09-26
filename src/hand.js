// Controls for Anne's physical hand (physics.js), after the original's bindings
// (Lib/Sys/RegInit.cpp: hand, grab, Shift = rotate wrist, Ctrl = rotate arm, throw,
// stow, crouch), mapped to this remake's scheme:
//   hold right mouse   raise the hand: the mouse moves it instead of the view
//   left click         (hand up) grab / let go; a quick flick as you let go throws
//   wheel              reach in / out
//   Shift + mouse      turn the wrist; Ctrl + mouse rolls it; Shift+Ctrl resets it
//   Q                  throw what she holds
//   R                  stow / retrieve the gun
//   C (or Z)           crouch while held
// On touch, buttons made here: HAND (toggle: the right stick moves the hand), ROTATE
// (hold: the right stick turns the wrist), THROW, STOW, CROUCH (toggle). GRAB and FIRE
// grab / let go while the hand is up.
export class HandControls {
  constructor({ canvas, physics, touch }) {
    Object.assign(this, { canvas, physics, touch });
    this.keys = new Set();
    this.touchRotate = false;
    this.touchCrouch = false;
    const locked = () => document.pointerLockElement === canvas;
    const playing = () => document.body.classList.contains('playing');

    addEventListener('mousedown', (e) => { if (e.button === 2 && locked()) physics.setArm(true); });
    addEventListener('mouseup', (e) => { if (e.button === 2) physics.setArm(false); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (locked() && physics.hand.aiming) physics.handReach(-Math.sign(e.deltaY) * 0.05); }, { passive: true });
    addEventListener('keydown', (e) => {
      if (!playing()) return;
      if (!this.keys.has(e.code)) {
        if (e.code === 'KeyQ') physics.handThrow(physics.player);
        if (e.code === 'KeyR') physics.stow();
      }
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); physics.setArm(false); });
    document.addEventListener('pointerlockchange', () => { if (!locked()) physics.setArm(false); });

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
    make('HAND', (b) => { ph.setArm(!ph.hand.aiming); b.classList.toggle('on', ph.hand.aiming); });
    make('ROTATE', (b) => { this.touchRotate = true; b.classList.add('on'); }, (b) => { this.touchRotate = false; b.classList.remove('on'); });
    make('THROW', () => ph.handThrow(ph.player));
    make('STOW', (b) => { b.classList.toggle('on', ph.stow()); });
    make('CROUCH', (b) => { this.touchCrouch = !this.touchCrouch; b.classList.toggle('on', this.touchCrouch); });
    document.body.append(pad);
  }

  // Modifiers for this frame.
  poll() {
    const k = this.keys;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight') || this.touchRotate;
    const ctrl = k.has('ControlLeft') || k.has('ControlRight');
    return { rotate: shift || ctrl, roll: ctrl && !shift, reset: shift && ctrl, crouch: k.has('KeyC') || k.has('KeyZ') || this.touchCrouch };
  }
}
