---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Controlled A0 baseline for the pattern computation cost implementation."
---

# Lunch-poll reactive read baseline

The A0 workload used 14 options, eight same-space profile cells, and 74 keyed
votes. Voters 0–4 each voted green on all 14 options; voter 5 voted green on
options 0–3. Voters 6–7 were roster members without votes. Each vote occupied
the address returned by the production `voteKeyFor` helper. The measured update
changed voter 0's vote on option 0 from green to yellow, preserving 74 votes.

The fixture was `packages/patterns/lunch-poll/read-cost.test.tsx` in PR #7241.
The runtime was commit `07300583c742f2638aaa0babf175a30a70158cc8` plus that
fixture. The underlying poll source came from
`100c8f3d12c7774c0a039d64d571a40c1cfde71a`. The same fixture also passed against
an untouched archive of that base revision before the counter implementation.
Both runs' bounded Action Stats tables reported 1,125 retained runs. The
candidate's untruncated completion-event intervals totaled 1,127 runs; the
control did not expose that event total. The final candidate fixture added an
explicit cleanup settle, which reported zero additional runs.

## Reproduce

```sh
CF_TEST_CONTINUOUS_UI=1 deno task cf test \
  packages/patterns/lunch-poll/read-cost.test.tsx \
  --verbose --stats-threshold 0
```

This ran on macOS arm64 with Deno 2.9.4, in the local CLI's emulated storage
runtime. The pattern-test preset used `enforce-explicit` CFC enforcement and
default enabled lazy materialization. The headless VDOM reconciler kept the
poll's exported UI demanded throughout initialization, seed, viewer claim, and
vote update. It did not create a browser DOM or a worker/main-thread boundary.
All profile links were within one space. Stored option images and an unhosted
poll avoided image-generation requests.

Idempotency verification remained enabled. These are operation counts, not
product timing measurements; no duration from this test establishes a speedup or
slowdown. The reactive clock determined the day filter, and seed actions stamped
votes with the current handler clock. Run within one calendar day when comparing
counts.

## Measured counts

Document and dependency columns sum per-run cardinalities. They are not unions.
The boundary covers reactive action bodies, excluding event dispatch, commit
processing, and diagnostic idempotency reruns.

| Interval                       | Runs | Proxy accesses | Link hops | Document-runs | Dependency-runs |
| ------------------------------ | ---: | -------------: | --------: | ------------: | --------------: |
| Empty-poll initialization      |  673 |          1,219 |    10,472 |         4,837 |          16,255 |
| Seed 74 keyed votes and roster |   52 |          1,746 |       483 |           410 |           2,131 |
| Claim viewer                   |  326 |          2,811 |     3,508 |         2,312 |           7,754 |
| Vote update, step 5            |   60 |          1,769 |       579 |           413 |           2,033 |
| Final settle                   |    0 |              0 |         0 |             0 |               0 |

The vote-update tally at `lunch-poll/main.tsx:1499:19` ran once: 360 proxy
accesses, 174 link hops, 96 documents, and 781 dependencies. The largest access
row was the UI construction at `main.tsx:1816:34`: 649 accesses in one run. The
current-day vote derivation at `main.tsx:1446:33` contributed 224 accesses.

The fixture's five assertions passed. Assertions ran in separate report
intervals; their own tree walks were not included in the vote-update row. In
particular, verifying all 14 cards through the VDOM helper generated 43,569
accesses in its interval. Keeping that assertion work distinct from the update
is necessary for a useful baseline. Verbose output defaults to ten attributed
rows per interval; `--stats-action-limit 1000` exposes more rows without
truncating or changing totals.

The design's approximately 2,600 tally accesses described nested scans. This
source already grouped votes in one pass and memoized roster lookup. The
measured 360 tally accesses therefore establish a baseline for this source, not
a speedup achieved by the counter implementation. Browser, cross-space,
whole-step, and idempotency-disabled timing comparisons remained separate work.
