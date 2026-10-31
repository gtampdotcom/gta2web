// The game's language (Options screen, web/options.js): the text in the game's menus, messages and
// missions. The engine picks data/<letter>.gxt from the registry's option\language when it starts
// (TextTable.cpp), so a change is used from the next game.
//
// Español is the original translation (data/s.gxt, in the game files). Français has no original
// file here: it is made from data/e.gxt with the fan translation of the menus, HUD and messages
// (web/gxt-translations.js, web/gxtgen.js, both from the upstream GTA2 in the browser), so its
// mission text stays in English.
import { GAME_TRANSLATIONS } from './gxt-translations.js?v=1256913706';
import { buildGxt, parseGxt, translateGxt } from './gxtgen.js?v=1256913706';

export const LANG_KEY = 'gta2-port-lang';
export const LANGS = { en: 'English', es: 'Español', fr: 'Français' };
const LETTERS = { en: 'e', es: 's', fr: 'f' };

/** A language code from anywhere (this browser, a host's lobby settings): a known one, else English. */
export const knownLang = (code) => (Object.hasOwn(LANGS, code) ? code : 'en');

/** This browser's choice (?lang=es|fr|en for this visit). */
export function savedLang() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl) return knownLang(fromUrl);
  try { return knownLang(localStorage.getItem(LANG_KEY)); } catch { return 'en'; }
}

/**
 * Makes sure data/<letter>.gxt exists for the language (an original file always wins) and returns
 * the letter for the registry. Must run before the game starts. Falls back to English.
 */
export function prepareGameLanguage(FS, dir, code) {
  const letter = LETTERS[knownLang(code)];
  if (letter === 'e') return 'e';
  const target = `${dir}/data/${letter}.gxt`;
  try {
    if (FS.analyzePath(target).exists) return letter;
    const translations = GAME_TRANSLATIONS[knownLang(code)];
    if (!translations) return 'e';
    FS.writeFile(target, translateGxt(FS.readFile(`${dir}/data/e.gxt`), letter, translations));
    return letter;
  } catch (err) {
    console.warn('game language unavailable, using English:', err);
    return 'e';
  }
}

/**
 * A community map's own text (maps.json "gxt": its modified e.gxt), for this match only: the
 * game's files are in memory, written again from the cache for every match. Every text the map
 * changes from the game's e.gxt goes into each language file there (English becomes the map's
 * file; Español and Français keep their translation plus the map's own messages, in English).
 * Must run before the game starts.
 */
export function applyMapText(FS, dir, mapGxt) {
  const stock = new Map(parseGxt(FS.readFile(`${dir}/data/e.gxt`)).entries.map((e) => [e.key, e.text]));
  const changed = new Map(parseGxt(FS.readFile(`${dir}/data/${mapGxt}`)).entries
    .filter((e) => stock.get(e.key) !== e.text).map((e) => [e.key, e.text]));
  for (const letter of Object.values(LETTERS)) {
    const path = `${dir}/data/${letter}.gxt`;
    if (!FS.analyzePath(path).exists) continue;
    const { entries } = parseGxt(FS.readFile(path));
    const keys = new Set(entries.map((e) => e.key));
    const out = entries.map((e) => (changed.has(e.key) ? { key: e.key, text: changed.get(e.key) } : e));
    for (const [key, text] of changed) if (!keys.has(key)) out.push({ key, text });
    FS.writeFile(path, buildGxt(letter, out));
  }
}
