// Co-op lobby and transport (D20): free roam in a story district with GTA2's
// own network game, lockstep, peer-to-peer. Every player runs the full game;
// only each tick's inputs travel, a few bytes per player.
//
// A transport moves small messages between the players in a room, reliably
// and in order, with one interface (id, join(), send(), leave(), onMessage,
// onPeerJoined, onPeerLeft):
//   WebRtcTransport - the internet: players talk directly, peer to peer, over
//                     WebRTC data channels. No server of ours: public
//                     WebTorrent trackers only introduce the players to each
//                     other (Trystero, web/vendor/trystero), STUN finds a route.
//   ServerTransport - through our own game server (D21, server/server.mjs):
//                     a WebSocket to the server, which relays to the room.
//                     Works on every network.
//   LocalTransport  - BroadcastChannel between tabs of this browser (testing).
//
// Lobby protocol (JSON): hello {name}, crew {crew} (a player's Gang Wars crew),
// roster {players: [{id, name, crew}], settings} from the
// host, start {district, players: [{id, name}], delay, friendlyFire} from the host, loaded (a
// player's game files are ready) and go (everyone's are) for entering the
// match together, and wp {wp: {x, y} | null} (a player's waypoint, shown to
// the others; not part of the game, so it never affects the simulation), and
// sync {tick, h} (a checksum of the game at a tick, compared by everyone to
// catch games drifting apart), and chat {text}. Game messages
// are binary and go straight to the core (gta2_port_net_receive).

// The original's multiplayer setups for the three story districts (data/*.mmp).
// (no prototype: a map name sent by another player, like "constructor", must not find anything)
import { BUNDLE, MatchClock } from './clock.js?v=1256913706';

export const DISTRICTS = Object.assign(Object.create(null), {
  // (the original's scripts start at 2 players; one player alone uses the 2-player script)
  // (author: the lobby's map search; the original game's maps are DMA Design's)
  downtown: { label: 'Downtown', author: 'DMA Design', gmp: 'wil-multi.gmp', sty: 'wil.sty', scr: (n) => `downtown-${Math.max(2, n)}p.scr` },
  residential: { label: 'Residential', author: 'DMA Design', gmp: 'ste.gmp', sty: 'ste.sty', scr: (n) => `res-${Math.max(2, n)}p.scr` },
  industrial: { label: 'Industrial', author: 'DMA Design', gmp: 'bil-multi.gmp', sty: 'bil.sty', scr: (n) => `Industrial-${Math.max(2, n)}P.scr` },
  // the original's multiplayer maps (data/mp*.mmp): no street gangs, so no Gang Wars
  tinytown: { label: 'Tiny Town', author: 'DMA Design', gmp: 'mp1-comp.gmp', sty: 'bil.sty', scr: (n) => `mp1-${Math.max(2, n)}p.scr` },
  hiddensurprise: { label: 'Hidden Surprise', author: 'DMA Design', gmp: 'mp2-comp.gmp', sty: 'wil.sty', scr: (n) => `mp2-${Math.max(2, n)}p.scr` },
  faceoff: { label: 'Face Off', author: 'DMA Design', gmp: 'mp5-comp.gmp', sty: 'ste.sty', scr: (n) => `mp5-${Math.max(2, n)}p.scr` },
});
export const MAX_PLAYERS = 6;
// Ghost races (web/ghosts.js): everyone plays their own game, so the room can be bigger.
export const GHOST_MAX_PLAYERS = 16;
/** Ghost races, see-through ('ghost') or solid ('solid': the others are real cars and characters you can bump into). */
export const isGhostRace = (pacing) => pacing === 'ghost' || pacing === 'solid';
/** The most players a room can have with these settings. */
export const roomSize = (settings) => (settings && isGhostRace(settings.pacing) ? GHOST_MAX_PLAYERS : MAX_PLAYERS);

const STOCK_STYLES = new Set(['bil.sty', 'ste.sty', 'wil.sty']);

/**
 * Adds the community maps listed in maps/maps.json to DISTRICTS (no street gangs, so no Gang Wars).
 * An entry: {id, label, author?, dir, gmp, sty, scr or scrs, players?, extra?, sounds?, category?, gxt?, lighting?}.
 * scrs: {"2": "x-2p.scr", ...}, a script per player count. gameFiles: files that are the game's own.
 * handling: the map's car handling file (its mmp's GCIFile; also listed in extra). incompatible: why this
 * game cannot run it (listed, but it cannot be started). scr may contain {n} (one script per player
 * count, 1..players). Names are lower case; files (fetched from maps/<dir>/ into the game's data folder
 * when a match starts) are the map, the script(s), a style that is not the game's own, and extra. sounds: the
 * game's sound bank a custom style without its own borrows (bil, ste or wil; default ste). category: "racing"
 * puts the map in the lobby's Racing group. gxt: the map's own text (a modified e.gxt, under another name),
 * used for its matches only (web/gamelang.js applyMapText). lighting: "dusk" or "noon", what the map is made
 * for (the lobby picks it with the map; the host can change it).
 * @returns {Promise<string[]>} the ids added, in file order
 */
export async function loadMaps() {
  let list = [];
  try {
    const res = await fetch('maps/maps.json', { cache: 'no-cache' });
    if (res.ok) list = (await res.json()).maps || [];
  } catch { /* no community maps */ }
  for (const m of list) {
    // scrs: {players: script} for maps without a script for every count (most start at 2): a match
    // uses the script for the nearest count at or above its players, as the original maps do
    const byCount = m.scrs && typeof m.scrs === 'object'
      ? Object.entries(m.scrs).map(([k, v]) => [Number(k), v]).filter(([k, v]) => k >= 1 && typeof v === 'string').sort((a, b) => a[0] - b[0])
      : null;
    if (byCount ? !byCount.length : typeof m.scr !== 'string') continue;
    const players = Math.min(byCount ? byCount[byCount.length - 1][0] : m.players || MAX_PLAYERS, MAX_PLAYERS);
    const scrs = byCount ? byCount.map(([, v]) => v)
      : m.scr.includes('{n}') ? Array.from({ length: players }, (_, i) => m.scr.replace('{n}', i + 1)) : [m.scr];
    const scrFor = byCount ? (n) => (byCount.find(([k]) => k >= n) || byCount[byCount.length - 1])[1]
      : (n) => m.scr.replace('{n}', Math.min(n, players));
    DISTRICTS[m.id] = {
      label: m.label, author: typeof m.author === 'string' ? m.author : '', gmp: m.gmp, sty: m.sty, community: true,
      lighting: ['dusk', 'noon'].includes(m.lighting) ? m.lighting : null, racing: m.category === 'racing', gxt: m.gxt || null,
      handling: typeof m.handling === 'string' ? m.handling : null,
      incompatible: typeof m.incompatible === 'string' ? m.incompatible.slice(0, 60) : null,
      sounds: ['bil', 'ste', 'wil'].includes(m.sounds) ? m.sounds : 'ste',
      scr: scrFor,
      maxPlayers: players < MAX_PLAYERS ? players : 0,
      dir: `maps/${m.dir}`,
      // (gameFiles: the game's own files a map uses, such as Tiny Town's map: already there, not fetched)
      files: [...new Set([m.gmp, ...scrs, ...(STOCK_STYLES.has(m.sty) ? [] : [m.sty]), ...(m.gxt ? [m.gxt] : []), ...(m.extra || [])])]
        .filter((f) => !(Array.isArray(m.gameFiles) && m.gameFiles.includes(f))),
    };
  }
  return list.map((m) => m.id);
}

// Each district's three street gangs (the multiplayer maps have them all): internal name, name,
// colour. In Gang Wars every crew sides with one; its members treat the crew as their own.
export const GANGS = Object.assign(Object.create(null), {
  downtown: [['zai', 'Zaibatsu', '#c8c8c8'], ['loo', 'Loonies', '#3fd16a'], ['yak', 'Yakuza', '#4fa8ff']],
  residential: [['zai', 'Zaibatsu', '#c8c8c8'], ['red', 'Rednecks', '#ff8a3d'], ['sci', 'SRS Scientists', '#b38bff']],
  industrial: [['zai', 'Zaibatsu', '#c8c8c8'], ['rus', 'Russians', '#ff4d4d'], ['kri', 'Hare Krishnas', '#ffd23f']],
});

// Match modes: free roam (co-op), Gang Wars (crews), free-for-all (the original frag game).
export const MODES = { roam: 'Free Roam', wars: 'Gang Wars', ffa: 'Frag Game', points: 'Points Game', tag: 'Tag Game' };

const cleanCrew = (name) => String(name || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 16);

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Tabs of this browser on the same computer. */
export class LocalTransport {
  constructor(room) {
    this.id = randomId();
    this.channel = new BroadcastChannel(`gta2-coop-${room}`);
    this.peers = new Set();
    this.onMessage = () => {};
    this.onPeerJoined = () => {};
    this.onPeerLeft = () => {};
    this.channel.onmessage = (e) => {
      const m = e.data;
      if (!m || m.from === this.id || (m.to && m.to !== this.id)) return;
      if (m.kind === 'here' || m.kind === 'here-too') {
        if (!this.peers.has(m.from)) { this.peers.add(m.from); this.onPeerJoined(m.from); }
        if (m.kind === 'here') this.channel.postMessage({ kind: 'here-too', from: this.id, to: m.from });
        return;
      }
      if (m.kind === 'bye') { this.peers.delete(m.from); this.onPeerLeft(m.from); return; }
      this.onMessage(m.from, m.data);
    };
    window.addEventListener('pagehide', () => this.leave());
  }
  join() { this.channel.postMessage({ kind: 'here', from: this.id }); }
  send(to, data) { this.channel.postMessage({ kind: 'msg', from: this.id, to: to || null, data }); }
  leave() { try { this.channel.postMessage({ kind: 'bye', from: this.id }); this.channel.close(); } catch { /* closed */ } }
}

/** Players on our game server (D21): everything goes through its relay. */
export class ServerTransport {
  static create(room, path = '/relay') {
    const url = new URL(path, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    return new Promise((ok, fail) => {
      ws.onopen = () => ok(new ServerTransport(ws, room));
      ws.onerror = () => fail(new Error('the game server did not answer'));
    });
  }

  constructor(ws, room) {
    this.ws = ws;
    this.room = room;
    this.id = randomId();
    this.peers = new Set();
    this.onMessage = () => {};
    this.onPeerJoined = () => {};
    this.onPeerLeft = () => {};
    this.pings = new Map();
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const b = new Uint8Array(e.data);
        const from = new TextDecoder().decode(b.subarray(1, 1 + b[0]));
        this.onMessage(from, b.slice(1 + b[0]));
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === 'peers') m.ids.forEach((id) => this.peerJoined(id));
      else if (m.t === 'joined') this.peerJoined(m.id);
      else if (m.t === 'left') { this.peers.delete(m.id); this.onPeerLeft(m.id); }
      else if (m.t === 'msg') this.onMessage(m.from, m.data);
      else if (m.t === 'ping') this.ws.send(JSON.stringify({ t: 'pong', to: m.from, n: m.n }));
      else if (m.t === 'pong') { const done = this.pings.get(m.n); if (done) { this.pings.delete(m.n); done(); } }
      else if (m.t === 'full' || m.t === 'taken') this.onRefused?.(m.t);
    };
    ws.onclose = () => { for (const id of this.peers) this.onPeerLeft(id); this.peers.clear(); };
  }

  peerJoined(id) {
    if (this.peers.has(id)) return;
    this.peers.add(id);
    this.onPeerJoined(id);
  }

  join() { this.ws.send(JSON.stringify({ t: 'join', room: this.room, id: this.id })); }

  send(to, data) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (data instanceof Uint8Array) {
      const target = new TextEncoder().encode(to || '');
      const out = new Uint8Array(1 + target.length + data.length);
      out[0] = target.length;
      out.set(target, 1);
      out.set(data, 1 + target.length);
      this.ws.send(out);
    } else {
      this.ws.send(JSON.stringify({ t: 'msg', to: to || null, data }));
    }
  }

  /** Round trip to a player through the server, in milliseconds. */
  ping(id) {
    const n = Math.random();
    const t0 = performance.now();
    return new Promise((ok, fail) => {
      this.pings.set(n, () => ok(performance.now() - t0));
      this.ws.send(JSON.stringify({ t: 'ping', to: id, n }));
      setTimeout(() => { if (this.pings.delete(n)) fail(new Error('no answer')); }, 5000);
    });
  }

  leave() { try { this.ws.close(); } catch { /* closed */ } }
}

const APP_ID = 'gta2-browser-port-coop-1';

/**
 * The site's TURN relays (web/turn.php): ICE servers with short-lived logins, fetched for each room
 * joined (logins expire). None when the site has no turn-config.php, or no answer within 4 s.
 */
async function turnServers() {
  try {
    const res = await fetch('turn.php', { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    const data = res.ok ? await res.json() : null;
    const list = data && Array.isArray(data.iceServers) ? data.iceServers : [];
    return list.filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
  } catch {
    return [];
  }
}

/** Players anywhere, peer to peer over WebRTC (see the top of this file). */
export class WebRtcTransport {
  /**
   * The room code is also the password that encrypts the connection set-up. Players find each other
   * through the site's own board (board.php) where it runs PHP, otherwise public WebTorrent trackers.
   */
  static async create(room) {
    // (whole import('...') calls: the release build versions their addresses, see version_urls in scripts/build_pages.py)
    const board = await import('./board.js?v=1256913706');
    const onBoard = await board.boardAvailable();
    const { joinRoom, selfId } = onBoard ? board : await import('./vendor/trystero/torrent.mjs?v=1256913706');
    // relays for players who cannot connect directly (web/turn.php, where the site runs PHP)
    const turn = onBoard ? await turnServers() : [];
    return new WebRtcTransport(joinRoom, selfId, room, onBoard ? board.boardActivity : null, turn);
  }

  constructor(joinRoom, selfId, room, activity = null, turn = []) {
    this.activity = activity; // the board's (web/board.js), or null on public trackers
    this.turn = turn;
    this.id = selfId;
    this.peers = new Set();
    this.onMessage = () => {};
    this.onPeerJoined = () => {};
    this.onPeerLeft = () => {};
    this.joinRoom = joinRoom;
    this.roomCode = room;
  }

  join() {
    this.room = this.joinRoom({ appId: APP_ID, password: this.roomCode, ...(this.turn.length ? { turnConfig: this.turn } : {}) },
      `gta2-${this.roomCode}`);
    // lobby messages are JSON, game messages are bytes; both channels are reliable and ordered
    this.lobby = this.room.makeAction('lobby');
    this.game = this.room.makeAction('game');
    this.lobby.onMessage = (data, { peerId }) => this.onMessage(peerId, data);
    this.game.onMessage = (data, { peerId }) => this.onMessage(peerId, data instanceof Uint8Array ? data : new Uint8Array(data));
    this.room.onPeerJoin = (id) => { this.peers.add(id); this.onPeerJoined(id); };
    this.room.onPeerLeave = (id) => { this.peers.delete(id); this.onPeerLeft(id); };
  }

  send(to, data) {
    const action = data instanceof Uint8Array ? this.game : this.lobby;
    action.send(data, to ? { target: to } : {}).catch(() => { /* the peer has gone: onPeerLeft follows */ });
  }

  /** Round trip to a player in milliseconds. */
  ping(id) { return this.room.ping(id); }

  /** Whether another player in this room has been heard from lately (on the board), so a connection is being set up. */
  heardOthers() { return !!this.activity && Date.now() - this.activity.lastOther < 10000; }

  leave() { if (this.room) this.room.leave().catch(() => {}); }
}

// The meeting place of the public games list (not a room code: codes are upper case).
const DIRECTORY = 'public-rooms';
const ROOM_TTL_MS = 15000;

/**
 * Public games: a host who ticks Public announces the room (code, host name, map, mode, players) to
 * everyone on the lobby page, every few seconds and to each newcomer, so others can join without being
 * given the code. Rooms that stop being announced, or whose host leaves, drop off the list.
 *
 * Between computers this goes through the site's own board (board.php, BoardDirectory in board.js)
 * where the site runs PHP, otherwise public MQTT brokers (MqttDirectory below); this class is the
 * same list between tabs of one browser (?local), over LocalTransport.
 */
export class RoomDirectory {
  /** @param {boolean} local this browser's tabs only (?local), like LocalTransport */
  static async create(local) {
    if (local) return new RoomDirectory(new LocalTransport(DIRECTORY));
    const { BoardDirectory, boardAvailable } = await import('./board.js?v=1256913706');
    return await boardAvailable() ? new BoardDirectory(cleanRoom) : new MqttDirectory(BROKERS);
  }

  constructor(transport) {
    this.t = transport;
    this.rooms = new Map(); // code -> {code, host, map, mode, players, max, from, seen}
    this.mine = null;       // the room this page announces, or null
    this.sent = '';
    this.onChange = () => {};
    transport.onMessage = (from, data) => this.message(from, data);
    transport.onPeerJoined = (id) => { if (this.mine) this.t.send(id, { dir: 'room', room: this.mine }); };
    transport.onPeerLeft = (id) => {
      for (const [code, r] of this.rooms) if (r.from === id) this.rooms.delete(code);
      this.onChange();
    };
    transport.join();
    this.timer = setInterval(() => this.tick(), 5000);
  }

  /** Lists this page's room (or takes it off the list with null). Sends only when something changed. */
  announce(room) {
    const text = JSON.stringify(room);
    if (text === this.sent) return;
    if (!room && this.mine) this.t.send(null, { dir: 'gone', code: this.mine.code });
    this.mine = room;
    this.sent = text;
    if (room) this.t.send(null, { dir: 'room', room });
  }

  message(from, data) {
    if (!data || typeof data !== 'object') return;
    if (data.dir === 'room') {
      const r = cleanRoom(data.room);
      if (!r) return;
      // a code belongs to whoever announced it first
      const had = this.rooms.get(r.code);
      if (had && had.from !== from) return;
      this.rooms.set(r.code, { ...r, from, seen: Date.now() });
      this.onChange();
    } else if (data.dir === 'gone' && typeof data.code === 'string') {
      const had = this.rooms.get(data.code);
      if (had && had.from === from) { this.rooms.delete(data.code); this.onChange(); }
    }
  }

  tick() {
    if (this.mine) this.t.send(null, { dir: 'room', room: this.mine });
    const now = Date.now();
    let changed = false;
    for (const [code, r] of this.rooms) if (now - r.seen > ROOM_TTL_MS) { this.rooms.delete(code); changed = true; }
    if (changed) this.onChange();
  }

  /** The public rooms, in code order (stable while the list refreshes). */
  list() { return [...this.rooms.values()].sort((a, b) => a.code.localeCompare(b.code)); }

  leave() {
    clearInterval(this.timer);
    this.announce(null);
    setTimeout(() => this.t.leave(), 500); // let the "gone" message go out
  }
}

// Public MQTT brokers (WebSocket): the public games list is a message board there, so finding rooms
// needs no peer-to-peer connection. Two brokers, so the list keeps working when one is down.
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const ROOMS_TOPIC = 'gta2web/v1/rooms'; // one retained message per public room: <ROOMS_TOPIC>/<code>
const REPUBLISH_MS = 10000;
const RETAINED_MAX_AGE_MS = 60000; // a kept (retained) announcement older than this is a leftover

/**
 * The public games list over MQTT. Each public room is a retained message on <ROOMS_TOPIC>/<code>,
 * so the broker hands every room to a newcomer at once; the host republishes it every 10 s with the
 * time, and clears it (an empty message) when the room closes. If the host's tab just disappears,
 * the broker clears it for them (the connection's "last will").
 */
export class MqttDirectory {
  constructor(urls) {
    this.rooms = new Map(); // code -> room, with when it was last heard (seen)
    this.mine = null;
    this.sent = '';
    this.onChange = () => {};
    this.links = urls.map((url) => new MqttLink(url, {
      onOpen: (link) => {
        link.subscribe(`${ROOMS_TOPIC}/+`);
        this.publishTo(link);
      },
      onMessage: (topic, payload, retained) => this.message(topic, payload, retained),
    }));
    this.timer = setInterval(() => this.tick(), 5000);
    this.republish = 0;
    window.addEventListener('pagehide', () => this.leave());
  }

  topic(code) { return `${ROOMS_TOPIC}/${code}`; }

  publishTo(link) {
    if (this.mine) link.publish(this.topic(this.mine.code), new TextEncoder().encode(JSON.stringify({ ...this.mine, ts: Date.now() })), true);
  }

  /** Lists this page's room (or takes it off the list with null). */
  announce(room) {
    const text = JSON.stringify(room);
    if (text === this.sent) return;
    const was = this.mine;
    this.mine = room;
    this.sent = text;
    if (was && (!room || room.code !== was.code)) {
      for (const link of this.links) link.publish(this.topic(was.code), new Uint8Array(0), true);
    }
    // the last will clears the room if this tab goes away without saying so
    for (const link of this.links) link.setWill(room ? this.topic(room.code) : null);
    for (const link of this.links) this.publishTo(link);
    clearInterval(this.republish);
    if (room) this.republish = setInterval(() => this.links.forEach((link) => this.publishTo(link)), REPUBLISH_MS);
  }

  message(topic, payload, retained) {
    const code = topic.slice(ROOMS_TOPIC.length + 1);
    if (!payload.length) {
      if (this.rooms.delete(code)) this.onChange();
      return;
    }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    const r = cleanRoom(data);
    if (!r || r.code !== code) return;
    // a room kept by the broker from before: only if its host announced it lately
    if (retained && !(Math.abs(Date.now() - Number(data.ts)) < RETAINED_MAX_AGE_MS)) return;
    if (this.mine && this.mine.code === code) return; // our own room
    this.rooms.set(code, { ...r, seen: Date.now() });
    this.onChange();
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const [code, r] of this.rooms) if (now - r.seen > REPUBLISH_MS * 3) { this.rooms.delete(code); changed = true; }
    if (changed) this.onChange();
  }

  /** The public rooms, in code order (stable while the list refreshes). */
  list() { return [...this.rooms.values()].sort((a, b) => a.code.localeCompare(b.code)); }

  leave() {
    clearInterval(this.timer);
    this.announce(null);
    setTimeout(() => this.links.forEach((link) => link.close()), 500); // let the "gone" message go out
  }
}

/**
 * A small MQTT 3.1.1 client over WebSocket: connect (with an optional last will), subscribe and
 * publish at QoS 0, keep-alive pings, and reconnecting after a dropped connection.
 */
class MqttLink {
  constructor(url, { onOpen, onMessage }) {
    this.url = url;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.will = null; // topic of the empty retained message the broker publishes if we drop
    this.ready = false;
    this.closed = false;
    this.retryMs = 2000;
    this.buffer = new Uint8Array(0);
    this.nextId = 1;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.retry(); return; }
    this.ws = ws;
    this.buffer = new Uint8Array(0);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(this.connectPacket());
    ws.onmessage = (e) => { if (this.ws === ws) this.receive(new Uint8Array(e.data)); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      clearInterval(this.pinger);
      this.retry();
    };
    ws.onerror = () => {}; // onclose follows
  }

  retry() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  /** Sets the last will (a topic, or null); the will belongs to the connection, so this reconnects. */
  setWill(topic) {
    if ((this.will || null) === (topic || null)) return;
    this.will = topic || null;
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    this.ready = false;
    clearInterval(this.pinger);
    try { if (old.readyState === WebSocket.OPEN) old.send(new Uint8Array([0xe0, 0])); old.close(); } catch { /* closed */ } // DISCONNECT: no will
    this.connect();
  }

  connectPacket() {
    let flags = 0x02; // clean session
    const payload = mqttString(`gta2web-${randomId()}`);
    if (this.will) {
      flags |= 0x04 | 0x20; // a will, retained, at QoS 0
      payload.push(...mqttString(this.will), 0, 0); // with an empty message: clears the room
    }
    return mqttPacket(0x10, [...mqttString('MQTT'), 4, flags, 0, 30, ...payload]); // keep-alive 30 s
  }

  receive(bytes) {
    const all = new Uint8Array(this.buffer.length + bytes.length);
    all.set(this.buffer);
    all.set(bytes, this.buffer.length);
    let at = 0;
    for (;;) {
      // fixed header: the packet type, then the remaining length (1 to 4 bytes, 7 bits each)
      let len = 0;
      let i = at + 1;
      let complete = false;
      for (let mult = 1; i < all.length && i < at + 5; i++, mult *= 128) {
        len += (all[i] & 0x7f) * mult;
        if (!(all[i] & 0x80)) { complete = true; i++; break; }
      }
      if (!complete || all.length - i < len) break;
      this.packet(all[at], all.subarray(i, i + len));
      at = i + len;
    }
    this.buffer = all.slice(at);
  }

  packet(header, body) {
    const type = header >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) return; // refused
      this.ready = true;
      this.retryMs = 2000;
      clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send(new Uint8Array([0xc0, 0])), 20000); // PINGREQ
      this.onOpen(this);
    } else if (type === 3) { // PUBLISH
      const topicLen = (body[0] << 8) | body[1];
      const topic = new TextDecoder().decode(body.subarray(2, 2 + topicLen));
      const start = 2 + topicLen + ((header >> 1) & 3 ? 2 : 0); // QoS 1 or 2 carry a packet id
      this.onMessage(topic, body.slice(start), (header & 1) === 1);
    }
  }

  send(bytes) {
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  subscribe(filter) {
    const id = (this.nextId++ % 0xffff) + 1;
    this.send(mqttPacket(0x82, [id >> 8, id & 0xff, ...mqttString(filter), 0]));
  }

  publish(topic, payload, retain) {
    this.send(mqttPacket(retain ? 0x31 : 0x30, [...mqttString(topic), ...payload]));
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    try { this.ws.send(new Uint8Array([0xe0, 0])); this.ws.close(); } catch { /* closed */ }
  }
}

/** An MQTT string: its UTF-8 length (2 bytes), then the bytes. */
function mqttString(text) {
  const b = new TextEncoder().encode(text);
  return [b.length >> 8, b.length & 0xff, ...b];
}

/** An MQTT packet: the header byte, the body's length (variable length), the body. */
function mqttPacket(header, body) {
  const len = [];
  let n = body.length;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    len.push(byte);
  } while (n);
  return new Uint8Array([header, ...len, ...body]);
}

/** A room announced by another player, checked field by field (it is shown on everyone's page). */
function cleanRoom(r) {
  if (!r || typeof r !== 'object' || typeof r.code !== 'string' || !/^[A-Z0-9]{1,8}$/.test(r.code)) return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const players = int(r.players, 1, GHOST_MAX_PLAYERS);
  const max = int(r.max, 1, GHOST_MAX_PLAYERS);
  if (players === null || max === null || typeof r.map !== 'string' || !(r.mode in MODES)) return null;
  return {
    live: r.live === true, // a ghost race under way (it can be joined)
    code: r.code, host: String(r.host || 'Player').replace(/[^ -~]/g, '?').slice(0, 16),
    map: r.map.slice(0, 32), mode: r.mode, players, max,
  };
}

// Ticks run 30 times a second. A player's inputs are used `delay` ticks after
// they are sent, so a delay that covers the slowest one-way trip keeps the
// game from waiting on the network (at the cost of that much input lag).
const TICK_MS = 1000 / 30;
export const inputDelayFor = (rttMs) => Math.min(8, Math.max(1, Math.ceil((rttMs / 2 + 10) / TICK_MS)));
// Host-paced (net_web.cpp): a player's inputs go to the host and its bundle comes back, a round trip.
export const hostPacedDelayFor = (rttMs) => Math.min(8, Math.max(1, Math.ceil((rttMs + 10) / TICK_MS)));

/**
 * The lobby: who is in the room, who hosts, and the start of a match. The
 * host is whoever created the room; slots follow join order (host = 0).
 */
export class CoopLobby {
  constructor(transport, { name, host, onChange, onStart }) {
    this.t = transport;
    this.name = name;
    this.host = host;
    this.hostId = host ? transport.id : null;
    this.players = host ? [{ id: transport.id, name }] : [];
    this.onChange = onChange;
    this.onStart = onStart;
    this.started = false;
    this.slots = null;   // id -> slot once the match starts
    this.onGameMessage = () => {};
    this.onPlayerLeft = () => {};
    this.onWaypoint = () => {}; // (slot, {x, y} | null)
    this.onSync = () => {};     // (slot, tick, checksum)
    this.onChat = () => {};     // (slot, text)
    this.onGhost = () => {};    // (slot, [x, y, z, rotation, sprite type, number, palette, remap] | null)
    this.stats = { sent: 0, received: 0, early: 0 }; // game messages
    this.early = [];
    this.earlyBundles = [];
    // the match clock (pacing 'clock', web/clock.js): the host's page runs it; bundles go to the
    // core in tick order (onBundle)
    this.clock = null;
    this.clockId = null;
    this.nextTick = 0;
    this.onBundle = () => {};
    this.onLag = () => {};       // (late: made-up inputs per slot in the last 2 s)
    this.onClockLost = () => {}; // the host left: the match is over
    this.trace = [];
    this.settings = {
      mode: 'ffa', district: 'rocket', pacing: 'lockstep', lighting: 'noon', public: false, police: false, friendlyFire: false, minutes: 0, killLimit: 10, pointsTarget: 0, sides: {},
    };
    this.loaded = new Set(); // host: players whose game files are ready
    this.gone = new Set();   // players who left after the start
    this.go = () => {};      // game messages that arrived before this player's game was ready
    transport.onPeerJoined = (id) => { if (!this.host) this.t.send(id, { lobby: 'hello', name: this.name }); };
    transport.onPeerLeft = (id) => this.left(id);
    transport.onMessage = (from, data) => this.message(from, data);
    transport.join();
  }

  message(from, data) {
    if ((data instanceof Uint8Array || data instanceof ArrayBuffer) && this.clockMode) {
      if (this.gone.has(from)) return;
      const bytes = new Uint8Array(data);
      if (from === this.clockId && bytes[0] === BUNDLE) this.bundle(bytes);
      else if (this.clock && this.slots && from in this.slots) this.clock.input(this.slots[from], bytes);
      return;
    }
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      if (!this.slots || !(from in this.slots)) return;
      const bytes = new Uint8Array(data);
      this.log('in', this.slots[from], bytes);
      // another player's game can start sending before ours has loaded: keep those for later
      if (!this.ready) { this.stats.early++; this.early.push([this.slots[from], bytes]); return; }
      this.stats.received++;
      this.onGameMessage(this.slots[from], bytes);
      return;
    }
    if (!data || !data.lobby) return;
    if (data.lobby === 'hello' && this.host && !this.started) {
      if (!this.players.some((p) => p.id === from) && this.players.length < roomSize(this.settings)) {
        this.players.push({ id: from, name: String(data.name || 'Player').slice(0, 16), crew: '' });
      }
      this.broadcastRoster();
    } else if (data.lobby === 'hello' && this.host && this.started) {
      this.lateHello(from, data);
    } else if (data.lobby === 'joined' && !this.host && this.started && from === this.hostId && Array.isArray(data.players)) {
      // someone joined the ghost race: everyone in it learns their slot (and name)
      this.players = data.players;
      this.slots = Object.fromEntries(this.players.map((p, i) => [p.id, i]));
      this.onChange();
    } else if (data.lobby === 'busy' && !this.host && !this.started) {
      this.refused = true; // the host's game started without us
      this.onChange();
    } else if (data.lobby === 'crew' && this.host && !this.started) {
      const p = this.players.find((pl) => pl.id === from);
      if (p) { p.crew = cleanCrew(data.crew); this.broadcastRoster(); }
    } else if (data.lobby === 'side' && this.host && !this.started && typeof data.side === 'string') {
      this.applySide(from, data.side);
    } else if (data.lobby === 'roster' && !this.host) {
      this.hostId = from;
      this.players = data.players;
      if (data.settings) this.settings = data.settings;
      this.onChange();
    } else if (data.lobby === 'start' && !this.host && from === this.hostId) {
      this.begin(data.match);
    } else if (data.lobby === 'loaded' && this.host) {
      this.loaded.add(from);
      this.checkLoaded();
    } else if (data.lobby === 'go' && !this.host && from === this.hostId) {
      this.go();
    } else if (data.lobby === 'ghost' && this.slots && from in this.slots) {
      this.onGhost(this.slots[from], data.g === null ? null : data.g);
    } else if (data.lobby === 'chat' && this.slots && from in this.slots && typeof data.text === 'string') {
      this.onChat(this.slots[from], data.text.slice(0, 160));
    } else if (data.lobby === 'sync' && this.slots && from in this.slots && Number.isInteger(data.tick)) {
      this.onSync(this.slots[from], data.tick, String(data.h));
    } else if (data.lobby === 'lag' && from === this.clockId && Array.isArray(data.late)) {
      this.onLag(data.late.map(Number));
    } else if (data.lobby === 'leave' && this.clock && this.slots && from in this.slots) {
      this.clock.leave(this.slots[from]);
    } else if (data.lobby === 'wp' && this.slots && from in this.slots) {
      const wp = data.wp && Number.isFinite(data.wp.x) && Number.isFinite(data.wp.y) ? { x: data.wp.x, y: data.wp.y } : null;
      this.onWaypoint(this.slots[from], wp);
    }
  }

  broadcastRoster() {
    for (const p of this.players) {
      if (p.id !== this.t.id) this.t.send(p.id, { lobby: 'roster', players: this.players, settings: this.settings });
    }
    this.onChange();
  }

  /** This player's Gang Wars crew (a name; players with the same name are one crew). */
  setCrew(name) {
    const crew = cleanCrew(name);
    if (this.host) {
      const me = this.players.find((p) => p.id === this.t.id);
      if (me) me.crew = crew;
      this.broadcastRoster();
    } else if (this.hostId) {
      this.t.send(this.hostId, { lobby: 'crew', crew });
    }
  }

  /** Host: change the match settings (mode, district, limits, crew sides); everyone sees them. */
  setSettings(changes) {
    if (!this.host) return;
    this.settings = { ...this.settings, ...changes };
    this.broadcastRoster();
  }

  /** The crews in the room (Gang Wars): name, members and side (the host's choice, or the next free gang). */
  /**
   * The crews in the room (Gang Wars): name, members and the gang the crew picked (null until it
   * picks one; never assigned for it). Two crews cannot hold the same gang: the first keeps it.
   */
  crews() {
    const gangs = GANGS[this.settings.district] || GANGS.downtown;
    const names = [...new Set(this.players.map((p) => p.crew).filter(Boolean))];
    const taken = new Set();
    return names.map((name) => {
      let side = this.settings.sides[name] || null;
      if (side && (!gangs.some(([code]) => code === side) || taken.has(side))) side = null;
      if (side) taken.add(side);
      const gang = side ? gangs.find(([code]) => code === side) : null;
      return {
        name, side, gang: gang ? gang[1] : null, colour: gang ? gang[2] : '#8a8a8a',
        members: this.players.filter((p) => p.crew === name).map((p) => p.id),
      };
    });
  }

  /** The gang this player's crew sides with (any member can choose; the host relays it). */
  pickSide(side) {
    const me = this.players.find((p) => p.id === this.t.id);
    if (!me || !me.crew) return;
    if (this.host) this.applySide(this.t.id, side);
    else if (this.hostId) this.t.send(this.hostId, { lobby: 'side', side });
  }

  /** Host: a crew member's choice of gang, if the gang is in this district and no other crew has it. */
  applySide(from, side) {
    const p = this.players.find((pl) => pl.id === from);
    if (!p || !p.crew) return;
    const gangs = GANGS[this.settings.district] || GANGS.downtown;
    const valid = side === '' || gangs.some(([code]) => code === side);
    const heldByOther = this.crews().some((c) => c.name !== p.crew && c.side === side);
    if (!valid || (side && heldByOther)) return;
    this.setSettings({ sides: { ...this.settings.sides, [p.crew]: side || undefined } });
  }

  /** Host: why the match cannot start yet, or ''. */
  startProblem() {
    const d = DISTRICTS[this.settings.district];
    if (!d) return 'The community maps have not loaded yet.';
    if (d.incompatible) return `${d.label} does not work here (${d.incompatible}): pick another map.`;
    const ghost = isGhostRace(this.settings.pacing);
    if (this.players.length > roomSize(this.settings)) return `Lockstep and host-paced games have room for ${MAX_PLAYERS} players.`;
    if (ghost && this.settings.mode === 'wars') return 'Gang Wars is not for Ghost or Contact sync: pick another game type.';
    if (ghost && this.settings.mode === 'tag') return 'Tag needs everyone in one game, not Ghost or Contact sync: pick another game type.';
    // in a ghost race everyone plays the map alone, so its own player limit does not apply
    if (!ghost && d.maxPlayers && this.players.length > d.maxPlayers) return `${d.label} has room for ${d.maxPlayers} players.`;
    if (this.settings.mode !== 'wars') return '';
    const crews = this.crews();
    if (this.players.some((p) => !p.crew)) return 'Everyone needs a crew for Gang Wars.';
    if (crews.length < 2) return 'Gang Wars needs at least two crews.';
    if (crews.length > 3) return 'Gang Wars has room for three crews (one per street gang).';
    const unpicked = crews.filter((c) => !c.side).map((c) => c.name);
    if (unpicked.length) return `Waiting for ${unpicked.join(' and ')} to pick a gang.`;
    return '';
  }

  left(id) {
    if (this.slots && id in this.slots && this.clockMode) {
      // the clock drops a player at the same tick in every game; the host's leaving ends it
      this.gone.add(id);
      if (this.clock) this.clock.leave(this.slots[id]);
      if (id === this.hostId) this.clockGone();
      this.checkLoaded();
      return;
    }
    if (this.slots && id in this.slots) {
      this.onPlayerLeft(this.slots[id]);
      this.gone.add(id);
      this.checkLoaded();
      return;
    }
    this.players = this.players.filter((p) => p.id !== id);
    if (!this.host && id === this.hostId) this.hostGone = true; // the host cancelled or closed the page
    if (this.host) this.broadcastRoster(); else this.onChange();
  }

  /** Host: measures the round trip to every player (shown in the lobby, and sets the input delay). */
  async measurePings() {
    if (!this.host || !this.t.ping) return;
    await Promise.all(this.players.filter((p) => p.id !== this.t.id).map(async (p) => {
      try { p.ping = Math.round(await this.t.ping(p.id)); } catch { /* not connected yet */ }
    }));
    if (!this.started) this.broadcastRoster();
  }

  /** Host: start the match for everyone in the room. */
  start() {
    if (!this.host || this.startProblem()) return;
    const slowest = Math.max(0, ...this.players.map((p) => p.ping || 0));
    const s = this.settings;
    const match = {
      ...s, id: `${randomId()}${Date.now().toString(36)}`, players: this.players, delay: (s.pacing === 'host' ? hostPacedDelayFor : inputDelayFor)(slowest),
      // ?predict=0 on the host's page: the clock without prediction (web/rollback.js)
      clock: s.pacing === 'clock', predict: s.pacing === 'clock' && new URLSearchParams(location.search).get('predict') !== '0',
      crews: s.mode === 'wars' ? this.crews() : [],
    };
    for (const p of this.players) if (p.id !== this.t.id) this.t.send(p.id, { lobby: 'start', match });
    this.begin(match);
  }

  /**
   * Host, a match under way: someone says hello. A ghost race takes them in (everyone plays their
   * own game, so a newcomer just starts theirs; the loaded/go handshake lets them in as usual);
   * other games started without them, and they are told so.
   */
  lateHello(from, data) {
    if (this.players.some((p) => p.id === from)) return;
    // (players who have left do not count: a running game is not filled up by people who came and went)
    const here = this.players.filter((p) => !this.gone.has(p.id)).length;
    if (!this.match || !isGhostRace(this.match.pacing) || here >= roomSize(this.match)) {
      this.t.send(from, { lobby: 'busy' });
      return;
    }
    // the slot of someone who left, if any (a ghost race draws 16 others at most)
    const newcomer = { id: from, name: String(data.name || 'Player').slice(0, 16), crew: '' };
    const free = this.players.findIndex((p) => this.gone.has(p.id));
    if (free >= 0) {
      delete this.slots[this.players[free].id];
      this.players[free] = newcomer;
    } else {
      this.players.push(newcomer);
    }
    this.slots[from] = free >= 0 ? free : this.players.length - 1;
    for (const p of this.players) {
      if (p.id !== this.t.id && p.id !== from && !this.gone.has(p.id)) this.t.send(p.id, { lobby: 'joined', players: this.players });
    }
    this.t.send(from, { lobby: 'roster', players: this.players, settings: this.settings });
    this.t.send(from, { lobby: 'start', match: { ...this.match, players: this.players } });
    this.onChange();
  }

  begin(match) {
    this.started = true;
    this.match = match;
    this.players = match.players;
    this.slots = Object.fromEntries(match.players.map((p, i) => [p.id, i]));
    this.mySlot = this.slots[this.t.id];
    this.clockMode = !!match.clock;
    if (this.clockMode) this.clockId = this.host ? this.t.id : this.hostId;
    this.onStart({ ...match, mySlot: this.mySlot, delay: match.delay || 1 });
  }

  /**
   * Resolves when every player's game files are loaded, so that all enter the
   * match together (the game gives up on a player who is not there within
   * about 25 seconds, and loading speeds differ a lot).
   */
  allLoaded() {
    return new Promise((resolve) => {
      this.go = () => { this.go = () => {}; resolve(); };
      if (this.host) { this.loaded.add(this.t.id); this.checkLoaded(); } else this.t.send(this.hostId, { lobby: 'loaded' });
    });
  }

  checkLoaded() {
    if (!this.host || !this.slots || !this.loaded.has(this.t.id)) return;
    if (!this.players.every((p) => this.loaded.has(p.id) || this.gone.has(p.id))) return;
    if (this.goSent) return; // once: a second clock would start the match's ticks over
    this.goSent = true;
    if (this.clockMode) this.startClock();
    for (const p of this.players) if (p.id !== this.t.id && !this.gone.has(p.id)) this.t.send(p.id, { lobby: 'go' });
    this.go();
  }

  /**
   * Host: the match clock starts as everyone enters the match, on a worker's timer (a hidden tab's
   * own timers slow down). Every 2 s it tells everyone whose inputs it had to make up (lag).
   */
  startClock() {
    const ids = this.players.map((p) => p.id);
    this.clock = new MatchClock({
      players: ids.length,
      send: (bytes) => {
        for (const id of ids) if (id !== this.t.id && !this.gone.has(id)) this.t.send(id, bytes);
        this.bundle(bytes);
      },
    });
    for (const id of ids) if (this.gone.has(id)) this.clock.leave(this.slots[id]);
    const timer = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),4);'], { type: 'text/javascript' })));
    let late = this.clock.stats().map((s) => s.late);
    let lagAt = performance.now();
    timer.onmessage = () => {
      this.clock.poll();
      if (performance.now() - lagAt >= 2000) {
        lagAt = performance.now();
        const now = this.clock.stats().map((s) => s.late);
        const msg = { lobby: 'lag', late: now.map((n, i) => n - late[i]) };
        late = now;
        for (const id of ids) if (id !== this.t.id && !this.gone.has(id)) this.t.send(id, msg);
        this.onLag(msg.late);
      }
      if (this.clock.done) timer.terminate();
    };
  }

  /** A bundle from the clock: to the core, in tick order (the transports keep the order). */
  bundle(bytes) {
    const tick = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
    if (tick !== this.nextTick) return;
    this.nextTick++;
    this.stats.received++;
    if (!this.ready) { this.earlyBundles.push(bytes); return; }
    this.onBundle(bytes);
  }

  /** The clock is gone for good (said once). */
  clockGone() {
    if (this.clockLost) return;
    this.clockLost = true;
    this.onClockLost();
  }

  /** This player leaves the match (the game is over for them): the clock drops them now. */
  leaveMatch() {
    if (!this.started || !this.clockMode) return;
    if (this.host) { if (this.clock) this.clock.leave(this.mySlot); } else this.t.send(this.hostId, { lobby: 'leave' });
  }

  /** The last game messages in and out, for diagnosing (window.gta2.coop.lobby.trace). */
  log(dir, slot, bytes) {
    this.trace.push(`${dir} ${slot} ${bytes[0]}:${bytes[1]}${bytes[0] === 3 ? ` ${bytes[2]}` : ''} @${Math.round(performance.now())}`);
    if (this.trace.length > 80) this.trace.shift();
  }

  /** This player's game is ready for game messages: delivers the ones that came early. */
  gameReady() {
    this.ready = true;
    for (const [slot, bytes] of this.early.splice(0)) { this.stats.received++; this.onGameMessage(slot, bytes); }
    for (const bytes of this.earlyBundles.splice(0)) this.onBundle(bytes);
  }

  /** Ghost races: where this player is now, for everyone else's ghosts (or null: not on the map). */
  shareGhost(g) {
    if (!this.slots) return;
    for (const id of Object.keys(this.slots)) if (id !== this.t.id && !this.gone.has(id)) this.t.send(id, { lobby: 'ghost', g });
  }

  /** A chat message to everyone else in the match. */
  sendChat(text) {
    if (!this.slots) return;
    for (const id of Object.keys(this.slots)) if (id !== this.t.id) this.t.send(id, { lobby: 'chat', text });
  }

  /** A checksum of this player's game at a tick, for the others to compare. */
  shareSync(tick, h) {
    if (!this.slots) return;
    for (const id of Object.keys(this.slots)) if (id !== this.t.id) this.t.send(id, { lobby: 'sync', tick, h });
  }

  /** This player's waypoint, for the others' maps (null clears it). */
  shareWaypoint(wp) {
    if (!this.slots) return;
    const msg = { lobby: 'wp', wp: wp ? { x: wp.x, y: wp.y } : null };
    for (const id of Object.keys(this.slots)) if (id !== this.t.id) this.t.send(id, msg);
  }

  /** Game messages from the core: to one slot, or -1 for everyone. */
  sendGame(slot, bytes) {
    this.log('out', slot, bytes);
    if (this.clockMode) {
      // the clock takes inputs only; this game's own come back in its bundles
      if (this.clock) this.clock.input(this.mySlot, bytes);
      else this.t.send(this.clockId, bytes);
      this.stats.sent++;
      return;
    }
    for (const [id, s] of Object.entries(this.slots)) {
      if (s === this.mySlot || (slot >= 0 && s !== slot)) continue;
      this.t.send(id, bytes);
      this.stats.sent++;
    }
  }
}
