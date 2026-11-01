// The page reader. chrome.scripting.executeScript injects readPageState into a
// tab with `func:`, after `files: ["lib/codec.js"]` has set
// globalThis.agentwatchCodec. Chrome serializes only the function, so it must
// use nothing from this module: every helper is declared inside it.
//
// It returns {storage, skipped}. `storage` is the C2 storage object. `skipped`
// lists the names of databases and caches that could not be opened or read;
// they are left out of `storage`. A name is not secret; a stored value never
// enters an error or a name.
export async function readPageState() {
  const codec = globalThis.agentwatchCodec;
  const CHUNK = 32 * 1024;
  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(s);
  };
  const req = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("request failed"));
    });
  const readArea = (area) => {
    const out = {};
    try {
      for (let i = 0; i < area.length; i++) {
        const k = area.key(i);
        const v = area.getItem(k);
        if (k !== null && v !== null) {
          Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
        }
      }
    } catch {
      // A storage area that the page forbids reads as empty.
    }
    return out;
  };

  const storage = { local: readArea(localStorage), session: readArea(sessionStorage), idb: [], caches: [] };
  const skipped = [];

  let infos = [];
  try {
    infos = await indexedDB.databases();
  } catch {
    infos = [];
  }
  for (const info of infos) {
    const name = info.name;
    let db = null;
    try {
      db = await req(indexedDB.open(name));
      const d = { name: db.name, version: db.version, stores: [] };
      for (const storeName of Array.from(db.objectStoreNames)) {
        const st = db.transaction(storeName, "readonly").objectStore(storeName);
        const s = {
          name: storeName,
          keyPath: st.keyPath === undefined ? null : st.keyPath,
          autoIncrement: st.autoIncrement,
          indexes: [],
          records: [],
        };
        for (const indexName of Array.from(st.indexNames)) {
          const ix = st.index(indexName);
          s.indexes.push({ name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry });
        }
        const keys = await req(st.getAllKeys());
        const values = await req(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
        for (let i = 0; i < keys.length; i++) {
          s.records.push({ key: await codec.encode(keys[i]), value: await codec.encode(values[i]) });
        }
        d.stores.push(s);
      }
      storage.idb.push(d);
    } catch {
      skipped.push(String(name));
    } finally {
      try {
        if (db) db.close();
      } catch {
        // Already closed.
      }
    }
  }

  let cacheNames = [];
  try {
    cacheNames = await caches.keys();
  } catch {
    cacheNames = [];
  }
  for (const name of cacheNames) {
    try {
      const cache = await caches.open(name);
      const entries = [];
      for (const r of await cache.keys()) {
        const resp = await cache.match(r);
        if (!resp) continue;
        entries.push({
          url: r.url,
          status: resp.status,
          headers: Array.from(resp.headers),
          body: toB64(new Uint8Array(await resp.arrayBuffer())),
        });
      }
      storage.caches.push({ name, entries });
    } catch {
      skipped.push("cache " + String(name));
    }
  }
  return { storage, skipped };
}
