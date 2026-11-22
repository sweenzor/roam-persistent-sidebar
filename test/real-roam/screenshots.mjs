// Takes the README's screenshots in Roam's real desktop app (the Linux build, under Xvfb), signed in to
// the hosted test graph with the build loaded through Roam Depot's developer mode.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… OUT=docs/images node test/real-roam/screenshots.mjs
//
// Every picture shows the real extension at work: the sidebar pictures are taken after Roam has been
// quit and started again, and the log pictures show what the extension wrote. It makes a few small
// pages about a trip to have something to show, and puts the settings and the sidebar back when done.
// Credentials are handled as in run.mjs. See .github/workflows/screenshots.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, quitRoam, waitFor, signIn, openGraph, loadDevExtension,
  sb, clearSidebar, deletePage, logSettings,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;
const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const DIST = path.resolve(process.env.DIST || path.join(import.meta.dirname, '../../dist'));
const OUT = path.resolve(process.env.OUT || 'docs/images');
const KEY = `persistent-sidebar:hosted:${GRAPH}`;
const LOG_PAGE = 'Sidebar Log';
const WIDTH = 1280, HEIGHT = 800;

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.startsWith('debug-')) fs.rmSync(path.join(OUT, f)); // from an earlier run
roam.logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));

// A few pages to fill the sidebar with. Each entry is a block, or [block, its children].
const PAGES = {
  'Lisbon trip': [
    'Dates: May 12 to May 19',
    'Staying in [[Alfama]]',
    ['Things to book', ['Train to [[Sintra]]', 'Dinner at one of the [[Restaurants to try]]']],
    'Go through the [[Packing list]] the night before',
  ],
  'Packing list': ['Passport', 'Walking shoes', 'Rain jacket', 'Plug adapter'],
  'Restaurants to try': ['Cervejaria Ramiro for seafood', 'Time Out Market for lunch', 'Pastéis de Belém, go early'],
  Sintra: ['Take the early train from Rossio', 'Pena Palace', 'Quinta da Regaleira'],
  Alfama: ['Miradouro de Santa Luzia at sunset', 'Fado on Thursday night'],
};

/** Makes the pages that are missing, and returns the uid of each page plus Sintra's first block. */
const makePages = () => evalIn(async (PAGES) => {
  const api = window.roamAlphaAPI;
  const uidOf = (t) => api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', t);
  const add = async (parent, items) => {
    for (const [order, item] of items.entries()) {
      const [string, children] = Array.isArray(item) ? item : [item, []];
      const uid = api.util.generateUID();
      await api.data.block.create({ location: { 'parent-uid': parent, order }, block: { string, uid } });
      await add(uid, children);
    }
  };
  // A page can be there already and empty, made by a [[link]] to it from another page.
  const empty = (uid) => !api.data.q('[:find ?b . :in $ ?u :where [?p :block/uid ?u] [?p :block/children ?b]]', uid);
  const uids = {};
  for (const [title, items] of Object.entries(PAGES)) {
    if (!uidOf(title)) await api.data.page.create({ page: { title, uid: api.util.generateUID() } });
    uids[title] = uidOf(title);
    if (empty(uids[title])) await add(uids[title], items);
  }
  await new Promise((r) => setTimeout(r, 500));
  uids.block = api.data.q('[:find ?c . :in $ ?u :where [?p :block/uid ?u] [?p :block/children ?b] [?b :block/order 0] [?b :block/uid ?c]]', uids.Sintra);
  return uids;
}, PAGES);

const openPage = async (title) => {
  await evalIn((title) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title } }), title);
  await waitFor(`the page "${title}"`, () => evalIn((t) => document.querySelector('.roam-article .rm-title-display')?.textContent.trim() === t, title), 20000);
  await sleep(1500);
};
const windowCount = () => evalIn(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().length);
const savedCount = () => evalIn((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.windows.length ?? -1, KEY);

let cdp = null;
/** Starts Roam and opens the graph at twice the pixel density, so the pictures are sharp. */
async function start() {
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  cdp = await roam.page.context().newCDPSession(roam.page); // kept open: the override ends with it
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);
}
/** Quits Roam the way closing its window does, starts it again and waits for `n` sidebar windows. */
async function restart(n) {
  await waitFor('the sidebar to be saved', async () => (await savedCount()) === n, 15000);
  await sleep(1000);
  await quitRoam('SIGTERM');
  await start();
  await waitFor(`${n} windows back in the sidebar`, async () => (await windowCount()) === n, 20000);
}
/** The part of the window `selector` covers, for a cropped picture. */
const boxOf = (selector, pad = 0) => evalIn(([selector, pad, W, H]) => {
  const r = document.querySelector(selector)?.getBoundingClientRect();
  if (!r) return null;
  const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
  return { x, y, width: Math.min(W, r.right + pad) - x, height: Math.min(H, r.bottom + pad) - y };
}, [selector, pad, WIDTH, HEIGHT]);
/** How far down the text in `selector` goes, so a picture can stop there and not show empty space. */
const fold = (selector = '.roam-article *, #right-sidebar .rm-sidebar-window *', pad = 28) => evalIn(([selector, pad, H]) => {
  let bottom = 0;
  for (const e of document.querySelectorAll(selector)) {
    if (e.children.length || !e.textContent.trim()) continue;
    const r = e.getBoundingClientRect();
    if (r.width && r.height) bottom = Math.max(bottom, r.bottom);
  }
  return Math.min(H, Math.ceil(bottom + pad));
}, [selector, pad, HEIGHT]);
/** The whole window, down to where its text ends. */
const windowBox = async () => ({ x: 0, y: 0, width: WIDTH, height: await fold() });
async function snap(name, clip) {
  await evalIn(() => document.querySelectorAll('.bp3-toast .bp3-button').forEach((b) => b.click()));
  await roam.page.mouse.move(WIDTH / 2, HEIGHT - 4);
  await sleep(500);
  // Straight from the page's own session: Playwright's screenshot puts its own 1x viewport back first.
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  log('saved', `${name}.png`, clip ? JSON.stringify(clip) : '');
}

async function main() {
  serve(DIST);
  await start();
  await loadDevExtension();
  await waitFor('the extension to save the sidebar', async () => (await savedCount()) >= 0, 20000);
  await logSettings({ on: false, page: '' });
  await deletePage(LOG_PAGE); // entries from test runs
  await clearSidebar();
  const u = await makePages();

  // 1. Three windows, Roam quit and started again.
  await sb(`
    await sb.addWindow({ window: w('block:' + arg.block) });
    await sb.addWindow({ window: w('outline:' + arg['Packing list']) });
    await sb.addWindow({ window: w('outline:' + arg['Restaurants to try']) });`, u);
  await restart(3);
  await openPage('Lisbon trip');
  await snap('sidebar-restored', await windowBox());

  // 2. One window of every kind, some collapsed and one pinned, Roam quit and started again.
  await clearSidebar();
  await sb(`
    await sb.addWindow({ window: w('search-query:train') });
    await sb.addWindow({ window: w('graph:' + arg['Lisbon trip']) });
    await sb.addWindow({ window: w('block:' + arg.block) });
    await sb.addWindow({ window: w('outline:' + arg['Restaurants to try']) });
    await sb.addWindow({ window: w('mentions:' + arg.Sintra) });
    await sb.addWindow({ window: w('outline:' + arg['Packing list']) });
    await new Promise((r) => setTimeout(r, 800));
    await sb.collapseWindow({ window: w('search-query:train') });
    await sb.collapseWindow({ window: w('graph:' + arg['Lisbon trip']) });
    await sb.collapseWindow({ window: w('outline:' + arg['Restaurants to try']) });
    await sb.pinWindow({ window: w('outline:' + arg['Packing list']) });`, u);
  await restart(6);
  await openPage('Sintra');
  await snap('window-kinds', await windowBox());

  // 3. The settings tab, with the log switched on.
  await logSettings({
    on: true,
    beforeClose: async () => {
      await evalIn(() => {
        const find = (t) => [...document.querySelectorAll('.bp3-dialog *')].find((e) => e.children.length === 0 && e.textContent.trim() === t && e.offsetParent);
        const a = find('Sidebar log'), b = find('Sidebar log page');
        let n = a;
        while (n && !n.contains(b)) n = n.parentElement;
        document.querySelectorAll('[data-ps-shot]').forEach((e) => e.removeAttribute('data-ps-shot'));
        n?.setAttribute('data-ps-shot', '');
      });
      await snap('settings', await boxOf('[data-ps-shot]', 16));
    },
  });

  // 4. The log: open one window and close two, then look at the log page.
  await sb(`
    await sb.addWindow({ window: w('outline:' + arg.Alfama) });
    await new Promise((r) => setTimeout(r, 1500));
    await sb.removeWindow({ window: w('search-query:train') });
    await new Promise((r) => setTimeout(r, 1500));
    await sb.removeWindow({ window: w('graph:' + arg['Lisbon trip']) });`, u);
  await waitFor('three lines in the log', () => evalIn((title) => {
    const page = window.roamAlphaAPI.data.pull('[{:block/children [{:block/children [:block/string]}]}]', [':node/title', title]);
    return (page?.[':block/children'] ?? []).flatMap((d) => d[':block/children'] ?? []).length >= 3;
  }, LOG_PAGE), 15000);
  await openPage(LOG_PAGE);
  await snap('sidebar-log', await windowBox());

  // 5. A page that was opened in the sidebar lists the log in its Linked References.
  await openPage('Alfama');
  const article = await boxOf('.roam-article');
  const top = (await boxOf('.roam-article .rm-title-display')).y - 28;
  await snap('sidebar-log-linked-references', { ...article, y: top, height: (await fold('.roam-article *')) - top });
}

let failure = '';
try { await main(); } catch (e) { failure = e.message.split('\n')[0]; log('ERROR', e.stack ?? e.message); if (roam.page) await snap('debug-error').catch(() => {}); }
try {
  if (roam.page) { await logSettings({ on: false, page: '' }); await clearSidebar(); await deletePage(LOG_PAGE); await sleep(1500); }
} catch { /* best effort */ }
await quitRoam('SIGTERM').catch(() => {});
stopServing();
log(failure ? `FAILED: ${failure}` : 'DONE', '->', OUT);
process.exit(failure ? 1 : 0);
