// Touch controls for phones and tablets, drawn over the game. GTA2 steers like a tank (left and
// right turn, up and down go forward and back), so: turn left / turn right under the left thumb,
// forward / back under the right thumb with the action buttons around them. A thumb can slide
// between the two buttons of a pair without lifting.
//
// They press the same keys a keyboard does: the game's default controls, which shell.js turns into
// the player's own bindings while playing (as for a game pad), so in the game's menus the arrows
// move the selection, Car is Enter and Menu Esc.

// [label, key, css class]: pairs a thumb slides between
const PAIRS = [
  [['◀', 'ArrowLeft', 'turn left'], ['▶', 'ArrowRight', 'turn right']],
  [['▲', 'ArrowUp', 'drive forward'], ['▼', 'ArrowDown', 'drive back']],
];
// [label, key, css class]: buttons held while touched
const BUTTONS = [
  ['Shoot', 'ControlLeft', 'big shoot'],
  ['Jump', 'Space', 'mid jump'],
  ['Car', 'Enter', 'mid car'],
  ['Horn', 'Tab', 'small horn'],
  ['Wpn −', 'KeyZ', 'small prev'],
  ['Wpn +', 'KeyX', 'small next'],
];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const capture = (target, e) => {
  try { target.setPointerCapture(e.pointerId); } catch { /* the touch has already ended */ }
};

/** Whether this device has a touch screen (more are found by their first touch: shell.js). */
export function isTouchDevice() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
}

export class TouchControls {
  /**
   * @param {object} o
   * @param {(code: string, down: boolean) => void} o.send presses or releases a key (shell.js)
   * @param {HTMLElement} o.parent where the controls go (over the game)
   * @param {() => void} [o.onMenu] opens the menu (game menu, map, scores, full screen, settings)
   */
  constructor({ send, parent, onMenu = null }) {
    this.send = send;
    this.root = el('div', 'touch-controls');
    this.root.setAttribute('aria-hidden', 'true');
    for (const pair of PAIRS) this.root.append(this.pair(pair));
    for (const [label, code, cls] of BUTTONS) this.root.append(this.button(label, () => code, cls));
    // everything else is in one menu: one button at the top, clear of the game's HUD
    if (onMenu) {
      const menu = el('div', 'touch-btn top menu', '☰');
      menu.setAttribute('aria-label', 'Menu');
      // (on lifting the finger: the touch controls stop taps becoming clicks, and it still counts as a
      // gesture, which full screen needs)
      menu.addEventListener('pointerup', () => onMenu());
      this.root.append(menu);
    }
    // held upright the game is a strip: GTA2 plays sideways (index.html hides this in landscape)
    this.root.append(el('div', 'touch-rotate', 'Turn your phone sideways for a bigger view'));
    parent.append(this.root);
    // no page zoom, scrolling, text selection or callout menus from the controls
    for (const ev of ['contextmenu', 'touchstart', 'touchmove']) {
      this.root.addEventListener(ev, (e) => { if (e.target !== this.root) e.preventDefault(); }, { passive: false });
    }
  }

  button(label, codeOf, cls) {
    const b = el('div', `touch-btn ${cls}`, label);
    let code = null;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(b, e);
      code = codeOf();
      if (!code) return;
      b.classList.add('down');
      this.send(code, true);
    });
    const up = () => {
      if (!code) return;
      b.classList.remove('down');
      this.send(code, false);
      code = null;
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
    return b;
  }

  /** Two buttons a thumb slides between: whichever is under the thumb is pressed. */
  pair(defs) {
    const box = el('div', `touch-pair ${defs[0][2].split(' ')[0]}`);
    const buttons = defs.map(([label, code, cls]) => {
      const b = el('div', `touch-btn ${cls}`, label);
      b.dataset.code = code;
      box.append(b);
      return b;
    });
    const touches = new Map(); // pointer -> the button it is on (or null)
    const pressed = () => new Set([...touches.values()].filter(Boolean));
    const set = (id, b) => {
      const before = pressed();
      touches.set(id, b);
      const after = pressed();
      for (const x of before) if (!after.has(x)) { x.classList.remove('down'); this.send(x.dataset.code, false); }
      for (const x of after) if (!before.has(x)) { x.classList.add('down'); this.send(x.dataset.code, true); }
    };
    const under = (e) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      return buttons.includes(hit) ? hit : null;
    };
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(box, e);
      set(e.pointerId, under(e));
    });
    box.addEventListener('pointermove', (e) => { if (touches.has(e.pointerId)) set(e.pointerId, under(e)); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      box.addEventListener(ev, (e) => {
        if (!touches.has(e.pointerId)) return;
        set(e.pointerId, null);
        touches.delete(e.pointerId);
      });
    }
    return box;
  }

  /** Shown while the game is. */
  update(visible) {
    this.root.hidden = !visible;
  }
}
