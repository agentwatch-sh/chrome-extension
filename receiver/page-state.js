// The page side of the receiver's import (contract C6 step 3).
//
// replacePageState runs only in the restore page of the site's origin,
// injected with chrome.scripting.executeScript after lib/codec.js. Chrome
// sends the function's source, so it is self-contained: it uses no other name
// of this module and no import, only the page's own globals and
// globalThis.agentwatchCodec. It never throws, and no error text carries a
// stored value (names and counts only).
export async function replacePageState(json) {
  const out = { local: 0, session: 0, idb_databases: 0, idb_records: 0, cache_entries: 0, errors: [] };
  const fail = (text) => {
    out.errors.push(text);
  };
  try {
    let state;
    try {
      state = JSON.parse(json);
    } catch (e) {
      state = null;
    }
    if (state === null || typeof state !== "object") {
      fail("storage: not readable");
      return out;
    }
    const codec = globalThis.agentwatchCodec;
    if (!codec || typeof codec.decode !== "function") {
      fail("storage: codec missing");
      return out;
    }

    const isList = (x) => Object.prototype.toString.call(x) === "[object Array]";
    const isMap = (x) => x !== null && typeof x === "object" && !isList(x);
    const listOf = (x) => (isList(x) ? x : []);
    const label = (x) => (typeof x === "string" ? x : "?");
    const fromB64 = (s) => {
      const bin = atob(s);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    };
    // A deletion that another connection blocks stays pending; report it and
    // leave that database alone, so a later open does not wait behind it.
    const dropDatabase = (name) => new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => resolve("ok");
      r.onerror = () => resolve("failed");
      r.onblocked = () => resolve("blocked");
    });
    const hasCaches = typeof caches !== "undefined";

    // 1. Clear what the origin holds now.
    try {
      localStorage.clear();
    } catch (e) {
      fail("local: not cleared");
    }
    try {
      sessionStorage.clear();
    } catch (e) {
      fail("session: not cleared");
    }
    const kept = [];
    try {
      for (const info of await indexedDB.databases()) {
        if (typeof info.name !== "string") continue;
        if ((await dropDatabase(info.name)) !== "ok") {
          kept.push(info.name);
          fail("idb " + info.name + ": not deleted");
        }
      }
    } catch (e) {
      fail("idb: not cleared");
    }
    if (hasCaches) {
      try {
        for (const name of await caches.keys()) {
          try {
            await caches.delete(name);
          } catch (e) {
            fail("cache " + name + ": not deleted");
          }
        }
      } catch (e) {
        fail("caches: not cleared");
      }
    }

    // 2. Write the sent state.
    const writeArea = (area, entries, key) => {
      if (!isMap(entries)) return;
      let skipped = 0;
      for (const k of Object.keys(entries)) {
        try {
          if (typeof entries[k] !== "string") throw new Error("not text");
          area.setItem(k, entries[k]);
          out[key] += 1;
        } catch (e) {
          skipped += 1;
        }
      }
      if (skipped > 0) fail(key + ": " + skipped + " entries skipped");
    };
    try {
      writeArea(localStorage, state.local, "local");
    } catch (e) {
      fail("local: not written");
    }
    try {
      writeArea(sessionStorage, state.session, "session");
    } catch (e) {
      fail("session: not written");
    }

    const openDatabase = (d) => new Promise((resolve, reject) => {
      const r = indexedDB.open(d.name, d.version);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of listOf(d.stores)) {
          const where = "idb " + d.name + "/" + label(s && s.name);
          let store;
          try {
            store = db.createObjectStore(s.name, {
              keyPath: s.keyPath === null ? undefined : s.keyPath,
              autoIncrement: s.autoIncrement === true,
            });
          } catch (e) {
            fail(where + ": not created");
            continue;
          }
          for (const ix of listOf(s.indexes)) {
            try {
              store.createIndex(ix.name, ix.keyPath, { unique: ix.unique === true, multiEntry: ix.multiEntry === true });
            } catch (e) {
              fail(where + ": index " + label(ix && ix.name) + " not created");
            }
          }
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("open failed"));
      r.onblocked = () => reject(new Error("open blocked"));
    });

    // One transaction per store. A record whose key or value does not decode,
    // or whose put fails, is skipped; the others stay.
    const writeStore = async (db, dbName, s) => {
      const records = listOf(s && s.records);
      if (records.length === 0) return;
      const where = "idb " + dbName + "/" + label(s.name);
      let written = 0;
      let skipped = 0;
      try {
        const tx = db.transaction(s.name, "readwrite");
        const done = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(new Error("aborted"));
        });
        const store = tx.objectStore(s.name);
        const outOfLine = store.keyPath === null;
        for (const rec of records) {
          try {
            const value = codec.decode(rec.value);
            const r = outOfLine ? store.put(value, codec.decode(rec.key)) : store.put(value);
            r.onsuccess = () => {
              written += 1;
            };
            r.onerror = (ev) => {
              ev.preventDefault(); // keep the transaction
              ev.stopPropagation();
              skipped += 1;
            };
          } catch (e) {
            skipped += 1;
          }
        }
        await done;
      } catch (e) {
        fail(where + ": not written");
        return;
      }
      out.idb_records += written;
      if (skipped > 0) fail(where + ": " + skipped + " records skipped");
    };

    for (const d of listOf(state.idb)) {
      const dbName = label(d && d.name);
      if (d === null || typeof d !== "object" || typeof d.name !== "string") {
        fail("idb " + dbName + ": not written");
        continue;
      }
      if (kept.indexOf(d.name) >= 0) {
        fail("idb " + dbName + ": not written");
        continue;
      }
      let db;
      try {
        db = await openDatabase(d);
      } catch (e) {
        fail("idb " + dbName + ": not written");
        continue;
      }
      out.idb_databases += 1;
      try {
        for (const s of listOf(d.stores)) await writeStore(db, dbName, s);
      } finally {
        db.close();
      }
    }

    for (const c of listOf(state.caches)) {
      const where = "cache " + label(c && c.name);
      if (!hasCaches) {
        fail(where + ": not written");
        continue;
      }
      let skipped = 0;
      try {
        const cache = await caches.open(c.name);
        for (const entry of listOf(c.entries)) {
          try {
            await cache.put(entry.url, new Response(fromB64(entry.body), { status: entry.status, headers: entry.headers }));
            out.cache_entries += 1;
          } catch (e) {
            skipped += 1;
          }
        }
      } catch (e) {
        fail(where + ": not written");
        continue;
      }
      if (skipped > 0) fail(where + ": " + skipped + " entries skipped");
    }
  } catch (e) {
    fail("storage: failed");
  }
  return out;
}
