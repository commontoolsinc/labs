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

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token, so the per-test timings in the `test-timing-*`
artifacts are not reachable this way; measure those locally.

Jobs and steps for a run:
`GET /repos/commontoolsinc/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

## Root Test Job Shape

The `Test` job in `.github/workflows/deno.yml` runs the root `deno task test`
with `TEST_DISABLED_PACKAGES=runner`. The runner package has its own sharded CI
job, so the root job skips it. The root task still collects workspace coverage
with `DENO_COVERAGE_DIR`.

The root task is `tasks/test.ts`. It reads the workspace list from
`deno.jsonc`, starts `deno task test` in every enabled package at the same time,
and waits for all packages to finish. Its wall time is set by the slowest
package test task, plus the fixed setup and coverage report steps around it.

When this job becomes the long pole, start with the `Package timings:` block
printed by `tasks/test.ts`. A slow package may simply be running many independent
test modules serially. Deno's `--parallel` mode can reduce that package's wall
time, but only after checking for tests that share process-wide state.

Known serial CLI tests:

- `test/fuse.test.ts`, `test/inspect-remote.test.ts`,
  `test/log-level.test.ts`, `test/main-command.test.ts`,
  `test/test-runner-compile-byte-cache.test.ts`, and
  `test/test-runner-pattern-coverage.test.ts` mutate shared process state.
- `test/view-mod-gate.test.ts` changes into a removed directory to test the
  missing-current-directory fallback.
- `test/view-pager-pty.test.ts` drives a real pseudo-terminal and is sensitive
  to heavy workspace contention.

The CLI package keeps those tests in a serial group and runs the rest of its
test modules with `--parallel`.

## Coverage Debt Baselines

Performance Check also tracks coverage debt as uncovered source lines. See
[COVERAGE.md](COVERAGE.md) for how that coverage is collected and which CI job
measures which code. Coverage debt uses a latest-main ratchet for source groups
changed by the PR: any increase in a changed group fails unless the PR
explicitly accepts it. Debt metrics for unchanged groups are still reported, but
they do not block the PR.

Use the narrow per-metric form when a PR intentionally increases one coverage
debt metric:

```text
NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 123 lines
```

Use the broad reset marker only to bootstrap coverage data for the first time,
or when the upstream coverage baseline is known to be bogus and should be
re-seeded for one cycle:

```text
NEW_COVERAGE_BASELINE
```

When that PR merges, the main run's coverage metrics become the new ratchet
baseline for later PRs. Performance Check still requires the full expected
coverage artifact set during that reset cycle. Jobs with no reportable covered
files upload an empty LCOV report so missing artifacts mean the report upload
itself failed.

## Compile Cache State and Cold Runs

The pattern test jobs restore a compile byte cache keyed on a fingerprint hash
over the compiler packages. A PR that changes that fingerprint runs cold: every
pattern compiles from scratch, pattern tests run roughly 1.7–2× slower, and the
timing gate would trip against warm baselines. The other direction is just as
bad: a cold main run covers compile branches that only execute on a cold cache,
which lowers the coverage-debt baseline, so later warm PRs fail the coverage
ratchet with phantom uncovered lines.

To compare like with like, each pattern job uploads a small `cache-state-*`
artifact recording its cache restore result. Performance Check aggregates those
into `compileCacheStates` in `perf-metrics.json`. A job family is cold when any
of its shards had a full cache miss, detected as the cache file being absent
after the restore step (the combined `actions/cache` action does not expose the
matched key). A partial hit through a restore key counts as warm: both key
forms start with the fingerprint hash, so any restore means the compiled bytes
are current.

The comparison rules follow from the tagging:

- When the current run is cold for a family, that family's cache-sensitive
  timing metrics get the non-blocking `COLD` status instead of being gated.
  The remedy is to re-run the pattern jobs: the cold attempt already saved the
  new cache, so the re-run is warm and gates normally.
- When the current run is warm, known-cold baseline samples are excluded from
  the timing comparison.
- The coverage-debt ratchet uses the latest non-cold main sample, so a cold
  main run cannot lower the baseline that warm PRs are held to.

Runs with unknown cache state — anything before this mechanism rolled out, and
backfill-derived runs — behave exactly as before: their samples are kept and
their metrics gate normally.

Two gaps remain. Cold compile duration itself is not gated, so a regression
that only shows up on a cold cache passes unnoticed; a dedicated cold-compile
bench could cover that later. And cold main runs from before the rollout stay
unknown, so they can still skew baselines until they age out of the 20-run
baseline window.
