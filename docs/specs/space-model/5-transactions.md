# Transactions

This document specifies how reads and writes are grouped into atomic units.

## Status

Draft — based on codebase investigation. This document describes the current
implementation; no major changes are currently proposed.

---

## Current State

### Overview

Transactions provide atomicity and consistency for cell operations. All writes
to cells require a transaction context.

### Transaction Lifecycle

1. **Open**: `runtime.edit()` creates a new transaction
2. **Read**: `cell.withTx(tx).get()` reads within transaction context
3. **Write**: `cell.withTx(tx).set(value)` buffers write
4. **Commit**: `tx.commit()` attempts to persist changes
5. **Abort**: `tx.abort()` discards changes (or automatic on error)

### Settle Outcomes

A transaction settles in one of three ways: its commit succeeds, its commit is
rejected, or something aborts it. All three run the callbacks registered through
`addCommitCallback`. A rejected commit and an abort both deliver an error to
those callbacks, because both discard every write the transaction staged.

Those callbacks are the compensation hook: they undo in-memory state that only
makes sense if the transaction's writes became durable. Two rules govern one.

A callback that undoes such state checks that the state is still the state this
transaction established. Another transaction can reach the same deterministic
address and take ownership before this one settles, and its bookkeeping matches
durable writes of its own.

Not every failure calls for compensation. A stale basis — a conflict, or a local
inconsistency — is resolved by re-running the same work against fresh state, and
that re-run may depend on the very bookkeeping a compensating callback would
discard; undoing it there can stop the work converging at all.
`storage/rejection.ts` classifies the outcomes, so a callback acts only on the
ones no re-run follows.

External side effects belong in the post-commit outbox instead, which runs only
after a successful commit.

Work that re-runs what another transaction already carries, so the two can be
compared, wants none of this. The idempotency validator is the case that exists.
Its callbacks would compensate for state belonging to the run it duplicates,
which has already committed it, so it takes its transaction from
`createDuplicateWorkTransaction` — a wrapper that drops settle callbacks rather
than registering them, leaving nothing to take back when the transaction is
discarded.

### Read-Your-Writes

Within a transaction, reads reflect pending writes:

```typescript
// Shown for illustration only.
const tx = runtime.edit();
cell.withTx(tx).set(5);
cell.withTx(tx).get();  // returns 5, even before commit
```

This allows handlers to read back values they've written within the same
transaction.

### Conflict Detection

The system detects conflicts when the committed state changes between first
cell access and commit.

#### Behavior

- The first operation on a cell within a transaction (whether `get()` or
  `set()`) captures the current committed value as the **baseline**
- On commit, if the committed state no longer matches the baseline, the commit
  fails with `StorageTransactionInconsistent`
- Even **identical writes** trigger conflict — detection is based on baseline
  divergence, not on whether final values differ
- This is optimistic concurrency control
- **Important**: Simply opening a transaction does not capture any baselines.
  Conflict detection only applies to cells that were **accessed** (read or
  written) within the transaction. If T2 commits before T1 touches a cell, T1's
  subsequent access captures T2's committed value as the baseline, so no
  conflict occurs.

#### Examples

Conflict (both transactions access before either commits):

```
Transaction A: open, set cell (captures baseline=1)
Transaction B: open, set cell (captures baseline=1), commit  // succeeds
Transaction A: commit  // FAILS — baseline 1 ≠ committed 2
```

No conflict (T1 accesses after T2 commits):

```
Transaction A: open
Transaction B: open, set cell (2), commit  // succeeds, cell is now 2
Transaction A: set cell (3)  // captures baseline=2 (T2's committed value)
Transaction A: commit  // succeeds — baseline 2 = committed 2
```

In the conflict case, both transactions captured the original value as their
baseline. In the no-conflict case, Transaction A's first access happens after
Transaction B has committed, so A's baseline already reflects B's changes.

### Non-Traditional Transaction Semantics

This system does not implement SQL-style transaction isolation. Key differences:

- **Live references, not snapshots**: For cells with `any` type (no schema),
  `cell.get()` returns a live proxy to committed state. If another transaction
  commits while yours is open, your previously-read reference reflects their
  changes — no isolation. (This proxy behavior exists because for untyped cells,
  reading eagerly might require crawling the entire space via links. Cells with
  schemas may behave differently since the schema scopes the read.)

- **Conflict detection is baseline-based**: The first access to a cell (read
  or write) captures the committed value as a baseline. If the committed value
  changes before commit, the transaction fails. If T2 commits *before* T1
  touches the cell, T1's access captures T2's value as its baseline and commits
  successfully — no conflict.

- **Two read modes**: `cell.get()` returns committed state (live proxy);
  `cell.withTx(tx).get()` returns pending writes (read-your-writes).

- **Point-in-time requires explicit copy**: If you need snapshot semantics,
  deep-copy at read time: `JSON.parse(JSON.stringify(cell.get()))`.

### Retry Semantics

The `editWithRetry()` helper provides automatic retry on a **retryable** commit
failure:

```typescript
// Shown for illustration only.
const result = await runtime.editWithRetry(async (tx) => {
  const current = cell.withTx(tx).get();
  cell.withTx(tx).set(current + 1);
  return current + 1;
});
```

- On a retryable commit rejection, re-runs the entire function with a fresh
  transaction
- On any other commit rejection, returns the error immediately — the first
  attempt is the only attempt
- Returns success or error after exhausting retries

Retryability is an **allow-list**: `isRetryableCommitRejection`, defined in the
shared rejection vocabulary (`packages/runner/src/storage/rejection.ts`) and
consumed only by `editWithRetry()`. The scheduler's commit classifier
(`classifyCommitDisposition`, `packages/runner/src/scheduler/events.ts`) draws
its predicates from that same module but composes them itself, so the two
classifiers are independent and can disagree — the scheduler retries only a
stale basis (`ConflictError`, `StorageTransactionInconsistent`) and drops
everything else on the first attempt, including the liveness and abort classes
`editWithRetry()` does retry. A rejection is retried by `editWithRetry()` only
when re-running the function against fresh state can produce a different
outcome:

| Class | Why a re-run can converge |
| --- | --- |
| `ConflictError` | Stale basis from upstream. The retry first awaits the conflict's `readyToRetry` catch-up gate, then pulls the doc the conflict names, so it runs against fresh state. |
| `StorageTransactionInconsistent` | Stale basis on this replica — a value read during the transaction changed locally; re-reading resolves it. |
| `ConnectionError`, `SessionError`, `InvalidMessageError` | Liveness failure: the commit never reached a verdict, so a re-established connection or session can land the identical write. `InvalidMessageError` is collateral — an undecodable frame makes the client reject every in-flight request, including commits it says nothing about. |
| `StorageTransactionAborted` | The attempt was discarded before storage — the callback called `tx.abort()`, or CFC enforcement refused to hand the transaction over. A re-run is a genuinely new attempt, and costs no round-trip. |
| `AuthorizationError` with `retriable: true` | The server itself marked this denial as one a fresh handshake heals (a session-open anti-replay race). |

Everything else is **terminal on the first attempt**: a `ProtocolError` (the
server refused the commit's shape), an unmarked `AuthorizationError` (the server
evaluated the request and denied it), a `PreconditionFailedError` (permanent by
definition — the client must not retry), a `RowLabelCommitError` (a commit-time
rule refused the data), a `StoreError`, or the generic `TransactionError`. Those
are deterministic with respect to the committed data: a re-run recomputes the
identical refused write, and each doomed attempt costs a server round-trip plus
a revert notification to the cell's subscribers.

A rejection class introduced later is non-retryable until someone establishes
that re-running can converge and adds it to the allow-list. If a callback
*throws* rather than aborting, the transaction is aborted and the error is
returned without any retry.

The scheduler also provides automatic retry for handlers on transaction conflict.

### Relationship to Handlers

Handlers execute within transaction context:
- The transaction is provided to the handler function
- Reads and writes within the handler use this transaction
- On handler completion, the transaction commits
- On handler error, the transaction aborts

```typescript
// Shown for illustration only.
const handler = (tx, event) => {
  const current = someCell.withTx(tx).get();
  someCell.withTx(tx).set(current + 1);
  // tx commits automatically after handler returns
};
```

### Cell Methods and Transactions

The transaction layer uses a narrow subset of Cell methods:

| Method | Purpose |
|--------|---------|
| `get()` | Read current value |
| `getRaw()` | Read without schema transformation |
| `set()` | Write value |
| `setRaw()` | Write without schema transformation |
| `update()` | Partial object update |
| `push()` | Array append |
| `remove()` | Array removal |
| `key()` | Navigate to nested property |
| `withTx()` | Bind cell to transaction |
| `asSchema()` | Type cast |

These ~10 methods form the core data access API. Everything else (reactivity,
streaming) builds on top.

---

## Open Questions

- ~~How do nested/child transactions work (if at all)?~~ Not supported. For
  cases where nested semantics might be useful (e.g. a chain of events with
  rollback), branches and merging branches may be the better mechanism.
  Transactions are intended for short-lived operations.
- ~~How are transactions serialized for storage?~~ As UCAN invocations.
- ~~What consistency guarantees exist across spaces?~~ None so far.

---

**Previous:** [Cells](./4-cells.md) | **Next:** [Reactivity](./6-reactivity.md)
