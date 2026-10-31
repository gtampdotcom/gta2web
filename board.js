// The site's own message board (board.php), for when the site runs PHP: the public games list and
// setting up connections between players (WebRTC signalling) go through it instead of public
// trackers or brokers. Browsers poll it; nothing stays on it for more than a minute.

import { createTopicStrategy, selfId } from './vendor/trystero/core/index.mjs?v=1256913706';

const URL_ = 'board.php';
const POLL_MS = 1000;
// How often a page in a room says it is there. trystero's default with a board like this is once a
// minute after the first two seconds, so when that first exchange with the host fails (it sometimes
// does), nothing tries again for a minute. Every few seconds, a failed attempt is retried at once.
const ANNOUNCE_MS = 4000;

/**
 * What this page has heard on the board in its rooms: when another player was last heard from
 * (0: nobody yet), for the lobby to tell "looking for the room" from "found it, connecting".
 */
export const boardActivity = { lastOther: 0 };

let available = null;

/** Whether this site has a working board.php (a static host sends the PHP file as text, or nothing). */
export function boardAvailable() {
  available ||= fetch(`${URL_}?since=-1`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => !!data && Number.isInteger(data.last))
    .catch(() => false);
  return available;
}

async function post(body) {
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`board: error ${res.status}`);
}

/** Polls the board for messages on the topics someone here listens to. */
class BoardClient {
  constructor() {
    this.handlers = new Map(); // topic -> Set of (topic, text) => void
    this.since = null;
    this.timer = 0;
    this.started = null;
  }

  /** Starts after the messages already on the board: only new ones are delivered. */
  start() {
    this.started ||= fetch(`${URL_}?since=-1`, { cache: 'no-store' }).then((res) => res.json()).then((data) => {
      this.since = data.last;
    });
    return this.started;
  }

  subscribe(topic, handler) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic).add(handler);
    this.schedule();
    return () => {
      const set = this.handlers.get(topic);
      if (!set) return;
      set.delete(handler);
      if (!set.size) this.handlers.delete(topic);
    };
  }

  publish(topic, text) {
    return post({ t: topic, m: text }).catch((err) => console.warn(err.message));
  }

  schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  async poll() {
    this.timer = 0;
    if (!this.handlers.size) return;
    try {
      await this.start();
      const topics = [...this.handlers.keys()].map(encodeURIComponent).join(',');
      const res = await fetch(`${URL_}?t=${topics}&since=${this.since}`, { cache: 'no-store' });
      const data = await res.json();
      this.since = Math.max(this.since, data.last);
      for (const m of data.msgs || []) {
        if (fromOther(m.m)) boardActivity.lastOther = Date.now();
        for (const handler of [...(this.handlers.get(m.t) || [])]) handler(m.t, m.m);
      }
    } catch { /* the next poll tries again */ }
    this.schedule();
  }
}

const client = new BoardClient();

/** Whether a board message (trystero's JSON, with the sender's peerId) is from another page. */
function fromOther(text) {
  try {
    const { peerId } = JSON.parse(text);
    return typeof peerId === 'string' && peerId !== selfId;
  } catch {
    return false;
  }
}

/** trystero's joinRoom, finding players through this board (the same rooms as the other strategies). */
export const joinRoom = createTopicStrategy({
  steadyAnnounceIntervalMs: ANNOUNCE_MS,
  init: () => client.start().then(() => client),
  subscribeTopic: (c, topic, onMessage) => c.subscribe(topic, onMessage),
  publishTopic: (c, topic, msg) => void c.publish(topic, typeof msg === 'string' ? msg : JSON.stringify(msg)),
});
export { selfId };

/**
 * The public games list on this board: each public room is a kept message on rooms/<code>, which
 * the host refreshes every 10 s; the board drops it 30 s after the last refresh. Same interface as
 * MqttDirectory (web/net.js).
 */
export class BoardDirectory {
  constructor(cleanRoom) {
    this.cleanRoom = cleanRoom;
    this.rooms = new Map();
    this.mine = null;
    this.sent = '';
    this.onChange = () => {};
    this.timer = setInterval(() => this.refresh(), 3000);
    this.republish = 0;
    this.refresh();
    window.addEventListener('pagehide', () => this.leave());
  }

  async refresh() {
    let data;
    try {
      data = await (await fetch(`${URL_}?kept=rooms/`, { cache: 'no-store' })).json();
    } catch { return; }
    const rooms = new Map();
    for (const { t, m } of data.kept || []) {
      let room;
      try { room = this.cleanRoom(JSON.parse(m)); } catch { continue; }
      const code = t.slice('rooms/'.length);
      if (room && room.code === code && !(this.mine && this.mine.code === code)) rooms.set(code, room);
    }
    const before = JSON.stringify([...this.rooms]);
    this.rooms = rooms;
    if (JSON.stringify([...rooms]) !== before) this.onChange();
  }

  publish() {
    if (this.mine) post({ t: `rooms/${this.mine.code}`, m: JSON.stringify(this.mine), keep: true }).catch(() => {});
  }

  /** Lists this page's room (or takes it off the list with null). */
  announce(room) {
    const text = JSON.stringify(room);
    if (text === this.sent) return;
    const was = this.mine;
    this.mine = room;
    this.sent = text;
    if (was && (!room || room.code !== was.code)) post({ t: `rooms/${was.code}`, m: '', keep: true }).catch(() => {});
    this.publish();
    clearInterval(this.republish);
    if (room) this.republish = setInterval(() => this.publish(), 10000);
  }

  list() { return [...this.rooms.values()].sort((a, b) => a.code.localeCompare(b.code)); }

  leave() {
    clearInterval(this.timer);
    if (this.mine) {
      // as the page goes away: a beacon still gets out
      navigator.sendBeacon(URL_, new Blob([JSON.stringify({ t: `rooms/${this.mine.code}`, m: '', keep: true })], { type: 'application/json' }));
    }
    this.mine = null;
    this.sent = 'null';
    clearInterval(this.republish);
  }
}
