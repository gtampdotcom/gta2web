// The Controls screen (issue #2): change the game's twelve keys. The front end's Options item opens
// it (the original launched the separate GTA2 Manager program), and so does the toolbar's
// Controls button. It writes the same registry values GTA2 Manager wrote; the game reads them
// again at once, and the shell keeps them in this browser with the other settings.
//
// The controller's buttons are in a second column (web/gamepad.js keeps them in this browser).
import { bindableButton, buttonLabel, padBindings, resetPadBindings, setPadBinding } from './gamepad.js?v=5a148f500b';

// The game's control slots, in its order (hklm\...\gta2\control\0-11).
const ACTIONS = [
  'Forward', 'Back', 'Turn left', 'Turn right', 'Shoot / punch', 'Get in or out of a car', 'Jump / handbrake',
  'Previous weapon', 'Next weapon', 'Special 1 (horn, car extras)', 'Special 2', 'Status',
];
// Slots not shown: Status (11) does nothing in this version of the game (Player.cpp reads it into a
// flag that nothing uses).
const HIDDEN = new Set([11]);
// The browser version's own key, shown after the game's: hold for the multiplayer scoreboard
// (web/map.js). Kept in this browser, not in the game's registry.
const SCORE = ACTIONS.length;
const SCORE_ACTION = 'Scoreboard (multiplayer, hold)';
const SCORE_STORE = 'gta2-port-scoreboard-key';
const SCORE_DEFAULT = 'Backquote';
// Each row's controller action (web/gamepad.js PAD_ACTIONS); turning is the d-pad and left stick's.
const PAD_ROWS = { 0: 'forward', 1: 'back', 4: 'shoot', 5: 'car', 6: 'jump', 7: 'prev', 8: 'next', 9: 'special1', 10: 'special2' };
const STEER = 'D-pad / left stick';
// Controller-only rows, after the game's: their keyboard keys are the browser version's own.
const PAD_EXTRA = [['menu', 'Game menu', 'Esc'], ['map', 'Map', 'M']];

/** The key (KeyboardEvent.code) that shows the multiplayer scoreboard. */
export function scoreboardKey() {
  try {
    return localStorage.getItem(SCORE_STORE) || SCORE_DEFAULT;
  } catch {
    return SCORE_DEFAULT;
  }
}

function setScoreboardKey(code) {
  try { localStorage.setItem(SCORE_STORE, code); } catch { /* storage unavailable: this session only */ }
}

// Keys the browser version uses itself while playing, so the game never sees them.
const RESERVED = {
  KeyM: 'M opens the map', KeyR: 'R turns the radio on and off',
  KeyT: 'T changes radio station (and opens the chat in co-op)', Minus: '− and = change the view distance',
  Equal: '− and = change the view distance', F5: 'F5 opens the Saves screen', F9: 'F9 opens the Saves screen',
  Escape: 'Esc opens the game menu',
};

const NAMES = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Keypad Enter', Backspace: 'Backspace', Tab: 'Tab', CapsLock: 'Caps Lock',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '~',
  Backslash: '\\', Comma: ',', Period: '.', Slash: '/', PageUp: 'Page Up', PageDown: 'Page Down',
  NumpadMultiply: 'Keypad *', NumpadSubtract: 'Keypad −', NumpadAdd: 'Keypad +', NumpadDecimal: 'Keypad .',
  NumpadDivide: 'Keypad /', NumLock: 'Num Lock', ScrollLock: 'Scroll Lock',
};

function keyName(code) {
  if (NAMES[code]) return NAMES[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad(\d)$/, 'Keypad $1');
}

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

export class ControlsScreen {
  /**
   * @param {object} opts
   * @param {object} opts.Module the game module
   * @param {Record<string, [number, number]>} opts.keys KeyboardEvent.code -> [scan code, virtual key]
   * @param {number[]} opts.defaults the browser version's default scan code for each slot
   * @param {string} opts.regPath the game's control registry key
   * @param {() => void} opts.onChange keeps the settings in this browser
   * @param {(paused: boolean) => void} opts.pause pauses the game while the screen is open
   * @param {() => void} opts.onClose gives the keyboard back to the game
   * @param {() => object|null} [opts.gamepad] the controller input (web/gamepad.js GamepadInput)
   */
  constructor({ Module, keys, defaults, regPath, onChange, pause, onClose, gamepad = () => null }) {
    this.gamepad = gamepad;
    this.padWaiting = null; // the controller action waiting for a button
    this.Module = Module;
    this.keys = keys;
    this.defaults = defaults;
    this.regPath = regPath;
    this.onChange = onChange;
    this.pause = pause;
    this.onClose = onClose;
    this.open = false;
    this.waiting = -1; // the slot waiting for a key
    this.message = '';
    this.setDword = Module.cwrap('gta2_port_reg_set_dword', null, ['string', 'string', 'number']);
    this.codeOf = new Map(Object.entries(keys).map(([code, [scan]]) => [scan, code]));
    this.root = el('div', { id: 'controls-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Controls', hidden: '' });
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    document.body.append(this.root);
  }

  /** The current binding of each slot, from the game's registry (a value of 0x8000 or more is a game pad). */
  bindings() {
    const text = this.Module.ccall('gta2_port_reg_export', 'string', [], []);
    const out = this.defaults.slice();
    const path = this.regPath.toLowerCase();
    for (const line of text.split('\n')) {
      const [p, name, type, value] = line.split('|');
      if (type === 'd' && p && p.toLowerCase() === path && /^\d+$/.test(name) && Number(name) < out.length) {
        out[Number(name)] = Number(value) >>> 0;
      }
    }
    return out;
  }

  /**
   * A default key, as the controller presses it (web/gamepad.js sends the default controls), turned
   * into the key now bound to that action, so the controller follows the player's choices.
   */
  rebound(code) {
    const scan = this.keys[code] && this.keys[code][0];
    const slot = scan === undefined ? -1 : this.defaults.indexOf(scan);
    if (slot < 0) return code;
    const value = this.bindings()[slot];
    return (value < 0x8000 && this.codeOf.get(value)) || code;
  }

  set(slot, value) {
    this.setDword(this.regPath, String(slot), value);
  }

  apply() {
    this.Module.ccall('gta2_port_reload_controls', null, [], []);
    this.onChange();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.waiting = -1;
    this.message = '';
    this.pause(true);
    this.root.hidden = false;
    this.render();
  }

  close() {
    if (!this.open) return;
    this.stopPadWait();
    this.open = false;
    this.waiting = -1;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.pause(false);
    this.onClose();
  }

  /** While open, every key is the screen's: a new binding, Esc to cancel or close. */
  handleKey(e, down) {
    if (!this.open) return false;
    if (!down || e.repeat) return true;
    if (this.padWaiting) {
      if (e.code === 'Escape') {
        this.stopPadWait();
        this.message = '';
        this.render();
      }
      return true;
    }
    if (this.waiting < 0) {
      if (e.code === 'Escape') this.close();
      return true;
    }
    if (e.code === 'Escape') {
      this.waiting = -1;
      this.message = '';
    } else if (RESERVED[e.code]) {
      this.message = `${RESERVED[e.code]} in the browser version. Choose another key.`;
    } else if (!this.keys[e.code] || e.metaKey) {
      this.message = 'That key can’t be used. Choose another key.';
    } else {
      this.message = '';
      if (this.waiting === SCORE) this.bindScoreboard(e.code);
      else this.bind(this.waiting, this.keys[e.code][0]); // a swap says which action took the old key
      this.waiting = -1;
    }
    this.render();
    return true;
  }

  /** Gives a slot a key; a slot that had that key takes this slot's old one (a swap). */
  bind(slot, scan) {
    const current = this.bindings();
    const other = current.findIndex((v, i) => i !== slot && v === scan);
    if (other >= 0) {
      this.set(other, current[slot]);
      this.message = `${ACTIONS[other]} is now ${this.label(current[slot])}.`;
    }
    // the scoreboard's key: it takes this slot's old one
    if (this.codeOf.get(scan) === scoreboardKey() && this.codeOf.get(current[slot])) {
      setScoreboardKey(this.codeOf.get(current[slot]));
      this.message = `${SCORE_ACTION} is now ${keyName(scoreboardKey())}.`;
    }
    this.set(slot, scan);
    this.apply();
  }

  /** The scoreboard's key; a game action that had it takes the scoreboard's old key (a swap). */
  bindScoreboard(code) {
    const old = scoreboardKey();
    const current = this.bindings();
    const slot = current.findIndex((v) => v === this.keys[code][0]);
    if (slot >= 0) {
      this.set(slot, this.keys[old] ? this.keys[old][0] : current[slot]);
      this.message = `${ACTIONS[slot]} is now ${keyName(old)}.`;
      this.apply();
    }
    setScoreboardKey(code);
    this.onChange();
  }

  /** Waits for a controller button for an action (Esc cancels). */
  waitForPad(action) {
    const input = this.gamepad();
    this.waiting = -1;
    this.stopPadWait();
    if (!input) {
      this.message = 'Controllers are not available in this browser.';
      this.render();
      return;
    }
    this.padWaiting = action;
    this.message = input.activePad() ? '' : 'Connect a controller and press a button on it.';
    input.captureButton((button, pad) => {
      if (!bindableButton(button)) {
        this.message = `The ${STEER} always steer. Choose another button.`;
      } else {
        const swapped = setPadBinding(action, button);
        this.message = swapped ? `${this.padActionName(swapped)} is now ${buttonLabel(padBindings()[swapped], pad)}.` : '';
        this.stopPadWait();
      }
      this.render();
    });
    this.render();
  }

  stopPadWait() {
    if (!this.padWaiting) return;
    this.padWaiting = null;
    const input = this.gamepad();
    if (input) input.captureButton(null);
  }

  padActionName(action) {
    const slot = Object.keys(PAD_ROWS).find((s) => PAD_ROWS[s] === action);
    if (slot !== undefined) return ACTIONS[slot];
    if (action === 'scores') return SCORE_ACTION;
    const extra = PAD_EXTRA.find(([a]) => a === action);
    return extra ? extra[1] : action;
  }

  /** The controller cell of a row: the button, or the d-pad for turning. */
  padCell(action, label) {
    if (!action) return el('button', { type: 'button', disabled: '', class: 'fixed' }, STEER);
    const input = this.gamepad();
    const pad = input ? input.activePad() : null;
    const waiting = this.padWaiting === action;
    const name = buttonLabel(padBindings()[action], pad);
    return el('button', {
      type: 'button', class: waiting ? 'waiting' : '', 'aria-label': `${label} on the controller: ${name}. Change`,
      onclick: () => this.waitForPad(action),
    }, waiting ? 'Press a button…' : name);
  }

  reset() {
    this.stopPadWait();
    resetPadBindings();
    setScoreboardKey(SCORE_DEFAULT);
    this.defaults.forEach((scan, slot) => this.set(slot, scan));
    this.apply();
    this.waiting = -1;
    this.message = 'Back to the default keys and buttons.';
    this.render();
  }

  label(value) {
    if (value >= 0x8000) return 'Game pad';
    const code = this.codeOf.get(value);
    return code ? keyName(code) : `Key ${value}`;
  }

  render() {
    if (!this.open) return;
    const current = this.bindings();
    const list = el('div', { class: 'controls-list' });
    const pick = (slot) => () => { this.stopPadWait(); this.waiting = slot; this.message = ''; this.render(); };
    list.append(el('div', { class: 'controls-row controls-cols' }, el('span', {}), el('span', {}, 'Keyboard'), el('span', {}, 'Controller')));
    current.forEach((value, slot) => {
      if (HIDDEN.has(slot)) return;
      const waiting = this.waiting === slot;
      list.append(el('div', { class: 'controls-row' },
        el('span', {}, ACTIONS[slot]),
        el('button', {
          type: 'button', class: waiting ? 'waiting' : '', 'aria-label': `${ACTIONS[slot]}: ${this.label(value)}. Change`,
          onclick: pick(slot),
        }, waiting ? 'Press a key…' : this.label(value)),
        this.padCell(PAD_ROWS[slot], ACTIONS[slot])));
    });
    const waitingScore = this.waiting === SCORE;
    list.append(el('div', { class: 'controls-row' },
      el('span', {}, SCORE_ACTION),
      el('button', {
        type: 'button', class: waitingScore ? 'waiting' : '', 'aria-label': `${SCORE_ACTION}: ${keyName(scoreboardKey())}. Change`,
        onclick: pick(SCORE),
      }, waitingScore ? 'Press a key…' : keyName(scoreboardKey())),
      this.padCell('scores', SCORE_ACTION)));
    for (const [action, label, key] of PAD_EXTRA) {
      list.append(el('div', { class: 'controls-row' },
        el('span', {}, label),
        el('button', { type: 'button', disabled: '', class: 'fixed' }, key),
        this.padCell(action, label)));
    }
    this.root.replaceChildren(el('div', { class: 'saves-panel controls-panel' },
      el('div', { class: 'saves-head' },
        el('h2', {}, 'Controls'),
        el('span', { class: 'saves-keys' }, 'Click a key or button, then press the new one. Esc cancels.'),
        el('button', { type: 'button', class: 'saves-close', 'aria-label': 'Close', onclick: () => this.close() }, '✕')),
      list,
      el('p', { class: 'saves-note', role: 'status' }, this.message || 'Menus always use the arrow keys, Enter and Esc (on a controller: the d-pad, A and B).'),
      el('div', { class: 'controls-actions' },
        el('button', { type: 'button', onclick: () => this.reset() }, 'Defaults'),
        el('button', { type: 'button', class: 'primary', onclick: () => this.close() }, 'Done'))));
  }
}
