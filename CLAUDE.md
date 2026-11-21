# roam-persistent-sidebar

Roam Research extension "Persistent Sidebar": saves every right-sidebar window (order, collapsed, pinned,
sidebar open/closed) per graph on the device and restores it when Roam starts. Successor to
sweenzor/roam-autopin. Optional sidebar log writes opened/closed windows to the page "Sidebar Log".

## Build and test

```
npm install
npm test         # node --test, fake roamAlphaAPI
npm run build    # esbuild src/index.js -> dist/extension.js (load dist/ as a Roam Depot developer extension)
DISPLAY=:99 node test/real-roam/run.mjs   # real Roam desktop app; ROAM_EMAIL/ROAM_PASSWORD to sign in, else public help graph
```

## Layout

- `src/sidebar.js` pure read/restore logic over `roamAlphaAPI.ui.rightSidebar`.
- `src/store.js` localStorage + IndexedDB (strict durability, survives SIGKILL); newer copy wins.
- `src/log.js` sidebar log page writer.
- `src/index.js` lifecycle, MutationObserver on body -> debounced compare and save, settings panel.

## Roam API notes

- `addWindow` puts the window at the top and opens the sidebar. `getWindows` reports `page-uid` for
  outline/mentions/graph of a page, `mentions-uid` for mentions of a block, `search-query-str` for search;
  all are added back with `block-uid` (or `search-query-str`).
- Sidebar open = `#roam-right-sidebar-content` exists. Windows survive `close()`.
- In the public help graph nothing in the sidebar survives a restart, pinned or not.
