// Saves the sidebar per graph on this device. Two copies: localStorage, which is quick but which
// Chromium writes to disk lazily, and IndexedDB with strict durability, which survives a crash or a
// force quit. On load the newer of the two wins.
const DB = 'persistent-sidebar', STORE = 'state';

const openDb = (idb) => new Promise((res, rej) => {
  const r = idb.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export function createStore(key, { idb = globalThis.indexedDB, ls = globalThis.localStorage } = {}) {
  const lsKey = `${DB}:${key}`;
  // One connection for the store: every caller waits on the same open, so calls that overlap while it
  // is still opening share it. After close() nothing opens a connection again.
  let opening = null, closed = false, writes = Promise.resolve();
  const getDb = () => {
    if (closed) return Promise.reject(new Error('closed'));
    return (opening ??= openDb(idb).catch((e) => { opening = null; throw e; }));
  };

  async function load() {
    let a = null, b = null;
    try { a = JSON.parse(ls.getItem(lsKey) ?? 'null'); } catch { /* unreadable */ }
    try {
      const d = await getDb();
      b = await new Promise((res, rej) => {
        const q = d.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error);
      });
    } catch { /* IndexedDB unavailable, or closed meanwhile */ }
    if (!a) return b; if (!b) return a;
    return (b.t ?? 0) > (a.t ?? 0) ? b : a;
  }

  /** The localStorage copy is written before this returns; the IndexedDB copy follows, one save at a time. */
  function save(state) {
    try { ls.setItem(lsKey, JSON.stringify(state)); } catch { /* full or blocked */ }
    if (closed) return writes;
    const opened = getDb();
    opened.catch(() => {}); // looked at below, when its turn comes
    writes = writes.then(async () => {
      const d = await opened;
      await new Promise((res, rej) => {
        const tx = d.transaction(STORE, 'readwrite', { durability: 'strict' });
        tx.objectStore(STORE).put(state, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    }).catch(() => { /* localStorage copy still there */ });
    return writes;
  }

  /** Closes the connection once the saves already asked for are written, also one that is still being
   *  opened when this is called. */
  function close() {
    if (closed) return writes;
    closed = true;
    const pending = opening;
    opening = null;
    writes = writes.then(() => pending).then((d) => d?.close(), () => {});
    return writes;
  }
  return { load, save, close };
}
