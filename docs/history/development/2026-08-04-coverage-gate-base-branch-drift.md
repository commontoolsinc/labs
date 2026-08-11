---
status: historical
created: 2026-08-04
archived: 2026-08-04
reason: "Investigation finding: why Coverage Check failed packages/runner at random, and what the measurement actually depends on."
---

# Why Coverage Check failed `packages/runner` at random

Coverage Check failed pull request #5198 on `packages/runner` with 5747
uncovered lines against a baseline of 5746. A run seventeen minutes earlier, on
a head that differed only in three `packages/content-hash` files, reported 5746
and passed. The failure looked like measurement noise. It was not.

## What the two runs actually measured

The two runs checked out different trees:

```text
run 30514963895 (04:50)  HEAD is now at cdd97f5 Merge 66ef4bf2 into f69af094c
run 30515725503 (05:07)  HEAD is now at 90a4c9e Merge 5d89521c into c8afb078b
```

A `pull_request` run checks out `refs/pull/<number>/merge`, and GitHub rebuilds
that merge ref whenever the base branch moves. Between the two runs,
`c8afb078b` — "feat(runner): map every instantiated pattern back to its source
file" (#5196) — landed on `main` at 05:04:32Z. It touched eight files under
`packages/runner/src`. So the runner source was not identical between the two
runs at all; only the two pull request heads were.

Both runs took their baseline from the same `main` run, 30504402912 at
`a5dde681`, which predates `c8afb078b`. The failing run therefore measured
`main`'s newer code against a baseline that did not contain it.

The gate had already noticed and said so, one line before failing the run:

```text
Warning: Newest successful baseline run 30504402912 (2026-07-30T01:00:42Z) is
for a5dde681..., but current main is c8afb078b...
```

## Confirming it, and finding the one line

Scoring the two trees with the gate's own code (`collectSourceFiles`,
`parseLcov`, `countUncoveredProfileLines` from `tasks/coverage-metrics.ts`) and
the combined `main` LCOV reports published to
`gs://commontools-build-artifacts/workspace-artifacts/labs-<sha>.lcov`:

| tree | LCOV | `packages/runner` |
| --- | --- | --- |
| `f69af094c` | `f69af094c` | 5746 |
| `f69af094c` | `c8afb078b` | 5746 |
| `c8afb078b` | `f69af094c` | 5747 |
| `c8afb078b` | `c8afb078b` | 5747 |

The number tracks the tree and ignores the coverage data entirely. That falls
out of how the metric is computed: for a file that *has* an LCOV record, the
score counts the zero-hit lines that record names and never reads the file, so
the tree can only change the number through files that have *no* record.

The per-file difference between the two trees was a single file:

```text
packages/runner/src/harness/types.ts   114 -> 115
```

`types.ts` declares interfaces and nothing else. It compiles to no executable
statements, so Deno's coverage never emitted a record for it, and at the time
the gate charged every one of its tracked lines as uncovered — debt no test
could pay. `c8afb078b` added a nine-line block to it, one line of which is code
and eight of which are a doc comment. Debt went 114 → 115, `packages/runner`
went 5746 → 5747, and because the ratchet parks every group at exactly its
baseline, that was enough.

That charge is gone: the gate now compiles a file it finds no record for and
charges it nothing when nothing comes out, so this particular line can no longer
move a group's total. What made the failure possible in general — a baseline
measured at a different commit from the run — is what the fix below addresses.

The `packages/toolshed` movement noted alongside this (−25 in one run, −23 in
the other, with unchanged toolshed source) has the same origin by a different
route: `c8afb078b` also rewrote `packages/cli/lib/test-runner.ts` and the piece
state-continuity harness, which changes what the tests execute.

## The fix

The ratchet now uses the `main` run for the base-branch commit the run merged,
so the baseline and the measurement cover the same base-branch code and the only
difference left between them is the pull request. Runs that are not ancestors of
that commit are never used, which closes the mirror-image case: a `main` run
that finished after the base commit measured code the run does not contain. When
no `main` run has measured the base commit, the nearest ancestor with one stands
in, and the groups the base branch changed in between are reported and not
gated.

Two things had to be read carefully to make it correct:

- The base-branch commit cannot come from the triggering event. This run's
  payload carried `pull_request.base.sha: f69af094c` and
  `merge_commit_sha: cdd97f5` — both describing the *previous* run — while the
  checkout merged `c8afb078b`. GitHub does not rewrite the event when it
  rebuilds the merge ref.
- It cannot be read with `git log --format=%P` either. `actions/checkout`
  clones to depth one, and git reports a shallow boundary commit as having no
  parents. `git cat-file commit HEAD` prints the stored object, which keeps
  them.

The live description is in [`COVERAGE.md`](../../development/COVERAGE.md).
