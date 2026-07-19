---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Investigation snapshot of the July 2026 CI duration increase caused by the pattern time-capability sweeps."
---

# Why labs CI duration increased in July 2026

## Conclusion

Commit
[`72df6bce1`](https://github.com/commontoolsinc/labs/commit/72df6bce116bebbc334d0d7e7c277a161d299e52),
"Timing side-channel mitigations and the reactive #now clock," added four
pattern-integration test files. Three cover the new time-capability rules. The
fourth covers cell-flip shaping. The largest file,
`time-capability-full.test.ts`, discovers 56 patterns and exercises every one
serially. It creates a new identity, session, runtime, and controller for each
pattern. It then resolves and starts the pattern, makes its result reactive,
waits for the runtime to settle and synchronize, fires every top-level result
stream, waits again, and disposes the controller.

That full sweep is assigned as one ordinary test file to Pattern Integration
Tests shard 3. It does not use `PATTERN_INTEGRATION_SHARD` to divide its 56
patterns. On a warm compile cache the sweep takes about 5 minutes 28 seconds by
itself. It accounts for about 72 percent of shard 3's test step.

The compile cache made the first affected run slower still, but a cache miss is
not the persistent cause. A later warm run still took 8 minutes 10 seconds for
shard 3, compared with 1 minute 56 seconds immediately before the commit.

## The change boundary

The first slow commit is the direct child of the last fast commit, so no other
change is mixed into this comparison.

| State | Main run | Compile cache | Whole workflow | Shard 3 job | Shard 3 test step |
| --- | --- | --- | ---: | ---: | ---: |
| Before | [`29635744508`](https://github.com/commontoolsinc/labs/actions/runs/29635744508), `d7a5243e7` | warm | 8m 08s | 1m 56s | 1m 25s |
| First affected | [`29636904390`](https://github.com/commontoolsinc/labs/actions/runs/29636904390), `72df6bce1` | cold | 13m 42s | 9m 42s | 8m 57s |
| Later comparison | [`29641431325`](https://github.com/commontoolsinc/labs/actions/runs/29641431325), `a88a29d6a` | warm | 12m 39s | 8m 10s | 7m 37s |

The warm comparison shows that the whole workflow remained 4 minutes 31
seconds slower than the run before the change. The Performance Check reported
that required non-deploy jobs occupied 9 minutes 6 seconds in the warm run. The
last fast run's required jobs completed in about 4 minutes 51 seconds.

## Per-test evidence

The JUnit timing artifacts make the new work visible inside the test step.

| Shard 3 measurement | Before | Warm after |
| --- | ---: | ---: |
| Reported tests | 34 | 98 |
| Total test time | 84.421s | 456.265s |
| `all.test.ts`: Compile all patterns | 16.296s | 16.344s |
| `time-capability-full.test.ts` | absent | 327.899s |

The unchanged warm time for `all.test.ts` rules out a slowdown in its existing
warm-cache compile-and-create workload as the main cause. That test creates
patterns without starting them, so it does not exercise every runtime operation
in the full sweep. The new full capability sweep alone contributes 327.899
seconds. Its 56 individual pattern cases account for 327.876 seconds of that
total.

The smaller `time-capability.test.ts` sweep also adds 84.261 seconds to shard 1.
In the same warm run the four pattern-integration jobs took:

| Shard | Job duration | New capability work |
| --- | ---: | --- |
| 1 | 4m 32s | the 11-case curated capability suite |
| 2 | 2m 41s | none of the two large sweeps |
| 3 | 8m 10s | the 56-case full-pattern sweep |
| 4 | 2m 44s | the intrinsic behavior tests |

## Why all 56 cases landed in one shard

`tasks/select-pattern-integration-files.ts` includes `all.test.ts` in every
shard because that file divides its own pattern list with
`PATTERN_INTEGRATION_SHARD`. Every other integration file is assigned to one
shard. Known expensive files have explicit assignments. New unlisted files use
round-robin assignment by filename.

The timing-side-channel commit added `time-capability-full.test.ts`,
`time-capability.test.ts`, and `time-capability-intrinsics.test.ts` without
changing the selector. The fallback placed the full sweep on shard 3 and the
curated capability suite on shard 1. The full sweep does not divide its
discovered pattern list by the CI shard value.

Moving the full test file intact to another shard would move the delay rather
than reduce it. The independent pattern cases are the useful split boundary.

## Why Performance Check did not stop the increase

The first affected run changed the compile fingerprint and missed every pattern
compile cache. Performance Check classified the pattern-integration timing as
`COLD`, which deliberately does not fail against warm baselines. It did emit all
three wall-time revisit signals:

- the slowest required job exceeded 3 minutes;
- shard 3 was much slower than nearby jobs; and
- required non-deploy checks exceeded the 8-minute budget.

The later warm run emitted the same revisit signals. Its shard 1 and shard 3
timings had fewer than five comparable samples, so Performance Check reported
them as `n/a` instead of comparing them with a threshold. The guard therefore
identified the wall-time problem in its informational section but had no gated
timing result that could fail.

## Remediation direction

The lowest-risk first change is to give the full sweep the same internal
sharding contract as `all.test.ts` and select it in every pattern-integration
job. A plain sorted, modulo-four division of the measured 56 cases would put
between 50 and 117 seconds of this sweep on each shard, instead of 328 seconds
on shard 3. The 84-second curated capability suite on shard 1 should then be
split or reassigned while comparing all four resulting job times.

The selector should explicitly distinguish internally sharded files that run in
every job from expensive files pinned to one job. The full sweep belongs in the
first group. The curated suite can be split or pinned after measuring the new
balance. Leaving either file to the fallback changes the placement of other
unlisted files whenever a new filename is inserted, which makes an already
measured balance unstable.

This investigation does not recommend weakening or removing the capability
checks. It recommends running the independent checks across the four workers
that CI already starts.
