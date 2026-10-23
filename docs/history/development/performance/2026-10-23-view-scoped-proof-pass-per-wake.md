---
status: historical
created: 2026-10-23
archived: 2026-10-23
reason: "Why a view-scoped web client proves each producer once per wake rather than once per adopted computation, and why the planner's cone selection indexes visible edits by the entity they write: on one rendered lunch vote at 296 votes the browser's runtime worker spent 1.4 s applying frames, which the proof pass took to 263 ms. Measured on the served-vote branch (#9122) before the change was split out to land on its own."
---

# One proof pass per wake in a view-scoped web client

This change was made and measured on the served-vote branch
(commonfabric/labs#9122), and split out of it to land on its own. The code is
the same on both.

## How it was measured

On #9122's branch, at `3f7822bb6` against its parent `a2fbdfc37`. That branch
can run the serving loop in a worker, and the arm measured did: the store
read-through on, the overlap off, the flush deadline growing to a 1000 ms cap,
and `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION` on. The change itself runs in
the browser's runtime worker, whichever thread serves the space. Every run
used a toolshed and shell built from source, on a four-core container.

A probe kept out of the tree seeded the lunch poll's read-scale fixture at 296
votes, warmed one viewer, and diffed the browser runtime worker's timing
statistics (`rt.getLoggerCounts()`) around four timed votes.

## What one vote cost the browser

Per vote, the browser's runtime worker spent 5.25 × 267 ms applying frames and
6.25 × 160 ms executing. Every accepted plan, and every change of local
coverage, revalidated every adopted computation, and each computation's proof
walked its whole producer ancestry on its own: it matched every basis value,
checked its piece's source, and then resubscribed the computation even when
nothing it proved had changed. The plan carried 973 producers with 8,478 read
fingerprints.

## The change

A wake now runs one proof pass. Within it each producer is proved once, each
basis value matched once and each source checked once, for every adopted node
that reaches them, and nothing the pass does changes the replica or the plans.
A node whose proof observed what its previous proof did keeps the dependencies
and write surface that proof installed, without a resubscribe.

The planner's cone selection tested each ancestor's reads against every edit a
visible handler can make. It now indexes those edits by the entity they write,
as the graph's own writer index does. `view-replication.bench.ts` gained a
1000-row cone selection to measure it.

## Measured

| Per vote, in the browser's runtime worker | Before | After |
| --- | ---: | ---: |
| Applying frames | 1.4 s | 263 ms |
| Scheduler execution | 1.0 s | 284 ms |
| Event-loop lag | 3.75 × 689 ms | 4.75 × 80 ms |
| The four timed votes | 1.8, 3.1, 4.6, 1.8 s | 0.7, 1.7, 1.4, 1.6 s |

On #9122's branch the 1000-row cone selection read 67 ms before and 9.3 ms
after. Off `main`, with only the bench added, it read 69.4 and 79.8 ms against
12.7 and 15.5 ms with the change, in two alternating rounds; at 300 rows, 7.3
and 10.6 ms against 3.2 and 3.9 ms.

The vote's end-to-end time carries the serving loop's work as well, which is
#9122's, so only the browser's rows above describe this change alone.
