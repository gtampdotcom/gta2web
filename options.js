// The Options screen: the settings the toolbar has no button for (language, screen shape, HUD,
// motion). Opened from the lobby and from the toolbar (or the touch menu) while playing. Kept in
// this browser; the shell applies a change at once when it can (onChange).
import { LANG_KEY, LANGS } from './gamelang.js?v=5a148f500b';

export const OPTIONS = [
  { key: LANG_KEY, label: 'Game language',
    hint: 'Español is the original translation. Français covers menus and messages; missions stay in English. Used from the next game.',
    choices: Object.entries(LANGS), fallback: 'en' },
  { key: 'gta2-port-aspect', label: 'Screen shape', hint: 'Widescreen shows more of the city to the sides.',
    choices: [['16:9', '16:9'], ['auto', 'Fill window'], ['4:3', '4:3 original']], fallback: '16:9' },
  { key: 'gta2-port-hud', label: 'HUD', hint: 'Where score, wanted level and messages sit on a wide screen.',
    choices: [['edges', 'Screen edges'], ['centre', 'Centred']], fallback: 'edges' },
  { key: 'gta2-port-smooth', label: 'Motion', hint: 'Smooth draws extra frames to match your screen (60–165 Hz).',
    choices: [['1', 'Smooth'], ['0', 'Original 30 fps']], fallback: '1' },
];

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, v) => { try { localStorage.setItem(key, v); } catch { /* storage unavailable: this visit only */ } };

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

export class OptionsScreen {
  /**
   * @param {object} [opts]
   * @param {(key: string, value: string) => void} [opts.onChange] applies a change
   * @param {(paused: boolean) => void} [opts.pause] pauses the game while the screen is open
   * @param {() => void} [opts.onClose] gives the keyboard back to the game
   */
  constructor({ onChange = () => {}, pause = () => {}, onClose = () => {} } = {}) {
    this.onChange = onChange;
    this.pause = pause;
    this.onClose = onClose;
    this.open = false;
    this.root = el('div', { class: 'options-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Options', hidden: '' });
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    document.body.append(this.root);
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.pause(true);
    this.root.hidden = false;
    this.render();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.pause(false);
    this.onClose();
  }

  /** While open, Esc closes it and the game sees no keys. */
  handleKey(e, down) {
    if (!this.open) return false;
    if (down && e.code === 'Escape') this.close();
    return true;
  }

  render() {
    const list = el('div', { class: 'options-list' });
    for (const o of OPTIONS) {
      const current = read(o.key) ?? o.fallback;
      const group = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': o.label });
      for (const [value, text] of o.choices) {
        group.append(el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(value === current), 'data-value': value,
          onclick: () => {
            write(o.key, value);
            for (const b of group.children) b.setAttribute('aria-checked', String(b.dataset.value === value));
            this.onChange(o.key, value);
          },
        }, text));
      }
      list.append(el('div', { class: 'opt' }, el('div', { class: 'opt-label' }, el('strong', {}, o.label), el('small', {}, o.hint)), group));
    }
    this.root.replaceChildren(el('div', { class: 'saves-panel options-panel' },
      el('div', { class: 'saves-head' },
        el('h2', {}, 'Options'),
        el('span', { class: 'saves-keys' }, 'Saved in this browser.'),
        el('button', { type: 'button', class: 'saves-close', 'aria-label': 'Close', onclick: () => this.close() }, '✕')),
      list,
      el('div', { class: 'controls-actions' },
        el('button', { type: 'button', class: 'primary', onclick: () => this.close() }, 'Done'))));
  }
}
