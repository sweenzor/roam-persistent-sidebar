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
 * closes the sidebar to match. Windows Roam already restored itself (pinned ones) are taken out and added
 * again so the order comes out right. Windows whose page or block no longer exists are skipped.
 * Windows that are open now and were not saved stay, below the restored ones.
 */
export async function restore(api, saved, { exists } = {}) {
  const sb = api.ui.rightSidebar;
  const has = exists ?? ((uid) => !!api.data.pull('[:block/uid]', [':block/uid', uid]));
  const wanted = (saved.windows ?? []).filter((s) => s.type === 'search-query' ? !!s.query : !!s.uid && has(s.uid));
  const wantedKeys = new Set(wanted.map(windowKey));
  const current = readWindows(sb);
  const already = current.filter((w) => wantedKeys.has(windowKey(w)));
  // A window Roam put back pinned stays pinned, even though it is taken out and added again below.
  const pinnedNow = new Set(already.filter((w) => w.pinned).map(windowKey));
  // Nothing to do when the saved windows already sit at the top in the right order.
  const inPlace = already.length === wanted.length && wanted.every((w, i) => windowKey(current[i] ?? {}) === windowKey(w));
  if (!inPlace) {
    for (const w of already) await sb.removeWindow({ window: apiWindow(w) });
    // addWindow puts a window at the top, so add the last one first.
    for (const w of [...wanted].reverse()) await sb.addWindow({ window: apiWindow(w) });
  }
  const now = new Map(readWindows(sb).map((w) => [windowKey(w), w]));
  for (const w of wanted) {
    const cur = now.get(windowKey(w));
    if (!cur) continue;
    if (w.collapsed && !cur.collapsed) await sb.collapseWindow({ window: apiWindow(w) });
    if (!w.collapsed && cur.collapsed) await sb.expandWindow({ window: apiWindow(w) });
    if ((w.pinned || pinnedNow.has(windowKey(w))) && !cur.pinned) await sb.pinWindow({ window: apiWindow(w) });
  }
  if (saved.open === false) await sb.close();
  else if (saved.open && wanted.length) await sb.open();
  return wanted.length;
}
