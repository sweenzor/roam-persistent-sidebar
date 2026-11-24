// Pure helpers for reading, comparing and restoring Roam's right sidebar through roamAlphaAPI.
// Nothing here touches storage or the DOM, so it runs under node --test with a fake API.

/** The uid a sidebar window points at, or null for a search window. */
export function targetUid(w) {
  return w['block-uid'] ?? w['page-uid'] ?? w['mentions-uid'] ?? null;
}

/** Identity of a window: the same page opened as an outline and as its mentions are two windows. */
export function windowKey(w) {
  return w.type === 'search-query' ? `search-query:${w['search-query-str'] ?? w.query ?? ''}` : `${w.type}:${w.uid ?? targetUid(w)}`;
}

/** What we keep for one window. */
export function toSaved(w) {
  const s = { type: w.type, collapsed: !!w['collapsed?'], pinned: !!w['pinned?'] };
  if (w.type === 'search-query') s.query = w['search-query-str'] ?? '';
  else s.uid = targetUid(w);
  return s;
}

/** The sidebar's windows in display order, as saved records. */
export function readWindows(sidebar) {
  return [...(sidebar.getWindows() ?? [])].sort((a, b) => a.order - b.order).map(toSaved).filter((w) => w.type && (w.uid || w.type === 'search-query'));
}

/** The `window` argument roamAlphaAPI.ui.rightSidebar.* takes for a saved window. */
export function apiWindow(s) {
  return s.type === 'search-query' ? { type: s.type, 'search-query-str': s.query } : { type: s.type, 'block-uid': s.uid };
}

export const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Puts the saved windows back, in their saved order, collapsed and pinned as they were, then opens or
 * closes the sidebar to match. Windows that are open already (Roam puts pinned ones back itself) stay
 * open and are moved into place with setWindowOrder: nothing is ever taken out of the sidebar, so a
 * step that fails loses nothing. Windows whose page or block no longer exists are skipped. Windows that
 * are open now and were not saved stay, below the restored ones.
 *
 * Every call to Roam is tried on its own: one that fails is noted in `failed` and the rest still run.
 * `cancelled` is asked before each call; once it says yes nothing more is done. The caller keeps the
 * old save unless `ok` is true. Running it again is safe: it only does what is still missing.
 */
export async function restore(api, saved, { exists, cancelled = () => false } = {}) {
  const sb = api.ui.rightSidebar;
  const has = exists ?? ((uid) => !!api.data.pull('[:block/uid]', [':block/uid', uid]));
  const wanted = (saved.windows ?? []).filter((s) => s.type === 'search-query' ? !!s.query : !!s.uid && has(s.uid));
  const failed = [];
  const result = () => ({ count: wanted.length, failed, cancelled: cancelled(), ok: !failed.length && !cancelled() });
  /** One call to Roam. False when it failed or the restore was cancelled first. */
  const step = async (what, w, call) => {
    if (cancelled()) return false;
    try { await call(); return true; } catch (e) { failed.push({ step: what, window: w ? windowKey(w) : null, error: e?.message ?? String(e) }); return false; }
  };
  const keysNow = () => readWindows(sb).map(windowKey);

  // Add what is missing. addWindow puts a window at the top, so add the last one first.
  const open = new Set(keysNow());
  for (const w of [...wanted].reverse()) {
    if (!open.has(windowKey(w))) await step('add', w, () => sb.addWindow({ window: apiWindow(w) }));
  }
  // Move the saved windows that are open to the top, in their saved order.
  const present = new Set(keysNow());
  const inOrder = wanted.filter((w) => present.has(windowKey(w)));
  for (const [i, w] of inOrder.entries()) {
    if (keysNow()[i] !== windowKey(w)) await step('order', w, () => sb.setWindowOrder({ window: { ...apiWindow(w), order: i } }));
  }
  if (!cancelled() && inOrder.some((w, i) => keysNow()[i] !== windowKey(w))) failed.push({ step: 'order', window: null, error: 'the windows did not end up in the saved order' });

  const now = new Map(readWindows(sb).map((w) => [windowKey(w), w]));
  for (const w of wanted) {
    const cur = now.get(windowKey(w));
    if (!cur) continue;
    if (w.collapsed && !cur.collapsed) await step('collapse', w, () => sb.collapseWindow({ window: apiWindow(w) }));
    if (!w.collapsed && cur.collapsed) await step('expand', w, () => sb.expandWindow({ window: apiWindow(w) }));
    if (w.pinned && !cur.pinned) await step('pin', w, () => sb.pinWindow({ window: apiWindow(w) }));
  }
  if (saved.open === false) await step('close', null, () => sb.close());
  else if (saved.open && wanted.length) await step('open', null, () => sb.open());
  return result();
}
