# Persistent Sidebar

Everything in your right sidebar comes back after you restart Roam.

Roam forgets the right sidebar when you quit or reload, unless you pin each window. Persistent Sidebar keeps
every window that's open there, in the same order, and puts them back the next time you open the graph. That
covers pages, blocks, mentions, graph views and searches. Windows you collapsed come back collapsed, windows
you pinned stay pinned, and if you had the sidebar closed it stays closed.

Nothing is pinned for you, and nothing is written to your graph unless you turn on the sidebar log. If a page
or block in the sidebar was deleted in the meantime, its window is left out.

Turn the extension off to go back to Roam's normal sidebar.

## Sidebar log

Turn on **Sidebar log** in the Persistent Sidebar settings tab to keep a record of everything you open in
and close from the right sidebar. Each one is added to the page **Sidebar Log** with the time, under a block
for the day, like `14:05 Opened [[Project X]]` or `14:20 Closed References to: [[Project X]]`. Because the
entries link to the pages and blocks, those pages list the log in their Linked References. It's off unless
you turn it on.

## Limitations

The sidebar is kept on the computer you're using, separately for each graph. It doesn't follow you to another
computer or browser: each one keeps its own sidebar for the graph, and a computer you haven't used the graph
on starts with Roam's normal sidebar. Clearing Roam's site data on a computer clears the saved sidebar there.

## Coming from Autopin

Persistent Sidebar replaces [Autopin](https://github.com/sweenzor/roam-autopin), which kept the sidebar by
pinning every window. Turn Autopin off when you turn this on. Windows Autopin pinned stay pinned until you
unpin them.
