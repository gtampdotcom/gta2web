// The Saves screen (single player): the autosave and six slots, each a card with a picture of
// the moment, the area, district, cash and wanted level. Save here, load or delete; the game is
// paused while it is open. Opened (and closed) with Ctrl+S / ⌘S or F5, or the toolbar's Saves button.
import { LOAD_KEY, SAVE_KEY, SAVE_MIN_COST, SLOTS, deleteSave, listSaves, saveCost, slotName } from './savestate.js?v=5a148f500b';

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

/** "just now", "5 min ago", "yesterday", or a date. */
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The card's lines: where ("Chinatown, Downtown") and how ("$12,500 · ★★ · 5 min ago"). */
export function describe(save) {
  const l = save.label || {};
  const where = [l.area, l.district].filter(Boolean).join(', ') || 'Somewhere in the city';
  const how = [`$${(l.cash || 0).toLocaleString()}`, l.stars ? '★'.repeat(l.stars) : '', ago(save.savedAt)].filter(Boolean).join(' · ');
  return { where, how };
}

export class SavesScreen {
  /**
   * @param {object} opts
   * @param {import('./savestate.js?v=5a148f500b').SaveStates} opts.states
   * @param {(paused: boolean) => void} opts.pause pauses the game and its sound (as the map screen does)
   * @param {() => void} opts.onClose gives the keyboard back to the game
   */
  constructor({ states, pause, onClose }) {
    this.states = states;
    this.pause = pause;
    this.onClose = onClose;
    this.open = false;
    this.picture = null;
    this.urls = [];
    this.root = el('div', { id: 'saves-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Saves', hidden: '' });
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    document.body.append(this.root);
    states.screen = this;
  }

  async show() {
    if (this.open) return;
    this.open = true;
    this.canSave = this.states.canSave();
    // Fair saving: why a save is not allowed now (wanted, on a job, not enough cash), or null
    this.blocked = this.canSave ? this.states.whyNot() : null;
    // the picture first, while the game is still on screen
    this.picture = this.canSave ? await this.states.picture() : null;
    this.pause(true);
    this.root.hidden = false;
    await this.render();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.dropUrls();
    this.pause(false);
    this.onClose();
  }

  dropUrls() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  /** While open: Esc closes, and no key reaches the game. */
  handleKey(e, down) {
    if (!this.open) return false;
    if (down && !e.repeat && (e.code === 'Escape' || e.code === 'F5' || e.code === 'F9' || ((e.metaKey || e.ctrlKey) && (e.code === 'KeyS' || e.code === 'KeyO')))) this.close();
    return true;
  }

  async render() {
    const saves = new Map((await listSaves()).map((s) => [s.slot, s]));
    // Older versions this server still has (old/<build>/, the local server only): a save made by
    // one opens there, since a save only loads in the build that made it.
    const older = [...new Set([...saves.values()].filter((s) => !s.current && s.build).map((s) => s.build))];
    const kept = await Promise.all(older.map((b) => fetch(`old/${b}/gta2.wasm`, { method: 'HEAD', cache: 'no-store' })
      .then((r) => (r.ok ? b : null), () => null)));
    this.oldVersions = new Set(kept.filter(Boolean));
    if (!this.open) return;
    this.dropUrls();
    const grid = el('div', { class: 'saves-grid' });
    for (const slot of SLOTS) grid.append(this.card(slot, saves.get(slot)));
    // the autosave, and a quick save from an earlier version: loadable, not saved to
    for (const slot of ['quick', 'auto']) if (saves.has(slot)) grid.prepend(this.card(slot, saves.get(slot)));
    this.root.replaceChildren(el('div', { class: 'saves-panel' },
      el('div', { class: 'saves-head' },
        el('h2', {}, 'Saves'),
        el('span', { class: 'saves-keys' }, `Open and close with ${SAVE_KEY} or ${LOAD_KEY} · Esc closes`),
        el('button', { type: 'button', class: 'saves-close', 'aria-label': 'Close', onclick: () => this.close() }, '✕')),
      el('p', { class: 'saves-note' }, !this.canSave ? 'Start a game to save. You can load a save from here at any time.'
        : this.blocked ? `${this.blocked} You can still load.`
          : `Saving now costs $${saveCost(this.states.cash()).toLocaleString()} (20% of your $${this.states.cash().toLocaleString()}, at least $${SAVE_MIN_COST.toLocaleString()}), one save every 2 minutes. No saving while wanted or during a job. Passing a job or a kill frenzy autosaves for free.`),
      grid,
      el('p', { class: 'saves-note' }, 'Saves stay in this browser. A save made before an update can’t be loaded by the new version.')));
  }

  card(slot, save) {
    const card = el('div', { class: `save-card${save ? '' : ' empty'}` });
    let picture;
    if (save && save.thumb) {
      const url = URL.createObjectURL(save.thumb);
      this.urls.push(url);
      picture = el('img', { src: url, alt: '' });
    } else {
      picture = el('div', { class: 'save-blank' }, save ? '' : 'Empty');
    }
    const text = save ? describe(save) : null;
    const actions = el('div', { class: 'save-actions' });
    if (this.canSave && !this.blocked && SLOTS.includes(slot)) {
      // the first click asks for the price (the game is paused, so it is the price when you confirm)
      const price = `$${saveCost(this.states.cash()).toLocaleString()}`;
      actions.append(this.confirmButton(save ? 'Save here' : 'Save', save ? `Overwrite: ${price}?` : `Pay ${price}?`, () => this.saveTo(slot), 'primary'));
    }
    if (save) {
      const elsewhere = !save.current && this.oldVersions.has(save.build);
      const load = elsewhere
        ? el('button', { type: 'button', title: 'Opens the version of the game that made this save, in a new tab',
          onclick: () => window.open(`old/${save.build}/`, '_blank') }, 'Open in its version')
        : el('button', { type: 'button', onclick: () => this.loadFrom(slot) }, 'Load');
      if (!save.current && !elsewhere) { load.disabled = true; load.title = 'Made by an older version of the game'; }
      actions.append(load, this.confirmButton('Delete', 'Delete?', async () => { await deleteSave(slot); this.render(); }, 'quiet'));
    }
    card.append(picture, el('div', { class: 'save-text' },
      el('span', { class: 'save-slot' }, slotName(slot)),
      text ? el('strong', {}, text.where) : '',
      text ? el('small', {}, save.current ? text.how : `${text.how} · older version`) : ''),
    actions);
    return card;
  }

  /** A button that asks once ("Overwrite?") before it acts. */
  confirmButton(label, ask, act, cls) {
    const b = el('button', { type: 'button', class: cls }, label);
    let armed = !ask;
    b.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        b.textContent = ask;
        b.classList.add('armed');
        setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 5000);
        return;
      }
      b.disabled = true;
      await act();
    });
    return b;
  }

  async saveTo(slot) {
    // the game is paused behind this screen, so the save is the moment the screen opened
    if (await this.states.save(slot, { picture: this.picture })) this.close();
    else this.render();
  }

  async loadFrom(slot) {
    this.close();
    await this.states.load(slot);
  }
}
