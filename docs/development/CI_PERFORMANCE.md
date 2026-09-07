# CI Performance Policy

This repo tracks GitHub Actions wall time so CI optimization work is driven by
trend data, not one-off slow runs. Use this policy when deciding whether to
split, rebalance, or otherwise optimize CI jobs.

## Current Posture

A pull request runs five jobs, and each is one lane of `tasks/ci-lane.ts`. A
push to the default branch runs the whole corpus over as many lanes as the
planner says it needs. What a lane holds is decided by the packer rather than
by a job definition, so the questions this document used to answer — which
shard is the long pole, how to move a heavy file between shards, when a split
is worth its maintenance cost — are no longer questions anybody answers by
hand.

What is left to keep an eye on is the budget. A lane is packed against
`LANE_BUDGET_SECONDS` in `tasks/test-selection/policy.ts` and its job is killed
at `LANE_BOUND_SECONDS`; the difference is the setup and shipping either side
of the work. A lane that runs long says so in its job summary, along with what
it projected and how much of that projection rests on costs nobody has
measured. `deno task test-selection plan --dry-run` answers the same question
without a run.

GitHub's Team plan allows the organization
[60 parallel hosted runners](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners).
That capacity is shared by every workflow and repository in the organization.
The pull-request path takes five of them and the full run takes as many lanes
as it asked for, so the count to watch is the lane count the planning job
emits.

Two things still make a run slower than it needs to be, and neither is a
sharding decision:

- **A test that costs more than a lane can hold.** The packer reports it as
  unschedulable and runs it nowhere, because a lane holding it would be killed
  before it reported anything. Splitting that test is the fix.
- **A stand-in cost.** A unit no manifest has seen is charged what the middle
  unit of its suite costs, which is a guess. A lane whose summary says most of
  its projection rests on stand-ins is a lane whose timing means little; the
  next publisher run fixes it.

## Required Pull Request Checks

Configure merge protection to require `Status`. The GitHub web interface shows
that check as `CI / Status`, joining the workflow's name to the job's name, but
merge protection stores and matches the job's name on its own.

`Status` runs after every pull request validation job in `deno.yml`. It runs
after failed and skipped dependencies, and it holds two rules: nothing failed,
and at least one of the two test paths succeeded. The second is what stops a
pull request in which both paths skipped from reporting green having run no
tests at all. Add each new pull request validation job to its `needs` list.

Keep pull request path filters out of workflows that provide required checks.
GitHub leaves a required check pending when a path filter prevents its workflow
from starting.

Require checks from other GitHub Apps separately. A GitHub Actions job cannot
depend on a check produced by another app.

## Revisit Triggers

Revisit CI wall-time optimization when at least one of these holds across
normal runs:

- A lane is over its budget, which its job summary says outright.
- The full run's lane count is climbing without the corpus having grown.
- A test is reported as unschedulable, so nothing runs it.
- Required checks take more than 8 minutes from first start to last completion.

## How To Respond

1. Start from a lane's job summary, which says what it planned, what it ran,
   which manifest it read, and how much of its projection rests on stand-ins.
2. Prefer the record store's measured costs over a single outlier run;
   `deno task test-selection explain <identity>` prints what one test costs
   and what it is worth.
3. A test past the sixty-second rule is the thing to split. Nothing else about
   the layout is anybody's to rebalance.

For the pattern integration suites specifically, the time is dominated by
per-pattern CFC compile, not by storage or sync — see
[the profiling snapshot](../history/development/performance/pattern-integration-compile-bound.md)
before optimizing there.

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token; measure per-test timings locally, or read
them out of the record store with `deno task test-selection explain`.

Jobs and steps for a run:
`GET /repos/commontoolsinc/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

The team ops dashboard's `/bench?view=ci` page provides repeated-run analysis
for labs and loom. It reports overall workflow duration and individual job
duration. Matrix jobs are grouped using the trailing-parenthesis base names from
`scripts/ci-gantt.ts`, with the slowest lane tracked across runs.

For a requested history window, the collector retains every successful main
push build when there are at most 200. Larger sets are sorted chronologically
and reduced to exactly 200 builds spread evenly through that run sequence,
including its oldest and newest builds.

## Step Phase Markers

`scripts/ci-gantt.ts` draws each job as a bar and splits that bar into three
segments — setup, work, and shutdown — so the shared scaffolding around a job is
visually separated from the job's own work. For a matrix job this shows, per
lane, how much wall time is setup that every lane repeats versus the unique
work that one lane does.

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
in `tasks/ci-step-phases.ts`, keeping the one-emoji-one-phase rule.

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
| 🗃️ | restore a cached native library |
| 🧮 | compute a cache identity |

**work** — the job's actual purpose:

| Emoji | Used for |
| --- | --- |
| 🔎 | checks (format, type, patterns, attestations) |
| 🔢 | work out how much work there is |
| 🚧 | guard that fails the build on a banned pattern |
| 🩹 | check for unresolved merge-conflict markers |
| ✅ | validate an artifact a previous step produced |
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
classifies them by name. Current jobs use `Set up job`, `Post …`, and `Complete
job`. Retained records can also contain `Set up runner` and `Complete runner`.
The two set-up steps count as setup and the rest as shutdown. Any other step
that reaches the chart without a recognized marker is counted as "other", drawn
in gray, and listed on standard error when the script runs, so a missing marker
is easy to find and fix.

## Cache Keys And Post-Job Saves

The combined `actions/cache` action restores during setup and saves in a
post-job step. GitHub evaluates expressions in the action's inputs again for
that save. A `hashFiles()` call written directly in `with.key` therefore walks
the checkout twice: once before the work and once after it.

When a job writes a large generated tree under the checkout, that second walk
can become much more expensive than the first. The workspace test jobs are the
important case here: raw V8 coverage can contain hundreds of thousands of files
by the time post-job steps run.

Resolve any workspace-wide dependency hash in an ordinary setup step and write
it to `GITHUB_OUTPUT`. Give the cache action that step output as its key. The
post-job save can reevaluate the output reference safely because its value was
fixed before the job populated the workspace. The `deno-setup` composite action
uses this shape for the shared Deno dependency cache.

## Step And Job Timeouts

Every work step in `.github/workflows/deno.yml` carries its own
`timeout-minutes`, and the `timeout-minutes` on the job around it is at least ten
minutes larger. The two bounds do different things when they are reached.
GitHub ends a job that runs past the bound on the job by cancelling it, so the
job's conclusion is `cancelled` — the conclusion that a run stopped by hand or
superseded by a newer push also carries, and one that reads as nobody's fault. A
step that runs past the bound on the step fails, and its job fails with it. The
headroom between the bounds is what the setup and upload steps around the work
normally need. An individual wedged step can therefore reach its step bound and
report a failure before the outer job bound. The outer bound remains the final
limit when several steps in one job consume unusual amounts of time.

The minutes are written once. The top of the workflow declares them as YAML
anchors, which GitHub Actions has accepted since September 2025:

```yaml
env:
  WORK_TIMEOUT_MINUTES: &work-timeout 30
  JOB_TIMEOUT_MINUTES: &job-timeout 40
```

Every job then reads `timeout-minutes: *job-timeout` and every work step
`timeout-minutes: *work-timeout`. Changing either bound is one edit. The
environment variables are how a workflow declares a value an anchor can name;
nothing reads them, and merge keys (`<<:`) remain unsupported, so an anchor
cannot carry a block that a job then overrides.

An anchor with no job aliasing it is a bound nothing holds anything to, so
the pair goes when the last job that read it does. `tasks/ci-workflow.test.ts`
holds every bound to being an alias; it does not ask whether every anchor is
used, which is a thing to check by eye when a job is deleted.

The lanes take a pair of their own, and theirs is not the same number as the
budget they are packed against. `LANE_BOUND_SECONDS` and
`FULL_LANE_BOUND_SECONDS` in `tasks/test-selection/policy.ts` are what the
packer aims at; the anchors here are where the runner gives up. The two are
deliberately far apart.

The budget governs what the packer *chooses* to add to a lane. It does not
govern what must run — what the change touched, and every unit no manifest has
seen — and a mandatory set larger than the budget is placed anyway, because a
test that must run and does not is the one failure this design refuses. A lane
over its budget says by how much in its summary and finishes. So the bound on
the step is generous: a lane that reaches it is one nothing is going to finish,
not one that was given more than its share.

A job needing its own bound adds a pair of anchors alongside these rather than
a number next to the step.

The deploy jobs carry no bound at all. A deploy hands the work to a script that
lives outside this repository, and a bound here would cancel a deploy this
workflow has no way to size. `tasks/ci-workflow.test.ts` names those jobs and
asks nothing of them.

For every other job, that test fails the `Check` job when a work step has no
bound, when a job has none, when a bound is written as anything but an alias to
an anchor, or when fewer than ten minutes separate the step's anchor from its
job's.

## What a lane runs, and how it is decided

`.github/workflows/deno.yml` names no test surface. `tasks/test-topology.ts`
declares every suite the repository has — what setup it needs, how to list the
things its runner can be pointed at, how to recognize its own records, and what
command runs a chosen subset — and `tasks/ci-lane.ts` reads it. Adding a test,
a kind of test, or a configuration of existing tests is a change to a module
under `tasks/test-topology/` and never a change to the workflow.

A lane packs its share by cost, and every cost is measured on every run rather
than transcribed from one. There is no weight table to refresh and no matrix to
rebalance. `deno task check-test-topology` fails on a test file no suite claims
and on a recorded identity no suite recognizes, which is what stops a surface
being added and then quietly running nowhere.

Where a package's own runner still divides its work, it does so for reasons of
its own rather than for CI. The CLI package keeps tests that share
process-wide state in a serial group and runs the rest with `--parallel`.

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
