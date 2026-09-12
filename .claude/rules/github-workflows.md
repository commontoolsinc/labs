---
paths:
  - ".github/workflows/**"
---

# Editing a CI workflow

## A deploy step has a counterpart outside this repository

The deploy jobs open an SSH connection to the bastion and run one script there.
That script belongs to the infra repository, not this one, so a change to what
a job passes it only works once the matching infra change has landed and been
deployed. `docs/development/deploying.md` describes which jobs deploy where and
what the wrapper accepts.

The staging deploy jobs trigger on pushes to `main`, so a change to one of them
cannot be exercised on a branch. Reason it through before merging rather than
after.

## Step names carry a phase marker

A step is placed into a phase — setup, build, test, upload — by the marker
emoji its name begins with. The vocabulary is defined in
`docs/development/CI_PERFORMANCE.md` under "Step phase markers" and mirrored in
`PHASE_MARKERS` in `tasks/ci-step-phases.ts`. A step whose name starts with a
marker that is in neither list is silently charted as "other", which is how
setup time disappears from the timings people use to decide what to optimize.
Adding a marker means editing the document and the module together.

## A work step carries its own timeout

In `.github/workflows/deno.yml`, every step whose marker puts it in the work
phase carries `timeout-minutes: *work-timeout`, and its job carries
`timeout-minutes: *job-timeout`, which is the ten minutes longer. GitHub
cancels a job that runs past the bound on the job, so that job's conclusion is
`cancelled` rather than `failure`, and a wedged test then looks like a run
somebody stopped. A step that runs past the bound on the step fails, and the
job fails with it.

Both aliases point at YAML anchors declared in the `env:` block at the top of
the file, which is where the minutes themselves are written. Add a work step
and you add the alias, not a number; a job that needs its own bound adds a pair
of anchors there, as the lanes have. A lane's work bound is
`LANE_BOUND_SECONDS` or `FULL_LANE_BOUND_SECONDS` from
`tasks/test-selection/policy.ts` written in minutes — the bound the lane is
killed at, which the budget it is packed against is derived from — so the
anchor and that constant move together. The deploy jobs are
the exception and carry no bound, because a deploy's duration is set by a
script in another repository. `tasks/ci-workflow.test.ts` names those and holds
every other job to the shape: it fails when a bound is missing, when it is
written as a number rather than an alias, or when a step's anchor is fewer than
ten minutes below its job's.

## Adding a test surface is not a workflow edit

A pull request runs five `pr-tests` lanes and a push runs one `full-tests` lane
per share of the corpus, and both run the same script. Which tests each of them
runs comes from `tasks/test-topology.ts` and the manifest, so a new test
surface is a suite under `tasks/test-topology/` and never a job here. `deno task
check-test-topology` fails on a test file no suite accounts for, and on a step
under `.github/` that records a test by hand — a lane records what it ran
through the suite that owns it, so a recording step in a workflow is either a
test no suite knows about or a second run of one a lane already carries.

`tasks/ci-workflow.test.ts` holds that to a checked property: it lists the
things a workflow may not name — a suite, a shard count, a server-execution
arm, a skip list — and fails on any of them.

## A workflow that runs tests ships test records

The two lane jobs set `CF_TEST_RECORDS_DIR` to a workspace spool and end with a
`📤 Ship test records` step using the `./.github/actions/test-records-ship`
composite action, `if: always()`, with the job's display name and its lane
number in `artifact:`. Neither carries a `variant:` or a `junit:` input: a lane
may hold default and non-default batches at once, so a job-wide variant could
not represent it, and the lane runner gathers each batch's records as it
finishes and applies that suite's own variant there. The contract is
`docs/specs/test-records.md`; the wiring recipe is "Covering a new test surface"
in `docs/development/test-records.md`.

A workflow whose every test another workflow already records against the same
commit records nothing: no spool directory, no `run-recorded` wrapper, no ship
step. Recording there would file each of those tests twice against one commit.
The Dashboard workflow's tests job is one, and the relay does not follow that
workflow.

A check that no lane can be asked to run records nothing either, for the same
three reasons. `docs/specs/test-records.md` under "Recording" holds the
criterion. The `Coverage Report` job in `deno.yml` is one, because it reads the
coverage artifacts of every lane in its own run; the CFC Property Suite's audit
step is the other, because it reads the corpus the suite in the step before it
has just written. A gate comparing against a base ref is not this:
`check-baselines-append-only` and `check-test-aliases` each resolve a merge
base, and both record — through their suite, inside a lane.

## Before reaching for a job

`docs/development/CI_PERFORMANCE.md` says what a slow run calls for, and the
answer is almost never a job: the packer decides what goes where, and
`deno task test-selection plan --dry-run` says what it would decide before
anything runs.
