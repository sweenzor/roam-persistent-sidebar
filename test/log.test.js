import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, createLog, describeWindow, LOG_PAGE } from '../src/log.js';

const titles = { p1: 'Alpha', p2: 'Beta' };
const titleOf = (u) => titles[u] ?? null;

test('lists opened and closed windows in Roam\'s words', () => {
  const before = [{ type: 'outline', uid: 'p1' }, { type: 'graph', uid: 'p2' }];
  const after = [{ type: 'outline', uid: 'p1' }, { type: 'block', uid: 'b1' }, { type: 'mentions', uid: 'p2' }, { type: 'search-query', query: 'todo' }];
  assert.deepEqual(changes(before, after, titleOf), [
    'Opened ((b1))', 'Opened References to: [[Beta]]', 'Opened Search: `todo`', 'Closed Graph of [[Beta]]',
  ]);
});

test('moving, collapsing or pinning a window is not logged', () => {
  const a = [{ type: 'outline', uid: 'p1', collapsed: false }, { type: 'block', uid: 'b1', pinned: false }];
  const b = [{ type: 'block', uid: 'b1', pinned: true }, { type: 'outline', uid: 'p1', collapsed: true }];
  assert.deepEqual(changes(a, b, titleOf), []);
});

test('search text goes in as inline code, so nothing typed into a search is read as Roam markup', () => {
  const line = (query) => describeWindow({ type: 'search-query', query }, titleOf);
  assert.equal(line('[[Foo]] #foo {{[[TODO]]}} ((abc123456)) Key:: **x**'), 'Search: `[[Foo]] #foo {{[[TODO]]}} ((abc123456)) Key:: **x**`');
  // A backtick would end the code and let the rest through as markup.
  assert.equal(line('a` [[Foo]] `b'), "Search: `a' [[Foo]] 'b`");
  assert.equal(line('```\n[[Foo]]'), "Search: `''' [[Foo]]`");
  for (const q of ['a` [[Foo]] `b', '`', '``[[Foo]]``', 'x\n```']) assert.equal((line(q).match(/`/g) ?? []).length, 2);
  assert.equal(line(''), 'Search: ');
});

test('typing in an open search window is not logged as one search closed and another opened', () => {
  const page = { type: 'outline', uid: 'p1' };
  const s = (query) => ({ type: 'search-query', query });
  assert.deepEqual(changes([page, s('t')], [page, s('to')], titleOf), []);
  assert.deepEqual(changes([s('to'), page], [s('todo'), page], titleOf), []);
  // A search opened or closed on its own is still logged, also next to one being typed in.
  assert.deepEqual(changes([page], [page, s('todo')], titleOf), ['Opened Search: `todo`']);
  assert.deepEqual(changes([page, s('todo')], [page], titleOf), ['Closed Search: `todo`']);
  assert.deepEqual(changes([s('a')], [s('ab'), s('new')], titleOf), ['Opened Search: `new`']);
  assert.deepEqual(changes([s('a'), page], [s('ab')], titleOf), ['Closed [[Alpha]]']);
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
  const outline = (title = LOG_PAGE) => {
    const page = [...blocks.values()].find((b) => b.title === title);
    return page?.children.map((d) => [blocks.get(d).string, blocks.get(d).children.map((c) => blocks.get(c).string)]);
  };
  return { api, outline };
}

test('writes under one block per day, linked to the daily note, creating the page the first time', async () => {
  const g = fakeGraph();
  const log = createLog(g.api);
  log.add(['Opened [[Alpha]]'], new Date(2026, 10, 21, 9, 5));
  log.add(['Closed [[Alpha]]', 'Opened ((b1))'], new Date(2026, 10, 21, 17, 30));
  await log.add(['Opened Search: `todo`'], new Date(2026, 10, 22, 8, 0));
  assert.deepEqual(g.outline(), [
    ['[[November 21th, 2026]]', ['09:05 Opened [[Alpha]]', '17:30 Closed [[Alpha]]', '17:30 Opened ((b1))']],
    ['[[November 22th, 2026]]', ['08:00 Opened Search: `todo`']],
  ]);
});

test('writes to the page named in settings, and to Sidebar Log when the name is blank', async () => {
  const g = fakeGraph();
  let name = '  Reading trail ';
  const log = createLog(g.api, () => name);
  await log.add(['Opened [[Alpha]]'], new Date(2026, 10, 21, 9, 5));
  name = '';
  await log.add(['Closed [[Alpha]]'], new Date(2026, 10, 21, 9, 6));
  assert.deepEqual(g.outline('Reading trail'), [['[[November 21th, 2026]]', ['09:05 Opened [[Alpha]]']]]);
  assert.deepEqual(g.outline(), [['[[November 21th, 2026]]', ['09:06 Closed [[Alpha]]']]]);
});

test('after stop nothing more is written: not a write under way, not lines waiting, not new ones', async () => {
  const g = fakeGraph();
  const log = createLog(g.api);
  const create = g.api.data.block.create;
  let release;
  const held = new Promise((r) => { release = r; });
  // Hold the first line's write open, as a slow Roam would, and unload during it.
  g.api.data.block.create = async (a) => { if (a.block.string.endsWith('one')) await held; return create(a); };
  log.add(['one', 'two', 'three'], new Date(2026, 10, 21, 9, 5));
  const waiting = log.add(['four'], new Date(2026, 10, 21, 9, 6));
  await new Promise((r) => setTimeout(r, 10));
  log.stop();
  release();
  await waiting;
  await log.add(['five'], new Date(2026, 10, 21, 9, 7));
  assert.deepEqual(g.outline(), [['[[November 21th, 2026]]', ['09:05 one']]]);
});
