---
status: historical
created: 2026-07-27
archived: 2026-07-27
reason: "Investigation record: paging the agent-sessions debug table exhausts the browser runtime's heap."
---

# Paging the session table exhausts the browser heap

Clicking **Next** on the Sessions tab of the agent-sessions debug view a dozen
or so times kills the browser tab. That view and its host were under
development on a separate branch, so the packages this record names are not in
this tree; the runner fixes the investigation produced are. This document records how the failure was
reproduced, what was measured, and which explanations the measurements rule
out. It is a record of one investigation on one machine, not a description of
the current system.

## Environment

- The debug host published 716 sessions from two sources (`codex-app-server`
  and `claude-agent-sdk`) into a single space.
- The Sessions tab shows 20 rows per page, so the table had 36 pages. The
  pattern projects a window of the current page plus the page on either side.
- The shell ran against a local Toolshed. The runtime, as always in the shell,
  ran in a web worker, so the growth reported below is the worker's isolate,
  not the page's.

## What happens

The tab's renderer process grows by roughly a quarter of a gigabyte per page
change until the process dies. Three runs, each starting from a freshly loaded
view:

| Run | Interaction | Start | End | Outcome |
| --- | ----------- | ----- | --- | ------- |
| 1 | Click Next repeatedly | 1.24 GB | 4.85 GB | Renderer process died after about 15 page turns, 137 seconds in |
| 2 | Alternate Next and Previous between pages 1 and 2 | 2.01 GB | 4.53 GB | Renderer process died after about 30 page changes, 99 seconds in |
| 3 | Click the Title sort header 40 times | 1.52 GB | 1.9 GB | Survived; memory levelled off |

The figures are resident set size of the tab's renderer process, sampled from
outside the browser every two or three seconds. The main thread's own heap
stayed between 16 MB and 19 MB throughout every run, so all of the growth is
in the worker that hosts the runtime.

Run 2 is the important one. Alternating between the same two pages shows the
same fatal growth as walking forward through all 36. The rows are the same 20
sessions over and over, so the growth is not the cost of reaching new session
data. It is the cost of the window changing at all.

Run 3 is the control. Sorting re-renders the same 20 rows and does not move
the projection window: no element runs are retired or started. That case is
stable, which places the growth in the window change rather than in rendering
or in reading the rows.

The host process has the same problem from the other side. During this
investigation the `agents-host` process itself died with
`Fatal JavaScript out of memory: Ineffective mark-compacts near heap limit`
after a periodic collection, having grown to about 5 GB resident and a 4 GB
heap. That is a separate failure from the browser one and was not investigated
further.

## What the growth is not

Each of these was measured while alternating between pages 1 and 2, the
interaction that kills the tab in run 2.

**Not scheduler nodes.** `getGraphSnapshot()` reports the live scheduler graph.
Across ten page changes it oscillated between exactly 5551 and 6811 nodes, and
between 13454 and 14094 edges, returning to the same numbers each time the same
page came back. Element runs are being registered and unregistered correctly.
Meanwhile resident memory rose from 1.84 GB to 2.77 GB.

**Not new stored documents.** Ten page changes added 10 entities and 115
commits to the space — the per-session view state, and nothing more. The map
coordinator reuses its element result documents, as intended. Resident memory
over the same ten changes rose from 2.77 GB to 3.87 GB.

**Not the client's document cache.** Instrumenting the storage provider's
document map showed it settling at about 3273 documents and staying there
across page changes. The per-document pending-version list and materialized
prefix cache never held more than one entry each.

So the retained memory is not a structure whose size these counters report. It
is retained values: object graphs derived from documents that outlive the
element runs that produced them.

## A separate finding: the table loads every session

The same instrumentation showed what the client holds after the Sessions tab
first renders, with only two pages' worth of rows on screen:

```
docs=2769  716×[chunks,complete,driver,formatVersion]
           716×[active,archived,capabilities,contentHash]
           444×[string] 121×[/] 90×[children,name,props,type] 86×[$stream]
```

The first group is every session manifest in the space. The second is every
session row. All 716 of each are resident after the first render, though the
window projects 40 rows. Native event chunks are not pulled, so the manifests'
own contents stay behind their links, but the manifests themselves are all
there. The pattern's README describes the table as reaching only the rows in
its window; that is not what the client ends up holding.

This alone accounts for a large fixed cost — the view sits at 1.2 GB to 2 GB
before any paging — but it does not explain the per-page-change growth, since
run 2 revisits sessions whose manifests are already resident.

## Reproducing it

1. Publish a few hundred sessions into a space with `deno task agents-host`,
   so the Sessions tab has many pages.
2. Open the debug piece in the shell and select the Sessions tab.
3. Click Next repeatedly, or alternate Next and Previous, waiting for the view
   to settle between clicks.
4. Watch the resident size of the tab's renderer process from outside the
   browser. The tab dies between 4.5 GB and 4.9 GB.

The waiting in step 3 was done with `commonfabric.viewSettled()`, which
resolves when the worker is idle and the rendered view has drained.

## Where to look next

The measurements point at values retained past the end of an element run,
somewhere between the map coordinator's child release and the storage layer's
materialized values. A useful next step is a headless harness: drive the same
piece from a Deno runtime against the same Toolshed, alternate the page the
same way, and force a full garbage collection between changes. That
distinguishes memory that is genuinely reachable from garbage the browser's
collector has not reclaimed, and it gives a place to bisect that does not need
a browser. A synthetic harness — a sliding window over a list of cells, each
row projecting a child pattern that holds a link to a large document, against
an in-process memory server — did not reproduce the growth, so whatever is
retained depends on something that harness lacked.
