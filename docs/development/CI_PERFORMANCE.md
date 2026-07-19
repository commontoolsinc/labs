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

For the pattern-integration job specifically, the time is dominated by
per-pattern CFC compile, not by storage or sync — see
[the profiling snapshot](../history/development/performance/pattern-integration-compile-bound.md)
before optimizing there.

### Pattern Integration Sharding

Pattern Integration runs four jobs. Most integration test files run in exactly
one job. Tests that sweep a pattern list run in every job and divide their own
cases with `PATTERN_INTEGRATION_SHARD`. An unset variable selects every case, so
the ordinary local command remains unsharded.

`INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES` in
`tasks/select-pattern-integration-files.ts` is the list of files that run in
every job. Those files select their cases through
`packages/patterns/integration/pattern-integration-shard.ts`. The selector tests
verify that every real integration file follows one of these two contracts.

Use internal sharding for a single file with many independent, expensive cases.
Moving that file intact between jobs moves the delay without dividing it. Keep
independent end-to-end files in the measured assignment table when their run
times are large enough that count-based round-robin cannot balance them.

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token, so the per-test timings in the `test-timing-*`
artifacts are not reachable this way; measure those locally.

Jobs and steps for a run:
`GET /repos/commontoolsinc/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

## Step Phase Markers

`scripts/ci-gantt.ts` draws each job as a bar and splits that bar into three
segments — setup, work, and shutdown — so the shared scaffolding around a job is
visually separated from the job's own work. For a matrix job this shows, per
shard, how much wall time is setup that every shard repeats versus the unique
work that one shard does.

The chart decides a step's phase from the emoji its name starts with. The emoji
is the marker: the script never reads step wording, only the leading emoji. Every
step we control — in `.github/workflows/*` and in the composite actions under
`.github/actions/*` — must begin with a marker emoji from the table below, and
each emoji belongs to exactly one phase. When you add a step, pick an emoji whose
phase matches what the step does. When you add a genuinely new kind of step,
choose a new emoji, then add it to both this table and the `PHASE_MARKERS` array
in `scripts/ci-gantt.ts`, keeping the one-emoji-one-phase rule.

**setup** — fetch code, install tools and dependencies, restore caches,
authenticate, and bring test servers and devices up before the real work:

| Emoji | Used for |
| --- | --- |
| 📥 | checkout, download inputs |
| 🦕 | set up Deno |
| 🔍 | verify the lock file and install, resolve refs |
| 📦 | install packages, cache dependencies |
| ♻️ | restore or save a build cache |
| 🛡️ | relax the sandbox for browser tests |
| 🔧 | enable a device |
| ⚙️ | set up an external SDK |
| 🔑 | authenticate to a cloud |
| 🔌 | start a local server for tests |
| ⏳ | wait for a service to be ready |
| 💾 | restore or save a cache |
| 🧮 | compute a cache identity |

**work** — the job's actual purpose:

| Emoji | Used for |
| --- | --- |
| 🔎 | checks (format, type, patterns, attestations) |
| 🚧 | guard that fails the build on a banned pattern |
| 🧪 | run tests |
| 🧩 | run integration tests |
| 🧹 | lint |
| 🧭 | check skill facts |
| 📄 | type-check docs |
| 🏗️ | build binaries or assets |
| 🏋️ | run benchmarks |
| 📊 | produce performance metrics or status reports |
| 🧬 | combine coverage |
| 📝 | generate attestations |
| 🔐 | sign binaries |
| 🚀 | deploy |
| 💬 | post a pull-request comment |

**shutdown** — post-work reports, artifact uploads, log capture, teardown:

| Emoji | Used for |
| --- | --- |
| 🧾 | write a coverage report |
| 📤 | upload artifacts |
| 📋 | capture logs on failure |

A few markers were chosen so the phase stays unambiguous, which is worth knowing
before you "correct" a step name back to a more obvious emoji:

- 🚀 means deploy, which is work. A step that starts a local server for tests is
  setup, so it uses 🔌 instead of 🚀. A step that uploads artifacts to cloud
  storage is shutdown, so it uses 📤.
- 🔍 means verify-then-install, which is setup. Verifying binary attestations is
  work, so that step uses 🔎.
- Downloading logs after a failure is shutdown, so those steps use 📋 rather than
  the 📥 or 📦 download markers.

The steps GitHub injects into every job — `Set up job`, `Post …`, and
`Complete job` — carry no marker, so the script classifies them by name (setup
for `Set up job`, shutdown for the other two). Any other step that reaches the
chart without a recognized marker is counted as "other", drawn in gray, and
listed on standard error when the script runs, so a missing marker is easy to
find and fix.

## Root Test Job Shape

The `Test (n/6)` jobs in `.github/workflows/deno.yml` run the root
`deno task test` on standard runners, sharded six ways with `TEST_SHARD` and
with `TEST_DISABLED_PACKAGES=runner`. The runner package has its own sharded
CI job, so the root jobs skip it. Each shard collects workspace coverage for
its packages with `DENO_COVERAGE_DIR` and uploads it as
`coverage-profile-workspace-<shard>`.

The root task is `tasks/test.ts`. It reads the workspace list from
`deno.jsonc`, selects this shard's packages by round-robin over the sorted
package-name list (`selectShardMembers`), and runs `deno task test` in every
selected package, at most `TEST_CONCURRENCY` (default: half the cores) at a
time to keep contention-sensitive tests stable. Each shard's wall time is set
by the slowest package test task in the shard, plus the fixed setup and
coverage report steps around it. When a package fails, the runner prints that
package's captured output immediately and stops starting new package tests.
Package tests that are already running finish before the summary is printed.

When a shard becomes the long pole, start with the `Package timings:` block
printed by `tasks/test.ts`. The round-robin split carries no per-package
weighting, so first check whether one shard simply drew several slow packages;
changing the shard count in the workflow matrix reshuffles the assignment.
A shard-count change must also update the `coverage-profile-workspace-*`
entries in `EXPECTED_COVERAGE_ARTIFACT_NAMES` in `tasks/perf-check.ts`, which
the Performance Check gate uses to require every shard's coverage artifact.

A package too heavy for any single shard can be split internally: the cli
package runs as three units via `CLI_TEST_SHARD` (see
`INTERNALLY_SHARDED_PACKAGES` in `tasks/workspace-tests.ts` and
`packages/cli/test/run-tests.ts`), so its slices spread across workspace
shards. A package that dominates a shard can be given the same treatment. A
slow package may also be running many independent test modules serially.
Deno's `--parallel` mode can reduce that package's wall time, but only after
checking for tests that share process-wide state.

Known serial CLI tests:

- `test/fuse.test.ts`, `test/inspect-remote.test.ts`,
  `test/log-level.test.ts`, `test/main-command.test.ts`,
  `test/test-runner-compile-byte-cache.test.ts`, and
  `test/test-runner-pattern-coverage.test.ts` mutate shared process state.
- `test/view-mod-gate.test.ts` changes into a removed directory to test the
  missing-current-directory fallback.
- `test/view-pager-pty.test.ts` drives a real pseudo-terminal, spawning a full
  CLI child per test. Keystrokes are gated on observed child output rather than
  on timing, so contention slows it but does not flake it; it stays serial to
  avoid stacking those children on top of the parallel groups.

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

A run without a recorded cache state — an artifact carrying no stamp, a
backfill-derived run, or a run whose cache-state artifact failed to upload — is
retro-classified from the compile fingerprint (`tasks/perf-cache-state.ts`
mirrors the `cc-*` key globs, drift-guarded by a test that parses the workflow):
if the fingerprint paths changed against the run's predecessor, every family is
treated as cold; if unchanged, warm. The same fingerprint inference backstops
the current run when its cache-state artifact is missing. Fingerprint inference
cannot see non-fingerprint cold causes (cache eviction, cache-service outages):
a run cold for those reasons and lacking a recorded state stays unknown, so its
samples are kept and gate normally.

Cold compile duration itself is not gated, so a regression that shows up only on
a cold cache passes unnoticed; a dedicated cold-compile bench would cover it.
