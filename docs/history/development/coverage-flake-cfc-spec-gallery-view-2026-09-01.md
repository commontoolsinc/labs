---
status: historical
created: 2026-09-01
archived: 2026-09-01
reason: "Investigation record: the 132 lines of one pattern that moved the `packages/patterns` coverage count between a `main` run and the pull request measured against it."
---

# The gallery view that only a browser built, September 2026

## Conclusion

[PR #6742](https://github.com/commontoolsinc/labs/pull/6742) changed no line of
`packages/patterns/cfc-spec-gallery/main.tsx`, and its Coverage Check job
reported `packages/patterns` at 29174 uncovered lines against a `main` baseline
of 29111. The 63-line rise was charged to a pull request about a profile
creation surface.

Underneath the 63 sit 132 lines of that one file, all of them code that runs
only when something reads what the pattern returns:

- the bodies of the two view helpers, `ExampleCard` and `LabelDisclosureCard`,
  and the seventy-seven lines of call sites in the `[UI]` tree that invoke them
- the three `lift()` bodies that mint the disclosure cells the label cards show
- the three stage `computed()` bodies, whose only reader is a badge in the view
- the `[NAME]` computed, and the four `computed()` fields in the returned
  record that report the gallery's inputs back out

Two lanes reach this pattern and only one of them reads any of that. The
pattern test in `main.test.tsx` instantiated the gallery, drove its streams,
and asked for scalars. The browser-driven integration test in
`integration/cfc-spec-gallery.test.ts` rendered the piece, which built the view
and read the fields the view binds. So whether the 132 lines counted came down
to whether the integration lane's report for this file survived into the
shard's artifact.

## What the runs measured

The baseline is
[run 33572324139](https://github.com/commontoolsinc/labs/actions/runs/33572324139),
`main` at `27c8aa43`. The measurement is
[run 33575774351](https://github.com/commontoolsinc/labs/actions/runs/33575774351),
which merged the pull request into base-branch commit `03219f51`. The file is
untouched by the pull request, so line numbers and counts compare directly.

Each run uploads 36 coverage artifacts. Two of the baseline's measure this
file and one of the measurement's does:

| artifact | baseline | measurement |
| --- | --- | --- |
| `coverage-profile-pattern-unit-2` | 385 of 522 lines | 385 of 522 lines |
| `coverage-profile-pattern-integration-10` | 512 of 522 lines | file absent |

The two runs' `pattern-unit-2` records for this file are byte-identical, and
the measurement's whole coverage of the file is that record. The entire
difference is the integration record, which the measurement does not have.

The two lanes each covered what the other did not. The 132 lines are exactly
what the integration record had and the pattern record did not; running the
other way, five lines were the pattern record's alone — 258, 265, 272, 314 and
321, the bodies of the five handlers the pattern test drove and the browser
test did not click. Their union is the 517.

The integration record is one file per collecting test file. The baseline's
holds 28 source files — the gallery, the seventeen `cfc/trusted-surfaces` modules it composes,
and the notes and system patterns other tests on the shard exercised. The
measurement's holds 14: the notes and system patterns, plus the topics patterns
a test on that shard ran and the profile patterns the pull request adds.
Neither the gallery nor a single trusted surface appears in it.

The integration test itself ran on shard 10 in both runs and passed in both, in
25 seconds on the baseline and 15 on the measurement. The measurement's shard-10
job log carries no `[pattern-coverage]` warning.

## What took the record away

The collection defect is the subject of
[PR #6746](https://github.com/commontoolsinc/labs/pull/6746), which landed the
day after this measurement. `deno test` runs each test file in its own isolate,
so a shard's files held separate instances of the harness module, each with its
own collector — and every one of them wrote
`pattern-integration-<pid>.pattern-coverage.lcov`, one name for the whole
process. Each file's report overwrote the one before it, and a shard uploaded
only what its last collecting file had gathered. Three of the four ways a dump
can come back empty-handed returned in silence besides.

The two records here are each the shape of one test file's isolate rather than
of a shard. A browser-driven test seeds the space root through
`ensureDefaultPattern`, which compiles `system/default-app.tsx` and what it
composes, so the notes and system patterns belong to whichever isolate wrote
the surviving file. The baseline's 28 are that set plus the gallery and its
seventeen trusted surfaces, which is the gallery test's own isolate. The
measurement's 14 are that set — carrying the profile patterns the pull request
adds — plus the topics patterns, which is `topic-create-onscreen.test.ts`, a
file the baseline's shard did not hold and the measurement's ran last.

This document does not establish that the overwrite is what happened here, only
that both records are consistent with it and that the defect was present.

The baseline's counts say the view was built twice: 12 for each line of
`ExampleCard`, which the tree calls six times, and 6 for each line of
`LabelDisclosureCard`, which it calls three times. The integration test
navigates once per case and has two cases.

## The lines nothing reached at all

Five lines of the file — 279, 286, 293, 300 and 307 — report zero in every
artifact of both runs. They are the bodies of the `acknowledgeDisclosure`,
`acknowledgeAlert`, `acceptInvite`, `releaseRedactedSummary` and
`escalateSupportCase` handlers. The pattern exposes a stream for each, the view
gives two of them a card, and nothing in either lane ever sent to one. They
were permanent debt rather than movement.

## What was done

Two changes, because the first was written to unblock the pull request the gate
had stopped and shipped with it. Both are in the pattern test, which reads the
same way on every machine and in every shard, so none of these lines is left to
a lane that has to render the piece to reach them.

The first reaches into the rendered view. `hasText(findNodeById(instance[UI],
"gallery-count"), "16 total examples")` walks the tree to find the header, and
walking is what builds it, so every helper the tree calls runs. That is worth
asserting for its own sake: the pattern claims sixteen examples through
`totalExamples`, and `gallery-count` is where a reader is told the same number.
It takes the pattern lane from 385 covered lines to 512.

The second takes the remaining ten. Five are the computed fields nothing read:
an assertion on `instance[NAME]`, and one that states the three inputs the
trusted surfaces read back out — the forward recipient, the research command
and the safe-link source — against the values the test's own setter actions
sent, alongside the raw note the forward drew its bounded excerpt from. The
other five are the handler bodies: the test now sends to all five streams and
asserts each handler's string, which also takes `completedCount` to twelve, the
whole of what that computed counts. That replaces a closing assertion of
`completedCount >= 3` that a regression to three would have passed.

Measured over the pattern lane alone, with a clean `CF_PATTERN_COVERAGE_DIR`
and nothing but this one test file, the file goes to 522 of 522.

Four mutations confirm the assertions are not passing on the strength of what
they walk past. Renaming the pattern fails the `[NAME]` assertion. Changing the
header to say seventeen examples fails the view assertion, which reports the
label node it found. Making `safeLinkSource` report an empty string fails the
inputs assertion on that operand and no other. Shortening one handler's string
fails the closing assertion.

No source change: nothing about the pattern needed rearranging for a test to
reach these lines. The view is a value the pattern returns, the reported inputs
are fields on the same record, and every unreached handler already had a stream
on it.

What this settles and what #6746 settles are different things. That pull
request makes the integration lane report what it measured; this one stops the
file depending on that lane at all, and takes with it the five handler bodies
no lane had ever run.
