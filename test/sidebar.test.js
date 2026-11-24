import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWindows, restore, windowKey } from '../src/sidebar.js';

// A stand-in for roamAlphaAPI that behaves like Roam's: addWindow puts the window at the top, the
// sidebar opens when a window is added, and getWindows reports page windows by page-uid.
function fakeApi(pages = ['p1', 'p2', 'p3', 'b1'], { fail = () => false } = {}) {
  let wins = [], open = false;
  const key = (w) => w.type === 'search-query' ? `search-query:${w['search-query-str']}` : `${w.type}:${w['block-uid']}`;
  const find = (w) => wins.find((x) => key(x) === key(w));
  const calls = [];
  // `fail(name, key)` makes that one call reject, as Roam does for a window it cannot act on.
  const guard = (name, fn) => async (arg) => {
    const k = arg?.window ? key(arg.window) : null;
    if (fail(name, k)) { calls.push([`${name} failed`, k]); throw new Error(`${name} refused`); }
    return fn(arg);
  };
  const sb = {
    getWindows: () => wins.map((w, order) => {
      const o = { type: w.type, order, 'pinned?': !!w.pinned, 'collapsed?': !!w.collapsed };
      if (w.type === 'search-query') o['search-query-str'] = w['search-query-str'];
      else if (w.type === 'block') o['block-uid'] = w['block-uid'];
      else o['page-uid'] = w['block-uid'];
      return o;
    }),
    addWindow: async ({ window: w }) => { calls.push(['add', key(w)]); if (!find(w)) wins.unshift({ ...w }); open = true; },
    removeWindow: async ({ window: w }) => { calls.push(['remove', key(w)]); wins = wins.filter((x) => key(x) !== key(w)); },
    collapseWindow: async ({ window: w }) => { find(w).collapsed = true; },
    expandWindow: async ({ window: w }) => { find(w).collapsed = false; },
    pinWindow: async ({ window: w }) => { find(w).pinned = true; },
    setWindowOrder: async ({ window: w }) => {
      calls.push(['order', key(w), w.order]);
      const x = find(w);
      wins = wins.filter((y) => y !== x);
      wins.splice(w.order, 0, x);
    },
    open: async () => { open = true; },
    close: async () => { open = false; },
  };
  for (const name of Object.keys(sb)) if (name !== 'getWindows') sb[name] = guard(name, sb[name]);
  return { api: { ui: { rightSidebar: sb } }, exists: (u) => pages.includes(u), isOpen: () => open, calls, sb };
}

const saved = {
  open: true,
  windows: [
    { type: 'outline', uid: 'p1', collapsed: false, pinned: false },
    { type: 'block', uid: 'b1', collapsed: true, pinned: false },
    { type: 'search-query', query: 'todo', collapsed: false, pinned: true },
    { type: 'mentions', uid: 'p2', collapsed: false, pinned: false },
  ],
};

test('restores every window in order, with collapsed and pinned state, and opens the sidebar', async () => {
  const f = fakeApi();
  await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.deepEqual(readWindows(f.sb), saved.windows);
  assert.equal(f.isOpen(), true);
});

test('read then restore round-trips', async () => {
  const a = fakeApi();
  await restore(a.api, saved, { exists: a.exists, addPinnedSearches: true });
  const snap = { open: true, windows: readWindows(a.sb) };
  const b = fakeApi();
  await restore(b.api, snap, { exists: b.exists, addPinnedSearches: true });
  assert.deepEqual(readWindows(b.sb), readWindows(a.sb));
});

test('keeps the sidebar closed when it was closed', async () => {
  const f = fakeApi();
  await restore(f.api, { ...saved, open: false }, { exists: f.exists, addPinnedSearches: true });
  assert.equal(readWindows(f.sb).length, 4);
  assert.equal(f.isOpen(), false);
});

test('skips windows whose page or block was deleted', async () => {
  const f = fakeApi(['p1']);
  const n = await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.equal(n.count, 2);
  assert.deepEqual(readWindows(f.sb).map(windowKey), ['outline:p1', 'search-query:todo']);
});

test('windows Roam already put back (pinned ones) are not doubled and end up in saved order', async () => {
  const f = fakeApi();
  await f.sb.addWindow({ window: { type: 'mentions', 'block-uid': 'p2' } });
  await f.sb.pinWindow({ window: { type: 'mentions', 'block-uid': 'p2' } });
  await f.sb.addWindow({ window: { type: 'outline', 'block-uid': 'p3' } }); // open now, not saved
  await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.deepEqual(readWindows(f.sb).map(windowKey), [...saved.windows.map(windowKey), 'outline:p3']);
  assert.equal(readWindows(f.sb)[3].pinned, true);
});

test('windows that are open already are moved into place, never taken out and added again', async () => {
  const f = fakeApi();
  for (const w of [{ type: 'mentions', 'block-uid': 'p2' }, { type: 'outline', 'block-uid': 'p1' }]) await f.sb.addWindow({ window: w });
  await f.sb.pinWindow({ window: { type: 'mentions', 'block-uid': 'p2' } });
  f.calls.length = 0;
  const r = await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.filter(([c]) => c === 'remove'), []);
  assert.deepEqual(f.calls.filter(([c]) => c === 'add').map(([, k]) => k), ['search-query:todo', 'block:b1']);
  assert.deepEqual(readWindows(f.sb).map(windowKey), saved.windows.map(windowKey));
});

test('one window that cannot be added does not stop the others, their order or their pins', async () => {
  const f = fakeApi(undefined, { fail: (name, key) => name === 'addWindow' && key === 'block:b1' });
  const r = await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map((x) => [x.step, x.window]), [['add', 'block:b1']]);
  assert.deepEqual(readWindows(f.sb), saved.windows.filter((w) => w.uid !== 'b1'));
  assert.equal(f.isOpen(), true);
});

test('a window Roam put back pinned keeps its pin when other steps fail', async () => {
  const pinned = { ...saved, windows: saved.windows.map((w) => ({ ...w, pinned: true })) };
  const f = fakeApi(undefined, { fail: (name, key) => (name === 'addWindow' && key === 'outline:p1') || (name === 'setWindowOrder' && key === 'mentions:p2') });
  await f.sb.addWindow({ window: { type: 'mentions', 'block-uid': 'p2' } });
  await f.sb.pinWindow({ window: { type: 'mentions', 'block-uid': 'p2' } });
  const r = await restore(f.api, pinned, { exists: f.exists, addPinnedSearches: true });
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls.filter(([c]) => c === 'remove'), []);
  const now = readWindows(f.sb);
  assert.deepEqual(now.map(windowKey).sort(), ['block:b1', 'mentions:p2', 'search-query:todo']);
  assert.equal(now.every((w) => w.pinned), true);
});

test('a second try after a failure adds only what is still missing', async () => {
  let refuse = true;
  const f = fakeApi(undefined, { fail: (name, key) => refuse && name === 'addWindow' && key === 'block:b1' });
  assert.equal((await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true })).ok, false);
  refuse = false; f.calls.length = 0;
  assert.equal((await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true })).ok, true);
  assert.deepEqual(f.calls.filter(([c]) => c === 'add'), [['add', 'block:b1']]);
  assert.deepEqual(readWindows(f.sb), saved.windows);
});

test('stops between steps once it is cancelled, and says so', async () => {
  const f = fakeApi();
  let adds = 0;
  const add = f.sb.addWindow;
  f.sb.addWindow = async (a) => { adds++; return add(a); };
  const r = await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true, cancelled: () => adds >= 2 });
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.equal(adds, 2);
  assert.equal(readWindows(f.sb).length, 2);
  assert.equal(readWindows(f.sb).some((w) => w.collapsed || w.pinned), false);
});

test('a pinned search is left for Roam to put back, then moved into place; it is never added twice', async () => {
  const f = fakeApi();
  const first = await restore(f.api, saved, { exists: f.exists });
  assert.equal(first.ok, false);
  assert.deepEqual(first.waiting, ['search-query:todo']);
  assert.deepEqual(first.failed, []);
  assert.deepEqual(readWindows(f.sb).map(windowKey), ['outline:p1', 'block:b1', 'mentions:p2']);
  // Roam brings it back, pinned, below the others.
  await f.sb.addWindow({ window: { type: 'search-query', 'search-query-str': 'todo' } });
  await f.sb.pinWindow({ window: { type: 'search-query', 'search-query-str': 'todo' } });
  await f.sb.setWindowOrder({ window: { type: 'search-query', 'search-query-str': 'todo', order: 3 } });
  f.calls.length = 0;
  const second = await restore(f.api, saved, { exists: f.exists });
  assert.equal(second.ok, true);
  assert.deepEqual(f.calls.filter(([c]) => c === 'add'), []);
  assert.deepEqual(readWindows(f.sb), saved.windows);
});

test('does nothing when the sidebar already matches', async () => {
  const f = fakeApi();
  await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  f.calls.length = 0;
  await restore(f.api, saved, { exists: f.exists, addPinnedSearches: true });
  assert.deepEqual(f.calls, []);
});

test('an empty save leaves the sidebar alone', async () => {
  const f = fakeApi();
  await f.sb.addWindow({ window: { type: 'outline', 'block-uid': 'p3' } });
  await restore(f.api, { open: true, windows: [] }, { exists: f.exists, addPinnedSearches: true });
  assert.deepEqual(readWindows(f.sb).map(windowKey), ['outline:p3']);
});
