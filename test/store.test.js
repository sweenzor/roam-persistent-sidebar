import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// A stand-in for indexedDB: open() answers when `release()` is called (at once when `held` is false),
// and every connection handed out is counted, with whether it was closed.
function fakeIdb({ held = false } = {}) {
  const data = new Map(), connections = [], waiting = [];
  const connection = () => {
    const c = {
      closed: false,
      close() { c.closed = true; },
      transaction() {
        if (c.closed) throw new Error('InvalidStateError');
        const tx = {
          objectStore: () => ({
            put: (value, key) => { data.set(key, value); setTimeout(() => tx.oncomplete?.()); },
            get: (key) => { const q = { result: data.get(key) }; setTimeout(() => q.onsuccess?.()); return q; },
          }),
        };
        return tx;
      },
    };
    connections.push(c);
    return c;
  };
  const idb = {
    opens: 0,
    open() {
      idb.opens++;
      const r = {};
      const answer = () => { r.result = connection(); r.onsuccess(); };
      if (held) waiting.push(answer); else setTimeout(answer);
      return r;
    },
  };
  return { idb, data, connections, release: () => waiting.splice(0).forEach((f) => f()) };
}
const fakeLs = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('saves to both copies and loads the newer one', async () => {
  const f = fakeIdb(), ls = fakeLs();
  const store = createStore('hosted:g', { idb: f.idb, ls });
  await store.save({ open: true, windows: [], t: 1 });
  assert.deepEqual(f.data.get('hosted:g'), { open: true, windows: [], t: 1 });
  ls.setItem('persistent-sidebar:hosted:g', JSON.stringify({ open: false, windows: [], t: 2 }));
  assert.equal((await store.load()).t, 2);
  f.data.set('hosted:g', { open: true, windows: [], t: 3 });
  assert.equal((await store.load()).t, 3);
});

test('calls that overlap while the database is opening share one connection', async () => {
  const f = fakeIdb({ held: true });
  const store = createStore('hosted:g', { idb: f.idb, ls: fakeLs() });
  const all = [store.load(), store.save({ t: 1 }), store.save({ t: 2 }), store.load()];
  await tick();
  f.release();
  await Promise.all(all);
  assert.equal(f.idb.opens, 1);
  assert.equal(f.connections.length, 1);
  assert.equal(f.data.get('hosted:g').t, 2);
});

test('close while the database is still opening closes the connection when it arrives', async () => {
  const f = fakeIdb({ held: true });
  const store = createStore('hosted:g', { idb: f.idb, ls: fakeLs() });
  const loading = store.load();
  await tick();
  const closing = store.close();
  f.release();
  await Promise.all([loading, closing]);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closed, true);
});

test('a save asked for just before close is written, then the connection is closed', async () => {
  const f = fakeIdb(), ls = fakeLs();
  const store = createStore('hosted:g', { idb: f.idb, ls });
  await store.load();
  store.save({ t: 7 });
  await store.close();
  assert.equal(f.data.get('hosted:g').t, 7);
  assert.equal(JSON.parse(ls.m.get('persistent-sidebar:hosted:g')).t, 7);
  assert.equal(f.connections[0].closed, true);
});

test('after close nothing opens the database again', async () => {
  const f = fakeIdb(), ls = fakeLs();
  const store = createStore('hosted:g', { idb: f.idb, ls });
  await store.save({ t: 1 });
  await store.close();
  await store.save({ t: 2 });
  assert.equal((await store.load()).t, 2); // from localStorage
  await tick();
  assert.equal(f.idb.opens, 1);
  assert.equal(f.connections.every((c) => c.closed), true);
  assert.equal(f.data.get('hosted:g').t, 1);
});
