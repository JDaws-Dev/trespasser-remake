// Screens and HUD drawn in the DOM over the 3D view: the start / pause overlay,
// the death overlay, damage feedback (red flash, shake, low-health heartbeat)
// and the health / weapon / hint readout.
export const LEVELS = [
  ['be', 'Beach'], ['jr', 'Jungle Road'], ['ij', 'Industrial Jungle'], ['it', 'Town'],
  ['lab', 'Lab'], ['as', 'Ascent'], ['as2', 'Ascent 2'], ['sum', 'Summit'],
];
const LOW_HP = 30;

// Shared with Input: while paused, input reads as idle so Anne stands still.
export const state = { paused: true, started: false };

const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ game, touch, level }) {
    this.game = game;
    this.touch = touch;
    this.canvas = document.querySelector('canvas');
    this.shown = {};   // last values written, so the DOM is touched only on change

    // HUD: health bar top-left, weapon top-right, hint centred beneath.
    const hud = game.hud;
    hud.textContent = '';
    hud.innerHTML = `<div id="hp"><span class="bar"><i></i></span><b></b></div>
      <div id="weapon"></div><div id="hint"></div>`;
    this.hpBar = hud.querySelector('#hp i');
    this.hpNum = hud.querySelector('#hp b');
    this.weapon = hud.querySelector('#weapon');
    this.hint = hud.querySelector('#hint');
    this.hurtEl = $('hurt');
    this.lowEl = $('lowhp');

    // Start / pause overlay.
    const params = new URLSearchParams(location.search);
    const list = $('levels');
    for (const [id, name] of LEVELS) {
      const q = new URLSearchParams(params);
      q.set('level', id);
      q.delete('at');   // a teleport spot belongs to the level it was taken in
      const a = document.createElement('a');
      a.href = '?' + q.toString();
      a.textContent = name;
      if (id === level) a.className = 'current';
      list.append(a);
    }
    $('controls').textContent = touch
      ? 'Left stick walks, right stick looks. GRAB picks up a gun, FIRE shoots, JUMP jumps.'
      : 'Mouse looks · WASD walks · Shift runs · Space jumps · E picks up · Click fires · G drops · Esc pauses';
    $('play').addEventListener('click', () => this.resume());
    $('btn-pause')?.addEventListener('touchstart', (e) => { e.preventDefault(); this.pause(); }, { passive: false });
    $('again').addEventListener('click', () => location.reload());
    $('menu').hidden = false;

    // Esc releases pointer lock (the browser swallows the key), so losing the lock
    // is what pauses on desktop; the key itself covers the unlocked case.
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && state.started && !game.dead) this.pause();
    });
    addEventListener('keydown', (e) => { if (e.code === 'Escape' && state.started && !game.dead) this.pause(); });
  }

  get paused() { return state.paused; }

  resume() {
    const first = !state.started;
    state.started = true;
    state.paused = false;
    $('menu').hidden = true;
    $('play').textContent = 'Resume';
    document.body.classList.add('playing');
    // The opening hint would have run out behind the overlay: give it its time now.
    if (first && this.game.hint) this.game.hintUntil = performance.now() + 6000;
    if (!this.touch && this.canvas) {
      // Refused right after Esc (browsers enforce a short wait); a click on the view retries.
      try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (e) { /* not allowed here */ }
    }
  }

  pause() {
    if (state.paused) return;
    state.paused = true;
    $('menu').hidden = false;
    document.body.classList.remove('playing');
  }

  died() {
    state.paused = true;
    document.body.classList.remove('playing');
    document.body.classList.add('dead');
    $('menu').hidden = true;
    $('death').hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.flash(1);
  }

  // A hit: the red edges flash and the view jolts, harder for bigger bites.
  flash(strength = 1) {
    const el = this.hurtEl;
    el.style.animation = 'none';
    void el.offsetWidth;   // restart the animation on every hit
    el.style.opacity = String(Math.min(1, 0.55 + strength * 0.45));
    el.style.animation = 'hurt .6s ease-out forwards';
    if (this.canvas) {
      this.canvas.style.animation = 'none';
      void this.canvas.offsetWidth;
      this.canvas.style.animation = 'shake .35s linear';
    }
  }

  update({ hp, maxHp, gun, hint }) {
    const s = this.shown;
    const h = Math.max(0, Math.round(hp));
    if (s.hp !== h) {
      s.hp = h;
      this.hpBar.style.width = `${(100 * h) / maxHp}%`;
      this.hpNum.textContent = h;
      const low = h > 0 && h < LOW_HP;
      this.hpBar.parentElement.parentElement.classList.toggle('low', low);
      this.lowEl.classList.toggle('on', low);
    }
    const w = gun ? `${gun.name}  <b>${gun.ammo}</b>` : '<span class="none">Unarmed</span>';
    if (s.w !== w) { s.w = w; this.weapon.innerHTML = w; }
    if (s.hint !== hint) { s.hint = hint; this.hint.textContent = hint; this.hint.classList.toggle('on', !!hint); }
  }
}
