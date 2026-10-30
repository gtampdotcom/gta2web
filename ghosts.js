// Ghost races (the host's choice of network mode): every player drives their own one-player game
// of the map, and sees the other players' cars and characters as see-through ghosts where their
// own games put them. Nothing waits for anyone and nothing can drift apart: each world is separate,
// and the ghosts are pictures the game draws (gta2_port_ghost_set, sprite.cpp), which nothing in
// it collides with. Players can join a race already under way (web/net.js).
//
// Each player sends their state once per game tick (30 a second) over the room's lobby channel:
// {lobby: 'ghost', g: [on the map, x, y, z, rotation, sprite type, sprite number, palette, remap,
// in a car, kills, deaths, points, horn held, car model, burps so far, the last one's sample,
// game tick, x and y speed per tick, turn per tick (x16)]} (Fix16 and Ang16 values as the game
// keeps them). The tick says exactly when the state was true, and the speeds come from the
// sender's own positions tick by tick, so they are exact too.
//
// A ghost is drawn where it probably is now (dead reckoning): its last state moved on by its speed
// for the ticks since then, mapped to this page's clock (the earliest arrival of recent updates,
// so a late message does not make its player look slow). When a new update disagrees with what
// was drawn, the difference fades out over BLEND_MS instead of jumping; a big one (a crash, a
// respawn) snaps. The same states give the map, radar, names and scoreboard their other players
// (shell.js coopView).
//
// Horns and burps: the page plays them itself (Web Audio), from the level's own sound bank
// (data/audio/<style>.raw and .sdt), with the samples and pitches the game uses (sound_obj.cpp:
// a car's horn is a sample by its class at a pitch by its model; special 1 on foot is a burp or a
// fart, sample 309 or 310 at random), and quieter and panned by where the ghost is from this
// player. Which of the two this player's own game played is read from the samples it starts, so
// everyone hears the same one.
//
// Contact races (the host's "solid" mode): the same, but the other players are real cars and
// characters in this game (gta2_port_puppet_set, port/platform/puppet_web.cpp), put where they are
// after every game tick, so you can bump into them. Their cars are steered there under their own
// physics, so bumps push both ways; nothing can hurt them, and they cannot hurt you.

export const GHOST_MAX_PLAYERS = 16; // one ghost per other player (sprite.cpp keeps 16)
const FIELDS = 21;
const VOICES = [309, 310]; // special 1 on foot: a burp or a fart (sound_obj.cpp, voice event 20)
const TICK_MS = 1000 / 30; // the game's tick
const CHECK_MS = 8; // how often the game's tick is checked, to send once per tick
const MAX_AHEAD = 6; // ticks a ghost is moved on past its last update at most (200 ms)
const BLEND_MS = 100; // a correction fades out over this long
const SNAP_BLOCKS = 2; // a correction bigger than this jumps
const CLOCK_WINDOW = 90; // updates (3 s) over which a player's clock is matched to ours
const STALE_MS = 3000; // no update for this long: the player is gone from view
const ALPHA = 150; // 0..255: see-through
const TURN = 1440; // Ang16: a full turn
const FX = 16384; // Fix16: one block
const HORN_BLOCKS = 7.5; // heard this far away (sound_obj.cpp: CalculateDistance)
const BURP_BLOCKS = 9;
const HORN_VOLUME = 20 / 127; // the game's emitting volumes
const BURP_VOLUME = 25 / 127;

// The horn by car model (sound_obj.cpp: HandleCarAlarmSound_415570, which is the player's horn,
// GetVehicleAudioClass_417BA0 and ConvertToPlayBackRate_417C60). Models by number (enums.hpp).
const HORN_SAMPLE = new Map([
  ...[8, 13, 16, 29, 36, 40].map((m) => [m, 17]), // small cars
  ...[1, 2, 5, 19, 22, 30, 31, 38, 44, 46, 49, 53, 57, 71, 83].map((m) => [m, 18]), // sports cars, 4x4s
  ...[3, 7, 11, 17, 21, 54, 63, 64, 86].map((m) => [m, 19]), // trucks and buses
  [60, 20], // train cab
  [27, 23], // ice-cream van: its jingle
]); // any other model: 16
const HORN_RATE = new Map([
  ...[13, 36].map((m) => [m, 22000]), ...[2, 8, 19, 40, 53, 71].map((m) => [m, 18000]),
  ...[10, 16, 23, 24, 25, 26, 28, 29, 37, 42, 62, 67, 85].map((m) => [m, 24000]),
  ...[1, 22, 30, 46, 49, 83].map((m) => [m, 16000]), ...[5, 31, 38, 57].map((m) => [m, 14000]),
  ...[3, 11, 54].map((m) => [m, 11000]), ...[17, 21, 63].map((m) => [m, 10300]), ...[7, 64, 86].map((m) => [m, 11700]),
  [60, 15000], [27, 11025], ...[4, 32, 35, 41, 44, 50, 56, 70, 82].map((m) => [m, 19000]),
]); // any other model: 22050
// Special 1 is not a horn in these: a weapon (fire truck, tank, gun jeep) or the siren (police,
// ambulance, SWAT van, FBI car; the siren is not sent to the ghosts)
const NO_HORN = new Set([17, 54, 22, 12, 34, 52, 84]);

/** The shortest turn from angle a to b (Ang16). */
const turnBetween = (a, b) => ((b - a) % TURN + TURN + TURN / 2) % TURN - TURN / 2;
const wrap = (r) => ((Math.round(r) % TURN) + TURN) % TURN;

export class GhostRace {
  /**
   * @param {object} o
   * @param {object} o.Module the game
   * @param {object} o.lobby the room (CoopLobby), already in its match
   * @param {object} [o.audio] the game's Web Audio output (audio.js), for horns and burps
   * @param {string} [o.bank] the level's sound bank without extension (.raw and .sdt)
   * @param {boolean} [o.solid] the others as real cars and characters, not see-through pictures
   */
  constructor({ Module, lobby, audio = null, bank = '', solid = false }) {
    this.M = Module;
    this.lobby = lobby;
    this.audio = audio;
    this.bank = bank;
    this.sounds = null; // {raw, sdt, buffers} once loaded
    this.horns = new Map(); // slot -> {source, gain, panner}
    this.burps = 0; // this player's burps and farts so far
    this.lastVoice = 0; // the last one's sample
    this.horn = 0;
    this.model = -1;
    this.self = Module.cwrap('gta2_port_ghost_self', 'number', []);
    this.stats = Module.cwrap('gta2_port_coop_players', 'number', []);
    this.netDebug = Module.cwrap('gta2_port_net_debug', 'number', []);
    this.set = Module.cwrap('gta2_port_ghost_set', null, Array(11).fill('number'));
    this.puppet = solid && Module._gta2_port_puppet_set ? Module.cwrap('gta2_port_puppet_set', null, Array(13).fill('number')) : null;
    if (this.puppet) Module.ccall('gta2_port_puppet_reset', null, [], []);
    this.states = new Map(); // slot -> the other player's latest state and how to draw it (receive)
    this.history = []; // this player's last few ticks: {tick, x, y, rot}, for their speed
    this.sentTick = -1;
    lobby.onGhost = (slot, g) => this.receive(slot, g);
    // this player's burps and farts: the game's own samples as it starts them (in a ghost race
    // nobody else in this game makes that sound)
    if (audio) {
      const start = audio.sampleStart.bind(audio);
      audio.sampleStart = (id, ptr, len, ...rest) => {
        const voice = this.voiceOf(ptr, len);
        if (voice) { this.burps++; this.lastVoice = voice; }
        return start(id, ptr, len, ...rest);
      };
    }
    this.sender = setInterval(() => this.send(), CHECK_MS);
    const frame = () => { this.draw(); this.raf = requestAnimationFrame(frame); };
    this.raf = requestAnimationFrame(frame);
  }

  /** The game's tick counter (gNetworkFrameCounter: one a tick in a network game). */
  tick() {
    const p = this.netDebug() >> 2;
    return this.M.HEAP32[p + 4];
  }

  /** Once per game tick: this player's state, with its tick and speed, to everyone. */
  send() {
    this.watchSpecial(); // also here: a tab in the background gets no animation frames
    if (this.puppet) this.placePuppets(performance.now()); // (and stand-ins are part of the game, not only drawn)
    const tick = this.tick();
    if (tick === this.sentTick) return;
    this.sentTick = tick;
    const p = this.self() >> 2;
    const v = this.M.HEAP32.subarray(p, p + 9);
    const s = this.stats() >> 2; // this game's only player, slot 0: in a car, kills, deaths, points
    const st = this.M.HEAP32.subarray(s, s + 12);
    // speed from this player's own positions a few ticks apart (exact: the positions are per tick)
    let vx = 0;
    let vy = 0;
    let vr = 0;
    if (v[0]) {
      this.history.push({ tick, x: v[1], y: v[2], rot: v[4] });
      while (this.history.length > 4) this.history.shift();
      const old = this.history[0];
      const dt = tick - old.tick;
      const jump = Math.abs(v[1] - old.x) > 4 * FX || Math.abs(v[2] - old.y) > 4 * FX; // a respawn or teleport
      if (dt > 0 && dt <= 8 && !jump) {
        vx = Math.round((v[1] - old.x) / dt);
        vy = Math.round((v[2] - old.y) / dt);
        vr = Math.round((turnBetween(old.rot, v[4]) / dt) * 16);
      }
    } else {
      this.history = [];
    }
    this.lobby.shareGhost([v[0] ? 1 : 0, ...v.subarray(1, 9), st[5] ? 1 : 0, st[7], st[8], st[11], this.horn, this.model,
      this.burps, this.lastVoice, tick, vx, vy, vr]);
  }

  /** This player's horn (special 1 held in a car). */
  watchSpecial() {
    const p = this.self() >> 2;
    const v = this.M.HEAP32.subarray(p, p + 11);
    this.model = v[0] ? v[10] : -1;
    this.horn = v[0] && v[9] && this.model >= 0 ? 1 : 0;
  }

  /** Whether a sample the game starts is a burp or a fart (309 or 310), by its bytes: its number, or 0. */
  voiceOf(ptr, len) {
    const bank = this.loadSounds();
    if (!bank) return 0;
    for (const idx of VOICES) {
      if (idx >= bank.count || bank.sdt.getInt32(idx * 24 + 4, true) !== len) continue;
      const offset = bank.sdt.getInt32(idx * 24, true);
      const heap = this.M.HEAPU8;
      let same = offset >= 0 && offset + len <= bank.raw.length;
      for (let i = 0; same && i < Math.min(64, len); i++) same = heap[ptr + i] === bank.raw[offset + i];
      if (same) return idx;
    }
    return 0;
  }

  receive(slot, g) {
    if (!Array.isArray(g) || g.length !== FIELDS || !g.every(Number.isInteger)) return;
    const now = performance.now();
    let st = this.states.get(slot);
    // an older tick than we have: a message overtaken by a newer one (keep the newer)
    if (st && st.g && g[17] <= st.g[17] && g[17] > st.g[17] - 300) return;
    // a new player, or their game restarted (the tick count starts again)
    if (!st || (st.g && g[17] < st.g[17])) st = { g: null, arrivals: [], err: null };
    if (st.g && g[15] > st.g[15] && g[0]) this.burp(g); // a burp or fart since the last update
    // where this ghost was drawn just now, to fade from (not for a different car or character)
    const before = st.g && st.g[0] && g[0] && st.g[5] === g[5] ? this.predict(st, now) : null;
    st.g = g;
    st.t = now;
    // their tick clock on ours: the earliest arrival of recent updates (the least delayed)
    st.arrivals.push(now - g[17] * TICK_MS);
    while (st.arrivals.length > CLOCK_WINDOW) st.arrivals.shift();
    st.offset = Math.min(...st.arrivals);
    st.err = null;
    if (before) {
      const after = this.predict(st, now);
      const dx = before[1] - after[1];
      const dy = before[2] - after[2];
      if (Math.hypot(dx, dy) < SNAP_BLOCKS * FX) st.err = { dx, dy, dr: turnBetween(after[4], before[4]), t: now };
    }
    this.states.set(slot, st);
  }

  /** A player's state moved on to now by its speed, plus what is left of the last correction. */
  predict(st, now) {
    const g = st.g.slice();
    const ahead = Math.max(0, Math.min(MAX_AHEAD, (now - st.offset) / TICK_MS - g[17]));
    g[1] = Math.round(g[1] + g[18] * ahead);
    g[2] = Math.round(g[2] + g[19] * ahead);
    let rot = g[4] + (g[20] / 16) * ahead;
    if (st.err) {
      const left = 1 - (now - st.err.t) / BLEND_MS;
      if (left > 0) {
        g[1] = Math.round(g[1] + st.err.dx * left);
        g[2] = Math.round(g[2] + st.err.dy * left);
        rot += st.err.dr * left;
      } else {
        st.err = null;
      }
    }
    g[4] = wrap(rot);
    return g;
  }

  /** A player left: their ghost goes. */
  remove(slot) {
    this.states.delete(slot);
    this.stopHorn(slot);
  }

  // ------------------------------------------------------------- sounds
  /** The level's sound bank: 16-bit mono samples (.raw) and their table (.sdt, 24 bytes each). */
  loadSounds() {
    if (this.sounds !== null) return this.sounds;
    this.sounds = false;
    try {
      const raw = this.M.FS.readFile(`${this.bank}.raw`);
      const sdt = new DataView(this.M.FS.readFile(`${this.bank}.sdt`).buffer);
      this.sounds = { raw, sdt, count: Math.floor(sdt.byteLength / 24), buffers: new Map() };
    } catch { /* no sound bank: ghosts stay silent */ }
    return this.sounds;
  }

  /** A sample of the bank as a Web Audio buffer, and its own rate. */
  sample(idx) {
    const bank = this.loadSounds();
    const ctx = this.audio && this.audio.ctx;
    if (!bank || !ctx || idx < 0 || idx >= bank.count) return null;
    const offset = bank.sdt.getInt32(idx * 24, true);
    const length = bank.sdt.getInt32(idx * 24 + 4, true);
    const rate = bank.sdt.getInt32(idx * 24 + 8, true) || 22050;
    const loopStart = Math.max(0, bank.sdt.getInt32(idx * 24 + 16, true)); // bytes: where a held sound repeats from
    let buffer = bank.buffers.get(idx);
    if (!buffer) {
      if (offset < 0 || length < 2 || offset + length > bank.raw.length) return null;
      const frames = length >> 1;
      buffer = ctx.createBuffer(1, frames, rate);
      const data = buffer.getChannelData(0);
      const dv = new DataView(bank.raw.buffer, bank.raw.byteOffset + offset, frames * 2);
      for (let i = 0; i < frames; i++) data[i] = dv.getInt16(i * 2, true) / 32768;
      bank.buffers.set(idx, buffer);
    }
    return { buffer, rate, loopStart };
  }

  /** How loud and where a sound at a ghost's position is, from this player: {gain, pan} or null. */
  placement(g, range) {
    const s = this.stats() >> 2;
    const v = this.M.HEAP32.subarray(s, s + 4);
    if (!v[1]) return null;
    const dx = (g[1] - v[2]) / FX;
    const dy = (g[2] - v[3]) / FX;
    const d = Math.hypot(dx, dy);
    if (d >= range) return null;
    return { gain: 1 - d / range, pan: Math.max(-1, Math.min(1, dx / range)) * 0.8 };
  }

  play(idx, rate, loop, volume, place) {
    const s = this.sample(idx);
    if (!s) return null;
    const ctx = this.audio.ctx;
    const source = ctx.createBufferSource();
    source.buffer = s.buffer;
    source.loop = loop;
    if (loop && s.loopStart > 0 && s.loopStart / 2 < s.buffer.length) {
      source.loopStart = s.loopStart / 2 / s.rate; // the start plays once, the rest repeats
      source.loopEnd = s.buffer.duration;
    }
    source.playbackRate.value = Math.max(0.05, rate / s.rate);
    const gain = ctx.createGain();
    gain.gain.value = volume * place.gain;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = place.pan;
      source.connect(gain).connect(panner).connect(this.audio.master);
    } else {
      source.connect(gain).connect(this.audio.master);
    }
    source.start();
    return { source, gain, panner };
  }

  burp(g) {
    const place = this.placement(g, BURP_BLOCKS);
    if (!place) return;
    const idx = VOICES.includes(g[16]) ? g[16] : VOICES[Math.random() < 0.5 ? 0 : 1]; // the one they made
    const s = this.sample(idx);
    if (s) this.play(idx, s.rate, false, BURP_VOLUME, place);
  }

  /** A car's horn as the game picks it: [sample, rate] by its model (HORN_SAMPLE, HORN_RATE). */
  hornSound(model) {
    return [HORN_SAMPLE.get(model) || 16, HORN_RATE.get(model) || 22050];
  }

  /** Each ghost's horn: sounding while their horn is held, following them. */
  updateHorn(slot, g) {
    const on = g && g[0] && g[13] && g[14] >= 0 && !NO_HORN.has(g[14]);
    const place = on ? this.placement(g, HORN_BLOCKS) : null;
    let h = this.horns.get(slot);
    if (!place) { this.stopHorn(slot); return; }
    if (!h || h.model !== g[14]) {
      this.stopHorn(slot);
      const [idx, rate] = this.hornSound(g[14]);
      h = this.play(idx, rate, true, HORN_VOLUME, place);
      if (!h) return;
      h.model = g[14];
      this.horns.set(slot, h);
    }
    h.gain.gain.value = HORN_VOLUME * place.gain;
    if (h.panner) h.panner.pan.value = place.pan;
  }

  stopHorn(slot) {
    const h = this.horns.get(slot);
    if (!h) return;
    this.horns.delete(slot);
    try { h.source.stop(); } catch { /* stopped */ }
  }

  /** A player's state as drawn now (predicted), or null. */
  current(slot, now) {
    const st = this.states.get(slot);
    if (!st || !st.g || now - st.t > STALE_MS || slot === this.lobby.mySlot) return null;
    return st.g[0] ? this.predict(st, now) : st.g;
  }

  /** The other players in the race, for the map, radar, names and scoreboard. */
  players() {
    const now = performance.now();
    const out = [];
    for (const slot of this.states.keys()) {
      const g = this.current(slot, now);
      if (!g) continue;
      out.push({ slot, onMap: !!g[0], x: g[1], y: g[2], rot: g[4], inCar: !!g[9], kills: g[10], deaths: g[11], points: g[12] });
    }
    return out;
  }

  draw() {
    const now = performance.now();
    this.watchSpecial();
    if (this.puppet) this.placePuppets(now);
    for (let slot = 0; slot < GHOST_MAX_PLAYERS; slot++) {
      const g = this.current(slot, now);
      if (g && g[0] && !this.puppet) this.set(slot, 1, g[1], g[2], g[3], g[4], g[5], g[6], g[7], g[8], ALPHA);
      else this.set(slot, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      if (this.audio) this.updateHorn(slot, g);
    }
  }

  /** Contact races: each player's stand-in, a real car (its model) or character (its animation frame) in this game. */
  placePuppets(now) {
    for (let slot = 0; slot < GHOST_MAX_PLAYERS; slot++) {
      const g = this.current(slot, now);
      const inCar = !!(g && g[0] && g[14] >= 0);
      if (g && g[0]) this.puppet(slot, 1, inCar ? 1 : 0, g[1], g[2], g[3], g[4], inCar ? g[14] : -1, g[8], inCar ? -1 : g[6], g[18], g[19], g[20]);
      else this.puppet(slot, 0, 0, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0);
    }
  }

  stop() {
    clearInterval(this.sender);
    cancelAnimationFrame(this.raf);
    for (let slot = 0; slot < GHOST_MAX_PLAYERS; slot++) {
      this.set(slot, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      if (this.puppet) this.puppet(slot, 0, 0, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0);
      this.stopHorn(slot);
    }
  }
}
