// Persistent Sidebar: keeps every window in Roam's right sidebar, with its order and whether it is
// collapsed or pinned, and whether the sidebar is open, and puts them all back when Roam starts again.
import { readWindows, restore, sameState } from './sidebar.js';
import { createStore } from './store.js';
import { changes, createLog, LOG_PAGE } from './log.js';

const TAG = '[persistent-sidebar]';
const SAVE_DELAY = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sidebarOpen = () => !!document.querySelector('#roam-right-sidebar-content');

let stop = null;

async function start(extensionAPI) {
  const api = window.roamAlphaAPI;
  const graph = api.graph ?? {};
  const store = createStore(`${graph.type ?? 'hosted'}:${graph.name ?? location.hash.split('/')[2] ?? ''}`);
  let stopped = false, timer = null, last = null, observer = null;
  const log = createLog(api);
  const logging = () => !!extensionAPI?.settings?.get('log');
  const titleOf = (uid) => api.data.pull('[:node/title]', [':block/uid', uid])?.[':node/title'] ?? null;

  const current = () => ({ open: sidebarOpen(), windows: readWindows(api.ui.rightSidebar) });
  const check = () => {
    timer = null;
    if (stopped) return;
    let now;
    try { now = current(); } catch { return; }
    if (sameState(now, last)) return;
    if (logging()) {
      try { log.add(changes(last.windows, now.windows, titleOf)); } catch (e) { console.warn(TAG, 'could not log:', e?.message ?? e); }
    }
    last = now;
    store.save({ ...now, t: Date.now() });
  };
  const schedule = () => { if (!timer && !stopped) timer = setTimeout(check, SAVE_DELAY); };
  const flush = () => { if (timer) { clearTimeout(timer); check(); } };

  stop = () => {
    stopped = true;
    observer?.disconnect();
    if (timer) clearTimeout(timer);
    window.removeEventListener('beforeunload', flush);
    store.close();
  };

  // Give Roam a moment to put back its own pinned windows first, so they are not added twice.
  await sleep(500);
  if (stopped) return;
  const saved = await store.load();
  if (stopped) return;
  if (saved) {
    try { await restore(api, saved); } catch (e) { console.warn(TAG, 'could not restore the sidebar:', e?.message ?? e); }
    await sleep(300);
  }
  if (stopped) return;
  last = current();
  store.save({ ...last, t: Date.now() });

  // Any change to the sidebar (a window opened, closed, moved, collapsed or pinned, or the sidebar
  // opened or closed) changes the page, so watch the page and compare after it settles.
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', flush);
}

function settingsPanel(extensionAPI) {
  extensionAPI?.settings?.panel?.create({
    tabTitle: 'Persistent Sidebar',
    settings: [{
      id: 'log',
      name: 'Sidebar log',
      description: `Add every window opened in or closed from the right sidebar to the page ${LOG_PAGE}, with the time.`,
      action: { type: 'switch' },
    }],
  });
}

export default {
  onload: ({ extensionAPI } = {}) => {
    settingsPanel(extensionAPI);
    start(extensionAPI).catch((e) => console.warn(TAG, e?.message ?? e));
  },
  onunload: () => { stop?.(); stop = null; },
};
