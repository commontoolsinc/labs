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
| Rollback override in tracked files | None. No workflow under `.github/`, deployment configuration, or package manifest sets `EXPERIMENTAL_LAZY_MATERIALIZATION`. A process environment supplied outside the tree is not observable from it |

Elapsed time is not acceptance. What the period covers is stated under
[Covered workloads](#covered-workloads), and what it does not under
[Limits](#limits).

## Posture per process

The [F0 baseline](2026-09-11-lazy-materialization-f0-baseline.md) records how
each process resolves the flag. The parts that matter to a retirement
decision:

- **Toolshed, the background piece service, and `cf dev`** read the
  variable from their own environment through `experimentalOptionsFromEnv`
  and resolve an unset one to on. An explicit `false` there is the rollback
  route; no tracked file supplies one.
- **A deployed `cf`** resolves the flag through
  `experimentalOptionsForDeployedClient`: an explicit value in its own
  environment wins, otherwise the posture its server publishes, otherwise the
  built-in default.
- **The browser shell has no rollback route.** Its build-time defines cover
  five other experimental flags and not this one, so every shell build since
  2026-08-12 has run the view on with no way to turn it off short of a code
  change. The registry's statement that the shell reads the same variables
  from its defines does not hold for this flag.

So the deployed browser population has had no off arm for the whole period,
which is soak evidence for the on arm. Whether any server or `cf` ran the off
arm through an environment supplied outside the tree is not something this
record can see; it has no deployment observation or telemetry either way.

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
refusal, snapshot, and dependency tests. Its tests construct their runtimes
directly and pass no experimental options unless a case is about one, and
`Runtime` reads no environment, so the environment variable does not put the
suite in the off posture; only the built-in default does. The off run below
therefore flips that default at its source, `lazyMaterialization ??= false`
in `runtime.ts`, as an uncommitted edit in a worktree whose tree is the F0
record's change at `8551bd82b8` plus the lift-path fix, the tree
`codex/lift-refusal-disposition` holds at `f3872d5737`. Every runtime the suite
builds without an explicit value then runs off, and a case that names the
posture explicitly keeps the posture it names.

| Posture                                | Result                       |
| -------------------------------------- | ---------------------------- |
| On (the built-in default; every CI run) | Green in CI on `55b7e6bff6` |
| Off (built-in default flipped at the source) | `FAILED`: 1,378 tests passed, 5 failed (9 steps), 1 step ignored, in 13 minutes 22 seconds, locally |

Every failing step is in `aggregate.test.ts`, the three "updates reduce with
N independently linked values" cases, and each fails on one assertion: that
the computed's run registered at least N proxy accesses. That is a
lazy-posture expectation — an eager value produces no proxy accesses
([read accounting](../../../features/read-accounting.md)) — and the case's
value assertion, that the sum updated, passed. The counts of tests and
steps above include the parents those steps fail. No other test in the
suite differs between the postures.

An earlier run with `EXPERIMENTAL_LAZY_MATERIALIZATION=false` in the
process environment passed, 1,383 tests and 0 failures, but for the reason
above it exercised the off posture only in the cases that set the option
themselves, and it is not counted here.

Files that run their own cases in both postures: `patterns-lift.test.ts`
(the forwarding lift runs once under the view and twice eager),
`lazy-materialization-runner.test.ts`, `lift-refusal-disposition.test.ts`,
and, on the prototype branch, `handler-lazy-context.test.ts`.

## Changes to the view in the period

Every commit that touched the view's two files, `schema-view.ts` and
`query-result-proxy.ts`, between the default flipping on and the revision of
this evidence, oldest first. The kind is the subject's prefix as written, and
the subject is quoted without its pull request number; two subjects carry no
prefix.

| Date       | Commit        | Kind     | Subject                                                                                              |
| ---------- | ------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| 2026-08-13 | `572a477c27` | refactor | name each object-shape predicate for the array case |
| 2026-08-14 | `401df0d11d` | docs | say "returns" where "answers" was doing the work, in `src` |
| 2026-08-15 | `720c03243c` | refactor | conform imports in `runner/src` and `runner/integration` |
| 2026-08-17 | `a3fcd6047a` | (none) | A transaction resolves a link once, not once per element read |
| 2026-08-17 | `8ca18b71e1` | fix | an `unknown` field keeps the reference it holds |
| 2026-08-17 | `9c0881506b` | fix | the proxy value cache answers for the writability asked for |
| 2026-08-17 | `0c9ea8a8a0` | refactor! | remove `{ proxy: true }` and writability in query-result proxies |
| 2026-08-18 | `129215d4c6` | feat | a materialized read describes the instant it was taken |
| 2026-08-19 | `4543e4dfcd` | refactor | a validator is named after the type it guards |
| 2026-08-21 | `90b0996722` | (none) | OW51 unresolved-input semantics: the RULED option-3 build [HOLD — coordinator delta review pending] |
| 2026-08-26 | `7789adb5ca` | refactor | `data-model-schema`, and `data-model` stops importing `api` |
| 2026-08-28 | `8acda7a358` | feat | reader schema takes precedence over link schemas on hops |
| 2026-09-01 | `14bc4ecc9e` | refactor | the `FabricValue` surface is the package's main export |
| 2026-09-09 | `fda353d69b` | fix | the walks admit fabric special objects |
| 2026-09-09 | `818af09978` | fix | an empty write batch keeps the transaction's read caches |
| 2026-09-10 | `89e5524c23` | feat | expose pattern computation read costs |
| 2026-09-10 | `e70704f206` | fix | preserve read accounting across transaction and test boundaries |
| 2026-09-10 | `10a780d064` | fix | carry enclosing `$defs` into sub-schemas through one shared helper |
| 2026-09-11 | `5347f7da45` | fix | resolve `#/$defs/<name>` against the document root |

Separately from these two files, the lift path's disposition of a
synchronous refusal in `runner.ts` has a fix on `codex/lift-refusal-disposition`,
held for the pattern vintage gate's owner because the fix changes a derived
value the gate holds for the lunch poll. This fast-follow found the defect by
reviewing the F0 record rather than by a failure in the field: `lift-refusal-disposition.test.ts`
fails at the pinned revision with the flag on and the previous result
standing, passes with it off, and passes in both postures with the fix. The
design's Stage 5 claim that a thrown refusal writes an undefined result was
true only of the asynchronous case.

What the list does not contain: a report of a lift running where an eager
read would have refused, which is the one behavior change the design names
as observable.

## Limits

- The off arm has no field evidence this record can see: no browser can have
  run it since 2026-08-12, and no tracked file sets the override for any
  other process. Its evidence is the runner suite run with the default
  flipped and the both-posture test files above.
- The integration suites were not run at the off posture for this record.
  They launch browsers, which this record's author could not do from the
  session it ran in; a retirement decision that wants them run at the off
  posture should say so.
- Production-like client and server behavior on isolated data at both
  postures was exercised only by the runner suite's two-runtime and
  served-dispatch tests, not by a deployed pair.
- Thirty days of soak on a fast-moving `main` is thirty days of that
  `main`; the view's files changed nineteen times in it. The relevant
  question for retirement is whether the last change's revision has soaked,
  and it has not: `5347f7da45` was about seven hours old at this evidence's
  revision.

## What a retirement decision needs to name

- Whether the off arm's absence in the browser since 2026-08-12 is accepted
  as soak evidence, or whether a build define is wanted first so the arm can
  be exercised, given that retirement deletes the switch anyway.
- The rollback route after retirement, which can only be a revert of the
  removal commit.
- Whether the integration suites are to be run at the off posture before
  removal, and by whom.
