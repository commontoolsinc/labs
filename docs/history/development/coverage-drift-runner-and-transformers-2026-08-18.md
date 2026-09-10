---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Investigation record: which lines moved the coverage counts of packages/runner, packages/ts-transformers and packages/schema-generator between CI runs of identical code, and which reported movement was not measurement at all."
---

# The lines that moved between runs, August 2026

## Conclusion

Nine consecutive `main` runs, compared line by line over the files whose
content is identical across all nine commits, move on 2017 lines across 76
files. All but 52 of those lines, and 60 of those files, are in
`packages/patterns`. The rest:

| Group | Files | Lines |
| --- | ---: | ---: |
| `packages/patterns` | 60 | 1965 |
| `packages/ts-transformers` | 6 | 26 |
| `packages/schema-generator` | 6 | 21 |
| `packages/runner` | 2 | 3 |
| `packages/connectors` | 1 | 1 |
| `tasks` | 1 | 1 |

Outside `packages/patterns` the moving lines are:

| Group | File and lines |
| --- | --- |
| `packages/runner` | `src/scheduler/facade.ts` 241; `src/storage/v2-remote-session.ts` 283, 301 |
| `packages/ts-transformers` | `src/policy/capability-analysis.ts` 378, 379, 1237, 2540, 2542, 2543; `src/ast/call-kind.ts` 1549, 1604; `src/core/common-fabric-symbols.ts` 129; `src/closures/strategies/array-method-transform.ts` 209, 210, 211, 212, 213, 215, 216, 217; `src/transformers/expression-rewrite/rewrite-helpers.ts` 340; `src/transformers/pattern-coverage.ts` 72, 73, 74, 75, 76, 289, 290, 291 |
| `packages/schema-generator` | `src/schema-generator.ts` 819, 820, 901, 902; `src/formatters/common-fabric-formatter.ts` 531, 532, 656, 657; `src/formatters/object-formatter.ts` 256, 270, 271; `src/formatters/union-formatter.ts` 980, 982; `src/type-utils.ts` 302, 303, 304, 305, 306, 308, 309; `src/typescript/cell-brand.ts` 106 |
| `packages/connectors` | `agents/src/drivers/codex-jsonl-client.ts` 172 |
| `tasks` | `workspace-tests.ts` 305 |

`packages/fuse` moves on no line at all.

## The runs

Runs 32158049752, 32159269411, 32160371151, 32160718226, 32161100363,
32161944636, 32162051872, 32167910185 and 32169603503, over commits
`796c4c2c` through `ea9bc7e5`. 152 files differ across that span; the
remaining 6157 are identical, and only those were compared. Each run's 36
coverage artifacts were read as one report per run, accumulating duplicate
`SF:` sections, and a line counts as moved when it is covered in one run and
uncovered in another.

## What the reported movement in `packages/fuse` and `packages/runner` was

The investigation started from two CI runs of pull request #5827, runs
32058834063 and 32079105439, whose Coverage Check tables read:

```
packages/fuse     3602 -> 3602  (+0)      then  3602 -> 3608  (+6)
packages/runner   4516 -> 4516  (+0)      then  4512 -> 4510  (-2)
```

Neither movement is measurement. The second run merged into base-branch commit
`bd20be6f`, and no `main` run had measured that commit, so the ratchet stepped
back five commits to `0b55eb08`. Those five commits added
`decodeSourceWriteText()` to `packages/fuse/mod.ts` and rewrote parts of the
runner's harness and compilation cache, so the two sides of each of those
comparisons count different code. The job says so on its own: both groups are
marked `excl`, under the line "Not gated, because no baseline counts the same
base-branch code as this run does". A group's `Change` column is only a
measurement of the pull request when that line does not name it.

The two runs' own reports agree. Over the 5985 files identical between the two
merge commits, `packages/fuse` and `packages/runner` move on no line at all;
the only line that moves anywhere is 61–69 of `packages/integration/page.ts`,
which the metric does not track.

## `packages/runner`

`src/scheduler/facade.ts` 241 is the last of the cross-space rules in
`observationMinimumContextRank()`: an action whose recorded scope summary
crosses spaces with no address scoped to a user or a session may be adopted
only from a session-context snapshot. It was covered by the runner integration
job on the four oldest of the nine runs and by nothing on the five newest, with
the file identical throughout. Lines 226 and 227, the rule above it that
refuses a summary describing some other piece, were covered on none of the
nine.

`src/storage/v2-remote-session.ts` 283 and 301 are two of the three abort
checks in `RemoteSessionFactory.create()`. Both were covered by the
`workspace-1` shard on the two oldest runs and by nothing on the other seven.
Both windows are microtask-sized: the abort has to land between one library
call returning and the next line running.

Line 301 decides something. An abort that lands after the mount resolves has
already run the close-on-abort listener, so without the check `create()` would
return a client it had just shut. Lines 277 and 283 decide nothing:
`MemoryClient.connect()` refuses an aborted signal on entry and `Client.mount()`
does the same through `runWithAbortSignal`, both raising the signal's own
reason, which `create()`'s catch clause converts exactly as its own check
would. Removing them changes no rejection, no reason, no closed transport and
no frame sent. They were removed, and the cases that would have covered them
now state the contract at those windows instead, which is what makes the
removal safe.

## `packages/ts-transformers` and `packages/schema-generator`

Both groups move for one reason: their own test jobs never reach these lines.
What reaches them is the pattern integration jobs, compiling whatever the
pattern corpus happens to contain, on whichever shard the pattern landed. Every
carrier recorded for these lines is a `coverage-profile-pattern-integration-*`
artifact, and the shard number differs from run to run for the same line —
`packages/schema-generator/src/type-utils.ts` 302 was carried by
`pattern-integration-8` on one run and `pattern-integration-9` on three others,
and by nothing on the remaining five.

Three shapes account for most of them. The first is a branch for a language
construct the corpus uses rarely: the `Stream<T>` arm of the declared-wrapper
classification, a numeric literal type node, the bare `object` type, a scope
wrapper around a schema that accepts any value, a switch's `default` clause.
Each is one hand-built type or one small source through the analyzer.

The second is a guard on a TypeScript symbol that has no declarations —
`call-kind.ts` 1549 and 1604, `common-fabric-symbols.ts` 129,
`rewrite-helpers.ts` 340, `cell-brand.ts` 106. Which pattern shape produces a
declaration-less symbol at each site is not obvious from the code, and none of
these was addressed.

The third is a path whose result is the same as the path beside it for every
input that could be constructed. `array-method-transform.ts` 209 to 217 takes an
array-method callback's authored return-type annotation instead of
synthesizing a node from the resolved type; the emitted module is identical
either way for an annotation naming an interface, a type alias, or a Common
Fabric type. It was not addressed, and whether some input separates the two —
the branch beside it declines a return type that is a type parameter — was not
established.

## `packages/connectors`

`codex-jsonl-client.ts` 172 is the `catch` around `child.kill("SIGTERM")` in
`#terminate()`. Deno's `kill` throws only once the child has been reaped, and
the only `await` of `child.status` in the class is the one immediately below
the kill, so within a single `#terminate()` call the kill precedes it. What
makes the kill throw is the reap completing concurrently, which the process
scheduler decides. From outside the class there is no way to force it: the
child is private, and `#terminate()` clears it before the kill so a second call
returns early. Reaching the line deterministically would take a seam for
spawning. It was not addressed.

## `tasks`

`workspace-tests.ts` 305 is `if (!passed) Deno.exit(1)` in `main()`. It was
covered by the `workspace-5` shard on the four runs whose workspace suite had
a failing test and by nothing on the five that were green: whether the line
counted as covered was decided by whether the suite was passing.

The line is gone. Test-run recording moved the exit out to `tasks/test.ts`,
so that a failing run's records are shipped by a `finally` clause that
`Deno.exit` would have skipped, and `main()` now returns whether the run
passed. `tasks/test.ts` is not measured at all — `deno coverage` skips a file
whose name ends in `test.ts` — so nothing of this is left for the metric to
count either way.

What survives in `main()`'s neighborhood is the guard that reports a failure
when the selection comes back empty, which a run that tested nothing reaches.
That has a case of its own.
