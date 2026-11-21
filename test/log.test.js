import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, createLog, LOG_PAGE } from '../src/log.js';

const titles = { p1: 'Alpha', p2: 'Beta' };
const titleOf = (u) => titles[u] ?? null;

test('lists opened and closed windows in Roam\'s words', () => {
  const before = [{ type: 'outline', uid: 'p1' }, { type: 'graph', uid: 'p2' }];
  const after = [{ type: 'outline', uid: 'p1' }, { type: 'block', uid: 'b1' }, { type: 'mentions', uid: 'p2' }, { type: 'search-query', query: 'todo' }];
  assert.deepEqual(changes(before, after, titleOf), [
    'Opened ((b1))', 'Opened References to: [[Beta]]', 'Opened Search: todo', 'Closed Graph of [[Beta]]',
  ]);
});

test('moving, collapsing or pinning a window is not logged', () => {
  const a = [{ type: 'outline', uid: 'p1', collapsed: false }, { type: 'block', uid: 'b1', pinned: false }];
  const b = [{ type: 'block', uid: 'b1', pinned: true }, { type: 'outline', uid: 'p1', collapsed: true }];
  assert.deepEqual(changes(a, b, titleOf), []);
});

// A tiny in-memory graph with the bits of roamAlphaAPI the log uses.
function fakeGraph() {
  const blocks = new Map(); // uid -> { string, title, children: [] }
  let n = 0;
  const api = {
    util: { generateUID: () => `u${++n}`, dateToPageTitle: (d) => `November ${d.getDate()}th, 2026` },
    data: {
      q: (query, arg) => {
        if (query.includes(':node/title ?t')) return [...blocks].find(([, b]) => b.title === arg)?.[0] ?? null;
        return (blocks.get(arg)?.children ?? []).map((u, i) => [u, blocks.get(u).string, i]);
      },
      page: { create: async ({ page }) => { blocks.set(page.uid, { title: page.title, children: [] }); } },
      block: {
        create: async ({ location, block }) => {
          const uid = block.uid ?? api.util.generateUID();
          blocks.set(uid, { string: block.string, children: [] });
          blocks.get(location['parent-uid']).children.push(uid);
        },
      },
    },
  };
  const outline = () => {
    const page = [...blocks.values()].find((b) => b.title === LOG_PAGE);
    return page?.children.map((d) => [blocks.get(d).string, blocks.get(d).children.map((c) => blocks.get(c).string)]);
  };
  return { api, outline };
}

test('writes under one block per day, creating the page the first time', async () => {
  const g = fakeGraph();
  const log = createLog(g.api);
  log.add(['Opened [[Alpha]]'], new Date(2026, 10, 21, 9, 5));
  log.add(['Closed [[Alpha]]', 'Opened ((b1))'], new Date(2026, 10, 21, 17, 30));
  await log.add(['Opened Search: todo'], new Date(2026, 10, 22, 8, 0));
  assert.deepEqual(g.outline(), [
    ['November 21th, 2026', ['09:05 Opened [[Alpha]]', '17:30 Closed [[Alpha]]', '17:30 Opened ((b1))']],
    ['November 22th, 2026', ['08:00 Opened Search: todo']],
  ]);
});
