---
status: historical
created: 2026-07-29
archived: 2026-07-29
reason: "Investigation record: why PR #5128, a type-rename-only change, had to accept coverage debt. The date in the filename is the day of the CI runs it analyses."
---

# Why a rename-only pull request owed coverage debt, July 2026

## Conclusion

[PR #5128](https://github.com/commontoolsinc/labs/pull/5128) renamed two
TypeScript type aliases and changed no executable code, yet the coverage ratchet
reported `packages/runner` at 6898 uncovered lines against a `main` baseline of
6896, so the author accepted the debt with an override.

The pull request did not add those two lines. Its coverage of `packages/runner`
was identical, line for line, to the `main` run immediately before its baseline.
The baseline had dropped by two lines because a different pull request landed on
`main` in the twelve minutes between when #5128 last merged `main` and when its
coverage job ran.

Underneath that, the metric itself is far noisier than the gate's zero-line
tolerance. Across five hours of `main` runs on 2026-07-28 the
`packages/runner` count took four distinct values — 6896, 6898, 6935, 6937 —
with no change to any source file in that package. Two independent mechanisms
produce the swing, and both are described below.

## What the numbers actually were

The gate compares a pull request against the newest non-cold `main` run, not
against a run of the pull request's own merge base. The relevant runs, in order:

| Time (UTC) | `main` commit | Landed pull request | `packages/runner` uncovered |
| --- | --- | --- | ---: |
| 21:21 | `704d3108` | #5122 | 6909 |
| 21:51 | `8be27e5c` | #5094 | 6937 |
| 21:58 | `62d16cc2` | #5124 | 6898 |
| 22:06 | `fc9572aa` | #5129 | 6896 |
| 23:00–23:11 | three runs | — | 6896 |
| 23:15 | `2567081a` | #5126 | 6935 |

A `pull_request` run does not test the pull request's own head. It checks out
`refs/pull/N/merge`, GitHub's synthetic merge of that head onto `main`, so the
`main` commit a run was measured on top of is that merge commit's **first
parent** — not the pull request's merge base, which can be hundreds of commits
back. For PR #5128 the tested tree was `6f5e5449`, whose first parent is
`8be27e5c`: the run that measured 6937.

PR #5128's own coverage job measured 6898. Against the `main` it was tested on
top of it was 39 lines *better*. Against the baseline the gate chose,
`fc9572aa`, it was 2 lines worse.

Joining the 159 LCOV shard reports from each run and differencing them per file
gives the exact accounting. Comparing PR #5128's run to the `62d16cc2` `main`
run: zero files differ. Comparing it to the `fc9572aa` baseline: exactly two
lines differ, in two files the pull request never touched.

- `packages/runner/src/builtins/fetch-utils.ts:69`
- `packages/runner/src/builtins/flatmap.ts:128`

## Mechanism one: adding any runner test file re-partitions the shards

`tasks/select-runner-test-files.ts` splits `packages/runner/test/*.test.ts`
across five shards by round-robin over the sorted filename list. Inserting one
file moves every alphabetically later file into a different shard.

PR #5129, which landed at 22:06 and became #5128's baseline, added
`packages/runner/test/fake-clock-lockdown-classification.test.ts`. That name
sorts before every `fetch-*` and `list-*` test, so 294 of the suite's 505 test
files changed shard. Both of the two lines above sit in code that those tests
drive.

The two lines then moved for different reasons.

### `fetch-utils.ts:69` — a line-attribution artifact, not a behavior change

The line is the `} else {` of a two-branch conditional:

```ts
// Shown for illustration only.
if (Object.keys(normalizedOptions).length > 0) {   // line 67
  inputsOnly.options = normalizedOptions;          // line 68
} else {                                           // line 69
  delete inputsOnly.options;                       // line 70
}
```

The else branch ran exactly once in every run examined — line 70 reports one
hit in all of them. What changed is which shard process ran it. V8 collects
coverage as byte ranges, and a process that takes only one of the two branches
reports the other as an uncovered range whose boundary falls on line 69. So a
shard that only takes the if branch reports `DA:69,0`, and a shard that only
takes the else branch also reports `DA:69,0`. The join sums per-line counts
across shards, and zero plus zero is zero, so the line scores as uncovered even
though both branches demonstrably executed. After the re-partition both
workloads landed in the same process, which reported `DA:69,11`, and the line
scored as covered.

Raw evidence, one shard report each:

```text
main 704d3108, shard runner-1 (if branch only)      DA:67,10  DA:68,10  DA:69,0   DA:70,0
main 704d3108, shard runner-4 (else branch only)    DA:67,0   DA:68,0   DA:69,0   DA:70,1
main 2567081a, shard runner-1 (both, one process)   DA:67,11  DA:68,10  DA:69,11  DA:70,1
```

This is the cross-shard form of a single-process artifact. In one process a
guard line reads as uncovered because its branch is not taken, which is
expected: V8 counts byte ranges, and a whole-line count is a projection of them.
Here the branch *is* taken, in a different process, and summing the shard
reports loses that fact.

deno fixed this attribution. On 2.8.1, the version pinned when this ran, and on
2.8.3, a process that takes only the if arm reports the `} else {` line as 0
hits; on 2.9.4 it reports the count of the arm that ran, so summing the shards no
longer loses the else branch. Reduced case, `if (n > 0) { … } else { … }` called
once with a positive argument, lines 3 to 7:

```text
deno 2.8.3   DA:3,1  DA:4,1  DA:5,0  DA:6,0  DA:7,0
deno 2.9.4   DA:3,1  DA:4,1  DA:5,1  DA:6,0  DA:7,0
```

### The sibling artifact, fixed in the same release

Through 2.8.x a trailing comment on a guard line changed that line's reported
count, which a comment cannot justify since it does not execute. The live note
on guard-line coverage carried this reproduction, and it is kept here because
the behaviour it isolates no longer occurs:

```ts
// guard.ts
function noComment(x: unknown): number {
  if (!x) throw new Error("e");
  return 1;
}
function withComment(x: unknown): number {
  if (!x) throw new Error("e"); // a trailing comment
  return 1;
}
if (import.meta.main) {
  noComment({}); // truthy argument: the `if (!x)` branch is never taken
  withComment({});
}
```

```text
deno 2.8.3   DA:2,0  DA:3,1  DA:6,1  DA:7,1
deno 2.9.4   DA:2,0  DA:3,1  DA:6,0  DA:7,1
```

`noComment` and `withComment` hold identical executable code and are each called
once with a truthy argument. On 2.8.3 the commented form reported 1 hit and the
uncommented form 0, because deno credited the line to whatever byte range ended
it — the un-taken branch statement when nothing followed, the covered trailing
comment when one did. On 2.9.4 both report 0. What survives on every version is
the first line of each pair: a guard whose branch is never taken reads as
uncovered, by design.

Searching deno's issues while this stood found no existing report of either
artifact. The closest,
[denoland/deno#9865](https://github.com/denoland/deno/issues/9865), is closed
and covers off-by-one line and branch counts around an `if`/`else` block rather
than either of these. Both were fixed upstream before a report was filed.

### `flatmap.ts:128` — a real difference in what the tests did

The line is the array arm of the `contribute` callback the flatMap builtin hands
to the resume republisher. Before the re-partition it executed zero times across
the entire suite; afterwards it executed 47 times in one shard. The number of
`contribute` calls changed as well, from 31 to 47. So here the tests genuinely
took a different path once their grouping into processes changed — the flatMap
resume and republish tests are sensitive to what else shares their process.

## Mechanism two: a wall-clock branch in traverse.ts, worth 39 lines

This one was already diagnosed, in the description of
[PR #5087](https://github.com/commontoolsinc/labs/pull/5087) on the same day.
It is repeated here because it was still live afterwards, and because it is the
larger of the two sources of movement in this group.

`packages/runner/src/traverse.ts` ends each traversal with a diagnostic guarded
on elapsed time:

```ts
// Shown for illustration only.
const elapsed = logger.timeEnd("traverse") ?? 0;
if (elapsed > 100) {
  // ... assemble and log a slow-traverse warning, reading
  // this.schemaTracker.size and this.schemaTracker.totalValues
}
```

Whether that branch is ever taken during a CI run depends on how loaded the
machine was. In the runs examined it fired once or twice across a whole run, or
not at all, always from a pattern-integration shard:

```text
main 8be27e5c   no shard fired      39 lines uncovered
PR  #5128       pattern-integration-3 and -4 fired once each   covered
main fc9572aa   pattern-integration-4 fired twice              covered
```

The block is 32 lines, and it is the only caller of `MapSet.size` and
`MapSet.totalValues`, which are another 7 lines. So one timing-dependent branch
decides 39 lines of the `packages/runner` total. That is the 6896 versus 6935
step in the table above: the 23:15 run landed PR #5126, which touches only
`packages/cli` and `docs/tutorial`, and `packages/runner` rose by exactly 39.

## Why the gate cannot absorb this

The ratchet's tolerance is zero lines. The measurement's own run-to-run spread
in this one group is 39 lines from the traverse branch, plus a few more whenever
the runner test file list changes. A rename-only pull request has no way to
influence either.

Seven of the sixty most recently merged pull requests carry a coverage override
in their descriptions, spread across `packages/runner`, `packages/cli`,
`packages/toolshed`, and `packages/memory`. Two of them accept `packages/runner`
at 6948, which is the traverse swing being paid for rather than fixed.

An accepted override does not raise the baseline value for later pull requests.
`applyBaselineOverrides` in `tasks/ci-check-lib.ts` truncates the metric's
sample timeline to start at the overriding commit, and the baseline is still the
newest non-cold sample in what remains. So an override forgives one pull request
and discards older history for that metric; it does not pin the number.

## What removes each cause

Policy is that coverage does not depend on wall-clock performance or on how the
tests were sharded, so the fix for each of these is a test that covers the line
on every run and under every configuration — not a looser gate and not an
override. [COVERAGE.md](../../development/COVERAGE.md) states the policy.

- `flatmap.ts` is fixed. The contribution the flatMap builtin hands to the
  resume republisher is now a named export, and `resume-republish-unit.test.ts`
  drives all three of its arms — array, scalar, and still-pending — through
  the real republisher with hand-built inputs. The array arm no longer waits
  for a resume that happens to produce an array-valued element result.
- The slow-traverse diagnostic is fixed, in
  [PR #5108](https://github.com/commontoolsinc/labs/pull/5108). The field
  assembly moved into a function a unit test can call, and the threshold
  comparison moved off the call site into a method the tests drive from both
  sides — 150ms reports, 5ms is silent, and the boundary is pinned exactly at
  100ms silent and 101ms reporting. Leaving the comparison at the call site
  would not have been enough: an `if` whose body never runs marks the `if` line
  uncovered too, so one line would have kept flapping, and against a
  zero-tolerance ratchet a one-line swing fails a pull request exactly as a
  39-line swing does.
- `fetch-utils.ts:69` is fixed, by the toolchain rather than by this
  repository. deno 2.9.4 corrects the line attribution that produced it: on
  2.8.3 a process taking only one arm of a two-arm conditional reports the
  boundary line as 0 hits, and on 2.9.4 it reports the count of the arm that
  ran. The pin moved to 2.9.4 the day after this investigation, so summing the
  shard reports no longer loses that branch.

## How to reproduce this analysis

Download the `coverage-profile-*` artifacts from the pull request's run and from
the `main` runs on either side of it, then for each run join every shard's LCOV
into one map from source line to total hits and difference the resulting
uncovered-line sets per file. The per-file difference localizes a whole-group
change of a few lines to the exact file and line numbers, which the pull request
comment cannot do. Reading the individual shard reports for that file then
distinguishes a real behavior change from a line-attribution artifact: if some
shard reports a hit on the branch body while the branch's own line sums to zero,
the code ran and the accounting lost it.
