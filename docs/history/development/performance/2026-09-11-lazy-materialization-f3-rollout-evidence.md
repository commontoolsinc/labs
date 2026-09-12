---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "F3 of the lazy-materialization fast-follow: the default-on rollout evidence assembled for the flag owner's retirement decision."
---

# Lazy materialization: default-on rollout evidence

This is the F3 record for the
[lazy materialization fast-follow](../../../plans/lazy-materialization-fast-follow.md).
It assembles what is known about `lazyMaterialization` running on by default,
so that the flag's owner can decide whether the lift path's rollout switch is
retired (F4). It records no decision itself, and it mutates no live data.

## Revisions and observation period

| Item                     | Value                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View landed, flag off    | `cd5510583b`, 2026-08-12                                                                                                                                                                |
| Flag default flipped on  | `3c36680eba`, 2026-08-12, the same day                                                                                                                                                  |
| Revision this evidence   | `8551bd82b8`, 2026-09-11, on top of `a44d9389c3`                                                                                                                                        |
| Observation period       | 2026-08-12 to 2026-09-11, thirty days of `main` at the default-on posture                                                                                                                |
| Rollback override in use | None found. No tracked file under `.github/`, no deployment configuration, and no package manifest sets `EXPERIMENTAL_LAZY_MATERIALIZATION`; the only mentions are the registry and the plans |

Elapsed time is not acceptance. What the period covers is stated under
[Covered workloads](#covered-workloads), and what it does not under
[Limits](#limits).

## Posture per process

The [F0 baseline](2026-09-11-lazy-materialization-f0-baseline.md) records how
each process resolves the flag. The parts that matter to a retirement
decision:

- **Server processes** (toolshed, the CLI, the background piece service)
  resolve an unset variable to on; an explicit `false` in the environment is
  the rollback route, and nothing sets it.
- **The browser shell has no rollback route.** Its build-time defines cover
  five other experimental flags and not this one, so every shell build since
  2026-08-12 has run the view on with no way to turn it off short of a code
  change. The registry's statement that the shell reads the same variables
  from its defines does not hold for this flag.
- **Detached clients** take the server's published posture, which has been on.

So the deployed browser population has had no off arm for the whole period.
That is soak evidence for the on arm and, at the same time, the reason the
off arm has no field evidence at all.

## Covered workloads

- **Continuous integration.** Every merge to `main` since 2026-08-12 ran the
  runner unit suite and the integration suites at the default-on posture. No
  CI lane sets the flag off; the only experimental variable the workflows set
  is `EXPERIMENTAL_SERVER_EXECUTION`, for that flag's two arms.
- **The pattern computation-cost arc**, 2026-09-10 to 2026-09-12: the
  [controlled lunch-poll baseline](2026-09-10-lunch-poll-read-baseline.md),
  the [reactive rows acceptance](2026-09-11-reactive-lunch-rows.md), and the
  [representative-copy rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md)
  all ran with the view on and record their read counts under it.
- **The scalar read width baseline**
  ([record](2026-09-11-lazy-scalar-read-width.md)) measured both postures on
  the same schema and rows and verified every result.
- **The F0 handler dispatch benchmark** ran eighteen handler variants at the
  default posture, which reads a handler's context eagerly either way; the
  F1 prototype's posture runs exercised lift-style views inside handler
  bodies in both postures and verified every result.

## Both postures on the test suites

The runner unit suite is the suite that holds the view's equivalence,
refusal, snapshot, and dependency tests. It was run at revision `8551bd82b8`
plus the F1 lift-path fix, once per posture:

| Posture                                         | Result                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| On (default; also every CI run)                 | Green in CI on `8551bd82b8`                                                                     |
| Off (`EXPERIMENTAL_LAZY_MATERIALIZATION=false`) | `ok`: 1,383 tests, 9,602 steps, 0 failed, 1 step ignored, in 12 minutes 35 seconds, locally |

Files that run their own cases in both postures: `patterns-lift.test.ts`
(the forwarding lift runs once under the view and twice eager),
`lazy-materialization-runner.test.ts`, `lift-refusal-disposition.test.ts`,
and, on the prototype branch, `handler-lazy-context.test.ts`.

## Changes to the view in the period

Every commit that touched the view's two files, `schema-view.ts` and
`query-result-proxy.ts`, after the default flipped, in date order, with the
kind its subject gives it. Refactors that only moved or renamed are left out.

| Date       | Commit        | Kind    | Change                                                                                                                         |
| ---------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-17 | `a3fcd6047a`  | fix     | A transaction resolves a link once, not once per element read                                                                  |
| 2026-08-17 | `8ca18b71e1`  | fix     | An `unknown` field keeps the reference it holds                                                                                |
| 2026-08-17 | `9c0881506b`  | fix     | The proxy value cache answers for the writability asked for                                                                    |
| 2026-08-17 | `0c9ea8a8a0`  | change  | `{ proxy: true }` and writability removed from query-result proxies                                                            |
| 2026-08-18 | `129215d4c6`  | feature | A materialized read describes the instant it was taken (the snapshot contract)                                                 |
| 2026-08-21 | `90b0996722`  | fix     | A read dead-ending at a document the replica does not hold is a refusal the run boundary disposes of, not an `undefined` value |
| 2026-08-28 | `8acda7a358`  | feature | Reader schema takes precedence over link schemas on hops                                                                       |
| 2026-09-09 | `818af09978`  | fix     | An empty write batch keeps the transaction's read caches                                                                       |
| 2026-09-09 | `fda353d69b`  | fix     | The walks admit fabric special objects                                                                                         |
| 2026-09-10 | `89e5524c23`  | feature | Read accounting exposes pattern computation read costs                                                                         |
| 2026-09-10 | `e70704f206`  | fix     | Read accounting is preserved across transaction and test boundaries                                                            |
| 2026-09-10 | `10a780d064`  | fix     | Enclosing `$defs` are carried into sub-schemas through one helper                                                              |
| 2026-09-11 | `5347f7da45`  | fix     | `#/$defs/<name>` resolves against the document root                                                                            |
| 2026-09-11 | F1, unmerged  | fix     | A refusal a lift body throws synchronously reaches the post-run that writes the undefined result                               |

The last is the one this fast-follow found, by a review of the F0 record
rather than by a failure in the field: `lift-refusal-disposition.test.ts`
fails on `8551bd82b8` with the flag on and passes with it off, and passes in
both postures with the fix. The design's Stage 5 claim that a thrown refusal
writes an undefined result was true only of the asynchronous case.

What the list does not contain: a report of a lift running where an eager
read would have refused, which is the one behavior change the design names
as observable. The two `$defs` fixes sit on the eager path as well as the
view; the rest are the view's own.

## Limits

- The off arm has no field evidence: no browser has run it since 2026-08-12,
  and no server deployment set the override. Its evidence is the runner
  suite and the both-posture test files above.
- The integration suites were not run at the off posture for this record.
  They launch browsers, which this record's author could not do from the
  session it ran in; a retirement decision that wants them run at the off
  posture should say so.
- Production-like client and server behavior on isolated data at both
  postures was exercised only by the runner suite's two-runtime and
  served-dispatch tests, not by a deployed pair.
- Thirty days of soak on a fast-moving `main` is thirty days of that
  `main`; the view's files changed thirteen times in it. The relevant
  question for retirement is whether the last change's revision has soaked,
  and it has not: `5347f7da45` is one day old at this revision.

## What a retirement decision needs to name

- Whether the off arm's absence in the browser since 2026-08-12 is accepted
  as soak evidence, or whether a build define is wanted first so the arm can
  be exercised, given that retirement deletes the switch anyway.
- The rollback route after retirement, which can only be a revert of the
  removal commit.
- Whether the integration suites are to be run at the off posture before
  removal, and by whom.
