---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Investigation record: where the lunch poll spends its time at the deployed 14-option shape, measured across the pattern test, the headless multi-runtime probe, two browsers, and the serving toolshed, with each cost attributed to its runtime mechanism."
---

# Where the lunch poll spends its time

Measured 2026-09-09 on a 32-core AMD Ryzen AI Max+ 395 with 125 GB of RAM,
running Linux, from `packages/patterns/lunch-poll/main.tsx` at commit
`16de7e0c87` (main of that morning). Every process was on the
`serverExecution` OFF arm, the arm the deployed poll runs: the headless probe
pins it, the pattern test declares it, and the toolshed the browser runs
talked to reported `servingLoop: null`. The browser runs used a source-run
toolshed and shell started by `deno task integration --port-offset=700` from
the same checkout, over loopback. Each number is from a single run, so treat
a difference under about a third as noise; the point of the record is which
mechanism each cost attributes to, which the single runs agree on.

Instruments, cheapest first: `cf test --verbose --stats-threshold 0` on
`main.test.tsx`; the same run with `CF_TIMING_MEASURES` spans read by
`skills/perf-investigation/scripts/aggregate-measures.ts`,
`attribute-measures.ts` and `wall-time.ts`; a V8 CPU profile of that process
taken in-process (`profile-cf.ts` with `CF_PROF_CPU=1`) and sliced to the
spans' own intervals; `packages/patterns/tools/lunch-poll-diagnose.ts` at
`--production` (14 options, one viewer) and at `--cases=14x5`; the
`lunch-poll-vote.test.ts` browser test, then a scratch copy of it that seeds
14 options through the piece argument and brackets each vote phase with a
`CdpWorkerProfiler` capture of both browsers' runtime workers; and
`/api/health/stats` on the toolshed those browsers used.

## The numbers

The three rungs measure different things, and the deployed poll is the last
row of each table.

| Rung | Shape | A vote settles in |
| --- | --- | --- |
| Headless probe, one viewer | 14 options | 130 to 215 ms |
| Headless probe, five voters casting at once | 14 options | 103 to 139 ms per session |
| Two browsers, both casting on one option at once | 2 options | 469 ms to dispatch both, 54 ms more until both show the merged tally |
| Two browsers, both casting on one option at once | 14 options | 730 ms to dispatch both, 490 ms more until both show the merged tally |
| Two browsers, one voter casting alone | 2 options | 119 ms until both show it |
| Two browsers, one voter casting alone | 14 options | 292 ms until both show it |

Cold load, from navigation to both runtimes idle on the poll:

| Shape | Navigate and log in | Space roots ready | Both runtimes idle |
| --- | --- | --- | --- |
| 2 options | 496 ms | 513 ms | 637 ms |
| 14 options | 552 ms | 626 ms | 2,109 ms |

The reactive graph after the host adds 14 options is about 1,370 nodes and
3,400 edges, matching the September figure in the deploy runbook.

## Finding 1: in the browser a vote is mostly waiting, not computing

The four worker CPU profiles, each covering one vote phase at 14 options,
sampled 1.4 to 2.0 s of wall time and attributed 79 to 89% of it to
`(program)`, which is time the worker was not running JavaScript. The
JavaScript that did run summed to roughly 150 to 300 ms per phase, and its
top self-time frames were link resolution (`resolveLinkTracingDereferences`),
deep freezing, `utf8SortedKeysOf` and `feedPlainObject` from the content
hasher, and `internSchema`. That agrees with the runbook's earlier "about
75 ms of CPU per vote": the worker's own work is a modest fraction of what a
voter waits for.

What the worker waits on is the storage sync. The browser load summaries put
`storage.v2/watchRefresh/watchAddSync` at a p95 of 250 to 310 ms and a
maximum of 480 to 530 ms in both browsers at 14 options, 67 to 77 refreshes
over the run, and `scheduler/scheduler/execute` at a p95 of 148 to 193 ms
with a maximum of 500 to 550 ms. A settle triggers graph-watch refreshes,
and the settle's wall time is bounded below by the slowest of them.

The serving toolshed is not where that time goes. Its own statistics over the
same runs show a session refresh walk averaging 5.5 ms (p95 13 ms) over 574
refreshes, a watch add averaging 3.7 ms, and frame handling averaging 0.9 ms
over 5,226 frames. Its two recorded slow queries were the initial watch add
of a browser loading the poll (1,654 roots, 107 ms) and one 769-operation
transaction (102 ms). So a refresh that the client waits 250 ms for costs the
server about 5 ms of work, and the difference is in the client's side of the
exchange: the watch-mutation queue, response-order waiting in concurrent
mode, and applying the watch view. The `watchAddSync` span contains all of
those and does not separate them, which is the first thing to instrument
next.

The same shape appears in the pattern test, where the memory server is
in-process: `watchRefresh/watchAddSync` totals 7.4 s over 235 calls, every
one of them at the root of the span tree (asynchronous, enclosed by nothing
instrumented), and each refresh is most often preceded by the previous
refresh's `applySessionSync`, so refreshes run as chained waves rather than
one per read.

## Finding 2: cold load scales with the number of pattern instances

At 14 options each browser ran `runner/start/syncCellsForRunningPattern`
47 times, with a p50 of 410 to 550 ms and a maximum of 700 to 815 ms per
start, and `runner/start/resumeCellSync` 5,400 times at a uniform 90 to
110 ms (uniform because the syncs are concurrent within a wave; the wave
rows are the wall cost). Each option card is a sub-pattern and each carries
a generated-art sub-pattern, so a 14-option poll is close to fifty pattern
instances, and every one resumes with its own pre-sync waves. The 2-option
run started 4 to 5 patterns. That is the 637 ms to 2,109 ms difference in
the cold-load table, and it is per browser, per load.

## Finding 3: concurrent voters churn optimistic commits

Five voters on 14 options, three rounds of everyone recasting every option
(45 casts per session), produced 626 commit conflicts and 918 reverted
optimistic writes across the five sessions. One voter produced none. Per
vote settle time did not move (103 to 139 ms), so headless the churn is
wasted work rather than latency, but every revert is a commit built, sent,
refused, undone, and its dependents re-run. The two-browser runs show the
same in the product: 40 and 45 reverts in the 14-option run, 18 and 153 in
the 2-option run, for three votes cast. The keyed vote write itself is
mergeable and the regression test that pins it counts no reverts for votes,
so what conflicts is the derived state each session commits after a vote
lands (tallies, rankings, per-card state) against the writes arriving from
the other sessions. The `commit-revert` log line names only the rejection
kind, so attributing reverts to the committing action is the second thing
to instrument.

## Finding 4: a schema is content-hashed on every union-narrowed read

This one came from the pattern test, where a lift that formats the header
line (`u joined · o options · v votes today`) appeared to take 250 ms per
run. The CPU profile sliced to those spans showed the lift's body was not
running: the span brackets an asynchronous gap, and the thread was busy with
the test's own walk of the rendered tree. That walk is what is expensive,
and the reason is the runtime's.

Across all test steps, 6.9 s of sampled CPU, `internSchema` accounts for
1.62 s inclusive and the content hasher it calls (`hashOfInternal`) for
1.52 s, about 23% of the run. The intern cache is keyed by object identity
(`schemaToSah`, a `WeakMap` in
`packages/data-model-schema/src/schema-intern.ts`), and the hash memo is
too (`frozenObjectHashCache`), so both hit only for an object seen before.
The callers that miss build a fresh object every time:

- `branchWithOuter` in `packages/runner/src/schema-view.ts` narrows a union
  to the branch a value matches by spreading the union's own keywords into a
  new object, combining that with the branch, and spreading the result again
  to carry `$defs`. `combineSchema` keys its cache with
  `internSchemaPairAsKey`, which hashes both inputs, so the cache saves the
  combination and not the hashing. 487 ms of the interning arrived by this
  path, plus 212 ms through `mergeAnyOfBranchSchemas` from the same
  `narrowForValue`.
- `resolveSchema` in `packages/runner/src/schema.ts` interns its result on
  every call, by contract, so a fresh narrowed schema handed to
  `validateAndTransform` is hashed again: 447 ms, all under `resolveElement`
  in the array view.
- `resolveLink` interns the schema it returns at its exit
  (`packages/runner/src/link-resolution.ts`): 309 ms.

A schema that carries `$defs` is hashed in full, definitions included, and
the view-node schema carries every definition the render tree can reach. So
each child read of a union-typed value through a lazy view pays three or
four full hashes of a large schema, and a walk of a rendered tree pays that
per node. The identity caches that were meant to make the second read free
never see the same object twice. In the browser profiles the same functions
are the top JavaScript frames, though in absolute terms they are a small
share of a phase dominated by waiting; the pattern-test share is the honest
measure of the CPU cost because that process has no network to wait on.

The fix is at the source of the fresh objects: memoize `resolveBranch` and
`branchWithOuter` by the identity of their inputs so their outputs are the
canonical interned objects, and have `combineSchema` key its cache by
identity before falling back to hashing. That is a runtime change, and it
makes every read of a union-typed value cheaper, not only the poll's.

## Finding 5: what the pattern itself reads per vote

The probe's per-session read-site trace for one vote round at 14 options,
one viewer:

| Read site | Reads per vote round |
| --- | --- |
| the harness's `sink` on the result | 3,145 |
| per-option `rank` computed (`main.tsx` around line 1933) | 284 |
| `tallyOptions` (around line 1499) | 102 (196 with five voters) |
| the `ranked.map` card list (around line 1816) | 75 |

The first row is the harness holding the whole result live through a
schemaless sink, the "what your harness holds live" trap, and it is also the
slowest action per round at 47 to 57 ms. It is not a product cost as such,
though a browser rendering the result demands a comparable tree. The
pattern's own read sites are modest after the tally single-pass change
(#7175); the per-option `rank` computed is the widest because each of 14
cards scans the ranked list for its own position.

## What to do next, in order of leverage

1. Split `watchAddSync` into queue wait, request, response-order wait, and
   apply, then count refreshes per settle. Finding 1 says the vote's wall
   time is here, and that the server is not the part that is slow.
2. Memoize the schema-view's branch narrowing so interning hits by identity
   (finding 4). Small change, wide effect, and a benchmark that walks a
   rendered tree through a view would pin it.
3. Attribute reverts to the committing action, then decide whether derived
   state should be committed by every session at all on the OFF arm
   (finding 3). The ON arm changes this question rather than answering it.
4. Reduce pattern instances per option, or make a dormant sub-pattern's
   resume cheaper (finding 2). The runbook already records that a card
   without a nested generator settled an option add slower, so this needs
   its own measurement before a pattern change.

## Caveats

- The pattern test runs every computation twice (`enableIdempotencyCheck`),
  so its durations are inflated; its counts and the profile's attribution
  are what this record relies on from that rung.
- `(program)` in a worker profile taken over CDP includes the profiler's own
  overhead and native message handling as well as waiting; the claim is
  only that JavaScript execution is the minority of a vote phase, which the
  logger rows support independently.
- The probe's result sink and the browser test's controller sink both hold
  the whole result live; the browser tier is the one whose demand resembles
  the product's.
- Single runs, one machine, loopback. Ratios and mechanisms are the result;
  the milliseconds are the shape at this size.

The scratch profiling test, the profile slicer, and the caller attribution
script that produced findings 1 and 4 were throwaway and are not in the
tree; `default-app.test.ts` holds the maintained example of the profiler
wiring they copied.
