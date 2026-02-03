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

### Read-Your-Writes

Within a transaction, reads reflect pending writes:

```typescript
const tx = runtime.edit();
cell.withTx(tx).set(5);
cell.withTx(tx).get();  // returns 5, even before commit
```

This allows handlers to read back values they've written within the same
transaction.

### Conflict Detection

The system detects conflicts when the base state changes between transaction
open and commit.

#### Behavior

- When committing, if the underlying data has changed since the transaction
  started, the commit fails with `StorageTransactionInconsistent`
- Even **identical writes** trigger conflict — detection is based on base state
  changing, not on whether final values differ
- This is optimistic concurrency control
- **Important**: Conflict detection only applies to cells that were READ within
  the transaction. A write-only transaction will not conflict with concurrent
  commits to the same cell.

#### Example

```
Transaction A: open, read cell (value=1)
Transaction B: open, read cell (value=1), set(2), commit  // succeeds
Transaction A: set(2), commit  // FAILS — base state changed
```

Transaction A fails even though it wrote the same value, because the base state
it read from is no longer current.

### Non-Traditional Transaction Semantics

This system does not implement SQL-style transaction isolation. Key differences:

- **Live references, not snapshots**: `cell.get()` returns a live proxy to
  committed state. If another transaction commits while yours is open, your
  previously-read reference reflects their changes — no isolation.

- **Conflict detection is conditional**: Conflicts only occur when both
  transactions have pending writes based on the same original state. If T2
  commits *before* T1 writes, T1 observes the new state via live reference
  and commits successfully — no conflict.

- **Two read modes**: `cell.get()` returns committed state (live proxy);
  `cell.withTx(tx).get()` returns pending writes (read-your-writes).

- **Point-in-time requires explicit copy**: If you need snapshot semantics,
  deep-copy at read time: `JSON.parse(JSON.stringify(cell.get()))`.

### Retry Semantics

The `editWithRetry()` helper provides automatic retry on commit failure:

```typescript
const result = await runtime.editWithRetry(async (tx) => {
  const current = cell.withTx(tx).get();
  cell.withTx(tx).set(current + 1);
  return current + 1;
});
```

- Default maximum retries: 5
- On commit error, re-runs the entire function with a fresh transaction
- Returns `{ ok: result }` on success
- Returns `{ error: CommitError }` after exhausting retries

The scheduler also provides automatic retry for handlers, up to
`MAX_RETRIES_FOR_REACTIVE` attempts on transaction conflict.

### Relationship to Handlers

Handlers execute within transaction context:
- The transaction is provided to the handler function
- Reads and writes within the handler use this transaction
- On handler completion, the transaction commits
- On handler error, the transaction aborts

```typescript
const handler = (tx: IExtendedStorageTransaction, event: any) => {
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

- How do nested/child transactions work (if at all)?
- How are transactions serialized for storage?
- What consistency guarantees exist across spaces?

---

**Previous:** [Cells](./4-cells.md) | **Next:** [Reactivity](./6-reactivity.md)
