// Persistent Sidebar: keeps every window in Roam's right sidebar, with its order and whether it is
// collapsed or pinned, and whether the sidebar is open, and puts them all back when Roam starts again.
import { readWindows, restore, sameState } from './sidebar.js';
import { createStore } from './store.js';
import { changes, createLog, LOG_PAGE } from './log.js';

const TAG = '[persistent-sidebar]';
const SAVE_DELAY = 300;
const RESTORE_TRIES = 3, RESTORE_RETRY_DELAY = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sidebarOpen = () => !!document.querySelector('#roam-right-sidebar-content');

let stop = null;

async function start(extensionAPI) {
  const api = window.roamAlphaAPI;
  const graph = api.graph ?? {};
  const store = createStore(`${graph.type ?? 'hosted'}:${graph.name ?? location.hash.split('/')[2] ?? ''}`);
  let stopped = false, timer = null, last = null, observer = null;
  const log = createLog(api, () => extensionAPI?.settings?.get('log-page'));
  const logging = () => !!extensionAPI?.settings?.get('log');
  const titleOf = (uid) => api.data.pull('[:node/title]', [':block/uid', uid])?.[':node/title'] ?? null;

  const current = () => ({ open: sidebarOpen(), windows: readWindows(api.ui.rightSidebar) });
  const save = (state) => store.save({ ...state, t: Date.now() });
  const check = ({ quiet = false } = {}) => {
    timer = null;
    let now;
    try { now = current(); } catch { return; }
    if (sameState(now, last)) return;
    if (!quiet && logging()) {
      try { log.add(changes(last.windows, now.windows, titleOf)); } catch (e) { console.warn(TAG, 'could not log:', e?.message ?? e); }
    }
    last = now;
    save(now);
  };
  const schedule = () => { if (!timer && !stopped) timer = setTimeout(check, SAVE_DELAY); };
  const flush = () => { if (timer) { clearTimeout(timer); check(); } };

  stop = () => {
    if (stopped) return;
    observer?.disconnect();
    window.removeEventListener('beforeunload', flush);
    // A change still waiting out the delay is saved now. It is not logged: nothing is written to the
    // graph once the extension is unloaded, and log lines still waiting are dropped.
    if (timer) { clearTimeout(timer); check({ quiet: true }); }
    stopped = true;
    log.stop();
    store.close(); // after the save above is written; also closes a connection that is still opening
  };

  // Give Roam a moment to put back its own pinned windows first, so they are not added twice.
  await sleep(500);
  if (stopped) return;
  const saved = await store.load();
  if (stopped) return;
  let restored = true;
  if (saved) {
    // A step that fails (Roam not ready yet, say) is tried again; restore only does what is missing.
    for (let attempt = 1; attempt <= RESTORE_TRIES && !stopped; attempt++) {
      let result;
      try { result = await restore(api, saved, { cancelled: () => stopped }); } catch (e) { result = { ok: false, failed: [{ step: 'restore', error: e?.message ?? String(e) }] }; }
      restored = result.ok;
      if (restored || stopped) break;
      console.warn(TAG, `could not restore the sidebar (try ${attempt} of ${RESTORE_TRIES}):`, result.failed.map((f) => `${f.step}${f.window ? ` ${f.window}` : ''}: ${f.error}`).join('; '));
      if (attempt < RESTORE_TRIES) await sleep(RESTORE_RETRY_DELAY);
    }
    await sleep(300);
  }
  if (stopped) return;
  last = current();
  // Only a sidebar that came back whole replaces the save. After a restore that failed the old save
  // stays as it is, for the next start, until the sidebar is next changed by hand.
  if (restored) save(last);

  // Any change to the sidebar (a window opened, closed, moved, collapsed or pinned, or the sidebar
  // opened or closed) changes the page, so watch the page and compare after it settles.
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', flush);
}

function settingsPanel(extensionAPI) {
  extensionAPI?.settings?.panel?.create({
    tabTitle: 'Persistent Sidebar',
    settings: [
      {
        id: 'log',
        name: 'Sidebar log',
        description: 'Add every window opened in or closed from the right sidebar to the sidebar log page, with the time.',
        action: { type: 'switch' },
      },
      {
        id: 'log-page',
        name: 'Sidebar log page',
        description: 'The page the sidebar log is added to.',
        action: { type: 'input', placeholder: LOG_PAGE },
      },
    ],
  });
}

export default {
  onload: ({ extensionAPI } = {}) => {
    settingsPanel(extensionAPI);
    start(extensionAPI).catch((e) => console.warn(TAG, e?.message ?? e));
  },
  onunload: () => { stop?.(); stop = null; },
};
