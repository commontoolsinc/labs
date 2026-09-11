---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "D2 eager/lazy scalar and all-row baseline at three collection sizes."
---

# Lazy scalar read width

Runtime revision `2e5f76ebfc` on an Apple M5, using Deno 2.9.4
(aarch64-apple-darwin), was measured with
`packages/runner/test/cell-schema-read-width.bench.ts`. This supplies the
one-scalar comparison requested by the lazy-materialization plan. It does not
change runtime behavior or complete that plan's handler or flag-removal stages.

## Reproduction and boundaries

From the repository root:

```sh
deno bench -A packages/runner/test/cell-schema-read-width.bench.ts
```

Each sample creates an isolated runtime, seeds one document containing an inline
array, and reads through a fresh transaction. Both modes use the same fully
declared item schema: amount, title, and nested category/tags. The transaction's
lazy-materialization mark selects the read path explicitly. The timed interval
includes `get()` and either the first row's amount or the sum of every row's
amount. It excludes setup, checksum validation, journal inspection, and cleanup.
Every result is checked against its expected value, and every sample must
register reads. No linked-row or cross-space workload is represented here.

The benchmark requests `n: 5` and `warmup: 1`; the final JSON reporter recorded
six samples for every variant.
Journal counts are reported from the first invocation of each variant; every
subsequent sample validates the result and nonzero activity.
Concurrent local validation ran during this measurement. The means below are
observations, not stable latency thresholds. Journal activities are obtained
from `getTransactionReadActivities`; they are not proxy-access counts and must
not be compared directly with the action-body counters from Track A.

## Observations

| Rows | Reader | Eager activities | Lazy activities | Eager mean (p75), ms | Lazy mean (p75), ms |
| --- | --- | --- | --- | --- | --- |
| 74 | One scalar | 894 | 17 | 1.199 (1.371) | 0.685 (0.752) |
| 296 | One scalar | 3,558 | 17 | 6.192 (7.483) | 0.762 (1.453) |
| 1,184 | One scalar | 14,214 | 17 | 10.891 (15.274) | 0.505 (0.828) |
| 74 | All row amounts | 894 | 893 | 2.795 (5.738) | 5.556 (6.710) |
| 296 | All row amounts | 3,558 | 3,557 | 3.200 (3.306) | 8.198 (9.961) |
| 1,184 | All row amounts | 14,214 | 14,213 | 13.235 (19.958) | 67.135 (79.975) |

The lazy one-scalar reader's recorded work stayed fixed as the array grew.
Both all-row readers retained linear journal volume, and the lazy all-row
reader took longer in this run. The measurement supports narrowing what a
consumer reads; it does not support treating lazy materialization as a universal
speedup for full scans. Array ownership, linked rows, reactive scheduling, and
producer maintenance need their own measurements.

For D2, rerun this comparison and the Track A workload after changes to the
per-access implementation. Record counts and timings separately so a smaller
read set is not mistaken for a cheaper access.
