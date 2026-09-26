// The original's cheat console (gamewnd.cpp, Ctrl+F11 there; the backquote key here,
// desktop only), for testing the levels: type a command and press Enter.
//   TNEXT            jump to the level's next Teleport checkpoint (Ctrl+T too)
//   TELE x y [z]     jump to a point (z: the ground there if left out)
//   TTRIG name       jump into a trigger's volume (a name prefix is enough)
//   TRIG name        fire a trigger as if its condition were met
//   INVUL            invulnerable (toggle)
//   WOO              all the ammo you could want (toggle)
//   WIN              win the level: on to the next one (the ending after the summit)
//   LOC              show where Anne stands
//   DINOS            dinosaurs ignore Anne (toggle)
//   HEAL             back to full health
//   LIST [prefix]    list trigger names
// ?cheat=INVUL,WOO runs commands when the level starts.
const TOUCH = matchMedia('(pointer: coarse)').matches;

export class Cheats {
  constructor(triggers) {
    this.tr = triggers;
    this.game = triggers.game;
    this.invul = false;
    this.woo = false;
    this.tnext = -1;
    window.__cheats = this;
    // Invulnerable: Anne takes no damage (hurt is wrapped here, not changed).
    const hurt = this.game.hurt.bind(this.game);
    this.game.hurt = (amount) => { if (!this.invul) hurt(amount); };
    if (!TOUCH) this.makeConsole();
    const run = new URLSearchParams(location.search).get('cheat');
    if (run) for (const c of run.split(',')) this.run(c);
  }

  makeConsole() {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', left: '0', right: '0', top: '0', padding: '6px 10px', background: 'rgba(0,0,0,.72)',
      font: '13px/1.4 ui-monospace, Menlo, monospace', color: '#cfe', zIndex: 60, display: 'none',
    });
    const out = document.createElement('div');
    out.style.whiteSpace = 'pre-wrap';
    out.style.maxHeight = '40vh';
    out.style.overflow = 'auto';
    const input = document.createElement('input');
    Object.assign(input.style, { width: '100%', background: 'transparent', border: '0', outline: 'none', color: '#fff', font: 'inherit' });
    input.placeholder = 'TNEXT · TELE x y · TTRIG name · TRIG name · INVUL · WOO · WIN · LOC · DINOS · HEAL · LIST';
    box.append(out, input);
    document.body.appendChild(box);
    Object.assign(this, { box, out, input });
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        e.preventDefault();
        this.toggle();
      } else if (e.code === 'KeyT' && e.ctrlKey) {
        e.preventDefault();
        this.run('TNEXT');
      }
    }, true);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') { this.print('> ' + input.value); this.print(this.run(input.value)); input.value = ''; }
      if (e.code === 'Escape' || e.code === 'Backquote') { e.preventDefault(); this.toggle(false); }
    });
  }

  toggle(on = this.box.style.display === 'none') {
    this.box.style.display = on ? '' : 'none';
    if (on) {
      if (document.pointerLockElement) document.exitPointerLock();
      setTimeout(() => this.input.focus(), 0);
    } else {
      this.input.blur();
      document.querySelector('canvas')?.requestPointerLock?.()?.catch?.(() => {});
    }
  }

  print(s) {
    if (!this.out || !s) return;
    this.out.textContent = (this.out.textContent + '\n' + s).split('\n').slice(-14).join('\n').trim();
  }

  jump(x, y, z, yaw) {
    const p = this.tr.player;
    p.pos.set(x, y, z ?? this.tr.groundAt(x, y) + 0.3);
    p.vz = 0;
    if (yaw !== undefined) p.yaw = yaw;
  }

  run(line) {
    const [cmd, ...args] = String(line || '').trim().split(/\s+/);
    const tr = this.tr, g = this.game, logic = tr.logic;
    switch ((cmd || '').toUpperCase()) {
      case 'TNEXT': {
        const tps = logic?.teleports || [];
        if (!tps.length) return 'No Teleport objects in this level.';
        this.tnext = (this.tnext + 1) % tps.length;
        const t = tps[this.tnext];
        this.jump(t.pos[0], t.pos[1], t.pos[2], t.heading);
        return `${t.name} (${t.pos.map((v) => v.toFixed(0)).join(', ')})`;
      }
      case 'TELE': {
        const [x, y, z] = args.map(Number);
        if (Number.isNaN(x) || Number.isNaN(y)) return 'TELE x y [z]';
        this.jump(x, y, Number.isNaN(z) || z === undefined ? undefined : z);
        return `at ${x}, ${y}`;
      }
      case 'TTRIG': {
        const want = (args[0] || '').toLowerCase();
        const t = tr.list.find((t) => t.name.toLowerCase() === want) || tr.list.find((t) => t.name.toLowerCase().startsWith(want));
        if (!t) return 'No such trigger.';
        this.jump(t.pos[0], t.pos[1], Math.max(t.pos[2] - 0.9, tr.groundAt(t.pos[0], t.pos[1]) + 0.1));
        return `in ${t.name}`;
      }
      case 'TRIG': return tr.force(args[0]) ? `fired ${args[0]}` : 'No such trigger.';
      case 'INVUL': this.invul = !this.invul; return `Invulnerable ${this.invul ? 'on' : 'off'}`;
      case 'WOO': this.woo = !this.woo; return `Unlimited ammo ${this.woo ? 'on' : 'off'}`;
      case 'HEAL': g.heal?.(1000); return 'Healed';
      case 'WIN': {
        if (logic?.next) { tr.loadLevel(logic.next); return `On to ${logic.next}`; }
        tr.do_END_GAME();
        return 'The end';
      }
      case 'LOC': {
        const p = tr.player.pos;
        return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  yaw ${tr.player.yaw.toFixed(2)}`;
      }
      case 'DINOS':
        this.dinos = !this.dinos;
        for (const d of g.dinos) if (this.dinos) d.awake = false;
        return `Boring dinosaurs ${this.dinos ? 'on' : 'off'}`;
      case 'LIST': {
        const pre = (args[0] || '').toLowerCase();
        return tr.list.filter((t) => t.name.toLowerCase().startsWith(pre)).map((t) => `${t.name}${t.fired ? '*' : ''}`).slice(0, 60).join('  ');
      }
      case '': return '';
      default: return `Unknown: ${cmd}`;
    }
  }

  update() {
    const g = this.game;
    if (this.woo && g.gun) g.gun.ammo = Math.max(g.gun.ammo, g.gun.inst.props.MaxAmmo || 99);
    if (this.dinos) for (const d of g.dinos) d.awake = false;
    if (this.invul && g.hp < (g.maxHp || 100)) g.hp = g.maxHp || 100;
  }
}
