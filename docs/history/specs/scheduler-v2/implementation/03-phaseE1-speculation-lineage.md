---
status: historical
created: 2026-06-11
archived: 2026-07-09
reason: "Executed scheduler-v2 work order (Phase E1: speculation lineage); shipped in the #4288 cutover."
---

# Work order 03 — Phase E1: Speculation lineage

> Implements invariant I10 (spec §7.6): work launched by a handler attempt
> survives only if that attempt's transaction commits. Touches the memory
> engine — flag the PR for memory-owner review. PR title:
> `feat(runner,memory): speculation lineage for event-launched work (scheduler-v2 E1)`.

Spec: §7.6 "Speculation lineage", resolved decisions 7, 9, 11.
Paths relative to `packages/runner/` unless noted.

Design recap (do not deviate):

- **Same-space** follow-up (origin tx committed into the event's space):
  dispatch immediately as today; the handler tx carries an
  `origin-committed` precondition checked by the memory engine.
- **Cross-space** follow-up: the event PARKS until the origin commit
  confirms, then dispatches with no precondition; on origin failure it is
  dropped. No server-side cross-space verification exists or is added.
- Descendants of a failed attempt are never retried; a retried parent
  re-sends fresh events (new ids — E0 already guarantees this because the
  retry runs in a new transaction).
- Renderer/ingress events (no `originTx`) are completely unaffected.

## Step 1 — Capture per-space commit identity on the source transaction

The engine checks "a committed commit from this session with localSeq L
exists in this space". The client must therefore know, per space, the
`localSeq` its origin transaction used.

1. New file `src/storage/commit-identity.ts`:

   ```typescript
   // Shown at module scope.
   import type { IStorageTransaction, MemorySpace } from "./interface.ts";

   // Per-space client commit sequence numbers recorded for a source
   // transaction at commit-build time (storage/v2.ts). Used by speculation
   // lineage (scheduler-v2 §7.6) to express the `origin-committed`
   // precondition for follow-up work.
   const localSeqBySource = new WeakMap<object, Map<MemorySpace, number>>();

   export function recordCommitLocalSeq(
     source: IStorageTransaction,
     space: MemorySpace,
     localSeq: number,
   ): void {
     let bySpace = localSeqBySource.get(source);
     if (!bySpace) {
       bySpace = new Map();
       localSeqBySource.set(source, bySpace);
     }
     bySpace.set(space, localSeq);
   }

   export function getCommitLocalSeq(
     source: IStorageTransaction | undefined,
     space: MemorySpace,
   ): number | undefined {
     if (!source) return undefined;
     return localSeqBySource.get(source)?.get(space);
   }
   ```

2. `src/storage/v2.ts`, in `commitOperations` immediately after
   `const localSeq = this.#nextLocalSeq++;` (~line 1608): when
   `source !== undefined`, call
   `recordCommitLocalSeq(source, this.#space, localSeq);` (import the
   helper; the space field is `this.#space`, the same one used in the
   notification at ~1673).

Verify: `deno check src/storage/v2.ts`; run
`test/scheduler-retries.test.ts` and one storage test file
(`ls test | grep -i "storage\|transaction"` — run the closest match) to
confirm nothing regressed.

Commit: `feat(runner): record per-space commit localSeq on source transactions (scheduler-v2 E1)`

## Step 2 — Precondition plumbing: extended tx → ClientCommit

1. Locate the `ClientCommit` type:
   ```bash
   grep -rn "ClientCommit" ../../packages/memory ../../packages/runner/src/storage --include="*.ts" | grep -i "interface\|type\|="
   ```
   Read its definition. Add an optional field (JSON-serializable):

   ```typescript
   // Shown as interface or class members.
   preconditions?: Array<{
     kind: "origin-committed";
     /** localSeq of a commit from the SAME session in this space. */
     originLocalSeq: number;
   }>;
   ```

2. `src/storage/interface.ts` — on `IExtendedStorageTransaction`:

   ```typescript
   // Shown as interface or class members.
   /**
    * Commit-time preconditions attached to this transaction's commit in
    * the given space (scheduler-v2 §7.6). Violations surface as
    * IPreconditionFailedError (permanent — never retried).
    */
   addCommitPrecondition?(
     space: MemorySpace,
     precondition: { kind: "origin-committed"; originLocalSeq: number },
   ): void;
   ```

3. `src/storage/extended-storage-transaction.ts`: implement
   `addCommitPrecondition` — store in a private
   `Map<MemorySpace, Array<...>>`; expose a getter the v2 commit path can
   read via the *source* object. Mechanism: mirror how
   `setSchedulerObservation` data reaches `commitOperations` (read that
   path first and copy its pattern — grep `schedulerObservation` in
   `src/storage/v2.ts` and the extended transaction). In
   `commitOperations`, include `preconditions` in the built `ClientCommit`
   when present for `this.#space`.

4. Protocol flag: in `packages/memory/v2.ts`, replicate the
   `persistentSchedulerState` flag pattern (lines ~541-587: module
   variable, `set...Config`, `get...Config`, `reset...Config`, inclusion
   in the protocol-flags object and `compatibleMemoryProtocolFlags`)
   for a new flag named `commitPreconditions` (it will also cover E2
   receipts). Client side: only attach preconditions to outgoing commits
   when the flag is on. Runtime wiring: add
   `experimental.commitPreconditions` mirroring how
   `experimental.persistentSchedulerState` flows in `src/runtime.ts`
   (~lines 20-26). Tests construct runtimes with the flag on explicitly.

Verify: `deno check` on touched files; full runner suite (no behavior
change yet — nothing attaches preconditions).

Commit: `feat(runner,memory): commit precondition plumbing behind commitPreconditions flag (scheduler-v2 E1)`

## Step 3 — Engine check

File: `packages/memory/v2/engine.ts`.

1. Read `applyCommitTransaction` (~line 3078) until you can answer: (a)
   where the commit's session identity is available, (b) how the
   stale-read conflict rejection is constructed and returned
   (~lines 3411-3467) — the precondition rejection must use the same
   return mechanism.
2. Before the operations are applied (adjacent to the read-conflict
   checks), evaluate `commit.preconditions`: for each
   `{ kind: "origin-committed", originLocalSeq }`, query the commit table
   for a committed commit from the **same session** with that
   `localSeq`. If none exists, reject the whole commit with an error whose
   wire shape reaches the client as
   `{ name: "PreconditionFailedError", precondition: "origin-committed", message: ... }`
   — the existing route normalizes errors, so extend it end to end:
   add an `Engine.PreconditionFailedError` sibling to `Engine.ConflictError`
   with `precondition: "origin-committed" | "receipt-exists"`, map it in
   `packages/memory/v2/server.ts` before the `TransactionError` catch-all,
   add optional `precondition?: string` to `V2Error`, and copy that property
   onto the reconstructed client `Error` in `packages/memory/v2/client.ts`.
   Do not encode this through `ConflictError` or `TransactionError`; the
   runner's permanent-rejection taxonomy is name-keyed and already recognizes
   `PreconditionFailedError`.
3. Same-session ordering note (add as a comment at the check): commits
   from one session are applied in order, so the origin's fate is decided
   when the follow-up arrives; an absent origin means it was rejected.
4. Engine tests: `packages/memory/test/` — add
   `v2-commit-preconditions.test.ts` (mirror an existing engine test's
   setup; grep for a test that calls `applyCommit`):
   - commit B with precondition on committed A's localSeq → applies;
   - commit B with precondition on a localSeq that was rejected (force a
     conflict for A first) → B rejected with `PreconditionFailedError`;
   - commit with no preconditions → unaffected.

Commit: `feat(memory): origin-committed commit precondition (scheduler-v2 E1)`

## Step 4 — Lineage registry

New file: `src/scheduler/lineage.ts`.

```typescript
// Shown for illustration only.
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { QueuedEvent } from "./types.ts";

export type OriginStatus = "pending" | "confirmed" | "failed";

interface OriginRecord {
  status: OriginStatus;
  events: Set<QueuedEvent>;
  pieceStops: Array<() => void>;
}

/**
 * Speculation lineage (scheduler-v2 §7.6 / I10): tracks work launched by a
 * transaction so it can be released on commit success or cancelled on
 * failure. Records are created lazily on first launch and removed when the
 * origin settles and its launches are flushed.
 */
export class SpeculationLineage {
  private byOrigin = new Map<IExtendedStorageTransaction, OriginRecord>();

  constructor(
    private readonly hooks: {
      /** Remove a not-yet-dispatched event from the queue. */
      removeQueuedEvent: (event: QueuedEvent) => void;
      /** Wake the scheduler (parked cross-space events become ready). */
      queueExecution: () => void;
      onError: (error: unknown) => void;
    },
  ) {}

  private recordFor(origin: IExtendedStorageTransaction): OriginRecord {
    let record = this.byOrigin.get(origin);
    if (!record) {
      const originStatus = origin.status().status;
      record = {
        status: originStatus === "done"
          ? "confirmed"
          : originStatus === "error"
          ? "failed"
          : "pending",
        events: new Set(),
        pieceStops: [],
      };
      this.byOrigin.set(origin, record);
      if (record.status !== "pending") return record;
      origin.addCommitCallback((_tx, result) => {
        const settled = this.byOrigin.get(origin);
        if (!settled) return;
        settled.status = result.error ? "failed" : "confirmed";
        if (result.error) {
          for (const event of settled.events) {
            try {
              this.hooks.removeQueuedEvent(event);
            } catch (error) {
              this.hooks.onError(error);
            }
          }
          settled.events.clear();
          for (const stop of settled.pieceStops) {
            try {
              stop();
            } catch (error) {
              this.hooks.onError(error);
            }
          }
          settled.pieceStops.length = 0;
          this.byOrigin.delete(origin);
        } else {
          // Success: compensation is moot, but the EVENTS must stay
          // registered — still-queued descendants (e.g. cross-space parked
          // ones) keep asking originStatus() until they dispatch and
          // release(). Clearing them here would let the first release()
          // delete the record and strand the rest.
          settled.pieceStops.length = 0;
        }
        this.hooks.queueExecution();
      });
    }
    return record;
  }

  recordEvent(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    this.recordFor(origin).events.add(event);
  }

  recordPieceStop(origin: IExtendedStorageTransaction, stop: () => void): void {
    this.recordFor(origin).pieceStops.push(stop);
  }

  /** Called when an event is dispatched or dropped. */
  release(origin: IExtendedStorageTransaction, event: QueuedEvent): void {
    const record = this.byOrigin.get(origin);
    if (!record) return;
    record.events.delete(event);
    if (
      record.status !== "pending" && record.events.size === 0 &&
      record.pieceStops.length === 0
    ) {
      this.byOrigin.delete(origin);
    }
  }

  originStatus(origin: IExtendedStorageTransaction): OriginStatus {
    return this.byOrigin.get(origin)?.status ??
      // Unknown origin ⇒ the record was settled and fully released. A
      // still-queued event always finds its record (failure removes the
      // event synchronously; success keeps the record until release()),
      // so this fallback is only reachable after settlement — and it must
      // be "confirmed": "pending" would park a cross-space event forever,
      // since the commit callback that wakes it has already fired.
      "confirmed";
  }
}
```

Caveat to verify while implementing: `addCommitCallback` must fire even
for read-only/no-op commits (the origin handler may have made no writes).
Read `extended-storage-transaction.ts` `addCommitCallback` + commit (~line
841-857) and confirm callbacks run on every commit() resolution path; if
any early-return path skips callbacks, STOP and report it. Commit callbacks do
not fire retroactively for already-settled transactions; `recordFor()` must
inspect `origin.status()` before registering a callback.

Unit tests: `test/scheduler-lineage.test.ts` — record/fail cancels events
(removeQueuedEvent called) and runs pieceStops; record/confirm does NOT
remove events and drops pieceStops; **two recorded events, origin
confirms, first release()s → second still reads `"confirmed"`** (the
stranded-sibling regression); release() of the last event after
settlement deletes the record; originStatus of an unknown origin returns
`"confirmed"`; double-settle safe; record on an already-committed origin
reports `"confirmed"` without registering a commit callback; record on an
already-failed/aborted origin reports `"failed"` without registering a commit
callback.

Commit: `feat(runner): speculation lineage registry (scheduler-v2 E1)`

## Step 5 — Scheduler integration

1. `src/scheduler.ts`: instantiate
   `readonly lineage = new SpeculationLineage({...})` with
   `removeQueuedEvent: (event) => { const i = this.eventQueue.indexOf(event); if (i >= 0) this.eventQueue.splice(i, 1); }`,
   `queueExecution: () => this.queueExecution()`,
   `onError: (error) => logger.error("lineage", () => [error])`.
2. `src/scheduler/events.ts` `queueSchedulerEvent`: when
   `args.originTx !== undefined`, after pushing the QueuedEvent call a new
   state hook `state.recordLineageEvent(originTx, queuedEvent)` (add to
   `SchedulerEventQueueState`, wired in `createEventQueueState` to
   `this.lineage.recordEvent`). Also record on the `ensurePieceRunning`
   requeue path (it constructs the event via `state.queueEvent`, which
   re-enters this function — verify no double-record by making
   `recordEvent` idempotent via the Set, which it already is).
3. Head-event gating. File `src/scheduler/pull-events.ts` (read it first —
   it owns per-pass head processing): BEFORE preflight of the head event,
   insert, in this order:

   ```
   if (head.originTx) {
     status = lineage.originStatus(head.originTx)
     if (status === "failed") { /* drop + release + debug-log; already-failed
        settled origins reach this path and must not dispatch */ }
     sameSpace = getCommitLocalSeq(head.originTx.tx, head.eventLink.space) !== undefined
     if (!sameSpace && status === "pending") {
       // Cross-space: park until origin confirmation (spec decision 11).
       // The lineage commit callback calls queueExecution() on settle.
       skip this event for this pass (leave at head; do NOT set notBefore)
     }
   }
   ```

   Exact integration points depend on `pull-events.ts` structure; the
   contract: a cross-space-pending head event behaves like a parked head
   (blocks its lane, `idle()` stays open while a wake source exists — the
   commit callback IS the wake source). Extend the state bundle with
   `lineageStatus`/`getCommitLocalSeq` accessors as needed; list additions
   in PROGRESS.md.
4. Dispatch precondition. `dispatchQueuedEvent`: after creating `tx`, if
   `queuedEvent.originTx` and origin status is `"pending"` and same-space
   (per the same `getCommitLocalSeq` check, against
   `queuedEvent.eventLink.space`) and the `commitPreconditions` flag is on:
   `tx.addCommitPrecondition?.(queuedEvent.eventLink.space, { kind: "origin-committed", originLocalSeq });`
   Then `lineage.release(originTx, queuedEvent)` once dispatch proceeds
   (it is no longer cancellable).
5. `idle()` interaction: confirm (test, not assume) that a parked
   cross-space head keeps `idle()` pending. The existing mechanism for
   parked heads keys off the wake timer; the lineage park has no timer.
   Read `idle()` (~scheduler.ts:918-953) and `continuation.ts`; add the
   minimal condition: idle waits while
   `eventQueue[0]?.originTx && lineage.originStatus(...) === "pending"`
   (a commit always settles, so this cannot wedge; cite this in a
   comment). Add the accessor to the continuation/idle state bundles as
   needed.

Fixtures (fixture-first, G5) in `test/scheduler-event-lineage.test.ts`:

- **Duplication kill**: handler A (commit forced to conflict once — reuse
  the conflict-forcing helper from `test/scheduler-retries.test.ts`; read
  it first) sends event to handler B. Expected: B handles exactly once,
  with the payload from A's committed attempt. Under v1 behavior this
  test, written first, MUST fail by observing two B dispatches — paste
  the red output in PROGRESS.md.
- **Permanent failure**: handler A exhausts retries → B never dispatches;
  the queue does not contain the event after settle.
- **Payload-only follow-up**: B's handler reads only `$event` (no cell
  reads overlapping A's writes); same expectations (this is the case the
  storage layer's read-dependency rejection cannot catch).
- **Piece stop**: handler A returns a pattern (launch) and its commit
  fails permanently → the launched piece's result cell is not running
  (`runner.stop` returned false / piece absent) after settle. Wire-up for
  this assertion comes in step 6; keep the test in this file.
- **Cross-space park**: origin handler in space S1 sends to a stream in
  space S2. Assert the event does not dispatch before the origin commit
  resolves, dispatches after confirmation, and is dropped (never
  dispatched) when the origin fails. Two-space runtime setup: copy the
  pattern from an existing two-space test (grep
  `getCell(space2\|secondSpace` under `test/` and reuse that file's
  bootstrap).

Commit: `feat(runner): lineage gating for handler-sent events (scheduler-v2 E1)`

## Step 6 — Compensating stop for handler-result pieces

File: `src/runner.ts`, `handleJavaScriptHandlerResult`.

After the `this.run(...)` call that instantiates the result pattern (the
non-deferred path; after phase 0 the block ends with
`addCancel(() => this.stop(resultCell));`), add:

```typescript
// Shown for illustration only.
// Spec scheduler-v2 §7.6 rule 2: the launch is speculative; if this
// handler's transaction ultimately fails, stop the piece (data writes
// roll back with the transaction; registrations do not).
this.runtime.scheduler.lineage.recordPieceStop(
  tx,
  () => this.stop(resultCell),
);
```

`navigateTo` results (the `runPatternAfterSuccessfulCommit` /
`setupDeferredHandlerResultPattern` paths) stay commit-gated — do not
touch them.

Also (spec resolved decision 9) add the watch comments at the two retry
exhaustion sites in `src/scheduler/action-run.ts`:

- in `watchReactiveActionCommit`, in the `else` of
  `if (retries < MAX_RETRIES_FOR_REACTIVE ...)` (add an else if absent
  purely for the comment + existing retries-delete behavior):
  `// WATCH(scheduler-v2): exhausted retries can leave a piece registered`
  `// against rolled-back data (accepted zombie — spec §15 decision 9).`
- same comment in `rescheduleActionForImmediateRetry`'s exhaustion branch.

Verify: the piece-stop fixture from step 5 goes green; full runner suite.

Commit: `fix(runner): stop handler-launched pieces when the handler commit fails (scheduler-v2 E1)`

## Exit checklist (reviewer)

- [ ] All five fixtures green; duplication fixture demonstrably red-first
      in PROGRESS.md.
- [ ] Preconditions only attached when `commitPreconditions` flag on AND
      same-space AND origin pending (code inspection).
- [ ] Cross-space park has no timer; wake = lineage commit callback;
      `idle()` cannot wedge (comment + test present).
- [ ] Renderer-path events (no originTx) take zero new branches (inspect
      `queueSchedulerEvent` fast path).
- [ ] Engine change reviewed by memory owner; engine tests green
      (`cd packages/memory && deno task test`).
- [ ] No change to event FIFO order among surviving events.
