---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed scheduler-v2 work order (Phase 0: remove push mode); shipped in the #4288 cutover."
---

# Work order 01 — Phase 0: Remove push mode

> Pure deletion. Production behavior must be byte-for-byte unchanged (pull
> mode is already the only mode in use). PR title:
> `refactor(runner): remove push scheduler mode (scheduler-v2 phase 0)`.

All paths relative to `packages/runner/` unless noted. Spec references:
inventory §12 (site list), spec decision: one engine.

## Step 1 — Remove mode usage from tests, helpers, and benches

Mode APIs are exercised across **~25 test/bench files** in several
patterns (full inventory regenerated 2026-06-11 after a review caught an
earlier truncated list). First record YOUR authoritative inventory —
never pipe a contract grep through `head` (G6):

```bash
cd packages/runner
grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode" test/
```

Paste the full output into PROGRESS.md, then apply these rules file by
file until the grep returns zero:

**A. Shared helpers — remove the option.**
`test/scheduler-test-utils.ts` (~lines 75-79): delete the `pullMode`
option from the options type and the enable/disable if/else.
`test/scheduler-bench-helpers.ts` (~line 103): same treatment.

**B. Option passers.**
- `pullMode: "enabled"` → delete the property (no-op). Verified sites:
  `scheduler-observations.test.ts` (×24), `scheduler-pull-handlers.test.ts`
  (×2), `scheduler-pull-references.test.ts:30`,
  `scheduler-pull-array.test.ts:43`.
- `pullMode: "disabled"` marks a PUSH-MODE variant — classify per rule D.
  Verified sites: `scheduler-convergence.test.ts:31`,
  `scheduler-events.test.ts:56`, `scheduler-retries.test.ts:29`,
  `scheduler-core.test.ts:61`, `scheduler-ordering.test.ts:561`.

**C. Boolean parameterizations** (a local helper takes
`pullMode: boolean` and branches): `navigate-handler.test.ts` (~13, 30),
`default-app-note-create.bench.ts` (~107),
`push-pull-patterns.bench.ts` (~342, 352, 805, 841, 883),
`scheduler.bench.ts:31`, `storage.bench.ts:36`,
`scheduler-pull-seeds.bench.ts`, `wish-mentionable-schema.bench.ts`.
Drop the parameter and the entire push arm. For
`push-pull-patterns.bench.ts`: keep the FILE NAME (renames are deferred
to phase 3f) and add a header comment that it is pull-only since
phase 0.

**D. Classification rule for push-pinned tests — do not delete coverage
blindly:**

1. If the block exists to compare against or assert push mode itself
   (asserts `isPullModeEnabled()` is `false`, name/describe mentions
   push, or it duplicates an adjacent pull-mode test): DELETE the block.
   Record its name in PROGRESS.md. Known cases:
   `scheduler-pull.test.ts:90` and `:2242` (push baselines).
2. Otherwise the test covers real behavior that was merely pinned to
   push (expected for: the rule-B "disabled" passers,
   `oncommit-race.test.ts:29`, `cell-callbacks.test.ts:1374` and `:1486`,
   `scheduler-effects.test.ts:1055`): REMOVE the pin so it runs under
   pull, then run that file. Green → keep it. Red → **STOP and report
   the test name + failure** — it documents a push-only semantic, and
   the reviewer decides delete-vs-port; do not decide yourself.

**E. No-ops and tautologies.** Bare `runtime.scheduler.enablePullMode();`
lines and `expect(...isPullModeEnabled()).toBe(true)` assertions →
delete. Largest file: `scheduler-pull.test.ts` (38 combined sites
including the rule-D baselines).

Verify: the FULL runner suite (`deno task test`) — the sweep touches too
many files for single-file verification. Then the step's exit grep:

```bash
grep -rn "enablePullMode\|disablePullMode\|isPullModeEnabled\|pullMode" test/
```

Expected: zero matches.

Commit: `test(runner): remove push-mode usage from tests, helpers, and benches`

## Step 2 — Delete the push modules

Files deleted:

- `src/scheduler/push-execution.ts`
- `src/scheduler/push-notifications.ts`
- `src/scheduler/push-subscriptions.ts`
- `src/scheduler/push-events.ts`
- `src/scheduler/push-continuation.ts`

Do NOT touch the `pull-*.ts` files and do NOT rename them (renames happen in
phase 3, not here).

This will break compilation of `src/scheduler.ts` (imports). Step 3 fixes
it; steps 2+3 are still **separate commits** — commit this one with the
build red is NOT allowed, so: do steps 2 and 3 in your working tree
together, but keep the deletion list above as the authoritative scope of
this step and commit both steps as ONE commit with the step-3 message.
(Correction: steps 2+3 also include exactly the four `src/runner.ts`
mode-API call-site edits listed in step 4. Removing the scheduler mode API
otherwise leaves `src/runner.ts` unable to compile.)
(Correction: steps 2+3 also include the `scheduler-cfc-trigger-reads.test.ts`
push-arm deletion because that test imports the deleted push notification
module directly.)
(This is the single sanctioned two-step merge in this work order.)

## Step 3 — Remove `pullMode` and all mode branches from `scheduler.ts`

File: `src/scheduler.ts`.

Make exactly these changes (line numbers are anchors from the verified
state; locate by symbol, not by number):

1. Imports: remove the five imports that reference the deleted files:
   `runPushSchedulerSettleLoop`, `applyPushExecuteContinuation`,
   `processPushStorageNotification`, `processPushQueuedEventDuringExecute`,
   and `resubscribePushSchedulerAction, subscribePushSchedulerAction`.
2. Delete the field `private pullMode = true;` (~line 301).
3. `subscribe()` (~546): replace the ternary
   `const cancel = this.pullMode ? subscribePullSchedulerAction(...) : subscribePushSchedulerAction(...);`
   with a direct call to `subscribePullSchedulerAction(...)` (keep the
   argument list exactly).
4. `resubscribe()` (~587): same collapse to
   `resubscribePullSchedulerAction(...)`; remove the early-`return` shape if
   it only existed to branch.
5. Delete the methods `enablePullMode()` (~1031-1054, including the
   dependents-rebuild loop inside it), `disablePullMode()` (~1059-1068),
   `isPullModeEnabled()` (~1073-1075), and the section comment banner above
   them if it only introduces these methods.
6. `idle()` (~939): `if (this.pullMode && this.hasRunnablePullWork())` →
   `if (this.hasRunnablePullWork())`.
7. `execute()` (~1436): `if (this.pullMode) { await breakPullCyclesIfNeeded(...) }`
   → unconditional `await breakPullCyclesIfNeeded(...)`.
8. `processExecuteEventPhase()` (~1480): collapse the if/else to the pull
   call `processPullQueuedEventDuringExecute(...)` only.
9. `buildInitialExecuteSeeds()` (~1518): delete
   `if (!this.pullMode) return new Set();`.
10. `runSettleLoop()` (~1534): collapse ternary to
    `await runPullSchedulerSettleLoop(this.settleLoopState, initialSeeds)`.
11. `applyExecuteContinuation()` (~1551): collapse to
    `applyPullExecuteContinuation(this.executeContinuationState)`.
12. `applyAdaptiveCycleDebounce()` (~1559): delete the
    `if (!this.pullMode) return;` guard (keep the body and its comment).
13. `createDependencyUpdateState()` (~1825): in
    `backfillDependentsForNewWrites`, delete `if (!this.pullMode) return;`.
14. `processStorageNotification()` (~1906): collapse to the pull call only.
15. `createEventExecutionState().onEventCommitWrites` (~2265): delete
    `if (!this.pullMode) return;`.
16. `createActionRunState()`:
    - `modeLabel: () => this.pullMode ? "pull" : "push"` (~2323) →
      `modeLabel: () => "pull"`. Do NOT change
      `schedulerRuntimeFingerprint` or its call sites — persisted
      observations embed the `runner:scheduler:pull` string (G8).
    - `recordChangedComputationWrites` (~2350): delete
      `if (!this.pullMode) return [];` guard, keep body.
    - `markReadersDirtyForChangedWrites` (~2358): change the guard
      `if (!this.pullMode || !this.computations.has(target)) return;` to
      `if (!this.computations.has(target)) return;`.
17. `createGraphSnapshotState()` (~2380): replace the
    `getPullMode`/getter dance with the literal `pullMode: true` property.
    Do NOT remove `pullMode` from the `SchedulerGraphSnapshot` telemetry
    type (external consumers read it); it now always reports `true`.
18. Private helpers (~2431-2551): remove the `this.pullMode &&` /
    `if (!this.pullMode) return ...` guards in `isDemandedPullComputation`,
    `shouldRunFirstPullComputationInDemandContext`,
    `isPullDemandRootEffect`, `getNextDebounceRunTime`,
    `isDebouncedComputationWaiting`, `scheduleComputationDebounce` —
    keeping each body.

Grep contract after the edit:

```bash
grep -n "pullMode\|PushScheduler\|push-" src/scheduler.ts
```

Expected: exactly one match: the literal `pullMode: true` property in
`createGraphSnapshotState()`. `PushScheduler` and `push-` must have no
matches (comments included — if a comment mentions push mode, delete the
sentence, keeping the rest of the comment intact).

Verify: `deno check src/scheduler.ts`, then the full runner suite
(`deno task test`).

Because the public mode API is removed here, include exactly these
`src/runner.ts` call-site edits in the same commit:

- `handleJavaScriptHandlerResult`: delete the entire
  `if (!this.runtime.scheduler.isPullModeEnabled()) { ... }` push branch,
  keeping only `addCancel(() => this.stop(resultCell));`. The deleted branch
  contained on-commit-error cancel+stop cleanup; its pull-mode replacement is
  built in work order 03 (phase E1). Add no substitute here.
- `patternNeedsOneShotPull`: change
  `if (!this.runtime.scheduler.isPullModeEnabled() || !pattern)` to
  `if (!pattern)`.
- `pullCellOnceAfterSuccessfulCommit` and `pullCellOnceInPullMode`: delete
  the `if (!this.runtime.scheduler.isPullModeEnabled()) { return; }` guard in
  each, keeping the bodies.

Also include exactly this test-file edit:

- `test/scheduler-cfc-trigger-reads.test.ts`: delete the
  `processPushStorageNotification` import, delete the
  `["push", processPushStorageNotification]` parameterization entry, and keep
  the pull arm's assertions unchanged. Keep the loop/parameterization shape
  even though it has one entry.

Merged verification for this commit:
`deno check src/scheduler.ts src/runner.ts`, then the focused
`test/scheduler-cfc-trigger-reads.test.ts` run, then the full runner suite
(`deno task test`), then the corrected Step 3 grep,
`ls src/scheduler | grep push`, and
`grep -rn "scheduler/push-\|processPush\|PushScheduler" src/ test/`.

Commit (covers steps 2+3):
`refactor(runner): remove push scheduler mode and pullMode branches (scheduler-v2 phase 0)`

## Step 4 — Remove push paths from the runner and remaining call sites

1. Find all remaining mode-API callers:
   ```bash
   grep -rn "isPullModeEnabled" ../../packages --include="*.ts"
   ```
   Expected: no matches. The former four `src/runner.ts` sites were folded
   into the steps 2+3 compile-unit commit. Anything else: STOP and report.
2. Telemetry: in `src/telemetry.ts`, locate the `scheduler.mode.change`
   event type member and delete it. Use the corrected grep
   `scheduler\.mode\.change` — expected pre-edit matches are the type
   definition and the stale shell comment line listed below; anything else:
   STOP.
3. Shell stale comment: in
   `../../packages/shell/src/lib/debugger-controller.ts`, delete exactly the
   commented `latestMarker?.type === "scheduler.mode.change" ||` line from the
   dead auto-refresh block. Do not touch anything else in that file.

Verify: `deno check src/runner.ts src/telemetry.ts`; full runner suite;
additionally run the html/ui package checks if telemetry types are imported
there:
```bash
grep -rn "scheduler\.mode\.change" ../../packages --include="*.ts"
```
Expected: no matches.

Commit: `refactor(runner): drop push-mode branches from runner and telemetry (scheduler-v2 phase 0)`

## Step 5 — Docs touch-up

File: `docs/specs/pull-based-scheduler/README.md` (repo root relative).

1. In the header block (lines 1-9): replace the sentence stating push mode
   remains a compatibility path with: push mode has been removed; this
   document describes the remaining (pull) behavior; the forward-looking
   design is `docs/specs/scheduler-v2/`.
2. Delete the "Mode Control" subsection (under "Current Behavior
   Reference") and the `enablePullMode/disablePullMode/isPullModeEnabled`
   entries in the API Reference section.
3. Do not otherwise rewrite the document.

Commit: `docs: pull-based-scheduler reflects push-mode removal`

## Exit checklist (reviewer)

- [ ] `ls src/scheduler/ | grep push` → empty.
- [ ] `grep -rn "pullMode\|enablePullMode\|disablePullMode\|isPullModeEnabled" src/ test/` →
      residual matches only for the frozen scheduler graph snapshot
      `pullMode` field (`src/scheduler.ts`, `src/scheduler/graph-snapshot.ts`,
      `src/telemetry.ts`). No `enablePullMode` / `disablePullMode` /
      `isPullModeEnabled` matches.
- [ ] `git grep -n "enablePullMode\|disablePullMode\|isPullModeEnabled" -- ':!docs'` →
      no matches.
- [ ] `schedulerRuntimeFingerprint` still emits `runner:scheduler:pull`
      (grep shows the function unchanged).
- [ ] Full runner suite green; `scheduler-pull.test.ts` runs with no mode
      toggles.
- [ ] No new files; no renames; diff is delete-dominated.
- [ ] Benchmarks still compile: `deno task bench` starts (may be aborted
      after the first bench completes; record that it ran).
