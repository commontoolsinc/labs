---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Point-in-time record of where a served vote's time goes, measured on the lunch poll's vote burst with every client rendering the poll: the per-viewer fan-out of derivations downstream of a viewer read and the pattern change that removes it, the client arm measured with rendered views rather than data alone, and the engine's cost on each arm, in the memory server's per-session walks and frame encodes and in the scheduler's bookkeeping around the pattern's own code."
---

# A served vote costs one run per viewer, and a viewed vote costs the server a walk per viewer

All figures come from one 4-core container, at the code of
[commonfabric/labs#8691](https://github.com/commonfabric/labs/pull/8691)
after the serving-cycle plan closed
([the previous record](2026-10-11-serving-cycle-local-quiescence.md)). That
record left the 25-vote burst an order of magnitude above the client arm and
placed the remainder in what a vote re-derives on the serving side. This one
says what that is, what a pattern change does to it, what the client arm costs
once its clients render the poll rather than hold its data, and where the
engine's time goes on each arm. The last section says how each number was
taken.

## The measured window, first

The burst's clock used to stop at the voters' idle, their events' consequences
and the harness's settle, and on the OFF arm that is before the other voters'
pushed votes have reached a client. It now stops when every session's own vote
list, read at its runtime's quiescence and woken by the list's own changes,
holds exactly the round's rows, each voter's vote on each option at the value
cast this round: the moment each client's view is settled, on either arm. A
list that still holds a stale row never matches, however the counts come out,
so the window cannot close early on a partial delivery.

Under that window, five voters and five options, the poll as shipped, each
client holding the harness's default watch on the piece's result and no
rendered view:

| arm | burst, avg | range |
| --- | --- | --- |
| OFF | 445 ms | 350 to 800 ms, over two runs |
| ON, worker, read-through | 8.1 s | 6.6 to 8.8 s |
| ON, main thread, read-through | 10.6 s | 9.4 to 11.8 s |

The OFF figure answers a narrower question than it seems to. Those clients
ran nothing but their two sinks and five handlers per burst, since nothing on
them demanded the poll's view: with the loop off, a client derives only what
something on it reads, and the harness read the vote list. The ON arms, by
contrast, derived the whole view for every session, because a session's
demand on the server is the closure of the documents its watches reach. So
445 ms is the time for every client's data to be current, with no view work
on the client side, and the sections after the next take up the comparison
with the clients rendering. The ON arms sit where the previous record left
them; what follows is why.

## Where the serving thread's time goes

One burst on the main-thread arm with the read-through on, every timing span
the loop's realm emitted captured (44,388 spans over 14.7 s; the clients are
workers, so the realm is the serving runtime and the memory server):

| what | wall time, as a union of its spans |
| --- | --- |
| the whole burst | 14.7 s |
| node runs (`scheduler/run`, 695 of them: one node over all its demanded instances) | 8.6 s |
| of which instance runs (`scheduler/run/action`, 2,175) | 5.1 s |
| of which re-subscription after a run (2,870) | 1.8 s |
| the memory server's fan-out to the five clients, on the same thread | 3.3 s |
| wave commits (91) | 1.5 s |

Per vote: 87 instance runs over 28 node runs, with 5 wave commits
interleaved as the 100 ms deadline cuts the settle. The traversals on this
thread are cheap and many (13,452 at 0.06 ms, 88% of them the memory server
re-walking a client subscription; the longest 12 ms), and the client is nearly
idle: one voter's realm emitted 1,101 spans over the same burst, 4.6 s of them
in its scheduler, 83 traversals in all with the longest at 66 ms inside a
handler's dependency pull. The 100 to 340 ms walks the previous records saw
were the serving runtime's own loads under the posture without the
read-through, and under the read-through they are on neither thread.

## The 87 runs: one per viewer

Grouping the instance spans by the node run they ran in, each of the hot nodes
runs five instances within one run under five voters and three under three,
whatever the option count:

| size (voters × options) | instance runs per vote | node runs per vote | instances of one node within a run |
| --- | --- | --- | --- |
| 5 × 5 | 87.0 | 27.8 | 5 (370 such groups), or 1 (325) |
| 3 × 5 | 58.2 | 28.1 | 3 (226), or 1 (195) |
| 5 × 3 | 72.7 | 24.9 | 5 (179), or 1 (195) |

That is the fan-out the specification states
([`docs/specs/server-side-execution/scopes.md`](../../../specs/server-side-execution/scopes.md)
§2): a derivation that reads a per-user value has one instance per demanding
user, one that reads a per-session value has one per demanding session, the
serving loop computes everyone's, and the scheduler's fan-out loop runs each
demanded instance in turn. Each voter here is one user with one session, so
the copies count the same at either scope: one per voter. The client arm never
meets it: each client computes only its own instance, and the poll's own
single-runtime test handles a vote in four node runs.

What put the poll's whole graph on that path is one argument. `tallyOption`
took the viewer's profile to mark which vote in a tally is the viewer's own
(`isSelf` on each voter row), so the five option tallies were per-viewer, the
ranking over them was per-viewer, each card's rank and swatches were
per-viewer, and every one of them ran for every voter on every vote. The nodes
that ran five instances per run were exactly the tally, the ranking, each card's
rank, the option-card map and the cards' own lifts.

## The change

Two copies of the poll were measured the same way on the same thread before
the pattern was changed:

| poll | runs per vote | five-copy groups per burst | action time per burst | probe burst |
| --- | --- | --- | --- | --- |
| as shipped | 87.0 | 370 | 5.1 s | 14.7 s |
| tallies without the viewer (the marker dropped) | 30.5 | 25 | 1.7 s | 7.0 s |
| tallies without the viewer, the marker decided at the leaf | 34.7 | 63 | 1.9 s | 6.5 s |

The third row is the shape the pattern now has, with one difference: the
copy compared a key string the row carried with a key the viewer's profile
yielded, and the pattern compares the row's voter cell with the viewer's
profile cell by `equals`, in a `computed` at the swatch: the key comparison
did not ring the viewer's swatch in the poll's own test, and `equals`, which
the marker used before, does. The tally rows carry the voter cell and nothing of the viewer, so
the tally, the ranking and each card's rank are one derivation each; what runs
per viewer is the swatch's comparison. The burst under the measured window,
the pattern as it now is:

| arm | burst, avg | range | waves (cut) | scheduler settle per event |
| --- | --- | --- | --- | --- |
| OFF | 463 ms | 400 to 550 ms | — | — |
| ON, worker, read-through | 3.7 s | 3.1 to 4.3 s | 17 (15) | 50 ms |
| ON, main thread, read-through | 4.8 s | 4.5 to 6.1 s | 36 (34) | 72 ms |

The OFF arm does not move, since its clients derived no view. The served
burst halves and more: 8.1 s to 3.7 s under the worker, 10.6 s to 4.8 s on
the main thread, the waves per burst from 36 to 17 under the worker, and the
derivations the scheduler runs after each vote's handler from 150 to 300 ms
down to 50 to 72 ms.

The rule this leaves behind is in `docs/common/patterns/multi-user-patterns.md`
under "Keep the viewer out of shared derivations", and the pattern-dev and
pattern-critic skills point at it: a shared derivation that reads the viewer
is one derivation per viewer, per user or per session by what it read,
wherever a server derives it for everyone, so the viewer belongs at the leaf
that needs it.

## The client arm, with the clients rendering

A browser tab does not hold the vote list; it holds the poll's view, and the
view's derivations run wherever the tab's demand reaches. The multi-runtime
harness now gives a session that: `renderView` mounts the worker reconciler's
recursive demand over the piece's `$UI` for the session's life, its operations
discarded, which is the demand graph a mounted renderer installs (it is what
`cf test` mounts to materialize a step's view). The benchmark's fixture shows
the poll's own view under `renderPoll`, the benchmark's voters hold it and
nothing else (no watch on the result root, which a browser does not have
either), and the measured window is unchanged: every client's vote list at its
quiescence, which with the view demanded is after the view's derivations.

| arm | burst, avg | range | rejected commits and rolled-back writes per burst |
| --- | --- | --- | --- |
| OFF | 3.0 s | 2.3 to 4.4 s | 648 and 905 |
| ON, worker, read-through | 4.3 s | 3.9 to 4.8 s | 0 and 0 |
| ON, main thread, read-through | 6.5 s | 6.0 to 7.2 s | 0 and 0 |

The OFF arm is six and a half times its data-only figure, and the served arms
are within one and a half times of it under the worker. Two things the OFF
clients do that the data-only ones did not: each derives the poll's view, 32
instance runs per vote on each client, and each writes what it derived, since
with the loop off a client's derivations are its commits. Five clients
deriving the same space-scoped documents write the same documents, and the
server refuses all but the first of each: 648 rejected commits and 905
rolled-back writes per burst of 25 votes, where the data-only burst had none
and the served arms have none.

What the OFF arm then waits on is the memory server. With the serving loop
off, the server's thread holds nothing but the memory server, and over a 2.9 s
burst it spent 1.56 s walking sessions' tracked documents (21 walks, 74 ms
each, the longest 175 ms), 1.22 s encoding frames (948 of them; 1.98 s summed,
since encodes overlap each other) and 1.28 s handling frames, which overlap
the first two. A session's walk re-traverses the view-bearing documents under
the view's schema, whose `anyOf` over vnode children is taken at every node,
so one walk visits the schema thousands of times (`slow-traverse` reports of
100 to 400 ms with 3,000 to 5,000 schema visits and 4,000 to 5,700 `anyOf`
branches each; 132 of them in one benchmark run). These are the 100 to 340 ms
walks the earlier records saw on the serving runtime's loads, now on the
clients' sessions: the read-through took them off the serving session, and
every viewing session still pays them.

The CPU profile of that thread over the burst, by file: `traverse.ts` 20%,
`engine.ts` 7% (the commits and the conflict scans behind the rejections),
`query.ts` and `graph-query.ts` 4%, `statement.ts` 4% (SQLite), `deep-freeze.ts`
3%, JSON encoding and decoding 3%, with 23% in the runtime's internals (the
collector, structured clone, the encoder); no single frame above 4%.

## Where the engine's time goes on the served arm

The main-thread arm with the read-through on, rendered views, one burst of
6.9 s, every span the thread emitted captured and unioned:

| what | union of its spans |
| --- | --- |
| serving loop cycles | 6.85 s |
| scheduler node runs (675) | 2.82 s |
| of which instance runs (876) | 1.57 s |
| of which the pattern's own code (`invokeJavaScriptImplementation`, 546) | 0.72 s |
| memory server flushes (253 session walks, 5 ms median) | 1.78 s |
| frame encodes (518) | 1.33 s |
| wave commits (50) | 0.66 s |

The pattern's own code is 0.72 s of the 6.9 s. Around it, in the scheduler:
per instance run 0.4 ms to commit the derivation's transaction (CFC flow
observation, the reactivity log, hashing), 0.5 ms to read inputs and finish,
and per node run 0.55 ms to re-subscribe the union of its instances' reads
(`sortAndCompactPaths`, the trigger-index delta) and 0.74 ms of bookkeeping
before and after its instances, of which the demand lookup that decides the
instances (`#demandersFor`) is 139 ms per burst on its own. Three quarters of
a node run is machinery, one quarter the pattern. The CPU profile by file says
the same in another way: `traverse.ts` 9%, the transaction and storage layers
(`v2-transaction.ts`, `extended-storage-transaction.ts`, `v2.ts`) 11%,
`link-resolution.ts` 3%, `reactive-dependencies.ts` 3%, `deep-freeze.ts` 2%,
CFC preparation 2%, `space-server.ts` 2%, hashing, schema validation and the
trigger index 1% each; no frame above 3%.

Beside the scheduler, the memory server's fan-out to the five viewing
sessions is 3.1 s of the same thread (walks and encodes, overlapping in part),
cheaper per walk than on the OFF arm because the served sessions receive the
view plan the loop publishes rather than re-walking what five clients wrote.
Under the worker, that fan-out is on the other thread, and what the loop pays
for it is the port: a cycle is 294 ms, of which the settle is 82 ms, the wave
commit 74 ms and the publish 74 ms, each a round trip to a main thread busy
with the fan-out.

The levers this leaves, in the order of what they cost here:

- the memory server's per-session walk of a view-bearing document under the
  view's schema, and the frame encode behind it, paid once per viewing
  session per flush on every arm, and five times over by the client arm's
  own derived writes;
- the scheduler's cost around a derivation: the per-instance commit and
  re-subscription and the per-node demand lookup, three times the pattern's
  own code on the served arm;
- the client arm's duplicate derived writes, five clients committing the
  same documents and four of them refused;
- the serving loop's port round trips under the worker, half of a cycle.

## What this says about the three questions the previous record left

- **What the runs are.** Above: fan-out across sessions of a graph whose root
  reads the viewer, times the depth of that graph.
- **Why a `scheduler/run` costs 11 to 14 ms.** It is not a pass: it is one
  node's run over every instance the demand supplies, at about 2.3 ms an
  instance plus 0.6 ms to re-subscribe the union of the instances' reads.
  Five instances of one node is 12 ms. The node runs per vote, 28, are the
  nodes a vote's change reaches and do not change with the fix; the instances
  in each do.
- **The 100 to 340 ms schema walks.** The memory server's walk of a
  view-bearing document under the view's schema for one session. The
  read-through took the serving session's walks off the serving runtime; with
  clients that hold no view, no walk on either thread exceeds 66 ms, and with
  clients that render the poll, every viewing session's walk is back, 100 to
  400 ms each on the OFF arm.

## Read-through on the main thread

The previous record's main-thread read-through figures (14.4 and 15.0 s) were
taken while a type check or a test suite shared the box. Interleaved on an
otherwise idle box, the main thread runs the burst in 12.7 s without the
read-through and 10.0 s with it; a second pair, which overlapped with the
probes above, read 11.7 s and 13.7 s. The read-through is not slower on the
main thread; the difference between runs is the box.

## How the numbers were taken

The burst: `lunch-poll-vote-burst.bench.ts` at five voters and five options,
with `EXPERIMENTAL_SERVER_EXECUTION`, `SERVER_EXECUTION_WORKER` and
`SERVER_EXECUTION_STORE_READ_THROUGH` set per arm, under the measured window
this change gives it; the data-only tables with the harness's default root
watch and no view, the rendered-view table with `renderView` on every voter,
`renderPoll` on the fixture and no root watch. The spans: a throwaway probe hosting the same harness in
the test process with the loop on its thread, `CF_TIMING_MEASURES` on for one
burst after two warm-ups and, for the two profiles, V8's sampling profiler
over that burst through `node:inspector` in the same process, the loop realm's measures taken from its own
timeline and one voter's through the harness's `timingMeasures()`, both read
with the perf-investigation scripts (`attribute-measures.ts
--key=scheduler/run/action --detail` for the runs by node, `--key=traverse
--heavy` for the walks, `wall-time.ts` and a union over spans for the table).
The two poll copies were untracked copies of `packages/patterns/lunch-poll`
with the fixture's import pointed at them, and were deleted. The single-runtime
figure is `lunch-poll/read-cost.test.tsx` under `cf test --verbose
--stats-threshold 0`.
