// The original front end, rebuilt from its own art and layout files: the splash,
// the intro and new-game cutscenes, the main screen, the load / options / audio /
// video / controls dialogs, the level loader and the in-game menu. Layouts come
// from the game's .ddf files (tools/export_menu.py → public/menu/layouts.json) and
// are drawn at their 640x480 / 320x200 coordinates, scaled to fit the screen.
//
// Flow (mainwnd.cpp GameLoop): intro video → main screen. New Game plays
// newgame.smk then loads the beach. ?level=xx&play=1 (a level picked from a menu,
// or Restart) goes straight to the loader; ?menu=1 (Quit → Main Menu) straight to
// the main screen. The level itself loads behind all of this (main.js); the Game
// hands its UI over through attach() once it is ready.
const BASE = 'menu/';
const params = new URLSearchParams(location.search);
const LEVEL = params.get('level') || 'be';
const FIRST_LEVEL = 'be';
const TOUCH = matchMedia('(pointer: coarse)').matches;

export const LEVELS = [
  ['be', 'Beach'], ['jr', 'Jungle Road'], ['ij', 'Industrial Jungle'], ['it', 'Town'],
  ['lab', 'Lab'], ['as', 'Ascent'], ['as2', 'Ascent 2'], ['sum', 'Summit'],
];
// uidlgs.cpp g_aszSCNImage: the loader's picture for each scene.
const LOADER_IMAGE = { as: 'li_a1', as2: 'li_a2', be: 'li_be', ij: 'li_ij', it: 'li_it', jr: 'li_jr', lab: 'li_lab', pv: 'li_pv', sum: 'li_sum' };
// trespass.rc strings.
const IDS_RESTARTLEVEL = 'Do you wish to restart this level?';
const IDS_LOADING_LEVEL = 'Loading Level.  Please Wait.';

// Button ids per layout (uidlgs.cpp).
const ID = {
  main: { NEW: 1000, LOAD: 1001, OPTIONS: 1002, QUIT: 1003, DIRECT: 1004, LOGO: 1005 },
  ingame: { QUIT: 1000, RESUME: 1001, RESTART: 1002, SAVE: 1003, LOAD: 1004, OPTIONS: 1005 },
  options: { CONTROLS: 1000, VIDEO: 1001, AUDIO: 1002, CREDITS: 1003, CLOSE: 1004 },
  quit: { CANCEL: 1000, DESKTOP: 1001, MENU: 1002 },
  CANCEL: 1000, OK: 1001, LIST: 1002,
};

const url = (level, extra) => {
  const q = new URLSearchParams(params);
  for (const k of ['at', 'play', 'menu']) q.delete(k);
  q.set('level', level);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return '?' + q.toString();
};
const go = (level, extra) => { location.href = url(level, extra); };

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = 'trespasser.settings';
const DEFAULTS = { volume: 90, sfx: true, music: true, quality: 4, brightness: 5, screen: 9 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* private mode */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } };

// ---------------------------------------------------------------- menu sound

// Menu.tpa: a looping bed, a T-rex footstep on every button, and a distant dinosaur
// or bird at random every ten seconds (tpassglobals.cpp SetupMenuAudio).
const RANDOMS = ['DINO - TREX DIST MISC', 'DINO - TREX DIST A', 'DINO - TREX DIST B', 'DINO - RAPT DIST A', 'DINO - RAPT DIST B',
  'DINO - RAPT DIST C', 'BIRD 01', 'BIRD 02', 'BIRD 03', 'BIRD 04', 'BIRD 05', 'BIRD 06', 'BIRD 07'];

class MenuSound {
  constructor() {
    this.ctx = null;
    this.index = null;
    this.buffers = new Map();
    this.loop = null;
    this.wantLoop = false;
    this.timer = 0;
    this.ready = fetch(BASE + 'sounds.json').then((r) => r.json()).then((j) => (this.index = j)).catch(() => {});
    const unlock = () => {
      if (!this.ctx) {
        try {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          this.gain = this.ctx.createGain();
          this.gain.connect(this.ctx.destination);
          this.setVolume();
        } catch (e) { return; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.wantLoop && !this.loop) this.startLoop();
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, unlock, { passive: true, capture: true });
  }

  setVolume() { if (this.gain) this.gain.gain.value = settings.volume / 100; }

  async buffer(name) {
    await this.ready;
    const e = this.index?.[name];
    if (!e || !this.ctx) return null;
    if (!this.buffers.has(name)) {
      this.buffers.set(name, fetch(BASE + e.file).then((r) => r.arrayBuffer())
        .then((b) => new Promise((res, rej) => this.ctx.decodeAudioData(b, res, rej))).catch(() => null));
    }
    return this.buffers.get(name);
  }

  async play(name, { loop = false, volume = 1 } = {}) {
    const buf = await this.buffer(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx.createGain();
    g.gain.value = volume * (this.index[name].volume ?? 1);
    src.connect(g).connect(this.gain);
    src.start();
    return src;
  }

  button() { if (settings.sfx) this.play('DINO - TREX FOOT'); }

  // The main screen's bed starts two seconds in (IDTIMER_MAININIT) with the random calls.
  menuOn() {
    this.wantLoop = true;
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => this.startLoop(), 2000);
  }

  async startLoop() {
    if (!this.wantLoop || this.loop || !this.ctx) return;
    this.loop = 'pending';
    const src = settings.music ? await this.play('OPTIONS - MAIN LOOP', { loop: true }) : null;
    if (!this.wantLoop) { src?.stop(); this.loop = null; return; }
    this.loop = src || 'silent';
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (settings.sfx) this.play(RANDOMS[(Math.random() * RANDOMS.length) | 0], { volume: 0.8 }); }, 10000);
  }

  menuOff() {
    this.wantLoop = false;
    clearTimeout(this.startTimer);
    clearInterval(this.timer);
    if (this.loop && this.loop.stop) this.loop.stop();
    this.loop = null;
  }

  // Music switched in the audio dialog while the main screen is up.
  refresh() { if (this.wantLoop) { this.menuOff(); this.wantLoop = true; this.startLoop(); } }
}

// ---------------------------------------------------------------- layout rendering

let layouts = null;
const layoutsReady = fetch(BASE + 'layouts.json').then((r) => r.json()).then((j) => (layouts = j));

const el = (tag, cls, parent) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
};
const place = (e, x, y, w, h) => {
  e.style.left = x + 'px'; e.style.top = y + 'px';
  if (w != null) e.style.width = w + 'px';
  if (h != null) e.style.height = h + 'px';
};
const size = (e, w, h) => { e.style.width = w + 'px'; e.style.height = h + 'px'; };
const preloaded = new Set();
const preload = (src) => { if (src && !preloaded.has(src)) { preloaded.add(src); new Image().src = BASE + src; } };

// A window built from a .ddf layout. Buttons report through onButton(id); the
// rest of the controls are reachable by id for filling in.
class Win {
  constructor(name, { onButton = () => {}, backdrop = null } = {}) {
    const lay = layouts[name];
    this.name = name;
    this.onButton = onButton;
    this.ctrls = new Map();
    const [, , w, h] = lay.background.rect;
    this.w = w; this.h = h;
    this.el = el('div', 'fe-win');
    size(this.el, w, h);
    // Text-only dialogs (yes/no, message) are drawn on the generic plate.
    const bg = lay.background.image || backdrop;
    if (bg) { const i = el('img', 'fe-static', this.el); i.src = BASE + bg; place(i, 0, 0); i.draggable = false; }
    else if (!lay.controls.some((c) => c.type === 'static')) this.el.classList.add('bare');
    for (const c of lay.controls) this.add(c);
  }

  add(c) {
    const [l, t, r, b] = c.rect;
    const sized = r > 0 && b > 0;
    let e;
    switch (c.type) {
      case 'static': {
        if (!c.image) return;
        e = el('img', 'fe-static', this.el);
        e.src = BASE + c.image;
        e.draggable = false;
        place(e, l, t, sized ? r - l : null, sized ? b - t : null);
        break;
      }
      case 'button': {
        const imgs = c.images;
        imgs.forEach(preload);
        e = el(imgs[0] ? 'img' : 'div', 'fe-button', this.el);
        if (imgs[0]) { e.src = BASE + imgs[0]; e.draggable = false; }
        place(e, l, t, sized ? r - l : null, sized ? b - t : null);
        e.images = imgs;
        e.enabled = !!c.enabled;
        this.wireButton(e, c.id);
        if (!c.enabled) this.setEnabled(c.id, false, e);
        break;
      }
      case 'textbox': {
        e = el('div', 'fe-text', this.el);
        place(e, l, t, r - l, b - t);
        const f = c.flags ?? 0x11;
        e.style.fontSize = (c.size || 12) + 'px';
        e.style.justifyContent = f & 1 ? 'center' : f & 2 ? 'flex-end' : 'flex-start';
        e.style.textAlign = f & 1 ? 'center' : f & 2 ? 'right' : 'left';
        e.style.alignItems = f & 4 ? 'center' : 'flex-start';
        e.style.whiteSpace = f & 0x20 ? 'nowrap' : 'normal';
        if (c.border) e.classList.add('border');
        e.textContent = c.text || '';
        break;
      }
      case 'listbox': {
        e = el('div', 'fe-list', this.el);
        place(e, l, t, r - l, b - t);
        e.rows = el('div', 'rows', e);
        const up = el('img', 'arrow up', e), dn = el('img', 'arrow dn', e);
        up.src = BASE + 'sarrow_up_0.png'; dn.src = BASE + 'sarrow_dn_0.png';
        up.draggable = dn.draggable = false;
        const step = (d) => (ev) => { ev.preventDefault(); this.sound(); e.rows.scrollBy({ top: d * 16 }); };
        up.addEventListener('pointerdown', step(-1)); dn.addEventListener('pointerdown', step(1));
        break;
      }
      case 'checkbox': {
        e = el('img', 'fe-check', this.el);
        e.draggable = false;
        place(e, l, t);
        e.images = c.images;
        c.images.forEach(preload);
        e.checked = false;
        e.enabled = true;
        e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); this.toggle(c.id); });
        this.paintCheck(e);
        break;
      }
      case 'hotspot': {
        // The label beside a checkbox toggles it too.
        e = el('div', 'fe-hot', this.el);
        place(e, l, t, r - l, b - t);
        e.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          for (const [id, x] of this.ctrls) if (x.classList?.contains('fe-check') && Math.abs(parseFloat(x.style.top) - t) < 8) this.toggle(id);
        });
        break;
      }
      case 'slider': {
        e = el('div', 'fe-slider', this.el);
        place(e, l, t, r - l, b - t);
        e.units = c.units;
        e.value = 0;
        e.thumb = el('img', 'thumb', e);
        e.thumb.src = BASE + c.image;
        e.thumb.draggable = false;
        const set = (ev) => {
          const box = e.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
          this.setSlider(c.id, Math.round(f * (e.units - 1)));
          e.onchange?.(e.value);
        };
        e.addEventListener('pointerdown', (ev) => { ev.preventDefault(); e.setPointerCapture(ev.pointerId); set(ev); e.dragging = true; });
        e.addEventListener('pointermove', (ev) => { if (e.dragging) set(ev); });
        e.addEventListener('pointerup', () => { e.dragging = false; });
        e.addEventListener('pointercancel', () => { e.dragging = false; });
        break;
      }
      case 'progress': {
        e = el('div', 'fe-progress', this.el);
        place(e, l, t, r - l, b - t);
        e.fill = el('i', '', e);
        e.fill.style.background = `rgb(${c.color.join(',')})`;
        e.fill.style.width = '0%';
        break;
      }
      default:
        return;
    }
    if (!c.visible) e.hidden = true;
    if (c.id !== -1) this.ctrls.set(c.id, e);
  }

  sound() { menuSound.button(); }

  // Normal, hover, pressed, disabled: _0.._3 (CUIButton). The action fires on release.
  wireButton(e, id) {
    const img = (n) => { if (e.images[n]) e.src = BASE + e.images[n]; };
    let down = false;
    e.addEventListener('pointerenter', (ev) => { if (e.enabled && ev.pointerType === 'mouse') img(down ? 2 : 1); });
    e.addEventListener('pointerleave', () => { if (e.enabled) img(0); down = false; });
    e.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (!e.enabled) return;
      down = true;
      img(2);
      try { e.releasePointerCapture?.(ev.pointerId); } catch (err) { /* not captured */ }
    });
    e.addEventListener('pointerup', (ev) => {
      if (!e.enabled || !down) return;
      down = false;
      img(ev.pointerType === 'mouse' ? 1 : 0);
      if (e.images[0]) this.sound();
      this.onButton(id);
    });
    e.addEventListener('pointercancel', () => { down = false; if (e.enabled) img(0); });
  }

  get(id) { return this.ctrls.get(id); }
  show(id, on = true) { const e = this.get(id); if (e) e.hidden = !on; }
  text(id, s) { const e = this.get(id); if (e) e.textContent = s; }

  setEnabled(id, on, e = this.get(id)) {
    if (!e) return;
    e.enabled = on;
    if (e.images) {
      if (e.images[3]) e.src = BASE + e.images[on ? 0 : 3];
      else e.classList.toggle('disabled', !on);
    }
  }

  paintCheck(e) {
    e.src = BASE + e.images[e.checked ? 2 : 0];
    e.classList.toggle('disabled', !e.enabled);
  }
  check(id, on) { const e = this.get(id); if (e) { e.checked = on; this.paintCheck(e); } }
  checked(id) { return !!this.get(id)?.checked; }
  toggle(id) {
    const e = this.get(id);
    if (!e || !e.enabled) return;
    this.sound();
    e.checked = !e.checked;
    this.paintCheck(e);
    e.onchange?.(e.checked);
  }
  disableCheck(id) { const e = this.get(id); if (e) { e.enabled = false; this.paintCheck(e); } }

  setSlider(id, v) {
    const e = this.get(id);
    if (!e) return;
    e.value = v;
    const w = parseFloat(e.style.width);
    e.thumb.style.left = (e.units > 1 ? (v / (e.units - 1)) * (w - 10) : 0) + 'px';
  }

  setProgress(id, f) { const e = this.get(id); if (e) e.fill.style.width = (100 * Math.min(1, Math.max(0, f))) + '%'; }

  // Listbox rows; onPick(index) on selection, onOpen(index) on a double click / second tap.
  fill(id, items, { onPick, onOpen } = {}) {
    const box = this.get(id);
    box.rows.textContent = '';
    box.selected = -1;
    items.forEach((label, i) => {
      const row = el('div', 'row', box.rows);
      row.textContent = label;
      row.addEventListener('pointerup', () => {
        const again = box.selected === i;
        for (const r of box.rows.children) r.classList.remove('sel');
        row.classList.add('sel');
        box.selected = i;
        onPick?.(i);
        if (again) onOpen?.(i);
      });
      row.addEventListener('dblclick', () => onOpen?.(i));
    });
  }
}

// ---------------------------------------------------------------- the screen stack

class FrontEnd {
  constructor() {
    this.root = el('div', '', document.body);
    this.root.id = 'fe';
    this.stack = [];          // open windows, topmost last
    this.ui = null;           // the game's UI, once the level is ready
    this.game = null;
    this.readyWaiters = [];
    this.mode = 'boot';       // boot | video | menu | loader | game
    this.sound = menuSound;
    addEventListener('resize', () => this.layout());
    visualViewport?.addEventListener('resize', () => this.layout());
    addEventListener('keydown', (e) => this.key(e), true);
    this.watchLoading();
  }

  // Stage scale: the 640x480 screen letterboxed into the window. Dialogs follow it
  // over the main screen on desktop; on a phone, or over the game, they get the room
  // they need to be touchable.
  scales() {
    const vw = innerWidth, vh = innerHeight;
    const stage = Math.min(vw / 640, vh / 480);
    const fit = (w, h) => Math.min((vw * 0.94) / w, (vh * 0.94) / h);
    return { stage, fit };
  }

  layout() {
    const { stage, fit } = this.scales();
    for (const layer of this.stack) {
      const w = layer.win;
      let s = stage;
      if (layer.kind === 'dialog') {
        const f = fit(w.w, w.h);
        s = this.mode === 'game' ? (TOUCH ? f : Math.min(f, stage * 1.25)) : TOUCH ? Math.max(stage, f) : Math.min(stage, f);
      }
      w.el.style.transform = `translate(-50%, -50%) scale(${s})`;
    }
  }

  push(win, { kind = 'dialog', onEscape = null } = {}) {
    // Full screens sit on black; over the game the view shows, dimmed, round the dialogs.
    if (kind === 'screen') this.root.classList.add('opaque');
    const layer = { win, kind, onEscape };
    layer.shield = el('div', 'fe-shield', this.root);   // blocks the windows below
    this.root.append(win.el);
    win.el.classList.add(kind);
    this.stack.push(layer);
    this.root.hidden = false;
    this.layout();
    return layer;
  }

  pop(win) {
    const i = this.stack.findIndex((l) => l.win === win);
    if (i < 0) return;
    const [layer] = this.stack.splice(i, 1);
    layer.shield.remove();
    win.el.remove();
  }

  clear() {
    for (const l of this.stack) { l.shield.remove(); l.win.el.remove(); }
    this.stack = [];
    this.root.classList.remove('opaque', 'dim');
  }

  key(e) {
    if (this.mode === 'video') return;   // the player handles its own keys
    if (e.code !== 'Escape') return;
    if (this.mode === 'game' && this.ui && !this.ui.paused && !this.game?.dead) { this.ui.pause(); e.preventDefault(); return; }
    const top = this.stack[this.stack.length - 1];
    if (top?.onEscape) { e.preventDefault(); menuSound.button(); top.onEscape(); }
  }

  // ------------------------------------------------------------ level readiness

  // main.js writes its progress into #loading and removes it when the world is built;
  // the loader screen reads both.
  watchLoading() {
    this.phase = 0;
    this.fetched = 0;
    const phases = ['Building world', 'Painting', 'Building collision'];
    const src = document.getElementById('loading');
    if (!src) return;
    const read = () => {
      const t = src.textContent || '';
      const i = phases.findIndex((p) => t.startsWith(p));
      if (i >= 0) this.phase = Math.max(this.phase, i + 1);
    };
    new MutationObserver(read).observe(src, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => { if (!src.isConnected) this.phase = 4; }).observe(document.body, { childList: true });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name.includes('/levels/')) this.fetched++;
      }).observe({ type: 'resource', buffered: true });
    } catch (e) { /* no resource timing */ }
  }

  whenReady() { return this.ui ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r)); }

  // Called by the UI when the Game exists: the level is playable.
  attach(ui, game) {
    this.ui = ui;
    this.game = game;
    this.phase = 5;
    applyVideoSettings();
    for (const r of this.readyWaiters.splice(0)) r();
  }

  // ------------------------------------------------------------ boot

  async boot() {
    await layoutsReady;
    for (const n of ['ms_bkgnd.png', 'splash.png', 'ingameopt.png', 'generic_bg.png']) preload(n);
    if (params.get('play') === '1') return this.loader(LEVEL, { entered: false });
    if (params.get('menu') === '1') return this.mainScreen();
    await this.splash();
    await this.video('tpassintro');
    this.mainScreen();
  }

  // The DreamWorks Interactive card, held until a tap or key so the intro can play with sound.
  splash() {
    this.mode = 'boot';
    return new Promise((resolve) => {
      const win = { el: el('div', 'fe-win'), w: 640, h: 480 };
      size(win.el, 640, 480);
      const img = el('img', 'fe-static', win.el);
      img.src = BASE + 'splash.png';
      img.draggable = false;
      const cap = el('div', 'fe-text fe-blink', win.el);
      place(cap, 0, 446, 640, 22);
      cap.style.justifyContent = 'center';
      cap.style.fontSize = '13px';
      cap.textContent = TOUCH ? 'Tap to start' : 'Click or press a key to start';
      this.push(win, { kind: 'screen' });
      const go = (e) => {
        if (e.type === 'keydown' && ['Tab', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) return;
        removeEventListener('pointerup', go, true);
        removeEventListener('keydown', go, true);
        this.pop(win);
        resolve();
      };
      addEventListener('pointerup', go, true);
      addEventListener('keydown', go, true);
    });
  }

  // ------------------------------------------------------------ cutscenes

  // A Smacker cutscene, transcoded to H.264 MP4 (every current browser plays it),
  // letterboxed on black. A click, tap, Esc, Space or Enter skips it (video.cpp).
  video(name) {
    const prev = this.mode;
    this.mode = 'video';
    return new Promise((resolve) => {
      const layer = el('div', '', document.body);
      layer.id = 'fe-video';
      const v = el('video', '', layer);
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'auto';
      v.src = `${BASE}video/${name}.mp4`;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        removeEventListener('keydown', onKey, true);
        v.pause();
        v.removeAttribute('src');
        v.load();
        layer.remove();
        this.mode = prev === 'video' ? 'menu' : prev;
        resolve();
      };
      const onKey = (e) => { if (['Escape', 'Space', 'Enter'].includes(e.code)) { e.preventDefault(); e.stopPropagation(); end(); } };
      v.addEventListener('ended', end);
      v.addEventListener('error', end);
      // Ignore the tap that started the video.
      setTimeout(() => { layer.addEventListener('pointerdown', (e) => { e.preventDefault(); end(); }); addEventListener('keydown', onKey, true); }, 400);
      window.__feVideo = v;   // for automated tests
      v.play().catch(() => {
        // No user gesture behind this one (autoplay policy): try it silent before giving up.
        v.muted = true;
        v.play().catch(end);
      });
    });
  }

  // ------------------------------------------------------------ main screen

  mainScreen() {
    this.clear();
    this.mode = 'menu';
    const I = ID.main;
    const win = new Win('mainscreen', {
      onButton: (id) => {
        // The Soundelux logo shows until the first button press (m_fAMDShowLogoOnce).
        win.show(I.LOGO, false);
        if (id === I.NEW) this.newGame();
        else if (id === I.LOAD) this.loadDialog();
        else if (id === I.OPTIONS) this.optionsDialog(false);
        else if (id === I.QUIT) this.credits();
        else if (id === I.DIRECT) this.directLoad();
      },
    });
    // No Exit in a browser: that slot takes the main-screen Credits art the game
    // shipped but never placed (ms_credits_*), centred on the Exit sign's spot.
    const quit = win.get(I.QUIT);
    quit.images = ['ms_credits_0.png', 'ms_credits_1.png', 'ms_credits_2.png', null];
    quit.images.forEach(preload);
    quit.src = BASE + quit.images[0];
    place(quit, 205 + (208 - 240) / 2, 340 + (81 - 75) / 2);
    this.push(win, { kind: 'screen' });
    this.main = win;
    menuSound.menuOn();
  }

  async newGame() {
    menuSound.menuOff();
    await this.video('newgame');
    if (LEVEL !== FIRST_LEVEL) return go(FIRST_LEVEL, { play: 1 });
    this.loader(FIRST_LEVEL, { entered: true });
  }

  async credits() {
    const wasMenu = menuSound.wantLoop;
    menuSound.menuOff();
    await this.video('credits');
    if (wasMenu) menuSound.menuOn();
  }

  // Load: the original lists saved games here; the remake has none, so it lists the
  // levels, each with its loader picture in the preview frame.
  loadDialog() {
    const win = new Win('loadgame', {
      onButton: (id) => {
        if (id === ID.CANCEL) this.pop(win);
        else if (id === ID.OK && pick >= 0) this.startLevel(LEVELS[pick][0]);
      },
    });
    let pick = -1;
    const preview = win.get(1003);
    win.fill(ID.LIST, LEVELS.map(([, n]) => n), {
      onPick: (i) => {
        pick = i;
        preview.src = `${BASE}${LOADER_IMAGE[LEVELS[i][0]] || 'li_other'}_0.png`;
        win.show(ID.OK, true);
      },
      onOpen: (i) => this.startLevel(LEVELS[i][0]),
    });
    this.push(win, { onEscape: () => this.pop(win) });
  }

  // The hidden bottom-left corner of the main screen: the developers' scene list.
  directLoad() {
    const win = new Win('directload', {
      onButton: (id) => {
        if (id === ID.CANCEL) this.pop(win);
        else if (id === ID.OK && pick >= 0) this.startLevel(LEVELS[pick][0]);
      },
    });
    let pick = -1;
    win.setEnabled(ID.OK, false);
    win.fill(ID.LIST, LEVELS.map(([id]) => `${id}.scn`), {
      onPick: (i) => { pick = i; win.setEnabled(ID.OK, true); },
      onOpen: (i) => this.startLevel(LEVELS[i][0]),
    });
    this.push(win, { onEscape: () => this.pop(win) });
  }

  startLevel(level) {
    menuSound.menuOff();
    if (level === LEVEL && this.mode === 'menu') { this.loader(level, { entered: true }); return; }
    go(level, { play: 1 });
  }

  // ------------------------------------------------------------ options

  optionsDialog(inGame) {
    const O = ID.options;
    const win = new Win(inGame ? 'options2' : 'options', {
      onButton: (id) => {
        if (id === O.CLOSE) this.pop(win);
        else if (id === O.AUDIO) this.audioDialog();
        else if (id === O.VIDEO) this.videoDialog();
        else if (id === O.CONTROLS) this.controlsDialog();
        else if (id === O.CREDITS) this.credits();
      },
    });
    this.push(win, { onEscape: () => this.pop(win) });
  }

  audioDialog() {
    const before = { ...settings };
    const win = new Win('audio', {
      onButton: (id) => {
        if (id === ID.OK) { saveSettings(); }
        else { Object.assign(settings, before); applyAudio(); menuSound.refresh(); }
        this.pop(win);
      },
    });
    const vol = win.get(1004);
    win.setSlider(1004, settings.volume);
    vol.onchange = (v) => { settings.volume = v; applyAudio(); };
    win.check(1020, settings.sfx);
    win.get(1020).onchange = (on) => { settings.sfx = on; applyAudio(); };
    win.check(1023, settings.music);
    win.get(1023).onchange = (on) => { settings.music = on; menuSound.refresh(); };
    // Ambient, voice-overs, subtitles and 3D hardware: nothing in the remake to switch.
    win.check(1021, true); win.check(1022, true); win.check(1025, true);
    for (const id of [1021, 1022, 1024, 1025]) win.disableCheck(id);
    this.push(win, { onEscape: () => win.onButton(ID.CANCEL) });
  }

  // Video: the driver box names the WebGL renderer; Quality is the render
  // resolution, Brightness a gamma-like lift, Screen Size the original's shrinking
  // viewport (the +/- keys in gamewnd.cpp).
  videoDialog() {
    const before = { ...settings };
    const win = new Win('render', {
      onButton: (id) => {
        if (id === ID.OK) saveSettings();
        else if (id === ID.CANCEL) Object.assign(settings, before);
        else return;
        applyVideoSettings();
        this.pop(win);
      },
    });
    win.text(1011, 'Video Driver Name');
    let driver = 'WebGL';
    try {
      const gl = window.__renderer?.getContext();
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
      driver = `${gl instanceof WebGL2RenderingContext ? 'WebGL 2' : 'WebGL'}${name ? ' — ' + name : ''}`;
    } catch (e) { /* no context yet */ }
    win.fill(ID.LIST, [driver]);
    win.get(ID.LIST).rows.firstChild?.classList.add('sel');
    for (const [id, key] of [[1006, 'quality'], [1008, 'brightness'], [1012, 'screen']]) {
      win.setSlider(id, settings[key]);
      win.get(id).onchange = (v) => { settings[key] = v; applyVideoSettings(); };
    }
    this.push(win, { onEscape: () => win.onButton(ID.CANCEL) });
  }

  // Controls: the original remapping screen, showing the remake's fixed bindings.
  controlsDialog() {
    const win = new Win('controls', { onButton: () => this.pop(win) });
    const keys = TOUCH
      ? { 1030: 'Left stick', 1031: 'Stick to edge', 1032: 'Left stick', 1033: 'Left stick', 1034: 'Left stick', 1035: 'JUMP', 1036: '',
        1043: '', 1037: 'FIRE', 1038: '', 1039: 'Right stick', 1040: 'GRAB', 1041: '', 1042: '', 1044: '', 100: 'More' }
      : { 1030: 'W', 1031: 'Shift + W', 1032: 'S', 1033: 'A', 1034: 'D', 1035: 'Space', 1036: '',
        1043: '', 1037: 'Left Mouse', 1038: '', 1039: 'Mouse', 1040: 'E / G', 1041: '', 1042: '', 1044: '', 100: 'More' };
    for (const [id, s] of Object.entries(keys)) win.text(+id, s);
    win.disableCheck(102);
    this.push(win, { onEscape: () => this.pop(win) });
  }

  // ------------------------------------------------------------ the loader

  // uidlgs.cpp CLoaderWnd: the level's picture centred on black, the loader.ddf
  // dialog over it with its two progress bars. `entered` means the player has just
  // pressed something, so the game can start without another tap.
  async loader(level, { entered }) {
    this.clear();
    this.mode = 'loader';
    menuSound.menuOff();
    const back = { el: el('div', 'fe-win'), w: 640, h: 480 };
    size(back.el, 640, 480);
    const img = el('img', 'fe-static', back.el);
    img.src = `${BASE}${LOADER_IMAGE[level] || 'li_other'}_0.png`;
    img.draggable = false;
    this.push(back, { kind: 'screen' });
    const win = new Win('loader');
    // The commented-out "Please Wait" line of loader.ddf, restored with IDS_LOADING_LEVEL.
    win.add({ type: 'textbox', visible: 1, id: 102, rect: [0, 15, 320, 40], text: IDS_LOADING_LEVEL, size: 14, flags: 0x25 });
    this.push(win, { kind: 'screen' });

    let shown = 0, copy = 0, raf = 0;
    const tick = () => {
      // Phases from main.js; the bar creeps within each so it never sits still.
      const target = [0.55, 0.7, 0.82, 0.93, 0.97, 1][this.phase];
      shown += (target - shown) * 0.04;
      copy = Math.max(copy, 1 - Math.exp(-this.fetched / 60));
      win.setProgress(100, this.ui ? 1 : shown);
      win.setProgress(101, this.ui ? 1 : copy);
      raf = requestAnimationFrame(tick);
    };
    tick();
    await this.whenReady();
    await new Promise((r) => setTimeout(r, 250));
    cancelAnimationFrame(raf);
    win.setProgress(100, 1); win.setProgress(101, 1);

    const active = navigator.userActivation ? navigator.userActivation.isActive : false;
    if (!(entered && (active || TOUCH))) {
      // Sound and mouse capture both need a fresh press.
      win.text(102, TOUCH ? 'Tap to begin' : 'Click to begin');
      win.get(102).classList.add('fe-blink');
      await new Promise((resolve) => {
        const go = (e) => {
          if (e.type === 'keydown' && e.code !== 'Space' && e.code !== 'Enter') return;
          removeEventListener('pointerup', go, true);
          removeEventListener('keydown', go, true);
          resolve();
        };
        addEventListener('pointerup', go, true);
        addEventListener('keydown', go, true);
      });
    }
    this.enterGame();
  }

  enterGame() {
    this.clear();
    this.mode = 'game';
    this.root.hidden = true;
    menuSound.menuOff();
    applyAudio();
    this.ui.resume();
  }

  // ------------------------------------------------------------ in the game

  // Esc / the pause button (gamewnd.cpp VK_ESCAPE → CInGameOptionsWnd).
  pauseMenu() {
    if (this.mode !== 'game') return;
    this.clear();
    this.root.hidden = false;
    this.root.classList.add('dim');
    const G = ID.ingame;
    const win = new Win('ingameopt', {
      onButton: (id) => {
        if (id === G.RESUME) this.resumeGame();
        else if (id === G.RESTART) go(LEVEL, { play: 1 });
        else if (id === G.LOAD) this.loadDialog();
        else if (id === G.OPTIONS) this.optionsDialog(true);
        else if (id === G.QUIT) this.quitDialog();
      },
    });
    // Saving isn't part of the remake: its plate stays, the button goes.
    win.show(G.SAVE, false);
    this.push(win, { onEscape: () => this.resumeGame() });
  }

  quitDialog() {
    const Q = ID.quit;
    const win = new Win('quit', {
      onButton: (id) => {
        if (id === Q.MENU) go(LEVEL, { menu: 1 });
        else this.pop(win);
      },
    });
    win.show(Q.DESKTOP, false);
    this.push(win, { onEscape: () => this.pop(win) });
  }

  resumeGame() {
    this.clear();
    this.root.hidden = true;
    applyAudio();
    this.ui.resume();
  }

  // After death: Trespasser asks to restart the level (IDS_RESTARTLEVEL); No goes
  // back to the main screen.
  died() {
    this.clear();
    setTimeout(() => {
      this.root.hidden = false;
      this.root.classList.add('dim');
      const win = new Win('yesno', {
        backdrop: 'generic_bg.png',
        onButton: (id) => (id === 1000 ? go(LEVEL, { play: 1 }) : go(LEVEL, { menu: 1 })),
      });
      win.text(1002, IDS_RESTARTLEVEL);
      this.push(win);
    }, 1800);
  }

  // The ending (mainwnd.cpp): win.smk, then the credits, then the main screen.
  async won() {
    this.mode = 'menu';
    if (document.pointerLockElement) document.exitPointerLock();
    await this.video('win');
    await this.video('credits');
    go(LEVEL, { menu: 1 });
  }
}

function applyAudio() {
  menuSound.setVolume();
  const master = front.game?.audio?.master;
  if (master) master.gain.value = 0.9 * (settings.sfx ? settings.volume / 100 : 0);
}

let baseRatio = 0;
function applyVideoSettings() {
  const canvas = document.querySelector('canvas');
  if (canvas) {
    const b = settings.brightness;
    canvas.style.filter = b === DEFAULTS.brightness ? '' : `brightness(${(0.75 + b * 0.05).toFixed(2)}) contrast(${(1.04 - b * 0.008).toFixed(3)})`;
    const k = 0.55 + settings.screen * 0.05;
    canvas.style.scale = settings.screen === DEFAULTS.screen ? '' : String(k);
  }
  const r = window.__renderer;
  if (r) {
    baseRatio ||= r.getPixelRatio();
    const want = baseRatio * [0.5, 0.625, 0.75, 0.875, 1][settings.quality];
    if (Math.abs(r.getPixelRatio() - want) > 1e-3) {
      r.setPixelRatio(want);
      dispatchEvent(new Event('resize'));   // main.js resizes the renderer and post chain
    }
  }
}

const menuSound = new MenuSound();
export const front = new FrontEnd();
window.__front = front;   // for automated tests
front.boot();
