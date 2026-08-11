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
  ports, artifacts, or sharding rules.

At that point, keep the timing instrumentation and wait for a concrete trigger
instead of continuing to split jobs proactively.

## Required Pull Request Checks

Configure merge protection to require `Status`. The GitHub web interface shows
that check as `CI / Status`, joining the workflow's name to the job's name, but
merge protection stores and matches the job's name on its own.

`Status` runs after every pull request validation job in `deno.yml`. It runs
after failed and skipped dependencies. It fails unless every dependency
succeeded. Add each new pull request validation job to its `needs` list.

Keep pull request path filters out of workflows that provide required checks.
GitHub leaves a required check pending when a path filter prevents its workflow
from starting.

Require checks from other GitHub Apps separately. A GitHub Actions job cannot
depend on a check produced by another app.

## Revisit Triggers

Revisit CI wall-time optimization when at least one of these holds across
normal runs:

- A required non-deploy job is over 3 minutes.
- One required non-deploy job is more than 50% slower than comparable jobs and
  at least 30 seconds slower in absolute terms.
- Required non-deploy checks take more than 8 minutes from first start to last
  completion.
- New tests clearly cluster in one shard or suite and make it consistently
  heavier.

## How To Respond

1. Start from the latest completed `main` run and its Coverage Check log.
2. Prefer timing artifacts and repeated runs over a single outlier.
3. First look for a low-maintenance rebalance, such as moving a heavy test file
   between existing shards.
4. Split a job only when the boundary is already clear and the split preserves
   local developer workflows.

Good CI optimization PRs should reduce critical-path wall time without making
the workflow harder to reason about.

For the pattern-integration job specifically, the time is dominated by
per-pattern CFC compile, not by storage or sync — see
[the profiling snapshot](../history/development/performance/pattern-integration-compile-bound.md)
before optimizing there.

### Pattern Integration Sharding

Pattern Integration runs as a job matrix. Most integration test files run in
exactly one job. Tests that sweep a pattern list run in every job and divide
their own cases with `PATTERN_INTEGRATION_SHARD`. An unset variable selects
every case, so the ordinary local command remains unsharded.

`INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES` in
`tasks/select-pattern-integration-files.ts` is the list of files that run in
every job. Those files select their cases through
`packages/patterns/integration/pattern-integration-shard.ts`. The selector tests
verify that every real integration file follows one of these two contracts.
Measured starting loads and file weights for the current matrix live
in `tasks/select-pattern-integration-files.ts`. Files added after the latest
timing profile receive the default weight until a later profile measures them.

Use internal sharding for a single file with many independent, expensive cases.
Moving that file intact between jobs moves the delay without dividing it. Keep
Keep independent end-to-end files in the measured weight table when their run
times are large enough that default-weight placement cannot balance them.

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token, so the per-test timings in the `test-timing-*`
artifacts are not reachable this way; measure those locally.

Jobs and steps for a run:
`GET /repos/commontoolsinc/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

The team ops dashboard's `/bench?view=ci` page provides repeated-run analysis
for labs and loom. It reports overall workflow duration and individual job
duration. Matrix jobs are grouped using the trailing-parenthesis base names from
`scripts/ci-gantt.ts`, with the slowest shard tracked across runs to expose
persistent imbalance.

For a requested history window, the collector retains every successful main
push build when there are at most 200. Larger sets are sorted chronologically
and reduced to exactly 200 builds spread evenly through that run sequence,
including its oldest and newest builds.

## Step Phase Markers

`scripts/ci-gantt.ts` draws each job as a bar and splits that bar into three
segments — setup, work, and shutdown — so the shared scaffolding around a job is
visually separated from the job's own work. For a matrix job this shows, per
shard, how much wall time is setup that every shard repeats versus the unique
work that one shard does.

When the chart contains one workflow run, it draws every execution of a rerun
job on the same row at its actual time. Each bar carries its own duration
beside it, and its tooltip names the attempt and how that attempt ended. Failed
attempts end in a red cross, and the delay before a retry stays blank. Charts
covering several workflow runs use the latest execution of each job from each
run when calculating their aggregate bars.

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
| 🔁 | replay captured fixtures under today's source |
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

The steps the runner injects into every job carry no marker, so the script
classifies them by name. GitHub adds `Set up job`, `Post …`, and `Complete
job`; the Blacksmith runners add `Set up runner` and `Complete runner`
alongside them. The two set-up steps count as setup and the rest as shutdown.
Any other step that reaches the chart without a recognized marker is counted as
"other", drawn in gray, and listed on standard error when the script runs, so a
missing marker is easy to find and fix.

## Root Test Job Shape

The `Test` matrix jobs in `.github/workflows/deno.yml` run the root
`deno task test` on standard runners, sharded with `TEST_SHARD` and with
`TEST_DISABLED_PACKAGES=runner`. The runner package has its own sharded CI job,
so the root jobs skip it. Each shard collects workspace coverage for its
packages with `DENO_COVERAGE_DIR` and uploads it as
`coverage-profile-workspace-<shard>`.

The root task is `tasks/test.ts`. It reads the workspace list from
`deno.jsonc`, assigns package test units to shards by observed test cost
(`selectShardMembers`), and runs `deno task test` in every selected package.
Unknown packages receive a default weight, so adding a workspace member cannot
make it fall out of CI. The test runner uses half the available cores for
package workers. This is two package workers on the standard four-core CI
runner.
`TEST_CONCURRENCY` can override that default for a diagnostic run. Each shard's
test time follows the longest chain of package tasks assigned to one worker,
plus initialization inside the root task. Fixed workflow setup and coverage
reporting sit outside that test step. When a package fails, the runner prints
that package's captured output immediately and stops starting new package
tests. Package tests that are already running finish before the summary is
printed.

When a shard becomes the long pole, start with the `Package timings:` block
printed by `tasks/test.ts`. Update `WORKSPACE_TEST_WEIGHTS` in
`tasks/test-timing-weights.ts` when package costs have drifted enough to affect
the critical path. Changing the shard count in the workflow matrix recomputes
the weighted assignment. A shard-count change must also update the
`coverage-profile-workspace-*` entries in `EXPECTED_COVERAGE_ARTIFACT_NAMES` in
`tasks/coverage-check.ts`, which the Coverage Check gate uses to require every
shard's coverage artifact.

A package too heavy for any single shard can be split internally. The CLI,
piece, and tasks packages run as multiple units via their package-specific
shard variables (see
`INTERNALLY_SHARDED_PACKAGES` in `tasks/workspace-tests.ts` and
`packages/cli/test/run-tests.ts` or `tasks/run-sharded-test-files.ts`), so their
slices spread across workspace shards. Slices of one package occupy distinct
workspace shards whenever the matrix has enough shards. A package that
dominates a shard can be given the same treatment. A slow package may also be
running many independent test modules serially. Deno's `--parallel` mode can
reduce that package's wall time, but only after checking for tests that share
process-wide state.

The CLI's commit-message tests are split across numbered
`view-commitmsg-*.test.ts` files. Some of these tests change process environment
while installing Git shims, so every file in the family stays in the serial
group. Their numbered filenames are consecutive in the sorted test inventory,
so ordinary file assignment places one in each CLI slice. An unsharded local
CLI test run executes every file.

### Runner Test Sharding

Runner test modules are assigned across the job matrix by observed per-file
cost.
`RUNNER_TEST_WEIGHTS` in `tasks/test-timing-weights.ts` records only files whose
cost materially affects placement; every other file receives a unit weight.
The longest-processing-time assignment in `tasks/weighted-shards.ts` places
expensive files first and uses the filename to break ties, so the result is
stable across machines. Selector tests require every real runner test file to
appear exactly once and keep the modeled shard loads close.

Refresh the weights from timestamped `running ... from ./test/...` boundaries
in successful CI logs. Deno's JUnit output attributes runner cases to the
preloaded clock module, so it does not carry usable per-file runner timings.

Deno runs each parallel test file on its own thread of a single process, so
"process-wide state" means state every file shares: environment variables,
replaced globals, and the current directory. A test that only configures a CLI
it spawns shares nothing — `cf` in `packages/cli/test/utils.ts` takes the
command's environment as an argument and gives it nothing else, so those tests
stay in the parallel group.

Known serial CLI tests:

- `test/completion-output.test.ts`, `test/completion-providers.test.ts`,
  `test/fuse.test.ts`, `test/inspect-remote.test.ts`,
  `test/log-level.test.ts`, `test/main-command.test.ts`,
  `test/test-runner-compile-byte-cache.test.ts`,
  `test/test-runner-pattern-coverage.test.ts`, and `test/wish-command.test.ts`
  set an
  environment variable that the test process itself then reads, so another
  file setting the same name would decide what they read.
- Every `test/view-commitmsg-*.test.ts` file remains serial because some tests
  in the family install Git shims by changing process environment.
- `test/json-command.test.ts` and `test/runtime-creation.test.ts` replace
  globals — the console methods and runtime prototype methods.
- `test/view-mod-gate.test.ts` changes into a removed directory to test the
  missing-current-directory fallback.
- `test/view-pager-pty.test.ts` drives a real pseudo-terminal, spawning a full
  CLI child per test. Keystrokes are gated on observed child output rather than
  on timing, so contention slows it but does not flake it; it stays serial to
  avoid stacking those children on top of the parallel groups.

The CLI package keeps those tests in a serial group and runs the rest of its
test modules with `--parallel`.
