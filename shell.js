// Browser shell for the GTA2 port: loads the player's own game files into the
// in-memory filesystem, wires input and the renderer, and starts the core.
// No game file leaves the device (R01); nothing is fetched from the network
// except the port itself, or local files in ?devdata=1 developer mode.
import createGta2 from './gta2.js';
import { SAVE_KEY, SaveStates, exportSaves, importSaves, listSaves, toast } from './savestate.js';
import { SavesScreen, describe } from './saves.js';
import { GhostRace } from './ghosts.js';
import { ControlsScreen, scoreboardKey } from './controls.js';
import { OptionsScreen } from './options.js';
import { LANG_KEY, applyMapText, prepareGameLanguage, savedLang } from './gamelang.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Gta2Renderer } from './renderer.js';
import { SaveStorage } from './storage.js';
import { Gta2Audio } from './audio.js';
import { GameFileCache, MapFileCache, downloadFreeware, gunzip, unpackInstallerFile } from './gamefiles.js';
import { Gta2Map, exportDiscovery, importDiscovery } from './map.js';
import { hideLanding, landingProgress, showContinue, showLanding, showLeaderboard } from './landing.js';
import { count, initStats, startPlayClock } from './stats.js';
import { CoopChat } from './chat.js';
import { GamepadInput } from './gamepad.js';
import { CoopLobby, DISTRICTS, GANGS, LocalTransport, MAX_PLAYERS, MODES, RoomDirectory, ServerTransport, WebRtcTransport, isGhostRace, loadMaps, roomSize } from './net.js';

const GAME_DIR = '/gta2';
// Minimum set for the first district; a full profile check is T07's job.
const REQUIRED = ['data/bil.gmp', 'data/bil.sty', 'data/bil.scr', 'data/fstyle.sty', 'data/e.gxt'];
// Bump when saved settings from older builds must not be reused.
const SETTINGS_KEY = 'gta2-port-registry-v3';
const REG_ROOT = 'hklm\\software\\dma design ltd\\gta2';

// Default controls (DirectInput scan codes), in the game's slot order: the original GTA2's own.
// Players can change any of these on the Controls screen (Options in the game's menu, or the
// toolbar's Controls button; web/controls.js). Web/gamepad.js presses these keys.
const PORT_CONTROLS = [
  0xc8, // 0 forward: Up
  0xd0, // 1 back: Down
  0xcb, // 2 left: Left
  0xcd, // 3 right: Right
  0x1d, // 4 attack: Left Ctrl
  0x1c, // 5 enter/exit vehicle: Enter
  0x39, // 6 jump / handbrake: Space
  0x2c, // 7 previous weapon: Z
  0x2d, // 8 next weapon: X
  0x0f, // 9 special 1: Tab
  0x38, // 10 special 2: Left Alt
  0x36, // 11 status: Right Shift
];
// The defaults of earlier versions (W A S D, L, J K, I O P): a player still on exactly these gets
// the new ones; anyone who changed a key keeps their own.
const OLD_PORT_CONTROLS = [0x11, 0x1f, 0x1e, 0x20, 0x26, 0x1c, 0x39, 0x24, 0x25, 0x17, 0x18, 0x19];

// KeyboardEvent.code -> [DirectInput scan code, Win32 virtual key]
const KEYS = {
  Escape: [0x01, 0x1b], Digit1: [0x02, 0x31], Digit2: [0x03, 0x32], Digit3: [0x04, 0x33], Digit4: [0x05, 0x34],
  Digit5: [0x06, 0x35], Digit6: [0x07, 0x36], Digit7: [0x08, 0x37], Digit8: [0x09, 0x38], Digit9: [0x0a, 0x39],
  Digit0: [0x0b, 0x30], Minus: [0x0c, 0xbd], Equal: [0x0d, 0xbb], Backspace: [0x0e, 0x08], Tab: [0x0f, 0x09],
  KeyQ: [0x10, 0x51], KeyW: [0x11, 0x57], KeyE: [0x12, 0x45], KeyR: [0x13, 0x52], KeyT: [0x14, 0x54],
  KeyY: [0x15, 0x59], KeyU: [0x16, 0x55], KeyI: [0x17, 0x49], KeyO: [0x18, 0x4f], KeyP: [0x19, 0x50],
  BracketLeft: [0x1a, 0xdb], BracketRight: [0x1b, 0xdd], Enter: [0x1c, 0x0d], ControlLeft: [0x1d, 0x11],
  KeyA: [0x1e, 0x41], KeyS: [0x1f, 0x53], KeyD: [0x20, 0x44], KeyF: [0x21, 0x46], KeyG: [0x22, 0x47],
  KeyH: [0x23, 0x48], KeyJ: [0x24, 0x4a], KeyK: [0x25, 0x4b], KeyL: [0x26, 0x4c], Semicolon: [0x27, 0xba],
  Quote: [0x28, 0xde], Backquote: [0x29, 0xc0], ShiftLeft: [0x2a, 0x10], Backslash: [0x2b, 0xdc],
  KeyZ: [0x2c, 0x5a], KeyX: [0x2d, 0x58], KeyC: [0x2e, 0x43], KeyV: [0x2f, 0x56], KeyB: [0x30, 0x42],
  KeyN: [0x31, 0x4e], KeyM: [0x32, 0x4d], Comma: [0x33, 0xbc], Period: [0x34, 0xbe], Slash: [0x35, 0xbf],
  ShiftRight: [0x36, 0x10], NumpadMultiply: [0x37, 0x6a], AltLeft: [0x38, 0x12], Space: [0x39, 0x20],
  CapsLock: [0x3a, 0x14], F1: [0x3b, 0x70], F2: [0x3c, 0x71], F3: [0x3d, 0x72], F4: [0x3e, 0x73],
  F5: [0x3f, 0x74], F6: [0x40, 0x75], F7: [0x41, 0x76], F8: [0x42, 0x77], F9: [0x43, 0x78], F10: [0x44, 0x79],
  NumLock: [0x45, 0x90], ScrollLock: [0x46, 0x91], Numpad7: [0x47, 0x67], Numpad8: [0x48, 0x68],
  Numpad9: [0x49, 0x69], NumpadSubtract: [0x4a, 0x6d], Numpad4: [0x4b, 0x64], Numpad5: [0x4c, 0x65],
  Numpad6: [0x4d, 0x66], NumpadAdd: [0x4e, 0x6b], Numpad1: [0x4f, 0x61], Numpad2: [0x50, 0x62],
  Numpad3: [0x51, 0x63], Numpad0: [0x52, 0x60], NumpadDecimal: [0x53, 0x6e], F11: [0x57, 0x7a],
  F12: [0x58, 0x7b], NumpadEnter: [0x9c, 0x0d], ControlRight: [0x9d, 0x11], NumpadDivide: [0xb5, 0x6f],
  AltRight: [0xb8, 0x12], Home: [0xc7, 0x24], ArrowUp: [0xc8, 0x26], PageUp: [0xc9, 0x21],
  ArrowLeft: [0xcb, 0x25], ArrowRight: [0xcd, 0x27], End: [0xcf, 0x23], ArrowDown: [0xd0, 0x28],
  PageDown: [0xd1, 0x22], Insert: [0xd2, 0x2d], Delete: [0xd3, 0x2e],
};

const $ = (id) => document.getElementById(id);

// Uncaught errors from the core are kept (window.gta2Errors) and shown, so a
// crash is visible instead of a frozen frame.
window.gta2Errors = [];
window.gta2Log = [];
function logLine(t) {
  window.gta2Log.push(t);
  if (window.gta2Log.length > 300) window.gta2Log.shift();
}
function recordError(err) {
  const text = (err && (err.stack || err.message)) || String(err);
  window.gta2Errors.push(text);
  setStatus(`The game stopped with an error: ${String(err && err.message || err).slice(0, 160)}`, true);
}
window.addEventListener('error', (e) => recordError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => recordError(e.reason));

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** @returns {Map<string, File|Blob>} game files keyed by lowercased relative path. */
function collectPickedFiles(fileList) {
  const files = new Map();
  for (const file of fileList) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    // Drop the picked folder's own name; accept picking the folder that holds data/.
    const rel = parts.slice(1).join('/').toLowerCase();
    // The port never needs the original executables or DLLs.
    if (rel && !/\.(exe|dll|m3d|ico)$/.test(rel)) files.set(rel, file);
  }
  return files;
}

/**
 * The game files served at gamedata/: the local dev server's list of paths, or
 * our game server's {version, files: [[path, bytes]]} (D21), with progress in MB.
 */
async function collectDevFiles(onProgress = (text) => setStatus(text)) {
  let manifest;
  try {
    const res = await fetch('gamedata/manifest.json', { cache: 'no-store' });
    if (res.redirected && new URL(res.url).pathname === '/login') {
      throw new Error('your login has expired. Open the invite link again, or enter the password');
    }
    manifest = await res.json().catch(() => ({}));
    if (!res.ok || manifest.error) throw new Error(manifest.error || `the server answered ${res.status}`);
  } catch (err) {
    throw new Error(err instanceof TypeError ? 'the game server could not be reached. Check your connection and reload'
      : err.message);
  }
  // [path, size] or, packed by scripts/pack_site.py, [path, size, packed size]: fetch <path>.gz and unpack it here
  const list = Array.isArray(manifest) ? manifest.map((rel) => [rel, 0]) : manifest.files;
  const total = list.reduce((sum, [, size, packed]) => sum + (packed || size), 0);
  const files = new Map();
  let done = 0;
  let bytes = 0;
  const mb = (n) => Math.round(n / 1048576);
  // a few at a time, so the progress moves steadily and big files are not all fetched at once
  const queue = [...list];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [rel, size, packed] = item;
      let res;
      try {
        res = await fetch(`gamedata/${rel.split('/').map(encodeURIComponent).join('/')}${packed ? '.gz' : ''}`);
      } catch {
        throw new Error('the download was interrupted. Check your connection and reload the page');
      }
      if (!res.ok) throw new Error(`the server could not send ${rel} (error ${res.status})`);
      files.set(rel.toLowerCase(), packed ? new Blob([await gunzip(new Uint8Array(await res.arrayBuffer()))]) : await res.blob());
      done++;
      bytes += packed || size;
      onProgress(total ? `Getting GTA2 ready… ${mb(bytes)} of ${mb(total)} MB` : `Loading game files… ${done}/${list.length}`, total ? bytes / total : done / list.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return files;
}

function validate(files) {
  const missing = REQUIRED.filter((p) => !files.has(p));
  if (missing.length) {
    throw new Error(`That folder is not a GTA2 installation. Missing: ${missing.join(', ')}. ` +
      'Pick the folder that contains the "data" folder.');
  }
}

async function writeFiles(Module, files) {
  const FS = Module.FS;
  FS.mkdirTree(`${GAME_DIR}/player`);
  let done = 0;
  for (const [rel, blob] of files) {
    const path = `${GAME_DIR}/${rel}`;
    FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    FS.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    if (++done % 25 === 0) setStatus(`Preparing game files… ${done}/${files.size}`);
  }
}

/**
 * Width of gameplay frames in reference pixels (the height is always 480).
 * Default 16:9. ?aspect=W:H picks another shape (?aspect=4:3 is the original
 * view); ?aspect=auto follows the window (wireViewWidth). The core clamps it
 * to 640..1280.
 */
/** A saved option (landing page Options), unless the URL sets it for this visit. */
function option(param, key, fallback) {
  const fromUrl = new URLSearchParams(location.search).get(param);
  if (fromUrl !== null) return fromUrl;
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
let ASPECT = option('aspect', 'gta2-port-aspect', '16:9');
function chooseViewWidth(canvas) {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ASPECT);
  const rect = canvas.getBoundingClientRect();
  const aspect = m ? Number(m[1]) / Number(m[2]) : rect.width / Math.max(1, rect.height);
  return Math.round(480 * aspect);
}

/** Keeps the gameplay view as wide as the canvas (window resize, full screen) with Fill window. */
function wireViewWidth(Module, canvas) {
  let timer = 0;
  new ResizeObserver(() => {
    if (ASPECT !== 'auto') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      Module.ccall('gta2_port_set_view_width', 'number', ['number'], [chooseViewWidth(canvas)]);
    }, 150);
  }).observe(canvas);
}

const CAMERA_KEY = 'gta2-port-camera';

/** Camera: Modern / Classic button. ?camera=classic|modern sets it for this visit. */
const VIEW_KEY = 'gta2-port-view-distance';
const VIEWS = ['Normal', 'Far', 'Farther', 'Farthest'];

/**
 * Camera: Modern / Classic button, and the view distance (Modern camera only):
 * how far above the original height the camera sits, in blocks (0, 1.5, 3, 4).
 * More of the city is drawn; the activation margin keeps spawning off screen.
 * ?camera=classic|modern and ?heightbias=N set them for this visit.
 */
function wireCameraButton(Module) {
  const button = $('camera');
  const viewButton = $('view-distance');
  const params = new URLSearchParams(location.search);
  const HEIGHTS = [0, 1.5, 3, 4];
  let view = 0;
  try { view = Math.max(0, Math.min(3, Number(localStorage.getItem(VIEW_KEY)) || 0)); } catch { /* storage unavailable */ }
  let bias = HEIGHTS[view];
  if (params.has('heightbias')) bias = Number(params.get('heightbias')) || 0;
  let mode = params.get('camera');
  if (mode !== 'classic' && mode !== 'modern') {
    try { mode = localStorage.getItem(CAMERA_KEY); } catch { /* storage unavailable */ }
  }
  let modern = mode !== 'classic';
  const apply = () => {
    Module.ccall('gta2_port_set_camera', null, ['number', 'number'], [modern ? 1 : 0, bias]);
    button.textContent = modern ? 'Camera: Modern' : 'Camera: Classic';
    viewButton.textContent = `View: ${VIEWS[view]}`;
    viewButton.disabled = !modern;
    viewButton.title = modern ? 'How much of the city you see (− / = keys)' : 'View distance needs the Modern camera';
  };
  const setView = (v) => {
    view = Math.max(0, Math.min(3, v));
    bias = HEIGHTS[view];
    try { localStorage.setItem(VIEW_KEY, String(view)); } catch { /* storage unavailable */ }
    apply();
  };
  viewButton.addEventListener('click', () => { setView((view + 1) % 4); $('screen').focus(); });
  // − and = while playing (unused by the game): view distance out / in.
  viewKeys.handle = (e, down) => {
    if (e.code !== 'Minus' && e.code !== 'Equal') return false;
    if (down && !e.repeat && modern) {
      setView(view + (e.code === 'Minus' ? 1 : -1));
      setStatus(`View: ${VIEWS[view]}`);
      clearTimeout(viewKeys.timer);
      viewKeys.timer = setTimeout(() => setStatus(''), 1200);
    }
    return true;
  };
  button.addEventListener('click', () => {
    modern = !modern;
    try { localStorage.setItem(CAMERA_KEY, modern ? 'modern' : 'classic'); } catch { /* storage unavailable */ }
    apply();
    $('screen').focus();
  });
  apply();
}

function wireMapButtons(map) {
  $('map-open').addEventListener('click', () => {
    if (map.open) map.close();
    else if (!map.show()) setStatus('The map opens during play.');
  });
  const mini = $('minimap-toggle');
  const apply = () => {
    mini.setAttribute('aria-pressed', String(map.minimapOn));
    mini.textContent = map.minimapOn ? 'Minimap' : 'Minimap off';
  };
  mini.addEventListener('click', () => { map.setMinimap(!map.minimapOn); apply(); $('screen').focus(); });
  apply();
}

const FPS_KEY = 'gta2-port-show-fps';

/** Frame-rate readout (frames presented per second, as the game draws them). */
function wireFpsButton(renderer) {
  const button = $('fps-toggle');
  const out = $('fps');
  let shown = false;
  try { shown = localStorage.getItem(FPS_KEY) === '1'; } catch { /* storage unavailable */ }
  let timer = 0;
  let last = { t: performance.now(), frames: renderer.stats.frames };
  const sample = () => {
    const now = performance.now();
    const frames = renderer.stats.frames;
    const fps = ((frames - last.frames) * 1000) / Math.max(1, now - last.t);
    last = { t: now, frames };
    out.textContent = `${fps.toFixed(0)} fps`;
  };
  const apply = () => {
    out.hidden = !shown;
    button.setAttribute('aria-pressed', String(shown));
    clearInterval(timer);
    if (shown) {
      last = { t: performance.now(), frames: renderer.stats.frames };
      out.textContent = '… fps';
      timer = setInterval(sample, 500);
    }
  };
  button.addEventListener('click', () => {
    shown = !shown;
    try { localStorage.setItem(FPS_KEY, shown ? '1' : '0'); } catch { /* storage unavailable */ }
    apply();
    $('screen').focus();
  });
  apply();
}

/** Full screen for the whole page (the game view and the tools bar). */
/**
 * Full screen for the page: the toolbar's button, also in the touch menu. iPhone Safari has no full
 * screen for pages; there it is faked as WebMSX does: the page is made taller than the screen and
 * the game pinned to what is visible, so swiping up on the game slides Safari's bars away
 * (index.html, html.scroll-full). Started from the home screen, the game already has the screen.
 */
const fullScreen = {
  api: () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen),
  standalone: () => !!(navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)),
  supported: () => !fullScreen.standalone() && (fullScreen.api() || isTouchDevice()),
  isFull: () => !!(document.fullscreenElement || document.webkitFullscreenElement) || document.documentElement.classList.contains('scroll-full'),
  async toggle() {
    const root = document.documentElement;
    if (!fullScreen.api()) {
      // iPhone: the page grows and the player swipes the browser's bars away
      const on = !root.classList.contains('scroll-full');
      root.classList.toggle('scroll-full', on);
      window.scrollTo(0, on ? 1 : 0);
      if (on) toast('Swipe up on the game to hide the browser bars.');
      document.dispatchEvent(new Event('fullscreenchange'));
      return;
    }
    try {
      if (fullScreen.isFull()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else {
        await (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
        // Chromium: keep Esc for the game's menu (hold Esc to leave full screen).
        if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
      }
    } catch (err) {
      setStatus(`Full screen is not available here (${err.message || err}).`, true);
    }
    $('screen').focus();
  },
};

function wireFullscreenButton() {
  const button = $('fullscreen');
  if (!fullScreen.supported()) { button.hidden = true; return; } // (shown again for touch screens: touch menu)
  button.addEventListener('click', () => fullScreen.toggle());
  const update = () => { button.textContent = fullScreen.isFull() ? 'Exit full screen' : 'Full screen'; };
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);
  update();
}

function seedRegistry(Module, langLetter = 'e') {
  const setDword = Module.cwrap('gta2_port_reg_set_dword', null, ['string', 'string', 'number']);
  const setString = Module.cwrap('gta2_port_reg_set_string', null, ['string', 'string', 'string']);
  // Defaults for the browser: windowed 640x480 reference, no intro movie (Bink
  // playback is not wired up yet), sound path enabled (silent for now).
  setDword(`${REG_ROOT}\\screen`, 'start_mode', 0);
  PORT_CONTROLS.forEach((scan, slot) => setDword(`${REG_ROOT}\\control`, String(slot), scan));
  // The 10.5 code is the freeloader.com edition, which unlocked districts via
  // this value (0-based; 2 = all three). The 9.6F release ships all three.
  setDword('hklm\\software\\freeloader.com\\gta2', 'cityinstalled', 2);
  // Developer switch (?skiptrains=1) while the standalone train crash is fixed.
  setDword(`${REG_ROOT}\\debug`, 'skip_trains', new URLSearchParams(location.search).has('skiptrains') ? 1 : 0);
  setDword(`${REG_ROOT}\\screen`, 'do_play_movie', 0);
  try {
    // Developer option (?fresh=1): ignore saved settings.
    const saved = new URLSearchParams(location.search).has('fresh') ? '' : localStorage.getItem(SETTINGS_KEY);
    const controls = [];
    for (const line of (saved || '').split('\n')) {
      const [path, name, type, ...rest] = line.split('|');
      if (!path || !name) continue;
      if (type === 'd') setDword(path, name, Number(rest.join('|')) >>> 0);
      else if (type === 's') setString(path, name, rest.join('|'));
      if (type === 'd' && path.toLowerCase() === `${REG_ROOT}\\control`) controls[Number(name)] = Number(rest.join('|')) >>> 0;
    }
    if (OLD_PORT_CONTROLS.every((scan, slot) => controls[slot] === scan)) {
      PORT_CONTROLS.forEach((scan, slot) => setDword(`${REG_ROOT}\\control`, String(slot), scan));
    }
  } catch { /* storage unavailable: defaults only */ }
  // Never persisted: the movie stays off until video playback exists.
  setDword(`${REG_ROOT}\\screen`, 'do_play_movie', 0);
  // The Options screen's game language (web/gamelang.js), over anything saved
  setString(`${REG_ROOT}\\option`, 'language', langLetter);
  // The game's own car handling (data/nyc.gci) unless a community map names its own (setupCoop)
  setString(`${REG_ROOT}\\debug`, 'carname', '');
}

function saveRegistry(Module) {
  try {
    localStorage.setItem(SETTINGS_KEY, Module.ccall('gta2_port_reg_export', 'string', [], []));
  } catch { /* storage unavailable */ }
}

// Shell features that take keys before the game does (the map screen, view distance).
const keyHooks = { filter: null };
const viewKeys = { handle: null, timer: 0 };

/** Wires the keyboard; returns the key handler so other inputs (the gamepad) can press keys. */
function wireInput(Module, canvas) {
  const key = Module.cwrap('gta2_port_key', null, ['number', 'number', 'number', 'number']);
  const releaseAll = Module.cwrap('gta2_port_release_all_keys', null, []);
  const handleKey = (e, down) => {
    if (keyHooks.filter && keyHooks.filter(e, down)) {
      e.preventDefault();
      return;
    }
    const map = KEYS[e.code];
    if (!map) return;
    e.preventDefault();
    if (down && e.repeat) return;
    const ch = down && e.key.length === 1 ? e.key.charCodeAt(0) : 0;
    key(map[0], map[1], down ? 1 : 0, ch);
  };
  window.addEventListener('keydown', (e) => handleKey(e, true));
  window.addEventListener('keyup', (e) => handleKey(e, false));
  window.addEventListener('blur', () => releaseAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  return handleKey;
}

/**
 * Presses a default key for the game pad or the touch controls: while playing, the key the player
 * bound to that action instead (remap). A key's release lets go of the same key it pressed.
 */
function keySender(handleKey, isPlaying, remap = (code) => code) {
  const held = new Map(); // a key when pressed, so its release lets go of the same key
  return (code, down) => {
    let key = held.get(code);
    if (down || key === undefined) key = isPlaying() ? remap(code) : code;
    if (down) held.set(code, key); else held.delete(code);
    handleKey(syntheticKey(key), down);
  };
}

/** A key press from the gamepad, shaped like the KeyboardEvent the key hooks read. */
function syntheticKey(code) {
  return { code, key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} };
}

// remap: the controller presses the default keys; this gives the key the player bound instead.
function wireGamepad(handleKey, isPlaying, remap = (code) => code) {
  const send = keySender(handleKey, isPlaying, remap);
  const gamepad = new GamepadInput({
    send,
    isPlaying,
    scoreKey: scoreboardKey,
    onConnect: (pad) => toast(pad.mapping === 'standard' ? 'Controller connected' : 'This controller is not supported by the browser', pad.mapping !== 'standard'),
  });
  gamepad.start();
  return gamepad;
}

// Developer helpers (window.gta2.dev) for automated tests in ?devdata mode.
function installDevHelpers(Module) {
  const key = Module.cwrap('gta2_port_key', null, ['number', 'number', 'number', 'number']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.gta2.dev = {
    state() {
      const p = Module.ccall('gta2_dev_state', 'number', [], []);
      const v = Array.from(new Int32Array(Module.HEAPU8.buffer, p, 10));
      const fx = (n) => Math.round((n / 16384) * 100) / 100;
      return { player: !!v[0], inCar: !!v[1], x: fx(v[2]), y: fx(v[3]), z: fx(v[4]), speed: fx(v[5]), carModel: v[6], rot: v[7], weapon: v[8], ammo: v[9] };
    },
    spawnCar(model = 10, dx = 1, dy = 0, rot = 0) {
      return Module.ccall('gta2_dev_spawn_car', 'number', ['number', 'number', 'number', 'number'], [model, dx, dy, rot]);
    },
    giveWeapon(kind = 0, ammo = 100) {
      return Module.ccall('gta2_dev_give_weapon', 'number', ['number', 'number'], [kind, ammo]);
    },
    camera() {
      const p = Module.ccall('gta2_dev_camera', 'number', [], []);
      const v = Array.from(Module.HEAP32.subarray(p >> 2, (p >> 2) + 11));
      const f = (x) => Math.round((x / 16384) * 100) / 100;
      return { x: f(v[0]), y: f(v[1]), z: f(v[2]), zoom: f(v[3]), left: f(v[4]), right: f(v[5]),
        top: f(v[6]), bottom: f(v[7]), width: v[8], height: v[9], drawnZ: f(v[10]) };
    },
    teleport(x, y) {
      return Module.ccall('gta2_dev_teleport', 'number', ['number', 'number'], [x, y]);
    },
    findRoad() {
      const p = Module.ccall('gta2_dev_find_road', 'number', [], []);
      const [x, y, z, length, alongY] = Array.from(Module.HEAP32.subarray(p >> 2, (p >> 2) + 5));
      return { x, y, z, length, alongY: !!alongY };
    },
    addCash(n) {
      return Module.ccall('gta2_dev_add_cash', 'number', ['number'], [n]);
    },
    files(dir = 'player') {
      try { return Module.FS.readdir(`${GAME_DIR}/${dir}`).filter((f) => f[0] !== '.'); } catch { return []; }
    },
    async hold(code, ms) {
      const [sc, vk] = KEYS[code];
      key(sc, vk, 1, 0);
      await sleep(ms);
      key(sc, vk, 0, 0);
    },
    sleep,
  };
}

const MUTE_KEY = 'gta2-port-muted';

function wireAudioButton(audio) {
  const button = $('mute');
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage unavailable */ }
  const apply = () => {
    audio.setMuted(muted);
    button.textContent = muted ? 'Unmute' : 'Mute';
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage unavailable */ }
  };
  button.addEventListener('click', () => { muted = !muted; apply(); });
  apply();
}

const RADIO_KEY = 'gta2-port-radio';

/**
 * Radio keys: R turns the car radio on or off (kept in this browser); T is the game's own
 * F1, the next station (single player; in co-op T opens the chat). Returns the key filter.
 */
function wireRadioKeys(Module, audio, coop) {
  const key = Module.cwrap('gta2_port_key', null, ['number', 'number', 'number', 'number']);
  let on = true;
  try { on = localStorage.getItem(RADIO_KEY) !== '0'; } catch { /* storage unavailable */ }
  audio.setRadio(on);
  return (e, down) => {
    const mod = e.metaKey || e.ctrlKey || e.altKey;
    if (e.code === 'KeyR' && !mod) {
      if (down && !e.repeat) {
        on = !on;
        audio.setRadio(on);
        try { localStorage.setItem(RADIO_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
        toast(on ? 'Radio on' : 'Radio off (R to turn it back on)');
      }
      return true;
    }
    if (e.code === 'KeyT' && !mod && !coop) {
      if (!e.repeat) key(KEYS.F1[0], KEYS.F1[1], down ? 1 : 0, 0); // the game changes station on F1
      return true;
    }
    return false;
  };
}

/**
 * The toolbar fades out (and the pointer hides over the game) after a while without the mouse
 * moving; moving it brings them back (index.html, body.tools-idle).
 */
function wireToolsAutoHide(idleMs = 2500) {
  let timer = 0;
  const wake = () => {
    document.body.classList.remove('tools-idle');
    clearTimeout(timer);
    timer = setTimeout(() => document.body.classList.add('tools-idle'), idleMs);
  };
  for (const type of ['mousemove', 'mousedown', 'wheel']) window.addEventListener(type, wake, { passive: true });
  wake();
}

function wireSaveButtons(storage) {
  $('tools').hidden = false;
  wireToolsAutoHide();
  $('export-saves').addEventListener('click', async () => {
    storage.flush();
    if (window.gta2 && window.gta2.map) window.gta2.map.saveSeen(); // the latest discovery
    // the game's own saves, the Saves screen's saves and the map's discovery, in one file
    const blob = await storage.exportAll({ states: await exportSaves(), map: exportDiscovery() });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gta2-saves-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('import-saves').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const n = await storage.importAll(parsed);
      const states = await importSaves(parsed.states);
      const districts = importDiscovery(parsed.map);
      setStatus(`Imported ${n} game save file(s), ${states} Saves-screen save(s) and map progress for ` +
        `${districts} district(s). Reload the page to use them.`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });
}

const fileCache = new GameFileCache();

/** After a successful start from a picked folder: keep the files for next time. */
async function cachePickedFiles(files) {
  try {
    setStatus('Saving the game files in this browser for next time…');
    const bytes = await fileCache.save(files);
    setStatus(`Game files saved in this browser (${Math.round(bytes / 1048576)} MB), so next time it starts straight away.`);
  } catch (err) {
    setStatus(`Could not keep the game files in this browser (${err.message || err}); ` +
      'you will need to choose the folder again next time.', true);
  }
  setTimeout(() => setStatus(''), 6000);
}

// maps/index.json (scripts/pack_site.py): each packed map file's content hash; {} for files as they are
let mapIndex = null;
const mapFiles = new MapFileCache();

/** A file's content hash as maps/index.json gives it (sha-256, first 16 hex digits), or null where unavailable. */
async function contentHash(bytes) {
  if (!(globalThis.crypto && crypto.subtle)) return null; // (not on plain http pages other than localhost)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One community map file: from this browser's copy, or downloaded (packed: <file>.gz) and kept.
 * The download's address carries the file's hash (?v=), so a map replaced under the same name (the
 * admin page) is never served from an old cached download; a stored copy that does not match its
 * hash (kept before that) is downloaded again.
 */
async function mapFile(dir, name) {
  mapIndex ||= fetch('maps/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const hash = (await mapIndex)[`${dir.replace(/^maps\//, '')}/${name}`];
  const key = hash && `${dir}/${name}#${hash}`;
  const stored = key ? await mapFiles.get(key) : null;
  let data = stored ? await gunzip(stored) : null;
  if (data && hash) {
    const have = await contentHash(data);
    if (have !== null && have !== hash) data = null; // an older version kept under this one's name
  }
  let downloaded = 0;
  if (!data) {
    const res = await fetch(`${dir}/${name}${hash ? `.gz?v=${hash}` : ''}`, hash ? {} : { cache: 'no-cache' });
    if (!res.ok) throw new Error(`error ${res.status}`);
    const packed = new Uint8Array(await res.arrayBuffer());
    downloaded = packed.length;
    data = await gunzip(packed);
    const got = hash ? await contentHash(data) : null;
    if (got !== null && got !== hash) console.warn(`${dir}/${name}: the download does not match maps/index.json`);
    else if (key) await mapFiles.put(key, packed);
  }
  return { data, downloaded };
}

/** A bundled community map (not part of the GTA2 install): fetched from the site (once) into the game's data folder. */
async function writeMapFiles(Module, d) {
  let bytes = 0;
  for (const [i, name] of d.files.entries()) {
    setStatus(`Loading the ${d.label} map… file ${i + 1} of ${d.files.length}` + (bytes ? `, ${bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`} downloaded` : ''));
    let file;
    try {
      file = await mapFile(d.dir, name);
    } catch (err) {
      throw new Error(`Could not load the ${d.label} map (${name}: ${err.message || err}).`);
    }
    const { data } = file;
    bytes += file.downloaded;
    const path = `${GAME_DIR}/data/${name}`;
    Module.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    Module.FS.writeFile(path, data);
  }
  // the map's own text (maps.json gxt), over the game's in this match only
  if (d.gxt) {
    try { applyMapText(Module.FS, GAME_DIR, d.gxt); } catch (err) { console.warn(`${d.label}: its text could not be used:`, err); }
  }
  // A custom style without its own sound files (<style>.raw/.sdt) borrows ste.raw/ste.sdt, as in vike's GTA2
  // (or the bank maps.json names: Death Valley's are copies of bil's).
  const FS = Module.FS;
  const style = d.sty.replace(/\.sty$/i, '').toLowerCase();
  for (const ext of ['raw', 'sdt']) {
    const own = `${GAME_DIR}/data/audio/${style}.${ext}`;
    const borrowed = `${GAME_DIR}/data/audio/${d.sounds || 'ste'}.${ext}`;
    if (!FS.analyzePath(own).exists && FS.analyzePath(borrowed).exists) FS.writeFile(own, FS.readFile(borrowed));
  }
}

// A tag game without a time limit gets this one (its winner is whoever was "it" longest).
const TAG_MINUTES = 10;

/**
 * Co-op (D20): sets up the core's network session and the original multiplayer
 * map for the district, and connects the core to the lobby's transport.
 */
async function setupCoop(Module, coop) {
  const { lobby, district, players, mySlot, delay, friendlyFire, mode = 'roam', crews = [] } = coop;
  const d = DISTRICTS[district];
  if (d.dir) await writeMapFiles(Module, d);
  // the map's own car handling (its mmp's GCIFile, a GTA2 11.44 feature): 10.5 loads data/nyc.gci,
  // or the file its debug "carname" setting names
  if (d.handling) Module.ccall('gta2_port_reg_set_string', null, ['string', 'string', 'string'], [`${REG_ROOT}\\debug`, 'carname', d.handling]);
  // the host's lighting: noon is full daylight, dusk the map's own (community maps start at dusk)
  Module.ccall('gta2_port_set_noon', null, ['number'], [lobby.settings.lighting === 'dusk' ? 0 : 1]);
  // a ghost race (web/ghosts.js): this player's own one-player game, the others drawn as ghosts
  const ghost = isGhostRace(coop.pacing);
  const seats = ghost ? [players[mySlot]] : players;
  // lockstep, or host-paced (the host's choice; net_web.cpp): before the session is set up
  if (Module._gta2_port_net_set_pacing) Module.ccall('gta2_port_net_set_pacing', null, ['number'], [coop.pacing === 'host' ? 1 : 0]);
  Module.ccall('gta2_port_net_configure', null, ['number', 'number', 'number'], [seats.length, ghost ? 0 : mySlot, ghost ? 0 : delay]);
  // the mode's rules: free-for-all is the original frag game; Gang Wars and free roam a points game
  // (Gang Wars scored per crew by the shell); friendly fire everywhere in free-for-all, by crew in Gang Wars
  // everyone against everyone (frag, points and tag games): friendly fire on, no riding together
  const solo = ['ffa', 'points', 'tag'].includes(mode);
  Module.ccall('gta2_port_set_friendly_fire', null, ['number'], [solo || (mode === 'roam' && friendlyFire) ? 1 : 0]);
  if (Module._gta2_port_net_set_police) Module.ccall('gta2_port_net_set_police', null, ['number'], [coop.police ? 1 : 0]);
  Module.ccall('gta2_port_net_set_rules', null, ['number', 'number', 'number'],
    [{ ffa: 1, points: 2, tag: 3 }[mode] || 2, mode === 'ffa' ? coop.killLimit || 0 : mode === 'points' ? coop.pointsTarget || 0 : 0,
      // tag counts time as "it" only against a time limit: 10 minutes when none is set
      mode === 'roam' ? 0 : mode === 'tag' ? coop.minutes || TAG_MINUTES : coop.minutes || 0]);
  // riding together: anyone in free roam, your crew in Gang Wars, nobody in free-for-all
  Module.ccall('gta2_port_set_ride_together', null, ['number'], [ghost ? 0 : mode === 'roam' ? 1 : mode === 'wars' ? 2 : 0]);
  seats.forEach((p, i) => {
    const crew = mode === 'wars' ? crews.findIndex((c) => c.members.includes(p.id)) : -1;
    Module.ccall('gta2_port_set_player_team', null, ['number', 'number', 'string'], [i, crew, crew >= 0 ? crews[crew].side : '']);
  });
  Module.ccall('gta2_port_net_set_map', null, ['string', 'string', 'string'], [d.gmp, d.sty, d.scr(seats.length)]);
  seats.forEach((p, i) => Module.ccall('gta2_port_net_set_name', null, ['number', 'string'], [i, p.name.replace(/[^\x20-\x7e]/g, '?')]));
  // Every player must simulate identically: the presentation-only activation margin (D07/D17)
  // depends on each player's window and camera, so it is off in co-op.
  Module.ccall('gta2_port_set_activation_margin', null, ['number'], [0]);
  const receive = Module.cwrap('gta2_port_net_receive', null, ['number', 'number', 'number']);
  Module.gta2Net = { send: (to, bytes) => lobby.sendGame(to, bytes) };
  lobby.onGameMessage = (slot, bytes) => {
    const ptr = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, ptr);
    receive(slot, ptr, bytes.length);
    Module._free(ptr);
  };
  if (ghost && Module._gta2_port_ghost_set) {
    // horns and burps come from the level's sound bank (a custom style without one borrows ste's)
    const bank = `${GAME_DIR}/data/audio/${d.sty.replace(/\.sty$/i, '').toLowerCase()}`;
    coop.ghosts = new GhostRace({ Module, lobby, audio: window.gta2 && window.gta2.audio, bank, solid: coop.pacing === 'solid' });
    lobby.onPlayerLeft = (slot) => coop.ghosts.remove(slot);
  } else {
    lobby.onPlayerLeft = (slot) => Module.ccall('gta2_port_net_peer_left', null, ['number'], [slot]);
  }
  lobby.gameReady();
  watchCoop(Module, coop);
  // Developer option (?syncdump=N): capture every sprite at game tick N, for desync hunting.
  const dumpAt = new URLSearchParams(location.search).get('syncdump');
  if (dumpAt) Module.ccall('gta2_dev_sync_dump', 'number', ['number'], [Number(dumpAt)]);
  // A hidden tab, or a window covered by another one, gets no animation frames,
  // and in lockstep everyone else would wait for it: whenever frames stop
  // arriving, a worker's timer (not throttled like the page's) keeps it going.
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(()=>postMessage(0),8);'], { type: 'text/javascript' })));
  const slice = Module.cwrap('gta2_port_run_slice', null, []);
  let lastFrame = performance.now();
  const watch = () => { lastFrame = performance.now(); requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
  ticker.onmessage = () => { if (performance.now() - lastFrame > 50) slice(); };
}

/**
 * Co-op while the match runs (D20):
 * - a sync check: every 90 ticks (3 s) each player sends a checksum of the
 *   game (ped and car pools, random number state) and compares the others'
 *   with its own for the same tick; a difference means the games have drifted
 *   apart, and everyone is told;
 * - a notice naming the players everyone is waiting for, when the game has
 *   been held up by the network for more than half a second.
 */
function watchCoop(Module, coop) {
  const { lobby, players, mySlot } = coop;
  let won = null;
  const banner = $('coop-banner');
  const name = (slot) => (players[slot] ? players[slot].name : `Player ${slot + 1}`);
  const history = Module.cwrap('gta2_dev_sync_history', 'number', []);
  const netDebug = Module.cwrap('gta2_port_net_debug', 'number', []);
  const EVERY = 90;
  const mine = new Map();   // tick -> checksum
  const theirs = new Map(); // tick -> [slot, checksum][]
  let desync = null;
  let lastSent = -1;
  const ghost = isGhostRace(coop.pacing); // separate games: nothing to compare
  const checksumRows = () => {
    const p = history();
    const v = Module.HEAP32.subarray(p >> 2, (p >> 2) + 1024 * 9);
    for (let i = 0; i < 1024; i++) {
      const tick = v[i * 9];
      if (tick > 0 && tick % EVERY === 0 && !mine.has(tick)) {
        mine.set(tick, [1, 3, 4, 5, 6].map((k) => v[i * 9 + k]).join(':'));
      }
    }
  };
  const compare = (tick) => {
    const own = mine.get(tick);
    for (const [slot, h] of theirs.get(tick) || []) {
      if (own && h !== own && !desync) {
        desync = { tick, slot };
        console.warn(`co-op: games drifted apart at tick ${tick} (${name(slot)}: ${h}, here: ${own})`);
      }
    }
  };
  lobby.onSync = (slot, tick, h) => {
    if (!theirs.has(tick)) theirs.set(tick, []);
    theirs.get(tick).push([slot, h]);
    compare(tick);
  };
  let held = { frame: -1, since: 0 };
  setInterval(() => {
    if (!ghost) checksumRows();
    for (const tick of [...mine.keys()].filter((t) => t > lastSent).sort((a, b) => a - b)) {
      lobby.shareSync(tick, mine.get(tick));
      lastSent = tick;
      compare(tick);
    }
    for (const t of [...mine.keys()]) if (t < lastSent - EVERY * 20) { mine.delete(t); theirs.delete(t); }
    // who are we waiting for?
    const p = netDebug();
    const v = Module.HEAP32.subarray(p >> 2, (p >> 2) + 10);
    const now = performance.now();
    if (v[4] !== held.frame) held = { frame: v[4], since: now };
    const waiting = v[3] && now - held.since > 500
      ? players.map((_, slot) => slot).filter((slot) => slot !== mySlot && (v[6] & (1 << slot))) : [];
    if (coop.results) coop.results(); // keeps the latest standings for the end-of-match results
    // Gang Wars: a crew reaching the points target wins (time limits and free-for-all end in the game)
    if (!won && coop.mode === 'wars' && coop.pointsTarget > 0 && coop.results) {
      const lead = coop.results().leader;
      if (lead && lead.points >= coop.pointsTarget) {
        won = lead.c.name;
        setTimeout(() => coop.endMatch && coop.endMatch(), 6000);
      }
    }
    let text = '';
    if (won) text = `${won} win the Gang War!`;
    else if (desync) text = `The games have drifted apart (tick ${desync.tick}, with ${name(desync.slot)}): what you see may no longer match. Start a new match to fix it.`;
    else if (waiting.length) text = `Waiting for ${waiting.map(name).join(', ')}…`;
    banner.textContent = text;
    banner.hidden = !text;
    banner.classList.toggle('error', !!desync);
  }, 250);
}

// Co-op player colours by slot (map, radar, names, scoreboard).
const PLAYER_COLOURS = ['#4fc3ff', '#ff6b6b', '#7ee081', '#c792ff', '#ffa94d', '#ff7ad9'];

/**
 * What the map and radar need about the other players in a co-op match:
 * everyone's position and stats (from the local game, which simulates them
 * all) and their shared waypoints (lobby messages, outside the game).
 */
function coopView(Module, coop) {
  const { lobby, players, mySlot, mode = 'roam', crews = [] } = coop;
  // A ghost race (web/ghosts.js): this game has only this player (its slot 0); the others are the
  // ghosts, and the room's own list (which grows when someone joins mid-race) has their names.
  const ghost = isGhostRace(coop.pacing);
  const waypoints = new Map(); // slot -> {x, y}
  lobby.onWaypoint = (slot, wp) => { if (wp) waypoints.set(slot, wp); else waypoints.delete(slot); };
  const read = Module.cwrap('gta2_port_coop_players', 'number', []);
  const crewOf = (slot) => (mode === 'wars' ? crews.findIndex((c) => c.members.includes(players[slot].id)) : -1);
  const colour = (slot) => {
    const c = crewOf(slot);
    return c >= 0 ? crews[c].colour : PLAYER_COLOURS[slot % PLAYER_COLOURS.length];
  };
  const myCrew = crewOf(mySlot);
  const view = {
    mySlot,
    mode,
    waypoints,
    colour,
    name: (slot) => {
      const list = ghost ? lobby.players : players;
      return list[slot] ? list[slot].name : `Player ${slot + 1}`;
    },
    /** Every player in the match: position (blocks), heading, health, stats, crew. */
    players() {
      const p = read();
      const v = Module.HEAP32.subarray(p >> 2, (p >> 2) + 6 * 14);
      if (ghost) {
        // this player from their own game (slot 0 there), everyone else from their ghosts
        const mine = {
          slot: mySlot, name: view.name(mySlot), me: true, colour: colour(mySlot), crew: -1, ally: true,
          inGame: !!v[0], onMap: !!v[1], x: v[2] / 16384, y: v[3] / 16384, heading: (v[4] / 1440) * Math.PI * 2,
          inCar: !!v[5], health: v[6], kills: v[7], deaths: v[8], score: v[9], busted: v[10], points: v[11], itTime: v[12], it: !!v[13],
        };
        const others = (coop.ghosts ? coop.ghosts.players() : []).map((g) => ({
          slot: g.slot, name: view.name(g.slot), me: false, colour: colour(g.slot), crew: -1,
          ally: true, // a race: everyone is shown on the map and radar
          inGame: true, onMap: g.onMap, x: g.x / 16384, y: g.y / 16384, heading: (g.rot / 1440) * Math.PI * 2,
          inCar: g.inCar, health: 0, kills: g.kills, deaths: g.deaths, score: g.points, busted: 0, points: g.points, itTime: 0, it: false,
        }));
        return [mine, ...others];
      }
      return players.map((pl, slot) => {
        const o = slot * 14;
        const crew = crewOf(slot);
        return {
          slot, name: pl.name, me: slot === mySlot, colour: colour(slot), crew,
          // free roam: everyone is on your side; Gang Wars: your crew; free-for-all: nobody
          ally: mode === 'roam' || (mode === 'wars' && crew >= 0 && crew === myCrew),
          inGame: !!v[o], onMap: !!v[o + 1], x: v[o + 2] / 16384, y: v[o + 3] / 16384,
          heading: (v[o + 4] / 1440) * Math.PI * 2, inCar: !!v[o + 5], health: v[o + 6],
          kills: v[o + 7], deaths: v[o + 8], score: v[o + 9], busted: v[o + 10], points: v[o + 11],
          itTime: v[o + 12], it: !!v[o + 13],
        };
      });
    },
    /** The scoreboard and the end-of-match results: {title, columns, rows: [{cells, colour, strong}]}. */
    standings() {
      const ps = view.players().filter((p) => p.inGame);
      const money = (n) => `$${n.toLocaleString()}`;
      const row = (p) => ({ cells: [p.me ? `${p.name} (you)` : p.name, p.kills, p.deaths, money(p.points)], colour: p.colour, strong: p.me });
      if (mode === 'wars') {
        const totals = crews.map((c, i) => {
          const members = ps.filter((p) => p.crew === i);
          return { c, members, kills: members.reduce((n, p) => n + p.kills, 0), points: members.reduce((n, p) => n + p.points, 0) };
        }).sort((a, b) => b.points - a.points || b.kills - a.kills);
        const rows = [];
        for (const t of totals) {
          rows.push({ cells: [`${t.c.name} · ${t.c.gang}`, t.kills, '', money(t.points)], colour: t.c.colour, strong: true });
          for (const p of t.members.sort((a, b) => b.points - a.points)) rows.push({ ...row(p), cells: [`  ${row(p).cells[0]}`, ...row(p).cells.slice(1)], strong: false });
        }
        const lead = totals[0];
        const tied = !lead || totals.filter((t) => t.points === lead.points).length > 1;
        return { title: tied ? 'Gang Wars: level' : `Gang Wars: ${lead.c.name} leads with ${money(lead.points)}`, columns: ['Crew / player', 'Kills', 'Deaths', 'Points'], rows, leader: lead };
      }
      if (mode === 'tag') {
        // the most seconds as "it" wins
        const secs = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
        const sorted = [...ps].sort((a, b) => b.itTime - a.itTime || b.kills - a.kills);
        const top = sorted[0];
        const level = !!top && sorted.filter((p) => p.itTime === top.itTime).length > 1;
        const it = ps.find((p) => p.it);
        return {
          title: `Tag Game: ${!top ? '' : level ? `level at ${secs(top.itTime)}` : `${top.name} leads with ${secs(top.itTime)} as it`}`,
          columns: ['Player', 'Time as it', 'Kills', 'Deaths'],
          rows: sorted.map((p) => ({ ...row(p), cells: [`${row(p).cells[0]}${p === it ? ' (it)' : ''}`, secs(p.itTime), p.kills, p.deaths] })),
          leader: top,
        };
      }
      // frag game: kills; points game and free roam: points (cash earned)
      const score = mode === 'ffa' ? (p) => p.kills : (p) => p.points;
      const sorted = [...ps].sort(mode === 'ffa' ? (a, b) => b.kills - a.kills || b.points - a.points : (a, b) => b.points - a.points);
      const top = sorted[0];
      const amount = (n) => (mode === 'ffa' ? `${n} kill${n === 1 ? '' : 's'}` : money(n));
      // equal at the top: level (a draw once the match ends)
      const level = !!top && sorted.filter((p) => score(p) === score(top)).length > 1;
      const lead = !top ? '' : level ? `level at ${amount(score(top))}` : `${top.name} leads with ${amount(score(top))}`;
      return {
        title: mode === 'ffa' || mode === 'points' ? `${MODES[mode]}: ${lead}` : 'Free Roam',
        columns: ['Player', 'Kills', 'Deaths', 'Points'], rows: sorted.map(row), leader: sorted[0],
      };
    },
    /** Gang Wars result for the server (saved crews): every crew, its members' stats, who won. */
    report() {
      const ps = view.players().filter((p) => p.inGame);
      const sums = crews.map((c, i) => ({ c, members: ps.filter((p) => p.crew === i) }))
        .map((t) => ({ ...t, points: t.members.reduce((n, p) => n + p.points, 0) }));
      const best = Math.max(0, ...sums.map((t) => t.points));
      const leaders = sums.filter((t) => t.points === best).length;
      return sums.map((t) => ({
        name: t.c.name, gang: t.c.gang, won: best > 0 && leaders === 1 && t.points === best, // a tie: nobody wins
        members: t.members.map((p) => ({ name: p.name, kills: p.kills, deaths: p.deaths, points: p.points })),
      }));
    },
    shareWaypoint: (wp) => lobby.shareWaypoint(wp),
  };
  return view;
}

async function start(getFiles, { cacheAfterStart = false, coop = null, loadSlot = null } = {}) {
  const startOptions = { commandLine: coop ? '-N' : '' };
  $('picker').hidden = true;
  setStatus('Starting…');
  try {
    const canvas = $('screen');
    const renderer = new Gta2Renderer(canvas);
    const audio = new Gta2Audio();
    const storage = new SaveStorage(GAME_DIR, setStatus);
    await storage.open();
    const Module = await createGta2({
      print: (t) => { logLine(t); console.log(t); },
      printErr: (t) => { logLine(t); console.warn(t); },
      gta2Renderer: renderer,
      gta2Storage: storage,
      gta2Audio: audio,
      fastLoop: new URLSearchParams(location.search).has('fastloop'),
      onGameMessage: (caption, text) => setStatus(`${caption}: ${text}`, true),
      onAbort: (what) => recordError(what),
      onGameExit: (code) => {
        if (coop) {
          // back to the same room, as host again or rejoining (wireCoopLobby picks this up)
          try {
            sessionStorage.setItem('gta2-coop-rematch', JSON.stringify({ code: coop.lobby.code, host: coop.lobby.host, settings: coop.lobby.settings }));
            if (coop.results) {
              const r = coop.results();
              r.title = r.title.replace(' leads with ', ' won with ').replace(': level', ': a draw');
              sessionStorage.setItem('gta2-coop-results', JSON.stringify(r));
            }
          } catch { /* storage unavailable */ }
          setStatus('The match has ended. Back to the lobby…');
          const back = () => {
            const search = new URLSearchParams(location.search);
            search.delete('testmap'); // a test (?testmap) is over: back to the lobby, not into the test again
            const rest = search.toString();
            location.href = `${location.pathname}${rest ? `?${rest}` : ''}`;
            location.reload();
          };
          reportMatch(coop).then(back, back);
          return;
        }
        setStatus(`The game exited (code ${code}). Reload the page to play again.`);
      },
    });
    renderer.module = Module;
    storage.module = Module;
    audio.module = Module;
    window.gta2 = { Module, renderer, storage, audio };

    const files = await getFiles();
    validate(files);
    await writeFiles(Module, files);
    const restored = await storage.restoreInto(Module.FS);
    if (restored) console.log(`Restored ${restored} saved file(s)`);
    // the game's text, in this player's language (text only: every player's game still runs the same)
    seedRegistry(Module, prepareGameLanguage(Module.FS, GAME_DIR, savedLang()));
    const handleKey = wireInput(Module, canvas);
    // Browsers start audio only after a user gesture (but not while the map screen pauses the game).
    let gamePaused = false;
    // (iOS counts only the end of a tap, touchend or click, as the gesture that may start sound)
    for (const type of ['keydown', 'pointerdown', 'pointerup', 'touchend', 'click']) {
      window.addEventListener(type, () => { if (!gamePaused) audio.resume(); }, true);
    }
    wireAudioButton(audio);
    window.addEventListener('pagehide', () => { saveRegistry(Module); storage.flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) storage.flush(); });
    wireSaveButtons(storage);
    $('game').hidden = false;
    setStatus('');
    canvas.focus();
    Module.ccall('gta2_port_set_view_width', 'number', ['number'], [chooseViewWidth(canvas)]);
    wireViewWidth(Module, canvas);
    const params = new URLSearchParams(location.search);
    // Camera button; ?camera=classic|modern for this visit, ?heightbias=N raises Modern.
    wireCameraButton(Module);
    wireFpsButton(renderer);
    wireFullscreenButton();
    // ?smooth=0: draw only at the game's 30 updates per second (no display-rate interpolation).
    Module.ccall('gta2_port_set_interpolation', null, ['number'], [option('smooth', 'gta2-port-smooth', '1') === '0' ? 0 : 1]);
    // ?hud=centre keeps the whole HUD in the centred 4:3 box (default: anchored to the screen edges).
    Module.ccall('gta2_port_set_hud_edges', null, ['number'], [option('hud', 'gta2-port-hud', 'edges') === 'centre' ? 0 : 1]);
    // ?margin=0 keeps the original activation rectangle even where more is drawn (things then pop in).
    Module.ccall('gta2_port_set_activation_margin', null, ['number'], [params.get('margin') === '0' ? 0 : 1]);
    if (coop) {
      await setupCoop(Module, coop);
      window.gta2.coop = coop;
      setStatus('Waiting for everyone to load…');
      await coop.lobby.allLoaded();
      setStatus('');
    }
    const rc = Module.ccall('gta2_start', 'number', ['string', 'string'], [GAME_DIR, startOptions.commandLine || '']);
    if (rc < 0) setStatus(`Could not start (code ${rc}).`, true);
    else {
      if (cacheAfterStart) setTimeout(() => cachePickedFiles(files), 3000);
      count(coop ? `play/coop-${coop.mode}` : 'play/solo');
      if (coop && coop.lobby.host) {
        count(`match/${coop.players.length}-players`);
        // how often each map is played (once per match, from the host), and this server's match history
        count(`map/${coop.district}`, { match: { map: coop.district, mode: coop.mode, players: coop.players.length } });
      }
      startPlayClock(coop ? 'coop' : 'solo');
    }
    // Map screen (M), minimap and waypoint: not in the original game (T33).
    const releaseAll = Module.cwrap('gta2_port_release_all_keys', null, []);
    // The map screen and the Saves screen pause the game and its sound.
    const pauseGame = (paused) => {
      gamePaused = paused;
      releaseAll();
      // in co-op the shared game keeps running behind the map (everyone else would wait)
      if (!coop) Module.ccall('gta2_port_set_paused', null, ['number'], [paused ? 1 : 0]);
      if (audio.ctx) { if (paused) audio.ctx.suspend().catch(() => {}); else audio.resume(); }
    };
    const map = new Gta2Map({ Module, renderer, gameCanvas: canvas, onPause: pauseGame });
    window.gta2.map = map;
    if (coop) {
      map.coop = coopView(Module, coop);
      // the latest standings with players in them (once the game has ended there is nothing left to read)
      let lastResults = null;
      coop.results = () => {
        const r = map.coop.standings();
        if (r.rows.length) lastResults = r;
        return lastResults || r;
      };
      coop.endMatch = () => Module.onGameExit && Module.onGameExit(0);
      coop.report = () => map.coop.report();
      coop.startedAt = performance.now();
    }
    const chat = coop ? new CoopChat({
      lobby: coop.lobby, mySlot: coop.mySlot, releaseKeys: releaseAll,
      name: (slot) => (coop.players[slot] ? coop.players[slot].name : `Player ${slot + 1}`),
      colour: (slot) => PLAYER_COLOURS[slot % PLAYER_COLOURS.length],
    }) : null;
    // Quick save and load (single player): a snapshot of the whole game.
    // Save states (single player): the Saves screen, the autosave after a job, Continue on the front page.
    const states = coop ? null : new SaveStates({ Module, renderer, map });
    const saves = states ? new SavesScreen({ states, pause: pauseGame, onClose: () => canvas.focus() }) : null;
    window.gta2.states = states;
    if (states) {
      $('saves-open').title = `Save (20% of your cash, at least $10,000) or load (${SAVE_KEY} or F5)`;
      $('saves-open').addEventListener('click', () => saves.show());
      states.watchJobs();
      if (loadSlot) states.load(loadSlot); // Continue on the front page
    } else {
      $('saves-open').hidden = true;
    }
    const radioKeys = wireRadioKeys(Module, audio, coop);
    // The Controls screen: the game menu's Options (which launched GTA2 Manager) and the toolbar.
    const controls = new ControlsScreen({
      Module, keys: KEYS, defaults: PORT_CONTROLS, regPath: `${REG_ROOT}\\control`,
      onChange: () => saveRegistry(Module), pause: pauseGame, onClose: () => canvas.focus(),
      gamepad: () => window.gta2.gamepad || null,
    });
    Module.onOpenOptions = () => controls.show();
    $('controls-open').addEventListener('click', () => controls.show());
    // Options: the settings without a toolbar button, applied at once (the language from the next game)
    const options = new OptionsScreen({
      pause: pauseGame,
      onClose: () => canvas.focus(),
      onChange: (key, value) => {
        if (key === 'gta2-port-aspect') {
          ASPECT = value;
          Module.ccall('gta2_port_set_view_width', 'number', ['number'], [chooseViewWidth(canvas)]);
        } else if (key === 'gta2-port-hud') {
          Module.ccall('gta2_port_set_hud_edges', null, ['number'], [value === 'centre' ? 0 : 1]);
        } else if (key === 'gta2-port-smooth') {
          Module.ccall('gta2_port_set_interpolation', null, ['number'], [value === '0' ? 0 : 1]);
        } else if (key === LANG_KEY) {
          toast('The game language changes from the next game.');
        }
      },
    });
    $('options-open').addEventListener('click', () => options.show());
    keyHooks.filter = (e, down) => controls.handleKey(e, down) || options.handleKey(e, down) || (!!saves && saves.handleKey(e, down)) || (!!states && !map.open && states.handleKey(e, down)) ||
      (!!chat && !map.open && chat.handleKey(e, down)) || map.handleKey(e, down) ||
      // only while playing: the game's menus take R and T as letters (the player's name)
      (!!(map.last && map.last.hasPlayer) && (radioKeys(e, down) || (!!viewKeys.handle && viewKeys.handle(e, down))));
    wireMapButtons(map);
    const isPlaying = () => !!(map.last && map.last.hasPlayer) && !map.open && !(saves && saves.open) && !(chat && chat.open) && !controls.open && !options.open;
    // phones and tablets: buttons over the game (web/touch.js), at once on a touch screen, else at
    // the first touch (some browsers do not say they have one, such as iPad Safari as a desktop)
    const showTouch = () => {
      if (window.gta2.touch) return;
      const send = keySender(handleKey, isPlaying, (code) => controls.rebound(code));
      // the touch menu (☰): the desktop toolbar as a panel (camera, view, minimap, map, full screen...)
      // with the touch-only buttons first: the game's menu and the multiplayer scoreboard
      const closeMenu = () => document.body.classList.remove('touch-settings');
      const touch = new TouchControls({ send, parent: $('game'), onMenu: () => document.body.classList.add('touch-settings') });
      const tools = $('tools');
      const add = (label, act, first = true) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'touch-only';
        b.textContent = label;
        b.addEventListener('click', () => act(b));
        if (first) tools.prepend(b); else tools.append(b);
        return b;
      };
      if (coop) {
        add('Scores', (b) => {
          map.showScores = !map.showScores;
          b.setAttribute('aria-pressed', String(map.showScores));
          closeMenu();
        });
      }
      add('Game menu', () => { closeMenu(); send('Escape', true); setTimeout(() => send('Escape', false), 80); });
      for (const id of ['map-open', 'fullscreen', 'options-open']) $(id).addEventListener('click', closeMenu); // (they act on the screen)
      $('fullscreen').hidden = !fullScreen.supported();
      $('map-open').textContent = 'Map'; // (no M key to show)
      add('Done', closeMenu, false).id = 'tools-done';
      touch.update(true);
      window.gta2.touch = touch;
      map.touch = true; // the map screen's own touch buttons
      document.body.classList.add('touch'); // the desktop toolbar gives way to the touch buttons
    };
    if (isTouchDevice() || params.has('touch')) showTouch();
    else window.addEventListener('touchstart', showTouch, { once: true, passive: true });
    try {
      window.gta2.gamepad = wireGamepad(handleKey, isPlaying, (code) => controls.rebound(code));
    } catch (err) {
      console.warn('game pad support unavailable:', err); // never in the way of the keyboard or touch
    }
    if (new URLSearchParams(location.search).has('devdata')) installDevHelpers(Module);
    // Developer option (?perfbeacon=PORT): every 2 s, post frame timings to a listener on this
    // computer (for comparing browsers).
    const beaconPort = new URLSearchParams(location.search).get('perfbeacon');
    if (beaconPort) {
      let rafs = 0;
      const countRaf = () => { rafs++; requestAnimationFrame(countRaf); };
      requestAnimationFrame(countRaf);
      const presentOrig = renderer.present.bind(renderer);
      let presentMs = 0;
      renderer.present = (...args) => { const t = performance.now(); presentOrig(...args); presentMs += performance.now() - t; };
      let mapMs = 0;
      map.perf = { image: 0, fog: 0 };
      const mapFrame = map.frame.bind(map);
      map.frame = () => { const t = performance.now(); mapFrame(); mapMs += performance.now() - t; };
      if (new URLSearchParams(location.search).has('nominimap')) map.minimapOn = false; // this visit only
      const take = Module.cwrap('gta2_port_take_frame_ms', 'number', ['number']);
      let last = { t: performance.now(), frames: renderer.stats.frames };
      setInterval(() => {
        const now = performance.now();
        const secs = (now - last.t) / 1000;
        const countPtr = Module._malloc(4);
        const loopMs = take(countPtr);
        const slices = Module.HEAP32[countPtr >> 2];
        Module._free(countPtr);
        const frames = renderer.stats.frames - last.frames;
        const report = {
          ua: navigator.userAgent, fps: +(frames / secs).toFixed(1), raf: +(rafs / secs).toFixed(1),
          slices: +(slices / secs).toFixed(1), sliceMs: +(loopMs / Math.max(1, slices)).toFixed(2),
          presentMs: +(presentMs / Math.max(1, frames)).toFixed(2), drawCalls: renderer.stats.drawCalls,
          mapMs: +(mapMs / Math.max(1, rafs)).toFixed(2), minimap: map.minimapOn,
          imageMs: +(map.perf.image / Math.max(1, rafs)).toFixed(2), fogMs: +(map.perf.fog / Math.max(1, rafs)).toFixed(2),
          canvas: `${canvas.width}x${canvas.height}`, dpr: devicePixelRatio, hidden: document.hidden,
          player: !!(map.last && map.last.hasPlayer),
        };
        rafs = 0; presentMs = 0; mapMs = 0; map.perf = { image: 0, fog: 0 }; last = { t: now, frames: renderer.stats.frames };
        fetch(`http://127.0.0.1:${beaconPort}/`, { method: 'POST', mode: 'no-cors', body: JSON.stringify(report) }).catch(() => {});
      }, 2000);
      // ?perfsecs=N: leave after N seconds (a test page opened in someone's own browser)
      const secs = Number(new URLSearchParams(location.search).get('perfsecs'));
      if (secs > 0) setTimeout(() => location.replace('about:blank'), secs * 1000);
    }
    // Developer option (?autostart=1): Enter twice -> PLAY -> start area 1.
    if (new URLSearchParams(location.search).has('autostart')) {
      const key = Module.cwrap('gta2_port_key', null, ['number', 'number', 'number', 'number']);
      const tap = (at) => {
        setTimeout(() => key(0x1c, 0x0d, 1, 13), at);
        setTimeout(() => key(0x1c, 0x0d, 0, 0), at + 100);
      };
      tap(1500);
      tap(3500);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
    $('picker').hidden = false;
  }
}

// Pages hosted where other sites cannot be fetched (e.g. a sandboxed preview)
// set window.GTA2_NO_DIRECT_DOWNLOAD; the installer can still be picked as a file.
if (window.GTA2_NO_DIRECT_DOWNLOAD) $('download-freeware').hidden = true;

$('installer-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const files = await unpackInstallerFile(file, (stage) => {
      if (stage === 'read') setStatus('Reading the installer…');
      else if (stage === 'verify') setStatus('Checking the installer…');
      else if (stage === 'unpack') setStatus('Unpacking GTA2 in this browser…');
    });
    validate(files);
    start(async () => files, { cacheAfterStart: true });
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
});

$('download-freeware').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  const mb = (n) => Math.round(n / 1048576);
  const t0 = performance.now();
  try {
    const files = await downloadFreeware((stage, done, total) => {
      if (stage === 'download') {
        const rate = done / Math.max(1, (performance.now() - t0) / 1000);
        const left = rate > 0 ? Math.round((total - done) / rate) : 0;
        setStatus(`Downloading GTA2 from the Internet Archive… ${mb(done)} / ${mb(total)} MB` +
          (done > 1048576 ? ` (about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left)` : ''));
      } else if (stage === 'verify') setStatus('Checking the download…');
      else if (stage === 'unpack') setStatus('Unpacking GTA2 in this browser…');
    });
    validate(files);
    start(async () => files, { cacheAfterStart: true });
  } catch (err) {
    setStatus(err.message || String(err), true);
    button.disabled = false;
  }
});

$('folder').addEventListener('change', (e) => {
  const files = collectPickedFiles(e.target.files);
  start(async () => files, { cacheAfterStart: true });
});

const pageParams = new URLSearchParams(location.search);
let serverFiles = null; // serverGameFiles()
// On our game server (D21) the page is the front door: the game files come from the server.
const serverConfig = await fetch('config.json', { cache: 'no-store' })
  .then((res) => (res.ok ? res.json() : null)).catch(() => null);
// Our game server ({server: true}, D21) or a static site such as GitHub Pages ({static: true}):
// both show the landing page; the game files come from the server, or from the Internet Archive.
const onServer = !!(serverConfig && serverConfig.server);
const onSite = onServer || !!(serverConfig && serverConfig.static);
if (onServer) document.body.classList.add('on-server');
if (onSite) document.body.classList.add('on-site');
if (await initStats(serverConfig)) $('stats-faq').hidden = false; // anonymous play counts (the public site)
// Game files shipped with this site (web/gamedata/: the freeware's data folder, without music and
// movies): downloaded once with a progress bar and kept in this browser, like a game server's.
const bundled = !onServer && await fetch('gamedata/manifest.json', { method: 'HEAD', cache: 'no-store' })
  .then((res) => res.ok).catch(() => false);
if (onSite && !pageParams.has('coop')) {
  wireServerHome();
} else if (pageParams.has('devdata')) {
  Error.stackTraceLimit = 200;
  start(collectDevFiles);
} else if (pageParams.has('play')) {
  autoStart(); // single player (the story districts)
} else if (pageParams.has('choose')) {
  offerSavedFiles();
} else {
  // the main page: the multiplayer lobby
  if (onServer || bundled) serverGameFiles(); // start the one-time download while the lobby fills
  wireCoopLobby();
}
document.body.classList.remove('booting');

/**
 * On our game server: the game files from this browser's copy when there is one,
 * otherwise downloaded from the server once (and kept after the game starts).
 * Started early, so the download runs while the player is still choosing.
 */
function serverGameFiles() {
  if (serverFiles) return serverFiles;
  const show = (text, fraction) => { landingProgress(text, fraction); setStatus(text); };
  const job = serverFiles = { fromCache: false };
  job.promise = (async () => {
    if (await fileCache.info()) {
      job.fromCache = true;
      return fileCache.load();
    }
    show(onServer ? 'Getting GTA2 from the game server…' : bundled ? 'Getting GTA2 ready…' : 'Connecting to the Internet Archive…', 0);
    // a static site: the freeware installer from the Internet Archive, unpacked in this browser
    const files = onServer || bundled ? await collectDevFiles(show) : await downloadFreeware(freewareProgress(show));
    if (!onServer) count('download/gta2');
    show('GTA2 is ready.', 1);
    setTimeout(() => { if ($('status').textContent === 'GTA2 is ready.') setStatus(''); }, 4000);
    return files;
  })();
  job.promise.catch((err) => {
    if (serverFiles === job) serverFiles = null; // the next Play starts a fresh attempt
    if (!onServer) count('download/failed', { title: String(err.message || err).slice(0, 200) });
    const text = `Could not get the game files: ${String(err.message || err).replace(/\.$/, '')}. Press Play to try again.`;
    setStatus(text, true);
    landingProgress(text, 0, true);
  });
  return job;
}

/** Progress of the Internet Archive download, for a (text, fraction) display. */
function freewareProgress(show) {
  const mb = (n) => Math.round(n / 1048576);
  const t0 = performance.now();
  return (stage, done, total) => {
    if (stage === 'download') {
      const rate = done / Math.max(1, (performance.now() - t0) / 1000);
      const left = rate > 0 ? Math.round((total - done) / rate) : 0;
      show(`Downloading GTA2 from the Internet Archive… ${mb(done)} of ${mb(total)} MB` +
        (done > 1048576 ? ` (about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left)` : ''), total ? done / total : 0);
    } else if (stage === 'verify') show('Checking the download…', 1);
    else if (stage === 'unpack') show('Unpacking GTA2 in this browser…', 1);
  };
}

/** Whether the files about to be used came from the server and should be kept in this browser. */
function needsCaching() {
  return !!serverFiles && !serverFiles.fromCache;
}

/** Our game server's front page (the landing page): Play, Play with friends, controls, options, help. */
async function wireServerHome() {
  $('picker').hidden = true;
  count('/', { event: false });
  // On a static site the 360 MB download only starts when the player presses Play (or hosts/joins).
  const cached = !onServer && !!(await fileCache.info());
  const files = onServer || cached ? serverGameFiles() : null;
  let starting = false;
  if (onServer) savedCrews().then(showLeaderboard);
  else { $('crews').remove(); document.querySelector('#topnav a[href="#crews"]').remove(); } // saved crews live on our game server
  // loadSlot: Continue (a save to load once the game has started)
  const playNow = async (loadSlot = null) => {
    if (starting) return;
    starting = true;
    const buttons = document.querySelectorAll('[data-play]');
    for (const b of buttons) b.disabled = true;
    setStatus('Starting…');
    try {
      const loaded = await serverGameFiles().promise;
      hideLanding();
      start(async () => loaded, { cacheAfterStart: needsCaching(), loadSlot });
    } catch {
      starting = false;
      for (const b of buttons) b.disabled = false;
    }
  };
  showLanding({
    files,
    onCoop: () => { location.search = '?coop'; },
    onPlay: () => playNow(),
  });
  // Continue: the newest save this version of the game can load
  listSaves().then((all) => {
    const newest = all.find((s) => s.current);
    if (newest) showContinue({ ...describe(newest), thumb: newest.thumb }, () => playNow(newest.slot));
  });
}

/** Game files for a co-op match: the local server's copy or the browser's (the picker otherwise). */
async function coopFiles() {
  if (onSite || bundled) return serverGameFiles().promise;
  try {
    const res = await fetch('gamedata/manifest.json', { cache: 'no-store' });
    if (res.ok) return collectDevFiles();
  } catch { /* no local game folder */ }
  if (await fileCache.info()) return fileCache.load();
  throw new Error('Choose your GTA2 folder once on the normal start page first, then come back to co-op.');
}

/**
 * Saved crews (D21): a finished Gang Wars match of a minute or more goes to the
 * game server, once per match (every player reports; the server keeps the first).
 * The reputation changes join the "last match" panel.
 */
async function reportMatch(coop) {
  await new Promise((r) => setTimeout(r, 800)); // the "match has ended" message stays up a moment
  if (!onServer || coop.mode !== 'wars' || !coop.report || performance.now() - (coop.startedAt || 0) < 60000) return;
  try {
    const res = await fetch('api/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ id: coop.id, mode: 'wars', district: coop.district, crews: coop.report() }),
    });
    const out = await res.json();
    if (out.ok && out.changes && out.changes.length) {
      const saved = JSON.parse(sessionStorage.getItem('gta2-coop-results') || 'null');
      if (saved) {
        saved.reputation = out.changes;
        sessionStorage.setItem('gta2-coop-results', JSON.stringify(saved));
      }
    }
  } catch { /* the server could not be reached: the match is not saved */ }
}

/** Saved crews from the game server, for the lobby and the landing page (empty elsewhere). */
async function savedCrews() {
  if (!onServer) return [];
  try { return (await (await fetch('api/crews', { cache: 'no-store' })).json()).crews || []; } catch { return []; }
}

/** The lobby's "last match" panel, after a match ends. */
function showLastResults() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('gta2-coop-results') || 'null'); sessionStorage.removeItem('gta2-coop-results'); } catch { /* storage unavailable */ }
  if (!r || !r.rows) return;
  const box = $('coop-results');
  const h = document.createElement('h3');
  h.textContent = r.title;
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const c of r.columns) head.append(Object.assign(document.createElement('th'), { textContent: c }));
  for (const row of r.rows) {
    const tr = table.insertRow();
    row.cells.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (i === 0 && row.colour) td.style.color = row.colour;
      if (row.strong) td.style.fontWeight = '700';
    });
  }
  box.replaceChildren(h, table);
  if (r.reputation) {
    const rep = document.createElement('p');
    rep.className = 'mode-help';
    rep.textContent = 'Crew reputation: ' + r.reputation.map((c) => `${c.name} ${c.delta >= 0 ? '+' : ''}${c.delta} (now ${c.reputation})`).join(' · ');
    box.append(rep);
  }
  box.hidden = false;
}

/** ?coop: the co-op lobby (D20). */
function wireCoopLobby() {
  $('coop').hidden = false;
  if (bundled) $('coop-own-files').hidden = true; // the site brings the game files
  count('/coop', { event: false });
  if (onSite) {
    // the landing page's bar, leading back to the front page (relative: a static site may live in a folder)
    $('topnav').hidden = false;
    document.querySelector('#picker h1').textContent = 'Play with friends';
    for (const a of document.querySelectorAll('#topnav nav a')) a.href = `./${a.getAttribute('href')}`;
    for (const b of document.querySelectorAll('#topnav [data-play]')) b.addEventListener('click', () => { location.href = './'; });
  }
  for (const el of document.querySelectorAll('#picker > :not(h1):not(#coop):not(.credits-link)')) el.hidden = true;
  const nameInput = $('coop-name');
  try { nameInput.value = localStorage.getItem('gta2-port-coop-name') || ''; } catch { /* storage unavailable */ }
  let lobby = null;
  let attemptSince = 0; // when this try at it started (Try again, or every RETRY_MS, starts over)
  let attempt = 0;
  let lookingTimer = 0;
  const RETRY_MS = 30000; // looking this long without getting in: start over by itself
  const OFFER_RETRY_MS = 10000; // and from this long, a Try again button
  // an invite link (…#CODE): the room is filled in, ready to join; the address bar is tidied up
  const inviteCode = () => location.hash.replace(/^#/, '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  let invited = inviteCode();
  const takeInvite = () => {
    if (!invited) return;
    if (!lobby) $('coop-code').value = invited;
    history.replaceState(null, '', location.pathname + location.search);
  };
  takeInvite();
  // an invite link opened in a tab that already shows this page
  window.addEventListener('hashchange', () => {
    invited = inviteCode();
    takeInvite();
    render();
  });
  let pinger = 0;
  let crewSent = false;
  let known = []; // saved crews on the game server
  savedCrews().then((c) => { known = c; render(); });
  // public games: rooms whose host ticked Public, joined from a list without a code
  let directory = null;
  RoomDirectory.create(new URLSearchParams(location.search).has('local'))
    .then((d) => { directory = d; d.onChange = () => render(); render(); })
    .catch((err) => console.warn('public games list unavailable:', err));
  // the host's match settings, kept in this browser for the next game (not the Gang Wars crews' gangs)
  const SETTINGS_KEY = 'gta2-port-coop-settings';
  const DEFAULTS = { mode: 'ffa', district: 'rocket', pacing: 'lockstep', lighting: 'noon', public: false, police: false, friendlyFire: false, minutes: 0, killLimit: 10, pointsTarget: 0, sides: {} };
  const savedSettings = () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* storage unavailable */ }
    if (!saved || typeof saved !== 'object') return {};
    // only settings this version knows, of the right kind
    // (host-paced is hidden from the list: a host who last picked it gets lockstep)
    return Object.fromEntries(Object.entries(saved).filter(([k, v]) => k !== 'sides' && k in DEFAULTS && typeof v === typeof DEFAULTS[k] && !(k === 'pacing' && v === 'host')));
  };
  // ?testmap=<id> (the admin page's Test link): that map at once, alone, in this tab only
  const testMap = new URLSearchParams(location.search).get('testmap');
  let savedText = '';
  const saveSettings = () => {
    if (testMap) return; // (a test does not change the host's remembered settings)
    const { sides, ...keep } = lobby.settings;
    const text = JSON.stringify(keep);
    if (text === savedText) return;
    savedText = text;
    try { localStorage.setItem(SETTINGS_KEY, text); } catch { /* storage unavailable */ }
  };
  // the map list: this browser's favourites first (the star next to it), then every map, racing maps apart
  const FAVOURITES_KEY = 'gta2-port-favourite-maps';
  let favourites = [];
  try { favourites = JSON.parse(localStorage.getItem(FAVOURITES_KEY) || '[]').filter((id) => typeof id === 'string'); } catch { /* none */ }
  // the search box narrows it by name or author (and picks the first match: searchMaps)
  const mapList = () => {
    const select = $('coop-district');
    const value = select.value || (lobby && lobby.settings.district);
    const words = $('coop-map-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (id) => words.every((w) => `${DISTRICTS[id].label} ${DISTRICTS[id].author || ''}`.toLowerCase().includes(w));
    const group = (label, ids) => {
      const g = Object.assign(document.createElement('optgroup'), { label });
      for (const id of ids.filter(matches)) {
        const d = DISTRICTS[id];
        const text = d.community && d.author ? `${d.label} — ${d.author}` : d.label;
        // a map this game cannot run (maps.json incompatible): listed, greyed out, with the reason
        g.append(Object.assign(document.createElement('option'), {
          value: id, textContent: d.incompatible ? `${text} (${d.incompatible})` : text, disabled: !!d.incompatible,
        }));
      }
      return g;
    };
    // each group A to Z by name: the original game's maps, then the community's, racing ones apart
    const byName = (a, b) => DISTRICTS[a].label.localeCompare(DISTRICTS[b].label, undefined, { sensitivity: 'base', numeric: true });
    const ids = Object.keys(DISTRICTS).sort(byName);
    const favs = favourites.filter((id) => DISTRICTS[id]).sort(byName);
    select.replaceChildren(...[
      favs.length ? group('★ Favourites', favs) : null,
      group('Stock', ids.filter((id) => !DISTRICTS[id].community)),
      group('Maps', ids.filter((id) => DISTRICTS[id].community && !DISTRICTS[id].racing)),
      group('Racing', ids.filter((id) => DISTRICTS[id].community && DISTRICTS[id].racing)),
    ].filter((g) => g && g.children.length));
    if (!select.options.length) select.append(Object.assign(document.createElement('option'), { value: '', textContent: 'No maps match', disabled: true }));
    if (value) select.value = value;
    if (select.selectedIndex < 0) select.selectedIndex = 0; // ("No maps match")
  };
  // typing in the search box: the list shows only the matches, and the host's map becomes the first
  // one when the current map is not among them (as the lobby's change handler does: lighting and all)
  const searchMaps = () => {
    mapList();
    const select = $('coop-district');
    const usable = [...select.options].filter((o) => !o.disabled && o.value);
    if (!lobby || !lobby.host || !usable.length || usable.some((o) => o.value === lobby.settings.district)) return;
    select.value = usable[0].value;
    select.dispatchEvent(new Event('change'));
  };
  const updateFav = () => {
    const on = favourites.includes($('coop-district').value);
    $('coop-fav').textContent = on ? '★' : '☆';
    $('coop-fav').setAttribute('aria-pressed', String(on));
    $('coop-fav').title = on ? 'Remove this map from your favourites' : 'Add this map to your favourites';
  };
  $('coop-fav').addEventListener('click', () => {
    const id = $('coop-district').value;
    if (!DISTRICTS[id]) return;
    favourites = favourites.includes(id) ? favourites.filter((f) => f !== id) : [...favourites, id];
    try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(favourites)); } catch { /* storage unavailable: this visit only */ }
    mapList();
    updateFav();
  });
  $('coop-map-search').addEventListener('input', searchMaps);
  mapList();
  // the community maps (maps/maps.json) join the map list
  const mapsReady = loadMaps().then(() => {
    // a remembered map that this site no longer has: back to the default
    const remembered = lobby && DISTRICTS[lobby.settings.district];
    if (lobby && lobby.host && (!remembered || remembered.incompatible)) lobby.setSettings({ district: DEFAULTS.district });
    mapList();
    render();
  });
  let savedCrew = '';
  try { savedCrew = localStorage.getItem('gta2-port-coop-crew') || ''; } catch { /* storage unavailable */ }
  $('coop-crew').value = savedCrew;
  // this player's crew: joined from a card, typed as a new name, or '' to leave (remembered for next time)
  const setCrew = (name) => {
    savedCrew = String(name || '').trim().slice(0, 16);
    $('coop-crew').value = savedCrew;
    try { localStorage.setItem('gta2-port-coop-crew', savedCrew); } catch { /* storage unavailable */ }
    if (lobby) lobby.setCrew(savedCrew);
  };
  const HELP = {
    roam: 'Explore and cause trouble together. Friendly fire is your choice.',
    wars: 'Crews fight crews. Each crew sides with one of the district\'s gangs: its members leave you alone, the rival gangs hunt you. ' +
      'No friendly fire inside a crew. The crew with the most points wins.',
    ffa: 'Everyone against everyone, GTA2\'s own frag game: first to the kill limit wins.',
    points: 'Everyone against everyone, GTA2\'s points game: score points (cash) any way you can. First to the target, or the most when time runs out, wins.',
    tag: 'GTA2\'s tag game: one player is "it", and whoever kills them is it next. The longest time as it wins. ' +
      `With no time limit set, it lasts ${TAG_MINUTES} minutes.`,
  };
  const render = () => {
    const s = lobby ? lobby.settings : { ...DEFAULTS, ...savedSettings() };
    const host = !!(lobby && lobby.host);
    if (host && !lobby.started) saveSettings();
    const crews = lobby ? lobby.crews() : [];
    const list = $('coop-players');
    list.replaceChildren(...(lobby ? lobby.players : []).map((p, i) => {
      const li = document.createElement('li');
      li.textContent = `${p.name}${i === 0 ? ' (host)' : ''}${lobby && p.id === lobby.t.id ? ' — you' : ''}` +
        (p.ping ? ` · ${p.ping} ms` : '');
      const crew = s.mode === 'wars' && crews.find((c) => c.name === p.crew);
      if (crew) {
        const tag = document.createElement('span');
        tag.className = 'crewtag';
        tag.style.background = crew.colour;
        tag.textContent = crew.name;
        li.append(tag);
      }
      return li;
    }));
    // the match settings: the host's to change, everyone sees them
    for (const [id, key] of [['coop-mode', 'mode'], ['coop-district', 'district'], ['coop-pacing', 'pacing'], ['coop-minutes', 'minutes'],
      ['coop-kills', 'killLimit'], ['coop-points', 'pointsTarget'], ['coop-lighting', 'lighting']]) {
      if (document.activeElement !== $(id)) $(id).value = String(s[key]);
      $(id).disabled = !host;
    }
    updateFav();
    $('coop-fav').hidden = !host; // (the host's list: a player who hosts later has theirs)
    $('coop-map-search').hidden = !host;
    $('coop-ff').checked = !!s.friendlyFire;
    $('coop-ff').disabled = !host;
    $('coop-pub').checked = !!s.public;
    $('coop-pub').disabled = !host;
    $('coop-police').checked = !!s.police;
    $('coop-police').disabled = !host;
    // public games: the host lists the room while it is open; everyone else sees the list until they join one
    if (directory && lobby && lobby.host && (!lobby.started || isGhostRace(s.pacing))) {
      const d = DISTRICTS[s.district];
      directory.announce(s.public ? {
        live: lobby.started, // a ghost race under way can still be joined
        code: lobby.code, host: (lobby.players[0] || {}).name || 'Player', map: s.district, mode: s.mode,
        players: lobby.players.length, max: isGhostRace(s.pacing) ? roomSize(s) : (d && d.maxPlayers) || MAX_PLAYERS,
      } : null);
    }
    $('coop-public').hidden = !!lobby;
    if (!lobby) {
      const rooms = directory ? directory.list() : [];
      $('coop-public-list').replaceChildren(...(rooms.length ? rooms.map((r) => {
        const row = document.createElement('div');
        row.className = 'room';
        const full = r.players >= r.max;
        const name = document.createElement('b');
        name.textContent = r.host;
        const info = document.createElement('span');
        info.className = 'who';
        info.textContent = `${(DISTRICTS[r.map] || { label: r.map }).label} · ${MODES[r.mode]} · ${r.players} of ${r.max} players` +
          (r.live ? ' · under way, can be joined' : '');
        const join = document.createElement('button');
        join.type = 'button';
        join.textContent = full ? 'Full' : r.live ? 'Join race' : 'Join';
        join.disabled = full;
        join.addEventListener('click', () => { $('coop-code').value = r.code; open(false); });
        row.append(name, info, join);
        return row;
      }) : [Object.assign(document.createElement('p'), {
        className: 'mode-help',
        textContent: directory ? 'No public games right now. Host one and tick Public to list it here.' : 'Looking for public games…',
      })]));
    }
    for (const o of $('coop-mode').options) if (o.value === 'wars') o.disabled = !GANGS[s.district];
    const room = DISTRICTS[s.district];
    $('coop-needed').textContent = room ? `Players: 1 to ${isGhostRace(s.pacing) ? roomSize(s) : room.maxPlayers || MAX_PLAYERS}` : '';
    for (const el of document.querySelectorAll('#coop [data-modes]')) el.hidden = !el.dataset.modes.split(' ').includes(s.mode);
    $('coop-mode-help').textContent = HELP[s.mode] || '';
    // Gang Wars: crews and their sides
    const names = [...new Set([...crews.map((c) => c.name), ...known.map((c) => c.name)])];
    $('coop-crew-list').replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));
    // Gang Wars: the crews as cards. Anyone joins or switches with a click (or types a new crew name);
    // the crew's own members pick its gang. Nothing is assigned for them.
    const myId = lobby ? lobby.t.id : null;
    const mine = lobby ? (lobby.players.find((p) => p.id === myId) || {}).crew : '';
    const taken = new Set(crews.map((c) => c.side).filter(Boolean));
    const cards = crews.map((c) => {
      const row = document.createElement('div');
      row.className = `crew${c.name === mine ? ' mine' : ''}`;
      row.style.setProperty('--c', c.colour);
      const name = document.createElement('b');
      name.textContent = c.name;
      row.append(name);
      const member = c.name === mine;
      if (member || host) {
        const pick = document.createElement('select');
        pick.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Pick a gang…' }));
        for (const [code, label] of GANGS[s.district] || []) {
          const held = taken.has(code) && c.side !== code;
          pick.append(Object.assign(document.createElement('option'), { value: code, textContent: held ? `${label} (taken)` : label, disabled: held }));
        }
        pick.value = c.side || '';
        pick.addEventListener('change', () => (member ? lobby.pickSide(pick.value) : lobby.setSettings({ sides: { ...lobby.settings.sides, [c.name]: pick.value || undefined } })));
        row.append(pick);
      } else {
        const gang = document.createElement('span');
        gang.textContent = c.gang ? `sides with ${c.gang}` : 'has not picked a gang';
        row.append(gang);
      }
      const who = document.createElement('span');
      who.className = 'who';
      const saved = known.find((k) => k.name.toLowerCase() === c.name.toLowerCase());
      who.textContent = lobby.players.filter((p) => p.crew === c.name).map((p) => p.name).join(', ') +
        (saved ? ` · reputation ${saved.reputation}, ${saved.wins} wins` : ' · new crew');
      row.append(who);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = member ? 'Leave' : 'Join';
      button.addEventListener('click', () => setCrew(member ? '' : c.name));
      row.append(button);
      return row;
    });
    const loners = lobby ? lobby.players.filter((p) => !p.crew).map((p) => p.name) : [];
    if (loners.length) {
      const note = document.createElement('p');
      note.className = 'mode-help';
      note.textContent = `No crew yet: ${loners.join(', ')}. Join a crew above, or type a new crew name.`;
      cards.push(note);
    }
    $('coop-crews').replaceChildren(...cards);
    if (lobby && !crewSent && savedCrew && (lobby.host || lobby.hostId)) { crewSent = true; lobby.setCrew(savedCrew); }
    $('coop-start').hidden = !host;
    const why = host ? lobby.startProblem() : '';
    $('coop-start').disabled = !!why;
    $('coop-start-why').textContent = why;
    // in a room: no host/join boxes; Cancel (host) or Leave room (guest)
    $('coop-entry').hidden = !!lobby;
    nameInput.disabled = !!lobby;
    $('coop-leave').hidden = !lobby;
    $('coop-leave').textContent = host ? 'Cancel' : 'Leave room';
    // the invite link: opens this page with the room ready to join (on our server, it also logs a friend in)
    $('coop-invite').hidden = !lobby;
    if (lobby) {
      const link = new URL(location.pathname + location.search, location.href);
      if (onSite) {
        if (serverConfig.invite) link.searchParams.set('invite', serverConfig.invite);
        link.searchParams.set('coop', '');
      }
      link.hash = lobby.code;
      $('coop-link').value = link.href;
    }
    // joining: what is happening, and a way to start over
    const looking = !!lobby && !lobby.host && !lobby.players.length && !lobby.refused && !lobby.hostGone;
    const tried = Math.round((performance.now() - attemptSince) / 1000);
    $('coop-retry').hidden = !looking || performance.now() - attemptSince < OFFER_RETRY_MS;
    $('coop-state').classList.toggle('busy', looking || (!!lobby && !lobby.host && lobby.started && !lobby.ready));
    $('coop-state').textContent = !lobby ? (invited && $('coop-code').value === invited ? `You were invited to room ${invited}: enter your name and press Join.` : '')
      : lobby.host
        ? `Room ${lobby.code}. ${lobby.players.length} of ${isGhostRace(s.pacing) ? roomSize(s) : (DISTRICTS[s.district] || {}).maxPlayers || MAX_PLAYERS} players. Start when everyone is here, or play alone.`
        : lobby.hostGone ? `The host closed room ${lobby.code}. Press Leave room, then host or join another game.`
        : lobby.refused ? `The game in room ${lobby.code} has already started. Only Ghost and Contact sync games can be joined once under way.`
        : lobby.started && !lobby.ready ? `Joining the game in room ${lobby.code}…`
        : lobby.players.length ? `In room ${lobby.code}. Waiting for the host to start.`
          : `${lobby.t.peers && lobby.t.peers.size ? `Connected, waiting for the host of room ${lobby.code} to answer`
            : lobby.t.heardOthers && lobby.t.heardOthers() ? `Found room ${lobby.code}, connecting to the host`
              : `Looking for room ${lobby.code}`}… ${tried} s${attempt > 1 ? ` (try ${attempt})` : ''}.` +
            (tried * 1000 >= OFFER_RETRY_MS ? ` Not getting in? Press Try again (it also tries again by itself every ${RETRY_MS / 1000} s), or check the room code with the host.` : '');
  };
  const open = async (host, retry = false) => {
    const name = (nameInput.value || 'Player').trim().slice(0, 16);
    try { localStorage.setItem('gta2-port-coop-name', name); } catch { /* storage unavailable */ }
    const code = (host && rematch && rematch.host && rematch.code) || (host ? Math.random().toString(36).slice(2, 8).toUpperCase()
      : $('coop-code').value.trim().toUpperCase());
    if (!code) { setStatus('Enter the room code you were given.', true); return; }
    if (host) $('coop-code').value = '';
    for (const b of ['coop-host', 'coop-join']) $(b).disabled = true;
    if (onSite) serverGameFiles(); // the game files, while the room fills (a static site: from the Internet Archive)
    // ?coop&local: tabs of this browser only (BroadcastChannel), for testing
    let transport;
    try {
      transport = new URLSearchParams(location.search).has('local') || testMap ? new LocalTransport(code)
        : serverConfig && serverConfig.relay ? await ServerTransport.create(code, serverConfig.relay)
          : await WebRtcTransport.create(code);
    } catch (err) {
      setStatus(`Could not set up the connection: ${err.message}`, true);
      for (const b of ['coop-host', 'coop-join']) $(b).disabled = false;
      return;
    }
    lobby = new CoopLobby(transport, {
      name, host, onChange: render,
      onStart: async (match) => {
        clearInterval(pinger);
        // a started match cannot be joined, so it leaves the list; a ghost race stays (its host lists it)
        if (directory && !(lobby.host && isGhostRace(match.pacing))) directory.leave();
        else render(); // a ghost race's listing now says it is under way
        await mapsReady;
        if (!DISTRICTS[match.district]) {
          setStatus('The host chose a map this version of the game does not have.', true);
          return;
        }
        setStatus(`Starting ${MODES[match.mode] || 'co-op'} on ${DISTRICTS[match.district].label} with ${match.players.length} player${match.players.length === 1 ? '' : 's'}…`);
        try {
          const files = await coopFiles();
          start(async () => files, { coop: { lobby, ...match }, cacheAfterStart: needsCaching() });
        } catch (err) { setStatus(err.message, true); }
      },
    });
    lobby.code = code; // before the settings: a public room is listed by its code
    // the host's last settings (or, straight after a match, that match's)
    if (host) lobby.setSettings({ ...savedSettings(), ...(rematch && rematch.settings) });
    window.gta2Lobby = lobby; // for tests
    pinger = setInterval(() => lobby.measurePings(), 2000);
    if (!host) {
      // while looking for the room: the time and stage each second; starts over now and then
      if (!retry) attempt = 0;
      attemptSince = performance.now();
      attempt++;
      clearInterval(lookingTimer);
      lookingTimer = setInterval(() => {
        if (!lobby || lobby.host || lobby.players.length || lobby.refused || lobby.hostGone) {
          if (!lobby || !lobby.started || lobby.ready) clearInterval(lookingTimer); // (a late join: until its game is up)
          render();
          return;
        }
        if (performance.now() - attemptSince > RETRY_MS) { retryJoin(); return; }
        render();
      }, 1000);
    }
    render();
  };
  // Cancel (host) / Leave room (guest): out of the room, back to hosting or joining
  const close = () => {
    if (!lobby || lobby.started) return;
    clearInterval(pinger);
    clearInterval(lookingTimer);
    if (directory) directory.announce(null);
    lobby.onChange = () => {};
    lobby.t.leave();
    lobby = null;
    window.gta2Lobby = null;
    for (const b of ['coop-host', 'coop-join']) $(b).disabled = false;
    setStatus('');
    render();
  };
  $('coop-leave').addEventListener('click', close);
  // joining: start over with a new connection (the room code stays in the box)
  const retryJoin = () => {
    if (!lobby || lobby.host || lobby.started) return;
    const code = lobby.code;
    close();
    $('coop-code').value = code;
    open(false, true);
  };
  $('coop-retry').addEventListener('click', retryJoin);
  $('coop-copy').addEventListener('click', () => {
    const done = (text) => { $('coop-copy').textContent = text; setTimeout(() => { $('coop-copy').textContent = 'Copy link'; }, 2000); };
    navigator.clipboard.writeText($('coop-link').value).then(() => done('Copied!'), () => { $('coop-link').select(); done('Press Ctrl+C'); });
  });
  // after a match: straight back into the same room, as host or guest
  let rematch = null;
  try { rematch = JSON.parse(sessionStorage.getItem('gta2-coop-rematch') || 'null'); sessionStorage.removeItem('gta2-coop-rematch'); } catch { /* storage unavailable */ }
  if (rematch && rematch.code) {
    if (!rematch.host) $('coop-code').value = rematch.code;
    setTimeout(() => open(!!rematch.host), 0);
  }
  $('coop-host').addEventListener('click', () => open(true));
  $('coop-join').addEventListener('click', () => open(false));
  $('coop-start').addEventListener('click', () => lobby && lobby.start());
  if (testMap && !(rematch && rematch.code)) {
    (async () => {
      await mapsReady;
      const d = DISTRICTS[testMap];
      if (!d) { setStatus(`There is no map "${testMap}" on this site.`, true); return; }
      await open(true);
      if (!lobby) return;
      lobby.setSettings({ district: testMap, public: false, ...(d.lighting ? { lighting: d.lighting } : {}) });
      const problem = lobby.startProblem();
      if (problem) { setStatus(problem, true); return; }
      lobby.start();
    })();
  }
  // host: match settings
  // numbers: whole, 0 = none; the game's time limit stops at 60 minutes
  const LIMITS = { minutes: 60, killLimit: 999, pointsTarget: 100000000 };
  for (const [id, key] of [['coop-mode', 'mode'], ['coop-district', 'district'], ['coop-pacing', 'pacing'], ['coop-minutes', 'minutes'],
    ['coop-kills', 'killLimit'], ['coop-points', 'pointsTarget'], ['coop-lighting', 'lighting']]) {
    $(id).addEventListener('change', () => {
      if (!lobby) return;
      let value = $(id).value;
      if (key in LIMITS) value = Math.max(0, Math.min(LIMITS[key], Math.round(Number(value) || 0)));
      const changes = { [key]: value };
      if (key === 'district') {
        // a map made for dusk or noon comes with it (the host can change it after)
        if (DISTRICTS[value] && DISTRICTS[value].lighting) changes.lighting = DISTRICTS[value].lighting;
        if (lobby.settings.mode === 'wars' && !GANGS[value]) changes.mode = 'roam'; // Gang Wars needs a district with street gangs
      }
      lobby.setSettings(changes);
      if (changes.mode) return;
      $(id).value = String(value);
    });
  }
  // Options before playing (web/options.js)
  let lobbyOptions = null;
  $('lobby-options').addEventListener('click', () => {
    lobbyOptions = lobbyOptions || new OptionsScreen();
    lobbyOptions.show();
  });
  $('coop-ff').addEventListener('change', () => lobby && lobby.setSettings({ friendlyFire: $('coop-ff').checked }));
  $('coop-pub').addEventListener('change', () => lobby && lobby.setSettings({ public: $('coop-pub').checked }));
  $('coop-police').addEventListener('change', () => lobby && lobby.setSettings({ police: $('coop-police').checked }));
  $('coop-crew').addEventListener('change', () => setCrew($('coop-crew').value));
  showLastResults();
  render();
}

/**
 * Starts without asking when the game files are already available:
 * 1. the local server's copy of the game folder (scripts/serve_port.py
 *    --dev-data, which only listens on this computer);
 * 2. the copy kept in this browser after the folder was picked once.
 * Otherwise the folder picker stays. ?choose=1 always shows the picker.
 * (?play: the main page is the multiplayer lobby.)
 */
async function autoStart() {
  try {
    const res = await fetch('gamedata/manifest.json', { cache: 'no-store' });
    if (res.ok) {
      setStatus('Loading game files from this computer…');
      start(collectDevFiles);
      return;
    }
  } catch { /* no local game folder */ }
  if (await fileCache.info()) {
    setStatus('Loading game files from this browser…');
    start(() => fileCache.load());
  }
}

/** ?choose=1: the picker, plus Play / Forget for the copy kept in this browser. */
function offerSavedFiles() {
  fileCache.info().then((info) => {
    if (!info) return;
    $('saved-info').textContent = `Your GTA2 files are saved in this browser (${Math.round(info.bytes / 1048576)} MB).`;
    $('saved').hidden = false;
    $('play-saved').addEventListener('click', () => {
      setStatus('Loading game files from this browser…');
      start(() => fileCache.load());
    });
    $('forget-files').addEventListener('click', async () => {
      await fileCache.forget();
      $('saved').hidden = true;
      setStatus('Game files removed from this browser.');
    });
  });
}
