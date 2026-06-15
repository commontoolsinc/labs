# Keyed Collections POC Performance Notes

Command:

```bash
deno run -A packages/patterns/keyed-collections/diagnose.ts --votes=100,500
deno run -A packages/patterns/keyed-collections/diagnose.ts --votes=1000
deno run -A packages/patterns/keyed-collections/diagnose.ts --modes=bulk --votes=1000,5000
deno run -A packages/patterns/keyed-collections/diagnose.ts --programs=perf-v1.tsx --votes=20,100,500,1000
deno run -A packages/patterns/lunch-poll/diagnose.ts --program=main.tsx --cases=1x2,3x5,10x5 --rounds=3 --skip-refresh
deno run -A packages/patterns/lunch-poll/diagnose.ts --program=main-indexed.tsx --cases=1x2,3x5,10x5 --rounds=3 --skip-refresh
deno run -A packages/patterns/lunch-poll/diagnose.ts --program=main-v1.tsx --cases=1x2,3x5,10x5 --rounds=3 --skip-refresh
deno run -A packages/patterns/lunch-poll/diagnose.ts --program=main.tsx --cases=1x2,3x5,10x5 --rounds=3
deno run -A packages/patterns/lunch-poll/diagnose.ts --program=main-full-v1.tsx --cases=1x2,3x5,10x5 --rounds=3
```

The benchmark uses four coffee-origin poll options and casts one vote per
synthetic user. It compares:

- `perf-array.tsx`: cozy array state plus `countVotesByOption(options, votes)`,
  which scans the vote array for aggregate output.
- `perf-indexed.tsx`: same aggregate-facing streams/output, but internally
  stores votes by voter and maintains `talliesByOption` incrementally.
- `perf-v1.tsx`: same indexed aggregate shape, implemented through the reusable
  `keyed-collection-v1.ts` helper layer over today's cells.
- `perf-sqlite.tsx`: same aggregate-facing streams/output, but pushes vote
  storage and `COUNT/GROUP BY` aggregation into the existing SQLite builtin via
  declared tables, `db.exec`, and `db.query(..., { reactOn: db })`.

## Results from this branch

### Sequential vote events

| Votes | Program            | Cast votes | Graph nodes | Graph edges | Max recent settle | Slowest recent action |
| ----: | ------------------ | ---------: | ----------: | ----------: | ----------------: | --------------------: |
|    20 | `perf-array.tsx`   |      0.63s |          33 |          32 |            2.63ms |                2.80ms |
|    20 | `perf-indexed.tsx` |      1.05s |           9 |           8 |            1.74ms |                3.31ms |
|    20 | `perf-v1.tsx`      |      0.62s |           9 |           8 |            1.51ms |                3.37ms |
|    20 | `perf-sqlite.tsx`  |      0.55s |          27 |          34 |            7.80ms |                2.50ms |
|   100 | `perf-array.tsx`   |      2.95s |         113 |         112 |            3.84ms |                2.76ms |
|   100 | `perf-indexed.tsx` |      5.04s |           9 |           8 |            2.03ms |                1.28ms |
|   100 | `perf-v1.tsx`      |      3.26s |           9 |           8 |            1.39ms |                1.19ms |
|   100 | `perf-sqlite.tsx`  |      2.82s |          27 |          34 |            8.85ms |                2.42ms |
|   500 | `perf-array.tsx`   |     28.55s |         513 |         512 |           18.04ms |                9.29ms |
|   500 | `perf-indexed.tsx` |     25.81s |           9 |           8 |            1.20ms |                0.88ms |
|   500 | `perf-v1.tsx`      |     15.87s |           9 |           8 |            1.47ms |                1.02ms |
|   500 | `perf-sqlite.tsx`  |     14.36s |          27 |          34 |            5.35ms |                1.38ms |

### Bulk seed in one handler

| Votes | Program            | Seed votes | Graph nodes | Graph edges | Max recent settle | Slowest recent action |
| ----: | ------------------ | ---------: | ----------: | ----------: | ----------------: | --------------------: |
|  1000 | `perf-array.tsx`   |      0.43s |        1013 |        1012 |           43.30ms |               19.58ms |
|  1000 | `perf-indexed.tsx` |      0.49s |           9 |           8 |            2.55ms |                3.18ms |
|  1000 | `perf-v1.tsx`      |      0.51s |           9 |           8 |            2.92ms |                3.09ms |
|  1000 | `perf-sqlite.tsx`  |      0.76s |          27 |          34 |            9.24ms |                2.95ms |
|  5000 | `perf-array.tsx`   |      2.12s |        5013 |        5012 |          226.68ms |               92.02ms |
|  5000 | `perf-indexed.tsx` |     11.47s |           9 |           8 |            4.59ms |                3.47ms |
|  5000 | `perf-v1.tsx`      |     11.60s |           9 |           8 |            3.95ms |                3.73ms |
|  5000 | `perf-sqlite.tsx`  |      3.50s |          27 |          34 |            9.45ms |                2.55ms |

### Lunch-poll multi-runtime matrix

This matrix uses the diagnostic lunch poll variants to vary options (`n`), users
(`u`), and vote sends (`m = users × rounds`). It skips the homepage-refresh
phase so the numbers focus on poll state, joins, option creation, and concurrent
vote rounds.

| Case (`n×u`, `m`) | Program            | Total run | Add options |        Vote rounds | Final graph nodes | Final graph edges |
| ----------------- | ------------------ | --------: | ----------: | -----------------: | ----------------: | ----------------: |
| `1×2`, `m=6`      | `main.tsx`         |         — |       1.02s |    0.83/0.59/0.62s |               210 |               471 |
| `1×2`, `m=6`      | `main-indexed.tsx` |         — |       0.27s |    0.44/0.54/0.27s |                54 |                97 |
| `1×2`, `m=6`      | `main-v1.tsx`      |         — |       0.23s |    0.31/0.61/0.43s |                54 |                99 |
| `3×5`, `m=15`     | `main.tsx`         |         — |       9.14s | 15.69/22.82/14.70s |               418 |              1159 |
| `3×5`, `m=15`     | `main-indexed.tsx` |         — |       0.52s |    4.93/3.51/6.81s |                68 |               139 |
| `3×5`, `m=15`     | `main-v1.tsx`      |         — |       0.49s |    4.67/5.87/6.35s |                68 |               140 |
| `10×5`, `m=15`    | `main.tsx`         |         — |     107.47s | 18.28/19.11/16.15s |              1090 |              3391 |
| `10×5`, `m=15`    | `main-indexed.tsx` |         — |       2.03s |  12.88/11.00/9.16s |               117 |               286 |
| `10×5`, `m=15`    | `main-v1.tsx`      |         — |       3.00s | 10.63/12.74/13.72s |               117 |               287 |

Whole-command elapsed time for the three-case lunch runs was 259s for the
previous array-backed `main.tsx`, 67s for `main-indexed.tsx`, and 77s for
`main-v1.tsx`.

### Lunch-poll full-product parity matrix

`main-full-v1.tsx` keeps the canonical lunch-poll product surface: full UI,
profile wish/join, homepage and image enrichment, history logging, city state,
host takeover, and all public handlers. It only swaps the hot option/vote state
onto `keyed-collection-v1.ts`. These numbers therefore compare product-parity
state shape, while `main-indexed.tsx` and `main-v1.tsx` remain smaller
diagnostic targets.

The following runs included the homepage-refresh phase. Local runs also emitted
the expected `profile-create.tsx` localhost warning when no local server was
running, plus scheduler retry warnings during concurrent vote rounds.

| Case (`n×u`, `m`) | Program            | Total run | Add options | Vote round 3 | Refresh links | Final graph nodes | Final graph edges |
| ----------------- | ------------------ | --------: | ----------: | -----------: | ------------: | ----------------: | ----------------: |
| `1×2`, `m=6`      | `main.tsx`         |   437.64s |       0.92s |        0.99s |         0.23s |               210 |               471 |
| `1×2`, `m=6`      | `main-full-v1.tsx` |    12.23s |       0.99s |        2.15s |         0.25s |               209 |               467 |
| `3×5`, `m=15`     | `main.tsx`         |   437.64s |      26.93s |       11.38s |         0.72s |               418 |              1159 |
| `3×5`, `m=15`     | `main-full-v1.tsx` |    94.81s |       7.71s |       24.14s |         0.64s |               402 |              1050 |
| `10×5`, `m=15`    | `main.tsx`         |   437.64s |     254.03s |       17.74s |         1.28s |              1090 |              3392 |
| `10×5`, `m=15`    | `main-full-v1.tsx` |   240.29s |     104.91s |       44.86s |         1.17s |              1067 |              3039 |

The full-parity helper variant reduces option-add graph size and elapsed time at
larger option counts because option storage is keyed and vote/tally state is
maintained separately. Concurrent vote rounds are not uniformly faster yet: the
current helper still writes shared JSON records and shows retry/conflict cost
under simultaneous runtimes. That is useful evidence for the next layer: the
authoring API can stay cozy, but true public-internet scaling needs a runtime or
backend implementation of the same keyed/latest-by/count-by semantics.

## What this proves

The indexed aggregate variant changes the live reactive graph scaling law for
the aggregate-facing poll slice. Array aggregates grow roughly one input node
and edge per vote; the indexed aggregate graph stays flat in this benchmark
because the result only subscribes to `voteCount` and per-option tallies.

The reusable v1 helper preserves that same flat graph shape while moving the
manual indexing logic into a composable pattern-layer seam. In the current perf
fixtures it matches the hand-indexed graph size while keeping graph size
independent of vote count.

At small sequential sizes, hand-indexed writes have more overhead. By 500 votes,
the v1 helper and SQLite variants cross over on elapsed vote time while keeping
recent action/settle costs low.

SQLite pushdown is promising as an internal aggregate backend: in the visible
sequential matrix it is fastest at 100 and 500 votes, despite using the current
coarse `reactOn: db` invalidation model and no declared indexes. It keeps the
live graph flat relative to vote count, though less minimal than the manual
indexed variant because it has three reactive query nodes plus derived
query-result computeds.

Bulk seeding separates per-event harness/storage/sync overhead from the
representation and aggregate shape. A single array write can ingest quickly, but
it still creates a live result graph that grows with vote count and produced
slow traversal/get warnings at 5000 votes. Manual indexed state keeps the graph
tiny, but writing one very large JSON record is expensive at 5000 votes. SQLite
pushdown is a useful middle path for large historical/event data: bulk ingestion
is much faster than the large-record indexed variant and the graph remains flat.

## What this does not prove yet

- This is not a general runtime primitive yet; it is still authored manually in
  a POC pattern.
- The runner sends one event at a time and pays harness/storage/sync overhead
  for every vote, so elapsed time is not a production throughput number.
- The bulk path writes many synthetic votes from one handler and is not an end
  user interaction model; it is meant to isolate storage/aggregate shape.
- The indexed variant still stores every vote record; it only avoids exposing
  all votes in the subscribed output and maintains aggregate state
  incrementally.
- The v1 helper is still a pattern-layer helper over current cells. It is a good
  seam for composition and future runtime backing, not a runtime primitive yet.
- The SQLite variant currently reruns queries on any DB write (`reactOn: db`)
  and has no public declared-index API. It proves pushdown feasibility, not
  final query invalidation/index design.
- Conflict behavior under many concurrent runtimes still needs a separate test.

## Next perf target

The next meaningful step is using `keyed-collection-v1.ts` as the stable
pattern-layer seam while experimenting with runtime-backed implementations under
that same shape, so authors can write cozy code while the runtime chooses an
execution backend:

- in-runtime keyed materialized aggregates for small/interactive state;
- SQLite pushdown for large historical/event tables;
- finer invalidation than whole-DB `reactOn: db`;
- declared index support for pushed-down `latestBy`, `countBy`, and `groupBy`.
