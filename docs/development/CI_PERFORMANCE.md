# CI Performance Policy

This repository tracks GitHub Actions wall time so that work on it is driven
by trend data rather than by one-off slow runs. Use this policy when deciding
whether a run is slow enough to act on, and what to do about it.

## Current Posture

A pull request runs five jobs and a push to `main` runs one lane per share of
the whole corpus, and neither number is written in the workflow. The five come
from `LANES` in `tasks/test-selection/policy.ts`; the push count comes from
`deno run -A tasks/ci-lane.ts --full --lane-count`, which reads the working
tree against the manifest. `docs/development/test-selection.md` is the
operating guide for both.

GitHub's Team plan allows the organization
[60 parallel hosted runners](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners).
That capacity is shared by every workflow and repository in the organization,
and the full run is what can fill it. A pull request takes five runners.

Each pull-request lane is packed to finish inside `LANE_BOUND_SECONDS`, and a
lane of the full run inside `FULL_LANE_BOUND_SECONDS`. Those are the numbers to
move when a lane runs long, and the workflow's `lane-work-timeout` and
`full-lane-work-timeout` anchors are the same numbers in minutes. Moving one
without the other leaves a lane packed against a budget its job will not allow
it, or a job waiting past the budget it was packed against.

Rebalancing is not something anybody does here any more. What a test costs is
measured on every run and published in the manifest, and the packer distributes
items by that cost. A lane that runs long is a cost model that has drifted or a
test that got slower, and both are visible in the lane's own job summary, which
prints what it planned against what it spent.

## Required Pull Request Checks

Configure merge protection to require `Status`. The GitHub web interface shows
that check as `CI / Status`, joining the workflow's name to the job's name, but
merge protection stores and matches the job's name on its own.

`Status` needs `pr-tests` and `full-tests`, and exactly one of them runs: the
five selected lanes, or the full run the `ci: full` label asks for. Its rule has
two clauses. Every dependency is `success` or `skipped`, so the path that did
not run does not fail it. And at least one of the two is `success`, so a pull
request on which both were skipped — mislabelled, or excluded by an `if:`
somebody got wrong — fails rather than reporting green over no tests at all.

A new test surface adds no job and changes nothing here. It is a suite under
`tasks/test-topology/`, and the lanes pick it up.

Keep pull request path filters out of workflows that provide required checks.
GitHub leaves a required check pending when a path filter prevents its workflow
from starting.

Require checks from other GitHub Apps separately. A GitHub Actions job cannot
depend on a check produced by another app.

## Revisit Triggers

Revisit CI wall time when at least one of these holds across normal runs:

- A lane finishes past the budget it was packed against, and its summary shows
  the overrun is the plan rather than one slow test.
- The five pull-request lanes finish at visibly different times, which says the
  cost model behind the packing has drifted.
- A test is named in a lane's summary as unschedulable, meaning it costs more
  than a lane can hold and so runs nowhere on a pull request.
- The full run's lane count climbs without the corpus having grown.

## How To Respond

1. Read the lane's job summary. It prints the manifest it resolved, which
   batches it ran, what each was expected to cost, and what it spent.
2. A projection resting on stand-in costs says so in that summary. Such a lane
   is not evidence about the cost model; it is a lane whose tests the store has
   not measured yet.
3. For one test that got slower, fix the test. For a whole suite that did, look
   at the fitted `suiteOverhead` and `correction` the manifest carries for it.
4. Move a dial only from a measurement. Every dial is in
   `tasks/test-selection/policy.ts`, and `deno task test-selection dials`
   prints each one with the reason to move it.

Splitting or rebalancing a job is not a response any more. The packer decides
what goes where, and `deno task test-selection plan --dry-run` says what it
would decide before anything runs.

## Pattern Integration Sharding

`packages/patterns` shards its own integration task, and that is the one place
sharding survives. A lane asks the suite for a set of files, so the shard
variable is not what CI uses; what remains is the contract a file inside that
package follows.

Most integration test files are one file. Tests that sweep a pattern list divide
their own cases with `PATTERN_INTEGRATION_SHARD`, and an unset variable selects
every case, so the ordinary local command remains unsharded.

`INTERNALLY_SHARDED_PATTERN_INTEGRATION_FILES` in
`tasks/select-pattern-integration-files.ts` is the list of files that divide
their cases that way. Those files select their cases through
`packages/patterns/integration/pattern-integration-shard.ts`. The selector tests
verify that every real integration file follows one of these two contracts.

Use internal sharding for a single file with many independent, expensive cases.
Add persistent outliers in the compile-all-patterns sweep to
`COMPILE_ALL_PATTERN_SHARD_ASSIGNMENTS`. This moves the named case without
changing the default positions of the other cases.

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

The lanes take two further pairs. `lane-work-timeout` at five minutes and
`lane-job-timeout` at fifteen bound a pull-request lane; `full-lane-work-timeout`
at ten and `full-lane-job-timeout` at twenty bound a lane of the full run. Each
work bound is the budget the packer packed that lane against, written in
minutes, so the two move together. A job needing its own bound adds a pair of
anchors alongside these rather than a number next to the step.

The deploy jobs carry no bound at all. A deploy hands the work to a script that
lives outside this repository, and a bound here would cancel a deploy this
workflow has no way to size. `tasks/ci-workflow.test.ts` names those jobs and
asks nothing of them.

For every other job, that test fails when a work step has no
bound, when a job has none, when a bound is written as anything but an alias to
an anchor, or when fewer than ten minutes separate the step's anchor from its
job's.

## The Lane Shape

Both lane jobs run the same script and differ in two values: whether selection
is on, and which lane of how many this one is.

    deno run -A tasks/ci-lane.ts --lane 3 --of 5 --base origin/main
    deno run -A tasks/ci-lane.ts --full --lane 1 --of 58

Their steps are fixed and do not vary with what the lane runs: check out at
full depth, set up Deno, install, restore `.ci-cache`, set the kernel core
pattern, run the lane, upload what a failing lane left behind, upload the
coverage reports, ship test records. Everything conditional happens inside the
lane runner, which is what makes the workflow independent of the topology.

The cache step covers one directory under one exact key. A capability that
finds a binary under `.ci-cache` uses it without asking what it was built
from, so the key hashes the sources a binary is built from and carries no
restore-key prefix. The key also carries the lane number: the packing is
stable, so lane N tends to want the same binaries run after run, and five lanes
saving one key would keep only whichever finished first.

A lane that failed keeps its own working directory, under the job's temporary
directory, and the upload step carries it out. A server's log is written there,
and a lane that failed is when somebody wants to read one. A lane that passed
removes it.

The root `deno task test` is `tasks/test.ts`, which is what somebody runs
locally. It reads the workspace list from `deno.jsonc` and runs `deno task
test` in every member, using half the available cores for package workers —
two on a four-core machine. `TEST_CONCURRENCY` overrides that for a diagnostic
run. When a package fails it prints that package's captured output immediately
and stops starting new package tests. CI does not run it: a lane invokes each
member's test task directly, one file at a time where the member's task is a
single `deno test`.

### Tests That Cannot Run Beside Another

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
