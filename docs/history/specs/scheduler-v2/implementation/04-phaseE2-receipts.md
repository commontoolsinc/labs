---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed scheduler-v2 work order (Phase E2: receipts as result cells); shipped in the #4288 cutover."
---

# Work order 04 — Phase E2: Receipts = result cells (exactly-once)

> Implements invariant I11 (spec §7.6): at most one handling commit per
> event id, witnessed by the create of the handling's result cell.
> Default-on for ALL events (spec decision 14), gated only by the
> transitional `commitPreconditions` protocol flag from work order 03.
> PR title:
> `feat(runner,memory): exactly-once event handling via result-cell receipts (scheduler-v2 E2)`.

Spec: §7.6 "Receipts", resolved decisions 12, 13, 14.
Paths relative to `packages/runner/` unless noted.

## Step 1 — Single handler per event (decision 12)

1. `src/scheduler/events.ts` `addSchedulerEventHandler`: before pushing,
   search `state.eventHandlers` for an entry whose link matches
   `areNormalizedLinksSame(existing, args.ref)`. If found: remove it and
   `logger.warn` (`"event-handler-replaced"`, include the link id). Last
   registration wins — re-registration across piece reload is the normal
   lifecycle, which is why this is a warn-and-replace, not an error.
2. `queueSchedulerEvent`: after the first match in the handler loop,
   `break`. Keep the loop structure; add the comment:
   `// Exactly one handler per event (spec scheduler-v2 decision 12).`
3. Fixture (`test/scheduler-events.test.ts` or a new
   `test/scheduler-single-handler.test.ts` if the former's pre-existing
   type issue (00-README G3) interferes): registering two handlers for the
   same link → one event dispatch total, to the second handler; a warn was
   logged (assert via logger counts if the repo's logger exposes them —
   grep `getLoggerCounts`; otherwise assert dispatch counts only).

Verify: full runner suite. If any existing test registered two handlers
for one link and relied on fanout: STOP and report (decision 12 predicts
none).

Commit: `feat(runner): one handler per event link, last registration wins (scheduler-v2 E2)`

## Step 2 — Event-causal handler causes (decision 13 bridge)

File: `src/runner.ts`, `instantiateJavaScriptHandlerNode` (~line 2995):

Replace

```typescript
// Shown inside a pattern body.
const cause = {
  ...(inputs as Record<string, any>),
  $event: crypto.randomUUID(),
};
```

with

```typescript
// Shown inside a pattern body.
// Spec scheduler-v2 §7.6 / decision 13: the handler's result cell — and
// every id minted in this frame — derives from the durable event id, so
// retries of the same event reuse the same ids and duplicate handlings
// collide on the receipt. The fallback covers non-dispatch invocations
// (tests calling the handler directly).
const cause = {
  ...(inputs as Record<string, any>),
  $event: tx.dispatchedEventId ?? crypto.randomUUID(),
};
```

(`dispatchedEventId` was stamped by dispatch in work order 02 step 2.3.)

Behavior-change sweep (G5-adjacent): run the FULL runner suite plus
`cd packages/patterns && deno task test` (or the closest pattern test
task — check that package's deno.jsonc). Failures whose assertions baked in
per-attempt-unique ids must be listed in PROGRESS.md and individually
justified before adjusting them; any failure you cannot attribute to id
determinism: STOP.

Commit: `feat(runner): handler frame causes derive from the event id (scheduler-v2 E2)`

## Step 3 — Engine: entity-absent receipt precondition

Files: `packages/memory/v2/engine.ts` plus the commit-operation type
located in work order 03 step 2.1.

1. Extend the commit precondition type with
   `{ kind: "entity-absent", id, scope? }` (wire-compatible optional
   precondition kind). Do not use an operation-level `createOnly` flag;
   receipts are commit-level preconditions independent of surviving writes.
2. In `validateCommitPreconditions`: if `entity-absent` and a head revision
   already exists for that (id, scope, branch), reject the whole commit via
   the same route as the origin-committed rejection (work order 03 step 3),
   with `{ name: "PreconditionFailedError", precondition: "receipt-exists" }`.
   "Head exists" includes deleted/tombstoned heads and must use the same
   scope-key resolution and delete-aware existence semantics as the engine's
   set/delete conflict checks.
3. Allow commits with no operations when preconditions are present, and write
   the commit row for localSeq continuity. This is required so a duplicate
   handling whose writes are fully elided still reaches the engine and fails
   the receipt precondition instead of succeeding locally as a no-op.
4. Engine tests (extend `v2-commit-preconditions.test.ts` from work order
   03): entity-absent on a fresh entity applies; second entity-absent commit
   for the same entity rejects with `receipt-exists`; normal `set` without the
   precondition still overwrites; create → delete → entity-absent for the same
   entity rejects with `receipt-exists`; precondition-only commits pass/fail
   correctly for absent/present entities.

Commit: `feat(memory): create-only set precondition for event receipts (scheduler-v2 E2)`

## Step 4 — Runner: unconditional receipt creation

Goal: every dispatched event's handling transaction creates the result
cell `{ resultFor: cause }` exactly once, marked create-only — including
handlers that launch nothing.

1. Extended-tx marking API. `src/storage/interface.ts` +
   `extended-storage-transaction.ts`: add

   ```typescript
   // Shown as interface or class members.
   /** Mark an entity this transaction creates as create-only: the commit
    *  fails with PreconditionFailedError("receipt-exists") if the entity
    *  already has a head (scheduler-v2 §7.6 receipts). */
   markCreateOnly?(link: { space: MemorySpace; id: string; scope?: unknown }): void;
   ```

   Store marked (space, scope, id) tuples; in `storage/v2.ts`
   `commitOperations`, emit a matching
   `{ kind: "entity-absent", id, scope }` commit precondition for each mark.
   This must happen even when no semantic operations survive elision. Only
   emit these preconditions when the `commitPreconditions` flag is on (same
   gate as work order 03; when the flag is off the mark is recorded but not
   emitted).
2. `src/runner.ts` `handleJavaScriptHandlerResult`: this function must now
   ALWAYS materialize the result cell. Restructure the head of the
   function:

   - Compute `resultCell`'s identity once:
     `const receiptCell = this.runtime.getCell(processCell.space, { resultFor: cause }, undefined, tx);`
     placed BEFORE the early return
     (`if (!validateAndCheckReactives(result, name) && frame.reactives.size === 0)`).
   - In the early-return (nothing-to-launch) branch, before
     `return result;`: write the minimal receipt value and mark
     create-only:

     ```typescript
     // Shown inside a pattern body.
     // Receipt-only handling (spec scheduler-v2 §7.6): nothing was
     // launched, but the result cell is still created — its create is the
     // exactly-once witness for this event id.
     receiptCell.withTx(tx).setRaw({});
     tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
     ```

     If `Cell` has no `setRaw`/`withTx` combination with these exact
     names, locate the lowest-level "write a fresh document value inside
     this tx" helper used when `run()` initializes a result cell (read
     `setupInternal`/`startCore` doc-initialization) and use that; record
     what you used in PROGRESS.md. Do NOT invent a new write path.
   - In the launching branch: the existing `this.run(tx, resultPattern, undefined, <result cell>)`
     keeps creating/initializing the doc; add
     `tx.markCreateOnly?.(<result cell>.getAsNormalizedFullLink());`
     immediately after the `run(...)` call (non-deferred path only).
   - The `deferForNavigate` paths run AFTER commit in fresh transactions —
     mark create-only on the result cell inside
     `setupDeferredHandlerResultPattern` is NOT possible (different tx);
     leave navigate paths unmarked and add the comment:
     `// navigateTo results are commit-gated (startAfterSuccessfulCommit);`
     `// the receipt precondition rides the deferred start's own create.`
     Then in `runPatternAfterSuccessfulCommit`'s start transaction, mark
     create-only on the result cell there (locate the tx it opens; if the
     structure makes this awkward, STOP and report rather than forcing
     it — navigate flows are rare and the gap is recorded).
   - Constraint check before coding: confirm `handleJavaScriptHandlerResult`
     is reachable ONLY from the handler dispatch path
     (`instantiateJavaScriptHandlerNode`'s postRun). Command:
     `grep -n "handleJavaScriptHandlerResult" src/runner.ts` — expected:
     definition + exactly one call site (~line 3100). More call sites:
     STOP (reactive actions must not grow receipts).
3. Client drop on lost race. `src/scheduler/events.ts`
   `dispatchQueuedEvent` commit-result handling: E0 already prevents
   retrying permanent rejections. Add, in the permanent branch, a
   `logger.warn("event-lost-race", ...)` including the event id when
   `result.error?.precondition === "receipt-exists"`, and extend the
   `scheduler.event.commit` telemetry payload with
   `...(isPermanentRejection(result.error) ? { permanentRejection: (result.error as IPreconditionFailedError).precondition } : {})`.
   Update the telemetry type in `src/telemetry.ts` accordingly (optional
   field — additive).

Verify: full runner suite with the `commitPreconditions` experimental flag
both off (default; receipts not emitted — suite must be unchanged) and on
(set it in the scheduler test-runtime helper the way
`persistentSchedulerState` tests do — grep
`setPersistentSchedulerStateConfig` under `test/` and mirror).

Commit: `feat(runner): every event handling creates its result cell as a create-only receipt (scheduler-v2 E2)`

## Step 5 — Fixtures

File: `test/scheduler-event-receipts.test.ts` (flag on for all of these;
fixture-first where marked):

1. **Redelivery dedup (fixture-first)**: queue the same logical event
   twice with an explicit shared `eventId` (the E0 `opts.eventId`
   parameter — this is the faithful single-runtime proxy for ingress
   redelivery). Expected: handler's effects observable once; the second
   handling's commit rejected `receipt-exists`; no retry occurred (handler
   invocation count exactly 2 — it RUNS twice, commits once); telemetry
   shows the permanent rejection.
2. **Launch dedup**: same, with a pattern-launching handler — exactly one
   piece exists at the result cell after settle.
3. **Retry self-compatibility**: force a retryable conflict on another doc
   in the handler's tx (reuse the scheduler-retries helper); the retry
   commits fine — its receipt id is identical and its first attempt never
   committed.
4. **Receipt-only handling**: a handler that returns undefined and
   launches nothing → after settle, the result cell document exists (read
   it back via a fresh cell handle) with value `{}`.
5. **Flag off**: same scenario as (1) with the flag off → both commits
   apply (documented transitional behavior), no receipt docs asserted.

Optional stretch (only if directed): a true cross-runtime race via the
multi-runtime harness — locate with
`grep -rn "multi-runtime\|MultiRuntime" test/ ../cli/` and follow its
existing usage pattern; if no runner-level harness exists, note that the
engine test (work order 04 step 3) plus fixture 1 cover the semantics and
skip.

Commit: `test(runner): receipt exactly-once fixtures (scheduler-v2 E2)`

## Exit checklist (reviewer)

- [ ] One handler per link enforced; replacement warns; no fanout loop
      remains without its `break`.
- [ ] `crypto.randomUUID()` appears in `instantiateJavaScriptHandlerNode`
      only as the non-dispatch fallback.
- [ ] Receipt creation is unconditional under the flag, absent without it;
      no receipt logic on the reactive action path (grep `markCreateOnly`
      — sites: extended tx impl, v2.ts emission, runner handler-result
      paths only).
- [ ] Lost race → drop, warn, telemetry; never a retry (fixture 1).
- [ ] Engine create-only semantics reviewed by memory owner (tombstone
      question answered and recorded).
- [ ] Full runner + memory suites green, flag on and off.
