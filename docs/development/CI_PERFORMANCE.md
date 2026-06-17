# CI Performance Policy

This repo tracks GitHub Actions wall time so CI optimization work is driven by
trend data, not one-off slow runs. Use this policy when deciding whether to
split, rebalance, or otherwise optimize CI jobs.

## Current Posture

Stop active CI-splitting work when the required test jobs are already in the
same rough band. As a default, stop when:

- The top required test jobs are within about 20-30% of each other.
- The slowest required test job is around 2 minutes.
- The expected critical-path win is under about 30 seconds.
- The proposed split adds comparable maintenance cost: more matrix entries,
  ports, artifacts, sharding rules, or performance baselines.

At that point, keep the timing instrumentation and wait for a concrete trigger
instead of continuing to split jobs proactively.

## Revisit Triggers

Revisit CI wall-time optimization when at least one of these holds across
normal runs:

- A required non-deploy job is over 3 minutes.
- One required non-deploy job is more than 50% slower than comparable jobs and
  at least 30 seconds slower in absolute terms.
- Required non-deploy checks take more than 8 minutes from first start to last
  completion.
- The same job repeatedly appears as `OVER` or `CLOSE` in Performance Check,
  rather than as a one-run fluctuation.
- New tests clearly cluster in one shard or suite and make it consistently
  heavier.

Performance Check prints a non-blocking `CI Wall-Time Revisit Signals` section
for the first three triggers. Treat it as a prompt to inspect the data, not as a
failure by itself.

## How To Respond

1. Start from the latest completed `main` run and its Performance Check log.
2. Prefer timing artifacts and repeated runs over a single outlier.
3. First look for a low-maintenance rebalance, such as moving a heavy test file
   between existing shards.
4. Split a job only when the boundary is already clear and the split preserves
   local developer workflows.
5. If Performance Check asks for a `NEW_PERF_BASELINE`, make sure the metric is
   understood and note whether it is related to the CI change.

Good CI optimization PRs should reduce critical-path wall time without making
the workflow harder to reason about.
