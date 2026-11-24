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

## Releasing to Roam Depot

Before every release: each feature has a section and a screenshot in `README.md`, and the screenshots are
retaken for that release. Run the Screenshots workflow on the release branch (`test/real-roam/screenshots.mjs`,
signed in to the test graph): it commits the pictures to `docs/images` and points the README's image links at
that commit. A new feature needs a new picture in that script. Then bump `source_commit` in the Depot listing
(`extensions/sweenzor/roam-persistent-sidebar.json` in the fork sweenzor/roam-depot) to the merged commit on `main`.

## Layout

- `src/sidebar.js` pure read/restore logic over `roamAlphaAPI.ui.rightSidebar`.
- `src/store.js` localStorage + IndexedDB (strict durability, survives SIGKILL); newer copy wins.
- `src/log.js` sidebar log page writer.
- `src/index.js` lifecycle, MutationObserver on body -> debounced compare and save, settings panel.

## Rules from Roam's Depot review (#1552, 2026-11-24)

- Restore never takes a window out of the sidebar: it adds what is missing and moves open windows with
  `setWindowOrder`. Every call to Roam is tried on its own, and the save is only replaced after a restore
  where every step worked (`restore()` returns `ok`); `index.js` tries up to three times.
- Text the user typed (search queries) goes into the log as inline code (`plain()` in `src/log.js`), never
  as Roam markup. A search closed and a search opened in the same change is one window being typed in,
  and is not logged.
- Unload (`stop` in `src/index.js`): a change still waiting out the 300 ms is saved, not logged; a running
  restore stops at its next step; log lines still waiting are dropped; the IndexedDB connection is closed
  after the last save, also one still opening (`src/store.js` keeps one open promise).

## Roam API notes

- `addWindow` puts the window at the top and opens the sidebar. `getWindows` reports `page-uid` for
  outline/mentions/graph of a page, `mentions-uid` for mentions of a block, `search-query-str` for search;
  all are added back with `block-uid` (or `search-query-str`).
- Roam brings its pinned windows back itself a moment after the graph opens (later than the extension's
  own restore, measured in desktop 0.0.43). Adding a page or block that is open already changes nothing
  (`window-id` is `sidebar-<type>-<uid>`), but every `addWindow` of a search makes a new window
  (`sidebar-search-query-uuid…`). So a pinned search is left to Roam for 8 s (`PINNED_WAIT`) before it is added.
- Sidebar open = `#roam-right-sidebar-content` exists. Windows survive `close()`.
- In the public help graph nothing in the sidebar survives a restart, pinned or not.

## Test account plan

Real-Roam CI signs in to a Roam test account with a Believer plan (without a plan its local graphs are read-only). Each signed-in real-Roam run (`test/real-roam/run.mjs`) reads the plan from Roam's Billing page with `test/real-roam/plan.mjs` (account menu > Billing on the graph list, else Settings > Account > Open Billing) and fails if it isn't Believer or ends within a year.
