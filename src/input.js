// Keyboard + mouse (pointer lock) on desktop; two touch sticks on phones.
import { state } from './ui.js';
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.sticks = { L: { x: 0, y: 0, id: null }, R: { x: 0, y: 0, id: null } };
    this.pressed = new Set();   // one-shot keys, cleared each poll
    this.buttons = { fire: false, grab: false, jump: false };
    window.__input = this;   // for automated tests

    addEventListener('keydown', (e) => { if (!this.keys.has(e.code)) this.pressed.add(e.code); this.keys.add(e.code); });
    addEventListener('mousedown', (e) => { if (document.pointerLockElement === canvas && e.button === 0) this.pressed.add('Fire'); });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('click', () => { if (!this.touch && !state.paused) { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (e) { /* not allowed here */ } } });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) { this.mouse.x += e.movementX; this.mouse.y += e.movementY; }
    });

    if (this.touch) {
      document.body.classList.add('touch');
      for (const side of ['L', 'R']) this.bindStick(side);
      for (const id of ['fire', 'grab', 'jump']) {
        const el = document.getElementById('btn-' + id);
        el.addEventListener('touchstart', (e) => { this.buttons[id] = true; this.pressed.add(id); e.preventDefault(); }, { passive: false });
        // Each button tracks its own finger, so lifting a stick finger never releases it.
        const off = (e) => { if (e.targetTouches.length === 0) this.buttons[id] = false; };
        el.addEventListener('touchend', off); el.addEventListener('touchcancel', off);
      }
    }
  }

  bindStick(side) {
    const el = document.getElementById('stick' + side);
    const knob = el.querySelector('i');
    const s = this.sticks[side];
    const radius = 50;
    const update = (t) => {
      const r = el.getBoundingClientRect();
      let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) { dx *= radius / len; dy *= radius / len; }
      s.x = dx / radius; s.y = dy / radius;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    // Touches stay bound to the element they started on, so each stick only ever
    // sees its own finger; a second finger on the same stick is ignored.
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (s.id !== null) return;
      const t = e.changedTouches[0]; s.id = t.identifier; update(t);
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === s.id) update(t);
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === s.id) { s.id = null; s.x = s.y = 0; knob.style.transform = ''; }
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  poll(dt) {
    const k = this.keys;
    let forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let lookX = this.mouse.x * 0.0025 + ((k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0)) * 1.8 * dt;
    let lookY = this.mouse.y * 0.0025;
    this.mouse.x = this.mouse.y = 0;

    const L = this.sticks.L, R = this.sticks.R;
    if (L.id !== null) { forward -= L.y; strafe += L.x; }
    if (R.id !== null) { lookX += R.x * 2.4 * dt; lookY += R.y * 1.8 * dt; }

    const pressed = this.pressed;
    this.pressed = new Set();
    // Behind the menu or death screen Anne stands still and nothing fires.
    if (state.paused) return { touch: this.touch, fire: false, pickup: false, drop: false, forward: 0, strafe: 0, look: { x: 0, y: 0 }, run: false, jump: false };
    return {
      touch: this.touch,
      fire: pressed.has('Fire') || pressed.has('fire') || (k.has('KeyF')) || this.buttons.fire,
      pickup: pressed.has('KeyE') || pressed.has('grab'),
      drop: pressed.has('KeyG'),
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      look: { x: lookX, y: lookY },
      run: k.has('ShiftLeft') || k.has('ShiftRight') || Math.hypot(L.x, L.y) > 0.95,
      jump: k.has('Space') || this.buttons.jump,
    };
  }
}
