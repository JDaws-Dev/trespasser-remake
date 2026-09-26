// Sound: the original samples (exported by tools/export_sounds.py), played through
// WebAudio. Positional sounds sit in game coordinates; the listener follows the
// camera. Browsers only allow audio after a user gesture, so the context is
// created lazily and resumed on the first input.
import * as THREE from 'three';

export class Audio {
  constructor(base) {
    this.base = base;
    this.ctx = null;
    this.buffers = new Map();
    this.index = { samples: {}, vocals: {} };
    this.ready = fetch(`${base}/sfx.json`).then((r) => (r.ok ? r.json() : this.index)).then((j) => (this.index = j)).catch(() => {});
    const unlock = () => {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, unlock, { passive: true });
  }

  async buffer(name) {
    const entry = this.index.samples[name];
    if (!entry || !this.ctx) return null;
    if (!this.buffers.has(name)) {
      const p = fetch(`${this.base}/${entry.file}`).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null);
      this.buffers.set(name, p);
    }
    return this.buffers.get(name);
  }

  // Play a sample by name; `pos` (game coordinates) makes it positional.
  async play(name, { pos = null, volume = 1, loop = false, playbackRate = 1 } = {}) {
    if (!this.ctx) return null;
    const buf = await this.buffer(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = playbackRate;
    const gain = this.ctx.createGain();
    // The pack's per-sample master volume is in dB (0 = as recorded).
    gain.gain.value = volume * Math.pow(10, (this.index.samples[name]?.volume || 0) / 20);
    src.connect(gain);
    if (pos) {
      const pan = this.ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.maxDistance = 400;
      pan.rolloffFactor = 1;
      const w = this.toListenerSpace(pos);
      pan.positionX.value = w.x; pan.positionY.value = w.y; pan.positionZ.value = w.z;
      gain.connect(pan);
      pan.connect(this.master);
      src.pan = pan;
    } else {
      gain.connect(this.master);
    }
    src.start();
    return src;
  }

  // A sound effect with the original's transfer applied: `gain` linear, `rate` the
  // pitch multiplier, `refDistance` from the collision's dB-per-metre roll-off. The
  // pack's per-sample master volume is in dB. Returns { src, gain, pan } (or null)
  // so looping scrapes can be moved and faded.
  async playFx(name, { pos = null, gain = 1, rate = 1, refDistance = 4, loop = false } = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return null;
    const buf = await this.buffer(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain * Math.pow(10, (this.index.samples[name]?.volume || 0) / 20);
    src.connect(g);
    let pan = null;
    if (pos) {
      pan = this.ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = refDistance;
      pan.maxDistance = 400;
      pan.rolloffFactor = 1;
      const w = this.toListenerSpace(pos);
      pan.positionX.value = w.x; pan.positionY.value = w.y; pan.positionZ.value = w.z;
      g.connect(pan);
      pan.connect(this.master);
    } else {
      g.connect(this.master);
    }
    src.start();
    return { src, gain: g, pan, duration: buf.duration / rate };
  }

  // One of a dinosaur's vocal variants ("Raptor", "Attack"), at its position.
  vocal(dino, action, pos, volume = 1) {
    const names = this.index.vocals[dino]?.[action];
    if (!names || !names.length) return null;
    return this.play(names[Math.floor(Math.random() * names.length)], { pos, volume });
  }

  // Game coordinates (Z up) to WebAudio's (Y up, right-handed like three.js).
  toListenerSpace(p) {
    return new THREE.Vector3(p.x, p.z, -p.y);
  }

  // Call each frame with the camera's game-space position and facing.
  updateListener(pos, forward, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = this.toListenerSpace(pos), f = this.toListenerSpace(forward), u = this.toListenerSpace(up);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t); l.forwardY.setValueAtTime(f.y, t); l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t); l.upY.setValueAtTime(u.y, t); l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }
}
