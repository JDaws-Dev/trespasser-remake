// Keyboard + mouse (pointer lock) on desktop; two touch sticks on phones.
export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.sticks = { L: { x: 0, y: 0, id: null }, R: { x: 0, y: 0, id: null } };

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('click', () => { if (!this.touch) canvas.requestPointerLock?.(); });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) { this.mouse.x += e.movementX; this.mouse.y += e.movementY; }
    });

    if (this.touch) {
      document.body.classList.add('touch');
      for (const side of ['L', 'R']) this.bindStick(side);
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
    el.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; s.id = t.identifier; update(t); e.preventDefault(); }, { passive: false });
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

    return {
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      look: { x: lookX, y: lookY },
      run: k.has('ShiftLeft') || k.has('ShiftRight') || Math.hypot(L.x, L.y) > 0.95,
      jump: k.has('Space'),
    };
  }
}
