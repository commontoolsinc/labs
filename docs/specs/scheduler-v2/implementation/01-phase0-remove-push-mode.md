# Work order 01 — Phase 0: Remove push mode

> Pure deletion. Production behavior must be byte-for-byte unchanged (pull
> mode is already the only mode in use). PR title:
> `refactor(runner): remove push scheduler mode (scheduler-v2 phase 0)`.

All paths relative to `packages/runner/` unless noted. Spec references:
inventory §12 (site list), spec decision: one engine.

## Step 1 — Delete the push test, de-noise mode calls in tests

Files: `test/scheduler-pull.test.ts` only.

1. Open the file. Locate the test around line 90 that calls
   `runtime.scheduler.disablePullMode()` — it is a push-mode baseline
   comparison. Delete that entire `it(...)`/`test(...)` block (from its
   opening call to its closing `);`). Read the block before deleting and
   record its name in PROGRESS.md.
2. Delete every `runtime.scheduler.enablePullMode();` line in the file
   (pull is the default; the calls are no-ops). Expected count: ~14 lines
   (verified sites at lines 48, 140, 206, 250, 330, 430, 522, 605, 691,
   749, 850, 912, 960, 1022 — line numbers will shift as you edit; match on
   the exact call text).
3. Grep contract:
   ```bash
   grep -rn "enablePullMode\|disablePullMode" test/
   ```
   Expected after this step: no matches. If other test files match, STOP
   and report (the verified state had matches only in
   `scheduler-pull.test.ts`).

Verify: run `test/scheduler-pull.test.ts` (single-file command from
00-README G3). All remaining tests pass.

Commit: `test(runner): drop push-mode baseline and redundant enablePullMode calls`

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

Expected: no matches (comments included — if a comment mentions push mode,
delete the sentence, keeping the rest of the comment intact).

Verify: `deno check src/scheduler.ts`, then the full runner suite
(`deno task test`).

Commit (covers steps 2+3):
`refactor(runner): remove push scheduler mode and pullMode branches (scheduler-v2 phase 0)`

## Step 4 — Remove push paths from the runner and remaining call sites

1. Find all remaining mode-API callers:
   ```bash
   grep -rn "isPullModeEnabled" ../../packages --include="*.ts"
   ```
   Expected sites (verified): `runner.ts:2702`, `runner.ts:2813`
   (`patternNeedsOneShotPull`), `runner.ts:2828`
   (`pullCellOnceAfterSuccessfulCommit`). Anything else: STOP and report.
2. `src/runner.ts` `handleJavaScriptHandlerResult` (~2702-2736): the block
   `if (!this.runtime.scheduler.isPullModeEnabled()) { ... } else { addCancel(() => this.stop(resultCell)); }`
   — delete the entire push branch (the `readResultAction` subscription,
   its commit callback, and its addCancel), keeping only
   `addCancel(() => this.stop(resultCell));`. NOTE for the reviewer log:
   the deleted push branch contained on-commit-error cancel+stop cleanup;
   its pull-mode replacement is built in work order 03 (phase E1). Add no
   substitute here.
3. `patternNeedsOneShotPull` (~2813): change
   `if (!this.runtime.scheduler.isPullModeEnabled() || !pattern)` to
   `if (!pattern)`.
4. `pullCellOnceAfterSuccessfulCommit` (~2828): delete the
   `if (!this.runtime.scheduler.isPullModeEnabled()) { return; }` guard.
5. Telemetry: in `src/telemetry.ts`, locate the `scheduler.mode.change`
   event type member and delete it (grep `mode.change` — expected: the
   type definition only, since the emit sites died with
   enable/disablePullMode; any other site: STOP).

Verify: `deno check src/runner.ts src/telemetry.ts`; full runner suite;
additionally run the html/ui package checks if telemetry types are imported
there:
```bash
grep -rn "mode.change" ../../packages --include="*.ts"
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
- [ ] `grep -rn "pullMode\|enablePullMode\|disablePullMode\|isPullModeEnabled" src/ test/` → no matches.
- [ ] `schedulerRuntimeFingerprint` still emits `runner:scheduler:pull`
      (grep shows the function unchanged).
- [ ] Full runner suite green; `scheduler-pull.test.ts` runs with no mode
      toggles.
- [ ] No new files; no renames; diff is delete-dominated.
- [ ] Benchmarks still compile: `deno task bench` starts (may be aborted
      after the first bench completes; record that it ran).
