// Co-op text chat (D20): T to type, Enter to send, Esc to cancel. Messages go
// through the lobby's transport as lobby messages, outside the game, so they
// never affect the lockstep simulation. New lines show for a few seconds; while
// the chat is open, the whole match's chat shows above it, scrollable.

const SHOW_MS = 9000;
const MAX_LINES = 8;
const MAX_HISTORY = 500; // lines kept for the match (the oldest go first)

export class CoopChat {
  /**
   * @param {object} opts
   * @param {object} opts.lobby CoopLobby (sendChat, onChat)
   * @param {(slot: number) => string} opts.name
   * @param {(slot: number) => string} opts.colour
   * @param {number} opts.mySlot
   * @param {() => void} opts.releaseKeys lets go of game keys when typing starts
   */
  constructor({ lobby, name, colour, mySlot, releaseKeys }) {
    this.lobby = lobby;
    this.name = name;
    this.colour = colour;
    this.mySlot = mySlot;
    this.releaseKeys = releaseKeys;
    this.log = document.createElement('div');
    this.log.id = 'chat-log';
    this.log.setAttribute('aria-live', 'polite');
    this.input = document.createElement('input');
    this.input.id = 'chat-input';
    this.input.maxLength = 160;
    this.input.placeholder = 'Say something… (Enter to send, Esc to cancel)';
    this.input.hidden = true;
    this.input.setAttribute('aria-label', 'Chat message');
    // the match's chat so far, shown while typing
    this.history = document.createElement('div');
    this.history.id = 'chat-history';
    this.history.hidden = true;
    this.history.setAttribute('aria-label', 'Chat so far');
    // scrolling or clicking it keeps the chat open (the input would otherwise lose focus and close)
    this.history.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(this.log, this.history, this.input);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.send(this.input.value); this.close(); e.preventDefault(); }
      else if (e.key === 'Escape') { this.close(); e.preventDefault(); }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('blur', () => this.close());
    lobby.onChat = (slot, text) => this.add(slot, text);
    // (a keyboard hint: not on touch screens, which have no T to press)
    if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) this.add(-1, 'Press T to chat.');
  }

  get open() { return !this.input.hidden; }

  /** Keys while playing: T opens the chat. Returns true when the key is the chat's. */
  handleKey(e, down) {
    if (this.open) return true;
    if (e.code === 'KeyT' && down && !e.repeat) {
      this.releaseKeys();
      this.input.hidden = false;
      this.input.value = '';
      this.history.hidden = !this.history.children.length;
      this.log.hidden = !this.history.hidden; // the history shows the same lines
      this.history.scrollTop = this.history.scrollHeight;
      setTimeout(() => this.input.focus(), 0);
      return true;
    }
    return false;
  }

  close() {
    if (!this.open) return;
    this.input.hidden = true;
    this.history.hidden = true;
    this.log.hidden = false;
    this.input.blur();
    const screen = document.getElementById('screen');
    if (screen) screen.focus();
  }

  send(raw) {
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!text) return;
    this.lobby.sendChat(text);
    this.add(this.mySlot, text);
  }

  add(slot, text) {
    const line = document.createElement('p');
    if (slot >= 0) {
      const who = document.createElement('b');
      who.textContent = `${this.name(slot)}: `;
      who.style.color = this.colour(slot);
      line.append(who);
    } else {
      line.className = 'note';
    }
    line.append(document.createTextNode(text));
    this.log.append(line);
    while (this.log.children.length > MAX_LINES) this.log.firstChild.remove();
    setTimeout(() => line.classList.add('old'), SHOW_MS);
    // the match's history (players' messages, not the page's own notes)
    if (slot < 0) return;
    const atEnd = this.history.scrollTop + this.history.clientHeight >= this.history.scrollHeight - 4;
    this.history.append(line.cloneNode(true));
    while (this.history.children.length > MAX_HISTORY) this.history.firstChild.remove();
    if (this.open) {
      this.history.hidden = false;
      this.log.hidden = true;
      if (atEnd) this.history.scrollTop = this.history.scrollHeight; // follow new lines unless scrolled back
    }
  }
}
