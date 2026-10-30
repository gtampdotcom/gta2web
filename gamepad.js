// Game controllers (Xbox, DualSense, DualShock 4...) through the Gamepad API.
//
// Each frame the pad's buttons become the same KeyboardEvent codes the keyboard sends,
// so the port's default controls, the map screen and the game's menus work unchanged.
// Only pads with the browser's "standard" mapping are used.
//
// While playing, the buttons are the player's choice (the Controls screen, web/controls.js; kept
// in this browser). The d-pad and the left stick always steer, and the game's menus always use
// A / Cross to choose and B / Circle to go back.

const STICK_DEADZONE = 0.35;

// Standard mapping button indices (DualSense names).
const BUTTONS = {
  cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
  create: 8, options: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15,
};
const DPAD = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

const XBOX_NAMES = {
  cross: 'A', circle: 'B', square: 'X', triangle: 'Y', l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT',
  create: 'View', options: 'Menu', l3: 'Left stick press', r3: 'Right stick press',
};
const PLAYSTATION_NAMES = {
  cross: 'Cross', circle: 'Circle', square: 'Square', triangle: 'Triangle', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2',
  create: 'Create', options: 'Options', l3: 'L3', r3: 'R3',
};

/**
 * What the buttons do while playing: [action, default key, default button]. The keys are the
 * port's default controls (web/shell.js PORT_CONTROLS, turned into the player's own keys there)
 * and the shell's keys; SCOREBOARD is the player's scoreboard key (web/controls.js).
 */
export const SCOREBOARD = 'scoreboard';
export const PAD_ACTIONS = [
  ['forward', 'ArrowUp', 'r2'], ['back', 'ArrowDown', 'l2'],
  ['shoot', 'ControlLeft', 'cross'], ['car', 'Enter', 'triangle'], ['jump', 'Space', 'square'],
  ['prev', 'KeyZ', 'l1'], ['next', 'KeyX', 'r1'], ['special1', 'Tab', 'circle'], ['special2', 'AltLeft', 'l3'],
  ['scores', SCOREBOARD, 'r3'], ['menu', 'Escape', 'options'], ['map', 'KeyM', 'create'],
];
const PAD_STORE = 'gta2-port-pad-buttons';

/** Action -> button while playing (this browser's choices over the defaults). */
export function padBindings() {
  const out = Object.fromEntries(PAD_ACTIONS.map(([action, , button]) => [action, button]));
  try {
    const saved = JSON.parse(localStorage.getItem(PAD_STORE) || '{}');
    for (const [action, button] of Object.entries(saved || {})) {
      if (Object.hasOwn(out, action) && Object.hasOwn(XBOX_NAMES, button)) out[action] = button;
    }
  } catch { /* storage unavailable or damaged: the defaults */ }
  return out;
}

function savePadBindings(bindings) {
  try { localStorage.setItem(PAD_STORE, JSON.stringify(bindings)); } catch { /* storage unavailable: this visit only */ }
}

/**
 * Gives an action a button; an action that had the button takes this one's old button (a swap).
 * @returns {string|null} the action that was swapped, if any
 */
export function setPadBinding(action, button) {
  const bindings = padBindings();
  const other = Object.keys(bindings).find((a) => a !== action && bindings[a] === button) || null;
  if (other) bindings[other] = bindings[action];
  bindings[action] = button;
  savePadBindings(bindings);
  return other;
}

export function resetPadBindings() {
  try { localStorage.removeItem(PAD_STORE); } catch { /* storage unavailable */ }
}

/** Whether a button can be given to an action (the d-pad always steers). */
export const bindableButton = (name) => Object.hasOwn(XBOX_NAMES, name);

/** A button's name as printed on the pad: PlayStation names for Sony pads, else Xbox names. */
export function buttonLabel(name, pad = null) {
  const sony = !!pad && /054c|playstation|dualsense|dualshock/i.test(pad.id);
  return (sony ? PLAYSTATION_NAMES : XBOX_NAMES)[name] || name;
}

// In the game's menus and the map screen.
const MENU = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  cross: 'Enter', circle: 'Escape', options: 'Escape', create: 'KeyM',
  l1: 'Minus', r1: 'Equal', // map zoom
};

/** Button -> key while playing, from the player's choices. */
export function playKeys(scoreKey = () => 'Backquote') {
  const bindings = padBindings();
  const out = { ...DPAD };
  for (const [action, code] of PAD_ACTIONS) out[bindings[action]] = code === SCOREBOARD ? scoreKey() : code;
  return out;
}

export const listPads = () => (navigator.getGamepads ? [...navigator.getGamepads()] : []);

/** The first connected pad with the browser's standard layout, or null. */
export const findPad = (pads) => pads.find((p) => p && p.connected && p.mapping === 'standard') || null;

/**
 * The pad's name without the vendor and product ids the browsers add:
 * Chrome "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
 * Firefox "054c-0ce6-DualSense Wireless Controller".
 */
export function padName(pad) {
  const name = pad.id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim();
  return name || 'Controller';
}

/** Names of the pressed buttons; the left stick counts as the d-pad. */
export function pressedButtons(pad) {
  const pressed = new Set();
  for (const [name, index] of Object.entries(BUTTONS)) {
    if (pad.buttons[index] && pad.buttons[index].pressed) pressed.add(name);
  }
  const [x = 0, y = 0] = pad.axes;
  if (y < -STICK_DEADZONE) pressed.add('up');
  if (y > STICK_DEADZONE) pressed.add('down');
  if (x < -STICK_DEADZONE) pressed.add('left');
  if (x > STICK_DEADZONE) pressed.add('right');
  return pressed;
}

/** KeyboardEvent codes for the pressed buttons in the current context. */
export function codesFor(buttons, playing, scoreKey) {
  const map = playing ? playKeys(scoreKey) : MENU;
  return new Set([...buttons].map((name) => map[name]).filter(Boolean));
}

export class GamepadInput {
  /**
   * @param {(code: string, down: boolean) => void} send presses or releases a key
   * @param {() => boolean} isPlaying true while the player is in the city (not in a menu or the map)
   * @param {() => string} [scoreKey] the scoreboard's key
   */
  constructor({ send, isPlaying, getPads = listPads, onConnect = () => {}, scoreKey = () => 'Backquote' }) {
    this.send = send;
    this.isPlaying = isPlaying;
    this.getPads = getPads;
    this.onConnect = onConnect;
    this.scoreKey = scoreKey;
    this.held = new Set();
    // Buttons held across a context change: ignored until released, so the Cross that
    // confirms a menu does not also fire a shot.
    this.blocked = new Set();
    this.playing = undefined;
    // Controls screen: the next button pressed goes here instead of to the game (captureButton)
    this.capture = null;
    this.down = new Set();
  }

  start() {
    window.addEventListener('gamepadconnected', (e) => {
      this.onConnect(e.gamepad);
      this.loop();
    });
    window.addEventListener('blur', () => this.releaseAll());
    if (this.activePad()) this.loop();
  }

  /** The next button pressed (as its name) goes to `fn` instead of the game; null stops waiting. */
  captureButton(fn) {
    this.capture = fn;
    if (fn) this.releaseAll();
    // whatever is held when waiting ends stays out of the game until released
    else this.blocked = new Set(this.down);
  }

  loop() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.activePad()) {
        this.releaseAll();
        this.running = false;
        return;
      }
      this.poll();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  activePad() {
    return findPad([...this.getPads()]);
  }

  poll() {
    const pad = this.activePad();
    if (!pad || !document.hasFocus()) return;
    const buttons = pressedButtons(pad);
    const before = this.down;
    this.down = buttons;
    if (this.capture) {
      const pressed = [...buttons].find((name) => !before.has(name));
      if (pressed) this.capture(pressed, pad);
      return;
    }
    const playing = this.isPlaying();
    if (playing !== this.playing) {
      if (this.playing !== undefined) this.blocked = new Set(buttons);
      this.playing = playing;
    }
    for (const name of this.blocked) if (!buttons.has(name)) this.blocked.delete(name);
    const active = [...buttons].filter((name) => !this.blocked.has(name));
    this.apply(codesFor(active, playing, this.scoreKey));
  }

  /** Sends the presses and releases that turn the held keys into `codes`. */
  apply(codes) {
    for (const code of this.held) if (!codes.has(code)) this.send(code, false);
    for (const code of codes) if (!this.held.has(code)) this.send(code, true);
    this.held = codes;
  }

  releaseAll() {
    this.apply(new Set());
  }
}
