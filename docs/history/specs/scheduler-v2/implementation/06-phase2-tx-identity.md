---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed scheduler-v2 work order (Phase 2: transaction-carried identity); shipped in the #4288 cutover."
---

# Work order 06 — Phase 2: Transaction-carried identity

> Replaces the `inFlightSources` bookkeeping with one object-identity
> comparison (spec P5). Deliberately narrow: the in-process propagation
> channel and the conditional-effect machinery are NOT touched here (they
> die inside the phase-3 cutover — see migration plan). PR title:
> `refactor(runner): tx-carried source action for self-suppression (scheduler-v2 phase 2)`.

Spec: P5; migration plan "Phase 2 — Tx-carried identity".
Paths relative to `packages/runner/`.

Hard rule for this order: self-suppression compares **object identity**
(`source.sourceAction === action`), never the diagnostic action id —
distinct action instances can share ids (e.g. two `pull:<uri>` actions on
the same cell).

## Step 1 — The field

1. `src/storage/interface.ts`, on `IStorageTransaction` (the INNER
   transaction — notifications carry it as `source`; precedent: the
   informal `debugActionId` is read off it in `transaction.ts:282` and
   `v2-transaction.ts:1367`):

   ```typescript
   // Shown as interface or class members.
   /**
    * The scheduler action whose run opened this transaction (spec
    * scheduler-v2 P5). Change records derived from this transaction must
    * not re-trigger this action. Compared by OBJECT IDENTITY — diagnostic
    * action ids may collide across instances.
    */
   sourceAction?: object;
   ```

   (`object`, not `Action`, to avoid an import cycle from storage into
   scheduler types; the scheduler compares identity only.)

2. `src/scheduler/action-run.ts` `runSchedulerAction`, next to the
   existing `debugActionId` stamp (~337):
   `tx.tx.sourceAction = action;` (keep `debugActionId` — it feeds
   diagnostics/telemetry).

3. `src/scheduler/events.ts` `dispatchQueuedEvent`, after creating `tx`:
   `tx.tx.sourceAction = action;` (the per-dispatch action closure;
   harmless for suppression — it is never subscribed — and correct for
   provenance).

Commit: `feat(runner): stamp the source action on run transactions (scheduler-v2 phase 2)`

## Step 2 — Swap the suppression check; delete inFlightSources

1. `src/scheduler/pull-notifications.ts` (~100-102): replace

   ```typescript
   // Shown inside a pattern body.
   const isOwnCommitSource = notification.type === "commit" &&
     notification.source !== undefined &&
     state.inFlightSources.get(action)?.has(notification.source) === true;
   ```

   with

   ```typescript
   // Shown inside a pattern body.
   const isOwnCommitSource = notification.type === "commit" &&
     notification.source !== undefined &&
     notification.source.sourceAction === action;
   ```

2. Delete the bookkeeping, all sites:

   ```bash
   grep -rn "inFlightSources\|InFlightSourceState\|addInFlightSource\|removeInFlightSource" src/
   ```

   Expected sites (verified, untruncated): `action-run.ts` (state
   interface, add/remove helpers, the add at ~338, the remove in
   `watchReactiveActionCommit`'s finally and in
   `rescheduleActionForImmediateRetry`), `scheduler.ts` (field ~366-368,
   `createStorageNotificationState` member, `createActionRunState`
   member), `notifications.ts` (`StorageNotificationState.inFlightSources`
   member), and `test/scheduler-cfc-trigger-reads.test.ts` (builds a
   `StorageNotificationState` stub with an `inFlightSources` member and a
   self-suppression case at ~160-165 — rewrite that case to stamp
   `sourceTx.sourceAction = action` instead, and drop the stub member).
   `push-notifications.ts` matched before phase 0 and is already gone.
   Delete every one; the `watchReactiveActionCommit` `.finally()` that
   only removed the source collapses (keep the catch for the commit
   promise). Any other site: STOP.

3. **Do NOT touch** the change-group skip
   (`planSkippedTriggeredAction`'s `skip-same-change-group` branch,
   `notifications.ts:138-147`). Add above it:

   ```typescript
   // changeGroup is a user-facing suppression feature: external
   // subscribers (e.g. cf-code-editor sinks) group their own writes so
   // their subscription ignores them. It is NOT scheduler-internal
   // self-suppression — that is tx.sourceAction (spec scheduler-v2 P5).
   ```

## Step 3 — Fixtures (fixture-first for the sibling case)

File: `test/scheduler-tx-identity.test.ts`.

1. **Self-suppression**: a computation that reads and writes the same
   cell path (idempotently: writes the value it computed) runs once per
   external input change — its own commit does not re-trigger it. (This
   should already pass before the swap — run it against step-1 state to
   prove the new mechanism, then against step-2 state.)
2. **Shared-id siblings (fixture-first against a HYPOTHETICAL id-based
   implementation — here it documents the requirement)**: two `pull()`
   calls on the same cell while a third action writes it; both pulls
   resolve with the new value. Add the comment:
   `// Guards P5's object-identity rule: these two actions share the`
   `// diagnostic id "pull:<uri>"; id-based suppression would starve one.`
3. **changeGroup feature intact**: replicate the cf-code-editor shape —
   sink subscribed with `changeGroup: G`; a write committed via a tx whose
   `changeGroup` is `G` does not re-fire the sink; a write without the
   group does. (Mirror the subscription plumbing from
   `cell.ts:2323`/`sinkHelper`.)

Verify: full runner suite + `test/scheduler-retries.test.ts` specifically
(retry paths previously interacted with the in-flight lifecycle).

Commit: `refactor(runner): object-identity self-suppression replaces inFlightSources (scheduler-v2 phase 2)`

## Exit checklist (reviewer)

- [ ] `grep -rn "inFlightSources" packages/runner/src` → no matches.
- [ ] Suppression compares `sourceAction === action`; no id strings
      anywhere in the check.
- [ ] changeGroup branch untouched plus the explanatory comment.
- [ ] The three fixtures green; retries suite green.
- [ ] events dispatch and action runs both stamp `sourceAction`.
