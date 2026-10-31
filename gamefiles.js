// Keeps the player's own GTA2 files in this browser (IndexedDB) after they are
// picked once, so later visits start without choosing the folder again.
//
// The files never leave the computer: they are stored per site, per browser,
// like any other site data. A "complete" marker is written last, so an
// interrupted copy is never used. "Forget game files" deletes the copy.

const DB_NAME = 'gta2-port-gamefiles';
const FILES = 'files';
const META = 'meta';
const FORMAT = 1;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore(FILES);
    req.result.createObjectStore(META);
  };
  return promisify(req);
}

// Rockstar's December 2004 freeware release, as archived by the Internet
// Archive (item gta2_rockstar-classics; README.md "Provenance"). The /cors/
// address serves it with CORS headers, so the player's browser can fetch it
// directly; this site never stores or serves game files. For private testing.
const INSTALLER_URL = 'https://archive.org/cors/gta2_rockstar-classics/GTA2INSTALLER.exe';
const INSTALLER_SIZE = 362331961;

/**
 * Downloads the freeware installer into this browser and unpacks it in a
 * worker (web/installer-worker.js).
 * @param {(stage: string, done: number, total: number) => void} onProgress
 * @returns {Promise<Map<string, Blob>>} game files keyed by lower-case relative path
 */
let keptInstaller = null; // a verified download whose unpacking failed, for a retry

export async function downloadFreeware(onProgress) {
  const buf = keptInstaller || await fetchInstaller(onProgress);
  keptInstaller = null;
  return unpackInstaller(buf, onProgress);
}

/**
 * Checks and unpacks the freeware installer (GTA2INSTALLER.exe) the player
 * downloaded themselves, then picked as a file.
 * @param {File} file
 */
export async function unpackInstallerFile(file, onProgress) {
  if (file.size !== INSTALLER_SIZE) {
    throw new Error(`That is not the GTA2 freeware installer: GTA2INSTALLER.exe is ${INSTALLER_SIZE.toLocaleString()} bytes.`);
  }
  onProgress('read', 0, file.size);
  return unpackInstaller(new Uint8Array(await file.arrayBuffer()), onProgress);
}

async function unpackInstaller(buf, onProgress) {
  const worker = new Worker(new URL('./installer-worker.js?v=1256913706', import.meta.url), { type: 'module' });
  try {
    const files = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.stage, m.done, m.total);
        else if (m.type === 'done') resolve(m.files);
        else if (m.type === 'error') {
          if (m.installer && m.installer.byteLength === INSTALLER_SIZE) keptInstaller = new Uint8Array(m.installer);
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The unpacking worker failed.'));
      worker.postMessage({ installer: buf.buffer }, [buf.buffer]);
    });
    return new Map(files.map(([rel, data]) => [rel, new Blob([data])]));
  } finally {
    worker.terminate();
  }
}

// A download that receives nothing for this long is given up, so Play can try again.
const STALL_MS = 45000;

async function fetchInstaller(onProgress) {
  const abort = new AbortController();
  let timer = 0;
  const watch = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), STALL_MS); };
  watch();
  try {
    const res = await fetch(INSTALLER_URL, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status})`);
    const buf = new Uint8Array(INSTALLER_SIZE);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch();
      if (got + value.length > INSTALLER_SIZE) throw new Error('The download is larger than the GTA2 installer');
      buf.set(value, got);
      got += value.length;
      onProgress('download', got, INSTALLER_SIZE);
    }
    if (got !== INSTALLER_SIZE) throw new Error(`The download stopped early (${got} of ${INSTALLER_SIZE} bytes)`);
    return buf;
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`The Internet Archive sent nothing for ${STALL_MS / 1000} seconds`);
    if (err instanceof TypeError) throw new Error(`The Internet Archive could not be reached (${err.message})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unpacks a file the site sent pre-compressed (scripts/pack_site.py), here in the browser.
 * Bytes that are not gzip are returned as they are: some web servers unpack .gz files themselves.
 * @param {Uint8Array} bytes
 */
export async function gunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Community map files kept in this browser, as the site sent them (packed), so a map downloads once.
 * Keys are "<dir>/<file>#<content hash>" (maps/index.json): a changed file has a new key.
 */
export class MapFileCache {
  async open() {
    if (!this.db) {
      const req = indexedDB.open('gta2-port-maps', 1);
      req.onupgradeneeded = () => req.result.createObjectStore(FILES);
      this.db = await promisify(req);
    }
    return this.db;
  }

  /** @returns {Promise<Uint8Array|null>} */
  async get(key) {
    try {
      const blob = await promisify((await this.open()).transaction(FILES, 'readonly').objectStore(FILES).get(key));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  /** Keeps the file, and drops older versions of it. */
  async put(key, bytes) {
    try {
      const store = (await this.open()).transaction(FILES, 'readwrite').objectStore(FILES);
      const prefix = key.slice(0, key.indexOf('#') + 1);
      store.delete(IDBKeyRange.bound(prefix, `${prefix}~`)); // older versions (hashes are hex, below ~; queued before the put)
      store.put(new Blob([bytes]), key);
    } catch { /* storage unavailable: the map downloads again next time */ }
  }
}

export class GameFileCache {
  /** @returns {Promise<{count:number, bytes:number, savedAt:number}|null>} the stored copy, if complete. */
  async info() {
    try {
      const db = await openDb();
      const meta = await promisify(db.transaction(META, 'readonly').objectStore(META).get('complete'));
      db.close();
      return meta && meta.format === FORMAT ? meta : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<Map<string, Blob>>} */
  async load() {
    const db = await openDb();
    const store = db.transaction(FILES, 'readonly').objectStore(FILES);
    const [keys, values] = await Promise.all([promisify(store.getAllKeys()), promisify(store.getAll())]);
    db.close();
    const files = new Map();
    keys.forEach((k, i) => files.set(k, values[i]));
    return files;
  }

  /** Stores the picked files (after the game has started, so it does not delay it). */
  async save(files) {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch { /* best effort */ }
    }
    await this.forget();
    const db = await openDb();
    let bytes = 0;
    // Batches of up to ~32 MB keep memory use down for the large radio files.
    const batches = [[]];
    let batchBytes = 0;
    for (const entry of files) {
      if (batches.at(-1).length && batchBytes + entry[1].size > 32 * 1048576) {
        batches.push([]);
        batchBytes = 0;
      }
      batches.at(-1).push(entry);
      batchBytes += entry[1].size;
    }
    for (const entries of batches) {
      // Read the batch first: a transaction closes as soon as its task awaits anything else.
      const batch = await Promise.all(entries.map(async ([rel, file]) => [rel, await file.arrayBuffer()]));
      const tx = db.transaction(FILES, 'readwrite');
      const store = tx.objectStore(FILES);
      for (const [rel, data] of batch) {
        store.put(new Blob([data]), rel);
        bytes += data.byteLength;
      }
      await txDone(tx);
    }
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ format: FORMAT, count: files.size, bytes, savedAt: Date.now() }, 'complete');
    await txDone(tx);
    db.close();
    return bytes;
  }

  async forget() {
    const db = await openDb();
    const tx = db.transaction([FILES, META], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(FILES).clear();
    await txDone(tx);
    db.close();
  }
}
