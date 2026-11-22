// Saves the sidebar per graph on this device. Two copies: localStorage, which is quick but which
// Chromium writes to disk lazily, and IndexedDB with strict durability, which survives a crash or a
// force quit. On load the newer of the two wins.
const DB = 'persistent-sidebar', STORE = 'state';

const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export function createStore(key) {
  const lsKey = `${DB}:${key}`;
  let db = null;
  const getDb = async () => (db ??= await openDb());

  async function load() {
    let a = null, b = null;
    try { a = JSON.parse(localStorage.getItem(lsKey) ?? 'null'); } catch { /* unreadable */ }
    try {
      const d = await getDb();
      b = await new Promise((res, rej) => {
        const q = d.transaction(STORE).objectStore(STORE).get(key);
        q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error);
      });
    } catch { /* IndexedDB unavailable */ }
    if (!a) return b; if (!b) return a;
    return (b.t ?? 0) > (a.t ?? 0) ? b : a;
  }

  async function save(state) {
    try { localStorage.setItem(lsKey, JSON.stringify(state)); } catch { /* full or blocked */ }
    try {
      const d = await getDb();
      await new Promise((res, rej) => {
        const tx = d.transaction(STORE, 'readwrite', { durability: 'strict' });
        tx.objectStore(STORE).put(state, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    } catch { /* localStorage copy still there */ }
  }

  const close = () => { db?.close(); db = null; };
  return { load, save, close };
}
