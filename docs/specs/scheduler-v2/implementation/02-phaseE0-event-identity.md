# Work order 02 — Phase E0: Event identity + rejection taxonomy

> Shared infrastructure for lineage (03) and receipts (04). No behavior
> change for existing flows except: permanent rejections (a new error class
> nothing emits yet) would not be retried. PR title:
> `feat(runner): durable event ids + permanent-rejection taxonomy (scheduler-v2 E0)`.

Spec: §7.5 (event identity), §7.6 (taxonomy), decisions 7/8.
Paths relative to `packages/runner/` unless noted.

Execution correction: Step 3 must be completed before Step 2, because Step 2
sets `tx.dispatchedEventId` and Step 3 declares that transaction field. Execute
this order: Step 1 → Step 3 → Step 2 → Step 4.

## Step 1 — Event identity module

New file: `src/scheduler/event-identity.ts`

```typescript
// Shown at module scope.
import type { NormalizedFullLink } from "../link-utils.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

// Per-origin-transaction state for minting causally-derived event ids:
// a stable random key for the transaction plus a send counter. Both live
// only as long as the transaction object; retries of the sending handler
// run in a NEW transaction and therefore mint fresh ids (spec §7.6: each
// attempt's launches are tied to that attempt).
const txEventKeys = new WeakMap<object, { key: string; counter: number }>();

function originStateFor(tx: object): { key: string; counter: number } {
  let state = txEventKeys.get(tx);
  if (!state) {
    state = { key: crypto.randomUUID(), counter: 0 };
    txEventKeys.set(tx, state);
  }
  return state;
}

/**
 * Mints the durable id for an event at send time (spec §7.5). Ingress
 * callers that already own a durable delivery id pass it through instead.
 */
export function mintEventId(
  eventLink: NormalizedFullLink,
  originTx?: IExtendedStorageTransaction,
): string {
  if (originTx) {
    const state = originStateFor(originTx);
    const seq = state.counter++;
    return `evt:${state.key}:${seq}:${eventLink.id}`;
  }
  return `evt:${crypto.randomUUID()}:${eventLink.id}`;
}
```

(Exact code; keep comments. `eventLink.id` suffix is for log readability,
not uniqueness.)

Verify: `deno check src/scheduler/event-identity.ts`.

Commit: `feat(runner): event-id minting helper (scheduler-v2 E0)`

## Step 2 — Carry id + origin on QueuedEvent

1. `src/scheduler/types.ts`: find `QueuedEvent`. Add fields:

   ```typescript
   // Shown as JSX element children.
   /** Durable event id minted at send (spec §7.5). */
   readonly id: string;
   /** The transaction whose handler sent this event, when transactional. */
   readonly originTx?: IExtendedStorageTransaction;
   ```

   Add the `IExtendedStorageTransaction` import if missing.

2. `src/scheduler.ts` `queueEvent(...)` (~line 970): append a final optional
   parameter:

   ```typescript
   // Shown for illustration only.
   opts: { eventId?: string; originTx?: IExtendedStorageTransaction } = {},
   ```

   and pass `eventId: opts.eventId, originTx: opts.originTx` through into
   `queueSchedulerEvent`'s args object.

3. `src/scheduler/events.ts`:
   - `SchedulerEventQueueState.queueEvent` member type: append the same
     `opts` parameter.
   - `queueSchedulerEvent(state, args)`: extend `args` with
     `readonly eventId?: string; readonly originTx?: IExtendedStorageTransaction`.
     At the top compute once:
     `const id = args.eventId ?? mintEventId(args.eventLink, args.originTx);`
     Include `id` and `originTx: args.originTx` in the pushed `QueuedEvent`.
     In the no-handler `ensurePieceRunning` requeue (the
     `state.queueEvent(...)` call), pass
     `{ eventId: id, originTx: args.originTx }` so the requeued event keeps
     its identity.
   - `dispatchQueuedEvent`: in BOTH requeue sites (the `RetryImmediately`
     unshift and the commit-error unshift), the reconstructed object must
     carry `id: queuedEvent.id` and `originTx: queuedEvent.originTx`
     (preserve identity across retries — the retry is the SAME event).
   - `dispatchQueuedEvent`: immediately after `const tx = state.runtime.edit();`
     add `tx.dispatchedEventId = queuedEvent.id;` (field added in step 3).

4. `src/cell.ts` stream-send branch (~line 1167): change the
   `this.runtime.scheduler.queueEvent(resolvedToValueLink, event, undefined, onCommit)`
   call to pass a fifth/sixth argument per the new signature:
   `..., onCommit, false, { originTx: this.tx ?? undefined })` — check the
   current positional arity at the call site and match it exactly; the
   existing fifth positional (`doNotLoadPieceIfNotRunning`) keeps its
   default `false` explicitly.

5. Caller sweep:

   ```bash
   grep -rn "queueEvent(" ../../packages --include="*.ts" | grep -v "\.test\.ts"
   ```

   Expected non-test sites: `cell.ts` (edited above), `scheduler.ts`
   (definition), `events.ts` (internal requeue), plus possibly the
   runtime-client/shell UI event bridge. UI-bridge callers pass NO opts
   (renderer events have no origin tx) — leave them unchanged; list every
   site found in PROGRESS.md. Any site that looks like it forwards events
   *between* schedulers: STOP and report.

Verify: full runner suite (`deno task test`). New unit test, file
`test/scheduler-event-identity.test.ts`:

- minting twice from the same origin tx yields distinct ids sharing the
  same `evt:<key>:` prefix with seqs 0 and 1;
- two different origin txs yield different keys;
- no-origin minting yields distinct ids;
- a queued event's id survives the commit-error requeue path (simulate by
  constructing a `QueuedEvent` and exercising the unshift branch if
  practical at unit level; otherwise assert the field threading by reading
  the queue after `queueEvent` with an explicit `eventId`).

Commit: `feat(runner): thread event ids and origin tx through the event queue (scheduler-v2 E0)`

## Step 3 — Transaction fields

File: `src/storage/interface.ts`.

1. On `IExtendedStorageTransaction` add (near the other optional
   scheduler-facing members, with doc comments):

   ```typescript
   // Shown as JSX element children.
   /**
    * The durable id of the event whose dispatch opened this transaction
    * (spec §7.5). Set by the scheduler's event dispatch; consumed by the
    * runner to derive the handler result cell's cause (spec §7.6).
    */
   dispatchedEventId?: string;
   ```

2. Run `deno check` on the storage implementations; if a concrete class
   needs the field declared, add it as a plain optional property (no
   logic).

Commit: `feat(runner): dispatchedEventId transaction field (scheduler-v2 E0)`

## Step 4 — Permanent-rejection taxonomy

1. `src/storage/interface.ts`:
   - Define, next to the other error interfaces:

     ```typescript
     /**
      * A commit-time precondition failed (spec scheduler-v2 §7.6). Unlike
      * optimistic conflicts, this class is PERMANENT: the client must not
      * retry. `origin-committed` — the transaction that caused this work
      * never committed. `receipt-exists` — another handling of the same
      * event already committed (lost race).
      */
     export interface IPreconditionFailedError extends Error {
       name: "PreconditionFailedError";
       precondition: "origin-committed" | "receipt-exists";
     }
     ```

   - Add `IPreconditionFailedError` to the `StorageTransactionRejected`
     union (~line 1042).

2. New file `src/storage/rejection.ts`:

   ```typescript
   /**
    * Permanent rejections are commit-time precondition failures (spec
    * scheduler-v2 §7.6): retrying can never succeed and MUST not happen —
    * for `receipt-exists` a retry would double-handle an event.
    */
   export function isPermanentRejection(
     error: { name?: string } | undefined | null,
   ): boolean {
     return error?.name === "PreconditionFailedError";
   }
   ```

3. Wire the event retry path — `src/scheduler/events.ts`
   `dispatchQueuedEvent`, the commit-result branch
   (`if (result.error && retriesLeft > 0)`): change the condition to
   `if (result.error && retriesLeft > 0 && !isPermanentRejection(result.error))`.
   Permanent rejections therefore fall through to the existing
   final-failure handling (`runFinalCommitCallback()` + error log). Extend
   the error log message in that branch to include
   `permanent: isPermanentRejection(result.error)`.

4. Wire the reactive retry path — `src/scheduler/action-run.ts`
   `watchReactiveActionCommit`: change
   `if (retries < MAX_RETRIES_FOR_REACTIVE)` to
   `if (retries < MAX_RETRIES_FOR_REACTIVE && !isPermanentRejection(error))`.
   (Reactive runs should never hit preconditions, but the taxonomy must be
   uniform.)

5. Unit test, file `test/scheduler-rejection-taxonomy.test.ts`:
   `isPermanentRejection` truth table (PreconditionFailedError → true;
   ConflictError-shaped `{name:"ConflictError"}` → false; undefined →
   false). Integration coverage of the no-retry behavior lands in work
   orders 03/04 where the engine can actually emit the error — note this
   in a comment at the top of the test file.

Verify: full runner suite.

Commit: `feat(runner): permanent-rejection taxonomy; retry paths skip precondition failures (scheduler-v2 E0)`

## Exit checklist (reviewer)

- [ ] Every `QueuedEvent` constructed anywhere carries `id` (grep
      `eventQueue.push` and both `unshift` sites).
- [ ] Retried/requeued events keep their original id (code inspection of
      the three requeue sites).
- [ ] `isPermanentRejection` gates both retry paths; nothing else changed
      in them.
- [ ] No engine/server changes in this phase (grep `packages/memory` diff
      is empty).
- [ ] Full runner suite green; new tests present and green.
