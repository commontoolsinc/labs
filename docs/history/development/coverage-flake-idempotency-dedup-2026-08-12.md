---
status: historical
created: 2026-08-12
archived: 2026-08-12
reason: "Investigation record: the two uncovered lines that failed the coverage gate on PR #5711, which the suggestion comment could not tie to a file."
---

# The two lines a benchmark-only pull request was charged for, August 2026

## Conclusion

[PR #5711](https://github.com/commontoolsinc/labs/pull/5711) changed a
benchmark file, two dashboard files and some documentation. Its Coverage Check
job reported `packages/runner` at 4614 uncovered lines against a `main`
baseline of 4612, and the suggestion comment said it could not tie the increase
to any file in the diff.

The two lines are 333 and 334 of
`packages/runner/src/scheduler/diagnosis.ts`: the early `return` and its
closing brace inside the guard that stops `runIdempotencyRecheck()` recording a
second violation for an action it has already recorded one for.

```ts
const actionId = state.getActionId(action);
// Deduplicate: only record first violation per action.
if (state.idempotencyViolations.some((v) => v.actionId === actionId)) {
  return;
}
```

Nothing in the pull request could have added a tracked line to that group. Its
only change under `packages/runner` is to `test/cell.bench.ts`, which the
metric excludes twice over: `test` is an excluded path segment and `.bench.ts`
an excluded file suffix. The suggestion comment could not name a file because
it looks for newly added lines among the changed files, and the changed files
contributed none.

Those two lines run only when one action is caught being non-idempotent twice
in a single process. Whether that happens is a scheduling race, so the lines
are covered on some runs and not on others, and `packages/runner` was sitting
exactly at its baseline with no headroom for the difference.

## What the runs measured

Every count below is from the `Test (7/8)` job's LCOV artifact, reading the
lines of `runIdempotencyRecheck()`: line 326 counts arrivals at the
external-move check, which is one per detected violation; line 336 counts
violations actually recorded; line 333 counts the duplicates turned away.

| Run | What it was | Detections (326) | Recorded (336) | Duplicates (333) |
| --- | --- | ---: | ---: | ---: |
| 31634280324 | `main` at `96b4086a`, the baseline | 4 | 3 | 1 |
| 31635473455 | PR #5711, the failing run | 3 | 3 | 0 |
| 31636354109 | PR #5711, the next run | 4 | 3 | 1 |
| local | the one test file, run by hand | 3 | 3 | 0 |

The source under `packages/runner` is identical across all four. Three
violations are recorded every time; what moves is whether a fourth detection
arrives for an action already recorded.

Rescoring both CI artifact sets against the checkout with the gate's own
`tasks/coverage-metrics.ts` reproduces the job's numbers exactly — 4612 for the
baseline and 4614 for the failing run, along with 276763 and 276767 for the
whole workspace, 641 and 643 for `packages/memory`, and 76 for both readings of
`packages/dashboard`. So the whole of the gated increase is those two lines,
and no other file in the group moved.

The run immediately after the failing one, against the same baseline run and
with the same source, measured 4612 and passed.

## Where the detections come from

Shard 7 of 8 runs the CLI package's test slices 1, 8 and 9, plus `shell` and
`identity`. The idempotency rechecks all come from one file in slice 1,
`packages/cli/test/test-runner-expect-non-idempotent.test.ts`: running that
file alone reproduces the whole shard's counts, three detections and three
recorded violations. It drives three fixtures that are genuinely
non-idempotent, each an accumulator that appends to the log it reads.

Reading the log it appends to is what makes such a computation re-trigger
itself: the write schedules another run, and every run gets its own idempotency
recheck. The first recheck records the violation. A second recheck for the same
action reaches the dedup guard and returns. Whether a second run happens before
the test's assertions settle and the runtime is disposed is a race between the
scheduler draining its queue and the test finishing, and CI runs that file
alongside thirteen others under `deno test --parallel`.

## What was done

`packages/runner/test/scheduler-pull-idempotency.test.ts` gained a case that
reaches the guard deterministically: an action that writes an incrementing
count, so that every run differs from the recheck that verifies it, run twice
by moving an input it reads. That is four invocations, two detections and one
recorded violation, and the recorded one carries the writes of the first
detection rather than the second. Removing the guard fails the test with two
violations recorded.

## Also moving, but not gated

Two other files differed between the same two runs, and neither was gated for
this pull request:

- `packages/memory/v2/client.ts` lines 1101 and 1102, the `#closed` guard in
  `scheduleAck()`, covered exactly once by the `package-runner` job in the
  baseline run and not at all in the failing one. This is the same kind of
  race, and it will charge two lines to the next pull request that touches
  `packages/memory` while the group has no headroom.
- `packages/integration/page.ts`, seven lines, which the metric does not track
  at all: `integration` is an excluded path segment.
