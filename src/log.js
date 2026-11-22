// The optional sidebar log: every window opened in or closed from the right sidebar, written to a Roam
// page as it happens. One block per day, linked to that day's daily note, then one block per change with
// the time, worded like the window headers in Roam's sidebar.
import { windowKey } from './sidebar.js';

export const LOG_PAGE = 'Sidebar Log';

/** What a window shows, in Roam's words: [[Page]], ((block)), References to: [[Page]], ... */
export function describeWindow(w, titleOf) {
  if (w.type === 'search-query') return `Search: ${w.query}`;
  const title = titleOf(w.uid);
  const ref = title != null ? `[[${title}]]` : `((${w.uid}))`;
  if (w.type === 'mentions') return `References to: ${ref}`;
  if (w.type === 'graph') return `Graph of ${ref}`;
  return ref;
}

/** The windows opened and closed between two saved states, as log lines. */
export function changes(before, after, titleOf) {
  const was = new Set(before.map(windowKey)), is = new Set(after.map(windowKey));
  return [
    ...after.filter((w) => !was.has(windowKey(w))).map((w) => `Opened ${describeWindow(w, titleOf)}`),
    ...before.filter((w) => !is.has(windowKey(w))).map((w) => `Closed ${describeWindow(w, titleOf)}`),
  ];
}

const pad = (n) => String(n).padStart(2, '0');

/** Appends lines to the log page, under today's block. Writes run one after another. `pageTitle`
 *  gives the page to write to at the time of each write, so a change in settings takes effect at once. */
export function createLog(api, pageTitle = () => LOG_PAGE) {
  let queue = Promise.resolve();
  const q = (query, ...args) => api.data.q(query, ...args);
  async function write(lines, when) {
    const title = (pageTitle() ?? '').trim() || LOG_PAGE;
    let page = q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
    if (!page) {
      page = api.util.generateUID();
      await api.data.page.create({ page: { title, uid: page } });
    }
    const day = `[[${api.util.dateToPageTitle(when)}]]`;
    const kids = q('[:find ?u ?s ?o :in $ ?p :where [?pp :block/uid ?p] [?pp :block/children ?b] [?b :block/uid ?u] [?b :block/string ?s] [?b :block/order ?o]]', page)
      .sort((a, b) => a[2] - b[2]);
    let dayUid = kids.length && kids[kids.length - 1][1] === day ? kids[kids.length - 1][0] : null;
    if (!dayUid) {
      dayUid = api.util.generateUID();
      await api.data.block.create({ location: { 'parent-uid': page, order: 'last' }, block: { string: day, uid: dayUid } });
    }
    const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
    for (const line of lines) await api.data.block.create({ location: { 'parent-uid': dayUid, order: 'last' }, block: { string: `${time} ${line}` } });
  }
  return {
    add(lines, when = new Date()) {
      if (!lines.length) return queue;
      queue = queue.then(() => write(lines, when)).catch((e) => console.warn('[persistent-sidebar] could not write the sidebar log:', e?.message ?? e));
      return queue;
    },
  };
}
