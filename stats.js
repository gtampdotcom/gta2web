// Anonymous play counts for the public site, sent to GoatCounter (no cookies, nothing stored in
// the browser, no personal data). Only active where config.json names an endpoint
// ({"stats": "https://<code>.goatcounter.com/count"}, written by scripts/build_pages.py), and
// never from this computer, an automated browser or the developer's own copies.
//
// What is counted (GoatCounter paths): visits to the front page and the lobby; a game started
// (play/solo, play/coop-<mode>); each match's size and map (match/<n>-players, map/<map id>, from
// the host); active play time reaching a milestone (time/<solo|coop>-<5m…4h>); the one-time game
// download (download/gta2, download/failed).
//
// Where the site runs PHP, the same counts also go to the site's own stats.php, which keeps them
// on the web server with the history of hosted matches (map, mode, players, host country) and
// shows them at stats.php.

let endpoint = null;
let local = false;

/** Turns counting on when the site's config names an endpoint or the site has stats.php (and this is not a local or automated browser). */
export async function initStats(config) {
  const test = new URLSearchParams(location.search).has('statstest');
  if (!test && (navigator.webdriver || /^(localhost|127\.|\[::1\])/.test(location.hostname))) return false;
  if (config && config.stats) endpoint = config.stats;
  // a static host sends the PHP file as text, or nothing
  local = !(config && config.server) && await fetch('stats.php?ping', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null)).then((data) => !!data && data.stats === true).catch(() => false);
  return !!endpoint || local;
}

/**
 * Counts one visit (event = false) or event at a path such as 'play/solo'. match ({map, mode,
 * players}, from the host) also adds the match to the site's history.
 */
export function count(path, { event = true, title = '', match = null } = {}) {
  if (local) {
    try {
      navigator.sendBeacon('stats.php', new Blob([JSON.stringify({ p: path, ...(match ? { match } : {}) })], { type: 'application/json' }));
    } catch { /* counting never gets in the way of playing */ }
  }
  if (!endpoint) return;
  const data = {
    p: path, t: title || document.title, e: event ? 'true' : '',
    r: event ? '' : document.referrer,
    s: [screen.width, screen.height, devicePixelRatio || 1].join(','),
    rnd: Math.random().toString(36).slice(2, 7),
  };
  const query = Object.entries(data).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try { navigator.sendBeacon(`${endpoint}?${query}`); } catch { /* counting never gets in the way of playing */ }
}

const MILESTONES = [[5, '5m'], [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [240, '4h']];

/** Counts active play time (the tab visible) as it passes each milestone: time/<kind>-<5m…4h>. */
export function startPlayClock(kind) {
  if (!endpoint && !local) return;
  const step = 15;
  let seconds = 0;
  let next = 0;
  const timer = setInterval(() => {
    if (document.hidden) return;
    seconds += step;
    while (next < MILESTONES.length && seconds >= MILESTONES[next][0] * 60) count(`time/${kind}-${MILESTONES[next++][1]}`);
    if (next === MILESTONES.length) clearInterval(timer);
  }, step * 1000);
}
