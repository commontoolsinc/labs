Transactions API (Behavioral Spec)

- Scope: High-level contract between runner components and storage transactions,
  with emphasis on read/write recording for reactivity and atomic application of
  change sets.

Core Behaviors

- Creating transactions: A fresh transaction must be used to run actions and
  group related writes. For read-only operations, ephemeral transactions are
  acceptable, but must still record reads to the journal for dependency
  tracking.
- Reads: `readValueOrThrow(address, options?)` returns a JSON value at that
  address and records the read (space, id, type, path) in the journal. Reads may
  carry metadata; reads marked as “ignore for scheduling” must not create
  dependencies.
- Writes: `writeValueOrThrow(address, value)` writes a JSON value (or
  `undefined` to delete) and records the write in the journal. Writes are
  visible to reads performed within the same transaction.
- Commit: `commit()` finalizes the transaction, publishes writes, and closes the
  journal for dependency extraction.
- Journal: `journal.activity()` exposes a sequence of read/write activities for
  scheduler dependency extraction; value paths include a leading “value” prefix
  that is removed for dependency matching.
- Sync: For non-`data:` entities, a `syncCell(cell)` operation should be
  available to kick off background synchronization.

Usage Patterns

- Read phase: Reads performed by Cells or schema transforms should occur under a
  transaction to capture dependencies consistently. These reads define reactive
  triggers for subsequent scheduler runs.
- Write phase: Value normalization and diffing produce a change set that must be
  applied as writes within a single transaction to ensure atomicity and conflict
  handling.
- Reactivity: After an action commits, the scheduler derives the reactivity log
  from the journal and registers subscriptions accordingly.

Notes

- All mutating Cell operations must have a transaction provided. Implementations
  may automatically create ephemeral transactions for readonly code paths but
  should not do so for mutations. Group related writes into a single transaction
  whenever possible for predictable behavior.
