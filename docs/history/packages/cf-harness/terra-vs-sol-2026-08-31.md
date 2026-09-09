---
status: historical
created: 2026-08-31
archived: 2026-08-31
reason: "Executed 2×2 Terra-versus-Sol measurement of parent composition guidance."
---

# Terra versus Sol: placement changes occurrence; tier changes cost

This record covers the 2026-08-31 2×2 experiment. It compared
`gpt-5.6-terra` and `gpt-5.6-sol`, with V0 (no parent prompt) and V2 (the
2026-08-29 parent prompt, child composition guidance withheld). The deployed
index remained at 29 discoverable entries before and after every valid cell:
recorded-only publication did not change what later searches saw.

## The result

V0 composed zero tasks on both model tiers. V2 cleared the composition bar on
both tiers and both suites. The same four composition tasks give the cleanest
comparison: Terra/V0 composed 0/4; Terra/V2 composed 4/4. The 2026-08-29
task-set confound is absent here.

| cell | suite | searches/hits | run_pattern | composing | outcomes |
| --- | --- | --- | --- | --- | --- |
| Terra/V0 | reuse | 7/7 | 5 by-id + 3 source | 0 | 6 ok |
| Terra/V0 | composition | 16/16 | 16 source | 0 | 5 ok, 11 compile-error |
| Terra/V2 | reuse | 18/18 | 3 by-id + 14 source | 12, 4 tasks | 8 ok, 3 compile-error, 6 error |
| Terra/V2 | composition | 16/16 | 1 by-id + 17 source | 17, 4 tasks | 7 ok, 9 compile-error, 2 error |
| Sol/V0 | reuse | 15/15 | 6 by-id + 10 source | 0 | 8 ok, 5 compile-error, 3 error |
| Sol/V0 | composition | 12/12 | 21 source | 0 | 5 ok, 15 compile-error, 1 error |
| Sol/V2 | reuse | 24/24 | 1 by-id + 6 source | 6, 5 tasks | 6 ok, 1 compile-error |
| Sol/V2 | composition | 37/33 | 32 source | 17, 4 tasks | 9 ok, 22 compile-error, 1 error |

## What each finding changes

**Placement, not capability, controls occurrence.** V0's zero composition on
both tiers falsifies the idea that the stronger model substitutes for parent
guidance. V2 composes on all four composition tasks on both tiers. The V2
artifact check passed in every family: the parent marker was present, the child
composition bullet absent, and child search guidance retained.

**V2 also changes whole reuse into wrapping wholes.** On the reuse suite it
reduces by-id execution and induces imports of already-whole applications.
Both models wrapped a static mockup (Terra's birthday application repeatedly;
Sol's trip timeline). This is composition by the extractor, not evidence that
the resulting UI works. It belongs beside the render-gate gap.

**Tier changes cost, not occurrence, and not monotonically.** Sol/V2 reuse was
far cleaner than Terra/V2 reuse. But the pre-registered Sol/V2 composition
prediction is **falsified on its error half**: it met the bar but produced 22
compile errors versus Terra/V2's 9, contrary to the prediction that it would
have fewer. Cost is task-dependent, not tier-ordered.

## Invalid work retained in the record

Two Terra/V0 composition batches are substrate-invalid and excluded: Docker
was down for the first; the second inherited a dead console fabric session and
returned `fabric session unavailable: Broken pipe (os error 32)` on every
`run_pattern`. A restarted console and sacrificial successful `run_pattern`
probe preceded the valid third run. CT-2150 records the runner-level substrate
liveness-preflight gap.

## What remains unestablished

`ok` means a pattern compiled and matched its schema, not that its UI works.
The static-mockup imports make that limitation material. No browser/render
verification was performed; no discoverability state was changed; and the
standing suite remains a whole-reuse measurement, not a composition measure.
