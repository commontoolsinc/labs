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
`PHASE_MARKERS` in `scripts/ci-gantt.ts`. A step whose name starts with a
marker that is in neither list is silently charted as "other", which is how
setup time disappears from the timings people use to decide what to optimize.
Adding a marker means editing the document and the script together.

## Before splitting or rebalancing jobs

`docs/development/CI_PERFORMANCE.md` says when that work is worth starting and,
more usefully, when to stop. Read it first; the answer is often that the jobs
are already close enough.
