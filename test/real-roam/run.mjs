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
import { roam, log, sleep, evalIn, serve, stopServing, launchRoam, quitRoam, waitFor, shot, signIn, openGraph, loadDevExtension, EXT_URL } from './roam.mjs';

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
/** Runs `fn(sidebar, w)` in the page, where `w(key)` turns a window key back into an API window. */
const sb = (body, arg) => evalIn(async ([body, arg]) => {
  const sb = window.roamAlphaAPI.ui.rightSidebar;
  const w = (key) => { const [type, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]; return type === 'search-query' ? { type, 'search-query-str': id } : { type, 'block-uid': id }; };
  return new Function('sb', 'w', 'arg', `return (async () => { ${body} })()`)(sb, w, arg);
}, [body, arg]);

async function clearSidebar() {
  await sb(`for (const x of sb.getWindows()) { const k = x.type + ':' + (x['search-query-str'] ?? x['block-uid'] ?? x['page-uid'] ?? x['mentions-uid']);
    if (x['pinned?']) await sb.unpinWindow({ window: w(k) }); await sb.removeWindow({ window: w(k) }); }`);
}
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
  if (!PUBLIC) await signIn(EMAIL, PASSWORD);
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

  // 3. Change it (close one, move one, collapse another, close the sidebar), then kill Roam outright.
  await sb(`
    await sb.removeWindow({ window: w('graph:' + arg.c) });
    await sb.expandWindow({ window: w('mentions:' + arg.b) });
    await sb.collapseWindow({ window: w('outline:' + arg.a) });
    await sb.setWindowOrder({ window: { ...w('outline:' + arg.a), order: 0 } });
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

  // 5. The sidebar log (signed in only: the help graph can't be written to). Switched on in the
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

    await logSettings({ on: true });
    await openAndClose();
    const got = await entries(LOG_PAGE, logStart);
    check('With the switch on, opening and closing a window adds both to the page Sidebar Log', !!got, got?.join(' / ') ?? 'no entries');
    const today = await evalIn(() => `[[${window.roamAlphaAPI.util.dateToPageTitle(new Date())}]]`);
    const day = await logDay(LOG_PAGE);
    check('The day in the log links to the daily note page', day === today, day ?? 'no day block');
    await evalIn((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), LOG_PAGE);
    await sleep(1500);
    await shot('sidebar-log-page');

    await logSettings({ page: CUSTOM_LOG_PAGE });
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

const LOG_PAGE = 'Sidebar Log', CUSTOM_LOG_PAGE = 'Persistent Sidebar CI log';
let logStart = 0;
const logTree = (title) => evalIn((title) => {
  const page = window.roamAlphaAPI.data.pull('[{:block/children [:block/string :block/order {:block/children [:block/string :block/order]}]}]', [':node/title', title]);
  const byOrder = (a, b) => a[':block/order'] - b[':block/order'];
  return (page?.[':block/children'] ?? []).sort(byOrder).map((d) => [d[':block/string'], (d[':block/children'] ?? []).sort(byOrder).map((c) => c[':block/string'])]);
}, title);
const deletePage = (title) => evalIn(async (title) => {
  const uid = window.roamAlphaAPI.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
  if (uid) await window.roamAlphaAPI.data.page.delete({ page: { uid } });
}, title);
/** Every entry on a log page, oldest first. */
const logLines = async (title = LOG_PAGE) => (await logTree(title)).flatMap((d) => d[1]);
/** The last day block on a log page. */
const logDay = async (title) => (await logTree(title)).at(-1)?.[0] ?? null;
/** Opens the Persistent Sidebar settings tab, sets the Sidebar log switch (`on`) and the Sidebar log
 *  page field (`page`) when given, and returns how the switch was before. */
async function logSettings({ on, page }) {
  await evalIn(() => document.querySelector('.rm-topbar .bp3-icon-more')?.click());
  await waitFor('the More menu', () => evalIn(() => !!document.querySelector('.bp3-menu-item')), 5000);
  await evalIn(() => [...document.querySelectorAll('.bp3-menu-item')].find((e) => /^Settings/.test(e.innerText.trim()))?.click());
  await waitFor('the Persistent Sidebar settings tab', () => evalIn(() => {
    const tab = [...document.querySelectorAll('.bp3-dialog *')].find((e) => e.children.length === 0 && /^Persistent Sidebar/.test(e.textContent.trim()));
    tab?.click(); return !!tab;
  }), 15000);
  // The dialog keeps other tabs' controls around, so find ours by the name on their rows.
  const control = (name, selector) => evalIn(([name, selector]) => {
    const label = [...document.querySelectorAll('.bp3-dialog *')].find((e) => e.children.length === 0 && e.textContent.trim() === name && e.offsetParent);
    let row = label;
    while (row && !row.querySelector(selector)) row = row.parentElement;
    const el = row?.closest('.bp3-dialog') ? row.querySelector(selector) : null;
    if (!el) return null;
    document.querySelectorAll('[data-ps-control]').forEach((e) => e.removeAttribute('data-ps-control'));
    el.setAttribute('data-ps-control', '');
    return { checked: !!el.checked, value: el.value ?? '' };
  }, [name, selector]);
  const sw = () => control('Sidebar log', '.bp3-switch input');
  const was = await waitFor('the Sidebar log switch', sw, 10000);
  if (on !== undefined && was.checked !== on) {
    await evalIn(() => document.querySelector('[data-ps-control]').click());
    await sleep(800);
    if ((await sw())?.checked !== on) throw new Error(`could not turn the Sidebar log switch ${on ? 'on' : 'off'}`);
  }
  if (page !== undefined) {
    await waitFor('the Sidebar log page field', () => control('Sidebar log page', 'input:not([type="checkbox"])'), 10000);
    await roam.page.locator('[data-ps-control]').fill(page);
    await roam.page.keyboard.press('Tab');
    await sleep(1000);
  }
  if (on || page) await shot(`settings-${page ? 'log-page-named' : 'sidebar-log-on'}`);
  await roam.page.keyboard.press('Escape'); await sleep(500);
  return { on: was.checked };
}

let failure = '';
try { await main(); } catch (e) { failure = e.message.split('\n')[0]; log('ERROR', e.stack ?? e.message); await shot('error'); }
try { if (roam.page) await clearSidebar(); } catch { /* best effort */ }
try {
  if (roam.page && !PUBLIC) { await logSettings({ on: false, page: '' }); await deletePage(CUSTOM_LOG_PAGE); }
} catch { /* best effort */ }
await quitRoam('SIGTERM').catch(() => {});
stopServing();
const pass = writeResults(failure);
log(pass ? 'ALL PASSED' : 'FAILED', '->', path.join(OUT, 'RESULTS.md'));
process.exit(pass ? 0 : 1);
