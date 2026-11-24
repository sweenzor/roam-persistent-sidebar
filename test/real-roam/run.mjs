// End-to-end run of the built extension in Roam's real desktop app (the Linux build, under Xvfb).
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs
//
// Signed in, it loads the build through Roam Depot's developer mode in a hosted test graph
// (ROAM_GRAPH, default vault-spike-hosted). Without credentials it uses Roam's public help graph and
// loads the build straight into the page after each start instead, since a reader can't install
// extensions there. Either way it fills the right sidebar, quits Roam, starts it again and checks that
// every window came back in order, collapsed and pinned as it was; then does the same after killing
// Roam outright, as a crash would. Writes RESULTS.md and PNG screenshots to $OUT.
//
// Credentials come only from the environment (GitHub Actions secrets in CI). They are removed from this
// process's environment before anything else starts, never written to disk or to the log, and no
// screenshot is taken before the graph is open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, quitRoam, waitFor, shot, signIn, openGraph, loadDevExtension, EXT_URL,
  sb, clearSidebar, deletePage, logSettings,
} from './roam.mjs';
import { checkPlan } from './plan.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;
const PUBLIC = !EMAIL || !PASSWORD;
const GRAPH = PUBLIC ? 'help' : process.env.ROAM_GRAPH || 'vault-spike-hosted';
const DIST = path.resolve(process.env.DIST || path.join(import.meta.dirname, '../../dist'));
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
const KEY = `persistent-sidebar:hosted:${GRAPH}`;
const TEST_PAGE = 'Persistent Sidebar CI test', OTHER_PAGE = 'Persistent Sidebar CI other';

fs.mkdirSync(OUT, { recursive: true });
roam.out = OUT; roam.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
function writeResults(extra = '') {
  const pass = checks.length > 0 && checks.every((c) => c.ok) && !extra;
  const roamVersion = (() => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'roam-research'], { encoding: 'utf8' }); } catch { return '?'; } })();
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), [
    `# Real Roam run: ${pass ? 'PASS' : 'FAIL'}`, '',
    `Roam desktop ${roamVersion} (Linux, Xvfb), ${PUBLIC ? 'public help graph, build loaded into the page' : `hosted graph \`${GRAPH}\`, build loaded through Roam Depot developer mode`}.`,
    `Commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? 'local'}.`, '',
    extra ? `**Stopped early:** ${extra}\n` : '',
    '| Check | Result |', '|---|---|',
    ...checks.map((c) => `| ${c.name}${c.detail ? ` (${c.detail})` : ''} | ${c.ok ? 'PASS' : '**FAIL**'} |`), '',
  ].join('\n'));
  return pass;
}

// ---------- in the page ----------
/** The sidebar as the extension saves it: open or not, and each window in order. */
const sidebarNow = () => evalIn(() => ({
  open: !!document.querySelector('#roam-right-sidebar-content'),
  windows: [...window.roamAlphaAPI.ui.rightSidebar.getWindows()].sort((a, b) => a.order - b.order).map((w) => ({
    key: `${w.type}:${w['search-query-str'] ?? w['block-uid'] ?? w['page-uid'] ?? w['mentions-uid']}`,
    collapsed: !!w['collapsed?'], pinned: !!w['pinned?'],
  })),
}));
const savedNow = () => evalIn((key) => {
  const s = JSON.parse(localStorage.getItem(key) ?? 'null');
  return s && { open: s.open, windows: s.windows.map((w) => ({ key: `${w.type}:${w.query ?? w.uid}`, collapsed: w.collapsed, pinned: w.pinned })) };
}, KEY);
const describe = (s) => `${s.open ? 'open' : 'closed'}: ${s.windows.map((w) => `${w.key}${w.collapsed ? ' collapsed' : ''}${w.pinned ? ' pinned' : ''}`).join(', ') || 'none'}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Pages and a block to open in the sidebar. Signed in, made on a test page; in the help graph, found. */
async function targets() {
  return evalIn(async ([PUBLIC, TEST_PAGE, OTHER_PAGE]) => {
    const api = window.roamAlphaAPI;
    const uidOf = (t) => api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', t);
    const firstChild = (u) => api.data.q('[:find ?c . :in $ ?u :where [?p :block/uid ?u] [?p :block/children ?b] [?b :block/order 0] [?b :block/uid ?c]]', u);
    if (PUBLIC) return { a: uidOf('Workflows'), b: uidOf('Writing'), c: uidOf('Research'), block: firstChild(uidOf('Workflows')) };
    for (const t of [TEST_PAGE, OTHER_PAGE]) if (!uidOf(t)) await api.data.page.create({ page: { title: t } });
    const a = uidOf(TEST_PAGE), b = uidOf(OTHER_PAGE);
    if (!firstChild(a)) await api.data.block.create({ location: { 'parent-uid': a, order: 0 }, block: { string: `A block that links to [[${OTHER_PAGE}]]` } });
    await new Promise((r) => setTimeout(r, 500));
    return { a, b, c: a, block: firstChild(a) };
  }, [PUBLIC, TEST_PAGE, OTHER_PAGE]);
}

/** Starts Roam, opens the graph and, in the help graph, loads the build into the page. */
async function start() {
  await launchRoam();
  if (!PUBLIC) {
    await signIn(EMAIL, PASSWORD);
    { const plan = await checkPlan(roam.page, GRAPH.startsWith('offline/') ? `#/${GRAPH}` : `#/app/${GRAPH}`); check("The test account's plan is Believer and ends more than a year away", plan.ok, plan.detail); }
  }
  await openGraph(GRAPH);
  if (PUBLIC) await evalIn(async (url) => { const m = await import(`${url}extension.js?${Date.now()}`); m.default.onload({ extensionAPI: { settings: { get: () => false } } }); }, EXT_URL);
}
/** Waits until the extension has saved since `t0` (page time), which it does once it has restored. */
const savedSince = (t0) => waitFor('the extension to save the sidebar', () => evalIn(([key, t0]) => (JSON.parse(localStorage.getItem(key) ?? 'null')?.t ?? 0) > t0, [KEY, t0]), 20000);
const pageTime = () => evalIn(() => Date.now());
/** The extension restores after a short wait; give it time, then let the sidebar settle. */
const restored = (want) => waitFor('the sidebar to be restored', async () => same(await sidebarNow(), want), 15000).catch(() => false);

async function main() {
  serve(DIST);
  log(`build ${DIST}, graph ${GRAPH}${PUBLIC ? ' (public, no sign-in)' : ''}`);
  await start();
  const t0 = await pageTime();
  if (!PUBLIC) await loadDevExtension();
  await savedSince(t0);
  check('Extension loads and saves the sidebar', true);

  // 1. Fill the sidebar: one window of every kind, one collapsed, one pinned.
  logStart = (await logLines()).length;
  await clearSidebar();
  const t = await targets();
  log('targets', JSON.stringify(t));
  await sb(`
    await sb.addWindow({ window: w('outline:' + arg.a) });
    await sb.addWindow({ window: w('block:' + arg.block) });
    await sb.addWindow({ window: w('mentions:' + arg.b) });
    await sb.addWindow({ window: w('graph:' + arg.c) });
    await sb.addWindow({ window: w('search-query:sidebar') });
    await new Promise((r) => setTimeout(r, 800));
    await sb.collapseWindow({ window: w('mentions:' + arg.b) });
    await sb.pinWindow({ window: w('block:' + arg.block) });`, t);
  await sleep(1500);
  const first = await sidebarNow();
  log('sidebar', describe(first));
  check('Five windows open, one collapsed, one pinned', first.windows.length === 5 && first.windows.filter((w) => w.collapsed).length === 1 && first.windows.filter((w) => w.pinned).length === 1, describe(first));
  check('Saved as shown', same(await savedNow(), first));
  await shot('sidebar-before-quit');

  // 2. Quit and start again.
  await quitRoam('SIGTERM');
  await start();
  const ok1 = await restored(first);
  const after1 = await sidebarNow();
  check('After quitting and starting Roam again, every window is back in order, collapsed and pinned as it was', ok1, describe(after1));
  await shot('after-restart');

  // 3. Change it (close one, move one, collapse another, pin a second one, close the sidebar), then kill
  // Roam outright. Roam puts the two pinned windows back itself, so the extension has to move windows
  // that are open already into place.
  await sb(`
    await sb.removeWindow({ window: w('graph:' + arg.c) });
    await sb.expandWindow({ window: w('mentions:' + arg.b) });
    await sb.collapseWindow({ window: w('outline:' + arg.a) });
    await sb.setWindowOrder({ window: { ...w('outline:' + arg.a), order: 0 } });
    await sb.pinWindow({ window: w('search-query:sidebar') });
    await new Promise((r) => setTimeout(r, 500));
    await sb.close();`, t);
  await sleep(1500);
  const second = await sidebarNow();
  log('sidebar', describe(second));
  check('Sidebar changed and closed', !second.open && second.windows.length === 4 && !same(second.windows, first.windows), describe(second));
  await quitRoam('SIGKILL');
  await start();
  const ok2 = await restored(second);
  const after2 = await sidebarNow();
  log('raw windows after kill', JSON.stringify(await evalIn(() => window.roamAlphaAPI.ui.rightSidebar.getWindows())));
  check('After Roam is killed, the sidebar comes back as it was, and stays closed', ok2, describe(after2));
  await shot('after-kill-sidebar-closed');
  await sb('await sb.open();');
  await sleep(1000);
  await shot('after-kill-sidebar-opened');

  // 4. An empty sidebar stays empty.
  await clearSidebar();
  await sleep(1500);
  await quitRoam('SIGTERM');
  await start();
  await sleep(4000);
  const after3 = await sidebarNow();
  check('A sidebar left empty stays empty', after3.windows.length === 0, describe(after3));

  // 5. Unloading. A second copy of the build is loaded into the page with the log switched on, a window
  // is opened, and the copy is unloaded before its 300 ms wait is over: the change must be saved by the
  // unload itself, and nothing may reach the graph afterwards. (The copy Roam loaded stays, log off.)
  if (!PUBLIC) await deletePage(UNLOAD_LOG_PAGE);
  let un = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clearSidebar();
    await sleep(1500);
    un = await evalIn(async ([url, key, uid, page]) => {
      const sb = window.roamAlphaAPI.ui.rightSidebar;
      const m = await import(`${url}extension.js?unload-${Date.now()}`);
      const settings = { get: (k) => (k === 'log' ? true : k === 'log-page' ? page : undefined), panel: { create() {} } };
      m.default.onload({ extensionAPI: { settings } });
      await new Promise((r) => setTimeout(r, 3000)); // started, restored and watching
      const saved = () => JSON.parse(localStorage.getItem(key) ?? 'null')?.windows.length ?? -1;
      const before = saved();
      await sb.addWindow({ window: { type: 'outline', 'block-uid': uid } });
      const t0 = performance.now();
      while (!document.querySelector('#roam-right-sidebar-content .rm-sidebar-window') && performance.now() - t0 < 200) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30));
      const justBefore = saved();
      m.default.onunload();
      return { before, justBefore, after: saved(), ms: Math.round(performance.now() - t0) };
    }, [EXT_URL, KEY, t.b, UNLOAD_LOG_PAGE]);
    log('unload', JSON.stringify(un));
    if (un.justBefore === un.before) break; // else the other copy's own save got in first: try again
  }
  check('A window opened just before the extension is unloaded is saved by the unload', un.justBefore === un.before && un.after === un.before + 1, JSON.stringify(un));
  await sleep(1500);
  await clearSidebar();
  await sleep(1500);
  if (!PUBLIC) {
    const written = await evalIn((t) => !!window.roamAlphaAPI.data.q('[:find ?p . :in $ ?t :where [?p :node/title ?t]]', t), UNLOAD_LOG_PAGE);
    check('After unload nothing is written to the graph: the unloaded copy logged neither that window nor its closing', !written);
    await deletePage(UNLOAD_LOG_PAGE);
  }

  // 6. The sidebar log (signed in only: the help graph can't be written to). Switched on in the
  // settings tab, then off again, because extension settings are kept in the graph.
  if (!PUBLIC) {
    await deletePage(CUSTOM_LOG_PAGE); // left by a run that stopped early
    const was = await logSettings({});
    check('The Sidebar log switch is off until it is turned on, and nothing was logged', !was.on && (await logLines()).length === logStart, `${(await logLines()).length - logStart} lines`);
    const openAndClose = () => sb(`await sb.addWindow({ window: w('outline:' + arg.b) }); await new Promise((r) => setTimeout(r, 1500));
      await sb.removeWindow({ window: w('outline:' + arg.b) });`, t);
    const want = [`Opened [[${OTHER_PAGE}]]`, `Closed [[${OTHER_PAGE}]]`];
    const entries = (title, from) => waitFor('the log entries', async () => {
      const lines = (await logLines(title)).slice(from).map((l) => l.replace(/^\d\d:\d\d /, ''));
      return want.every((x) => lines.includes(x)) && lines;
    }, 15000).catch(() => null);

    await logSettings({ on: true, beforeClose: () => shot('settings-sidebar-log-on') });
    await openAndClose();
    const got = await entries(LOG_PAGE, logStart);
    check('With the switch on, opening and closing a window adds both to the page Sidebar Log', !!got, got?.join(' / ') ?? 'no entries');
    const today = await evalIn(() => `[[${window.roamAlphaAPI.util.dateToPageTitle(new Date())}]]`);
    const day = await logDay(LOG_PAGE);
    check('The day in the log links to the daily note page', day === today, day ?? 'no day block');
    await evalIn((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), LOG_PAGE);
    await sleep(1500);
    await shot('sidebar-log-page');

    // Search text is not Roam markup in the log: no page, reference or TODO comes of it.
    const marked = () => evalIn(([page, pages]) => {
      const api = window.roamAlphaAPI;
      const blocks = api.data.q('[:find ?u ?s :in $ ?t :where [?p :node/title ?t] [?b :block/page ?p] [?b :block/uid ?u] [?b :block/string ?s]]', page).filter(([, s]) => s.includes(pages[1]));
      const refs = blocks.flatMap(([u]) => api.data.pull('[{:block/refs [:block/uid]}]', [':block/uid', u])?.[':block/refs'] ?? []);
      return { lines: blocks.map(([, s]) => s.replace(/^\d\d:\d\d /, '')), refs: refs.length, pages: pages.filter((t) => api.data.q('[:find ?p . :in $ ?t :where [?p :node/title ?t]]', t)) };
    }, [LOG_PAGE, MARKUP_PAGES]);
    const before = (await marked()).lines.length; // from earlier runs: 2 a run
    await sb(`await sb.addWindow({ window: w('search-query:' + arg) }); await new Promise((r) => setTimeout(r, 1500));
      await sb.removeWindow({ window: w('search-query:' + arg) });`, MARKUP);
    const made = await waitFor('the search log entries', async () => { const m = await marked(); return m.lines.length >= before + 2 && m; }, 15000).catch(() => marked());
    await sleep(1500);
    check('Search text with [[a link]], a #tag and {{[[TODO]]}} in it is logged as code: no page is made and the lines refer to nothing',
      made.lines.length === before + 2 && made.lines.every((l) => l.endsWith(`Search: \`${MARKUP}\``)) && made.refs === 0 && made.pages.length === 0, JSON.stringify({ ...made, lines: made.lines.slice(-2), before }));

    // Typing in an open search window changes its text, which is part of what tells windows apart.
    await sb(`await sb.addWindow({ window: w('search-query:sidebar') });`);
    await sleep(2000);
    const n0 = (await logLines()).length;
    const field = roam.page.locator('#roam-right-sidebar-content .rm-sidebar-window input:not([type="checkbox"])').first();
    let typed = 'no text field in the search window';
    if (await field.count()) {
      await field.click();
      await roam.page.keyboard.press('End');
      await roam.page.keyboard.type(' log', { delay: 600 });
      await sleep(1500);
      typed = `the window now reports ${JSON.stringify(await evalIn(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'search-query').map((w) => w['search-query-str'])))}`;
    }
    const extra = (await logLines()).slice(n0);
    check('Typing in an open search window adds nothing to the log', extra.length === 0, `${typed}; ${extra.join(' / ') || 'no new lines'}`);
    await clearSidebar();
    await sleep(1500);

    await logSettings({ page: CUSTOM_LOG_PAGE, beforeClose: () => shot('settings-log-page-named') });
    const mid = (await logLines()).length;
    await openAndClose();
    const got2 = await entries(CUSTOM_LOG_PAGE, 0);
    check('With another page named in settings, the log goes to that page instead', !!got2 && (await logLines()).length === mid, got2?.join(' / ') ?? 'no entries');

    await logSettings({ on: false, page: '' });
    await sb(`await sb.addWindow({ window: w('outline:' + arg.b) }); await new Promise((r) => setTimeout(r, 1500));`, t);
    await sleep(1500);
    check('With the switch off again, nothing more is logged', (await logLines()).length === mid && (await logLines(CUSTOM_LOG_PAGE)).length === 2, `${(await logLines()).length - mid} lines`);
    await clearSidebar();
  }
}

const LOG_PAGE = 'Sidebar Log', CUSTOM_LOG_PAGE = 'Persistent Sidebar CI log', UNLOAD_LOG_PAGE = 'Persistent Sidebar CI unload log';
const MARKUP_PAGES = ['Persistent Sidebar CI no such page', 'pscinosuchtag'];
const MARKUP = `[[${MARKUP_PAGES[0]}]] #${MARKUP_PAGES[1]} {{[[TODO]]}}`;
let logStart = 0;
const logTree = (title) => evalIn((title) => {
  const page = window.roamAlphaAPI.data.pull('[{:block/children [:block/string :block/order {:block/children [:block/string :block/order]}]}]', [':node/title', title]);
  const byOrder = (a, b) => a[':block/order'] - b[':block/order'];
  return (page?.[':block/children'] ?? []).sort(byOrder).map((d) => [d[':block/string'], (d[':block/children'] ?? []).sort(byOrder).map((c) => c[':block/string'])]);
}, title);
/** Every entry on a log page, oldest first. */
const logLines = async (title = LOG_PAGE) => (await logTree(title)).flatMap((d) => d[1]);
/** The last day block on a log page. */
const logDay = async (title) => (await logTree(title)).at(-1)?.[0] ?? null;
let failure = '';
try { await main(); } catch (e) { failure = e.message.split('\n')[0]; log('ERROR', e.stack ?? e.message); await shot('error'); }
try { if (roam.page) await clearSidebar(); } catch { /* best effort */ }
try {
  if (roam.page && !PUBLIC) { await logSettings({ on: false, page: '' }); await deletePage(CUSTOM_LOG_PAGE); await deletePage(UNLOAD_LOG_PAGE); }
} catch { /* best effort */ }
await quitRoam('SIGTERM').catch(() => {});
stopServing();
const pass = writeResults(failure);
log(pass ? 'ALL PASSED' : 'FAILED', '->', path.join(OUT, 'RESULTS.md'));
process.exit(pass ? 0 : 1);
