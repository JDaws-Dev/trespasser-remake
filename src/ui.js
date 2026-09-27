// The HUD drawn in the DOM over the 3D view (health / weapon / hint readout, damage
// feedback: red flash, shake, low-health heartbeat) and the pause state the game and
// input read. Menus, pause screen, death and the loader are the original front end
// (frontend.js); this hands it the game once the level is ready.
import { front, LEVELS } from './frontend.js';

export { LEVELS };
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

    $('btn-pause')?.addEventListener('touchstart', (e) => { e.preventDefault(); this.pause(); }, { passive: false });

    // Esc releases pointer lock (the browser swallows the key), so losing the lock
    // is what pauses on desktop; the front end handles the key itself when unlocked.
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && state.started && !game.dead) this.pause();
    });
    front.attach(this, game);
  }

  get paused() { return state.paused; }

  resume() {
    const first = !state.started;
    state.started = true;
    state.paused = false;
    document.body.classList.add('playing');
    // The opening hint would have run out behind the menus: give it its time now.
    if (first && this.game.hint) this.game.hintUntil = performance.now() + 6000;
    if (!this.touch && this.canvas) {
      // Refused right after Esc (browsers enforce a short wait); a click on the view retries.
      try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (e) { /* not allowed here */ }
    }
  }

  pause() {
    if (state.paused || !state.started) return;
    state.paused = true;
    document.body.classList.remove('playing');
    front.pauseMenu();
  }

  died() {
    state.paused = true;
    document.body.classList.remove('playing');
    document.body.classList.add('dead');
    if (document.pointerLockElement) document.exitPointerLock();
    this.flash(1);
    front.died();
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
    // What she has in hand, for the touch layout (THROW / STOW show only when they apply).
    const ph = this.game.physics;
    const hand = ph?.hand;
    const handKey = `${!!(hand?.holding || ph?.held)}${!!gun}${!!hand?.stowed}`;
    if (s.handState !== handKey) {
      s.handState = handKey;
      const b = document.body.classList;
      b.toggle('holding', !!(hand?.holding || ph?.held));
      b.toggle('armed', !!gun);
      b.toggle('stowed', !!hand?.stowed);
    }
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
