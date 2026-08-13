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
of anchors there, as the CLI integration suites have. The deploy jobs are the
exception and carry no bound, because a deploy's duration is set by a script in
another repository. `tasks/ci-workflow.test.ts` names those and holds every
other job to the shape: it fails the `Check` job when a bound is missing, when
it is written as a number rather than an alias, or when a step's anchor is
fewer than ten minutes below its job's.

## Before splitting or rebalancing jobs

`docs/development/CI_PERFORMANCE.md` says when that work is worth starting and,
more usefully, when to stop. Read it first; the answer is often that the jobs
are already close enough.
