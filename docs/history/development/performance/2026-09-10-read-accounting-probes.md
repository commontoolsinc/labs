---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Disabled-probe comparison for the first pattern read-accounting implementation."
---

# Disabled read-accounting probes

The control was an untouched archive of
`100c8f3d12c7774c0a039d64d571a40c1cfde71a`. The candidate was the first A1/A2
implementation on `codex/pattern-read-accounting`. Both ran on the same macOS
arm64 host with Deno 2.9.4 and V8 15.0.245.2-rusty. Accounting was disabled.

From `packages/runner` in each tree:

```sh
deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env \
  --no-check --filter 'no write taken' test/lazy-view-epoch.bench.ts
```

The existing benchmark walks 1,000 elements through a lazy schema view, on a
transaction that has not written. The test suites had completed before this
series. Five control/candidate pairs ran in alternating order; each table entry
is Deno's reported mean per iteration for that invocation, in milliseconds, at
its displayed precision.

| Pair | Control | Candidate |
| ---- | ------- | --------- |
| 1    | 4.1     | 6.2       |
| 2    | 4.6     | 4.9       |
| 3    | 7.5     | 4.6       |
| 4    | 6.0     | 3.9       |
| 5    | 5.0     | 3.9       |

The minimum of five invocation means was 4.1 ms for control and 3.9 ms for
candidate. Within-invocation minimum iterations were 3.2–3.5 ms for both. This
comparison did not establish a disabled-probe regression. The spread between
windows prevents interpreting the lower candidate minimum as an improvement or
claiming literally zero overhead. It measures one schema-view scan, not all read
paths or enabled accounting's completion-time work.

The disabled code performs a weak-map lookup at a measured operation; it
allocates neither counters nor document sets. Document cardinality and
dependency compaction run only for enabled transactions. Tests separately check
that enabling accounting preserves read logs and subscription paths.

## Baseline limitations

The lunch-poll functional test passed its 36 assertions with reporting enabled,
but it was not the design's 14-option, 74-vote workload. UI assertions can
demand work after the preceding vote step. The checked-out tally also already
grouped votes in one pass and memoized roster lookup, so the design's
nested-scan estimate was not a measurement of this source revision. A0 remained
open for a controlled workload with sustained UI demand.

The first accounting boundary was reactive action bodies. Event dispatch, commit
processing, and diagnostic idempotency reruns were excluded; the reports could
not establish a whole-interaction budget.
