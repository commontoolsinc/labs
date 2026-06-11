# Scheduler v2 — Implementation Work Orders

> **Audience**: the implementing agent. Follow these documents literally and
> in order. When reality disagrees with an instruction (a grep returns
> different sites, a test fails unexpectedly, an API doesn't exist as
> described), **STOP that step and report** — do not improvise a fix, do not
> widen the change to "make it work".
> **Reviewer**: a separate reviewer checks every phase against the checklists
> at the end of each document.

## Required reading (before any code)

1. [`../README.md`](../README.md) — the v2 spec. You must know §2
   (principles), §4 (nodes), §7 (execution/events), §11 (invariants).
2. [`../current-system-inventory.md`](../current-system-inventory.md) — what
   each existing mechanism does and its fate. When you are about to delete
   or change something, find its row first.
3. [`../migration-plan.md`](../migration-plan.md) — the phase rationale.
4. This file, fully.

## Work-order sequence

Execute in this order. Do not start a document until the previous one's exit
checklist passes (exceptions noted inline).

| # | Document | Contents | Depends on |
| --- | --- | --- | --- |
| 1 | `01-phase0-remove-push-mode.md` | Delete push mode | — |
| 2 | `02-phaseE0-event-identity.md` | Event ids + rejection taxonomy | 1 |
| 3 | `03-phaseE1-speculation-lineage.md` | Lineage registry, origin precondition, compensating stop | 2 |
| 4 | `04-phaseE2-receipts.md` | Receipt = result cell, exactly-once | 3 |
| 5 | `05-phase1-static-write-surface.md` | Freeze write surface, delete write-set discovery | 1 (E not required) |
| 6 | `06-phase2-tx-identity.md` | tx.sourceAction self-suppression | 5 |
| 7 | `07-phase3-cutover.md` | Node records, liveness, new pass | 5, 6 |
| 8 | `08-later-phases.md` | Phase 4 (prefetch), 5 (gates), 7 (persistence) | 7 |

Phases E (docs 2–4) and 1–2 (docs 5–6) are independent tracks; if directed
to parallelize, E proceeds on its own branch. Default: sequential as listed.

## Global rules

### G1 — One step, one commit

Each work order is divided into numbered **steps**. One step = one commit.
Use the commit message given in the step verbatim (plus the repo trailer):

```
Co-Authored-By: <your model attribution line, as configured>
```

Never squash steps. Never batch two steps into one commit.

### G2 — Worktree pre-commit gotcha

The repo pre-commit hook inspects the DEFAULT worktree, not the one you work
in; newly added files fail it spuriously. After local verification passes,
commit with `--no-verify`. Never use `--amend` (it is blocked).

### G3 — Verification before every commit

Each step lists exact verification commands. Additionally, every commit must
pass for the files you touched:

```bash
deno fmt <touched files>            # src/ is formatted; docs/ is excluded
deno check <touched .ts files>
```

Test commands (run from `packages/runner/` unless stated otherwise):

```bash
# Full runner suite (use at phase end and where a step says so):
deno task test

# Single test file (preferred per-step; same flags as the task):
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git test/<file>.test.ts
```

Known pre-existing issue: `test/scheduler-events.test.ts` can fail TYPE
checking with a `Timeout` type error that predates this work. If you hit
exactly that, run that file with `--no-check` and note it in PROGRESS.md. Any
OTHER type error is yours.

### G4 — Scope discipline

- Touch only the files a step names. If a change seems to require touching
  another file, STOP and report.
- No opportunistic refactors, renames, comment rewrites, import reorderings,
  or lint fixes outside the step's instructions.
- Match surrounding code style exactly (the repo style guide is
  `docs/development/DEVELOPMENT.md`).
- Do not add comments narrating the change ("removed push mode here").
  Comments only where a step explicitly provides them.

### G5 — Red-green for behavior changes

Where a step says "fixture first", you must: write the test, run it, paste
the failing output into PROGRESS.md, then implement, then show it green.
Deletion-only steps don't need new tests but must keep existing ones green.

### G6 — Grep contracts

Steps that delete a mechanism include a grep whose expected result is listed
(usually "no matches" or an exact site list). If the grep returns anything
unexpected, STOP and report the diff between expected and actual. The
expected lists were verified against commit `4cf4ec86f` of branch
`claude/beautiful-knuth-7f8c80`; drift is possible and must be surfaced, not
absorbed.

### G7 — Progress tracking

Maintain `docs/specs/scheduler-v2/implementation/PROGRESS.md`: one line per
step — `- [x] 01/step-3 — <commit sha> — <one-line note / deviations>`.
Deviations and STOP events go here in detail. The reviewer reads this first.

### G8 — Behavioral contracts you must never break

These hold at every commit, not just phase ends:

- `Scheduler.idle()` semantics (spec §8.4): resolves only at quiescence;
  dormant invalid computations never hold it open. The tests in
  `scheduler-pull.test.ts` and `scheduler-events.test.ts` encode this.
- Global event FIFO (one lane): enqueue order is dispatch order; a parked
  head blocks the queue, never reorders it.
- CFC trigger reads (spec §10): every scheduled run's transaction carries
  the addresses that caused it; restored on retry.
  `scheduler-cfc-trigger-reads.test.ts` encodes this.
- Persisted-observation compatibility: never change
  `schedulerImplementationFingerprint` / `schedulerRuntimeFingerprint`
  output strings except where a step explicitly versions them.
- The benchmark files under `test/*.bench.ts` must keep compiling (they run
  with `--no-check` but are part of perf gates at phase ends).

## Phase-end protocol

At the end of each work order:

1. Run the full runner suite: `cd packages/runner && deno task test`.
2. Run the phase's listed benchmarks; record numbers in PROGRESS.md
   (before/after where the order says to capture a baseline first).
3. Run the work order's exit-checklist greps.
4. Push the branch, open a PR titled as the work order specifies, with the
   PROGRESS.md excerpt for the phase in the description.
5. Wait for review before starting the next work order (unless told to
   proceed).

## Glossary cross-check

The work orders use spec vocabulary. Quick map to current code:

| Spec term | Current code |
| --- | --- |
| node | `Action` (function object with annotations) |
| invalid / clean | `staleness.dirty` membership (direct dirty) |
| live | `isDemandedPullComputation` / effects membership |
| change channel | storage notifications → `processPullStorageNotification` |
| reader index | `SchedulerTriggerIndex` |
| writer map | `SchedulerWriteIndex` |
| gate | `SchedulerDelays` + delay-control |
| pass | one `execute()` cycle |
| origin tx | the transaction whose handler sent an event |
| receipt | the handler's `{ resultFor: cause }` result cell |
